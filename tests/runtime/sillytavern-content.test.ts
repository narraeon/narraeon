import { describe, expect, it } from "vitest";
import {
  inspectSillyTavernContent,
  convertSillyTavernContent,
} from "../../src/runtime/content/SillyTavernContent.ts";

describe("SillyTavern content migration", () => {
  it("keeps disabled world book entries out of world facts", () => {
    const source = Buffer.from(
      JSON.stringify({
        entries: {
          "0": {
            uid: 0,
            comment: "Secret",
            content: "Hidden",
            disable: true,
            key: ["secret"],
          },
        },
      }),
    );
    const inspection = inspectSillyTavernContent(source);
    const result = convertSillyTavernContent(source, {
      entries: { [inspection.entries[0]!.id]: "attachment" },
    });
    expect(
      result.files.some(
        (file) =>
          file.path.startsWith("world/") && file.contents.includes("Hidden"),
      ),
    ).toBe(false);
    expect(
      result.files.some(
        (file) =>
          file.path.startsWith("assets/") && file.contents.includes("Hidden"),
      ),
    ).toBe(true);
  });
});

import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";

const v1 = {
  name: "A",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  first_mes: "opening",
  mes_example: "example",
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("source formats and publication boundaries", () => {
  it("distinguishes embedded enabled from standalone disable and ignores originalData", () => {
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        ...v1,
        character_book: {
          entries: [
            { id: 1, content: "disabled by default" },
            { id: 2, content: "enabled", enabled: true },
          ],
        },
      },
    };
    const embedded = inspectSillyTavernContent(bytes(card));
    expect(embedded.entries.map((entry) => entry.enabled)).toEqual([
      false,
      true,
    ]);
    const standalone = inspectSillyTavernContent(
      bytes({
        entries: { "0": { uid: 0, content: "one" } },
        originalData: { entries: [{ content: "duplicate" }] },
      }),
    );
    expect(standalone.entries).toHaveLength(1);
    expect(standalone.entries[0]?.enabled).toBe(true);
  });
  it("requires known card formats and distinct entry identities", () => {
    expect(() =>
      inspectSillyTavernContent(bytes({ name: "not a card" })),
    ).toThrow("unsupported_format");
    expect(() =>
      inspectSillyTavernContent(
        bytes({ spec: "chara_card_v2", spec_version: "2.99", data: v1 }),
      ),
    ).toThrow("unknown_version");
    expect(() =>
      inspectSillyTavernContent(
        bytes({
          entries: { a: { uid: 1, content: "a" }, b: { uid: 1, content: "b" } },
        }),
      ),
    ).toThrow("duplicate_identity");
  });
  it("publishes chosen content only and keeps an unbound macro incomplete", () => {
    const source = bytes({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        ...v1,
        description: "<USER> knows",
        alternate_greetings: ["another"],
        character_book: {
          entries: [{ id: 1, content: "unselected secret", enabled: true }],
        },
      },
    });
    const result = convertSillyTavernContent(source, {
      character: true,
      scenario: true,
      opening: "1",
      entries: {},
    });
    expect(result.diagnostics).toContainEqual({
      code: "unbound_macro",
      path: "$.data.description",
    });
    expect(result.files.some((file) => file.path === "opening.md")).toBe(false);
    expect(JSON.stringify(result.files)).not.toContain("unselected secret");
    expect(inspectContentPackageCurrentTree(result.files).status).toBe(
      "needs_repair",
    );
    expect(
      result.files.find((file) => file.path.startsWith("assets/"))?.contents,
    ).toContain("another");
  });
  it("makes a usable package with one explicitly chosen opening", () => {
    const result = convertSillyTavernContent(bytes(v1), {
      character: true,
      scenario: true,
      opening: "0",
      entries: {},
    });
    expect(inspectContentPackageCurrentTree(result.files).status).toBe(
      "usable",
    );
    expect(
      result.files.find((file) => file.path === "opening.md")?.contents,
    ).toBe("opening");
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}
function png(metadata: [string, string][], width = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...metadata.map(([key, value]) =>
      chunk("tEXt", Buffer.from(`${key}\0${value}`)),
    ),
    chunk("IDAT", Buffer.from([1])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("PNG card metadata", () => {
  it("prefers ccv3 and rejects corruption and oversized dimensions", () => {
    const old = bytes(v1).toString("base64");
    const modern = bytes({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { ...v1, name: "Modern" },
    }).toString("base64");
    const image = png([
      ["chara", old],
      ["ccv3", modern],
    ]);
    expect(inspectSillyTavernContent(image).fields.name).toBe("Modern");
    const broken = Buffer.from(image);
    broken[20] = broken[20]! ^ 1;
    expect(() => inspectSillyTavernContent(broken)).toThrow("invalid_png_crc");
    expect(() =>
      inspectSillyTavernContent(png([["chara", old]], 16385)),
    ).toThrow("invalid_png_dimensions");
    expect(() => inspectSillyTavernContent(png([]))).toThrow(
      "missing_card_metadata",
    );
    expect(() => inspectSillyTavernContent(png([["chara", "%%%"]]))).toThrow(
      "invalid_base64",
    );
  });
});

it("preserves selected rule metadata in both world book formats", () => {
  const embedded = bytes({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      ...v1,
      character_book: {
        entries: [
          {
            id: 3,
            content: "lore",
            enabled: true,
            extensions: {
              depth: 7,
              role: 1,
              triggers: ["normal"],
              sticky: null,
              exclude_recursion: true,
            },
          },
        ],
      },
    },
  });
  const saved = convertSillyTavernContent(embedded, {
    entries: { "entry-0": "attachment" },
  }).files.find((file) => file.path.startsWith("assets/"))!.contents;
  for (const value of [
    "depth: 7",
    "role: 1",
    "normal",
    "exclude_recursion: true",
    "sticky: null",
  ])
    expect(saved).toContain(value);
  const standalone = bytes({
    entries: {
      a: {
        uid: 1,
        content: "lore",
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 2,
        groupWeight: 4,
        scanDepth: null,
      },
    },
  });
  const savedStandalone = convertSillyTavernContent(standalone, {
    entries: { "entry-0": "attachment" },
  }).files.find((file) => file.path.startsWith("assets/"))!.contents;
  for (const value of [
    "excludeRecursion: true",
    "preventRecursion: true",
    "delayUntilRecursion: 2",
    "groupWeight: 4",
    "scanDepth: null",
  ])
    expect(savedStandalone).toContain(value);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

it("Runtime revalidates and atomically publishes independent packages that round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-st-content-"));
  try {
    const runtime = new V1Runtime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
    });
    await runtime.initialize();
    const source = bytes(v1).toString("base64");
    const selection = {
      character: true,
      scenario: true,
      opening: "0",
      entries: {},
    };
    const before = (await runtime.handle({ type: "workspace.read" })).result;
    await runtime.handle({
      type: "content.sillytavern.preview",
      source,
      name: "Imported",
      selection,
    });
    await expect(
      runtime.handle({
        type: "content.sillytavern.import",
        source,
        name: "Imported",
        selection: { ...selection, entries: { unknown: "world" } },
      }),
    ).rejects.toThrow("invalid_selection");
    expect((await runtime.handle({ type: "workspace.read" })).result).toEqual(
      before,
    );
    const first = (
      await runtime.handle({
        type: "content.sillytavern.import",
        source,
        name: "Imported",
        selection,
      })
    ).result as {
      localId: string;
      files: { path: string; contents: string }[];
    };
    const second = (
      await runtime.handle({
        type: "content.sillytavern.import",
        source,
        name: "Imported",
        selection,
      })
    ).result as typeof first;
    expect(first.localId).not.toBe(second.localId);
    const archive = (
      await runtime.handle({ type: "content.export", packageId: first.localId })
    ).result as { base64: string };
    const restored = (
      await runtime.handle({
        type: "content.import",
        archiveBase64: archive.base64,
        title: "Restored",
      })
    ).result as typeof first;
    expect(restored.localId).not.toBe(first.localId);
    expect(restored.files).toEqual(first.files);
    const incomplete = (
      await runtime.handle({
        type: "content.sillytavern.import",
        source,
        name: "Incomplete",
        selection: { entries: {} },
      })
    ).result as { localId: string; status: string };
    expect(incomplete.status).toBe("needs_repair");
    await expect(
      runtime.handle({
        type: "world.create",
        operationId: "incomplete",
        packageId: incomplete.localId,
        model: {
          provider: "chat_completions",
          modelId: "test",
          contextWindowTokens: 32000,
          maxOutputTokens: 2000,
        },
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { FileNativePlayPresetStore } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

it("real world index and prompt compilation exclude attachment-only content", async () => {
  const source = bytes({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      ...v1,
      character_book: {
        entries: [
          {
            id: 1,
            comment: "Secret",
            content: "HIDDEN-ATTACHMENT",
            enabled: false,
          },
          { id: 2, comment: "Lore", content: "Visible lore", enabled: true },
        ],
      },
    },
  });
  const files = convertSillyTavernContent(source, {
    character: true,
    scenario: true,
    opening: "0",
    entries: { "entry-0": "attachment", "entry-1": "world" },
  }).files;
  const snapshot = WorldDocumentStore.open({
    layout: "world_state",
    files: files.map((file) => ({
      ...file,
      path: file.path.startsWith("world/")
        ? `state/${file.path.slice(6)}`
        : file.path,
    })),
  });
  const search = snapshot.query({
    kind: "literal_search",
    query: "HIDDEN-ATTACHMENT",
  });
  expect(search.ok).toBe(true);
  if (search.ok && search.kind === "literal_search")
    expect(search.matches).toHaveLength(0);
  const root = await mkdtemp(join(tmpdir(), "narraeon-st-prompt-"));
  try {
    const presets = new FileNativePlayPresetStore(root);
    await presets.initialize();
    const binding = await presets.bindCurrent();
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
      playerInput: "Hello",
      playerInputPlacement: "append",
    });
    input.world.documentSnapshot = snapshot;
    const compiled = new FileNativePromptCompiler().compilePlayCallChain(
      input,
      binding,
    );
    expect(JSON.stringify(compiled)).not.toContain("HIDDEN-ATTACHMENT");
    expect(JSON.stringify(compiled)).toContain("Lore");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects malformed known source field types and duplicate JSON keys", () => {
  expect(() =>
    inspectSillyTavernContent(
      bytes({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { ...v1, tags: "wrong" },
      }),
    ),
  ).toThrow("expected_string_array");
  expect(() =>
    inspectSillyTavernContent(
      bytes({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { ...v1, extensions: { depth_prompt: { depth: "wrong" } } },
      }),
    ),
  ).toThrow("invalid_depth_prompt");
  expect(() =>
    inspectSillyTavernContent(
      bytes({ entries: { a: { content: "lore", depth: "wrong" } } }),
    ),
  ).toThrow("invalid_rule_type");
  expect(() =>
    inspectSillyTavernContent(Buffer.from('{"name":"one","name":"two"}')),
  ).toThrow("ambiguous_json");
  const poisoned = Buffer.from("AAAA");
  poisoned[0] = poisoned[0]! | 0x80;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const image = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.concat([Buffer.from("chara\0"), poisoned])),
    chunk("IDAT", Buffer.from([1])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(() => inspectSillyTavernContent(image)).toThrow("invalid_base64");
});
