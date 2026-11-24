import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// node scripts/measure-turn-ledger.mjs [absolute/path/to/baseline-checkout]
// Each checkout needs its dependencies installed. All writes use temporary data.
const repo = resolve(import.meta.dirname, "..");
const baseline = process.argv[2];
const warmups = 5;
const samples = 40;
const narrative = "雾穿过老码头。 The lanterns are still lit.\n".repeat(256);
const { readFile, writeFile } = fs;
const parse = JSON.parse;
const clone = globalThis.structuredClone;
const isTurnFile = (path) =>
  /[/\\]turns[/\\][0-9]+\.json(?:\.[\da-f-]+\.tmp)?$/u.test(String(path));
let counts;

fs.readFile = async (path, ...args) => {
  const observed = counts && isTurnFile(path) ? counts : undefined;
  if (observed) observed.recordReadAttempts++;
  const result = await readFile(path, ...args);
  if (observed) observed.recordReads++;
  return result;
};
fs.writeFile = async (path, ...args) => {
  if (counts && isTurnFile(path)) counts.recordWrites++;
  return writeFile(path, ...args);
};
syncBuiltinESMExports();
JSON.parse = (...args) => {
  const value = parse(...args);
  if (counts && value?.sequence > 0 && value.mode && Array.isArray(value.files))
    counts.recordParses++;
  return value;
};
globalThis.structuredClone = (...args) => {
  if (counts) counts.structuredClones++;
  return clone(...args);
};

// Keep createdAt identical across checkouts for the raw file comparison.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? ["2026-01-01T00:00:00.000Z"] : args));
  }
};

async function measure(results, run, record) {
  counts = {
    recordReadAttempts: 0,
    recordReads: 0,
    recordWrites: 0,
    recordParses: 0,
    structuredClones: 0,
  };
  const started = performance.now();
  try {
    const result = await run();
    if (record) results.push({ ms: performance.now() - started, ...counts });
    return result;
  } finally {
    counts = undefined;
  }
}

async function openCheckout(checkout, root) {
  const load = (file) =>
    import(pathToFileURL(join(checkout, "src/runtime", file)));
  const { minimalFileNativeContentScaffold } = await load(
    "content/ContentWorkspace.ts",
  );
  const { createMinimalFileNativePreviewInput } = await load(
    "prompt/FileNativePromptCompiler.ts",
  );
  const { FileNativeWorldStore } = await load("world/FileNativeWorldStore.ts");
  const { V1Runtime } = await load("V1Runtime.ts");
  const store = new FileNativeWorldStore(root);
  const { world } = await store.createFromContentPackage({
    operationId: "ledger-benchmark-create",
    sourcePackageId: "ledger-benchmark-package",
    sourcePackageTitle: "Ledger benchmark",
    packageFiles: minimalFileNativeContentScaffold("en"),
    prompt: createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "benchmark-no-provider",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "preview",
      playerInputPlacement: "append",
    }),
  });
  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  return {
    checkout,
    dataRoot: root,
    worldId: world.worldId,
    worldRoot: join(root, "worlds-file-native", world.worldId),
    store,
    runtime,
    commit: [],
    recoverEndpoint: [],
    worldRead: [],
    records: [],
  };
}

async function verifyFreshProcess(fixture) {
  const { checkout, dataRoot, worldId, store, records } = fixture;
  const cold = parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { join } from "node:path";
          import { pathToFileURL } from "node:url";
          const [checkout, dataRoot, worldId] = process.argv.slice(1);
          const { FileNativeWorldStore } = await import(pathToFileURL(join(
            checkout, "src/runtime/world/FileNativeWorldStore.ts",
          )));
          const { WorldLedgerAuthority } = await import(pathToFileURL(join(
            checkout, "src/runtime/world/WorldLedgerAuthority.ts",
          )));
          const endpoint = await new FileNativeWorldStore(dataRoot).recoverEndpoint(worldId);
          const head = await new WorldLedgerAuthority(join(
            dataRoot, "worlds-file-native", worldId,
          )).readHead();
          console.log(JSON.stringify({ endpoint, head }));
        `,
        checkout,
        dataRoot,
        worldId,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    ),
  );
  const warm = await store.recoverEndpoint(worldId);
  assert.deepEqual(cold.endpoint, parse(JSON.stringify(warm)));
  assert.equal(cold.head.head, warm.head);
  assert.equal(
    cold.head.commitDigest,
    createHash("sha256").update(records.at(-1)).digest("hex"),
  );
}

function summarize(values) {
  const sorted = values.map(({ ms }) => ms).toSorted((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  const operations = Object.keys(values[0]).filter((key) => key !== "ms");
  return {
    samples: sorted.length,
    medianMs: Number(
      ((sorted[midpoint - 1] + sorted[midpoint]) / 2).toFixed(3),
    ),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)),
    perSample: Object.fromEntries(
      operations.map((key) => [
        key,
        [...new Set(values.map((value) => value[key]))],
      ]),
    ),
  };
}

const root = await fs.mkdtemp(join(tmpdir(), "narraeon-turn-ledger-"));
try {
  const checkouts = baseline === undefined ? [repo] : [resolve(baseline), repo];
  const fixtures = [];
  for (const [index, checkout] of checkouts.entries())
    fixtures.push(await openCheckout(checkout, join(root, String(index))));

  for (let sequence = 1; sequence <= warmups + samples; sequence++) {
    const record = sequence > warmups;
    const head = `commit:${sequence}`;
    const order = sequence % 2 === 0 ? fixtures.toReversed() : fixtures;
    for (const fixture of order) {
      const { store, worldId, worldRoot, runtime } = fixture;
      const outcome = await measure(
        fixture.commit,
        () =>
          store.commitPlayStep({
            worldId,
            operationId: `ledger-benchmark-turn-${sequence}`,
            parentHead: sequence === 1 ? "genesis" : `commit:${sequence - 1}`,
            historyAppend: [
              {
                role: "narrator",
                exactText: `${sequence}\n${narrative}`,
                background: {
                  kind: "narrative",
                  before: "dock",
                  after: "lanterns",
                },
              },
            ],
            nextMaterials: [
              {
                kind: "node",
                document: "@current",
                locator: { yaml: ["background"] },
              },
            ],
            stateChanges: [],
          }),
        record,
      );
      assert.equal(outcome.head, head);
      const filename = `${String(sequence).padStart(8, "0")}.json`;
      const bytes = await readFile(
        join(worldRoot, "runtime", "turns", filename),
      );
      assert.equal(
        outcome.commitDigest,
        createHash("sha256").update(bytes).digest("hex"),
      );
      fixture.records.push(bytes);
      const recovered = await measure(
        fixture.recoverEndpoint,
        () => store.recoverEndpoint(worldId),
        record,
      );
      assert.equal(recovered.head, head);
      assert.equal(
        recovered.history.at(-1).exactText,
        `${sequence}\n${narrative}`,
      );
      const page = await measure(
        fixture.worldRead,
        () => runtime.handle({ type: "world.read", worldId }),
        record,
      );
      assert.equal(page.result.head, head);
    }
  }
  if (fixtures.length === 2)
    assert.deepEqual(fixtures[0].records, fixtures[1].records);
  for (const fixture of fixtures) await verifyFreshProcess(fixture);
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          os: `${platform()} ${release()}`,
          arch: arch(),
          cpu: cpus()[0]?.model,
          filesystem: tmpdir(),
        },
        workload: {
          warmups,
          narrativeBytes: Buffer.byteLength(narrative),
          turnsPerWorld: warmups + samples,
          measuredCalls: ["commitPlayStep", "recoverEndpoint", "world.read"],
          cache: "warm process and OS filesystem cache",
          freshProcessReadMatches: true,
          crossCheckoutBytesEqual: fixtures.length === 2 ? true : undefined,
        },
        results: fixtures.map((fixture) => ({
          checkout: fixture.checkout,
          commit: summarize(fixture.commit),
          recoverEndpoint: summarize(fixture.recoverEndpoint),
          worldRead: summarize(fixture.worldRead),
          recordStreamDigest: createHash("sha256")
            .update(Buffer.concat(fixture.records))
            .digest("hex"),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
