// Generate with the actual v0.7.10 release tree, never current implementation.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const [releaseRoot, output] = process.argv.slice(2);
if (!releaseRoot || !output)
  throw new Error("Expected v0.7.10 source tree and output JSON path");
const expectedSources = {
  "src/runtime/play/FileNativePlayPresetStore.ts":
    "5817375490d10925b4570157e305b7a640c0c38a79f1c7ca921b50bcac6cf191",
  "src/runtime/play/OrderedPlayPrompts.ts":
    "0e58ca978d893f095040f359d4859b7acf3312b49710028fbea8dd1fd4dd8ceb",
  "src/shared/ordered-play-prompts.ts":
    "a42ca7a4b2b42f5054942643ad5f206fec6751bb7b61fe336050d8744c6bc2b8",
};
for (const [path, expected] of Object.entries(expectedSources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(releaseRoot, path)))
    .digest("hex");
  if (actual !== expected)
    throw new Error(`Not the expected v0.7.10 source: ${path}`);
}
const { FileNativePlayPresetStore } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/play/FileNativePlayPresetStore.ts"),
  )
);
const dataRoot = await mkdtemp(
  join(tmpdir(), "narraeon-137-released-library-"),
);
try {
  const store = new FileNativePlayPresetStore(dataRoot);
  await store.initialize();
  const { preset } = await store.create("Released customized preset");
  const structure = structuredClone(preset.structure);
  for (const entry of structure.playPrompts) {
    if (entry.builtin === "play.output") {
      entry.enabled = false;
      entry.messageRole = "user";
      entry.turnGuide = "";
    }
    if (entry.builtin === "play.person-first") entry.enabled = true;
    if (entry.builtin === "play.person-second") entry.enabled = false;
    if (entry.builtin === "play.scene") {
      entry.messageRole = "assistant";
      entry.turnGuide = "Keep scene custom tail.";
    }
    if (entry.kind === "world") entry.messageRole = "user";
  }
  structure.playPrompts.splice(2, 0, {
    id: "fixed-copy",
    kind: "user",
    name: "Original clone",
    enabled: false,
    body: "# Original clone\n\nPreserve every character.\n",
    messageRole: "assistant",
    gameplay: "tabletop",
    turnGuide: "Original clone tail.",
  });
  structure.playPrompts.push({
    id: "tail-kept",
    kind: "tail",
    name: "Saved tail",
    enabled: true,
    body: "Keep this tail.",
  });
  for (const entry of structure.authorPrompts) {
    if (entry.builtin === "author.guidance") {
      entry.enabled = false;
      entry.messageRole = "user";
    }
  }
  structure.authorPrompts.splice(1, 0, {
    id: "author-custom",
    kind: "user",
    name: "Original author",
    enabled: true,
    body: "# Author wording\n\nKeep intact.\n",
    messageRole: "assistant",
  });
  const files = {
    ...preset.files,
    "assets/custom.txt": "Resource remains exact.\n",
  };
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files,
    structure,
  });
  await store.select(preset.id);
  const current = (await store.list()).presets.find(
    (item) => item.id === preset.id,
  );
  const draftStructure = structuredClone(current.structure);
  draftStructure.playPrompts.find((entry) => entry.id === "fixed-copy").body =
    "# Edited draft clone\n\nDraft remains distinct.\n";
  const saved = await store.save({
    presetId: preset.id,
    name: current.name,
    files: current.files,
    structure: draftStructure,
  });
  const library = await readFile(
    join(dataRoot, "file-native-play-presets.json"),
    "utf8",
  );
  const fixture = {
    provenance: {
      release: "v0.7.10",
      commit: "53d0aa4b65623d58e030e5f7f9b3f8669c683e14",
      sources: expectedSources,
    },
    presetId: preset.id,
    currentRevision: current.revision,
    draftRevision: saved.preset.draft.revision,
    currentStructure: current.structure,
    draftStructure: saved.preset.draft.structure,
    library,
  };
  await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
  console.log(output);
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
