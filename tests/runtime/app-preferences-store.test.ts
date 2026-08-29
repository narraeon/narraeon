import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { AppPreferencesStore } from "../../src/runtime/config/AppPreferencesStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("app preferences default to English and persist the selected locale", async () => {
  const root = await temporaryRoot();
  const store = new AppPreferencesStore(root);

  await expect(store.view()).resolves.toEqual({ locale: "en" });
  await expect(store.save("zh-CN")).resolves.toEqual({ locale: "zh-CN" });
  await expect(new AppPreferencesStore(root).view()).resolves.toEqual({
    locale: "zh-CN",
  });

  const path = join(root, "preferences-v1.json");
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    schemaVersion: 1,
    locale: "zh-CN",
  });
});

test("app preferences reject incompatible persisted documents", async () => {
  const root = await temporaryRoot();
  await writeFile(
    join(root, "preferences-v1.json"),
    JSON.stringify({ schemaVersion: 1, locale: "fr" }),
    "utf8",
  );

  await expect(new AppPreferencesStore(root).view()).rejects.toThrow(
    "App preferences file does not match the v1 schema",
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-app-preferences-"));
  roots.push(root);
  return root;
}
