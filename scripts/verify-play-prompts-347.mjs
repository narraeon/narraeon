import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

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
const categories = {
  readState: ["state_list", "context_search", "context_read"],
  readHistory: ["history_list", "history_search", "history_read"],
  writeState: ["world_patch", "world_create", "world_retire"],
  checkpoint: ["world_checkpoint"],
};
const [, , sealed, blind, ...options] = process.argv;
const usage =
  "Usage: node scripts/verify-play-prompts-347.mjs <sealed-dir> <blind-dir> --scores <file.json|file.tsv> <locked-sha256> [--scores <file> <locked-sha256>] [--audit <authority-audit.json>]";
assert(sealed && blind, usage);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const codes = (value) => [...value].length;
const judges = [];
let audit = null;
while (options.length) {
  const command = options.shift();
  const path = options.shift();
  assert(path, usage);
  if (command === "--audit") {
    assert.equal(audit, null);
    audit = await read(path);
  } else {
    assert.equal(command, "--scores", usage);
    const sha256 = options.shift();
    assert.match(sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert(!judges.some((judge) => judge.sha256 === sha256));
    const bytes = await readFile(path);
    assert.equal(digest(bytes), sha256, "Scores changed after lock");
    judges.push({ sha256, scores: parseScores(bytes.toString("utf8")) });
  }
}
assert(judges.length, usage);
const { arms, repeats, scenes } = await read(join(sealed, "manifest.json"));
const frozen = await read(join(sealed, "frozen-requests.json"));
const mapping = await read(join(sealed, "blind-mapping.json"));
const readings = await read(join(blind, "readings.json"));
const runNames = (await readdir(sealed)).filter((name) => name.includes("--"));
assert.equal(runNames.length, arms.length * repeats * scenes.length);
assert.equal(mapping.length, runNames.length);
assert.equal(readings.length, repeats * scenes.length);
const matchedLabels = new Set();
const matchedRunIds = new Set();
const modelVersions = new Set();
const firstUsage = {};
const samples = [];
let requestConstants;

function parseScores(text) {
  let entries;
  if (text.trimStart().startsWith("[")) {
    entries = JSON.parse(text);
  } else {
    const [header, ...rows] = text.trimEnd().split(/\r?\n/u);
    const keys = ["label", ...dimensions, "evidence"];
    assert.deepEqual(header.split("\t"), ["sample", ...dimensions, "evidence"]);
    entries = rows.map((row) => {
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
  const scores = new Map();
  for (const { label, ...row } of entries) {
    assert(typeof label === "string" && !scores.has(label));
    for (const dimension of dimensions)
      assert([0, 1, 2].includes(row[dimension]));
    scores.set(label, row);
  }
  return scores;
}

function docs(snapshot) {
  return Object.fromEntries(
    snapshot.state.map(({ path, contents }) => [path, contents]),
  );
}

function matchesNegative(expected, observed) {
  return typeof observed === "string" && observed.includes(expected);
}

function toolCategory(name) {
  return (
    Object.entries(categories).find(([, names]) => names.includes(name))?.[0] ??
    "other"
  );
}

function toolTrace(turn) {
  const calls = turn.exchanges.flatMap(
    ({ response }) => response.toolCalls ?? [],
  );
  const projectedCalls = turn.toolEvents.filter(
    ({ kind }) => kind === "tool_call",
  );
  const receipts = turn.toolEvents.filter(({ kind }) => kind === "tool_result");
  assert.deepEqual(
    projectedCalls.map(({ callId }) => callId),
    calls.map(({ id }) => id),
  );
  assert.equal(receipts.length, calls.length);
  const resultsById = new Map(receipts.map((event) => [event.callId, event]));
  return calls.map(({ id, name, arguments: args }) => {
    const result = resultsById.get(id);
    assert(result);
    const tool = result.executedName ?? name;
    const response = turn.wire
      .flatMap(({ body }) => body.input)
      .find(
        (item) => item.type === "function_call_output" && item.call_id === id,
      );
    return {
      id,
      tool,
      category: toolCategory(tool),
      target: args?.target ?? args?.ref ?? args?.path ?? null,
      arguments: args,
      ok: result.ok,
      receipt: response?.output ?? result.markdown,
    };
  });
}

function observeState(turn, scene) {
  const state = docs(turn.after);
  const situation = parse(state["current-situation.yaml"]);
  const holder = parse(state["object.yaml"])["保管位置"];
  const { views, diagnostics } = turn.playerViews;
  const view =
    views
      .find(({ id }) => id === "object")
      ?.items.find(({ id }) => id === "custody")?.value ?? null;
  const expectedHolder = turn.turn < 3 ? scene.holder : scene.destination;
  const isExpected = (value) =>
    typeof value === "string" &&
    (turn.turn < 3 ? value === expectedHolder : value.includes(expectedHolder));
  const previousSituation = parse(docs(turn.before)["current-situation.yaml"]);
  const fixedFieldsChanged = Object.entries(scene.fixed).flatMap(
    ([key, expected]) => (situation.固定条件?.[key] === expected ? [] : [key]),
  );
  const negativesChanged = scene.negativeFields.filter(
    (key) => !matchesNegative(scene.facts[key], situation.情境?.[key]),
  );
  return {
    holder,
    view,
    viewDiagnostics: diagnostics,
    expectedHolder,
    authorityHolderCorrect: isExpected(holder),
    playerViewCorrect: isExpected(view),
    originalCustodyPresent: state["current-situation.yaml"].includes(
      scene.facts.当前保管,
    ),
    situationChanged: !isDeepStrictEqual(previousSituation, situation),
    fixedFieldsChanged,
    negativesChanged,
  };
}

function inspectExchanges(run, turn) {
  assert(
    turn.exchanges.length > 0 && turn.wire.length >= turn.exchanges.length,
  );
  let wireIndex = 0;
  const result = turn.exchanges.map((exchange, index) => {
    const attempts = [];
    let request;
    do {
      request = turn.wire[wireIndex++];
      assert(request);
      attempts.push(request.status);
      assert.deepEqual(request.body, exchange.preview);
    } while (request.status === 429);
    assert.equal(request.status, 200);
    const { input, instructions, prompt_cache_key, ...constants } =
      request.body;
    void instructions;
    void prompt_cache_key;
    assert(Array.isArray(input));
    requestConstants ??= constants;
    assert.deepEqual(requestConstants, constants);
    const ended = request.responseEvents.filter(
      ({ type }) => type === "response.completed",
    );
    assert.equal(ended.length, 1);
    const {
      model,
      model_version,
      system_fingerprint,
      usage: reported,
    } = ended[0].response;
    modelVersions.add(
      JSON.stringify({
        model,
        modelVersion: model_version ?? null,
        systemFingerprint: system_fingerprint ?? null,
      }),
    );
    const usage = exchange.response.usage;
    assert.equal(usage.inputTokens, reported.input_tokens);
    assert.equal(usage.outputTokens, reported.output_tokens);
    assert.equal(usage.totalTokens, reported.total_tokens);

    if (turn.turn === 1 && index === 0) {
      const key = `${run.sceneId}:${run.arm}`;
      assert.deepEqual(request.body, frozen.firstRequests[key].body);
      const preload = input.find(
        ({ type, call_id }) =>
          type === "function_call_output" &&
          call_id === "runtime_initial_world_context",
      );
      assert(
        preload?.output.includes(
          '物品 · 保管位置 → @object-custody#yaml:["保管位置"]',
        ),
      );
      firstUsage[key] ??= [];
      firstUsage[key].push({
        repeat: run.repeat,
        requestSize: exchange.previewSize,
        instructionsSize: exchange.instructionsSize,
        ...usage,
      });
    }
    return { attempts, usage };
  });
  assert.equal(wireIndex, turn.wire.length);
  return result;
}

for (const group of readings) {
  const scene = scenes.find(({ title }) => title === group.scene);
  assert(scene);
  assert.deepEqual(
    [group.opening, group.facts, group.playerInputs],
    [scene.opening, scene.situation, scene.turns],
  );
  assert.equal(group.readings.length, arms.length);
  const groupArms = new Set();
  for (const { label, narrative } of group.readings) {
    assert(!matchedLabels.has(label));
    matchedLabels.add(label);
    const scoreRows = judges.map(({ scores }) => scores.get(label));
    assert(scoreRows.every(Boolean));
    const entry = mapping.find((sample) => sample.label === label);
    assert(entry);
    const { id } = entry;
    assert(!matchedRunIds.has(id));
    matchedRunIds.add(id);
    assert(runNames.includes(id + ".json"));
    const run = await read(join(sealed, id + ".json"));
    assert.equal(run.id, id);
    assert.equal(run.status, "complete");
    assert.equal(run.sceneId, scene.id);
    assert.equal(run.repeat, group.repeat);
    assert.equal(run.arm, entry.arm);
    assert(!groupArms.has(run.arm));
    groupArms.add(run.arm);
    assert.equal(run.turns.length, 4);
    assert.deepEqual(run.turns[0].before, scene.snapshot);
    assert.deepEqual(
      narrative,
      run.turns.map(({ finalNarrative }) => finalNarrative),
    );
    const turns = run.turns.map((turn, index) => {
      assert.equal(turn.turn, index + 1);
      assert.equal(turn.runtimeStatus, "ready");
      assert(turn.finalNarrative?.trim());
      assert.equal(turn.playerText, scene.turns[index]);
      if (index > 0) assert.deepEqual(turn.before, run.turns[index - 1].after);
      const { history } = turn.before;
      assert.deepEqual(turn.after.history.slice(0, history.length), history);
      const additions = turn.after.history.slice(history.length);
      assert.deepEqual(
        additions.map(({ role, exactText }) => [role, exactText]),
        [
          ["player", turn.playerText],
          ["narrator", turn.finalNarrative],
        ],
      );
      return {
        turn: turn.turn,
        narrativeCodePoints: codes(turn.finalNarrative),
        ...observeState(turn, scene),
        tools: toolTrace(turn),
        exchanges: inspectExchanges(run, turn),
      };
    });
    samples.push({
      id,
      label,
      scene: scene.id,
      arm: run.arm,
      scores: scoreRows,
      turns,
    });
  }
}

for (const { scores } of judges) assert.equal(scores.size, samples.length);
assert(matchedLabels.size >= 24);
for (const entries of Object.values(firstUsage)) {
  assert.equal(entries.length, repeats);
  assert.equal(new Set(entries.map(({ inputTokens }) => inputTokens)).size, 1);
}

function usageSummary(entries) {
  return Object.fromEntries(
    usageFields.map((field) => {
      const values = entries
        .map(({ usage }) => usage[field])
        .filter((value) => value !== null);
      return [
        field,
        {
          reportedCalls: values.length,
          reportedSum:
            values.length === 0
              ? null
              : values.reduce((sum, value) => sum + value, 0),
        },
      ];
    }),
  );
}

function stats(members) {
  const turns = members.flatMap((sample) => sample.turns);
  const exchanges = turns.flatMap(({ exchanges }) => exchanges);
  const tools = turns.flatMap(({ tools }) => tools);
  const byJudge = judges.map(({ sha256 }, index) => ({
    sha256,
    dimensions: Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        members.reduce(
          (sum, sample) => sum + sample.scores[index][dimension],
          0,
        ),
      ]),
    ),
  }));
  const average = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      byJudge.reduce((sum, totals) => sum + totals.dimensions[dimension], 0) /
        judges.length,
    ]),
  );
  const first = members.map(({ turns }) => turns[0].exchanges[0]);
  return {
    runs: members.length,
    narrativeTurns: turns.length,
    narrativeCodePoints: turns.reduce(
      (sum, turn) => sum + turn.narrativeCodePoints,
      0,
    ),
    blindScores: {
      dimensions: average,
      sum: Object.values(average).reduce((sum, value) => sum + value, 0),
      byJudge,
      max: members.length * dimensions.length * 2,
    },
    physicalDispatches: exchanges.reduce(
      (sum, exchange) => sum + exchange.attempts.length,
      0,
    ),
    completedExchanges: exchanges.length,
    toolsByCategory: Object.fromEntries(
      [...Object.keys(categories), "other"].map((category) => [
        category,
        {
          attempts: tools.filter((tool) => tool.category === category).length,
          successes: tools.filter(
            (tool) => tool.category === category && tool.ok,
          ).length,
        },
      ]),
    ),
    usage: {
      total: usageSummary(exchanges),
      first: usageSummary(first),
      afterFirst: usageSummary(
        exchanges.filter((entry) => !first.includes(entry)),
      ),
    },
    mismatchedAuthorityDocument: members.flatMap(({ id, turns }) =>
      turns
        .filter((turn) => !turn.authorityHolderCorrect)
        .map(({ turn }) => [id, turn]),
    ),
    mismatchedPlayerView: members.flatMap(({ id, turns }) =>
      turns
        .filter((turn) => !turn.playerViewCorrect)
        .map(({ turn }) => [id, turn]),
    ),
    originalCustodyInSituation: Object.fromEntries(
      [3, 4].map((turn) => [
        turn,
        members
          .filter((sample) => sample.turns[turn - 1].originalCustodyPresent)
          .map(({ id }) => id),
      ]),
    ),
  };
}

function applyAuthorityAudit(samples, audit) {
  assert.equal(Object.keys(audit).length, samples.length);
  const custodyModes = [
    "current",
    "noSituationWrite",
    "otherSituationWrite",
    "conflictingNewAndOld",
  ];
  const dispositions = [
    "required",
    "consolidation",
    "unnecessary",
    "noNetChange",
    "failed",
  ];
  for (const sample of samples) {
    const reviews = audit[sample.id];
    assert.equal(reviews.length, sample.turns.length);
    for (const [index, turn] of sample.turns.entries()) {
      const review = reviews[index];
      assert.equal(turn.turn, review.turn);
      assert.equal(typeof review.transferNarrated, "boolean");
      assert(turn.turn === 3 || !review.transferNarrated);
      assert(
        review.situationCustody === null ||
          custodyModes.includes(review.situationCustody),
      );
      for (const aspect of [
        "contradictions",
        "retainedNegativesLost",
        "unauthorizedActs",
      ])
        assert(Array.isArray(review[aspect]));
      const writes = turn.tools.filter(
        ({ category }) => category === "writeState",
      );
      assert.deepEqual(
        Object.keys(review.writes).sort(),
        writes.map(({ id }) => id).sort(),
      );
      for (const write of writes) {
        assert(dispositions.includes(review.writes[write.id].type));
        assert(review.writes[write.id].evidence);
        assert.equal(review.writes[write.id].type === "failed", !write.ok);
      }
      turn.review = review;
    }
  }
}

function auditedStats(members) {
  const turns = members.flatMap(({ id, turns }) =>
    turns.map((turn) => ({ id, ...turn })),
  );
  const byTurn = turns.filter((turn) => turn.turn === 3);
  const countAnnotations = (field) =>
    turns.filter(({ review }) => review[field].length > 0).length;
  const writes = turns.flatMap(({ review }) => Object.values(review.writes));
  return {
    transferNarrated: byTurn.filter(({ review }) => review.transferNarrated)
      .length,
    bindingMisses: byTurn
      .filter(
        (turn) =>
          turn.review.transferNarrated &&
          (!turn.playerViewCorrect || !turn.authorityHolderCorrect),
      )
      .map(({ id }) => id),
    situationCustody: Object.fromEntries(
      [3, 4].map((round) => [
        round,
        turns
          .filter(({ turn }) => turn === round)
          .reduce((counts, { review }) => {
            if (review.situationCustody !== null)
              counts[review.situationCustody] =
                (counts[review.situationCustody] ?? 0) + 1;
            return counts;
          }, {}),
      ]),
    ),
    contradictions: countAnnotations("contradictions"),
    strictState:
      byTurn.every((turn) => turn.review.transferNarrated) &&
      turns.every(
        (turn) => turn.playerViewCorrect && turn.authorityHolderCorrect,
      ),
    contradictionsByType: Object.fromEntries(
      ["binding", "situation", "narrative"].map((type) => [
        type,
        turns.filter(({ review }) =>
          review.contradictions.some((item) => item.type === type),
        ).length,
      ]),
    ),
    retainedNegativesLost: countAnnotations("retainedNegativesLost"),
    unauthorizedActs: countAnnotations("unauthorizedActs"),
    writesByDisposition: Object.fromEntries(
      ["required", "consolidation", "unnecessary", "noNetChange", "failed"].map(
        (type) => [type, writes.filter((write) => write.type === type).length],
      ),
    ),
  };
}

if (audit !== null) applyAuthorityAudit(samples, audit);
const scopes = Object.fromEntries(
  arms.map((arm) => [
    arm,
    Object.fromEntries(
      ["all", ...scenes.map(({ id }) => id)].map((scope) => {
        const members = samples.filter(
          (sample) =>
            sample.arm === arm && (scope === "all" || sample.scene === scope),
        );
        return [
          scope,
          {
            ...stats(members),
            ...(audit === null
              ? {}
              : { authorityAudit: auditedStats(members) }),
          },
        ];
      }),
    ),
  ]),
);
const { tools, ...parameters } = requestConstants;
const baseline = scopes.baseline;
function candidateGates(candidate) {
  const improvements = {
    totalBlindScore:
      candidate.all.blindScores.sum > baseline.all.blindScores.sum,
    bothScenes: scenes.every(
      ({ id }) => candidate[id].blindScores.sum >= baseline[id].blindScores.sum,
    ),
    resistanceAndAgency: ["resistance", "agency"].every(
      (key) =>
        candidate.all.blindScores.dimensions[key] >=
        baseline.all.blindScores.dimensions[key],
    ),
  };
  if (audit === null) return improvements;
  const state = candidate.all.authorityAudit;
  const baselineState = baseline.all.authorityAudit;
  return {
    ...improvements,
    allBindingsAndTransfers: state.strictState,
    noRegressionsInContradictionsOrAgency: [
      "contradictions",
      "retainedNegativesLost",
      "unauthorizedActs",
    ].every((key) => state[key] <= baselineState[key]),
  };
}
const report = {
  scoreHashes: judges.map(({ sha256 }) => sha256),
  audited: audit !== null,
  matchedNarratives: samples.reduce(
    (sum, sample) => sum + sample.turns.length,
    0,
  ),
  positions: {
    live: frozen.firstRequests[`${scenes[0].id}:baseline`].position,
    offline: frozen.positionProbe,
  },
  firstUsage,
  toolSchemas: tools.length,
  parameters,
  modelVersions: [...modelVersions].map((value) => JSON.parse(value)),
  scopes,
  gates: Object.fromEntries(
    arms
      .filter((arm) => arm !== "baseline")
      .map((arm) => [arm, candidateGates(scopes[arm])]),
  ),
  samples,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
