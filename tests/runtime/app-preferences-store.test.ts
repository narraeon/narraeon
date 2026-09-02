import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { AppPreferencesStore } from "../../src/runtime/config/AppPreferencesStore.ts";
import { defaultAppReadingPreferences } from "../../src/protocol/appPreferences.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("app preferences default to English and persist the selected locale", async () => {
  const root = await temporaryRoot();
  const store = new AppPreferencesStore(root);

  await expect(store.view()).resolves.toEqual({
    locale: "en",
    reading: defaultAppReadingPreferences,
  });
  await expect(store.save({ locale: "zh-CN" })).resolves.toEqual({
    locale: "zh-CN",
    reading: defaultAppReadingPreferences,
  });
  await expect(new AppPreferencesStore(root).view()).resolves.toEqual({
    locale: "zh-CN",
    reading: defaultAppReadingPreferences,
  });

  const path = join(root, "preferences-v1.json");
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    schemaVersion: 2,
    locale: "zh-CN",
    reading: defaultAppReadingPreferences,
  });
});

test("app preferences migrate v1 locale and preserve it when reading controls save", async () => {
  const root = await temporaryRoot();
  await writeFile(
    join(root, "preferences-v1.json"),
    JSON.stringify({ schemaVersion: 1, locale: "zh-CN" }),
    "utf8",
  );
  const store = new AppPreferencesStore(root);
  const reading = {
    ...defaultAppReadingPreferences,
    measure: 72,
    fontSize: 20,
  };

  await expect(store.view()).resolves.toEqual({
    locale: "zh-CN",
    reading: defaultAppReadingPreferences,
  });
  await expect(store.save({ reading })).resolves.toEqual({
    locale: "zh-CN",
    reading,
  });
  expect(
    JSON.parse(await readFile(join(root, "preferences-v1.json"), "utf8")),
  ).toEqual({
    schemaVersion: 2,
    locale: "zh-CN",
    reading,
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
    "App preferences file does not match a supported schema",
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-app-preferences-"));
  roots.push(root);
  return root;
}
