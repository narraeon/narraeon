import { createHash } from "node:crypto";
import type * as FileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type * as NodePath from "node:path";
import { dirname, join, posix, win32 } from "node:path";
import { expect, test, vi } from "vitest";
import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import {
  readGoogleHops,
  writeGoogleHop,
} from "../../src/runtime/model/GoogleHopJournal.ts";
import type {
  GoogleHopEvidence,
  ModelHostWireRequest,
} from "../../src/runtime/model/ModelHost.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePlayTimelineStore } from "../../src/runtime/play/FileNativePlayTimelineStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeSettingImprovementStore } from "../../src/runtime/setting/FileNativeSettingImprovementStore.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { googleAuthoringHost } from "./support/google-authoring.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return { ...fs, mkdir: vi.fn(fs.mkdir) };
});

const pathFlavor = vi.hoisted(() => ({
  current: undefined as "posix" | "win32" | undefined,
}));
vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof NodePath>();
  return {
    ...path,
    join: (...parts: string[]) =>
      (pathFlavor.current === undefined ? path : path[pathFlavor.current]).join(
        ...parts,
      ),
    dirname: (value: string) =>
      (pathFlavor.current === undefined
        ? path
        : path[pathFlavor.current]
      ).dirname(value),
  };
});

const completedHop: GoogleHopEvidence = {
  exchange: 1,
  attempt: 1,
  hop: 2,
  tokenSupplied: true,
  status: "completed",
};

const wire: ModelHostWireRequest = {
  provider: "google_interactions",
  method: "POST",
  endpointPath: "/v1beta/interactions",
  headerNames: ["Accept", "x-goog-api-key", "Content-Type"],
  body: {
    model: "test-model",
    store: false,
    stream: true,
    input: [],
    generation_config: { max_output_tokens: 100 },
  },
  redactedProviderContinuation: true,
};

test.each([
  { flavor: "posix", platform: posix },
  { flavor: "win32", platform: win32 },
] as const)(
  "$flavor 路径在落盘前只读取指定 owner 的记录",
  async ({ flavor, platform }) => {
    const scratch = await mkdtemp(join(tmpdir(), "google-hop-pending-"));
    const root = platform.join(scratch, "journal");
    const release = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    pathFlavor.current = flavor;
    const pending = writeGoogleHop(root, "main", completedHop, () => {
      entered.resolve();
      return release.promise;
    });
    try {
      await Promise.race([entered.promise, pending]);
      expect(await readdir(scratch)).toEqual([]);
      expect((await readGoogleHops(root, "main", wire)).googleHops).toEqual([
        completedHop,
      ]);
      expect(
        (await readGoogleHops(root, "followup", wire)).googleHops,
      ).toBeUndefined();
    } finally {
      release.resolve(false);
      await pending;
      pathFlavor.current = undefined;
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test.each([
  { phase: "发布前", check: 2, published: false },
  { phase: "发布后", check: 3, published: true },
])(
  "$phase owner 过期时保留同目录下其他 owner 的记录",
  async ({ check, published }) => {
    const root = await mkdtemp(join(tmpdir(), "google-hop-siblings-"));
    const directoryFor = (owner: string) =>
      join(root, createHash("sha256").update(owner).digest("hex"));
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let checks = 0;
    let retained = true;
    const oldHop = {
      ...completedHop,
      hop: 1,
      tokenSupplied: false,
      request: wire,
    };
    await writeGoogleHop(root, "main", oldHop);
    await writeGoogleHop(root, "followup", completedHop);
    const pending = writeGoogleHop(root, "main", completedHop, async () => {
      if (++checks === check) {
        entered.resolve();
        await release.promise;
      }
      return retained;
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("The write finished before the retention check");
        }),
      ]);
      expect((await readdir(directoryFor("main"))).includes("1-1-2.json")).toBe(
        published,
      );
      retained = false;
      release.resolve();
      await pending;
      expect((await readGoogleHops(root, "followup", wire)).googleHops).toEqual(
        [completedHop],
      );
      expect(await readdir(directoryFor("followup"))).toEqual(["1-1-2.json"]);
      expect(
        (await readGoogleHops(root, "main", wire)).googleHops,
      ).toBeUndefined();
      await expect(readdir(directoryFor("main"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release.resolve();
      await pending;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("过期或已删除的记录不会被排队的迟到写入重建", async () => {
  const root = await mkdtemp(join(tmpdir(), "google-hop-expired-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let retained = true;
  let checks = 0;
  const pending = writeGoogleHop(
    join(root, "expired"),
    "main",
    completedHop,
    async () => {
      if (++checks === 2) {
        entered();
        await gate;
      }
      return retained;
    },
  );
  await writing;
  retained = false;
  await rm(join(root, "expired"), { recursive: true, force: true });
  release();
  await pending;
  expect(await readdir(root)).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

interface JournalScope {
  journalRoot: string;
  record: (hop: GoogleHopEvidence) => Promise<void>;
  read: () => Promise<ModelHostWireRequest | null | undefined>;
  expire: () => Promise<void>;
}

test.each([
  { name: "游玩 exchange", setup: playExchange },
  {
    name: "设定完善会话",
    setup: (root: string) => authoringSession(root, "setting"),
  },
  {
    name: "世界修订会话",
    setup: (root: string) => authoringSession(root, "revision"),
  },
])(
  "$name 清理后，已经通过首次保留检查的写入不会重建记录",
  async ({ setup }) => {
    const root = await mkdtemp(join(tmpdir(), "google-hop-scope-"));
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let pending: Promise<void> | undefined;
    const realMkdir = vi.mocked(mkdir).getMockImplementation()!;
    try {
      const scope = await setup(root);
      await scope.record(completedHop);
      expect((await scope.read())?.googleHops).toEqual([completedHop]);

      vi.mocked(mkdir).mockImplementation(async (path, options) => {
        if (typeof path === "string" && dirname(path) === scope.journalRoot) {
          entered.resolve();
          await release.promise;
        }
        return realMkdir(path, options);
      });
      pending = scope.record({ ...completedHop, hop: 3 });
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("The write finished before reaching mkdir");
        }),
      ]);
      expect(await readdir(scope.journalRoot)).toHaveLength(1);
      await scope.expire();
      await expect(readdir(scope.journalRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      release.resolve();
      await pending;
      await expect(readdir(scope.journalRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release.resolve();
      vi.mocked(mkdir).mockReset();
      await pending?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function playExchange(root: string): Promise<JournalScope> {
  const store = new FileNativePlayTimelineStore(root);
  const worldId = "world";
  const chainId = "chain";
  const chainHash = createHash("sha256").update(chainId).digest("hex");
  const journalRoot = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
    chainHash,
    "google-hops",
    "1",
  );
  await store.recordInitialEncoding(worldId, chainId, wire, 1);
  return {
    journalRoot,
    record: (hop) => store.recordGoogleHop(worldId, chainId, 1, hop),
    read: () => store.readInitialEncoding(worldId, chainId, 1),
    expire: async () => {
      await store.recordInitialEncoding(worldId, chainId, wire, 2);
      await store.recordInitialEncoding(worldId, chainId, wire, 3);
      expect(await store.readInitialEncoding(worldId, chainId, 1)).toBeNull();
    },
  };
}

async function authoringSession(
  root: string,
  kind: "setting" | "revision",
): Promise<JournalScope> {
  const requestId = "authoring-request";
  const title = "Journal test";
  const playPreset = builtinDefaultPlayPresetBinding("en");
  const modelBinding = googleAuthoringHost([]).host.binding();
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  const promptInput = {
    playPreset,
    modelBinding,
    gameplay: fictionGameplay,
    tools: [],
  };
  const bootstrap =
    kind === "setting"
      ? compiler.compileSettingImprovement({
          ...promptInput,
          contentPackageTitle: title,
        })
      : compiler.compileWorldRevision({ ...promptInput, worldTitle: title });
  const session = {
    locale: "en" as const,
    runStatus: "ready" as const,
    createdAt: 1,
    updatedAt: 1,
    creationRequestId: requestId,
    bootstrap,
    modelBinding,
    playPreset,
    modelItems: [{ kind: "user" as const, text: "Edit the setting." }],
    messages: [],
    usage: emptyAggregatedModelUsage(),
    exchange: 1,
    toolCalls: 0,
    activeRequestId: null,
    completedRequestIds: [requestId],
    lastFailure: null,
    authorization: null,
    pendingSettlement: null,
    requests: [
      {
        requestId,
        modelItemStart: 0,
        bootstrap,
        playPreset,
        wireRequest: wire,
      },
    ],
  };
  if (kind === "setting") {
    const store = new FileNativeSettingImprovementStore(root);
    const sessionId = store.createId();
    const packageId = "package";
    await store.save({
      ...session,
      schemaVersion: 6,
      sessionId,
      packageId,
      legacyDraft: null,
    });
    return {
      journalRoot: join(store.sessionScope, ".google-hops", sessionId),
      record: (hop) => store.recordGoogleHop(sessionId, requestId, hop),
      read: async () =>
        (await store.read(sessionId)).requests?.[0]?.wireRequest,
      expire: () => store.deleteSession(packageId, sessionId),
    };
  }
  const store = new FileNativeWorldRevisionStore(root);
  const sessionId = store.createSessionId();
  const worldId = "world";
  await store.saveSession({
    ...session,
    schemaVersion: 4,
    sessionId,
    worldId,
    worldTitle: title,
    epochId: store.createEpochId(),
  });
  return {
    journalRoot: join(store.sessionScope, ".google-hops", sessionId),
    record: (hop) => store.recordGoogleHop(sessionId, requestId, hop),
    read: async () =>
      (await store.readSession(sessionId)).requests?.[0]?.wireRequest,
    expire: () => store.deleteSession(worldId, sessionId),
  };
}
