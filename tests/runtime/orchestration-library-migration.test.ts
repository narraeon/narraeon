import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import {
  FileNativePlayPresetStore,
  isPlayPresetBinding,
  type FileNativePlayPresetLibrary,
  type FileNativePlayPresetView,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

vi.mock("node:fs/promises", { spy: true });

const oldFilename = "file-native-play-presets.json";
const filename = "file-native-orchestrations.json";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(join(tmpdir(), "narraeon-243-orchestrations-"));
  roots.push(root);
  return root;
}

async function releasedFixture(url: URL) {
  return JSON.parse(gunzipSync(await fs.readFile(url)).toString("utf8")) as {
    library: string;
    files?: Record<string, string>;
    provenance?: { release: string; commit: string };
    presetId: string;
    repairId: string;
    current: FileNativePlayPresetView;
    validDraft: NonNullable<FileNativePlayPresetView["draft"]>;
    invalidDraft: NonNullable<FileNativePlayPresetView["draft"]>;
  };
}

const v3 = new URL(
  "../fixtures/orchestrations-v090-preview3.json.gz",
  import.meta.url,
);

const v1 = new URL("./fixtures/released-v040/storage.json.gz", import.meta.url);

interface ReleasedLibrary {
  currentPresetId: string;
  presets: {
    id: string;
    currentRevision: string;
    revisions: Record<string, Record<string, string>>;
  }[];
}

test("released v3 keeps current and draft policies, post-requests, panels, permissions and historical bytes", async () => {
  const fixture = await releasedFixture(v3);
  expect(fixture.provenance).toMatchObject({
    release: "v0.9.0-preview.3",
    commit: "a96a6083d965ca0fd68fefd5ed8eb7dad945e7db",
  });
  const root = await temporaryRoot();
  const oldPath = join(root, oldFilename);
  const newPath = join(root, filename);
  await fs.writeFile(oldPath, fixture.library);

  const store = new FileNativePlayPresetStore(root, { locale: () => "en" });
  await store.initialize();
  expect(store.recovery).toBeNull();
  const library = await store.list();
  expect(library.currentPresetId).toBe(fixture.presetId);
  const current = library.presets.find(({ id }) => id === fixture.presetId)!;
  expect(current.scriptsEnabled).toBe(false);
  for (const [live, released] of [
    [current, fixture.current],
    [current.draft!, fixture.validDraft],
  ] as const) {
    expect(live.revision).not.toBe(released.revision);
    expect(live.structure).toEqual(released.structure);
    const { "preset.yaml": manifest, ...resources } = released.files;
    expect(live.files).toEqual({
      ...resources,
      "orchestration.yaml": manifest!.replace(
        "narraeon.play-preset/v3",
        "narraeon.orchestration/v1",
      ),
    });
    const historical = await store.readRevision(
      fixture.presetId,
      released.revision,
    );
    expect(historical.files).toEqual(released.files);
    expect(isPlayPresetBinding(historical)).toBe(true);
  }
  expect(isPlayPresetBinding(await store.bindCurrent())).toBe(true);

  const repair = library.presets.find(({ id }) => id === fixture.repairId)!;
  expect(repair.enabled).toBe(false);
  expect(repair.draft).toMatchObject({
    revision: fixture.invalidDraft.revision,
    files: fixture.invalidDraft.files,
    validation: { status: "invalid" },
  });
  const { schemaVersion, currentOrchestrationId, orchestrations } = JSON.parse(
    await fs.readFile(newPath, "utf8"),
  ) as {
    schemaVersion: number;
    currentOrchestrationId: string;
    orchestrations: ReleasedLibrary["presets"];
  };
  expect(schemaVersion).toBe(1);
  expect(currentOrchestrationId).toBe(fixture.presetId);
  for (const record of (JSON.parse(fixture.library) as ReleasedLibrary)
    .presets) {
    const migrated = orchestrations.find(({ id }) => id === record.id)!;
    expect(migrated.revisions).toMatchObject(record.revisions);
  }

  const bytes = await fs.readFile(newPath);
  const stat = await fs.stat(newPath);
  const cold = new FileNativePlayPresetStore(root, { locale: () => "en" });
  await cold.initialize();
  expect(await fs.stat(newPath)).toMatchObject({
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  });
  expect(await fs.readFile(newPath)).toEqual(bytes);
  expect(await fs.readFile(oldPath, "utf8")).toBe(fixture.library);

  const repaired = await cold.save({
    presetId: repair.id,
    name: repair.name,
    files: {
      ...repair.draft!.files,
      "call-chain.yaml": repair.files["call-chain.yaml"]!,
    },
  });
  expect(repaired.preset.draft?.files ?? repaired.preset.files).toEqual(
    repair.files,
  );
});

test("a failed publication leaves the release intact and the next startup migrates it once", async () => {
  const fixture = await releasedFixture(v3);
  const root = await temporaryRoot();
  const oldPath = join(root, oldFilename);
  const newPath = join(root, filename);
  await fs.writeFile(oldPath, fixture.library);
  const { rename } = await vi.importActual<typeof fs>("node:fs/promises");
  const publish = vi
    .mocked(fs.rename)
    .mockClear()
    .mockImplementationOnce(async (source, destination) => {
      expect(destination).toBe(newPath);
      expect(JSON.parse(await fs.readFile(source, "utf8"))).toMatchObject({
        currentOrchestrationId: fixture.presetId,
      });
      expect(await fs.readFile(oldPath, "utf8")).toBe(fixture.library);
      throw new Error("Interrupted before atomic publication");
    });
  await expect(
    new FileNativePlayPresetStore(root).initialize(),
  ).rejects.toThrow("Interrupted before atomic publication");
  expect(publish).toHaveBeenCalledOnce();
  expect(await fs.readdir(root)).toEqual([oldFilename]);
  expect(await fs.readFile(oldPath, "utf8")).toBe(fixture.library);

  // A hard process exit can leave a sibling staging file. Only the final path is the marker.
  await fs.writeFile(newPath + ".interrupted.tmp", "incomplete");
  publish.mockImplementation(rename);
  const cold = new FileNativePlayPresetStore(root);
  await cold.initialize();
  expect(publish).toHaveBeenCalledTimes(2);
  expect((await cold.list()).currentPresetId).toBe(fixture.presetId);
  await new FileNativePlayPresetStore(root).initialize();
  expect(publish).toHaveBeenCalledTimes(2);
});

test.each([
  ["corrupt JSON", Buffer.from("{ broken JSON\r\n")],
  ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
  [
    "unknown schema",
    Buffer.from(
      '{"schemaVersion":2,"currentPresetId":"future","presets":[]}\n',
    ),
  ],
])(
  "a %s legacy library is backed up byte for byte and reported by Runtime",
  async (_, contents) => {
    const root = await temporaryRoot();
    await fs.writeFile(join(root, oldFilename), contents);
    const runtime = new V1Runtime({
      configRoot: root,
      dataRoot: join(root, "data"),
    });
    await runtime.initialize();
    const { result } = await runtime.handle({ type: "workspace.read" });
    const workspace = result as {
      storageNotices: { surface: string; message: string }[];
      playPresets: FileNativePlayPresetLibrary;
    };
    const backup = (await fs.readdir(root)).find((path) =>
      /^file-native-play-presets\.unreadable-.+\.json$/u.test(path),
    )!;
    expect(await fs.readFile(join(root, backup))).toEqual(contents);
    await expect(fs.access(join(root, oldFilename))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(workspace.storageNotices).toHaveLength(1);
    expect(workspace.storageNotices[0]?.surface).toMatch(
      /编排方案库|Orchestration library/u,
    );
    expect(workspace.storageNotices[0]?.message).toContain(backup);
    expect(
      workspace.playPresets.presets[0]?.files["orchestration.yaml"],
    ).toContain("narraeon.orchestration/v1");
  },
);

test.each([
  ["v1", new URL("./fixtures/released-v040/storage.json.gz", import.meta.url)],
  ["v2", new URL("../fixtures/play-presets-v0710.json.gz", import.meta.url)],
  ["v3", v3],
])(
  "a %s portable export imports into the current schema without changing the selected identity",
  async (_, url) => {
    const fixture = await releasedFixture(url);
    const original = JSON.parse(
      fixture.library ?? fixture.files![`config/${oldFilename}`]!,
    ) as ReleasedLibrary;
    const released = original.presets.find(
      ({ id }) => id === fixture.presetId,
    )!;
    const files = released.revisions[released.currentRevision]!;
    const root = await temporaryRoot();
    const store = new FileNativePlayPresetStore(root);
    const before = await store.bindCurrent();
    const imported = await store.importPortable({
      name: "Released portable copy",
      files: Object.entries(files).map(([path, contents]) => ({
        path,
        contents,
      })),
    });
    expect(imported.currentPresetId).toBe(before.id);
    expect(imported.preset.scriptsEnabled).toBe(false);
    expect(imported.preset.files["orchestration.yaml"]).toContain(
      "narraeon.orchestration/v1",
    );
    expect(imported.preset.files["preset.yaml"]).toBeUndefined();
    for (const [path, contents] of Object.entries(files))
      if (path !== "preset.yaml" && path !== "call-chain.yaml")
        expect(imported.preset.files[path]).toBe(contents);
    const exported = await store.exportPortable(imported.preset.id);
    expect(exported).not.toContainEqual(
      expect.objectContaining({ path: "preset.yaml" }),
    );
    expect(exported).toContainEqual({
      path: "orchestration.yaml",
      contents: imported.preset.files["orchestration.yaml"],
    });
    await expect(fs.access(join(root, oldFilename))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test("a released v1 revision remains available when the inline conversion exceeds the file limit", async () => {
  const fixture = await releasedFixture(v1);
  const raw = fixture.files![`config/${oldFilename}`]!;
  const previous = (JSON.parse(raw) as ReleasedLibrary).presets.find(
    ({ id }) => id === fixture.presetId,
  )!;
  const root = await temporaryRoot();
  await fs.writeFile(join(root, oldFilename), raw);
  const store = new FileNativePlayPresetStore(root, {
    limits: { maxFileBytes: 8000 },
  });
  await store.initialize();
  expect(store.recovery).toBeNull();
  const binding = await store.bindCurrent();
  expect(binding.revision).toBe(previous.currentRevision);
  expect(binding.files).toEqual(previous.revisions[previous.currentRevision]);
  expect(await fs.readFile(join(root, oldFilename), "utf8")).toBe(raw);
  await expect(fs.access(join(root, filename))).resolves.toBeUndefined();
});
