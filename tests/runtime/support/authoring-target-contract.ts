import { expect, test } from "vitest";
import type {
  ModelHostExchange,
  ScriptedModelHostStep,
} from "../../../src/runtime/model/ModelHost.ts";

interface View {
  sessionId: string;
  runStatus: string;
  canRetry?: boolean;
  messages: { id: string; text: string }[];
}
interface Fixture {
  send(): Promise<View>;
  sendNext(id: string): Promise<View>;
  delete(id: string): Promise<unknown>;
  status(
    id: string,
  ): Promise<{ runStatus: string; progress: { streaming: unknown } } | null>;
  preview(id: string): Promise<unknown>;
  previews(id: string): Promise<unknown>;
  callContext(id: string, callId: string): Promise<unknown>;
  read(id: string): Promise<View>;
  resume(id: string): Promise<View>;
  edit(id: string, messageId: string): Promise<View>;
  activeId(): Promise<string>;
  cancel(id: string): Promise<unknown>;
  manualChange(): Promise<void>;
  files(): Promise<unknown>;
  requests: ModelHostExchange[];
  started: Promise<void>;
  release(): void;
}
type Factory = (
  steps: (write: ScriptedModelHostStep) => ScriptedModelHostStep[],
  delay?: boolean,
) => Promise<Fixture>;

/** The same observable contract runs against both real target publication adapters. */
export function authoringTargetContract(name: string, create: Factory): void {
  test(`${name}: retries a frozen request without duplicating its message`, async () => {
    const f = await create(() => [
      { outcome: "failure", message: "disconnected" },
      { outcome: "response", text: "Finished." },
    ]);
    const interrupted = await f.send();
    expect(interrupted.canRetry).toBe(true);
    const resumed = await f.resume(interrupted.sessionId);
    expect(resumed.messages.map(({ text }) => text)).toEqual([
      "Change.",
      "Finished.",
    ]);
    expect(f.requests[1]).toEqual({ ...f.requests[0], requestAttempt: 2 });
  });
  test.each([
    [
      "duplicate tool IDs",
      {
        outcome: "response",
        toolCalls: [
          { id: "duplicate", name: "read", arguments: {} },
          { id: "duplicate", name: "read", arguments: {} },
        ],
      },
    ],
    [
      "missing continuation",
      { outcome: "response", continuation: "lost", text: "Incomplete." },
    ],
  ] satisfies [string, ScriptedModelHostStep][])(
    `${name}: reports %s to the model without another user message or file change`,
    async (_label, step) => {
      const f = await create(() => [
        step,
        { outcome: "response", text: "Corrected." },
      ]);
      const files = await f.files();
      const result = await f.send();
      expect(result.runStatus).toBe("ready");
      expect(result.messages.map(({ text }) => text)).toEqual([
        "Change.",
        "Corrected.",
      ]);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.appended.at(-1)).toMatchObject({
        kind: "runtime_notice",
        notice: "response_correction",
      });
      expect(await f.files()).toEqual(files);
      expect((await f.read(result.sessionId)).runStatus).toBe("ready");
    },
  );
  test(`${name}: stops after an unsuccessful correction and can resend`, async () => {
    const invalid: ScriptedModelHostStep = {
      outcome: "response",
      toolCalls: [{ id: "", name: "read", arguments: {} }],
    };
    const f = await create(() => [
      invalid,
      invalid,
      { outcome: "response", text: "Recovered." },
    ]);
    const view = await f.send();
    expect(view).toMatchObject({ runStatus: "interrupted", canRetry: true });
    expect(f.requests).toHaveLength(2);
    expect(
      (await f.resume(view.sessionId)).messages.map(({ text }) => text),
    ).toEqual(["Change.", "Recovered."]);
  });
  test(`${name}: cancellation ignores a late response and retains retry`, async () => {
    const f = await create(
      (write) => [write, { outcome: "response", text: "Finished." }],
      true,
    );
    const files = await f.files();
    const running = f.send();
    await f.started;
    const id = await f.activeId();
    const cancelling = f.cancel(id);
    f.release();
    const interrupted = await running;
    await cancelling;
    expect(interrupted.canRetry).toBe(true);
    expect(await f.files()).toEqual(files);
    const resumed = await f.resume(interrupted.sessionId);
    expect(resumed.messages.map(({ text }) => text)).toEqual([
      "Change.",
      "Finished.",
    ]);
    expect(await f.files()).toEqual(files);
  });
  test(`${name}: observes one in-flight send and rejects actions on a deleted conversation`, async () => {
    const f = await create(
      () => [{ outcome: "response", text: "Finished." }],
      true,
    );
    const running = f.send();
    await f.started;
    try {
      const id = await f.activeId();
      const status = await f.status(id);
      expect(status?.runStatus).toBe("running");
      expect(status?.progress.streaming).toBeTypeOf("object");
      expect(status?.progress.streaming).not.toBeNull();
      await expect(f.sendNext(id)).rejects.toThrow(/still running/iu);
      await expect(f.delete(id)).rejects.toThrow(/cannot be deleted/iu);
      await expect(f.preview(id)).resolves.toBeDefined();
      await expect(f.previews(id)).resolves.toBeDefined();
      const duplicate = f.send();
      f.release();
      const [result, repeated] = await Promise.all([running, duplicate]);
      expect(repeated).toEqual(result);
      expect(f.requests).toHaveLength(1);
      const before = await f.files();
      await f.delete(id);
      await expect(f.read(id)).rejects.toThrow();
      await expect(f.sendNext(id)).rejects.toThrow();
      await expect(f.resume(id)).rejects.toThrow();
      await expect(f.edit(id, result.messages[0]!.id)).rejects.toThrow();
      await expect(f.cancel(id)).rejects.toThrow();
      await expect(f.preview(id)).rejects.toThrow();
      await expect(f.previews(id)).rejects.toThrow();
      await expect(f.callContext(id, "missing-call")).rejects.toThrow();
      expect(f.requests).toHaveLength(1);
      expect(await f.files()).toEqual(before);
    } finally {
      f.release();
      await running;
    }
  });
  test(`${name}: edit reverts once and deduplicates its request`, async () => {
    const f = await create((write) => [
      write,
      { outcome: "response", text: "Changed." },
      { outcome: "response", text: "Edited." },
    ]);
    const initialFiles = await f.files();
    const first = await f.send();
    expect(await f.files()).not.toEqual(initialFiles);
    const edited = await f.edit(first.sessionId, first.messages[0]!.id);
    const files = await f.files();
    expect(files).toEqual(initialFiles);
    expect(edited.messages.map(({ text }) => text)).toEqual([
      "Discuss.",
      "Edited.",
    ]);
    expect(await f.edit(first.sessionId, first.messages[0]!.id)).toEqual(
      edited,
    );
    expect(await f.files()).toEqual(files);
    expect(f.requests).toHaveLength(3);
  });
  test(`${name}: edit refuses to overwrite a later file change`, async () => {
    const f = await create((write) => [
      write,
      { outcome: "response", text: "Changed." },
    ]);
    const first = await f.send();
    await f.manualChange();
    const files = await f.files();
    await expect(
      f.edit(first.sessionId, first.messages[0]!.id),
    ).rejects.toThrow(/changed/iu);
    expect(await f.files()).toEqual(files);
    expect((await f.read(first.sessionId)).messages).toEqual(first.messages);
  });
}
