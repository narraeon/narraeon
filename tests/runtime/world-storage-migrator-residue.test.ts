import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { FileNativePlayTimelineStore } from "../../src/runtime/play/FileNativePlayTimelineStore.ts";
import { FileNativeWorldStorageMigrator } from "../../src/runtime/world/FileNativeWorldStorageMigrator.ts";
import {
  appendTurn,
  initializeLedger,
  listTurns,
  readFileAt,
} from "../../src/runtime/world/WorldTurnLedger.ts";

let dataRoot: string;
let worldRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "migrator-residue-"));
  worldRoot = join(dataRoot, "worlds-file-native", "world-residue");
  await mkdir(join(worldRoot, "state"), { recursive: true });
  await writeFile(join(worldRoot, "state", "a.yaml"), "v0\n");
  await initializeLedger(worldRoot);
  for (const [sequence, content] of [
    [1, "v1\n"],
    [2, "v2\n"],
  ] as const) {
    await appendTurn(worldRoot, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content }],
      payload: {
        sequence,
        head: `commit:${String(sequence)}`,
        operationId: `operation-${String(sequence)}`,
        parentHead:
          sequence === 1 ? "genesis" : `commit:${String(sequence - 1)}`,
        mode: "play",
        historyAppend: [],
        stateChanges: [],
        nextAdditionalMaterials: [],
      },
    });
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("already-current world drops interrupted V3 residue without touching the ledger", async () => {
  const runtime = join(worldRoot, "runtime");
  await mkdir(join(runtime, "authority-v3", "commits"), { recursive: true });
  await writeFile(join(runtime, "authority-v3", "continuity-head.json"), "{}");
  await mkdir(join(runtime, ".authority-v3-migration"), { recursive: true });

  const turnsBefore = (await listTurns(worldRoot)).map((turn) => turn.sequence);
  const migrator = new FileNativeWorldStorageMigrator(
    dataRoot,
    new FileNativePlayTimelineStore(dataRoot),
  );

  const result = await migrator.migrate("world-residue");

  expect(result).toEqual({
    outcome: "already_current",
    authorityCommits: 2,
    callChainContexts: 0,
  });
  expect(await exists(join(runtime, "authority-v3"))).toBe(false);
  expect(await exists(join(runtime, ".authority-v3-migration"))).toBe(false);
  expect((await listTurns(worldRoot)).map((turn) => turn.sequence)).toEqual(
    turnsBefore,
  );
  expect(await readFileAt(worldRoot, 2, "state/a.yaml")).toBe("v2\n");
  expect(await readFileAt(worldRoot, 0, "state/a.yaml")).toBe("v0\n");
});
