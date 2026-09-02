import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  defaultAppLocale,
  defaultAppReadingPreferences,
  isAppLocale,
  isAppReadingPreferences,
  type AppPreferences,
  type AppPreferencesUpdate,
} from "../../protocol/appPreferences.ts";

const preferencesFileName = "preferences-v1.json";

type AppPreferencesDocument =
  | { schemaVersion: 1; locale: AppPreferences["locale"] }
  | ({ schemaVersion: 2 } & AppPreferences);

export class AppPreferencesStore {
  readonly #configRoot: string;
  readonly #path: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(configRoot: string) {
    this.#configRoot = configRoot;
    this.#path = join(configRoot, preferencesFileName);
  }

  async view(): Promise<AppPreferences> {
    await this.#mutationTail;
    return toView(await this.#readDocument());
  }

  save(update: AppPreferencesUpdate): Promise<AppPreferences> {
    return this.#mutate(async () => {
      if (
        Object.keys(update).length === 0 ||
        Object.keys(update).some(
          (key) => key !== "locale" && key !== "reading",
        ) ||
        (update.locale !== undefined && !isAppLocale(update.locale)) ||
        (update.reading !== undefined &&
          !isAppReadingPreferences(update.reading))
      )
        throw new Error("Unsupported app preferences update");
      const current = toView(await this.#readDocument());
      const document: AppPreferencesDocument = {
        schemaVersion: 2,
        locale: update.locale ?? current.locale,
        reading: structuredClone(update.reading ?? current.reading),
      };
      await this.#writeDocument(document);
      return toView(document);
    });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #readDocument(): Promise<AppPreferencesDocument> {
    try {
      const info = await stat(this.#path);
      if (!info.isFile()) throw new Error("App preferences path is not a file");
      return validateDocument(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
    }
    return {
      schemaVersion: 2,
      locale: defaultAppLocale,
      reading: structuredClone(defaultAppReadingPreferences),
    };
  }

  async #writeDocument(document: AppPreferencesDocument): Promise<void> {
    await mkdir(this.#configRoot, { recursive: true, mode: 0o700 });
    const temporary = join(
      this.#configRoot,
      `.${preferencesFileName}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validateDocument(value: unknown): AppPreferencesDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("App preferences file does not match a supported schema");
  if (
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "locale" in value &&
    isAppLocale(value.locale) &&
    Object.keys(value).every(
      (key) => key === "schemaVersion" || key === "locale",
    )
  )
    return { schemaVersion: 1, locale: value.locale };
  if (
    "schemaVersion" in value &&
    value.schemaVersion === 2 &&
    "locale" in value &&
    isAppLocale(value.locale) &&
    "reading" in value &&
    isAppReadingPreferences(value.reading) &&
    Object.keys(value).every(
      (key) => key === "schemaVersion" || key === "locale" || key === "reading",
    )
  )
    return {
      schemaVersion: 2,
      locale: value.locale,
      reading: structuredClone(value.reading),
    };
  throw new Error("App preferences file does not match a supported schema");
}

function toView(document: AppPreferencesDocument): AppPreferences {
  return {
    locale: document.locale,
    reading:
      document.schemaVersion === 1
        ? structuredClone(defaultAppReadingPreferences)
        : structuredClone(document.reading),
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
