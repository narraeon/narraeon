// Run against an exported v0.6.0 tree, never against current modules.
// Writes the released artifact-store/ layout and an unexpanded fork snapshot,
// then records what the released reader returns for each world. The migration
// test must reproduce those values exactly.
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [releaseRoot, output] = process.argv.slice(2);
if (!releaseRoot || !output)
  throw new Error("Expected v0.6.0 tree and an empty output directory");

const expectedSources = {
  "src/runtime/artifact/FileNativeArtifactStore.ts":
    "963040a6cf09971d72e5ed2a7d183497aa511ed9d5987f3d450e9a87d1987939",
  "src/runtime/extension/WorldExtensionRequests.ts":
    "35004e7021bc0d09a2dbdd678dcbbd5cf4c5aec02c0e24704a327f26edb2523f",
  "src/protocol/worldExtensions.ts":
    "e92d0ce5720994c3f91a9b38f947cb8a965d0fe7b9fbcbf797a325d6fc2bfe39",
};
for (const [path, expected] of Object.entries(expectedSources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(releaseRoot, path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Not the v0.6.0 source: ${path}`);
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0)
  throw new Error("Fixture output directory must be empty");

const { FileNativeArtifactStore } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/artifact/FileNativeArtifactStore.ts"),
  ).href
);

const data = join(output, "data");
const store = new FileNativeArtifactStore(data);

const declarations = [
  {
    name: "panel",
    channel: "ui.panel",
    strategy: "replace",
    contentType: "text/plain",
    save: "commit",
    invalidation: "head_change",
    required: false,
    maxEmits: 3,
  },
  {
    name: "status",
    channel: "ui.status",
    key: "bar",
    strategy: "upsert",
    contentType: "text/plain",
    save: "operation",
    invalidation: "new_operation",
    required: false,
    maxEmits: 3,
  },
];

function operation(operationId, parentHead, attachment) {
  return {
    worldId: "world-1",
    parentHead,
    operationId,
    playPresetId: "fixture-preset",
    playPresetRevision: "rev-1",
    playPresetScriptsEnabled: false,
    ...(attachment === undefined ? {} : { attachment }),
  };
}

function request(operationContext, requestAttempt) {
  return {
    ...operationContext,
    requestId: "decorate",
    requestAttempt,
    maxArtifactBytes: 4096,
    declarations,
  };
}

// Round 1 completes its extension; its status is superseded by round 2.
const opA = operation("operation-a", "genesis", {
  contextId: "ctx",
  eventId: 1,
  head: "commit:1",
  runId: "run-a",
});
await store.beginOperation(opA);
await store.markCoreCommitted(opA, "commit:1");
await store.beginExtension(opA);
const reqA = request(opA, 1);
await store.beginRequestAttempt(reqA);
await store.emit({
  context: reqA,
  output: "panel",
  payload: "A-panel",
  toolCallId: "a-panel",
});
await store.emit({
  context: reqA,
  output: "status",
  payload: "A-status",
  toolCallId: "a-status",
});
await store.completeExtension(opA.operationId, [reqA.requestId]);

// Round 2 completes after its retry. Its first attempt clears a status and is retried, which
// rolls the clear back, and the retry's emits are what remain.
const opB = operation("operation-b", "commit:1", {
  contextId: "ctx",
  eventId: 2,
  head: "commit:2",
  runId: "run-b",
});
await store.beginOperation(opB);
await store.markCoreCommitted(opB, "commit:2");
await store.beginExtension(opB);
const reqB1 = request(opB, 1);
await store.beginRequestAttempt(reqB1);
await store.emit({
  context: reqB1,
  output: "panel",
  payload: "B-panel-1",
  toolCallId: "b-panel-1",
});
await store.emit({
  context: reqB1,
  output: "status",
  payload: "B-status-1",
  toolCallId: "b-status-1",
});
await store.clear({
  context: reqB1,
  output: "status",
  toolCallId: "b-clear-1",
});
const reqB2 = request(opB, 2);
await store.beginRequestAttempt(reqB2);
await store.emit({
  context: reqB2,
  output: "status",
  payload: "B-status-2",
  toolCallId: "b-status-2",
});
await store.emit({
  context: reqB2,
  output: "panel",
  payload: "B-panel-2",
  toolCallId: "b-panel-2",
});

await store.completeExtension(opB.operationId, [reqB2.requestId]);

// Round 3 is not yet committed: its commit-saved panel stays pending.
const opC = operation("operation-c", "commit:2");
await store.beginOperation(opC);
const reqC = request(opC, 1);
await store.beginRequestAttempt(reqC);
await store.emit({
  context: reqC,
  output: "panel",
  payload: "C-pending",
  toolCallId: "c-panel",
});

// A fork snapshot is staged into a sibling world and left unexpanded.
await mkdir(join(data, "worlds-file-native", "world-fork"), {
  recursive: true,
});
await store.stageFork({
  sourceWorldId: "world-1",
  targetWorldId: "world-fork",
  targetWorldRoot: join(data, "worlds-file-native", "world-fork"),
  timeline: [
    { contextId: "ctx", eventId: 1, head: "commit:1" },
    { contextId: "ctx", eventId: 2, head: "commit:2" },
  ],
});

// Read every world from a copy so the released reader's own restores and
// markers never touch the fixture data.
const scratch = await mkdtemp(join(tmpdir(), "artifact-v060-"));
const expected = {};
for (const worldId of ["world-1", "world-fork"]) {
  const copy = join(scratch, randomUUID());
  await cp(data, copy, { recursive: true });
  const reader = new FileNativeArtifactStore(copy);
  expected[worldId] = {
    activeProjection: await reader.readActiveProjection(worldId),
    extensionSummaries: await reader.readExtensionSummaries(worldId),
    debug: await reader.readDebug(worldId),
  };
}
await rm(scratch, { recursive: true, force: true });
// The released store also creates a lock directory that is not artifact state.
await rm(join(data, "runtime-locks"), { recursive: true, force: true });
await writeFile(
  join(output, "expected.json"),
  `${JSON.stringify(expected, null, 2)}\n`,
  "utf8",
);

const lines = [];
for (const file of await listFiles(output)) {
  const bytes = await readFile(join(output, file));
  lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
await writeFile(join(output, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.name !== "SHA256SUMS") files.push(relative(output, path));
  }
  return files.sort();
}
