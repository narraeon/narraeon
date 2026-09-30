import { expect, test, vi } from "vitest";
import type { ConversationTarget } from "../../src/protocol/conversationObservation.ts";
import type {
  V1Request,
  V1SettingImprovementView,
  V1WorldRevisionEpochView,
  ContentTreeFile,
} from "../../src/protocol/v1.ts";
import { emptyAggregatedModelUsage } from "../../src/protocol/modelUsage.ts";
import type { ObserveConversation } from "../../src/web/ConversationObserver.ts";
import { AuthoringWorkspace } from "../../src/web/AuthoringWorkspace.ts";
import {
  contentPackageTarget,
  worldRevisionTarget,
} from "../../src/web/AuthoringTarget.ts";

function fixture(kind: "setting" | "revision") {
  let files: ContentTreeFile[] = [
    { path: "control/frame.yaml", contents: "saved" },
  ];
  const view = (sessionId: string): V1SettingImprovementView => ({
    sessionId,
    packageId: "target",
    legacyDraft: null,
    runStatus: "ready",
    messages: [],
    turns: [],
    usage: emptyAggregatedModelUsage(),
    progress: { exchange: 0, toolCalls: 0, streaming: null, updatedAt: 1 },
    lastFailure: null,
  });
  let latest = view("recent");
  const epoch = (): V1WorldRevisionEpochView => ({
    epochId: "epoch",
    worldId: "target",
    lifecycle: "active",
    locked: true,
    baseHead: "commit:1",
    revision: files[0]!.contents,
    files,
    diff: [],
    diagnostics: [],
    changes: [],
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    appliedHead: null,
  });
  const overview = () => ({
    latest,
    history: ["recent", "old"].map((sessionId) => ({
      sessionId,
      createdAt: 1,
      updatedAt: 1,
      runStatus: "ready",
      messageCount: 0,
      turnCount: 0,
      exchangeCount: 0,
      toolCallCount: 0,
      changedFileCount: 0,
      excerpt: sessionId,
    })),
    ...(kind === "revision" ? { epoch: epoch(), sealedEpochs: [] } : {}),
  });
  const subscribers = new Set<{
    target: ConversationTarget;
    receive: Parameters<ObserveConversation>[1];
    connection: Parameters<ObserveConversation>[2];
  }>();
  const request = vi.fn(async (input: V1Request): Promise<unknown> => {
    await Promise.resolve();
    if (input.type === "content.read")
      return {
        localId: "target",
        title: "target",
        status: "usable",
        issues: [],
        files,
      };
    if (input.type.endsWith("overview")) return overview();
    if ("sessionId" in input && input.type.endsWith("session.read"))
      return view(input.sessionId);
    throw new Error(`Unexpected request ${input.type}`);
  });
  const client = {
    request,
    observeConversation: ((target, receive, connection) => {
      const item = { target, receive, connection };
      subscribers.add(item);
      return () => {
        subscribers.delete(item);
      };
    }) satisfies ObserveConversation,
  };
  const workspace = new AuthoringWorkspace(
    kind === "setting"
      ? contentPackageTarget(client, "target")
      : worldRevisionTarget(client, "target"),
    client.observeConversation,
  );
  return {
    workspace,
    request,
    subscribers,
    view,
    overview,
    setFiles: (value: string) => {
      files = [{ path: "control/frame.yaml", contents: value }];
    },
    setLatest: (value: V1SettingImprovementView) => {
      latest = value;
    },
    publish: async (durableChanged = true) => {
      for (const item of [...subscribers])
        await item.receive(
          {
            kind,
            value: {
              revision: "next",
              selected: {
                sessionId: latest.sessionId,
                runStatus: latest.runStatus,
                progress: latest.progress,
              },
            },
          },
          durableChanged,
        );
    },
  };
}

test.each(["setting", "revision"] as const)(
  "%s hydration preserves the editing baseline and reset uses the latest files",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "my unsaved text" },
    ]);
    f.setFiles("AI saved text");
    await f.publish();
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: true,
      files: [{ contents: "my unsaved text" }],
      baseline: [{ contents: "saved" }],
      serverFiles: [{ contents: "AI saved text" }],
    });
    f.workspace.resetFiles();
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: false,
      files: [{ contents: "AI saved text" }],
      baseline: [{ contents: "AI saved text" }],
    });
    f.workspace.close();
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each(["setting", "revision"] as const)(
  "%s fresh is claimed by observation and late send cannot override history selection",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    f.workspace.startFresh();
    await f.publish();
    expect(f.workspace.getSnapshot().view).toBeNull();
    const send = deferred<V1SettingImprovementView>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith(".message") ? send.promise : original(input),
    );
    const sending = f.workspace.send("start fresh");
    expect([...f.subscribers][0]!.target).toEqual({ kind, id: "target" });
    await f.publish();
    expect(f.workspace.getSnapshot().view).toBeNull();
    f.setLatest(f.view("created"));
    await f.publish();
    expect(f.workspace.getSnapshot().view?.sessionId).toBe("created");
    expect([...f.subscribers][0]!.target).toEqual({
      kind,
      id: "target",
      sessionId: "created",
    });
    await f.workspace.selectSession("old");
    send.resolve(f.view("created"));
    await sending;
    expect(f.workspace.getSnapshot().view?.sessionId).toBe("old");
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s stale cancel/delete failures and cleanup cannot affect a newer selection",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const cancel = deferred<V1SettingImprovementView>();
    const deletion = deferred<unknown>();
    const selection = deferred<V1SettingImprovementView>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith(".cancel")
        ? cancel.promise
        : input.type.endsWith("session.delete")
          ? deletion.promise
          : input.type.endsWith("session.read")
            ? selection.promise
            : original(input),
    );
    const cancelling = f.workspace.cancel();
    const deleting = f.workspace.deleteSession("recent");
    const selecting = f.workspace.selectSession("old");
    cancel.resolve(f.view("recent"));
    deletion.reject(new Error("late failure"));
    await Promise.all([cancelling, deleting]);
    expect(f.workspace.getSnapshot()).toMatchObject({
      loading: true,
      view: null,
      requestFailure: null,
    });
    selection.resolve(f.view("old"));
    await selecting;
    expect(f.workspace.getSnapshot()).toMatchObject({
      loading: false,
      view: { sessionId: "old" },
      requestFailure: null,
    });
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s closing invalidates a pending read and its failure",
  async (kind) => {
    const f = fixture(kind);
    const read = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith("overview") ? read.promise : original(input),
    );
    const opening = f.workspace.open();
    f.workspace.close();
    const closed = f.workspace.getSnapshot();
    read.reject(new Error("closed read"));
    await opening;
    expect(f.workspace.getSnapshot()).toBe(closed);
    expect(f.subscribers.size).toBe(0);
  },
);

test.each(["setting", "revision"] as const)(
  "%s save acknowledges submitted files while preserving edits made during the save",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "submitted" },
    ]);
    const save = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type === "content.replace" ||
      input.type === "world.revision.files.replace"
        ? save.promise
        : original(input),
    );
    const saving = f.workspace.saveFiles();
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "typed during save" },
    ]);
    f.setFiles("submitted");
    save.resolve(
      kind === "setting"
        ? await original({ type: "content.read", packageId: "target" })
        : f.overview(),
    );
    await saving;
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: true,
      loading: false,
      files: [{ contents: "typed during save" }],
      baseline: [{ contents: "submitted" }],
    });
    f.workspace.resetFiles();
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: false,
      files: [{ contents: "submitted" }],
    });
    f.workspace.close();
  },
);

test("world save refuses a changed epoch baseline until the user resets the draft", async () => {
  const f = fixture("revision");
  await f.workspace.open();
  f.workspace.editFiles([{ path: "control/frame.yaml", contents: "unsaved" }]);
  f.setFiles("changed worktree");
  await f.publish();
  await f.workspace.saveFiles();
  expect(f.workspace.getSnapshot().requestFailure).toContain("请重置草稿");
  expect(f.workspace.getSnapshot().files[0]!.contents).toBe("unsaved");
  expect(
    f.request.mock.calls.some(
      ([input]) => input.type === "world.revision.files.replace",
    ),
  ).toBe(false);
  f.workspace.close();
});

test.each(["setting", "revision"] as const)(
  "%s rollback refresh preserves file edits entered while awaiting Runtime",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const rollback = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith(".rollback") ? rollback.promise : original(input),
    );
    const rollingBack = f.workspace.rollbackFile(
      "recent",
      "change",
      "control/frame.yaml",
    );
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "keep my draft" },
    ]);
    f.setFiles("before image");
    rollback.resolve({
      status: "rolled_back",
      changeSetId: "change",
      path: "control/frame.yaml",
      changes: [],
    });
    await rollingBack;
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: true,
      files: [{ contents: "keep my draft" }],
      serverFiles: [{ contents: "before image" }],
    });
    f.workspace.close();
  },
);

test("world browsing creates no epoch; the first edit claims one without losing the draft", async () => {
  const f = fixture("revision");
  const opening = deferred<unknown>();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (input) => {
    if (input.type === "world.revision.overview")
      return { ...f.overview(), epoch: null };
    if (input.type === "world.surface.read")
      return input.surface === "control"
        ? [{ path: "frame.yaml", contents: "saved" }]
        : [];
    if (input.type === "world.revision.open") return opening.promise;
    return original(input);
  });
  await f.workspace.open();
  expect(
    f.request.mock.calls.some(
      ([input]) => input.type === "world.revision.open",
    ),
  ).toBe(false);
  f.workspace.editFiles([
    { path: "control/frame.yaml", contents: "first edit" },
  ]);
  f.workspace.editFiles([
    { path: "control/frame.yaml", contents: "second edit" },
  ]);
  expect(
    f.request.mock.calls.filter(
      ([input]) => input.type === "world.revision.open",
    ),
  ).toHaveLength(1);
  opening.resolve(f.overview());
  await vi.waitFor(() => expect(f.workspace.getSnapshot().loading).toBe(false));
  expect(f.workspace.getSnapshot()).toMatchObject({
    dirty: true,
    files: [{ contents: "second edit" }],
    target: { revision: { epoch: { locked: true } } },
  });
  f.workspace.close();
});

test.each(["apply", "discard"] as const)(
  "world %s completion is ignored after closing and reopening",
  async (action) => {
    const f = fixture("revision");
    await f.workspace.open();
    const command = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type === `world.revision.${action}`
        ? command.promise
        : original(input),
    );
    const finishing = f.workspace.finish(action);
    f.workspace.close();
    await f.workspace.open();
    const reopened = f.workspace.getSnapshot();
    command.resolve(f.overview());
    expect(await finishing).toBeNull();
    expect(f.workspace.getSnapshot()).toBe(reopened);
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s a hydration read started before saving cannot restore the old saved tree",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const hydration = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    const old = f.overview();
    let awaitingHydration = true;
    f.request.mockImplementation(async (input) => {
      if (input.type.endsWith("overview") && awaitingHydration) {
        awaitingHydration = false;
        return hydration.promise;
      }
      if (
        input.type === "content.replace" ||
        input.type === "world.revision.files.replace"
      ) {
        f.setFiles("saved by user");
        return kind === "setting"
          ? original({ type: "content.read", packageId: "target" })
          : f.overview();
      }
      return original(input);
    });
    const hydrating = f.publish();
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "saved by user" },
    ]);
    await f.workspace.saveFiles();
    hydration.resolve(old);
    await hydrating;
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: false,
      files: [{ contents: "saved by user" }],
      serverFiles: [{ contents: "saved by user" }],
    });
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s late hydration and transport failure cannot overwrite a fresh selection",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const subscriber = [...f.subscribers][0]!;
    const read = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith("overview") ? read.promise : original(input),
    );
    const hydrating = f.publish();
    f.workspace.startFresh();
    read.resolve(f.overview());
    await hydrating;
    subscriber.connection?.("failed");
    expect(f.workspace.getSnapshot()).toMatchObject({
      view: null,
      loading: false,
      observationFailure: null,
    });
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s fresh selected history survives deleting another conversation",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    await f.workspace.selectSession("old");
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith("session.delete")
        ? Promise.resolve(f.overview())
        : original(input),
    );
    await f.workspace.deleteSession("recent");
    expect(f.workspace.getSnapshot().view?.sessionId).toBe("old");
    f.workspace.startFresh();
    await f.workspace.deleteSession("old");
    await f.publish();
    expect(f.workspace.getSnapshot().view).toBeNull();
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s late preview failure is ignored after selection changes",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const preview = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type.endsWith(".preview") ? preview.promise : original(input),
    );
    const pending = f.workspace.preview();
    f.workspace.startFresh();
    preview.reject(new Error("old preview"));
    expect(await pending).toBeNull();
    f.workspace.close();
  },
);

test.each(["apply", "discard"] as const)(
  "world %s excludes editing and conversation switching until the command settles",
  async (action) => {
    const f = fixture("revision");
    await f.workspace.open();
    const command = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type === `world.revision.${action}`
        ? command.promise
        : original(input),
    );
    const finishing = f.workspace.finish(action);
    f.workspace.startFresh();
    await f.workspace.selectSession("old");
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "typed while finishing" },
    ]);
    expect(f.workspace.getSnapshot()).toMatchObject({
      applying: true,
      dirty: false,
      view: { sessionId: "recent" },
      files: [{ contents: "saved" }],
    });
    command.resolve(f.overview());
    expect(await finishing).toEqual({ changed: false });
    expect(f.workspace.getSnapshot().applying).toBe(false);
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s saving preserves an edit back to the old baseline, including through hydration",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const saved = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.type === "content.replace" ||
      input.type === "world.revision.files.replace"
        ? saved.promise
        : original(input),
    );
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "submitted" },
    ]);
    const saving = f.workspace.saveFiles();
    f.workspace.editFiles([{ path: "control/frame.yaml", contents: "saved" }]);
    f.setFiles("submitted");
    await f.publish();
    saved.resolve(
      kind === "setting"
        ? await original({ type: "content.read", packageId: "target" })
        : f.overview(),
    );
    await saving;
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: true,
      files: [{ contents: "saved" }],
      baseline: [{ contents: "submitted" }],
      serverFiles: [{ contents: "submitted" }],
    });
    f.workspace.close();
  },
);

test.each(["setting", "revision"] as const)(
  "%s repeated save while awaiting a receipt keeps later edits unsaved",
  async (kind) => {
    const f = fixture(kind);
    await f.workspace.open();
    const first = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    const response = () =>
      kind === "setting"
        ? original({ type: "content.read", packageId: "target" })
        : Promise.resolve(f.overview());
    f.request.mockImplementation((input) => {
      if (
        input.type === "content.replace" ||
        input.type === "world.revision.files.replace"
      ) {
        const contents = input.files[0]!.contents;
        f.setFiles(contents);
        return contents === "first submission" ? first.promise : response();
      }
      return original(input);
    });
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "first submission" },
    ]);
    const saving = f.workspace.saveFiles();
    const firstReceipt = await response();
    f.workspace.editFiles([
      { path: "control/frame.yaml", contents: "later draft" },
    ]);
    const again = f.workspace.saveFiles();
    await Promise.resolve();
    first.resolve(firstReceipt);
    await Promise.all([saving, again]);
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: true,
      files: [{ contents: "later draft" }],
      baseline: [{ contents: "first submission" }],
    });
    await f.workspace.saveFiles();
    expect(f.workspace.getSnapshot()).toMatchObject({
      dirty: false,
      files: [{ contents: "later draft" }],
      baseline: [{ contents: "later draft" }],
    });
    f.workspace.close();
  },
);
