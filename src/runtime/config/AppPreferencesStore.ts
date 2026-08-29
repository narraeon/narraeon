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
  isAppLocale,
  type AppLocale,
  type AppPreferences,
} from "../../protocol/appPreferences.ts";

const preferencesFileName = "preferences-v1.json";

interface AppPreferencesDocument extends AppPreferences {
  schemaVersion: 1;
}

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

  save(locale: AppLocale): Promise<AppPreferences> {
    return this.#mutate(async () => {
      if (!isAppLocale(locale)) throw new Error("Unsupported app locale");
      const document: AppPreferencesDocument = { schemaVersion: 1, locale };
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
    return { schemaVersion: 1, locale: defaultAppLocale };
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("locale" in value) ||
    !isAppLocale(value.locale) ||
    Object.keys(value).some(
      (key) => key !== "schemaVersion" && key !== "locale",
    )
  )
    throw new Error("App preferences file does not match the v1 schema");
  return { schemaVersion: 1, locale: value.locale };
}

function toView(document: AppPreferencesDocument): AppPreferences {
  return { locale: document.locale };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
