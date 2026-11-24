// Run against a checkout of the actual v0.9.0-preview.3 release, with its dependencies installed.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const [releaseRoot, output] = process.argv.slice(2);
if (!releaseRoot || !output)
  throw new Error("Expected the release source directory and output gzip path");

const storeSource = "src/runtime/play/FileNativePlayPresetStore.ts";
const requestSource = "src/shared/first-party-generic-panels.ts";
const panelSource = "src/shared/first-party-player-view.ts";
const sources = {
  [storeSource]:
    "3f6140f80f856c3c21decda20b492c593b3e745a31039a0509f325fd81913516",
  [requestSource]:
    "d273aaadc79b424fd30c14e9ccb6f0b2934761efcfea717de9c09effc8e54947",
  [panelSource]:
    "7fb7d28c3902b34edc4b9fbed927c7ba6ef6e3f156398cc71673c2b3daee3b7b",
};
for (const [path, digest] of Object.entries(sources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(releaseRoot, path)))
    .digest("hex");
  if (actual !== digest) throw new Error(`Unexpected release source: ${path}`);
}

const released = (path) => import(pathToFileURL(join(releaseRoot, path)));
const { FileNativePlayPresetStore, parsePlayPresetFiles } =
  await released(storeSource);
const { firstPartyGenericPanelsPresetFiles } = await released(requestSource);
const { firstPartyStatusPanelPresetFiles } = await released(panelSource);
const root = await mkdtemp(join(tmpdir(), "narraeon-243-v3-release-"));
try {
  const store = new FileNativePlayPresetStore(root, { locale: () => "en" });
  await store.initialize();
  const { preset } = await store.create(
    "Released v3 customization",
    firstPartyGenericPanelsPresetFiles,
  );
  const structure = structuredClone(preset.structure);
  const panel = parsePlayPresetFiles(
    firstPartyStatusPanelPresetFiles,
  ).definition;
  structure.playerViewPanels = panel.playerViewPanels;
  structure.extensionRefs.push(...panel.extensionRefs);
  const files = {
    ...preset.files,
    ...Object.fromEntries(
      panel.extensionRefs.map((path) => [path, panel.files[path]]),
    ),
    "assets/v3-extra.txt": "Coordinates: 修改 🧭\r\n\r\n",
  };
  structure.playPrompts.splice(1, 0, {
    id: "released-v3-clone",
    kind: "user",
    name: "Cloned policy",
    enabled: false,
    messageRole: "assistant",
    body: "# My copy\n\nFirst line.\n\n🧭 Last line.\n",
    turnGuide: "A disabled clone's tail.",
  });
  const outputPrompt = structure.playPrompts.find(
    (item) => item.builtin === "play.output",
  );
  outputPrompt.enabled = false;
  outputPrompt.messageRole = "user";
  outputPrompt.turnGuide = "";
  structure.authorPrompts.splice(2, 0, {
    id: "released-v3-author",
    kind: "user",
    name: "Author rule",
    enabled: true,
    body: "Keep the author's rule.\n",
  });
  structure.followupItems.reverse();
  structure.followupItems.find((item) => item.kind === "user").enabled = false;
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files,
    structure,
  });
  const { preset: current } = await store.select(preset.id);
  await store.setScriptsEnabled(preset.id, false);
  const draft = structuredClone(current.structure);
  draft.playPrompts.find((item) => item.id === "released-v3-clone").body =
    "Draft only.\n";
  const saved = await store.save({
    presetId: preset.id,
    name: preset.name,
    files: current.files,
    structure: draft,
  });

  const { preset: repair } = await store.create(
    "Released v3 repair",
    firstPartyGenericPanelsPresetFiles,
  );
  await store.setEnabled(repair.id, false);
  const broken = await store.save({
    presetId: repair.id,
    name: repair.name,
    files: {
      ...repair.files,
      "call-chain.yaml": "format: [broken\r\n# 修复我 🧭\r\n",
    },
  });
  if (
    saved.preset.draft.validation.status !== "valid" ||
    broken.preset.draft.validation.status !== "invalid"
  )
    throw new Error("The release did not create the expected drafts");

  const fixture = {
    provenance: {
      release: "v0.9.0-preview.3",
      commit: "a96a6083d965ca0fd68fefd5ed8eb7dad945e7db",
      sources,
    },
    presetId: preset.id,
    repairId: repair.id,
    current,
    validDraft: saved.preset.draft,
    invalidDraft: broken.preset.draft,
    library: await readFile(
      join(root, "file-native-play-presets.json"),
      "utf8",
    ),
  };
  await writeFile(
    output,
    gzipSync(JSON.stringify(fixture) + "\n", { level: 9 }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
