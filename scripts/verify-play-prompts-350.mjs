import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

const [, , sealed, blind, ...options] = process.argv;
const usage =
  "Usage: node scripts/verify-play-prompts-350.mjs <sealed-dir> <blind-dir> [--audit-only | --audit <file> --scores <JSON or TSV file> <locked-sha256> --scores <JSON or TSV file> <locked-sha256>]";
assert(sealed && blind, usage);
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dimensions = ["environment", "voice", "resistance", "agency"];
const usageFields = [
  "inputTokens",
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "outputTokens",
  "totalTokens",
];
const category = new Map(
  Object.entries({
    readState: ["state_list", "context_search", "context_read"],
    readHistory: ["history_list", "history_search", "history_read"],
    writeState: ["world_patch", "world_create", "world_retire"],
    checkpoint: ["world_checkpoint"],
  }).flatMap(([group, names]) => names.map((name) => [name, group])),
);
function scoreRows(text) {
  if (text.trimStart().startsWith("[")) return JSON.parse(text);
  const [header, ...rows] = text.trimEnd().split(/\r?\n/u);
  const keys = ["label", ...dimensions, "evidence"];
  assert.deepEqual(header.split("\t"), ["sample", ...dimensions, "evidence"]);
  return rows.map((row) => {
    const values = row.split("\t");
    assert.equal(values.length, keys.length);
    return Object.fromEntries(
      keys.map((key, index) => [
        key,
        dimensions.includes(key) ? Number(values[index]) : values[index],
      ]),
    );
  });
}

const auditOnly = options.length === 1 && options[0] === "--audit-only";
const judges = [];
let audit;
if (!auditOnly) {
  while (options.length) {
    const command = options.shift();
    const path = options.shift();
    assert(path, usage);
    if (command === "--audit") {
      assert(!audit, usage);
      audit = await read(path);
      continue;
    }
    assert.equal(command, "--scores", usage);
    const sha256 = options.shift();
    assert.match(sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert(!judges.some((judge) => judge.sha256 === sha256));
    const bytes = await readFile(path);
    assert.equal(digest(bytes), sha256, "Scores changed after lock");
    const scores = new Map();
    for (const { label, ...score } of scoreRows(bytes.toString("utf8"))) {
      assert(typeof label === "string" && !scores.has(label));
      assert(
        typeof score.evidence === "string" || Array.isArray(score.evidence),
      );
      for (const field of dimensions) assert([0, 1, 2].includes(score[field]));
      scores.set(label, score);
    }
    judges.push({ sha256, scores });
  }
  assert(judges.length >= 2 && audit, usage);
}

const { arms, connections, repeats, scenes, styleByLocale } = await read(
  join(sealed, "manifest.json"),
);
for (const { markdown, sha256 } of Object.values(styleByLocale))
  assert.equal(digest(markdown), sha256);
const { firstRequests } = await read(join(sealed, "frozen-requests.json"));
const { inputChecks } = await read(join(sealed, "summary.json"));
assert.equal(
  inputChecks.length,
  repeats * scenes.length * Object.keys(connections).length,
);
const inputById = new Map(
  inputChecks.flatMap(({ left, right, samples, ok }) => [
    [left, { ok, ...samples[0] }],
    [right, { ok, ...samples[1] }],
  ]),
);
const planned = scenes.flatMap((scene) =>
  Object.keys(connections).flatMap((provider) =>
    arms.flatMap((arm) =>
      Array.from({ length: repeats }, (_, index) => {
        const repeat = index + 1;
        return {
          scene,
          provider,
          arm,
          repeat,
          id: [scene.id, provider, repeat, arm].join("--"),
        };
      }),
    ),
  ),
);
const directoryRuns = (await readdir(sealed)).filter(
  (name) => name.includes("--") && name.endsWith(".json"),
);
assert.deepEqual(
  directoryRuns.sort(),
  planned.map(({ id }) => id + ".json").sort(),
);
const filesById = new Map();
const samples = [];
const disclosures = new Map();

function docs(snapshot) {
  return new Map(snapshot.state.map(({ path, contents }) => [path, contents]));
}

function stateChanges(before, after) {
  const a = docs(before);
  const b = docs(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .flatMap((path) =>
      a.get(path) === b.get(path)
        ? []
        : [{ path, before: a.get(path) ?? null, after: b.get(path) ?? null }],
    );
}

function wireToolReceipt(turn, callId) {
  for (const { body } of turn.wire) {
    const response = body.input?.find(
      (item) => item.type === "function_call_output" && item.call_id === callId,
    );
    if (response) return response.output;
    const chat = body.messages?.find(
      (item) => item.role === "tool" && item.tool_call_id === callId,
    );
    if (chat) return chat.content;
  }
  return null;
}

function toolTrace(turn) {
  const events = turn.toolEvents ?? [];
  const calls = events.filter(({ kind }) => kind === "tool_call");
  const receipts = events.filter(({ kind }) => kind === "tool_result");
  const projected = turn.exchanges.flatMap(
    ({ response }) => response?.toolCalls ?? [],
  );
  assert.deepEqual(
    calls.map(({ callId }) => callId),
    projected.map(({ id }) => id),
  );
  return calls.map((call, i) => {
    const { id, name, arguments: args } = projected[i];
    const receipt = receipts.find(({ callId }) => id === callId);
    const tool = receipt?.executedName ?? name;
    return {
      id,
      tool,
      category: category.get(tool) ?? "other",
      arguments: args,
      ok: receipt?.ok ?? null,
      receipt: wireToolReceipt(turn, id) ?? receipt?.markdown ?? null,
    };
  });
}

function matchesWaypoint(scene, index, observed) {
  if (!scene.stops) return observed === null;
  if (index < 2) return observed === scene.stops[0];
  if (observed === scene.stops[1]) return true;
  // Provider prose may spell out the same fork-side position in the view.
  return (
    typeof observed === "string" &&
    (scene.locale === "zh-CN"
      ? /^双孔石桥的?近侧桥头$/u.test(observed)
      : /^(?:the )?near bridgehead of (?:the )?twin-arch bridge$/iu.test(
          observed,
        ))
  );
}

function stableRulesChanged(before, after) {
  const pathname = "current-situation.yaml";
  const earlier = docs(before).get(pathname);
  const later = docs(after).get(pathname);
  return !isDeepStrictEqual(
    earlier && parse(earlier).rules,
    later && parse(later).rules,
  );
}

for (const { scene, provider, arm, repeat, id } of planned) {
  const run = await read(join(sealed, id + ".json"));
  filesById.set(id, run);
  assert.deepEqual(
    [run.id, run.sceneId, run.provider, run.arm, run.repeat],
    [id, scene.id, provider, arm, repeat],
  );
  assert.deepEqual(run.turns[0]?.before ?? scene.snapshot, scene.snapshot);
  const expectedFirst = firstRequests[[scene.id, provider, arm].join(":")];
  const first = run.turns[0]?.wire[0];
  const matchesFrozen = isDeepStrictEqual(first?.body, expectedFirst.body);
  assert.equal(matchesFrozen, inputById.get(id).matchesFrozen);
  const turns = run.turns.map((turn, index) => {
    assert.equal(turn.turn, index + 1);
    assert.equal(turn.playerText, scene.turns[index]);
    if (index > 0) assert.deepEqual(turn.before, run.turns[index - 1].after);
    if (turn.finalNarrative != null) {
      assert.equal(turn.after.history.at(-1).exactText, turn.finalNarrative);
      assert.equal(turn.after.history.at(-1).role, "narrator");
    }
    const changes = turn.after ? stateChanges(turn.before, turn.after) : null;
    if (turn.after) assert.deepEqual(changes, turn.changes);
    const expectedWaypoint = scene.stops?.[index < 2 ? 0 : 1] ?? null;
    const authorityWaypoint =
      parse((turn.after && docs(turn.after).get("route.yaml")) || "null")
        ?.waypoint ?? null;
    const viewWaypoint =
      turn.playerViews?.views
        .find(({ id }) => id === "route")
        ?.items.find(({ id }) => id === "waypoint")?.value ?? null;
    const endpoint =
      provider === "openai_responses" ? "/responses" : "/chat/completions";
    for (const wire of turn.wire) {
      assert.equal(wire.endpoint, endpoint);
      assert.equal(wire.body.model, connections[provider].modelBinding.modelId);
      for (const disclosure of wire.responseMetadata?.disclosures ?? []) {
        const { model, model_version, system_fingerprint } = disclosure;
        const identity = { provider, model, model_version, system_fingerprint };
        if (model || model_version || system_fingerprint)
          disclosures.set(JSON.stringify(identity), identity);
      }
    }
    return {
      turn: turn.turn,
      runtimeStatus: turn.runtimeStatus ?? null,
      failureCode: turn.failureCode ?? null,
      narrative: turn.finalNarrative ?? null,
      changes,
      fixedRulesChanged: turn.after
        ? stableRulesChanged(turn.before, turn.after)
        : null,
      expectedWaypoint,
      authorityWaypoint,
      viewWaypoint,
      authorityCorrect: matchesWaypoint(scene, index, authorityWaypoint),
      viewCorrect: matchesWaypoint(scene, index, viewWaypoint),
      viewDiagnostics: turn.playerViews?.diagnostics ?? null,
      tools: toolTrace(turn),
      usage: turn.exchanges.map(({ response }) => response?.usage ?? null),
      stopReasons: turn.exchanges.map(
        ({ response }) => response?.stopReason ?? null,
      ),
      http: turn.wire.map(
        ({
          sentAt,
          status,
          endpoint,
          contentType,
          responseMetadata,
          unreadable,
        }) => ({
          sentAt,
          status,
          endpoint,
          contentType,
          responseMetadata,
          unreadable,
        }),
      ),
    };
  });
  samples.push({
    id,
    topic: scene.topic,
    locale: scene.locale,
    provider,
    arm,
    repeat,
    status: run.status,
    error: run.error,
    position: expectedFirst.position,
    matchesFrozen,
    matchesPreview: inputById.get(id).matchesPreview,
    turns,
  });
}
if (auditOnly) {
  process.stdout.write(JSON.stringify({ samples }, null, 2) + "\n");
  process.exit(0);
}

const mapping = await read(join(sealed, "blind-mapping.json"));
const groups = await read(join(blind, "readings.json"));
assert.equal(mapping.length, planned.length);
assert.equal(groups.length, scenes.length * repeats);
const byLabel = new Map(mapping.map((row) => [row.label, row]));
assert.equal(byLabel.size, planned.length);
const resolvedJudges = judges.map(({ scores }) => {
  assert.deepEqual([...scores.keys()].sort(), [...byLabel.keys()].sort());
  return new Map(
    [...scores].map(([label, score]) => [byLabel.get(label).id, score]),
  );
});
const seen = new Set();
for (const group of groups) {
  const scene = scenes.find(({ title }) => title === group.scene);
  assert(scene);
  assert.deepEqual(group.facts, scene.situation);
  assert.deepEqual(group.playerInputs, scene.turns);
  assert.equal(group.opening, scene.opening);
  assert.equal(
    group.readings.length,
    arms.length * Object.keys(connections).length,
  );
  for (const { label, narrative } of group.readings) {
    const m = byLabel.get(label);
    assert.equal(m.sceneId, scene.id);
    assert.equal(m.repeat, group.repeat);
    assert(!seen.has(m.id));
    seen.add(m.id);
    assert.deepEqual(
      narrative,
      scene.turns.map(
        (_, index) => filesById.get(m.id).turns[index]?.finalNarrative ?? null,
      ),
    );
  }
}
assert.deepEqual([...seen].sort(), planned.map(({ id }) => id).sort());
assert.deepEqual(Object.keys(audit).sort(), [...seen].sort());
for (const sample of samples) {
  sample.scores = resolvedJudges.map((score) => score.get(sample.id));
  assert.equal(audit[sample.id].length, sample.turns.length);
  for (const [index, t] of sample.turns.entries()) {
    const note = audit[sample.id][index];
    assert.equal(note.turn, t.turn);
    assert.deepEqual(
      Object.keys(note.writes).sort(),
      t.tools
        .filter(({ category }) => category === "writeState")
        .map(({ id }) => id)
        .sort(),
    );
    for (const { type, evidence } of Object.values(note.writes)) {
      assert(
        [
          "required",
          "consolidation",
          "unnecessary",
          "no_change",
          "failed",
        ].includes(type),
      );
      assert(evidence);
    }
    if (sample.topic === "travel" && t.turn === 3 && t.narrative != null) {
      assert.equal(typeof note.arrived, "boolean");
      t.binding = {
        arrived: note.arrived,
        authorityCorrect: t.authorityCorrect,
        viewCorrect: t.viewCorrect,
        verbatim:
          t.authorityWaypoint === t.expectedWaypoint &&
          t.viewWaypoint === t.expectedWaypoint,
        complete: note.arrived && t.authorityCorrect && t.viewCorrect,
      };
    }
    assert(Array.isArray(note.unauthorized));
    assert(Array.isArray(note.contradictions));
    t.audit = note;
  }
}

function usageTotals(rows) {
  return Object.fromEntries(
    usageFields.map((field) => {
      const reported = rows.flatMap((row) =>
        Number.isFinite(row?.[field]) ? [row[field]] : [],
      );
      return [
        field,
        {
          sum: reported.length ? reported.reduce((a, b) => a + b, 0) : null,
          reported: reported.length,
          exchanges: rows.length,
        },
      ];
    }),
  );
}

function summarize(entries) {
  const turns = entries.flatMap(({ turns }) => turns);
  const usages = turns.flatMap(({ usage }) => usage);
  const tools = turns.flatMap(({ tools }) => tools);
  const writes = turns.flatMap(({ audit }) => Object.values(audit.writes));
  const scores = judges.map((_, i) =>
    Object.fromEntries(
      dimensions.map((field) => [
        field,
        entries.reduce((sum, sample) => sum + sample.scores[i][field], 0),
      ]),
    ),
  );
  return {
    planned: entries.length,
    completed: entries.filter(({ status }) => status === "complete").length,
    committedTurns: turns.filter(({ narrative }) => narrative != null).length,
    scores,
    bindings: turns.flatMap(({ binding }) => (binding ? [binding] : [])),
    delayedBindingRepairs: entries.filter(
      ({ turns }) =>
        turns[2]?.binding?.arrived &&
        !turns[2].binding.complete &&
        turns[3]?.authorityCorrect &&
        turns[3]?.viewCorrect,
    ).length,
    agencyTurns: turns.filter(({ audit }) => audit.unauthorized.length).length,
    contradictionTurns: turns.filter(({ audit }) => audit.contradictions.length)
      .length,
    fixedRuleChanges: turns.filter(({ fixedRulesChanged }) => fixedRulesChanged)
      .length,
    withStateChanges: turns.filter(({ changes }) => changes?.length).length,
    writeTools: Object.fromEntries(
      ["required", "consolidation", "unnecessary", "no_change", "failed"].map(
        (type) => [type, writes.filter((write) => write.type === type).length],
      ),
    ),
    tools: Object.fromEntries(
      [...new Set([...category.values(), "other"])].map((kind) => {
        const matching = tools.filter(({ category }) => category === kind);
        return [
          kind,
          {
            attempted: matching.length,
            succeeded: matching.filter(({ ok }) => ok === true).length,
            failed: matching.filter(({ ok }) => ok === false).length,
          },
        ];
      }),
    ),
    first: usageTotals(entries.map(({ turns }) => turns[0]?.usage[0])),
    subsequent: usageTotals(
      entries.flatMap(({ turns }) =>
        turns.flatMap(({ usage }, i) => (i === 0 ? usage.slice(1) : usage)),
      ),
    ),
    usage: usageTotals(usages),
    firstRequestControlsPassed: entries.filter(
      ({ matchesFrozen, matchesPreview }) => matchesFrozen && matchesPreview,
    ).length,
    majorAgencyTurns: turns.filter(({ audit }) =>
      audit.unauthorized.some(({ severity }) => severity === "major"),
    ).length,
    httpAttempts: turns.flatMap(({ http }) => http).length,
    httpFailures: turns.flatMap(({ http }) =>
      http.filter(
        ({ status }) => status === null || status < 200 || status >= 300,
      ),
    ).length,
  };
}

const strata = new Map();
for (const sample of samples) {
  for (const fields of [
    ["arm"],
    ["locale", "arm"],
    ["topic", "arm"],
    ["provider", "arm"],
    ["locale", "topic", "provider", "arm"],
  ]) {
    const key = fields.map((field) => sample[field]).join("/");
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(sample);
  }
}
const timestamps = samples
  .flatMap(({ turns }) =>
    turns.flatMap(({ http }) => http.map(({ sentAt }) => sentAt)),
  )
  .sort();
const report = {
  sentAt: { first: timestamps[0], last: timestamps.at(-1) },
  disclosures: [...disclosures.values()],
  judges: judges.map(({ sha256 }) => sha256),
  exactAgreement: samples.reduce(
    (sum, { scores }) =>
      sum +
      dimensions.filter((field) =>
        scores.every((score) => score[field] === scores[0][field]),
      ).length,
    0,
  ),
  scoredDimensions: samples.length * dimensions.length,
  strata: Object.fromEntries(
    [...strata].map(([key, entries]) => [key, summarize(entries)]),
  ),
  samples,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
