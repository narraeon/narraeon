import { canRetryAuthoringDispatch } from "../../src/runtime/authoring/AuthoringRetry.ts";
import { authoringTargetContract } from "./support/authoring-target-contract.ts";
import { parseDocument } from "yaml";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

import { afterEach, expect, test, vi } from "vitest";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  ScriptedModelHost,
  ModelHostBindingMismatchError,
  ModelHostContinuationError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  type ModelHost,
  type ModelHostBinding,
  type ScriptedModelHostStep,
} from "../../src/runtime/model/ModelHost.ts";
import {
  builtinDefaultPlayPresetBinding,
  parsePlayPresetFiles,
  revisionForPlayPresetFiles,
  presetHostBinding,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeSettingImprovementStore } from "../../src/runtime/setting/FileNativeSettingImprovementStore.ts";
import { SettingAuthoringTransaction } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { SettingImprovementSession } from "../../src/runtime/setting/SettingImprovementSession.ts";
import {
  googleAuthoringHost,
  googleInterruptedHost,
  googleSignedText,
  googleText,
  googleTools,
  interruptedGoogleWrite,
} from "./support/google-authoring.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const binding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "endpoint:test",
  modelId: "model:test",
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "protocol:test",
  cacheStrategy: "provider_managed",
};

test("editing a historical message while keeping files replaces the later dialogue and preserves the native prefix", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First answer." },
    { outcome: "response", text: "Second answer." },
    { outcome: "response", text: "Revised answer." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "First message.",
  );
  const second = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "second",
    message: "Second message.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  const files = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const result = await fixture.session.editMessage({
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "edit",
    messageId: second.turns[1]!.user.id,
    message: "Revised message.",
    filePolicy: "keep",
  });
  expect(result.messages.map(({ text }) => text)).toEqual([
    "First message.",
    "First answer.",
    "Revised message.",
    "Revised answer.",
  ]);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(files);
  expect(fixture.host.requests[2]!.appended).toEqual([
    ...fixture.host.requests[1]!.appended.slice(0, -1),
    { kind: "user", text: "Revised message." },
  ]);
});

test("editing can revert only this conversation's later AI changes, once", async () => {
  const write = (id: string, contents: string) => ({
    outcome: "response" as const,
    toolCalls: [
      {
        id: `read-${id}`,
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: `write-${id}`,
        name: "setting_write_file",
        arguments: { path: "opening.md", contents },
      },
    ],
  });
  const fixture = await createFixture([
    write("one", "First edit.\n"),
    { outcome: "response", text: "First done." },
    write("two", "Second edit.\n"),
    { outcome: "response", text: "Second done." },
    { outcome: "response", text: "Revised." },
  ]);
  const original = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "First.",
  );
  await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "second",
    message: "Second.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const manual = {
    path: "control/blocks/manual.md",
    contents: "Later manual edit.\n",
  };
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    [...current.files, manual],
    { baseTreeRevision: current.treeRevision },
  );
  const input = {
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "edit",
    messageId: first.turns[0]!.user.id,
    message: "Different.",
    filePolicy: "revert" as const,
  };
  const revised = await fixture.session.editMessage(input);
  expect(revised.messages.map(({ text }) => text)).toEqual([
    "Different.",
    "Revised.",
  ]);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual([...original, manual].sort((a, b) => a.path.localeCompare(b.path)));
  const saved = await new FileNativeSettingImprovementStore(fixture.root).read(
    first.sessionId,
  );
  expect(saved.authorization?.revision).toBe(
    contentTreeFingerprint(
      (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    ),
  );
  expect(await fixture.session.editMessage(input)).toEqual(revised);
  await expect(
    fixture.session.editMessage({ ...input, message: "Different payload." }),
  ).rejects.toThrow(/already used for different content/u);
  expect(fixture.host.requests).toHaveLength(5);
});

test("editing with revert reports every conflicting path and leaves files and dialogue intact", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        { id: "read", name: "setting_read", arguments: { path: "opening.md" } },
        {
          id: "write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "AI version.\n" },
        },
      ],
    },
    { outcome: "response", text: "Done." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Edit.",
  );
  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const manual = current.files.map((file) =>
    file.path === "opening.md"
      ? { ...file, contents: "Manual version.\n" }
      : file,
  );
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    manual,
    { baseTreeRevision: current.treeRevision },
  );
  await expect(
    fixture.session.editMessage({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Revised.",
      filePolicy: "revert",
    }),
  ).rejects.toThrow(/opening\.md/u);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(manual);
  expect(
    (await fixture.session.readSession(fixture.packageId, first.sessionId))
      .messages,
  ).toEqual(first.messages);
});

test("revert rejects a newly dangling reference from another conversation", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create",
          name: "setting_create",
          arguments: {
            path: "world/notes/created.yaml",
            ref: "created-note",
            title: "Created",
            summary: "Created note",
            aliases: [],
            body: "status: active\n",
          },
        },
      ],
    },
    { outcome: "response", text: "Created." },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read",
          name: "setting_read",
          arguments: { path: "@current-situation" },
        },
        {
          id: "reference",
          name: "setting_patch",
          arguments: {
            document: "@current-situation",
            op: "add",
            locator: ["linkedNote"],
            value: { $ref: "@created-note" },
          },
        },
      ],
    },
    { outcome: "response", text: "Linked." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Create a note.",
  );
  const other = await sendFresh(
    fixture.session,
    fixture.packageId,
    "other",
    "Reference the note.",
  );
  expect(other.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.isError).toBe(
    false,
  );
  const before = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  await expect(
    fixture.session.editMessage({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Do something else.",
      filePolicy: "revert",
    }),
  ).rejects.toThrow(/invalid|reference/iu);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(before);
  expect(
    (await fixture.session.readSession(fixture.packageId, first.sessionId))
      .messages,
  ).toEqual(first.messages);
});

test("an edit rejects a conversation that advanced while its model binding was opening", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read-later",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "write-later",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Later change.\n" },
        },
      ],
    },
    { outcome: "response", text: "Later response." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Original.",
  );
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slow = serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
    undefined,
    undefined,
    async () => {
      started.resolve();
      await release.promise;
      return fixture.host;
    },
  );
  const editing = slow.editMessage({
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "edit",
    messageId: first.turns[0]!.user.id,
    message: "Revised.",
    filePolicy: "revert",
  });
  await started.promise;
  const later = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "later",
    message: "Later.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  release.resolve();
  await expect(editing).rejects.toThrow(/conversation changed/iu);
  expect(
    (await slow.readSession(fixture.packageId, first.sessionId)).messages,
  ).toEqual(later.messages);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Later change.\n");
});

test("another service cannot edit or send while a live response is in flight", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Original.",
  );
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scripted = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "late-read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "late-write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Live change.\n" },
          },
        ],
      },
      { outcome: "response", text: "Live answer." },
    ],
  });
  let firstExchange = true;
  const host: ModelHost = {
    binding: () => binding,
    exchange: async (request, observer) => {
      if (firstExchange) {
        firstExchange = false;
        started.resolve();
        await release.promise;
      }
      return scripted.exchange(request, observer);
    },
  };
  const active = serviceFor(fixture.root, fixture.content, host);
  const other = serviceFor(
    fixture.root,
    new ContentWorkspace(fixture.root, { locale: () => "en" }),
    host,
  );
  const running = active.send({
    packageId: fixture.packageId,
    requestId: "live",
    message: "Live.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  await started.promise;
  await expect(
    other.editMessage({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Revised.",
      filePolicy: "revert",
    }),
  ).rejects.toThrow(/still running/iu);
  await expect(
    other.send({
      packageId: fixture.packageId,
      requestId: "other",
      message: "Other.",
      continuation: { kind: "continue_context", sessionId: first.sessionId },
    }),
  ).rejects.toThrow(/still running/iu);
  release.resolve();
  const complete = await running;
  expect(complete.messages.map(({ text }) => text)).toEqual([
    "Original.",
    "First.",
    "Live.",
    "Live answer.",
  ]);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Live change.\n");
});

test("another service cannot recover a running state before live ownership is registered", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Original.",
  );
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = store.save.bind(store);
  let pause = true;
  vi.spyOn(store, "save").mockImplementation(async (session) => {
    await save(session);
    if (
      pause &&
      session.runStatus === "running" &&
      session.activeRequestId === "next"
    ) {
      pause = false;
      started.resolve();
      await release.promise;
    }
  });
  const active = serviceFor(
    fixture.root,
    fixture.content,
    host,
    undefined,
    store,
  );
  const other = serviceFor(
    fixture.root,
    new ContentWorkspace(fixture.root, { locale: () => "en" }),
    host,
  );
  const running = active.send({
    packageId: fixture.packageId,
    requestId: "next",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  await started.promise;
  await expect(
    other.readSession(fixture.packageId, first.sessionId),
  ).rejects.toThrow(/running/iu);
  release.resolve();
  expect((await running).messages.at(-1)?.text).toBe("Finished.");
});

test.each(["applied", "apply_outcome_unknown"] as const)(
  "unattributed legacy %s file changes cannot be automatically reverted",
  async (outcome) => {
    const fixture = await createFixture([
      { outcome: "response", text: "First." },
      { outcome: "response", text: "Kept." },
    ]);
    const first = await sendFresh(
      fixture.session,
      fixture.packageId,
      "first",
      "Original.",
    );
    const store = new FileNativeSettingImprovementStore(fixture.root);
    const stored = await store.read(first.sessionId);
    stored.legacyDraft = {
      outcome,
      changes: [
        {
          path: "opening.md",
          kind: "modify",
          before: "Before",
          after: "After",
        },
      ],
    };
    await store.save(stored);
    const service = serviceFor(fixture.root, fixture.content, fixture.host);
    const before = await fixture.content.readCurrentTreeContentPackage(
      fixture.packageId,
    );
    const input = {
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Changed.",
      filePolicy: "revert" as const,
    };
    await expect(service.editMessage(input)).rejects.toMatchObject({
      reason: "unattributed",
      paths: ["opening.md"],
    });
    expect(
      (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    ).toEqual(before.files);
    expect(
      (await service.readSession(fixture.packageId, first.sessionId)).messages,
    ).toEqual(first.messages);
    expect(
      (await service.editMessage({ ...input, filePolicy: "keep" })).runStatus,
    ).toBe("ready");
  },
);

test.each(["before publication", "after publication"] as const)(
  "%s a pending edit recovers before a new workspace accesses the package",
  async (phase) => {
    const fixture = await createFixture([
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "AI version.\n" },
          },
        ],
      },
      { outcome: "response", text: "Done." },
    ]);
    const originalFiles = (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files;
    const first = await sendFresh(
      fixture.session,
      fixture.packageId,
      "first",
      "Edit.",
    );
    const store = new FileNativeSettingImprovementStore(fixture.root);
    const service = serviceFor(
      fixture.root,
      fixture.content,
      fixture.host,
      undefined,
      store,
    );
    vi.spyOn(store, "finishPendingEdit").mockImplementationOnce(
      async (session, lease) => {
        if (phase === "after publication")
          await lease.replace(session.pendingEdit!.afterFiles);
        throw new Error("simulated crash");
      },
    );
    await expect(
      service.editMessage({
        packageId: fixture.packageId,
        sessionId: first.sessionId,
        requestId: "edit",
        messageId: first.turns[0]!.user.id,
        message: "Revised.",
        filePolicy: "revert",
      }),
    ).rejects.toThrow("simulated crash");
    const coldContent = new ContentWorkspace(fixture.root, {
      locale: () => "en",
    });
    const recoveredTree = await coldContent.readCurrentTreeContentPackage(
      fixture.packageId,
    );
    expect(recoveredTree.files).toEqual(originalFiles);
    const retryHost = new ScriptedModelHost({
      binding,
      steps: [{ outcome: "response", text: "Recovered." }],
    });
    const cold = serviceFor(fixture.root, coldContent, retryHost);
    const recovered = await cold.readSession(
      fixture.packageId,
      first.sessionId,
    );
    expect(recovered).toMatchObject({
      runStatus: "interrupted",
      canRetry: true,
    });
    expect(recovered.messages.map(({ text }) => text)).toEqual(["Revised."]);
    const completed = await cold.resume({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "resume",
    });
    expect(completed.messages.map(({ text }) => text)).toEqual([
      "Revised.",
      "Recovered.",
    ]);
    expect(
      (await coldContent.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    ).toEqual(originalFiles);
  },
);

test("a marker left before edit intent is saved is safely cleared", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
    { outcome: "response", text: "Revised." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Original.",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const service = serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
    undefined,
    store,
  );
  vi.spyOn(store, "save").mockRejectedValueOnce(
    new Error("crash before intent"),
  );
  const input = {
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "edit",
    messageId: first.turns[0]!.user.id,
    message: "Revised.",
    filePolicy: "keep" as const,
  };
  await expect(service.editMessage(input)).rejects.toThrow(
    "crash before intent",
  );
  const coldContent = new ContentWorkspace(fixture.root, {
    locale: () => "en",
  });
  await expect(
    coldContent.readCurrentTreeContentPackage(fixture.packageId),
  ).resolves.toMatchObject({ localId: fixture.packageId });
  const cold = serviceFor(fixture.root, coldContent, fixture.host);
  expect(
    (await cold.readSession(fixture.packageId, first.sessionId)).messages,
  ).toEqual(first.messages);
  expect(
    (await cold.editMessage(input)).messages.map(({ text }) => text),
  ).toEqual(["Revised.", "Revised."]);
});

test("status observation recovers a pending edit before reporting its state", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Original.",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const service = serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
    undefined,
    store,
  );
  vi.spyOn(store, "finishPendingEdit").mockRejectedValueOnce(
    new Error("simulated crash"),
  );
  await expect(
    service.editMessage({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Revised.",
      filePolicy: "keep",
    }),
  ).rejects.toThrow("simulated crash");
  const cold = serviceFor(
    fixture.root,
    new ContentWorkspace(fixture.root, { locale: () => "en" }),
    fixture.host,
  );
  expect(
    (await cold.status(fixture.packageId, first.sessionId)).selected?.runStatus,
  ).toBe("interrupted");
  expect(
    (await cold.readSession(fixture.packageId, first.sessionId)).messages.map(
      ({ text }) => text,
    ),
  ).toEqual(["Revised."]);
});

test("historical schema 4 source is preserved exactly when upgrading to schema 5", async () => {
  // Generated by the original session service at 67f19cc before schema 5 existed.
  const source = gunzipSync(
    await readFile(
      new URL("./fixtures/author-schema4-67f19cc.json.gz", import.meta.url),
    ),
  ).toString("utf8");
  const old = JSON.parse(source) as {
    sessionId: string;
    schemaVersion: number;
  };
  expect(old.schemaVersion).toBe(4);
  const root = await temporaryRoot("schema4-historical-");
  const sessions = join(root, "setting-improvements", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, `${old.sessionId}.json`), source);
  const store = new FileNativeSettingImprovementStore(root);
  const original = await store.read(old.sessionId);
  await store.save({ ...original, schemaVersion: 5 });
  const backup = join(sessions, `${old.sessionId}.schema-v4.json`);
  expect(await readFile(backup, "utf8")).toBe(source);
  const migrated = await store.read(old.sessionId);
  expect(migrated).toEqual({ ...original, schemaVersion: 5 });
  await store.save(migrated);
  expect(await readFile(backup, "utf8")).toBe(source);
});

test("Google edit interrupted before dispatch resumes the proven-undispatched request", async () => {
  const root = await temporaryRoot("google-edit-predispatch-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const google = googleAuthoringHost([
    googleText("Initial."),
    googleText("Revised."),
  ]);
  const store = new FileNativeSettingImprovementStore(root);
  const service = serviceFor(root, content, google.host, undefined, store);
  const first = await sendFresh(service, localId, "first", "Original.");
  const finish = store.finishPendingEdit.bind(store);
  vi.spyOn(store, "finishPendingEdit").mockImplementationOnce(
    async (session, lease) => {
      await finish(session, lease);
      throw new Error("simulated crash before model dispatch");
    },
  );
  await expect(
    service.editMessage({
      packageId: localId,
      sessionId: first.sessionId,
      requestId: "edit",
      messageId: first.turns[0]!.user.id,
      message: "Revised request.",
      filePolicy: "keep",
    }),
  ).rejects.toThrow("simulated crash");
  const cold = serviceFor(
    root,
    new ContentWorkspace(root, { locale: () => "en" }),
    google.host,
  );
  const recovered = await cold.readSession(localId, first.sessionId);
  expect(recovered.runStatus).toBe("interrupted");
  const resumed = await cold.resume({
    packageId: localId,
    sessionId: first.sessionId,
    requestId: "resume",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Revised request.",
    "Revised.",
  ]);
});

test("damaged Google continuation after editing the first message remains isolated from package overview", async () => {
  const root = await temporaryRoot("google-edit-damaged-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const google = googleAuthoringHost([
    googleText("Initial."),
    googleText("Revised."),
  ]);
  const service = serviceFor(root, content, google.host);
  const first = await sendFresh(service, localId, "first", "Original.");
  await service.editMessage({
    packageId: localId,
    sessionId: first.sessionId,
    requestId: "edit",
    messageId: first.turns[0]!.user.id,
    message: "Revised request.",
    filePolicy: "keep",
  });
  const path = join(
    root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    modelItems: { kind: string; providerState?: { steps: unknown } }[];
  };
  stored.modelItems.find(
    (item) => item.kind === "assistant",
  )!.providerState!.steps = [{ type: "function_call", id: 4 }];
  await writeFile(path, JSON.stringify(stored));
  const overview = await serviceFor(root, content, google.host).overview(
    localId,
  );
  expect(overview.latest).toBeNull();
  expect(overview.history[0]?.unavailableReason).toMatch(/damaged/iu);
});

test("a historical applied schema 1 draft cannot be reverted without message provenance", async () => {
  // Captured after a real Apply by the historical implementation at ab70bf9.
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL(
          "./fixtures/author-schema1-applied-ab70bf9.json.gz",
          import.meta.url,
        ),
      ),
    ).toString("utf8"),
  ) as { packageId: string; sessionId: string; files: Record<string, string> };
  const root = await temporaryRoot("schema1-applied-edit-");
  for (const [path, contents] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const store = new FileNativeSettingImprovementStore(root);
  const migrated = await store.read(fixture.sessionId);
  expect(migrated.legacyDraft?.outcome).toBe("applied");
  const host = new ScriptedModelHost({
    binding: migrated.modelBinding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "later-read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "later-write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Later change.\n" },
          },
        ],
      },
      { outcome: "response", text: "Later." },
      { outcome: "response", text: "Revised later message." },
    ],
  });
  const service = serviceFor(root, content, host);
  const before = await content.readCurrentTreeContentPackage(fixture.packageId);
  const message = migrated.messages.find((entry) => entry.role === "user")!;
  await expect(
    service.editMessage({
      packageId: fixture.packageId,
      sessionId: fixture.sessionId,
      requestId: "edit",
      messageId: message.id,
      message: "Revised.",
      filePolicy: "revert",
    }),
  ).rejects.toMatchObject({ reason: "unattributed", paths: ["opening.md"] });
  expect(
    (await content.readCurrentTreeContentPackage(fixture.packageId)).files,
  ).toEqual(before.files);
  const later = await service.send({
    packageId: fixture.packageId,
    requestId: "later",
    message: "Later change.",
    continuation: { kind: "continue_context", sessionId: fixture.sessionId },
  });
  const revised = await service.editMessage({
    packageId: fixture.packageId,
    sessionId: fixture.sessionId,
    requestId: "later-edit",
    messageId: later.turns.at(-1)!.user.id,
    message: "Changed later request.",
    filePolicy: "revert",
  });
  expect(revised.messages.at(-1)?.text).toBe("Revised later message.");
  expect(
    (await content.readCurrentTreeContentPackage(fixture.packageId)).files,
  ).toEqual(before.files);
});

test("a package without a pending edit does not inspect unrelated session files", async () => {
  const fixture = await createFixture([]);
  const sessions = join(fixture.root, "setting-improvements", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, "setting-00000000-0000-4000-8000-000000000000.json"),
    "{broken",
  );
  await expect(
    new ContentWorkspace(fixture.root).readCurrentTreeContentPackage(
      fixture.packageId,
    ),
  ).resolves.toMatchObject({ localId: fixture.packageId });
});

test("Google setting conversation settles ordered mixed calls and continues after restart", async () => {
  const root = await temporaryRoot("google-setting-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const { host, sent } = googleAuthoringHost([
    googleTools([
      { id: "read", name: "setting_read", arguments: { path: "opening.md" } },
      {
        id: "write",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: "First change.\n" },
      },
      {
        id: "fail",
        name: "setting_write_file",
        arguments: { path: "missing.md", contents: "No.\n" },
      },
      {
        id: "read-again",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "write-again",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: "Final change.\n" },
      },
    ]),
    googleSignedText("The changes are live."),
    googleText("Continued after restart."),
  ]);
  const service = serviceFor(root, content, host);
  const candidate = await service.preview(localId);
  const first = await sendFresh(
    service,
    localId,
    "google-first",
    "Edit the opening.",
  );
  expect(first.runStatus).toBe("ready");
  expect(first.requestPreviews?.[0]?.compilation).toEqual(candidate);
  expect(first.requestPreviews?.[0]?.wireRequest?.body).toEqual(sent[0]);
  const stored = await new FileNativeSettingImprovementStore(root).read(
    first.sessionId,
  );
  const corruptPreview = structuredClone(stored);
  corruptPreview.requests![0]!.wireRequest!.body = null;
  await expect(
    new FileNativeSettingImprovementStore(root).save(corruptPreview),
  ).rejects.toThrow(/durable schema/iu);
  expect(
    host.previewRequest({
      bootstrap: candidate,
      toolUniverse: candidate.toolUniverse,
      allowedTools: candidate.toolUniverse.map(({ name }) => name),
      toolStrategy: candidate.toolStrategy,
      tools: candidate.tools,
      appended: stored.modelItems.slice(0, 1),
      requestId: "google-first",
      operationId: first.sessionId,
      exchange: 1,
      maxOutputTokens: host.binding().maxOutputTokens,
    }).body,
  ).toEqual(sent[0]);
  expect(first.turns[0]?.exchanges[0]?.toolCalls).toMatchObject([
    { callId: "read", result: { isError: false } },
    {
      callId: "write",
      result: { isError: false, changes: [{ after: "First change.\n" }] },
    },
    { callId: "fail", result: { isError: true, changes: [] } },
    {
      callId: "read-again",
      result: {
        isError: false,
      },
    },
    {
      callId: "write-again",
      result: {
        isError: false,
        changes: [{ before: "First change.\n", after: "Final change.\n" }],
      },
    },
  ]);
  expect(
    first.turns[0]?.exchanges[0]?.toolCalls[3]?.result?.markdown,
  ).toContain("First change.");
  expect(
    (await content.readCurrentTreeContentPackage(localId)).files.find(
      ({ path }) => path === "opening.md",
    )?.contents,
  ).toBe("Final change.\n");
  expect(JSON.stringify(sent[1])).toContain('"call_id":"fail"');
  const resumed = await serviceFor(
    root,
    new ContentWorkspace(root, { locale: () => "en" }),
    host,
  ).send({
    packageId: localId,
    requestId: "google-next",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(resumed.runStatus).toBe("ready");
  expect(resumed.messages.at(-1)?.text).toBe("Continued after restart.");
  expect(JSON.stringify(sent[2])).toContain("The changes are live.");
  expect(JSON.stringify(sent[2])).toContain("synthetic-signature-secret");
  expect(JSON.stringify(sent[2])).toContain("synthetic-opaque-secret");
  expect(JSON.stringify(resumed.requestPreviews)).not.toContain(
    "synthetic-signature-secret",
  );
  expect(JSON.stringify(resumed.requestPreviews)).not.toContain(
    "synthetic-opaque-secret",
  );
  const incompatible = new FileNativeModelHost({
    provider: "chat_completions",
    baseUrl: "https://other.invalid/v1beta",
    apiKey: "synthetic",
    modelId: "manual-model",
    contextWindowTokens: 64000,
    maxOutputTokens: 2000,
  });
  await expect(
    serviceFor(root, content, incompatible).send({
      packageId: localId,
      requestId: "incompatible",
      message: "Continue.",
      continuation: { kind: "continue_context", sessionId: first.sessionId },
    }),
  ).rejects.toThrow(/protocol|context/iu);
  expect(sent).toHaveLength(3);
});

test("Google setting 多跳证据随作者请求冷读取并遮蔽 token 和签名", async () => {
  const root = await temporaryRoot("google-setting-hops-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const firstHop = googleSignedText("Beginning. ");
  firstHop.unshift({ event_type: "interaction.created" });
  firstHop[firstHop.length - 1] = {
    event_type: "interaction.completed",
    interaction: {
      status: "requires_continuation",
      continuation_token: "author-token",
    },
  };
  const secondHop = [
    { event_type: "interaction.created" },
    ...googleText("Finished."),
  ];
  const { host, sent } = googleAuthoringHost([firstHop, secondHop]);
  const first = await sendFresh(
    serviceFor(root, content, host),
    localId,
    "multi-hop",
    "Continue.",
  );
  expect(first.runStatus).toBe("ready");
  expect(first.messages.at(-1)?.text).toBe("Beginning. Finished.");
  expect(sent[1]).toEqual({ ...sent[0], continuation_token: "author-token" });
  const saved = await new FileNativeSettingImprovementStore(root).read(
    first.sessionId,
  );
  expect(saved.requests?.[0]?.wireRequest?.googleHops).toMatchObject([
    { hop: 1, status: "requires_continuation", tokenSupplied: false },
    { hop: 2, status: "completed", tokenSupplied: true },
  ]);
  const preview = JSON.stringify(saved.requests?.[0]?.wireRequest);
  expect(preview).not.toContain("author-token");
  expect(preview).not.toContain("synthetic-signature-secret");
});

test("Google 作者续接第二跳挂起时冷读取已派发证据", async () => {
  const root = await temporaryRoot("google-setting-inflight-hops-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  let count = 0;
  let finish!: (response: Response) => void;
  const host = new FileNativeModelHost(
    {
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "secret",
      modelId: "manual-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 2000,
    },
    () => {
      count++;
      if (count === 2)
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      const events = [
        { event_type: "interaction.created" },
        {
          event_type: "interaction.completed",
          interaction: {
            status: "requires_continuation",
            continuation_token: "private-token",
          },
        },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  );
  const running = sendFresh(
    serviceFor(root, content, host),
    localId,
    "inflight",
    "Continue.",
  );
  await vi.waitFor(() => expect(count).toBe(2));
  const store = new FileNativeSettingImprovementStore(root);
  await vi.waitFor(async () => {
    const saved = await store.findByCreationRequest(localId, "inflight");
    expect(saved?.requests?.[0]?.wireRequest?.googleHops).toMatchObject([
      { hop: 1, status: "requires_continuation" },
      { hop: 2, status: "attempted", tokenSupplied: true },
    ]);
    const journal = join(
      root,
      "setting-improvements",
      "sessions",
      ".google-hops",
      saved!.sessionId,
      createHash("sha256").update("inflight").digest("hex"),
    );
    const firstHop = JSON.parse(
      await readFile(join(journal, "1-1-1.json"), "utf8"),
    ) as { status: string };
    const secondHop = JSON.parse(
      await readFile(join(journal, "1-1-2.json"), "utf8"),
    ) as { status: string };
    expect(firstHop.status).toBe("requires_continuation");
    expect(secondHop.status).toBe("attempted");
  });
  finish(
    new Response(
      [{ event_type: "interaction.created" }, ...googleText("Finished.")]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  expect((await running).runStatus).toBe("ready");
});

test.each(["empty", "malformed", "missing", "null"])(
  "Google setting rejects %s persisted continuation after restart",
  async (corruption) => {
    const root = await temporaryRoot("google-setting-corrupt-");
    const content = new ContentWorkspace(root, { locale: () => "en" });
    const { localId } = await content.createCurrentTreeContentPackage();
    const { host, sent } = googleAuthoringHost([
      googleText("Original answer."),
      googleText("Fresh context."),
    ]);
    const first = await sendFresh(
      serviceFor(root, content, host),
      localId,
      "first",
      "Discuss.",
    );
    const path = join(
      root,
      "setting-improvements",
      "sessions",
      `${first.sessionId}.json`,
    );
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      modelItems: { kind: string; providerState?: { steps: unknown } | null }[];
    };
    const assistant = stored.modelItems.find(
      (item: { kind: string }) => item.kind === "assistant",
    )!;
    if (corruption === "missing") delete assistant.providerState;
    else if (corruption === "null") assistant.providerState = null;
    else
      assistant.providerState!.steps =
        corruption === "empty" ? [] : [{ type: "function_call", id: 4 }];
    const damagedBytes = JSON.stringify(stored);
    await writeFile(path, damagedBytes);
    const before = await content.readCurrentTreeContentPackage(localId);
    const send = () =>
      serviceFor(root, content, host).send({
        packageId: localId,
        requestId: "next",
        message: "Continue.",
        continuation: { kind: "continue_context", sessionId: first.sessionId },
      });
    if (corruption === "empty") {
      await expect(send()).rejects.toThrow(/fresh model context/iu);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stored);
    } else await expect(send()).rejects.toThrow(/fresh model context/iu);
    expect(sent).toHaveLength(1);
    expect(
      (await content.readCurrentTreeContentPackage(localId)).files,
    ).toEqual(before.files);
    const overview = await serviceFor(root, content, host).overview(localId);
    expect(overview.history[0]).toMatchObject({
      sessionId: first.sessionId,
    });
    expect(overview.history[0]?.unavailableReason).toContain("damaged");
    const fresh = await sendFresh(
      serviceFor(root, content, host),
      localId,
      "fresh",
      "Start again.",
    );
    expect(fresh.runStatus).toBe("ready");
    await expect(
      sendFresh(serviceFor(root, content, host), localId, "first", "Discuss."),
    ).rejects.toThrow(/new request ID/iu);
    const reloaded = serviceFor(root, content, host);
    expect((await reloaded.overview(localId)).history).toHaveLength(2);
    expect((await reloaded.read(localId))?.sessionId).toBe(fresh.sessionId);
    expect(await readFile(path, "utf8")).toBe(damagedBytes);
    expect(sent).toHaveLength(2);
  },
);

test.each([
  ["identity", "malformed"],
  ["pending", "malformed"],
  ["owner", "malformed"],
  ["request", "malformed"],
  ["missing-proof", "malformed"],
  ["owner", "missing"],
  ["missing-proof", "null"],
  ["pending", "missing"],
] as const)(
  "Google damaged setting history with ambiguous %s and %s continuation fails closed",
  async (fault, corruption) => {
    const root = await temporaryRoot("google-setting-ambiguous-");
    const content = new ContentWorkspace(root, { locale: () => "en" });
    const { localId } = await content.createCurrentTreeContentPackage();
    const { host, sent } = googleAuthoringHost([googleText("Original.")]);
    const first = await sendFresh(
      serviceFor(root, content, host),
      localId,
      "first",
      "Discuss.",
    );
    const path = join(
      root,
      "setting-improvements",
      "sessions",
      `${first.sessionId}.json`,
    );
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      sessionId: string;
      packageId: string;
      creationRequestId: string;
      googleIdentity?: unknown;
      pendingSettlement: unknown;
      modelItems: { kind: string; providerState?: { steps: unknown } | null }[];
    };
    const assistant = stored.modelItems.find(
      ({ kind }) => kind === "assistant",
    )!;
    if (corruption === "missing") delete assistant.providerState;
    else if (corruption === "null") assistant.providerState = null;
    else assistant.providerState!.steps = [{ type: "function_call", id: 4 }];
    if (fault === "identity")
      stored.sessionId = "setting-00000000-0000-4000-8000-000000000000";
    else if (fault === "owner")
      stored.packageId = "package-00000000-0000-4000-8000-000000000000";
    else if (fault === "request")
      stored.creationRequestId = "different-valid-request";
    else if (fault === "missing-proof") delete stored.googleIdentity;
    else stored.pendingSettlement = {};
    const bytes = JSON.stringify(stored);
    await writeFile(path, bytes);
    const rejected = expect(
      sendFresh(
        serviceFor(root, content, host),
        localId,
        "fresh",
        "Start again.",
      ),
    ).rejects;
    if (fault === "owner" || fault === "request" || fault === "missing-proof")
      await rejected.toThrow(/cannot safely identify/iu);
    else await rejected.toThrow();
    expect(sent).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);

test("Google damaged history with an incomplete tool receipt batch cannot be isolated", async () => {
  const root = await temporaryRoot("google-setting-missing-receipt-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const { host, sent } = googleAuthoringHost([googleText("Original.")]);
  const first = await sendFresh(
    serviceFor(root, content, host),
    localId,
    "first",
    "Discuss.",
  );
  const path = join(
    root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    modelItems: {
      kind: string;
      providerState?: { steps: unknown };
      toolCalls?: { id: string; name: string; arguments: unknown }[];
      toolCallId?: string;
      markdown?: string;
      changes?: unknown[];
    }[];
  };
  const assistant = stored.modelItems.find(({ kind }) => kind === "assistant")!;
  assistant.providerState!.steps = [];
  assistant.toolCalls = [
    { id: "one", name: "setting_read", arguments: {} },
    { id: "two", name: "setting_read", arguments: {} },
  ];
  stored.modelItems.push({
    kind: "tool",
    toolCallId: "one",
    markdown: "First receipt",
    changes: [],
  });
  const bytes = JSON.stringify(stored);
  await writeFile(path, bytes);
  await expect(
    sendFresh(
      serviceFor(root, content, host),
      localId,
      "fresh",
      "Start again.",
    ),
  ).rejects.toThrow();
  expect(sent).toHaveLength(1);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("Google setting does not quarantine a different protocol as a missing continuation", async () => {
  const root = await temporaryRoot("google-setting-wrong-protocol-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const { host, sent } = googleAuthoringHost([
    googleText("First."),
    googleText("Second."),
  ]);
  const first = await sendFresh(
    serviceFor(root, content, host),
    localId,
    "first",
    "Discuss.",
  );
  await serviceFor(root, content, host).send({
    packageId: localId,
    requestId: "second",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  const path = join(
    root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    modelItems: { kind: string; providerState?: unknown }[];
  };
  const assistants = stored.modelItems.filter(
    ({ kind }) => kind === "assistant",
  );
  assistants[0]!.providerState = {
    protocol: "chat_completions",
    assistantMessage: { role: "assistant", content: "First." },
  };
  delete assistants[1]!.providerState;
  const bytes = JSON.stringify(stored);
  await writeFile(path, bytes);
  await expect(
    sendFresh(
      serviceFor(root, content, host),
      localId,
      "fresh",
      "Start again.",
    ),
  ).rejects.toThrow(/cannot safely identify/iu);
  expect(sent).toHaveLength(2);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("healthy older Google setting conversation without an identity proof remains continuable", async () => {
  const root = await temporaryRoot("google-setting-legacy-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const { host, sent } = googleAuthoringHost([
    googleText("First."),
    googleText("Continued."),
  ]);
  const first = await sendFresh(
    serviceFor(root, content, host),
    localId,
    "first",
    "Discuss.",
  );
  const path = join(
    root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    googleIdentity?: unknown;
  };
  delete stored.googleIdentity;
  await writeFile(path, JSON.stringify(stored));
  const resumed = await serviceFor(root, content, host).send({
    packageId: localId,
    requestId: "next",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(resumed.runStatus).toBe("ready");
  expect(resumed.messages.at(-1)?.text).toBe("Continued.");
  expect(sent).toHaveLength(2);
});

test.each(["truncated", "incomplete"])(
  "Google setting does not publish %s streamed tool arguments",
  async (ending) => {
    const root = await temporaryRoot("google-setting-partial-");
    const content = new ContentWorkspace(root, { locale: () => "en" });
    const { localId } = await content.createCurrentTreeContentPackage();
    const before = await content.readCurrentTreeContentPackage(localId);
    const events = interruptedGoogleWrite("setting_write_file", "opening.md");
    if (ending === "incomplete")
      events.push({
        event_type: "interaction.completed",
        interaction: { status: "incomplete" },
      });
    const { host } = googleAuthoringHost([events]);
    const result = await sendFresh(
      serviceFor(root, content, host),
      localId,
      "partial",
      "Edit.",
    );
    expect(result.runStatus).toBe("interrupted");
    expect(result.canRetry).toBe(true);
    expect(
      result.turns[0]?.exchanges.flatMap(({ toolCalls }) => toolCalls) ?? [],
    ).toEqual([]);
    expect(
      (await content.readCurrentTreeContentPackage(localId)).files,
    ).toEqual(before.files);
  },
);

test.each(["cancel", "disconnect"] as const)(
  "Google setting %s cannot publish streamed tool fragments",
  async (mode) => {
    const root = await temporaryRoot("google-setting-interrupt-");
    const content = new ContentWorkspace(root, { locale: () => "en" });
    const { localId } = await content.createCurrentTreeContentPackage();
    const initial = googleAuthoringHost([googleText("Ready.")]);
    const first = await sendFresh(
      serviceFor(root, content, initial.host),
      localId,
      "first",
      "Discuss.",
    );
    const before = await content.readCurrentTreeContentPackage(localId);
    const interrupted = googleInterruptedHost(
      "setting_write_file",
      "opening.md",
      mode,
    );
    const session = serviceFor(root, content, interrupted.host);
    const running = session.send({
      packageId: localId,
      requestId: "interrupted",
      message: "Edit.",
      continuation: { kind: "continue_context", sessionId: first.sessionId },
    });
    await interrupted.started;
    if (mode === "cancel") {
      const cold = googleAuthoringHost([]);
      await expect(
        serviceFor(root, content, cold.host).send({
          packageId: localId,
          requestId: "cold-retry",
          message: "Continue.",
          continuation: {
            kind: "continue_context",
            sessionId: first.sessionId,
          },
        }),
      ).rejects.toThrow(/resume|still running|fresh model context/iu);
      expect(cold.sent).toHaveLength(0);
      await session.cancel(first.sessionId);
    }
    const result = await running;
    expect(result.runStatus).toBe("interrupted");
    expect(result.canRetry).toBe(true);
    expect(
      result.turns[1]?.exchanges.flatMap(({ toolCalls }) => toolCalls) ?? [],
    ).toEqual([]);
    expect(
      (await content.readCurrentTreeContentPackage(localId)).files,
    ).toEqual(before.files);
    const afterRestart = googleAuthoringHost([]);
    await expect(
      serviceFor(root, content, afterRestart.host).send({
        packageId: localId,
        requestId: "retry",
        message: "Continue.",
        continuation: { kind: "continue_context", sessionId: first.sessionId },
      }),
    ).rejects.toThrow(/resume|still running|fresh model context/iu);
    expect(afterRestart.sent).toHaveLength(0);
    const sessionPath = join(
      root,
      "setting-improvements",
      "sessions",
      `${first.sessionId}.json`,
    );
    const legacy = JSON.parse(await readFile(sessionPath, "utf8")) as {
      googleOutcomeUnknown?: boolean;
    };
    delete legacy.googleOutcomeUnknown;
    await writeFile(sessionPath, JSON.stringify(legacy));
    const oldRestart = googleAuthoringHost([]);
    await expect(
      serviceFor(root, content, oldRestart.host).send({
        packageId: localId,
        requestId: "old-retry",
        message: "Continue.",
        continuation: { kind: "continue_context", sessionId: first.sessionId },
      }),
    ).rejects.toThrow(/resume|still running|fresh model context/iu);
    expect(oldRestart.sent).toHaveLength(0);
  },
);

test("Google setting cold restart can resume a request proven not dispatched", async () => {
  const root = await temporaryRoot("google-setting-before-dispatch-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const initial = googleAuthoringHost([googleText("Original.")]);
  const first = await sendFresh(
    serviceFor(root, content, initial.host),
    localId,
    "first",
    "Frozen message.",
  );
  const store = new FileNativeSettingImprovementStore(root);
  const saved = await store.read(first.sessionId);
  saved.modelItems = saved.modelItems.filter(
    ({ kind }) => kind !== "assistant",
  );
  saved.messages = saved.messages.filter(({ role }) => role !== "assistant");
  saved.runStatus = "running";
  saved.activeRequestId = "first";
  saved.completedRequestIds = [];
  saved.googleOutcomeUnknown = false;
  await store.save(saved);
  const restarted = googleAuthoringHost([googleText("Resumed.")]);
  const service = serviceFor(root, content, restarted.host);
  const resumed = await service.resume({
    packageId: localId,
    sessionId: first.sessionId,
    requestId: "resume",
  });
  expect(resumed.runStatus).toBe("ready");
  expect(resumed.messages.map(({ role }) => role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(
    JSON.stringify(restarted.sent[0]).match(/Frozen message\./gu),
  ).toHaveLength(1);
  const snapshot = (await store.read(first.sessionId)).requests![0]!;
  expect(snapshot.wireRequest?.googleHops?.length).toBeGreaterThanOrEqual(1);
  expect(
    snapshot.retryAttempts?.[0]?.wireRequest?.googleHops?.length,
  ).toBeGreaterThanOrEqual(1);
});

test("重整前真实 schema-v2 作者会话保留原生工具历史，下一次发送保存当前编排", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("./fixtures/pre38-author.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  ) as {
    packageId: string;
    sessionId: string;
    files: Record<string, string>;
    stored: Awaited<ReturnType<FileNativeSettingImprovementStore["read"]>>;
  };
  const root = await temporaryRoot("pre38-author-upgrade-");
  for (const [path, contents] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const store = new FileNativeSettingImprovementStore(root);
  expect(await store.read(fixture.sessionId)).toEqual(fixture.stored);
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const before = await content.readCurrentTreeContentPackage(fixture.packageId);
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Continued after upgrade." }],
  });
  const session = serviceFor(root, content, host);
  const candidate = await session.preview(fixture.packageId, fixture.sessionId);
  expect(host.requests).toHaveLength(0);
  await session.send({
    packageId: fixture.packageId,
    requestId: "upgrade-next",
    message: "Continue discussing.",
    continuation: { kind: "continue_context", sessionId: fixture.sessionId },
  });
  expect(
    host.requests[0]!.appended.slice(0, fixture.stored.modelItems.length),
  ).toEqual(fixture.stored.modelItems);
  expect(host.requests[0]!.bootstrap).toEqual(candidate);
  const upgraded = await store.read(fixture.sessionId);
  expect(upgraded.schemaVersion).toBe(6);
  expect(upgraded.bootstrap).toEqual(fixture.stored.bootstrap);
  expect(upgraded.messages.slice(0, fixture.stored.messages.length)).toEqual(
    fixture.stored.messages,
  );
  expect(
    (await content.readCurrentTreeContentPackage(fixture.packageId)).files,
  ).toEqual(before.files);
  expect(upgraded.requests).toHaveLength(1);
});

test("a real schema 2 authoring conversation supports editing and preserves its original source", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("./fixtures/pre38-author.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  ) as {
    packageId: string;
    sessionId: string;
    files: Record<string, string>;
    stored: Awaited<ReturnType<FileNativeSettingImprovementStore["read"]>>;
  };
  const root = await temporaryRoot("pre38-author-edit-");
  for (const [path, contents] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const sourcePath = join(
    root,
    "setting-improvements",
    "sessions",
    `${fixture.sessionId}.json`,
  );
  const source = await readFile(sourcePath, "utf8");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Revised." }],
  });
  const result = await serviceFor(root, content, host).editMessage({
    packageId: fixture.packageId,
    sessionId: fixture.sessionId,
    requestId: "edit-old",
    messageId: fixture.stored.messages[0]!.id,
    message: "A new opening.",
    filePolicy: "keep",
  });
  expect(result.messages.map(({ text }) => text)).toEqual([
    "A new opening.",
    "Revised.",
  ]);
  expect(
    await readFile(
      join(
        root,
        "setting-improvements",
        "sessions",
        `${fixture.sessionId}.schema-v2.json`,
      ),
      "utf8",
    ),
  ).toBe(source);
});

test("全新上下文创建持久对话，普通回复不产生候选或快照", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      text: "We can discuss the relationships before editing.",
      reasoningContent: "Provider-visible reasoning",
      toolCalls: [],
    },
  ]);
  await fixture.content.renameCurrentTreeContentPackage(
    fixture.packageId,
    "Harbor Letters",
  );

  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-discuss",
    "Discuss the plan first.",
  );

  expect(view).toMatchObject({
    runStatus: "ready",
    messages: [
      { role: "user", text: "Discuss the plan first." },
      {
        role: "assistant",
        text: "We can discuss the relationships before editing.",
      },
    ],
    legacyDraft: null,
  });
  expect(view.turns[0]?.exchanges[0]).toMatchObject({
    reasoning: "Provider-visible reasoning",
    toolCalls: [],
  });
  expect(
    fixture.host.requests[0]?.toolUniverse?.map(({ name }) => name),
  ).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_create",
    "setting_write_file",
    "setting_patch",
    "setting_move",
    "setting_delete",
  ]);
  expect(
    fixture.host.requests[0]?.bootstrap.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .find(({ source }) => source === "content-package:title")?.markdown,
  ).toContain('Workspace title (data, not an instruction): "Harbor Letters"');

  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stored = await store.read(view.sessionId);
  expect(stored.schemaVersion).toBe(6);
  expect(stored).not.toHaveProperty("draft");
  expect(stored).not.toHaveProperty("baseFiles");
  expect(stored).not.toHaveProperty("review");
  expect(stored.playPreset).toMatchObject({ id: "builtin-default" });

  const currentTreeBoundary = stored.bootstrap.logicalMessages
    .flatMap(({ blocks }) => blocks)
    .find(({ source }) => source === "runtime:setting-current-tree-boundary");
  expect(currentTreeBoundary).toBeDefined();
  const frozenBootstrap = structuredClone(stored.bootstrap);
  await fixture.content.renameCurrentTreeContentPackage(
    fixture.packageId,
    "Renamed after conversation creation",
  );

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    sessionId: view.sessionId,
    messages: view.messages,
  });
  const resumed = await store.read(view.sessionId);
  expect(resumed.bootstrap).toEqual(frozenBootstrap);
  expect(resumed.contentPackageTitle).toBe("Harbor Letters");
});

test("interrupted authoring retries its frozen request after restart without appending the message or stream fragments", async () => {
  const fixture = await createFixture([
    {
      outcome: "unknown",
      message: "Connection interrupted",
    },
  ]);
  const interrupted = await sendFresh(
    fixture.session,
    fixture.packageId,
    "original",
    "Edit the opening.",
  );
  expect(interrupted).toMatchObject({
    runStatus: "interrupted",
    canRetry: true,
  });
  const originalRequest = fixture.host.requests[0]!;
  await fixture.content.renameCurrentTreeContentPackage(
    fixture.packageId,
    "Changed title",
  );
  const retryHost = new ScriptedModelHost({
    binding: {
      ...binding,
      modelId: "new-model",
      endpointFingerprint: "new-endpoint",
    },
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const changedPreset = builtinDefaultPlayPresetBinding("en");
  changedPreset.definition.files["blocks/changed.md"] = "Changed preset";
  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    retryHost,
    changedPreset,
  );
  const resumed = await restarted.resume({
    packageId: fixture.packageId,
    sessionId: interrupted.sessionId,
    requestId: "retry",
  });
  expect(resumed).toMatchObject({ runStatus: "ready", canRetry: false });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Edit the opening.",
    "Finished.",
  ]);
  expect(retryHost.requests[0]).toEqual({
    ...originalRequest,
    requestAttempt: 2,
  });
  expect(JSON.stringify(retryHost.requests[0])).not.toContain(
    "Unfinished fragment",
  );
});

test("retry retains the original request identity through a subsequent tool exchange", async () => {
  const fixture = await createFixture([
    { outcome: "unknown", message: "Disconnected" },
  ]);
  const interrupted = await sendFresh(
    fixture.session,
    fixture.packageId,
    "original",
    "Inspect the opening.",
  );
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
        ],
      },
      { outcome: "response", text: "Finished." },
    ],
  });
  const result = await serviceFor(fixture.root, fixture.content, host).resume({
    packageId: fixture.packageId,
    sessionId: interrupted.sessionId,
    requestId: "retry-action",
  });
  expect(result.runStatus).toBe("ready");
  expect(host.requests.map((request) => request.requestId)).toEqual([
    "original",
    "original",
  ]);
  expect(host.requests[1]?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "read",
  });
  expect(result.requestPreviews?.map(({ requestId }) => requestId)).toEqual([
    "original",
    "retry-action",
  ]);
});

test("migration preserves the exact source bytes in a synthetic schema 3 transition", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
    { outcome: "response", text: "Second." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Discuss.",
  );
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const old = JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion: number;
    requests: { modelBinding?: unknown; retryAttempts?: unknown }[];
  };
  old.schemaVersion = 3;
  for (const request of old.requests) {
    delete request.modelBinding;
    delete request.retryAttempts;
  }
  const source = JSON.stringify(old);
  await writeFile(path, source);
  const result = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "second",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(result.runStatus).toBe("ready");
  expect(
    (
      await new FileNativeSettingImprovementStore(fixture.root).read(
        first.sessionId,
      )
    ).schemaVersion,
  ).toBe(6);
  expect(
    await readFile(
      join(
        fixture.root,
        "setting-improvements",
        "sessions",
        `${first.sessionId}.schema-v3.json`,
      ),
      "utf8",
    ),
  ).toBe(source);
});

test("historical schema 3 fixture upgrades without altering its original bytes", async () => {
  // Captured by the real session service at commit 4f1c8c9, before schema 4 existed.
  const source = gunzipSync(
    await readFile(
      new URL("./fixtures/author-schema3-4f1c8c9.json.gz", import.meta.url),
    ),
  ).toString("utf8");
  const old = JSON.parse(source) as {
    sessionId: string;
    schemaVersion: number;
  };
  expect(old.schemaVersion).toBe(3);
  const root = await temporaryRoot("schema3-historical-");
  const sessions = join(root, "setting-improvements", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, `${old.sessionId}.json`), source);
  const store = new FileNativeSettingImprovementStore(root);
  const original = await store.read(old.sessionId);
  await store.save({ ...original, schemaVersion: 4 });
  const preserved = join(sessions, `${old.sessionId}.schema-v3.json`);
  expect(await readFile(preserved, "utf8")).toBe(source);
  const migrated = await store.read(old.sessionId);
  expect(migrated).toEqual({ ...original, schemaVersion: 4 });
  await store.save(migrated);
  expect(await readFile(preserved, "utf8")).toBe(source);
});

test("cold recovery does not offer retry when native continuation is damaged", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
    { outcome: "unknown", message: "Disconnected" },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first",
    "Discuss.",
  );
  const failed = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "second",
    message: "Continue.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(failed.canRetry).toBe(true);
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    modelItems: { kind: string; providerState?: unknown }[];
  };
  const assistant = stored.modelItems.find(
    (item) => item.kind === "assistant",
  )!;
  assistant.providerState = {
    protocol: "chat_completions",
    assistantMessage: { role: "user" },
  };
  await writeFile(path, JSON.stringify(stored));
  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  expect(
    (await restarted.readSession(fixture.packageId, first.sessionId)).canRetry,
  ).toBe(false);
  await expect(
    restarted.resume({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "retry",
    }),
  ).rejects.toThrow();
});

test.each([
  [
    "native continuation",
    new ModelHostContinuationError("damaged continuation"),
  ],
  ["model binding", new ModelHostBindingMismatchError("binding changed")],
  ["context limit", new ModelHostFailureError("maximum context length")],
  [
    "output limit",
    new ModelHostFailureError("output limit", {
      details: { code: "model_output_limit" },
    }),
  ],
])("does not offer retry for %s failures", async (_label, error) => {
  const fixture = await createFixture([]);
  const host: ModelHost = {
    binding: () => binding,
    exchange: () => Promise.reject(error),
  };
  const session = serviceFor(fixture.root, fixture.content, host);
  const result = await sendFresh(
    session,
    fixture.packageId,
    "blocked",
    "Inspect.",
  );
  expect(result).toMatchObject({ runStatus: "interrupted", canRetry: false });
  expect(
    (
      await serviceFor(fixture.root, fixture.content, host).readSession(
        fixture.packageId,
        result.sessionId,
      )
    ).canRetry,
  ).toBe(false);
});

test("streamed fragments are not promoted to retry context", async () => {
  const fixture = await createFixture([]);
  const host: ModelHost = {
    binding: () => binding,
    exchange: (_request, observer) => {
      observer?.onDelta?.({ kind: "text", text: "Unfinished fragment" });
      return Promise.reject(
        new ModelHostOutcomeUnknownError("Stream interrupted"),
      );
    },
  };
  const failed = await sendFresh(
    serviceFor(fixture.root, fixture.content, host),
    fixture.packageId,
    "stream",
    "Inspect.",
  );
  const retryHost = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const resumed = await serviceFor(
    fixture.root,
    fixture.content,
    retryHost,
  ).resume({
    packageId: fixture.packageId,
    sessionId: failed.sessionId,
    requestId: "retry",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Inspect.",
    "Finished.",
  ]);
  expect(JSON.stringify(retryHost.requests)).not.toContain(
    "Unfinished fragment",
  );
});

test("an empty response can be resent without another user message", async () => {
  const fixture = await createFixture([{ outcome: "response", text: "" }]);
  const failed = await sendFresh(
    fixture.session,
    fixture.packageId,
    "empty",
    "Inspect.",
  );
  expect(failed).toMatchObject({ runStatus: "interrupted", canRetry: true });
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const resumed = await serviceFor(fixture.root, fixture.content, host).resume({
    packageId: fixture.packageId,
    sessionId: failed.sessionId,
    requestId: "retry-empty",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Inspect.",
    "Finished.",
  ]);
});

test("cancelled request ignores a late complete response and can be resent", async () => {
  const fixture = await createFixture([]);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scripted = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Late response." }],
  });
  const host: ModelHost = {
    binding: () => binding,
    exchange: async (request, observer) => {
      started.resolve();
      await release.promise;
      return scripted.exchange(request, observer);
    },
  };
  const service = serviceFor(fixture.root, fixture.content, host);
  const running = sendFresh(service, fixture.packageId, "cancel", "Inspect.");
  await started.promise;
  const current = await service.read(fixture.packageId);
  const cancelling = service.cancel(current!.sessionId);
  release.resolve();
  const result = await running;
  await cancelling;
  expect(result).toMatchObject({ runStatus: "interrupted", canRetry: true });
  const retryHost = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const resumed = await serviceFor(
    fixture.root,
    fixture.content,
    retryHost,
  ).resume({
    packageId: fixture.packageId,
    sessionId: result.sessionId,
    requestId: "retry-cancel",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Inspect.",
    "Finished.",
  ]);
  expect(JSON.stringify(retryHost.requests)).not.toContain("Late response.");
});

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)(
  "%s production stream retries the same frozen request",
  async (provider) => {
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const named = (name: string, value: unknown) =>
      `event: ${name}\n${data(value)}`;
    const chat = (text: string) =>
      data({ id: "c1", choices: [{ index: 0, delta: { content: text } }] });
    const response = (text: string) =>
      named("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: text,
      });
    const anthropicStart =
      named("message_start", {
        type: "message_start",
        message: {
          id: "m1",
          role: "assistant",
          model: "test",
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      named("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    const anthropic = (text: string) =>
      named("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    const partial =
      provider === "chat_completions"
        ? chat("unfinished fragment")
        : provider === "openai_responses"
          ? response("unfinished fragment")
          : anthropicStart + anthropic("unfinished fragment");
    const complete =
      provider === "chat_completions"
        ? chat("Finished.") +
          data({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "data: [DONE]\n\n"
        : provider === "openai_responses"
          ? response("Finished.") +
            named("response.completed", {
              type: "response.completed",
              response: {
                id: "r1",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: "m1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Finished." }],
                  },
                ],
              },
            })
          : anthropicStart +
            anthropic("Finished.") +
            named("content_block_stop", {
              type: "content_block_stop",
              index: 0,
            }) +
            named("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            }) +
            named("message_stop", { type: "message_stop" });
    const bodies: string[] = [];
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "test",
        contextWindowTokens: 64000,
        maxOutputTokens: 2000,
      },
      (_url, options) => {
        if (typeof options?.body !== "string")
          throw new Error("Missing request body");
        bodies.push(options.body);
        return Promise.resolve(
          new Response(bodies.length === 1 ? partial : complete, {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    );
    const root = await temporaryRoot("setting-production-stream-");
    const content = new ContentWorkspace(root, { locale: () => "en" });
    const { localId } = await content.createCurrentTreeContentPackage();
    const failed = await sendFresh(
      serviceFor(root, content, host),
      localId,
      "original",
      "Inspect.",
    );
    expect(failed).toMatchObject({ runStatus: "interrupted", canRetry: true });
    const resumed = await serviceFor(root, content, host).resume({
      packageId: localId,
      sessionId: failed.sessionId,
      requestId: "retry",
    });
    expect(resumed.messages.map(({ text }) => text)).toEqual([
      "Inspect.",
      "Finished.",
    ]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[1]).not.toContain("unfinished fragment");
  },
);

test("模型调用达到单条消息上限时暂停，继续时不追加用户消息并沿用冻结请求", async () => {
  const fixture = await createFixture([
    ...Array.from({ length: 64 }, (_, index) => ({
      outcome: "response" as const,
      toolCalls: [
        {
          id: `read-opening-${index}`,
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
      ],
    })),
    { outcome: "response", text: "Finished after continuing.", toolCalls: [] },
  ]);

  const paused = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-long",
    "Inspect the opening repeatedly.",
  );

  expect(paused).toMatchObject({ runStatus: "paused", lastFailure: null });
  expect(fixture.host.requests).toHaveLength(64);

  const resume = () =>
    fixture.session.resume({
      packageId: fixture.packageId,
      sessionId: paused.sessionId,
      requestId: "resume-long",
    });
  const resumed = await resume();

  expect(resumed).toMatchObject({ runStatus: "ready", lastFailure: null });
  expect(fixture.host.requests).toHaveLength(65);
  const continued = fixture.host.requests.at(-1)!;
  expect(continued.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "read-opening-63",
  });
  expect(continued.bootstrap).toEqual(fixture.host.requests[0]!.bootstrap);
  expect(resumed.messages.map(({ role }) => role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(resumed.turns).toHaveLength(1);
  expect(resumed.turns[0]?.exchanges).toHaveLength(65);

  await expect(resume()).resolves.toMatchObject({ runStatus: "ready" });
  expect(fixture.host.requests).toHaveLength(65);
  await expect(
    fixture.session.resume({
      packageId: fixture.packageId,
      sessionId: paused.sessionId,
      requestId: "resume-ready",
    }),
  ).rejects.toThrow("Only a paused authoring conversation can be continued");
});

test("synthetic schema 2 paused state continues without inventing a retry checkpoint", async () => {
  const fixture = await createFixture([
    ...Array.from({ length: 64 }, (_, index) => ({
      outcome: "response" as const,
      toolCalls: [
        {
          id: `read-${index}`,
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
      ],
    })),
    { outcome: "response", text: "Continued." },
  ]);
  const paused = await sendFresh(
    fixture.session,
    fixture.packageId,
    "legacy-paused",
    "Inspect.",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const old = await store.read(paused.sessionId);
  old.schemaVersion = 2;
  delete old.requests;
  await store.save(old);
  const resumed = await serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
  ).resume({
    packageId: fixture.packageId,
    sessionId: paused.sessionId,
    requestId: "continue-legacy",
  });
  expect(resumed).toMatchObject({ runStatus: "ready", canRetry: false });
  expect((await store.read(paused.sessionId)).schemaVersion).toBe(2);
});

test("完整工具响应直接原子发布当前树，并把推理、调用、结果和逐调用 diff 留在历史", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      reasoningContent: "Need the exact opening before replacing it.",
      toolCalls: [
        {
          id: "read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "write-opening",
          name: "setting_write_file",
          arguments: {
            path: "opening.md",
            contents: "Rain needles the midnight harbor.\n",
          },
        },
      ],
    },
    {
      outcome: "response",
      text: "The rainy harbor opening is already live.",
      toolCalls: [],
    },
  ]);

  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-write",
    "Move the opening to a rainy harbor.",
  );
  const package_ = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );

  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Rain needles the midnight harbor.\n");
  expect(view.turns[0]?.exchanges[0]).toMatchObject({
    reasoning: "Need the exact opening before replacing it.",
    toolCalls: [
      { callId: "read-opening", result: { isError: false, changes: [] } },
      {
        callId: "write-opening",
        result: {
          isError: false,
          changes: [
            {
              path: "opening.md",
              kind: "modify",
              after: "Rain needles the midnight harbor.\n",
            },
          ],
        },
      },
    ],
  });
  expect(view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.markdown).toContain(
    "Current-tree review passed",
  );
  expect(view.messages.at(-1)?.text).toContain("already live");
});

test("历史 AI 修改可按文件回滚到精确前像，重试保持幂等且对话历史不变", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "rollback-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "rollback-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "AI changed opening.\n" },
        },
      ],
    },
    { outcome: "response", text: "The edit is live.", toolCalls: [] },
  ]);
  const before = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const beforeOpening = before.files.find(
    ({ path }) => path === "opening.md",
  )!.contents;
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-rollback",
    "Change the opening",
  );
  const changeSetId =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changeSetId;
  expect(changeSetId).toMatch(/^change-set:[0-9]+$/u);
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted write did not expose a rollback identity");

  const rolledBack = await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId,
    path: "opening.md",
  });
  expect(rolledBack).toEqual({
    status: "rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [
      {
        path: "opening.md",
        kind: "modify",
        before: "AI changed opening.\n",
        after: beforeOpening,
      },
    ],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(beforeOpening);
  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: view.sessionId,
      changeSetId,
      path: "opening.md",
    }),
  ).resolves.toEqual({
    status: "already_rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [],
  });
  await expect(
    fixture.session.readSession(fixture.packageId, view.sessionId),
  ).resolves.toMatchObject({ turns: view.turns });
});

test("所选文件后来被修改时仍直接覆盖为历史前像", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "conflict-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "conflict-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "AI edit.\n" },
        },
      ],
    },
    { outcome: "response", text: "Done.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-conflicting-rollback",
    "Change the opening",
  );
  const changeSetId =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changeSetId;
  const beforeOpening =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changes[0]?.before;
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted write did not expose a rollback identity");
  if (beforeOpening === null || beforeOpening === undefined)
    throw new Error("The accepted write did not retain its previous file");
  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    current.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Later manual edit.\n" }
        : file,
    ),
    {
      baseTreeRevision: (
        await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
      ).treeRevision,
    },
  );

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: view.sessionId,
      changeSetId,
      path: "opening.md",
    }),
  ).resolves.toEqual({
    status: "rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [
      {
        path: "opening.md",
        kind: "modify",
        before: "Later manual edit.\n",
        after: beforeOpening,
      },
    ],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(beforeOpening);
});

test("move 的两个文件变化可以分别选择回滚", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-rollback-note",
          name: "setting_create",
          arguments: {
            path: "world/notes/rollback.yaml",
            ref: "rollback-note",
            title: "Rollback note",
            summary: "A note used to verify atomic move rollback.",
            aliases: [],
            body: "status: active\n",
          },
        },
        {
          id: "move-rollback-note",
          name: "setting_move",
          arguments: {
            from: "@rollback-note",
            to: "world/archive/rollback.yaml",
          },
        },
      ],
    },
    { outcome: "response", text: "Moved.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-move-rollback",
    "Create and move a note",
  );
  const move = view.turns[0]?.exchanges[0]?.toolCalls[1]?.result;
  expect(move?.changes).toHaveLength(2);
  if (move?.changeSetId === null || move?.changeSetId === undefined)
    throw new Error("The accepted move did not expose a rollback identity");

  await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId: move.changeSetId,
    path: "world/notes/rollback.yaml",
  });
  const afterSourceRollback = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files.map(({ path }) => path);
  expect(afterSourceRollback).toContain("world/notes/rollback.yaml");
  expect(afterSourceRollback).toContain("world/archive/rollback.yaml");

  await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId: move.changeSetId,
    path: "world/archive/rollback.yaml",
  });
  const afterDestinationRollback = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files.map(({ path }) => path);
  expect(afterDestinationRollback).toContain("world/notes/rollback.yaml");
  expect(afterDestinationRollback).not.toContain("world/archive/rollback.yaml");
});

test("回滚所选删除文件会直接恢复历史前像", async () => {
  const path = "world/notes/deleted-rollback.yaml";
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-delete-rollback-note",
          name: "setting_create",
          arguments: {
            path,
            ref: "deleted-rollback",
            title: "Deleted rollback note",
            summary: "A note used to verify delete rollback.",
            aliases: [],
            body: "status: active\n",
          },
        },
      ],
    },
    { outcome: "response", text: "Created.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "delete-rollback-note",
          name: "setting_delete",
          arguments: { document: "@deleted-rollback" },
        },
      ],
    },
    { outcome: "response", text: "Deleted.", toolCalls: [] },
  ]);
  const created = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-create-delete-rollback",
    "Create a temporary note",
  );
  const deleted = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-delete-rollback",
    message: "Delete the temporary note",
    continuation: {
      kind: "continue_context",
      sessionId: created.sessionId,
    },
  });
  const deletion = deleted.turns[1]?.exchanges[0]?.toolCalls[0]?.result;
  const before = deletion?.changes[0]?.before;
  if (deletion?.changeSetId === null || deletion?.changeSetId === undefined)
    throw new Error("The accepted delete did not expose a rollback identity");
  if (before === null || before === undefined)
    throw new Error("The accepted delete did not retain its previous file");

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: deleted.sessionId,
      changeSetId: deletion.changeSetId,
      path,
    }),
  ).resolves.toEqual({
    status: "rolled_back",
    changeSetId: deletion.changeSetId,
    path,
    changes: [{ path, kind: "create", before: null, after: before }],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find((file) => file.path === path)?.contents,
  ).toBe(before);
});

test("所选创建文件即使已有后来引用也直接回滚", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-referenced-rollback-note",
          name: "setting_create",
          arguments: {
            path: "world/notes/referenced-rollback.yaml",
            ref: "referenced-rollback",
            title: "Referenced rollback note",
            summary: "A note that receives a later reference.",
            aliases: [],
            body: "status: active\n",
          },
        },
      ],
    },
    { outcome: "response", text: "Created.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read-situation-before-reference",
          name: "setting_read",
          arguments: { path: "@current-situation" },
        },
        {
          id: "add-later-reference",
          name: "setting_patch",
          arguments: {
            document: "@current-situation",
            op: "add",
            locator: ["rollbackReference"],
            value: { $ref: "@referenced-rollback" },
          },
        },
      ],
    },
    { outcome: "response", text: "Referenced.", toolCalls: [] },
  ]);
  const created = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-create-referenced-rollback",
    "Create the note",
  );
  const changeSetId =
    created.turns[0]?.exchanges[0]?.toolCalls[0]?.result?.changeSetId;
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted create did not expose a rollback identity");
  await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-add-later-reference",
    message: "Reference the note",
    continuation: {
      kind: "continue_context",
      sessionId: created.sessionId,
    },
  });

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: created.sessionId,
      changeSetId,
      path: "world/notes/referenced-rollback.yaml",
    }),
  ).resolves.toMatchObject({
    status: "rolled_back",
    path: "world/notes/referenced-rollback.yaml",
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.some(({ path }) => path === "world/notes/referenced-rollback.yaml"),
  ).toBe(false);
});

test("默认可继续精确历史上下文，显式全新上下文创建第二段对话", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First answer.", toolCalls: [] },
    { outcome: "response", text: "Fresh answer.", toolCalls: [] },
    { outcome: "response", text: "Continued first answer.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-first",
    "First context",
  );
  const fresh = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-fresh",
    "Fresh context",
  );
  expect(fresh.sessionId).not.toBe(first.sessionId);

  const resumed = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-resume-first",
    message: "Continue the first context",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "First context",
    "First answer.",
    "Continue the first context",
    "Continued first answer.",
  ]);
  expect(fixture.host.requests[2]?.appended).toEqual(
    expect.arrayContaining([
      { kind: "user", text: "First context" },
      expect.objectContaining({ kind: "assistant", text: "First answer." }),
      { kind: "user", text: "Continue the first context" },
    ]),
  );

  const overview = await fixture.session.overview(fixture.packageId);
  expect(overview.latest?.sessionId).toBe(first.sessionId);
  expect(overview.history.map(({ sessionId }) => sessionId)).toEqual([
    first.sessionId,
    fresh.sessionId,
  ]);
  await expect(
    fixture.session.readSession(fixture.packageId, fresh.sessionId),
  ).resolves.toMatchObject({ sessionId: fresh.sessionId });
});

test("另一个对话改动当前树后，旧对话的读取授权失效并要求重新读取", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "a-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
      ],
    },
    { outcome: "response", text: "I read it.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "b-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "b-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Changed by B.\n" },
        },
      ],
    },
    { outcome: "response", text: "B changed it.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "a-stale-write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Stale A write.\n" },
        },
      ],
    },
    { outcome: "response", text: "I need to reread it.", toolCalls: [] },
  ]);
  const conversationA = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-a-read",
    "Read the opening",
  );
  await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-b-write",
    "Change the opening",
  );
  const resumedA = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-a-stale-write",
    message: "Now replace it without reading again",
    continuation: {
      kind: "continue_context",
      sessionId: conversationA.sessionId,
    },
  });

  expect(
    resumedA.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result,
  ).toMatchObject({ isError: true, changes: [] });
  expect(
    resumedA.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result?.markdown,
  ).toContain("Read opening.md completely before replacing it");
  const package_ = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Changed by B.\n");
});

test("全新上下文的 requestId 可幂等重试且不会创建重复历史", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Only once.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-idempotent",
    "Only once",
  );
  const retry = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-idempotent",
    "Only once",
  );
  expect(retry.sessionId).toBe(first.sessionId);
  expect(fixture.host.requests).toHaveLength(1);
  expect(
    (await fixture.session.overview(fixture.packageId)).history,
  ).toHaveLength(1);
});

test("完整工具响应若缺少原树结算意图，恢复会失败关闭而不在更新的树上重放", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Seed response.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-unconfirmed-seed",
    "Seed a conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const damaged = await store.read(view.sessionId);
  const seedAssistant = damaged.modelItems.find(
    (item) => item.kind === "assistant",
  );
  if (
    seedAssistant?.kind !== "assistant" ||
    seedAssistant.providerState === undefined
  )
    throw new Error("Seed response did not retain Provider continuation state");
  const now = Date.now();
  damaged.messages.push({
    id: "message-unconfirmed-tool-step",
    role: "user",
    text: "Replace the opening",
    createdAt: now,
  });
  damaged.modelItems.push(
    { kind: "user", text: "Replace the opening" },
    {
      kind: "assistant",
      text: "",
      providerState: seedAssistant.providerState,
      toolCalls: [
        {
          id: "unconfirmed-write",
          name: "setting_write_file",
          arguments: {
            path: "opening.md",
            contents: "Must never be replayed.\n",
          },
        },
      ],
    },
  );
  damaged.runStatus = "running";
  damaged.activeRequestId = "request-unconfirmed-write";
  damaged.pendingSettlement = null;
  damaged.updatedAt = now;
  damaged.schemaVersion = 2;
  delete damaged.requests; // Released sessions have no per-send snapshots.
  await store.save(damaged);

  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    current.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Newer current-tree edit.\n" }
        : file,
    ),
    {
      baseTreeRevision: (
        await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
      ).treeRevision,
    },
  );

  const recovered = await serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  ).readSession(fixture.packageId, view.sessionId);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Newer current-tree edit.\n");
  expect(recovered.turns.at(-1)?.exchanges[0]?.toolCalls[0]).toMatchObject({
    callId: "unconfirmed-write",
    result: {
      isError: true,
      changes: [],
    },
  });
  expect(
    recovered.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result?.markdown,
  ).toContain("without the persisted current-tree revision");
  expect((await store.read(view.sessionId)).pendingSettlement).toBeNull();
});

test("完整工具响应和原树指纹落盘后，重启只在该 revision 上继续结算", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Seed response.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-confirmed-seed",
    "Seed a conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const confirmed = await store.read(view.sessionId);
  const seedAssistant = confirmed.modelItems.find(
    (item) => item.kind === "assistant",
  );
  if (
    seedAssistant?.kind !== "assistant" ||
    seedAssistant.providerState === undefined
  )
    throw new Error("Seed response did not retain Provider continuation state");
  const files = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const now = Date.now();
  confirmed.messages.push({
    id: "message-confirmed-tool-step",
    role: "user",
    text: "Replace the opening",
    createdAt: now,
  });
  confirmed.modelItems.push({ kind: "user", text: "Replace the opening" });
  const assistantItemIndex = confirmed.modelItems.length;
  confirmed.modelItems.push({
    kind: "assistant",
    text: "",
    providerState: seedAssistant.providerState,
    toolCalls: [
      {
        id: "confirmed-read",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "confirmed-write",
        name: "setting_write_file",
        arguments: {
          path: "opening.md",
          contents: "Recovered from confirmed response.\n",
        },
      },
    ],
  });
  confirmed.runStatus = "running";
  confirmed.activeRequestId = "request-confirmed-tool-step";
  confirmed.pendingSettlement = {
    phase: "response_confirmed",
    assistantItemIndex,
    beforeFingerprint: contentTreeFingerprint(files),
  };
  confirmed.updatedAt = now;
  confirmed.requests!.push({
    ...structuredClone(confirmed.requests![0]!),
    requestId: confirmed.activeRequestId,
    modelItemStart: assistantItemIndex - 1,
  });
  await store.save(confirmed);

  const recovered = await serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  ).readSession(fixture.packageId, view.sessionId);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Recovered from confirmed response.\n");
  expect(recovered.turns.at(-1)?.exchanges[0]?.toolCalls[1]).toMatchObject({
    callId: "confirmed-write",
    result: {
      isError: false,
      changes: [
        { path: "opening.md", after: "Recovered from confirmed response.\n" },
      ],
    },
  });
  expect((await store.read(view.sessionId)).pendingSettlement).toBeNull();
});

test("tool settlement waits for an overlapping package operation and persists its receipt", async () => {
  const fixture = await createFixture([]);
  const started = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const settlementAttempted = Promise.withResolvers<void>();
  const script = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Settled change.\n" },
          },
        ],
      },
      { outcome: "response", text: "Done." },
    ],
  });
  let first = true;
  const host: ModelHost = {
    binding: () => binding,
    exchange: async (request, observer) => {
      if (first) {
        first = false;
        started.resolve();
        await respond.promise;
      }
      return script.exchange(request, observer);
    },
  };
  const session = serviceFor(fixture.root, fixture.content, host);
  const sending = sendFresh(session, fixture.packageId, "lease-race", "Edit.");
  await started.promise;
  const lease = await fixture.content.beginCurrentTreeContentPackageOperation(
    fixture.packageId,
  );
  const begin = fixture.content.beginCurrentTreeContentPackageOperation.bind(
    fixture.content,
  );
  vi.spyOn(
    fixture.content,
    "beginCurrentTreeContentPackageOperation",
  ).mockImplementation((...args) => {
    settlementAttempted.resolve();
    return begin(...args);
  });
  try {
    respond.resolve();
    await settlementAttempted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await lease.replace(
      lease.package.files.map((file) =>
        file.path === "opening.md"
          ? { ...file, contents: "Latest tree.\n" }
          : file,
      ),
    );
  } finally {
    lease.release();
  }
  const result = await sending;
  expect(result.runStatus).toBe("ready");
  expect(result.messages.at(-1)?.text).toBe("Done.");
  expect(result.turns[0]?.exchanges[0]?.toolCalls[1]).toMatchObject({
    callId: "write",
    result: {
      isError: false,
      changes: [{ path: "opening.md", before: "Latest tree.\n" }],
    },
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Settled change.\n");
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    result.sessionId,
  );
  expect(stored.pendingSettlement).toBeNull();
  expect(stored.modelItems).toContainEqual(
    expect.objectContaining({ kind: "tool", toolCallId: "write" }),
  );
});

test("发布前中断留下结算意图；重启只重放完整工具响应并补齐收据", async () => {
  const root = await temporaryRoot("narraeon-setting-recovery-");
  let failPublish = true;
  const interruptedContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        if (!failPublish) return;
        failPublish = false;
        throw new Error("simulated crash before current-tree publish");
      },
    },
  });
  const created = await interruptedContent.createCurrentTreeContentPackage();
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-before-crash",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write-before-crash",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Recovered change.\n" },
          },
        ],
      },
    ],
  });
  const interrupted = serviceFor(root, interruptedContent, host);
  const failed = await sendFresh(
    interrupted,
    created.localId,
    "request-crash",
    "Change the opening",
  );
  expect(failed.runStatus).toBe("interrupted");
  const pending = await new FileNativeSettingImprovementStore(root).read(
    failed.sessionId,
  );
  expect(pending.pendingSettlement).not.toBeNull();

  const recoveredContent = new ContentWorkspace(root, { locale: () => "en" });
  const restarted = serviceFor(
    root,
    recoveredContent,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  const recovered = await restarted.readSession(
    created.localId,
    failed.sessionId,
  );
  expect(recovered.runStatus).toBe("interrupted");
  const recoveredCalls = recovered.turns[0]?.exchanges[0]?.toolCalls;
  expect(recoveredCalls?.[0]).toMatchObject({
    callId: "read-before-crash",
    result: { isError: false },
  });
  expect(recoveredCalls?.[1]).toMatchObject({
    callId: "write-before-crash",
    result: {
      isError: false,
      changes: [{ path: "opening.md" }],
    },
  });
  const package_ = await recoveredContent.readCurrentTreeContentPackage(
    created.localId,
  );
  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Recovered change.\n");
  expect(
    (await new FileNativeSettingImprovementStore(root).read(failed.sessionId))
      .pendingSettlement,
  ).toBeNull();
});

test("当前树已发布但收据未落盘时，重启确认既有结算而不重复发布", async () => {
  const root = await temporaryRoot("narraeon-setting-after-publish-");
  let interruptPublish = true;
  const interruptedContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        if (!interruptPublish) return;
        interruptPublish = false;
        throw new Error("simulated crash after settlement intent");
      },
    },
  });
  const created = await interruptedContent.createCurrentTreeContentPackage();
  const interrupted = serviceFor(
    root,
    interruptedContent,
    new ScriptedModelHost({
      binding,
      steps: [
        {
          outcome: "response",
          toolCalls: [
            {
              id: "read-published-opening",
              name: "setting_read",
              arguments: { path: "opening.md" },
            },
            {
              id: "write-published-opening",
              name: "setting_write_file",
              arguments: {
                path: "opening.md",
                contents: "Already published change.\n",
              },
            },
          ],
        },
      ],
    }),
  );
  const failed = await sendFresh(
    interrupted,
    created.localId,
    "request-after-publish",
    "Change the opening",
  );
  const store = new FileNativeSettingImprovementStore(root);
  const pending = await store.read(failed.sessionId);
  expect(pending.pendingSettlement).not.toBeNull();

  const before = await interruptedContent.readCurrentTreeContentPackage(
    created.localId,
  );
  await interruptedContent.replaceCurrentTreeContentPackage(
    created.localId,
    before.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Already published change.\n" }
        : file,
    ),
    {
      baseTreeRevision: (
        await interruptedContent.readCurrentTreeContentPackage(created.localId)
      ).treeRevision,
    },
  );

  let repeatedPublish = false;
  const recoveredContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        repeatedPublish = true;
        throw new Error("recovery must not publish an already-current tree");
      },
    },
  });
  const resumeHost = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Publication confirmed." }],
  });
  const recoveryService = serviceFor(root, recoveredContent, resumeHost);
  const recovered = await recoveryService.readSession(
    created.localId,
    failed.sessionId,
  );

  expect(repeatedPublish).toBe(false);
  expect(recovered.turns[0]?.exchanges[0]?.toolCalls[1]).toMatchObject({
    callId: "write-published-opening",
    result: {
      isError: false,
      changes: [{ path: "opening.md", after: "Already published change.\n" }],
    },
  });
  expect((await store.read(failed.sessionId)).pendingSettlement).toBeNull();
  expect(recovered.canRetry).toBe(true);
  const finished = await recoveryService.resume({
    packageId: created.localId,
    sessionId: failed.sessionId,
    requestId: "retry-after-publication",
  });
  expect(finished.runStatus).toBe("ready");
  expect(repeatedPublish).toBe(false);
  expect(resumeHost.requests[0]?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "write-published-opening",
  });
});

test("当前树限制只拒绝越界调用，不回滚同响应中已接受的写入", async () => {
  const root = await temporaryRoot("narraeon-setting-limit-rejection-");
  const content = new ContentWorkspace(root, {
    locale: () => "en",
    limits: { maxFileBytes: 4_096, maxTotalBytes: 16_384 },
  });
  const created = await content.createCurrentTreeContentPackage();
  const openingBefore = (
    await content.readCurrentTreeContentPackage(created.localId)
  ).files.find(({ path }) => path === "opening.md")!.contents;
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-before-oversized-write",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "accepted-write",
            name: "setting_write_file",
            arguments: {
              path: "opening.md",
              contents: "Accepted sibling change.\n",
            },
          },
          {
            id: "oversized-write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "x".repeat(4_100) },
          },
        ],
      },
      {
        outcome: "response",
        text: "The valid edit is live; the oversized sibling was rejected.",
        toolCalls: [],
      },
    ],
  });
  const view = await sendFresh(
    serviceFor(root, content, host),
    created.localId,
    "request-oversized-write",
    "Replace the opening with a very long draft",
  );

  expect(openingBefore).not.toBe("Accepted sibling change.\n");
  expect(
    (await content.readCurrentTreeContentPackage(created.localId)).files.find(
      ({ path }) => path === "opening.md",
    )?.contents,
  ).toBe("Accepted sibling change.\n");
  expect(view.turns[0]?.exchanges[0]?.toolCalls).toMatchObject([
    { callId: "read-before-oversized-write", result: { isError: false } },
    {
      callId: "accepted-write",
      result: {
        isError: false,
        changes: [{ path: "opening.md", after: "Accepted sibling change.\n" }],
      },
    },
    {
      callId: "oversized-write",
      result: { isError: true, changes: [] },
    },
  ]);
  expect(view.turns[0]?.exchanges[0]?.toolCalls[2]?.result?.markdown).toContain(
    "size limit",
  );
  expect(host.requests[1]?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "oversized-write",
    isError: true,
  });
  expect(
    (await new FileNativeSettingImprovementStore(root).read(view.sessionId))
      .pendingSettlement,
  ).toBeNull();
});

test("schema-v1 隔离草稿严格迁移为审计历史，不改当前树", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Legacy seed.", toolCalls: [] },
  ]);
  const current = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-legacy-seed",
    "Seed",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const v2 = await store.read(current.sessionId);
  const packageBefore = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const openingBefore = packageBefore.files.find(
    ({ path }) => path === "opening.md",
  )!.contents;
  const legacyDraftFiles = packageBefore.files.map((file) =>
    file.path === "opening.md"
      ? { ...file, contents: "Unapplied legacy candidate.\n" }
      : file,
  );
  const legacyPreset = builtinDefaultPlayPresetBinding("en");
  const legacyPreview = new SettingAuthoringTransaction({
    baseFiles: legacyDraftFiles,
    locale: "en",
    preview: (snapshot) => {
      const openingMessage = "legacy-setting-authoring.genesis";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return new FileNativePromptCompiler({ locale: "en" }).preview(
        {
          endpoint: { id: "legacy-setting", commit: "draft-v1" },
          hostBinding: presetHostBinding(legacyPreset),
          world: {
            controlFingerprint: "legacy-setting",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Inspect the legacy setting draft.",
          modelBinding: binding,
        },
        legacyPreset,
      );
    },
  }).review().preview;
  expect(legacyPreview).not.toBeNull();
  // This synthetic v1 fixture must retain the released raw-input projection.
  if (legacyPreview?.initialAppend !== undefined) {
    const text = "Inspect the legacy setting draft.";
    legacyPreview.initialAppend.logical = { kind: "player", text };
    legacyPreview.initialAppend.provider = { role: "user", content: text };
  }
  const legacyBootstrap = structuredClone(v2.bootstrap);
  const legacyRuntime = legacyBootstrap.logicalMessages.find(
    ({ role }) => role === "runtime_system",
  )!;
  legacyRuntime.markdown =
    "# Legacy isolated draft\n\nAll writes enter an isolated draft and require Apply.";
  legacyRuntime.blocks = [
    {
      source: "runtime:setting-draft-boundary",
      markdown: legacyRuntime.markdown,
    },
  ];
  legacyBootstrap.provider.messages = [
    {
      role: "system",
      content:
        "# Legacy isolated draft\n\nAll writes enter an isolated draft and require Apply.",
    },
    ...legacyBootstrap.provider.messages.filter(
      ({ role }) => role !== "system",
    ),
  ];
  const legacy = {
    schemaVersion: 1,
    sessionId: v2.sessionId,
    packageId: v2.packageId,
    contentPackageTitle: v2.contentPackageTitle,
    locale: v2.locale,
    lifecycle: "open",
    runStatus: "running",
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    baseFingerprint: contentTreeFingerprint(packageBefore.files),
    baseFiles: packageBefore.files,
    draftVersion: 1,
    draft: {
      files: legacyDraftFiles,
      readWorldDocumentIds: [],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["opening.md"],
    },
    review: {
      status: "usable",
      diff: [
        {
          path: "opening.md",
          kind: "modify",
          before: openingBefore,
          after: "Unapplied legacy candidate.\n",
        },
      ],
      diagnostics: [],
      preview: legacyPreview,
      playCoverage: null,
    },
    bootstrap: legacyBootstrap,
    modelBinding: v2.modelBinding,
    modelItems: v2.modelItems,
    messages: v2.messages,
    usage: v2.usage,
    exchange: v2.exchange,
    toolCalls: v2.toolCalls,
    activeRequestId: "legacy-in-flight-request",
    completedRequestIds: v2.completedRequestIds,
    lastFailure: null,
    applyRequest: null,
    appliedAt: null,
  };
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${v2.sessionId}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  const malformedLegacySources = [
    { ...legacy, lifecycle: "unknown" },
    {
      ...legacy,
      review: { ...legacy.review, diff: [{ path: 7 }] },
    },
    {
      ...legacy,
      modelItems: [
        ...legacy.modelItems,
        { kind: "assistant", text: "Missing required toolCalls" },
      ],
    },
  ];
  for (const malformed of malformedLegacySources) {
    await writeFile(path, `${JSON.stringify(malformed)}\n`, "utf8");
    await expect(
      new FileNativeSettingImprovementStore(fixture.root).read(v2.sessionId),
    ).rejects.toThrow("Legacy setting-improvement conversation is damaged");
    await expect(
      readFile(
        join(
          fixture.root,
          "setting-improvements",
          "sessions",
          `${v2.sessionId}.schema-v1.json`,
        ),
        "utf8",
      ),
    ).rejects.toThrow();
  }
  const legacySource = `${JSON.stringify(legacy)}\n`;
  await writeFile(path, legacySource, "utf8");

  const continuedHost = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        text: "Continued against the current tree.",
        toolCalls: [],
      },
    ],
  });
  const restarted = serviceFor(fixture.root, fixture.content, continuedHost);
  const migrated = await restarted.readSession(fixture.packageId, v2.sessionId);
  expect(migrated.legacyDraft).toMatchObject({
    outcome: "unapplied_dropped",
    changes: [{ path: "opening.md", after: "Unapplied legacy candidate.\n" }],
  });
  expect(migrated.runStatus).toBe("interrupted");
  const packageAfter = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  expect(
    packageAfter.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(openingBefore);
  await expect(
    readFile(
      join(
        fixture.root,
        "setting-improvements",
        "sessions",
        `${v2.sessionId}.schema-v1.json`,
      ),
      "utf8",
    ),
  ).resolves.toBe(legacySource);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    schemaVersion: 2,
  });
  const migratedStored = await new FileNativeSettingImprovementStore(
    fixture.root,
  ).read(v2.sessionId);
  expect(migratedStored.completedRequestIds).toContain(
    "legacy-in-flight-request",
  );
  expect(migratedStored.playPreset).toBeUndefined();
  expect(JSON.stringify(migratedStored.bootstrap)).toContain(
    "Legacy isolated draft",
  );
  expect(migratedStored.modelItems).toEqual(v2.modelItems);
  const migratedSystemMessages = migratedStored.bootstrap.provider.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => String(content));
  expect(migratedSystemMessages).toEqual([
    expect.stringContaining("Legacy isolated draft"),
    expect.stringContaining("Runtime system contract replaces"),
  ]);
  expect(
    migratedStored.bootstrap.logicalMessages.find(
      ({ role }) => role === "runtime_system",
    )?.markdown,
  ).toContain("Runtime system contract replaces");

  await restarted.send({
    packageId: fixture.packageId,
    requestId: "legacy-in-flight-request",
    message: "Do not resend this unknown legacy request",
    continuation: { kind: "continue_context", sessionId: v2.sessionId },
  });
  expect(continuedHost.requests).toHaveLength(0);

  await restarted.send({
    packageId: fixture.packageId,
    requestId: "request-continue-migrated",
    message: "Continue this old conversation",
    continuation: { kind: "continue_context", sessionId: v2.sessionId },
  });
  expect(continuedHost.requests[0]?.bootstrap).toEqual(
    (await store.read(v2.sessionId)).requests?.at(-1)?.bootstrap,
  );
  expect(continuedHost.requests[0]?.appended.at(-1)).toEqual({
    kind: "user",
    text: "Continue this old conversation",
  });

  const receiptCases = [
    { current: "base", expected: "unapplied_dropped" },
    { current: "draft", expected: "applied" },
    { current: "other", expected: "apply_outcome_unknown" },
  ] as const;
  for (const receiptCase of receiptCases) {
    const created = await fixture.content.createCurrentTreeContentPackage();
    const base = await fixture.content.readCurrentTreeContentPackage(
      created.localId,
    );
    const baseOpening = base.files.find(
      ({ path }) => path === "opening.md",
    )!.contents;
    const draftFiles = base.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Legacy Apply target.\n" }
        : file,
    );
    const otherFiles = base.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Unrelated later current tree.\n" }
        : file,
    );
    if (receiptCase.current !== "base")
      await fixture.content.replaceCurrentTreeContentPackage(
        created.localId,
        receiptCase.current === "draft" ? draftFiles : otherFiles,
        {
          baseTreeRevision: (
            await fixture.content.readCurrentTreeContentPackage(created.localId)
          ).treeRevision,
        },
      );
    const receiptSessionId = store.createId();
    const receiptLegacy = {
      ...legacy,
      sessionId: receiptSessionId,
      packageId: created.localId,
      contentPackageTitle: created.title,
      runStatus: "ready",
      baseFingerprint: contentTreeFingerprint(base.files),
      baseFiles: base.files,
      draft: {
        ...legacy.draft,
        files: draftFiles,
      },
      review: {
        ...legacy.review,
        diff: [
          {
            path: "opening.md",
            kind: "modify",
            before: baseOpening,
            after: "Legacy Apply target.\n",
          },
        ],
      },
      activeRequestId: null,
      completedRequestIds: [],
      applyRequest: {
        expectedDraftVersion: legacy.draftVersion,
        draftFingerprint: contentTreeFingerprint(draftFiles),
      },
    };
    const receiptPath = join(
      fixture.root,
      "setting-improvements",
      "sessions",
      `${receiptSessionId}.json`,
    );
    await writeFile(receiptPath, `${JSON.stringify(receiptLegacy)}\n`, "utf8");
    const currentBeforeMigration = contentTreeFingerprint(
      (await fixture.content.readCurrentTreeContentPackage(created.localId))
        .files,
    );

    const receiptMigrated = await new FileNativeSettingImprovementStore(
      fixture.root,
      { content: fixture.content },
    ).read(receiptSessionId);

    expect(receiptMigrated.legacyDraft?.outcome).toBe(receiptCase.expected);
    expect(
      contentTreeFingerprint(
        (await fixture.content.readCurrentTreeContentPackage(created.localId))
          .files,
      ),
    ).toBe(currentBeforeMigration);
    if (receiptCase.expected === "apply_outcome_unknown")
      expect(receiptMigrated.lastFailure).toContain("cannot be proven");
  }
});

test("状态轮询只返回所选对话的轻量进度和持久 revision", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Done.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-status",
    "Status",
  );
  const status = await fixture.session.status(
    fixture.packageId,
    view.sessionId,
  );
  expect(status).toMatchObject({
    selected: {
      sessionId: view.sessionId,
      runStatus: "ready",
      progress: { exchange: 1, toolCalls: 0 },
    },
  });
  expect(status.revision).not.toBe("");
  expect(JSON.stringify(status)).not.toContain("Done.");
  expect(JSON.stringify(status)).not.toContain("opening.md");
});

test("删除历史对话只移除会话文件，不改内容包当前树", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First conversation.", toolCalls: [] },
    { outcome: "response", text: "Second conversation.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-delete-first",
    "Keep this first conversation",
  );
  const second = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-delete-second",
    "Keep this second conversation",
  );
  const before = contentTreeFingerprint(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  );

  const overview = await fixture.session.deleteSession(
    fixture.packageId,
    first.sessionId,
  );

  expect(overview.latest?.sessionId).toBe(second.sessionId);
  expect(overview.history.map(({ sessionId }) => sessionId)).toEqual([
    second.sessionId,
  ]);
  await expect(
    new FileNativeSettingImprovementStore(fixture.root).read(first.sessionId),
  ).rejects.toThrow("does not exist");
  expect(
    contentTreeFingerprint(
      (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    ),
  ).toBe(before);
});

test("正在接收 Provider 响应的对话不能被历史删除", async () => {
  const root = await temporaryRoot("narraeon-setting-delete-running-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scripted = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished.", toolCalls: [] }],
  });
  const host: ModelHost = {
    binding: () => scripted.binding(),
    exchange: (request, observer) => {
      started.resolve();
      return release.promise.then(() => scripted.exchange(request, observer));
    },
  };
  const session = serviceFor(root, content, host);
  const sending = sendFresh(
    session,
    created.localId,
    "request-delete-running",
    "Wait before answering",
  );
  await started.promise;
  const running = await session.overview(created.localId);
  const sessionId = running.latest?.sessionId;
  if (sessionId === undefined) throw new Error("Running session was not saved");

  await expect(
    session.deleteSession(created.localId, sessionId),
  ).rejects.toThrow("cannot be deleted");
  release.resolve();
  await sending;
  await expect(
    session.deleteSession(created.localId, sessionId),
  ).resolves.toMatchObject({ latest: null, history: [] });
});

test("schema-v2 对未知字段和损坏的非 opaque 结构 fail closed", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Codec seed.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-v2-codec",
    "Create a strict codec fixture",
  );
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    view.sessionId,
  );
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${view.sessionId}.json`,
  );
  const pendingModelItems = [
    ...stored.modelItems,
    { kind: "user", text: "Pending write" } as const,
    {
      kind: "assistant",
      text: "",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: { role: "assistant", content: null },
      },
      toolCalls: [
        {
          id: "pending-write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Pending\n" },
        },
      ],
    } as const,
  ];
  const validPreparedSettlement = {
    phase: "publication_prepared" as const,
    assistantItemIndex: pendingModelItems.length - 1,
    beforeFingerprint: "sha256:before",
    afterFingerprint: "sha256:after",
    toolResults: [
      {
        toolCallId: "pending-write",
        markdown: "# Current-tree write accepted",
        isError: false,
        changes: [],
      },
    ],
    authorization: {
      revision: "sha256:after",
      readWorldDocumentIds: [],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["opening.md"],
    },
  };
  const validPendingSession = {
    ...stored,
    runStatus: "interrupted" as const,
    modelItems: pendingModelItems,
    pendingSettlement: validPreparedSettlement,
  };
  await writeFile(path, `${JSON.stringify(validPendingSession)}\n`, "utf8");
  await expect(
    new FileNativeSettingImprovementStore(fixture.root).read(view.sessionId),
  ).resolves.toMatchObject({
    pendingSettlement: { phase: "publication_prepared" },
  });
  const damaged: unknown[] = [
    { ...stored, unknownRootField: true },
    { ...stored, bootstrap: { ...stored.bootstrap, unknownBootstrapField: 1 } },
    { ...stored, usage: { ...stored.usage, totalTokens: "invalid" } },
    {
      ...stored,
      pendingSettlement: {
        phase: "response_confirmed",
        assistantItemIndex: 0,
        beforeFingerprint: "sha256:before",
        unknownSettlementField: true,
      },
    },
    {
      ...validPendingSession,
      pendingSettlement: {
        ...validPreparedSettlement,
        toolResults: [
          {
            ...validPreparedSettlement.toolResults[0],
            toolCallId: "different-call",
          },
        ],
      },
    },
    {
      ...validPendingSession,
      pendingSettlement: {
        ...validPreparedSettlement,
        authorization: {
          ...validPreparedSettlement.authorization,
          revision: "sha256:not-after",
        },
      },
    },
  ];
  for (const value of damaged) {
    await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    await expect(
      new FileNativeSettingImprovementStore(fixture.root).read(view.sessionId),
    ).rejects.toThrow(
      "Setting-improvement conversation does not match its durable schema",
    );
  }
});

test("恢复写入使用 CAS，过期副本不能覆盖更新后的对话", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Durable answer.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-cas",
    "Create one durable conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stale = await store.read(view.sessionId);
  const newer = structuredClone(stale);
  newer.lastFailure = "newer state";
  newer.updatedAt += 1;
  await store.save(newer);
  const staleRecovery = structuredClone(stale);
  staleRecovery.lastFailure = "stale recovery";
  staleRecovery.updatedAt += 2;

  await expect(store.saveIfUnchanged(stale, staleRecovery)).resolves.toBe(
    false,
  );
  await expect(store.read(view.sessionId)).resolves.toMatchObject({
    lastFailure: "newer state",
  });
});

test("新内容包会话预载控制文档，未读即可修改预载文档，只列出的 opening.md 仍需先读", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "write-preloaded-control",
          name: "setting_write_file",
          arguments: {
            path: "control/blocks/world.md",
            contents: "# 本世界\n\n预载后直接修改。",
          },
        },
        {
          id: "write-listed-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "未读不能写入。" },
        },
      ],
    },
    { outcome: "response", text: "Preloaded write accepted.", toolCalls: [] },
  ]);

  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-preload",
    "Refine the world notes.",
  );

  expect(JSON.stringify(fixture.host.requests[0])).toContain(
    "Runtime preload note",
  );
  expect(view.turns[0]?.exchanges[0]?.toolCalls).toMatchObject([
    { callId: "write-preloaded-control", result: { isError: false } },
    { callId: "write-listed-opening", result: { isError: true } },
  ]);
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    view.sessionId,
  );
  expect(stored.requests?.[0]?.preload?.opaquePaths).toContain(
    "control/blocks/world.md",
  );
  expect(stored.requests?.[0]?.preload?.opaquePaths).not.toContain(
    "opening.md",
  );
});

test("a crash after settled receipts resumes the next frozen exchange exactly once", async () => {
  const fixture = await createFixture([]);
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Saved.\n" },
          },
        ],
      },
      { outcome: "failure", message: "stop after receipt" },
    ],
  });
  const originalSave = store.save.bind(store);
  let checkpoint: Parameters<typeof store.save>[0] | undefined;
  vi.spyOn(store, "save").mockImplementation(async (session) => {
    await originalSave(session);
    if (
      checkpoint === undefined &&
      session.runStatus === "running" &&
      session.pendingSettlement === null &&
      session.modelItems.at(-1)?.kind === "tool"
    )
      checkpoint = structuredClone(session);
  });
  const stopped = await sendFresh(
    serviceFor(fixture.root, fixture.content, host, undefined, store),
    fixture.packageId,
    "receipt",
    "Change.",
  );
  expect(checkpoint).toBeDefined();
  await originalSave(checkpoint!);
  const files = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const nextHost = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const recoveredService = serviceFor(fixture.root, fixture.content, nextHost);
  const recovered = await recoveredService.readSession(
    fixture.packageId,
    stopped.sessionId,
  );
  expect(recovered.canRetry).toBe(true);
  const resumed = await recoveredService.resume({
    packageId: fixture.packageId,
    sessionId: stopped.sessionId,
    requestId: "resume-receipt",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Change.",
    "Finished.",
  ]);
  expect(nextHost.requests[0]).toMatchObject({
    requestId: "receipt",
    exchange: 2,
  });
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(files);
});

test("setting recovers the frozen request if the initial running save precedes dispatch", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
  ]);
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const save = store.save.bind(store);
  let checkpoint: Parameters<typeof store.save>[0] | undefined;
  vi.spyOn(store, "save").mockImplementation(async (session) => {
    if (
      checkpoint === undefined &&
      session.runStatus === "running" &&
      session.modelItems.at(-1)?.kind === "user"
    )
      checkpoint = structuredClone(session);
    await save(session);
  });
  const stopped = await sendFresh(
    serviceFor(fixture.root, fixture.content, fixture.host, undefined, store),
    fixture.packageId,
    "original",
    "Change.",
  );
  expect(checkpoint).toBeDefined();
  await save(checkpoint!);
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished." }],
  });
  const service = serviceFor(fixture.root, fixture.content, host);
  expect(
    (await service.readSession(fixture.packageId, stopped.sessionId)).canRetry,
  ).toBe(true);
  const resumed = await service.resume({
    packageId: fixture.packageId,
    sessionId: stopped.sessionId,
    requestId: "resume",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Change.",
    "Finished.",
  ]);
  expect(host.requests[0]).toMatchObject({
    requestId: "original",
    exchange: 1,
  });
});

test("setting retries when the dispatch marker save fails before the host is called", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Finished." },
  ]);
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const save = store.save.bind(store);
  let failed = false;
  vi.spyOn(store, "save").mockImplementation(async (session) => {
    if (
      !failed &&
      session.runStatus === "running" &&
      session.exchange === 1 &&
      session.modelItems.at(-1)?.kind === "user"
    ) {
      failed = true;
      throw new Error("dispatch marker save failed");
    }
    await save(session);
  });
  const service = serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
    undefined,
    store,
  );
  const stopped = await sendFresh(
    service,
    fixture.packageId,
    "original",
    "Change.",
  );
  expect(failed).toBe(true);
  expect(fixture.host.requests).toHaveLength(0);
  expect(stopped.canRetry).toBe(true);
  const resumed = await service.resume({
    packageId: fixture.packageId,
    sessionId: stopped.sessionId,
    requestId: "resume",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Change.",
    "Finished.",
  ]);
  expect(fixture.host.requests[0]).toMatchObject({
    requestId: "original",
    exchange: 1,
  });
});

test("setting retries the next exchange after final settlement save fails once", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        { id: "read", name: "setting_read", arguments: { path: "opening.md" } },
        {
          id: "write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Saved.\n" },
        },
      ],
    },
    { outcome: "response", text: "Finished." },
  ]);
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const save = store.save.bind(store);
  let failed = false;
  vi.spyOn(store, "save").mockImplementation(async (session) => {
    if (
      !failed &&
      session.runStatus === "running" &&
      session.pendingSettlement === null &&
      session.modelItems.at(-1)?.kind === "tool"
    ) {
      failed = true;
      throw new Error("final settlement save failed");
    }
    await save(session);
  });
  const service = serviceFor(
    fixture.root,
    fixture.content,
    fixture.host,
    undefined,
    store,
  );
  const stopped = await sendFresh(
    service,
    fixture.packageId,
    "original",
    "Change.",
  );
  expect(failed).toBe(true);
  expect(stopped.canRetry).toBe(true);
  const files = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const resumed = await service.resume({
    packageId: fixture.packageId,
    sessionId: stopped.sessionId,
    requestId: "resume",
  });
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "Change.",
    "Finished.",
  ]);
  expect(fixture.host.requests[1]).toMatchObject({
    requestId: "original",
    exchange: 2,
  });
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(files);
});

test("inconsistent Google or unknown-outcome checkpoints never grant authoring replay", async () => {
  const fixture = await createFixture([
    { outcome: "failure", message: "disconnected" },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request",
    "Change.",
  );
  const saved = await new FileNativeSettingImprovementStore(fixture.root).read(
    view.sessionId,
  );
  expect(canRetryAuthoringDispatch(saved)).toBe(true);
  expect(
    canRetryAuthoringDispatch({ ...saved, googleOutcomeUnknown: true }),
  ).toBe(false);
});

authoringTargetContract("content package", async (steps, delay = false) => {
  const fixture = await createFixture([]);
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const write: ScriptedModelHostStep = {
    outcome: "response",
    toolCalls: [
      { id: "read", name: "setting_read", arguments: { path: "opening.md" } },
      {
        id: "write",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: "AI version.\n" },
      },
    ],
  };
  const script = new ScriptedModelHost({ binding, steps: steps(write) });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const host: ModelHost = {
    binding: () => binding,
    exchange: async (request, observer) => {
      if (delay && first) {
        first = false;
        started.resolve();
        await release.promise;
      }
      return script.exchange(request, observer);
    },
  };
  const makeService = () =>
    serviceFor(fixture.root, fixture.content, host, undefined, store);
  const service = makeService();
  return {
    send: () => sendFresh(service, fixture.packageId, "original", "Change."),
    read: (id) => service.readSession(fixture.packageId, id),
    resume: (id) =>
      makeService().resume({
        packageId: fixture.packageId,
        sessionId: id,
        requestId: "resume",
      }),
    edit: (id, messageId) =>
      service.editMessage({
        packageId: fixture.packageId,
        sessionId: id,
        messageId,
        requestId: "edit",
        message: "Discuss.",
        filePolicy: "revert",
      }),
    activeId: async () =>
      (await service.overview(fixture.packageId)).latest!.sessionId,
    cancel: (id) => service.cancel(id),
    manualChange: async () => {
      const current = await fixture.content.readCurrentTreeContentPackage(
        fixture.packageId,
      );
      await fixture.content.replaceCurrentTreeContentPackage(
        fixture.packageId,
        current.files.map((file) =>
          file.path === "opening.md"
            ? { ...file, contents: "Manual version.\n" }
            : file,
        ),
        { baseTreeRevision: current.treeRevision },
      );
    },
    files: async () =>
      (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    requests: script.requests,
    started: started.promise,
    release: () => release.resolve(),
  };
});

async function createFixture(steps: ScriptedModelHostStep[]) {
  const root = await temporaryRoot("narraeon-setting-conversation-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const host = new ScriptedModelHost({ binding, steps });
  return {
    root,
    content,
    packageId: created.localId,
    host,
    session: serviceFor(root, content, host),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sendFresh(
  session: SettingImprovementSession,
  packageId: string,
  requestId: string,
  message: string,
) {
  return session.send({
    packageId,
    requestId,
    message,
    continuation: { kind: "fresh_context" },
  });
}

function serviceFor(
  root: string,
  content: ContentWorkspace,
  host: ModelHost,
  playPreset: PlayPresetBinding = builtinDefaultPlayPresetBinding("en"),
  store?: FileNativeSettingImprovementStore,
  bindExisting?: (binding: ModelHostBinding) => Promise<ModelHost>,
): SettingImprovementSession {
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  return new SettingImprovementSession({
    store: store ?? new FileNativeSettingImprovementStore(root),
    content,
    compiler,
    locale: () => "en",
    bindModelHost: () =>
      bindExisting ? bindExisting(host.binding()) : Promise.resolve(host),
    bindExistingModelHost:
      bindExisting ??
      ((frozenBinding) => {
        if (JSON.stringify(frozenBinding) !== JSON.stringify(host.binding()))
          throw new Error("Frozen model binding is unavailable");
        return Promise.resolve(host);
      }),
    bindPlayPreset: () => Promise.resolve(structuredClone(playPreset)),
    preview: (snapshot, modelBinding, frozenPreset) => {
      if (frozenPreset === undefined)
        throw new Error(
          "New setting-improvement conversations freeze a preset",
        );
      const openingMessage = "setting-authoring.message.genesis.narrator";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return compiler.preview(
        {
          endpoint: { id: "setting-authoring", commit: "current-tree" },
          hostBinding: presetHostBinding(frozenPreset),
          world: {
            controlFingerprint: "setting-authoring",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Inspect the content package current tree.",
          modelBinding,
        },
        frozenPreset,
      );
    },
  });
}

test("next author send refreshes rules while retaining bootstrap and native history", async () => {
  const fixture = await createFixture([]);
  const preset = builtinDefaultPlayPresetBinding("en");
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        text: "First answer",
        reasoningContent: "Exact provider reasoning",
        toolCalls: [],
      },
      { outcome: "response", text: "Second answer", toolCalls: [] },
    ],
  });
  const session = serviceFor(fixture.root, fixture.content, host, preset);
  const first = await sendFresh(
    session,
    fixture.packageId,
    "rules-first",
    "First",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const before = await store.read(first.sessionId);
  preset.definition.authorPrompts = [
    {
      id: "new-rule",
      kind: "user",
      name: "New rule",
      enabled: true,
      body: "AUTHOR_RULE_UPDATED",
    },
    ...preset.definition.authorPrompts!,
  ];
  const raw = parseDocument(preset.files["preset.yaml"]!);
  raw.set("authorPrompts", { entries: [preset.definition.authorPrompts[0]] });
  preset.files["preset.yaml"] = raw.toString();
  const parsed = parsePlayPresetFiles(preset.files);
  if (parsed.kind !== "valid") throw parsed.error;
  preset.definition = parsed.definition;
  preset.revision = revisionForPlayPresetFiles(preset.files);
  await session.send({
    packageId: fixture.packageId,
    requestId: "rules-second",
    message: "Second",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(JSON.stringify(host.requests[1]!.bootstrap)).toContain(
    "AUTHOR_RULE_UPDATED",
  );
  expect(JSON.stringify(host.requests[0]!.bootstrap)).not.toContain(
    "AUTHOR_RULE_UPDATED",
  );
  expect(host.requests[1]!.appended.slice(0, before.modelItems.length)).toEqual(
    before.modelItems,
  );
  expect((await store.read(first.sessionId)).bootstrap).toEqual(
    before.bootstrap,
  );
});

test("new author snapshot corruption fails closed and upgrading keeps the old prompt accessible", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Original", toolCalls: [] },
    { outcome: "response", text: "Continued", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "snapshot-first",
    "Original user",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const saved = await store.read(first.sessionId);
  for (const index of [1, 999]) {
    const corrupt = structuredClone(saved);
    corrupt.requests![0]!.modelItemStart = index;
    await expect(store.save(corrupt)).rejects.toThrow("durable schema");
  }
  await expect(store.save({ ...saved, requests: [] })).rejects.toThrow(
    "durable schema",
  );
  const wrongRequest = structuredClone(saved);
  wrongRequest.requests![0]!.requestId = "unrelated";
  await expect(store.save(wrongRequest)).rejects.toThrow("durable schema");
  const legacy = structuredClone(saved);
  delete legacy.requests;
  await store.save({ ...legacy, schemaVersion: 2 });
  const candidate = await fixture.session.preview(
    fixture.packageId,
    first.sessionId,
  );
  expect(fixture.host.requests).toHaveLength(1);
  const next = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "snapshot-next",
    message: "Next",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(next.requestPreviews).toHaveLength(2);
  expect(next.requestPreviews![0]).toMatchObject({
    legacyBootstrap: true,
    compilation: saved.bootstrap,
  });
  expect(fixture.host.requests[1]!.bootstrap).toEqual(candidate);
});

test("151 cold resume Google setting after published tools", async () => {
  const root = await temporaryRoot("151-setting");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const { localId } = await content.createCurrentTreeContentPackage();
  const before = googleAuthoringHost([
    googleTools([
      {
        id: "read-151",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "write-151",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: "Only once." },
      },
    ]),
    interruptedGoogleWrite("setting_write_file", "opening.md"),
  ]);
  const stopped = await sendFresh(
    serviceFor(root, content, before.host),
    localId,
    "f151",
    "Edit.",
  );
  expect(stopped).toMatchObject({ runStatus: "interrupted", canRetry: true });
  const tree = await content.readCurrentTreeContentPackage(localId);
  const after = googleAuthoringHost([googleText("Done.")], undefined, {
    baseUrl: "https://new.invalid/other",
    modelId: "new-model",
    maxOutputTokens: 3000,
  });
  const next = await serviceFor(root, content, after.host).resume({
    packageId: localId,
    sessionId: stopped.sessionId,
    requestId: "r151",
  });
  expect(next.runStatus).toBe("ready");
  const previews = next.requestPreviews!;
  expect(previews).toHaveLength(2);
  expect(previews[0]!.wireRequest?.endpointPath).not.toEqual(
    previews[1]!.wireRequest?.endpointPath,
  );
  expect(previews[0]!.wireRequest?.body).toMatchObject({
    model: "manual-model",
  });
  expect(previews[1]!.wireRequest?.body).toMatchObject({ model: "new-model" });
  expect(previews[1]!.wireRequest?.body).toMatchObject({
    model: after.sent[0]?.model,
    generation_config: after.sent[0]?.generation_config,
  });
  expect(JSON.stringify(previews[1]!.wireRequest?.body)).toContain(
    "runtime_redacted_provider_step",
  );
  expect(after.sent).toHaveLength(1);
  expect(JSON.stringify(after.sent[0])).toContain('"call_id":"write-151"');
  expect(
    next.turns[0]?.exchanges
      .flatMap((e) => e.toolCalls)
      .filter((c) => c.callId === "write-151"),
  ).toHaveLength(1);
  expect(
    (await content.readCurrentTreeContentPackage(localId)).treeRevision,
  ).toBe(tree.treeRevision);
});

test("editing the first author message rejects a different protocol before changing files or history", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Old answer." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first-protocol",
    "Original.",
  );
  const before = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const nextHost = new ScriptedModelHost({
    binding: {
      ...binding,
      provider: "anthropic_messages",
      cacheStrategy: "explicit_anthropic_blocks",
    },
    steps: [],
  });
  const service = serviceFor(fixture.root, fixture.content, nextHost);
  await expect(
    service.editMessage({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "edit-protocol",
      messageId: first.turns[0]!.user.id,
      message: "Replacement.",
      filePolicy: "keep",
    }),
  ).rejects.toThrow(/protocol|fresh model context/i);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(before.files);
  expect(
    (await service.readSession(fixture.packageId, first.sessionId)).messages,
  ).toEqual(first.messages);
  expect(nextHost.requests).toHaveLength(0);
});

test("schema 5 source is preserved when the next send records current binding evidence", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First." },
    { outcome: "response", text: "Second." },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "first-schema5",
    "First.",
  );
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${first.sessionId}.json`,
  );
  const old = JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion: number;
    requests: { modelBinding?: unknown; retryAttempts?: unknown }[];
  };
  old.schemaVersion = 5;
  for (const request of old.requests) {
    delete request.modelBinding;
    delete request.retryAttempts;
  }
  const source = JSON.stringify(old);
  await writeFile(path, source);
  await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "second-schema6",
    message: "Second.",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(
    await readFile(
      join(
        fixture.root,
        "setting-improvements",
        "sessions",
        `${first.sessionId}.schema-v5.json`,
      ),
      "utf8",
    ),
  ).toBe(source);
  expect(
    (
      await new FileNativeSettingImprovementStore(fixture.root).read(
        first.sessionId,
      )
    ).schemaVersion,
  ).toBe(6);
});

test("设定完善中断正文在重启后继续发送，保持冻结请求及正文空白", async () => {
  const { prefillHost } = await import("./support/prefill-host.ts");
  const { host, sent } = prefillHost([
    { text: " \n半🙂" },
    { text: "续文。", finish: "stop" },
  ]);
  const fixture = await createFixture([]);
  const service = serviceFor(fixture.root, fixture.content, host);
  const first = await sendFresh(
    service,
    fixture.packageId,
    "prefill-first",
    "Inspect.",
  );
  expect(first).toMatchObject({
    runStatus: "interrupted",
    canContinuePartial: true,
  });
  expect(first.messages).toHaveLength(1);
  const cold = serviceFor(
    fixture.root,
    new ContentWorkspace(fixture.root),
    host,
  );
  const read = await cold.read(fixture.packageId);
  expect(read?.canContinuePartial).toBe(true);
  const done = await cold.resume({
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "prefill-continue",
    recovery: "continue_partial",
  });
  expect(done.runStatus).toBe("ready");
  expect(done.messages.at(-1)?.text).toBe(" \n半🙂续文。");
  expect((sent[1]?.messages as unknown[]).at(-1)).toEqual({
    role: "assistant",
    content: " \n半🙂",
  });
  expect((sent[1]?.messages as unknown[]).slice(0, -1)).toEqual(
    sent[0]?.messages,
  );
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    first.sessionId,
  );
  expect(stored.partialResponse).toBeUndefined();
  const assistant = stored.modelItems.at(-1);
  expect(assistant).toMatchObject({
    kind: "assistant",
    text: " \n半🙂续文。",
    providerState: { assistantMessage: { content: " \n半🙂续文。" } },
  });
});

test("设定完善 token 截断可累计继续，普通重发重新生成原请求", async () => {
  const { prefillHost } = await import("./support/prefill-host.ts");
  const { host, sent } = prefillHost([
    { text: "头", finish: "length" },
    { text: "中" },
    { text: "新正文", finish: "stop" },
  ]);
  const fixture = await createFixture([]);
  const service = serviceFor(fixture.root, fixture.content, host);
  const first = await sendFresh(
    service,
    fixture.packageId,
    "first",
    "Inspect.",
  );
  expect(first).toMatchObject({ canRetry: false, canContinuePartial: true });
  const second = await service.resume({
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "second",
    recovery: "continue_partial",
  });
  expect(second.canContinuePartial).toBe(true);
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    first.sessionId,
  );
  expect(stored.partialResponse?.text).toBe("头中");
  const done = await service.resume({
    packageId: fixture.packageId,
    sessionId: first.sessionId,
    requestId: "third",
  });
  expect(done.messages.at(-1)?.text).toBe("新正文");
  expect(sent[2]?.messages).toEqual(sent[0]?.messages);
});

test("进程在继续发送途中退出不把旧前缀冒充新响应完整保留", async () => {
  const { prefillHost } = await import("./support/prefill-host.ts");
  const { host } = prefillHost([{ text: "原前缀" }]);
  const fixture = await createFixture([]);
  const service = serviceFor(fixture.root, fixture.content, host);
  const first = await sendFresh(
    service,
    fixture.packageId,
    "first",
    "Inspect.",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stored = await store.read(first.sessionId);
  stored.runStatus = "running";
  stored.activeRequestId = "first";
  stored.retryDispatch!.state = "dispatching";
  stored.partialResponse!.request.assistantPrefill = {
    mode: "assistant",
    text: "原前缀",
  };
  await store.save(stored);
  const cold = serviceFor(
    fixture.root,
    new ContentWorkspace(fixture.root),
    host,
  );
  const recovered = await cold.read(fixture.packageId);
  expect(recovered).toMatchObject({
    runStatus: "interrupted",
    canRetry: true,
    canContinuePartial: false,
  });
  await expect(
    cold.resume({
      packageId: fixture.packageId,
      sessionId: first.sessionId,
      requestId: "continue",
      recovery: "continue_partial",
    }),
  ).rejects.toThrow(/no supported text prefix/iu);
});
