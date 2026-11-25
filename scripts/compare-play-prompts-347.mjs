import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { comparePlayPrompts } from "./lib/compare-play-prompts.mjs";
import {
  packageFiles,
  scenes,
} from "./fixtures/prompt-comparison-347-scenes.mjs";

const removedTailLines = [
  "play.person-second",
  "play.stop-beat",
  "play.output",
];
const rubric = await readFile(
  new URL("./fixtures/prompt-comparison-347-rubric.md", import.meta.url),
  "utf8",
);
const protocol = await readFile(
  new URL("./fixtures/prompt-comparison-347-protocol.md", import.meta.url),
  "utf8",
);
const args = process.argv.slice(2);
const preflightOnly = args[0] === "--preflight";
if (preflightOnly) args.shift();

function stringPaths(value, needle, path = []) {
  if (typeof value === "string")
    return value.includes(needle) ? [path.join(".")] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    stringPaths(child, needle, [...path, key]),
  );
}

function requestPlacement(body, scene) {
  const player = stringPaths(
    body,
    `<本轮玩家输入>\n${scene.turns[0]}\n</本轮玩家输入>`,
  );
  const guide = stringPaths(body, "[Runtime 本轮提示]");
  assert.equal(player.length, 1);
  assert.equal(guide.length, 1);
  return { player: player[0], guide: guide[0] };
}

function changedKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .sort();
}

async function preflight({ connection, scenes, arms, run }) {
  const first = new Map();
  const positions = [];
  for (const scene of scenes) {
    for (const arm of arms) {
      await run(scene, 1, arm, {
        id: "active",
        connection,
        inspect(body, request) {
          const position = requestPlacement(body, scene);
          assert.equal(position.guide, "instructions");
          assert.match(position.player, /^input\.\d+\.content$/u);
          assert.equal(
            Number(position.player.split(".")[1]),
            body.input.length - 1,
          );
          assert.doesNotMatch(JSON.stringify(body), /玩家本轮要求：/u);
          const voices = request.bootstrap.logicalMessages.find(({ blocks }) =>
            blocks.some(({ source }) => source === "world:control/voices.md"),
          );
          assert(voices);
          for (const voice of scene.voices) {
            assert(voices.markdown.includes(voice));
            assert.equal(stringPaths(body, voice).length, 1);
          }
          for (const initial of [
            ...Object.values(scene.fixed),
            ...Object.values(scene.facts),
          ]) {
            assert.equal(stringPaths(body, initial).length, 1);
          }
          assert.match(JSON.stringify(body), /@object-custody/u);
          assert.match(JSON.stringify(body), /保管位置/u);
          first.set(`${scene.id}:${arm}`, {
            body,
            position,
            lines: request.bootstrap.turnGuide.lines,
            messages: request.bootstrap.logicalMessages,
          });
        },
      });
    }
    const baseline = first.get(`${scene.id}:baseline`);
    const tail = first.get(`${scene.id}:short-tail`);
    const style = first.get(`${scene.id}:style`);
    assert.equal(baseline.lines.length, 8);
    assert.deepEqual(
      tail.lines,
      baseline.lines.filter(
        ({ source }) =>
          !removedTailLines.some((id) => source === `preset:builtin/${id}`),
      ),
    );
    assert.equal(tail.lines.length, 5);
    assert.deepEqual(style.lines, baseline.lines);
    assert.deepEqual(changedKeys(baseline.body, tail.body), ["instructions"]);
    assert.deepEqual(changedKeys(baseline.body, style.body), [
      "input",
      "prompt_cache_key",
    ]);
    assert.deepEqual(
      changedKeys(baseline.body.input, style.body.input).length,
      1,
    );
    assert.deepEqual(
      changedKeys(baseline.messages, style.messages).map((key) => [
        baseline.messages[key].promptId,
        style.messages[key].promptId,
      ]),
      [["play.prose", "play.prose"]],
    );
  }

  const fake = {
    baseUrl: "https://offline.example/v1",
    apiKey: "offline-probe",
    modelId: "offline-probe",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
  };
  const protocols = [
    {
      id: "openai_responses_opt_in",
      provider: "openai_responses",
      responsesTurnInstructions: true,
    },
    { id: "chat_completions", provider: "chat_completions" },
    { id: "anthropic_messages", provider: "anthropic_messages" },
    { id: "google_interactions", provider: "google_interactions" },
  ];
  const [scene] = scenes;
  for (const { id, ...settings } of protocols) {
    await run(scene, 1, "baseline", {
      id,
      connection: { ...fake, ...settings },
      inspect(body) {
        const position = requestPlacement(body, scene);
        if (id === "openai_responses_opt_in") {
          assert.equal(position.guide, "instructions");
          assert.equal(
            Number(position.player.split(".")[1]),
            body.input.length - 1,
          );
        } else {
          const [field, playerIndex] = position.player.split(".");
          const [guideField, guideIndex] = position.guide.split(".");
          assert.equal(guideField, field);
          assert.equal(Number(guideIndex), Number(playerIndex) + 1);
          assert.equal(Number(guideIndex), body[field].length - 1);
        }
        positions.push({ protocol: id, ...position });
      },
    });
  }
  return { positionProbe: positions, firstRequests: Object.fromEntries(first) };
}

await comparePlayPrompts({
  issue: 347,
  scenes,
  packageFiles,
  stylePath: new URL(
    "./fixtures/prompt-comparison-347-style.md",
    import.meta.url,
  ),
  minRepeats: 4,
  defaults: { repeats: "4", concurrency: "6" },
  removedTailLines,
  preflightOnly,
  args,
  freeze: {
    rubric,
    protocol,
    preflight,
    assertConnection(connection) {
      assert.equal(connection.dialect, "standard");
      assert.equal(connection.responsesTurnInstructions, false);
    },
  },
});
