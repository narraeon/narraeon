import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { comparePlayPrompts } from "./lib/compare-play-prompts.mjs";
import {
  packageFiles,
  scenes,
} from "./fixtures/prompt-comparison-350-scenes.mjs";
import { playerInputText } from "../src/shared/turn-guide.ts";

const fixture = (name) =>
  new URL("./fixtures/prompt-comparison-" + name + ".md", import.meta.url);
const providers = ["openai_responses", "chat_completions"];
const rubric = await readFile(fixture("350-rubric"), "utf8");
const protocol = await readFile(fixture("350-protocol"), "utf8");
const args = process.argv.slice(2);
const preflightOnly = args[0] === "--preflight";
if (preflightOnly) args.shift();

function locate(body, predicate) {
  return Object.entries(body).flatMap(([field, value]) => {
    if (typeof value === "string" && predicate(value)) return [{ field }];
    if (!Array.isArray(value)) return [];
    return value.flatMap(({ content, role } = {}, index) =>
      typeof content === "string" && predicate(content)
        ? [{ field, index, role, content }]
        : [],
    );
  });
}

function oneLocation(body, predicate) {
  const positions = locate(body, predicate);
  assert.equal(positions.length, 1);
  return positions[0];
}

function requestPlacement(body, scene, provider, prose) {
  const guideMarker =
    scene.locale === "en" ? "[Runtime turn guide]" : "[Runtime 本轮提示]";
  const player = oneLocation(body, (text) =>
    text.includes(playerInputText(scene.locale, scene.turns[0])),
  );
  const guide = oneLocation(body, (text) => text.includes(guideMarker));
  const narrative = oneLocation(body, (text) => text.includes(prose.trimEnd()));
  const responses = provider === "openai_responses";
  const field = responses ? "input" : "messages";
  assert.equal(player.field, field);
  assert.equal(player.role, "user");
  assert.equal(narrative.field, field);
  assert.equal(narrative.role, responses ? "developer" : "system");
  assert(narrative.index < player.index);
  if (responses) {
    assert.equal(player.index, body[field].length - 1);
    assert.equal(guide.field, "instructions");
  } else {
    assert.equal(guide.field, field);
    assert.equal(guide.index, player.index + 1);
    assert.equal(guide.index, body[field].length - 1);
  }
  return Object.fromEntries(
    Object.entries({ player, guide, narrative }).map(
      ([kind, { field, index, role }]) => [
        kind,
        {
          path: index === undefined ? field : field + "." + index + ".content",
          role,
        },
      ],
    ),
  );
}

function assertOnlyProseChanges(left, right) {
  const field = left.position.narrative.path.split(".")[0];
  const index = Number(left.position.narrative.path.split(".")[1]);
  assert.deepEqual(left.position, right.position);
  assert.equal(left.lines.length, 8);
  assert.deepEqual(left.lines, right.lines);
  assert.deepEqual(
    left.messages.map((message) => message.promptId),
    right.messages.map((message) => message.promptId),
  );
  assert.deepEqual(
    left.messages.filter(({ promptId }) => promptId !== "play.prose"),
    right.messages.filter(({ promptId }) => promptId !== "play.prose"),
  );
  const { prompt_cache_key: leftKey, ...expected } = left.body;
  const { prompt_cache_key: rightKey, ...actual } = right.body;
  if (field === "input") {
    assert.equal(typeof leftKey, "string");
    assert.equal(typeof rightKey, "string");
    assert.notEqual(leftKey, rightKey);
  } else {
    assert.equal(leftKey, rightKey);
  }
  assert.notEqual(expected[field][index].content, actual[field][index].content);
  assert.deepEqual(
    {
      ...expected,
      [field]: expected[field].map((item, i) =>
        i === index ? { ...item, content: actual[field][i].content } : item,
      ),
    },
    actual,
  );
}

async function preflight({ connections, candidates, run }) {
  const firstRequests = {};
  for (const scene of scenes) {
    for (const provider of providers) {
      const pair = [];
      for (const arm of ["baseline", "style"]) {
        await run(
          scene,
          1,
          arm,
          {
            id: "wire",
            connection: connections[provider],
            inspect(body, { bootstrap }) {
              const messages = bootstrap.logicalMessages;
              const prose = messages.filter(
                ({ promptId }) => promptId === "play.prose",
              );
              assert.equal(prose.length, 1);
              const markdown = prose[0].blocks.find(({ markdown }) =>
                markdown?.includes(
                  scene.locale === "en"
                    ? "# Prose texture and pacing"
                    : "# 叙事质感与节奏",
                ),
              )?.markdown;
              assert(markdown);
              if (arm === "style")
                assert.equal(
                  markdown.trimEnd(),
                  candidates[scene.locale].trimEnd(),
                );
              for (const voice of scene.voices)
                oneLocation(body, (text) => text.includes(voice));
              if (scene.stops) {
                assert.match(JSON.stringify(body), /@route-progress/u);
                assert.match(
                  JSON.stringify(body),
                  scene.locale === "en" ? /Current waypoint/u : /当前路标/u,
                );
              }
              const position = requestPlacement(
                body,
                scene,
                provider,
                markdown,
              );
              const request = {
                body,
                position,
                messages,
                lines: bootstrap.turnGuide.lines,
              };
              firstRequests[`${scene.id}:${provider}:${arm}`] = request;
              pair.push(request);
            },
          },
          provider,
        );
      }
      assertOnlyProseChanges(...pair);
    }
  }
  return { firstRequests };
}

function verifyWirePair(scene, left, right, frozen) {
  const samples = [left, right].map(({ provider, arm, turns }) => {
    const first = turns[0]?.wire?.[0];
    const expected = frozen.firstRequests[`${scene.id}:${provider}:${arm}`];
    return {
      arm,
      endpoint: first?.endpoint,
      position: expected.position,
      matchesFrozen: isDeepStrictEqual(first?.body, expected.body),
      matchesPreview:
        first !== undefined &&
        isDeepStrictEqual(first.body, turns[0].exchanges[0]?.preview),
    };
  });
  return {
    ok: samples.every(
      ({ matchesFrozen, matchesPreview }) => matchesFrozen && matchesPreview,
    ),
    samples,
  };
}

await comparePlayPrompts({
  issue: 350,
  scenes,
  packageFiles,
  stylePath: fixture("347-style"),
  matrix: {
    providers,
    modelId: "deepseek-flash",
    enStylePath: fixture("350-style-en"),
    verifyWirePair,
  },
  minRepeats: 2,
  defaults: { repeats: "2", concurrency: "8" },
  preflightOnly,
  args,
  freeze: {
    rubric,
    protocol,
    preflight,
    assertConnection(connection) {
      assert.equal(connection.dialect, "standard");
      if (connection.provider === "openai_responses")
        assert.equal(connection.responsesTurnInstructions, false);
    },
  },
});
