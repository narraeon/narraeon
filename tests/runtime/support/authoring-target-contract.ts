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
    expect(f.requests[1]).toEqual(f.requests[0]);
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
    `${name}: %s cannot be replayed`,
    async (_label, step) => {
      const f = await create(() => [step]);
      const result = await f.send();
      expect(result.runStatus).toBe("interrupted");
      expect(result.canRetry).toBe(false);
    },
  );
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
