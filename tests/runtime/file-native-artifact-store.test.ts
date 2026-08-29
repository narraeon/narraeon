import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import {
  FileNativeArtifactStore,
  type ArtifactOperationContext,
  type ArtifactRequestContext,
} from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import type { PlayPresetArtifactDeclaration } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

function declaration(
  save: PlayPresetArtifactDeclaration["save"],
  strategy: PlayPresetArtifactDeclaration["strategy"],
  overrides: Partial<PlayPresetArtifactDeclaration> = {},
): PlayPresetArtifactDeclaration {
  return {
    name: "panel",
    channel: "ui.panel",
    strategy,
    contentType: "text/plain",
    save,
    invalidation: "head_change",
    required: false,
    maxEmits: 2,
    ...overrides,
  };
}

function context(
  root: string,
  save: PlayPresetArtifactDeclaration["save"],
  strategy: PlayPresetArtifactDeclaration["strategy"],
  overrides: Partial<PlayPresetArtifactDeclaration> = {},
): {
  store: FileNativeArtifactStore;
  operation: ArtifactOperationContext;
  request: ArtifactRequestContext;
} {
  const store = new FileNativeArtifactStore(root);
  const operation = {
    worldId: "world-1",
    parentHead: "genesis",
    operationId: `operation-${save}-${strategy}`,
    playPresetId: "play-1",
    playPresetRevision: "rev-1",
    playPresetScriptsEnabled: true,
  } satisfies ArtifactOperationContext;
  const request = {
    ...operation,
    requestId: "decorate",
    requestAttempt: 1,
    maxArtifactBytes: 4096,
    declarations: [declaration(save, strategy, overrides)],
  } satisfies ArtifactRequestContext;
  return { store, operation, request };
}

function operationFile(root: string, operationId: string): string {
  const hash = createHash("sha256").update(operationId, "utf8").digest("hex");
  return join(root, "artifact-store", "operations", `${hash}.json`);
}

async function beginRequestFixture(fixture: {
  store: FileNativeArtifactStore;
  operation: ArtifactOperationContext;
  request: ArtifactRequestContext;
}): Promise<void> {
  await fixture.store.beginOperation(fixture.operation);
  await fixture.store.beginRequestAttempt(fixture.request);
}

describe("FileNativeArtifactStore", () => {
  test("core 尚运行时 resume 只读当前摘要，不把合法竞态误报为损坏", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-running-resume-"),
    );
    const fixture = context(root, "commit", "replace");
    await beginRequestFixture(fixture);

    await expect(
      new FileNativeArtifactStore(root).resumeExtension(
        fixture.operation.operationId,
      ),
    ).resolves.toMatchObject({
      operationId: fixture.operation.operationId,
      status: "not_started",
      coreCommitted: false,
    });
    await expect(
      fixture.store.readExtension(fixture.operation.operationId),
    ).resolves.toMatchObject({ status: "not_started", coreCommitted: false });
    await rm(root, { recursive: true, force: true });
  });

  test("artifact lock owner 发布后的 setup 故障会按 token 释放，不永久锁死 world", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-lock-setup-"));
    const fixture = context(root, "commit", "replace");
    process.env.NARRAEON_INTERNAL_TEST_FAIL_AT_ARTIFACT_LOCK_EDGE =
      "after_owner";
    try {
      await expect(
        fixture.store.beginOperation(fixture.operation),
      ).rejects.toThrow(/simulated artifact lock setup failure/u);
    } finally {
      delete process.env.NARRAEON_INTERNAL_TEST_FAIL_AT_ARTIFACT_LOCK_EDGE;
    }
    await expect(
      new FileNativeArtifactStore(root).beginOperation(fixture.operation),
    ).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  test("冷读取严格拒绝缺字段、未知字段和非法 operation 状态组合", async () => {
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        const stored = value.context as Record<string, unknown>;
        delete stored.playPresetScriptsEnabled;
      },
      (value) => {
        delete value.artifactProjectionStatus;
      },
      (value) => {
        delete value.requestAttempts;
      },
      (value) => {
        value.unexpectedField = true;
      },
      (value) => {
        value.status = "running";
        value.extensionStatus = "completed";
        value.completedRequests = ["unexpected-request"];
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const root = await mkdtemp(
        join(tmpdir(), "narraeon-artifact-strict-op-"),
      );
      const fixture = context(root, "commit", "replace");
      fixture.operation.operationId = `strict-operation-${index}`;
      await fixture.store.beginOperation(fixture.operation);
      const path = operationFile(root, fixture.operation.operationId);
      const value = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(value);
      await writeFile(path, JSON.stringify(value), "utf8");
      await expect(
        new FileNativeArtifactStore(root).readExtension(
          fixture.operation.operationId,
        ),
      ).rejects.toThrow(/Artifact operation state is corrupt/u);
    }
  });

  test("冷读取严格拒绝 raw/event 的缺字段与未知字段", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-strict-log-"));
    const fixture = context(root, "operation", "replace");
    await beginRequestFixture(fixture);
    await fixture.store.emit({
      context: fixture.request,
      output: "panel",
      payload: "strict",
      toolCallId: "strict-log",
    });
    const worldHash = createHash("sha256")
      .update(fixture.operation.worldId, "utf8")
      .digest("hex");
    const rawPath = join(
      root,
      "artifact-store",
      "worlds",
      worldHash,
      "records",
      "000000000001.json",
    );
    const raw = JSON.parse(await readFile(rawPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.playPresetScriptsEnabled;
    await writeFile(rawPath, JSON.stringify(raw), "utf8");
    await expect(
      new FileNativeArtifactStore(root).readDebug("world-1"),
    ).rejects.toThrow(/Artifact raw record is corrupt/u);

    const cleanRoot = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-strict-event-"),
    );
    const clean = context(cleanRoot, "operation", "replace");
    await beginRequestFixture(clean);
    await clean.store.emit({
      context: clean.request,
      output: "panel",
      payload: "strict",
      toolCallId: "strict-event",
    });
    const eventPath = join(
      cleanRoot,
      "artifact-store",
      "worlds",
      worldHash,
      "events",
      "000000000002.json",
    );
    const event = JSON.parse(await readFile(eventPath, "utf8")) as Record<
      string,
      unknown
    >;
    event.unexpectedField = true;
    await writeFile(eventPath, JSON.stringify(event), "utf8");
    await expect(
      new FileNativeArtifactStore(cleanRoot).readDebug("world-1"),
    ).rejects.toThrow(/Artifact projection event is corrupt/u);
  });

  test("bind_head event 必须与冻结 operation 的核心 head 一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-bind-head-"));
    const fixture = context(root, "commit", "replace");
    await beginRequestFixture(fixture);
    await fixture.store.emit({
      context: fixture.request,
      output: "panel",
      payload: "bound payload",
      toolCallId: "bind-head",
    });
    await fixture.store.markCoreCommitted(fixture.operation, "commit:1");
    const worldHash = createHash("sha256")
      .update(fixture.operation.worldId, "utf8")
      .digest("hex");
    const bindPath = join(
      root,
      "artifact-store",
      "worlds",
      worldHash,
      "events",
      "000000000002.json",
    );
    const bind = JSON.parse(await readFile(bindPath, "utf8")) as {
      head: string;
    };
    bind.head = "commit:2";
    await writeFile(bindPath, JSON.stringify(bind), "utf8");
    await expect(
      new FileNativeArtifactStore(root).readActiveProjection("world-1"),
    ).rejects.toThrow(/bind_head.*operation core head/u);
  });

  test("冷读取把 operation 与 raw/event 文件名绑定到内容身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-path-id-"));
    const fixture = context(root, "operation", "replace");
    await beginRequestFixture(fixture);
    await fixture.store.emit({
      context: fixture.request,
      output: "panel",
      payload: "path identity",
      toolCallId: "path-id",
    });

    const copiedOperationId = "operation-relocated-copy";
    await writeFile(
      operationFile(root, copiedOperationId),
      await readFile(operationFile(root, fixture.operation.operationId)),
    );
    await expect(
      new FileNativeArtifactStore(root).readExtension(copiedOperationId),
    ).rejects.toThrow(/operation.*identity/u);

    const worldHash = createHash("sha256")
      .update(fixture.operation.worldId, "utf8")
      .digest("hex");
    const records = join(
      root,
      "artifact-store",
      "worlds",
      worldHash,
      "records",
    );
    await rename(
      join(records, "000000000001.json"),
      join(records, "000000000009.json"),
    );
    await expect(
      new FileNativeArtifactStore(root).readDebug(fixture.operation.worldId),
    ).rejects.toThrow(/file name.*sequence/u);
  });

  test("operation 缺失后 emit/clear fail loud 且不写 raw/event", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-missing-op-"));
    const fixture = context(root, "operation", "replace");
    await beginRequestFixture(fixture);
    await rm(operationFile(root, fixture.operation.operationId));
    await expect(
      fixture.store.emit({
        context: fixture.request,
        output: "panel",
        payload: "must not persist",
        toolCallId: "missing-emit",
      }),
    ).rejects.toThrow(/missing an operation checkpoint/u);
    await expect(
      fixture.store.clear({
        context: fixture.request,
        output: "panel",
        toolCallId: "missing-clear",
      }),
    ).rejects.toThrow(/missing an operation checkpoint/u);
    await expect(
      fixture.store.markCoreCommitted(fixture.operation, "commit:1"),
    ).rejects.toThrow(
      /Core commit is missing an artifact-operation checkpoint/u,
    );
    await expect(
      fixture.store.beginExtension(fixture.operation),
    ).rejects.toThrow(/extension is missing an operation checkpoint/u);
    const worldHash = createHash("sha256")
      .update(fixture.operation.worldId, "utf8")
      .digest("hex");
    const worldRoot = join(root, "artifact-store", "worlds", worldHash);
    await expect(readdir(join(worldRoot, "records"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(worldRoot, "events"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("同 toolCallId 冷重试会补齐 raw-only 与 bind-only 的投影事件", async () => {
    for (const scenario of ["raw-only", "bind-only"] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `narraeon-artifact-${scenario}-`),
      );
      const fixture = context(
        root,
        scenario === "raw-only" ? "operation" : "commit",
        "replace",
      );
      fixture.operation.operationId = `operation-${scenario}`;
      fixture.request.operationId = fixture.operation.operationId;
      await beginRequestFixture(fixture);
      if (scenario === "bind-only")
        await fixture.store.markCoreCommitted(
          fixture.operation,
          "commit:repair",
        );
      const emit = {
        context: fixture.request,
        output: "panel",
        payload: `payload-${scenario}`,
        toolCallId: `call-${scenario}`,
      } as const;
      await fixture.store.emit(emit);
      const worldHash = createHash("sha256")
        .update(fixture.operation.worldId, "utf8")
        .digest("hex");
      const eventsRoot = join(
        root,
        "artifact-store",
        "worlds",
        worldHash,
        "events",
      );
      await rm(
        join(
          eventsRoot,
          scenario === "raw-only" ? "000000000002.json" : "000000000003.json",
        ),
      );
      await expect(
        new FileNativeArtifactStore(root).emit(emit),
      ).resolves.toMatchObject({ ok: true, idempotent: true });
      await expect(
        new FileNativeArtifactStore(root).readActiveProjection(
          fixture.operation.worldId,
        ),
      ).resolves.toMatchObject([{ payload: `payload-${scenario}` }]);
    }
  });

  test("recovery_required 会 fence 迟到 owner 的 emit/complete/fail", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-fenced-owner-"),
    );
    const fixture = context(root, "commit", "replace");
    await beginRequestFixture(fixture);
    await fixture.store.markCoreCommitted(fixture.operation, "commit:fenced");
    await fixture.store.beginExtension(fixture.operation);
    await expect(
      new FileNativeArtifactStore(root).resumeExtension(
        fixture.operation.operationId,
      ),
    ).resolves.toMatchObject({ status: "recovery_required" });

    await expect(
      fixture.store.emit({
        context: fixture.request,
        output: "panel",
        payload: "late payload",
        toolCallId: "late-owner",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.store.completeExtension(fixture.operation.operationId, [
        fixture.request.requestId,
      ]),
    ).resolves.toMatchObject({ status: "recovery_required" });
    await expect(
      fixture.store.failExtension(
        fixture.operation.operationId,
        "failed",
        "late owner failure",
      ),
    ).resolves.toMatchObject({ status: "recovery_required" });
    await expect(
      new FileNativeArtifactStore(root).readActiveProjection(
        fixture.operation.worldId,
      ),
    ).resolves.toEqual([]);
    await expect(
      new FileNativeArtifactStore(root).readDebug(
        fixture.operation.worldId,
        fixture.operation.operationId,
      ),
    ).resolves.toMatchObject([{ status: "superseded" }]);
  });

  test("两个 store 实例并发 emit 使用持久 world lock 保留两份产物", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-concurrent-"));
    const first = context(root, "operation", "append");
    first.operation.operationId = "concurrent-first";
    first.request.operationId = first.operation.operationId;
    const second = context(root, "operation", "append");
    second.operation.operationId = "concurrent-second";
    second.request.operationId = second.operation.operationId;
    await beginRequestFixture(first);
    await beginRequestFixture(second);
    const [left, right] = await Promise.all([
      first.store.emit({
        context: first.request,
        output: "panel",
        payload: "left",
        toolCallId: "concurrent-left",
      }),
      second.store.emit({
        context: second.request,
        output: "panel",
        payload: "right",
        toolCallId: "concurrent-right",
      }),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    const debug = await new FileNativeArtifactStore(root).readDebug("world-1");
    expect(debug.map(({ payload }) => payload).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(new Set(debug.map(({ sequence }) => sequence)).size).toBe(2);
  });

  test("world summary 隐藏无 post_commit 的默认成功与纯 core_failed，但保留无 artifact 扩展失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-summary-"));
    const store = new FileNativeArtifactStore(root);
    const coreOnly: ArtifactOperationContext = {
      worldId: "world-summary",
      parentHead: "genesis",
      operationId: "core-only",
      playPresetId: "play-1",
      playPresetRevision: "rev-1",
      playPresetScriptsEnabled: true,
    };
    await store.beginOperation(coreOnly);
    await store.markCoreCommitted(coreOnly, "commit:1");
    await store.completeExtension(coreOnly.operationId, []);

    const coreFailed = { ...coreOnly, operationId: "core-failed" };
    await store.beginOperation(coreFailed);
    await store.markCoreFailed(coreFailed.operationId, "核心失败");

    const extensionFailed = { ...coreOnly, operationId: "extension-failed" };
    await store.beginOperation(extensionFailed);
    await store.markCoreCommitted(extensionFailed, "commit:2");
    await store.beginExtension(extensionFailed);
    await store.failExtension(
      extensionFailed.operationId,
      "failed",
      "首次扩展请求失败",
    );

    expect(
      await new FileNativeArtifactStore(root).readExtensionSummaries(
        "world-summary",
      ),
    ).toEqual([
      expect.objectContaining({
        operationId: "extension-failed",
        status: "failed",
        coreCommitted: true,
      }),
    ]);
  });

  test.each([
    ["none", "append"],
    ["none", "replace"],
    ["none", "upsert"],
    ["none", "transient"],
    ["none", "hidden"],
    ["operation", "append"],
    ["operation", "replace"],
    ["operation", "upsert"],
    ["operation", "transient"],
    ["operation", "hidden"],
    ["commit", "append"],
    ["commit", "replace"],
    ["commit", "upsert"],
    ["commit", "transient"],
    ["commit", "hidden"],
  ] as const)(
    "支持 %s save × %s projection 的 raw/投影契约",
    async (save, strategy) => {
      const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-store-"));
      const { store, operation, request } = context(root, save, strategy, {
        ...(strategy === "upsert" ? { key: "main" } : {}),
      });
      await store.beginOperation(operation);
      await store.beginRequestAttempt(request);
      const emitted = await store.emit({
        context: request,
        output: "panel",
        payload: "hello",
        toolCallId: "emit-1",
      });
      expect(emitted.ok).toBe(true);
      if (save === "commit") {
        expect(await store.readActiveProjection("world-1")).toHaveLength(0);
        await store.markCoreCommitted(operation, "commit:1");
      }
      const projection = await store.readActiveProjection("world-1");
      const visible =
        strategy !== "hidden" &&
        (strategy !== "transient" || save !== "commit");
      expect(projection).toHaveLength(visible ? 1 : 0);
      const debug = await store.readDebug("world-1", operation.operationId);
      expect(debug).toHaveLength(1);
      expect(debug[0]).toMatchObject({
        output: "panel",
        save,
        projection: strategy,
        parentHead: "genesis",
      });
      const restarted = new FileNativeArtifactStore(root);
      expect(
        await restarted.readDebug("world-1", operation.operationId),
      ).toEqual(save === "none" ? [] : debug);
    },
  );

  test("artifact operation 在冷重启后继续使用启动时冻结的脚本策略", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-scripts-freeze-"),
    );
    const { store, operation, request } = context(root, "commit", "replace");
    const frozenOperation = { ...operation, playPresetScriptsEnabled: false };
    const frozenRequest = { ...request, ...frozenOperation };
    await store.beginOperation(frozenOperation);
    await store.beginRequestAttempt(frozenRequest);
    expect(
      await store.emit({
        context: frozenRequest,
        output: "panel",
        payload: "frozen",
        toolCallId: "frozen-script-call",
      }),
    ).toMatchObject({ ok: true });
    await store.markCoreCommitted(frozenOperation, "commit:frozen");
    const debug = await store.readDebug("world-1", operation.operationId);
    expect(debug[0]?.playPresetScriptsEnabled).toBe(false);
    const restarted = new FileNativeArtifactStore(root);
    expect(
      (await restarted.readActiveProjection("world-1"))[0]
        ?.playPresetScriptsEnabled,
    ).toBe(false);
    expect(
      (await restarted.readDebug("world-1", operation.operationId))[0]
        ?.playPresetScriptsEnabled,
    ).toBe(false);
  });

  test("emit 重试按 tool-call ID 幂等，参数变化冲突且不重复写", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-idempotency-"),
    );
    const { store, operation, request } = context(root, "commit", "upsert", {
      key: "main",
    });
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    const first = await store.emit({
      context: request,
      output: "panel",
      payload: "same",
      toolCallId: "call-1",
    });
    const retry = await store.emit({
      context: request,
      output: "panel",
      payload: "same",
      toolCallId: "call-1",
    });
    const conflict = await store.emit({
      context: request,
      output: "panel",
      payload: "different",
      toolCallId: "call-1",
    });
    expect(first.recordId).toBe(retry.recordId);
    expect(retry.idempotent).toBe(true);
    expect(conflict).toMatchObject({ ok: false });
    expect(
      await store.readDebug("world-1", operation.operationId),
    ).toHaveLength(1);
  });

  test("严格校验 JSON/text、字节预算和 clear，并能冷重建 projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-contract-"));
    const { store, operation, request } = context(root, "commit", "upsert", {
      key: "main",
      contentType: "application/json",
      required: true,
      maxEmits: 1,
    });
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    expect(
      await store.emit({
        context: request,
        output: "panel",
        payload: "not-json-object-is-still-a-json-string",
        toolCallId: "bad",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.emit({
        context: request,
        output: "panel",
        payload: { second: true },
        toolCallId: "too-many",
      }),
    ).toMatchObject({ ok: false });
    const clear = await store.clear({
      context: request,
      output: "panel",
      toolCallId: "clear-1",
    });
    expect(clear.ok).toBe(true);
    expect(
      await store.clear({
        context: request,
        output: "panel",
        toolCallId: "clear-1",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
    await store.markCoreCommitted(operation, "commit:1");
    expect(await store.readActiveProjection("world-1")).toEqual([]);
    const restarted = new FileNativeArtifactStore(root);
    expect(await restarted.readActiveProjection("world-1")).toEqual([]);
  });

  test("核心失败清理 commit-retained，旧 operation 迟到结果只能保留诊断 raw", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-invalidation-"),
    );
    const first = context(root, "commit", "upsert", { key: "main" });
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "old",
      toolCallId: "old-1",
    });
    await first.store.markCoreFailed(
      first.operation.operationId,
      "core failed",
    );
    expect(await first.store.readActiveProjection("world-1")).toEqual([]);

    const secondOperation = {
      ...first.operation,
      operationId: "operation-second",
      parentHead: "genesis",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "late",
      toolCallId: "late-1",
    });
    expect(
      await first.store.readDebug("world-1", first.operation.operationId),
    ).toMatchObject([{ status: "superseded" }, { status: "superseded" }]);
    await first.store.emit({
      context: secondRequest,
      output: "panel",
      payload: "new",
      toolCallId: "new-1",
    });
    await first.store.markCoreCommitted(secondOperation, "commit:2");
    expect(await first.store.readActiveProjection("world-1")).toMatchObject([
      { payload: "new", head: "commit:2" },
    ]);
  });

  test("renderer revision 丢失时仍保留 raw payload 作为安全 fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-renderer-"));
    const { store, operation, request } = context(root, "commit", "replace", {
      renderer: "renderers/panel.html",
      rendererRevision: "panel-v1",
    });
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    await store.emit({
      context: request,
      output: "panel",
      payload: "raw fallback",
      toolCallId: "renderer-1",
    });
    await store.markCoreCommitted(operation, "commit:1");
    const restarted = new FileNativeArtifactStore(root);
    expect(await restarted.readActiveProjection("world-1")).toMatchObject([
      {
        renderer: "renderers/panel.html",
        rendererRevision: "panel-v1",
        payload: "raw fallback",
      },
    ]);
  });

  test("无 artifact 的旧扩展也会被新 operation supersede，迟到 emit 只能留 raw", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-late-extension-"),
    );
    const first = context(root, "commit", "upsert", { key: "main" });
    await beginRequestFixture(first);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);

    const secondOperation = {
      ...first.operation,
      operationId: "operation-late-extension-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    const cold = new FileNativeArtifactStore(root);
    expect(await cold.readExtension(first.operation.operationId)).toEqual(
      expect.objectContaining({ status: "superseded" }),
    );
    await cold.emit({
      context: first.request,
      output: "panel",
      payload: "late",
      toolCallId: "late-extension-1",
    });
    expect(await cold.readActiveProjection("world-1")).toEqual([]);
    expect(
      await cold.readDebug("world-1", first.operation.operationId),
    ).toMatchObject([{ status: "superseded", payload: "late" }]);
    await cold.emit({
      context: secondRequest,
      output: "panel",
      payload: "new",
      toolCallId: "new-extension-1",
    });
    await cold.markCoreCommitted(secondOperation, "commit:2");
    expect(await cold.readActiveProjection("world-1")).toMatchObject([
      { payload: "new", head: "commit:2" },
    ]);
  });

  test("save:none 的迟到 emit 同样不会进入活动 projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-late-none-"));
    const first = context(root, "none", "replace");
    await beginRequestFixture(first);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);
    const secondOperation = {
      ...first.operation,
      operationId: "operation-late-none-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    await first.store.beginOperation(secondOperation);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "late-memory",
      toolCallId: "late-memory-1",
    });
    expect(await first.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await first.store.readDebug("world-1", first.operation.operationId),
    ).toMatchObject([{ status: "superseded", payload: "late-memory" }]);
    expect(
      await first.store.clear({
        context: first.request,
        output: "panel",
        toolCallId: "late-none-clear",
      }),
    ).toMatchObject({ ok: true });
    const cold = new FileNativeArtifactStore(root);
    expect(
      await cold.clear({
        context: first.request,
        output: "panel",
        toolCallId: "late-none-clear",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
  });

  test("新核心 head 通过高层 reconciliation 失效旧 head 产物和扩展", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-head-reconcile-"),
    );
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "old",
      toolCallId: "head-old",
    });
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);

    const secondOperation = {
      ...first.operation,
      operationId: "operation-head-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    await first.store.emit({
      context: secondRequest,
      output: "panel",
      payload: "new",
      toolCallId: "head-new",
    });
    await first.store.markCoreCommitted(secondOperation, "commit:2");
    expect(await first.store.readActiveProjection("world-1")).toMatchObject([
      { payload: "new", head: "commit:2" },
    ]);
    expect(
      await first.store.readExtension(first.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "superseded" }));
  });

  test("commit + operation_end 在扩展结束时失效，且 transient 在 post_commit 活跃窗口可见", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-operation-end-"),
    );
    const operationEnd = context(root, "commit", "upsert", {
      key: "main",
      invalidation: "operation_end",
    });
    await beginRequestFixture(operationEnd);
    await operationEnd.store.emit({
      context: operationEnd.request,
      output: "panel",
      payload: "operation-end",
      toolCallId: "operation-end-1",
    });
    await operationEnd.store.markCoreCommitted(
      operationEnd.operation,
      "commit:1",
    );
    expect(
      await operationEnd.store.readActiveProjection("world-1"),
    ).toHaveLength(1);
    await operationEnd.store.completeExtension(
      operationEnd.operation.operationId,
      ["decorate"],
    );
    expect(await operationEnd.store.readActiveProjection("world-1")).toEqual(
      [],
    );

    const failed = context(root, "commit", "append", {
      name: "failed",
      channel: "ui.failed",
      invalidation: "operation_end",
    });
    await beginRequestFixture(failed);
    await failed.store.emit({
      context: failed.request,
      output: "failed",
      payload: "discard-me",
      toolCallId: "failed-1",
    });
    await failed.store.markCoreCommitted(failed.operation, "commit:failed");
    expect(await failed.store.readActiveProjection("world-1")).toMatchObject([
      { output: "failed" },
    ]);
    await failed.store.failExtension(
      failed.operation.operationId,
      "failed",
      "post-commit failed",
    );
    expect(await failed.store.readActiveProjection("world-1")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ output: "failed" })]),
    );

    const transient = context(root, "commit", "transient", {
      name: "live",
      channel: "ui.live",
      invalidation: "operation_end",
    });
    await beginRequestFixture(transient);
    await transient.store.emit({
      context: transient.request,
      output: "live",
      payload: "post-commit",
      toolCallId: "live-1",
    });
    await transient.store.markCoreCommitted(transient.operation, "commit:2");
    expect(await transient.store.readActiveProjection("world-1")).toEqual([]);
    await transient.store.beginExtension(transient.operation);
    expect(await transient.store.readActiveProjection("world-1")).toMatchObject(
      [{ output: "live", payload: "post-commit" }],
    );
    await transient.store.completeExtension(transient.operation.operationId, [
      "decorate",
    ]);
    expect(await transient.store.readActiveProjection("world-1")).toEqual([]);
  });

  test("clear 只影响事件时已有记录，旧 operation late clear 不能清掉新面板", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-clear-order-"),
    );
    const first = context(root, "operation", "upsert", {
      key: "main",
      maxEmits: 2,
    });
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "before-clear",
      toolCallId: "before-clear",
    });
    await first.store.clear({
      context: first.request,
      output: "panel",
      toolCallId: "clear-before-second",
    });
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "after-clear",
      toolCallId: "after-clear",
    });
    expect(await first.store.readActiveProjection("world-1")).toMatchObject([
      { payload: "after-clear" },
    ]);

    const secondOperation = {
      ...first.operation,
      operationId: "operation-clear-second",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
    } satisfies ArtifactRequestContext;
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    await first.store.emit({
      context: secondRequest,
      output: "panel",
      payload: "current",
      toolCallId: "current-panel",
    });
    await first.store.markCoreCommitted(secondOperation, "commit:2");
    await first.store.clear({
      context: first.request,
      output: "panel",
      toolCallId: "stale-clear",
    });
    expect(await first.store.readActiveProjection("world-1")).toMatchObject([
      { payload: "current", operationId: secondOperation.operationId },
    ]);
  });

  test("artifact tool-call 身份绑定 tool、request/attempt、operation 与完整参数", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-call-identity-"),
    );
    const { store, operation, request } = context(root, "operation", "append", {
      maxEmits: 2,
    });
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    await store.emit({
      context: request,
      output: "panel",
      payload: "same",
      toolCallId: "shared-call",
    });
    expect(
      await store.emit({
        context: request,
        output: "panel",
        payload: "same",
        toolCallId: "shared-call",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
    expect(
      await store.emit({
        context: { ...request, requestAttempt: 2 },
        output: "panel",
        payload: "same",
        toolCallId: "shared-call",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await store.clear({
        context: request,
        output: "panel",
        toolCallId: "shared-call",
      }),
    ).toMatchObject({ ok: false });

    expect(
      await store.clear({
        context: request,
        output: "panel",
        toolCallId: "clear-call",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.clear({
        context: request,
        output: "panel",
        toolCallId: "clear-call",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
    expect(
      await store.clear({
        context: { ...request, requestAttempt: 2 },
        output: "panel",
        toolCallId: "clear-call",
      }),
    ).toMatchObject({ ok: false });
  });

  test("debug 返回获准 raw payload，且不泄漏 provider 内部字段", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-safe-debug-"));
    const { store, operation, request } = context(root, "operation", "append");
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    await store.emit({
      context: request,
      output: "panel",
      payload: "中文🙂x",
      toolCallId: "utf8-1",
    });
    const debug = await store.readDebug("world-1", operation.operationId);
    expect(debug[0]).toMatchObject({ payload: "中文🙂x" });
    expect(debug[0]).not.toHaveProperty("providerState");
    expect(debug[0]).not.toHaveProperty("reasoning");
    expect(debug[0]).not.toHaveProperty("transcript");
    expect(debug[0]).not.toHaveProperty("path");
  });

  test("beginOperation 在已写入 current operation 后重试仍完成旧扩展失效", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-begin-retry-"),
    );
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);
    const secondOperation = {
      ...first.operation,
      operationId: "operation-begin-retry-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    await mkdir(join(root, "artifact-store", "operations"), {
      recursive: true,
    });
    await writeFile(
      operationFile(root, secondOperation.operationId),
      JSON.stringify({
        schemaVersion: 1,
        context: secondOperation,
        status: "running",
        extensionStatus: "not_started",
        completedRequests: [],
        artifactProjectionStatus: "active",
        requestAttempts: {},
      }),
      "utf8",
    );
    const restarted = new FileNativeArtifactStore(root);
    await restarted.beginOperation(secondOperation);
    expect(await restarted.readExtension(first.operation.operationId)).toEqual(
      expect.objectContaining({ status: "superseded" }),
    );
    await restarted.beginOperation(secondOperation);
    expect(await restarted.readExtension(first.operation.operationId)).toEqual(
      expect.objectContaining({ status: "superseded" }),
    );
  });

  test("core_committed/not_started 的 receipt 窗口会在新 operation 时 supersede", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-receipt-window-"),
    );
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    const secondOperation = {
      ...first.operation,
      operationId: "operation-receipt-window-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    const cold = new FileNativeArtifactStore(root);
    expect(await cold.readExtension(first.operation.operationId)).toEqual(
      expect.objectContaining({ status: "superseded" }),
    );
    expect(
      await cold.resumeExtension(first.operation.operationId),
    ).toMatchObject({ status: "superseded" });
    await cold.emit({
      context: first.request,
      output: "panel",
      payload: "late-receipt-window",
      toolCallId: "late-receipt-window",
    });
    await cold.emit({
      context: secondRequest,
      output: "panel",
      payload: "current",
      toolCallId: "current-receipt-window",
    });
    expect(await cold.readActiveProjection("world-1")).toEqual([]);
  });

  test("completed operation 的混合 invalidation 只失效不匹配的 head record", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-mixed-invalidation-"),
    );
    const mixed = context(root, "commit", "replace", {
      name: "head-bound",
      channel: "ui.head",
      invalidation: "head_change",
    });
    mixed.request.declarations = [
      declaration("commit", "replace", {
        name: "head-bound",
        channel: "ui.head",
        invalidation: "head_change",
      }),
      declaration("commit", "append", {
        name: "keep",
        channel: "ui.keep",
        invalidation: "never",
      }),
    ];
    await beginRequestFixture(mixed);
    await mixed.store.emit({
      context: mixed.request,
      output: "head-bound",
      payload: "old-head",
      toolCallId: "mixed-head",
    });
    await mixed.store.emit({
      context: mixed.request,
      output: "keep",
      payload: "keep-after-head-change",
      toolCallId: "mixed-keep",
    });
    await mixed.store.markCoreCommitted(mixed.operation, "commit:1");
    await mixed.store.completeExtension(mixed.operation.operationId, []);
    await mixed.store.reconcileHead("world-1", "commit:2");
    expect(
      await mixed.store.readExtension(mixed.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "completed" }));
    expect(await mixed.store.readActiveProjection("world-1")).toMatchObject([
      { output: "keep", payload: "keep-after-head-change" },
    ]);
    expect(await mixed.store.readActiveProjection("world-1")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ output: "head-bound" }),
      ]),
    );
  });

  test("complete/fail 会清理 save:none，但不会抹掉 commit+never", async () => {
    const completedRoot = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-none-complete-"),
    );
    const completed = context(completedRoot, "none", "replace", {
      name: "none-complete",
      channel: "ui.none.complete",
      invalidation: "never",
    });
    await beginRequestFixture(completed);
    await completed.store.emit({
      context: completed.request,
      output: "none-complete",
      payload: "gone-on-complete",
      toolCallId: "none-complete-1",
    });
    expect(await completed.store.readActiveProjection("world-1")).toHaveLength(
      1,
    );
    await completed.store.markCoreCommitted(
      completed.operation,
      "commit:completed-none",
    );
    await completed.store.completeExtension(
      completed.operation.operationId,
      [],
    );
    expect(await completed.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await new FileNativeArtifactStore(completedRoot).readActiveProjection(
        "world-1",
      ),
    ).toEqual([]);

    const failedRoot = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-none-fail-"),
    );
    const failed = context(failedRoot, "none", "replace", {
      name: "none-fail",
      channel: "ui.none.fail",
      invalidation: "never",
    });
    await beginRequestFixture(failed);
    await failed.store.emit({
      context: failed.request,
      output: "none-fail",
      payload: "gone-on-fail",
      toolCallId: "none-fail-1",
    });
    await failed.store.markCoreCommitted(
      failed.operation,
      "commit:failed-none",
    );
    await failed.store.failExtension(
      failed.operation.operationId,
      "failed",
      "extension failed",
    );
    expect(await failed.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await new FileNativeArtifactStore(failedRoot).readActiveProjection(
        "world-1",
      ),
    ).toEqual([]);

    const retainedRoot = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-commit-never-"),
    );
    const retained = context(retainedRoot, "commit", "replace", {
      name: "commit-never",
      channel: "ui.commit.never",
      invalidation: "never",
    });
    await beginRequestFixture(retained);
    await retained.store.emit({
      context: retained.request,
      output: "commit-never",
      payload: "keep-on-complete",
      toolCallId: "commit-never-1",
    });
    await retained.store.markCoreCommitted(retained.operation, "commit:1");
    await retained.store.completeExtension(retained.operation.operationId, []);
    expect(await retained.store.readActiveProjection("world-1")).toMatchObject([
      { output: "commit-never", payload: "keep-on-complete" },
    ]);
  });

  test("markCoreCommitted 同 head 单调幂等，冲突 head 拒绝且冷重启不回退", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-commit-idempotent-"),
    );
    const current = context(root, "commit", "replace");
    await beginRequestFixture(current);
    await current.store.emit({
      context: current.request,
      output: "panel",
      payload: "committed",
      toolCallId: "commit-idempotent-1",
    });
    await current.store.markCoreCommitted(current.operation, "commit:1");
    await current.store.beginExtension(current.operation);
    await current.store.markCoreCommitted(current.operation, "commit:1");
    expect(
      await current.store.readExtension(current.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "running" }));
    expect(
      await current.store.readDebug("world-1", current.operation.operationId),
    ).toHaveLength(1);
    await current.store.completeExtension(current.operation.operationId, []);
    await current.store.beginExtension(current.operation);
    expect(
      await current.store.readExtension(current.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "completed" }));
    await expect(
      current.store.markCoreCommitted(current.operation, "commit:2"),
    ).rejects.toThrow(
      "Completed artifact operation has a conflicting core head",
    );
    await current.store.markCoreCommitted(current.operation, "commit:1");
    const cold = new FileNativeArtifactStore(root);
    expect(await cold.readExtension(current.operation.operationId)).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect(await cold.readActiveProjection("world-1")).toMatchObject([
      { payload: "committed", head: "commit:1" },
    ]);
  });

  test("projection supersede 后的迟到 core receipt 不会通过 activate 复活旧 record", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-artifact-no-revive-"));
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "old",
      toolCallId: "no-revive-old",
    });
    await first.store.markCoreCommitted(first.operation, "commit:1");
    const secondOperation = {
      ...first.operation,
      operationId: "operation-no-revive-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    await first.store.beginOperation(secondOperation);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    expect(await first.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await first.store.readDebug("world-1", first.operation.operationId),
    ).toMatchObject([{ status: "superseded" }]);
    expect(
      await first.store.readExtension(first.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "superseded" }));
  });

  test("stale clear 记录 ignored-call ledger，变参冲突且冷重启一致", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-stale-clear-"),
    );
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.beginExtension(first.operation);
    const secondOperation = {
      ...first.operation,
      operationId: "operation-stale-clear-second",
      parentHead: "commit:1",
    } satisfies ArtifactOperationContext;
    await first.store.beginOperation(secondOperation);
    expect(
      await first.store.clear({
        context: first.request,
        output: "panel",
        toolCallId: "stale-clear-ledger",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await first.store.clear({
        context: first.request,
        output: "panel",
        toolCallId: "stale-clear-ledger",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
    expect(
      await first.store.clear({
        context: { ...first.request, requestAttempt: 2 },
        output: "panel",
        toolCallId: "stale-clear-ledger",
      }),
    ).toMatchObject({ ok: false });
    const cold = new FileNativeArtifactStore(root);
    expect(
      await cold.clear({
        context: first.request,
        output: "panel",
        toolCallId: "stale-clear-ledger",
      }),
    ).toMatchObject({ ok: true, idempotent: true });
    expect(
      await cold.clear({
        context: { ...first.request, requestAttempt: 3 },
        output: "panel",
        toolCallId: "stale-clear-ledger",
      }),
    ).toMatchObject({ ok: false });
    expect(await cold.readActiveProjection("world-1")).toEqual([]);
  });

  test("beginOperation 直接按 parentHead reconciliation 失效 completed 旧 head", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-parent-reconcile-"),
    );
    const first = context(root, "commit", "replace");
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "old-head",
      toolCallId: "parent-reconcile-old",
    });
    await first.store.markCoreCommitted(first.operation, "commit:1");
    await first.store.completeExtension(first.operation.operationId, []);
    const secondOperation = {
      ...first.operation,
      operationId: "operation-parent-reconcile-second",
      parentHead: "commit:2",
    } satisfies ArtifactOperationContext;
    await first.store.beginOperation(secondOperation);
    expect(await first.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await first.store.readExtension(first.operation.operationId),
    ).toEqual(expect.objectContaining({ status: "completed" }));
    expect(
      await first.store.readDebug("world-1", first.operation.operationId),
    ).toMatchObject([{ status: "superseded" }]);
  });

  test("核心 receipt 将 operation/none 仍有效产物绑定新 head，post_commit 产物立即继承且 none 不落 raw", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-bind-all-save-"),
    );
    const store = new FileNativeArtifactStore(root);
    const operation = {
      worldId: "world-1",
      parentHead: "genesis",
      operationId: "operation-bind-all-save",
      playPresetId: "play-1",
      playPresetRevision: "rev-1",
      playPresetScriptsEnabled: true,
    } satisfies ArtifactOperationContext;
    const request = {
      ...operation,
      requestId: "core-after-freeze",
      requestAttempt: 1,
      maxArtifactBytes: 4096,
      declarations: [
        declaration("operation", "replace", {
          name: "operation-output",
          channel: "ui.operation",
          invalidation: "head_change",
        }),
        declaration("none", "replace", {
          name: "memory-output",
          channel: "ui.memory",
          invalidation: "head_change",
        }),
      ],
    } satisfies ArtifactRequestContext;
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    await store.emit({
      context: request,
      output: "operation-output",
      payload: "before receipt",
      toolCallId: "bind-operation-before",
    });
    await store.emit({
      context: request,
      output: "memory-output",
      payload: "memory before receipt",
      toolCallId: "bind-none-before",
    });
    await store.markCoreCommitted(operation, "commit:bind-all");
    await store.beginExtension(operation);
    expect(await store.readActiveProjection("world-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: "operation-output",
          head: "commit:bind-all",
        }),
        expect.objectContaining({
          output: "memory-output",
          head: "commit:bind-all",
        }),
      ]),
    );
    expect(
      await new FileNativeArtifactStore(root).readDebug(
        "world-1",
        operation.operationId,
      ),
    ).toHaveLength(1);

    const postRequest = {
      ...request,
      requestId: "post-decorate",
      declarations: [
        declaration("operation", "append", {
          name: "post-operation",
          channel: "ui.post.operation",
          invalidation: "never",
        }),
        declaration("none", "append", {
          name: "post-memory",
          channel: "ui.post.memory",
          invalidation: "never",
        }),
      ],
    } satisfies ArtifactRequestContext;
    await store.beginRequestAttempt(postRequest);
    await store.emit({
      context: postRequest,
      output: "post-operation",
      payload: "post operation",
      toolCallId: "bind-post-operation",
    });
    await store.emit({
      context: postRequest,
      output: "post-memory",
      payload: "post memory",
      toolCallId: "bind-post-none",
    });
    expect(await store.readActiveProjection("world-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: "post-operation",
          head: "commit:bind-all",
        }),
        expect.objectContaining({
          output: "post-memory",
          head: "commit:bind-all",
        }),
      ]),
    );
    await store.completeExtension(operation.operationId, [
      postRequest.requestId,
    ]);
    expect(await store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await new FileNativeArtifactStore(root).readActiveProjection("world-1"),
    ).toEqual([]);
    expect(
      await new FileNativeArtifactStore(root).readDebug(
        "world-1",
        operation.operationId,
      ),
    ).toHaveLength(2);
  });

  test("request attempt 单调隔离预算、clear 和 projection，旧 attempt 冷重建仅保留 debug", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-request-attempt-"),
    );
    const { store, operation, request } = context(root, "operation", "upsert", {
      key: "main",
      maxEmits: 2,
    });
    request.maxArtifactBytes = 16;
    await store.beginOperation(operation);
    await store.beginRequestAttempt(request);
    await store.emit({
      context: request,
      output: "panel",
      payload: "old",
      toolCallId: "attempt-one-old",
    });
    await store.clear({
      context: request,
      output: "panel",
      toolCallId: "attempt-one-clear",
    });
    const attemptTwo = { ...request, requestAttempt: 2 };
    await store.beginRequestAttempt(attemptTwo);
    await store.emit({
      context: attemptTwo,
      output: "panel",
      payload: "new1",
      toolCallId: "attempt-two-new-1",
    });
    await store.emit({
      context: attemptTwo,
      output: "panel",
      payload: "new2",
      toolCallId: "attempt-two-new-2",
    });
    expect(
      await store.emit({
        context: attemptTwo,
        output: "panel",
        payload: "new3",
        toolCallId: "attempt-two-over-max",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await store.emit({
        context: request,
        output: "panel",
        payload: "late-old",
        toolCallId: "attempt-one-late",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.emit({
        context: request,
        output: "panel",
        payload: "changed-attempt",
        toolCallId: "attempt-two-new-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await store.clear({
        context: request,
        output: "panel",
        toolCallId: "attempt-one-late-clear",
      }),
    ).toMatchObject({ ok: true });
    await store.markCoreCommitted(operation, "commit:attempt");
    expect(await store.readActiveProjection("world-1")).toMatchObject([
      { output: "panel", payload: "new2", head: "commit:attempt" },
    ]);
    const debug = await store.readDebug("world-1", operation.operationId);
    expect(debug.filter(({ requestAttempt }) => requestAttempt === 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "superseded", payload: "old" }),
        expect.objectContaining({
          status: "superseded",
          payload: "late-old",
        }),
      ]),
    );
    expect(debug.filter(({ requestAttempt }) => requestAttempt === 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "active", payload: "new2" }),
      ]),
    );
    const cold = new FileNativeArtifactStore(root);
    expect(await cold.readActiveProjection("world-1")).toMatchObject([
      { output: "panel", payload: "new2", head: "commit:attempt" },
    ]);
    expect(await cold.readDebug("world-1", operation.operationId)).toEqual(
      debug,
    );
  });

  test("有效 current-attempt clear 可清旧 operation，reopen 后 clear 回滚且 save:none clear 冷重建不复活旧面板", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-artifact-cross-op-clear-"),
    );
    const first = context(root, "commit", "upsert", {
      key: "main",
      invalidation: "never",
    });
    await beginRequestFixture(first);
    await first.store.emit({
      context: first.request,
      output: "panel",
      payload: "old-panel",
      toolCallId: "cross-clear-old",
    });
    await first.store.markCoreCommitted(first.operation, "commit:old");
    await first.store.completeExtension(first.operation.operationId, []);

    const secondOperation = {
      ...first.operation,
      operationId: "operation-cross-clear-second",
      parentHead: "commit:old",
    } satisfies ArtifactOperationContext;
    const secondRequest = {
      ...first.request,
      ...secondOperation,
      requestId: "clear-request",
      requestAttempt: 1,
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(secondOperation);
    await first.store.beginRequestAttempt(secondRequest);
    await first.store.clear({
      context: secondRequest,
      output: "panel",
      toolCallId: "cross-clear-current",
    });
    expect(await first.store.readActiveProjection("world-1")).toEqual([]);
    expect(
      await new FileNativeArtifactStore(root).readActiveProjection("world-1"),
    ).toEqual([]);

    await first.store.beginRequestAttempt({
      ...secondRequest,
      requestAttempt: 2,
    });
    expect(await first.store.readActiveProjection("world-1")).toMatchObject([
      { output: "panel", payload: "old-panel", head: "commit:old" },
    ]);
    expect(
      await new FileNativeArtifactStore(root).readActiveProjection("world-1"),
    ).toMatchObject([{ output: "panel", payload: "old-panel" }]);

    const noneClearOperation = {
      ...secondOperation,
      operationId: "operation-none-clear",
    } satisfies ArtifactOperationContext;
    const noneClearRequest = {
      ...secondRequest,
      ...noneClearOperation,
      declarations: [
        declaration("none", "upsert", {
          name: "panel",
          channel: "ui.panel",
          key: "main",
          invalidation: "never",
        }),
      ],
    } satisfies ArtifactRequestContext;
    await first.store.beginOperation(noneClearOperation);
    await first.store.beginRequestAttempt(noneClearRequest);
    await first.store.clear({
      context: noneClearRequest,
      output: "panel",
      toolCallId: "none-clear-persisted",
    });
    const cold = new FileNativeArtifactStore(root);
    expect(await cold.readActiveProjection("world-1")).toEqual([]);
    expect(
      await cold.readDebug("world-1", noneClearOperation.operationId),
    ).toEqual([]);
  });
});
