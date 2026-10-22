import { expect, test } from "vitest";

import {
  cloneSharingPromptRuns,
  playPromptRunsThroughEvents,
  promptRunStrings,
  sharePromptRun,
  type PlayPromptRun,
} from "../../src/runtime/play/PlayPromptRun.ts";

function run(firstEventId: number): PlayPromptRun {
  return {
    schemaVersion: 1,
    firstEventId,
    head: `commit:${firstEventId}`,
    exchange: firstEventId,
    playPreset: { id: "preset", name: "Preset", revision: "rev-1" },
    bootstrap: {
      logicalMessages: [
        {
          role: "runtime_system",
          blocks: [{ source: "runtime:play", markdown: "规则".repeat(200) }],
        },
      ],
    } as unknown as PlayPromptRun["bootstrap"],
    tools: [],
    followups: [],
    playPresetScriptsEnabled: false,
    presetFiles: { "preset.md": "预设".repeat(200) },
  };
}

test("共享后的 prompt run 被深度冻结，原地修改会抛错", () => {
  const shared = sharePromptRun(run(1), promptRunStrings(undefined));
  expect(Object.isFrozen(shared)).toBe(true);
  expect(Object.isFrozen(shared.bootstrap)).toBe(true);
  expect(Object.isFrozen(shared.presetFiles)).toBe(true);
  expect(() => {
    shared.presetFiles["preset.md"] = "changed";
  }).toThrow(TypeError);
});

test("上下文副本共享冻结的 prompt run，其余部分仍是独立深拷贝", () => {
  const first = sharePromptRun(run(1), promptRunStrings(undefined));
  const second = sharePromptRun(run(3), promptRunStrings(first));
  const context = {
    promptRuns: [first, second],
    events: [{ id: 1 }, { id: 3 }],
  };
  const copy = cloneSharingPromptRuns(context);
  expect(copy.promptRuns).not.toBe(context.promptRuns);
  expect(copy.promptRuns[0]).toBe(first);
  expect(copy.promptRuns[1]).toBe(second);
  expect(copy.events).not.toBe(context.events);
  copy.events.push({ id: 4 });
  expect(context.events).toHaveLength(2);
  expect(playPromptRunsThroughEvents(context, [{ id: 2 }] as never[])).toEqual([
    first,
  ]);
  expect(playPromptRunsThroughEvents(context, [{ id: 3 }] as never[])[1]).toBe(
    second,
  );
});
