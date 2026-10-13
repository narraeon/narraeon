import type * as FileSystem from "node:fs/promises";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProtagonistTemplateStore } from "../../src/runtime/config/ProtagonistTemplateStore.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-protagonist-"));
  roots.push(root);
  return root;
}

test("templates round trip, update and copy independently, and allow duplicate names", async () => {
  const root = await temporaryRoot();
  const store = new ProtagonistTemplateStore(root);
  expect(await store.view()).toEqual({ templates: [] });
  const created = (
    await store.save({ name: "调查员", body: "# 自由正文\n\n冷静。" })
  ).templates[0]!;
  const copied = (await store.copy(created.id)).templates[1]!;
  expect(copied).toMatchObject({ name: created.name, body: created.body });
  expect(copied.id).not.toBe(created.id);
  await store.save({
    id: created.id,
    name: created.name,
    body: "更新后的正文",
  });
  const reopened = new ProtagonistTemplateStore(root);
  expect((await reopened.view()).templates).toEqual([
    expect.objectContaining({ id: created.id, body: "更新后的正文" }),
    copied,
  ]);
  expect(
    JSON.parse(
      await readFile(join(root, "protagonist-templates-v1.json"), "utf8"),
    ),
  ).toEqual({ schemaVersion: 1, ...(await reopened.view()) });
  expect(
    (await stat(join(root, "protagonist-templates-v1.json"))).mode & 0o077,
  ).toBe(0);
  await reopened.delete(created.id);
  expect((await reopened.view()).templates).toEqual([copied]);
  await expect(reopened.copy(created.id)).rejects.toThrow("was not found");
  await expect(
    reopened.save({ id: created.id, name: "missing", body: "body" }),
  ).rejects.toThrow("was not found");
});

test("validation enforces character and UTF-8 byte limits without defining body fields", async () => {
  const store = new ProtagonistTemplateStore(await temporaryRoot());
  for (const input of [
    { name: "", body: "body" },
    { name: "  ", body: "body" },
    { name: "a\nb", body: "body" },
    { name: "a\rb", body: "body" },
    { name: "a".repeat(81), body: "body" },
    { name: "name", body: "" },
    { name: "name", body: "  " },
    { name: "name", body: "a".repeat(16 * 1024 + 1) },
    { name: "name", body: "界".repeat(5500) },
  ])
    await expect(store.save(input)).rejects.toThrow("1–80");
  expect(
    (await store.save({ name: "🦊".repeat(80), body: "a".repeat(16 * 1024) }))
      .templates,
  ).toHaveLength(1);
  expect(
    (
      await store.save({
        name: "unstructured",
        body: "any: text\n# No schema\n- arbitrary content",
      })
    ).templates,
  ).toHaveLength(2);
});

test("failed atomic publication leaves original bytes intact and removes its temporary file", async () => {
  const root = await temporaryRoot();
  const store = new ProtagonistTemplateStore(root);
  const created = (await store.save({ name: "before", body: "original" }))
    .templates[0]!;
  const path = join(root, "protagonist-templates-v1.json");
  const before = await readFile(path, "utf8");
  vi.mocked(rename).mockRejectedValueOnce(
    new Error("simulated rename failure"),
  );
  await expect(
    store.save({ id: created.id, name: "after", body: "replacement" }),
  ).rejects.toThrow("rename failure");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readdir(root)).toEqual(["protagonist-templates-v1.json"]);
  await Promise.all([
    store.save({ name: "second", body: "2" }),
    store.save({ name: "third", body: "3" }),
  ]);
  expect((await store.view()).templates.map(({ name }) => name)).toEqual([
    "before",
    "second",
    "third",
  ]);
});

test.each([
  "{broken",
  '{"schemaVersion":2,"templates":[]}',
  '{"schemaVersion":1,"templates":[{}]}',
  JSON.stringify({
    schemaVersion: 1,
    templates: Array(2).fill({
      id: "template-12345678-1234-4123-8123-123456789abc",
      name: "name",
      body: "body",
      updatedAt: 1,
    }),
  }),
])(
  "corrupt library is reported and never overwritten or mixed with other configuration: %s",
  async (contents) => {
    const root = await temporaryRoot();
    const path = join(root, "protagonist-templates-v1.json");
    await writeFile(path, contents);
    const runtime = new V1Runtime({
      configRoot: root,
      dataRoot: join(root, "data"),
    });
    await runtime.initialize();
    await runtime.handle({ type: "preferences.save", locale: "zh-CN" });
    const preferences = await readFile(
      join(root, "preferences-v1.json"),
      "utf8",
    );
    await expect(
      runtime.handle({ type: "protagonist-templates.read" }),
    ).rejects.toThrow("protagonist-templates-v1.json is invalid");
    await expect(
      runtime.handle({
        type: "protagonist-templates.save",
        name: "new",
        body: "new",
      }),
    ).rejects.toThrow("protagonist-templates-v1.json is invalid");
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(await readFile(join(root, "preferences-v1.json"), "utf8")).toBe(
      preferences,
    );
    expect(
      (await runtime.handle({ type: "workspace.read" })).result,
    ).toMatchObject({ preferences: { locale: "zh-CN" } });
  },
);

test("Runtime exposes template CRUD with validated required request fields", async () => {
  const root = await temporaryRoot();
  const runtime = new V1Runtime({
    configRoot: root,
    dataRoot: join(root, "data"),
  });
  const request = {
    type: "protagonist-templates.save",
    name: "new",
    body: "Markdown",
  } as const;
  expect(parseV1Envelope({ protocol: v1Protocol, request }).request).toEqual(
    request,
  );
  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: { ...request, body: 42 },
    }),
  ).toThrow("protagonist-templates.save.body is invalid");
  const created = (await runtime.handle(request)).result as {
    templates: { id: string }[];
  };
  const id = created.templates[0]!.id;
  expect(
    (await runtime.handle({ type: "protagonist-templates.copy", id })).result,
  ).toMatchObject({ templates: [expect.any(Object), expect.any(Object)] });
  await runtime.handle({ type: "protagonist-templates.delete", id });
  expect(
    (await runtime.handle({ type: "protagonist-templates.read" })).result,
  ).toMatchObject({ templates: [expect.any(Object)] });
});
