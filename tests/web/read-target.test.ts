import { expect, test, vi } from "vitest";
import { ReadTarget } from "../../src/web/ReadTarget.ts";

test("overlapping faults read again after an older read and never replay a command", async () => {
  const first = Promise.withResolvers<string>();
  const latest = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  const apply = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: vi.fn() });
  const opening = target.read();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  const recoveries = [target.recover(), target.recover()];
  first.resolve("before the writes");
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  latest.resolve("both writes committed");
  await Promise.all([opening, ...recoveries]);
  expect(apply.mock.calls.at(-1)).toEqual(["both writes committed"]);
  expect(load).toHaveBeenCalledTimes(2);
});

test("an ordinary read gets one recovery; manual recovery never retries itself", async () => {
  const offline = new Error("offline");
  const load = vi.fn<() => Promise<string>>().mockRejectedValue(offline);
  const sync = vi.fn();
  const target = new ReadTarget({ load, apply: vi.fn(), onSyncFailure: sync });
  expect(await target.read()).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
  expect(sync).toHaveBeenLastCalledWith(true, offline);
  load.mockResolvedValue("back online");
  expect(await target.recover()).toBe("back online");
  expect(load).toHaveBeenCalledTimes(3);
  expect(sync).toHaveBeenLastCalledWith(false);
});

test.each(["success", "failure"])(
  "a late %s cannot replace or obscure a newer observation",
  async (outcome) => {
    const pending = Promise.withResolvers<string>();
    const apply = vi.fn();
    const sync = vi.fn();
    const target = new ReadTarget({
      load: () => pending.promise,
      apply,
      onSyncFailure: sync,
    });
    const read = target.read();
    await Promise.resolve();
    target.accept();
    if (outcome === "success") pending.resolve("old world");
    else pending.reject(new Error("old connection"));
    expect(await read).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(sync.mock.calls).toEqual([[false]]);
  },
);

test("a successful pre-fault read does not confirm a failed trailing recovery", async () => {
  const pending = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const target = new ReadTarget({
    load,
    apply: vi.fn(),
    onSyncFailure: vi.fn(),
  });
  const old = target.read();
  await Promise.resolve();
  const recovery = target.recover();
  pending.resolve("old world");
  expect(await recovery).toBeNull();
  await old;
});

test("disposal discards callbacks and leaves a newly activated target's recovery intact", async () => {
  const old = Promise.withResolvers<string>();
  const current = Promise.withResolvers<string>();
  const trailing = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
    .mockReturnValueOnce(trailing.promise);
  const apply = vi.fn();
  const sync = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: sync });
  const abandoned = target.read();
  await Promise.resolve();
  target.dispose();
  target.activate();
  const active = target.read();
  await Promise.resolve();
  const recovery = target.recover();
  old.reject(new Error("old page"));
  await abandoned;
  current.resolve("before new fault");
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  trailing.resolve("current world");
  await Promise.all([active, recovery]);
  expect(apply.mock.calls).toEqual([["before new fault"], ["current world"]]);
  expect(sync.mock.calls).toEqual([[false], [false]]);
});

test("retargeting starts a new read without sharing the previous scope or its recovery", async () => {
  const pending = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce("new scope");
  const apply = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: vi.fn() });
  const oldRead = target.read();
  await Promise.resolve();
  const oldRecovery = target.recover();

  target.retarget();
  expect(await target.read()).toBe("new scope");
  pending.resolve("old scope");
  expect(await Promise.all([oldRead, oldRecovery])).toEqual([null, null]);
  expect(apply.mock.calls).toEqual([["new scope"]]);
  expect(load).toHaveBeenCalledTimes(2);

  target.dispose();
  target.retarget();
  expect(await target.read()).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

test("concurrent command failures recover the target while each write is sent only once", async () => {
  const pending = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue("both commits");
  const apply = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: vi.fn() });
  const firstSend = vi.fn().mockRejectedValue(new Error("lost first receipt"));
  const secondSend = vi
    .fn()
    .mockRejectedValue(new Error("lost second receipt"));
  const first = target.command(firstSend).catch(() => undefined);
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  const second = target.command(secondSend).catch(() => undefined);
  await Promise.resolve();
  pending.resolve("first commit");
  await Promise.all([first, second]);
  expect(firstSend).toHaveBeenCalledOnce();
  expect(secondSend).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenLastCalledWith("both commits");
  expect(load).toHaveBeenCalledTimes(2);
});

test("a partial receipt cannot discard a full read required by an earlier failed command", async () => {
  const older = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(older.promise)
    .mockResolvedValue("both packages");
  const apply = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: vi.fn() });
  const recovery = target.recover();
  await Promise.resolve();
  target.accept({ complete: false });
  older.resolve("only the failed command's package");
  expect(await recovery).toBe("both packages");
  expect(apply.mock.calls).toEqual([["both packages"]]);
});

test("a postreceipt read waits for fresh data even when an ordinary read was already in flight", async () => {
  const before = Promise.withResolvers<string>();
  const load = vi
    .fn()
    .mockReturnValueOnce(before.promise)
    .mockResolvedValue("after receipt");
  const apply = vi.fn();
  const target = new ReadTarget({ load, apply, onSyncFailure: vi.fn() });
  const opening = target.read();
  await Promise.resolve();
  target.accept({ complete: false });
  const postreceipt = target.read();
  before.resolve("before receipt");
  expect(await postreceipt).toBe("after receipt");
  expect(apply.mock.calls).toEqual([["after receipt"]]);
  await opening;
});

test("a fault arriving as a read settles still gets a new read", async () => {
  const fault = Promise.withResolvers<void>();
  const load = vi
    .fn()
    .mockResolvedValueOnce("before fault")
    .mockResolvedValue("after fault");
  let recovery: Promise<string | null> | undefined;
  const target = new ReadTarget({
    load,
    apply: (value: string) => {
      if (value === "before fault")
        void Promise.resolve().then(() => {
          recovery = target.recover();
          fault.resolve();
        });
    },
    onSyncFailure: vi.fn(),
  });
  await target.read();
  await fault.promise;
  expect(await recovery).toBe("after fault");
  expect(load).toHaveBeenCalledTimes(2);
});
