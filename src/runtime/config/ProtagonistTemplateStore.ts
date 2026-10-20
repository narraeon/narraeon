import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  isProtagonistTemplateContent,
  isProtagonistTemplateId,
  type ProtagonistTemplate,
  type ProtagonistTemplatesView,
  type SaveProtagonistTemplateInput,
} from "../../protocol/protagonistTemplates.ts";

const fileName = "protagonist-templates-v1.json";

export class ProtagonistTemplateStore {
  readonly #root: string;
  readonly #path: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(configRoot: string) {
    this.#root = configRoot;
    this.#path = join(configRoot, fileName);
  }

  async view(): Promise<ProtagonistTemplatesView> {
    await this.#mutationTail;
    return this.#read();
  }

  save(input: SaveProtagonistTemplateInput): Promise<ProtagonistTemplatesView> {
    return this.#mutate((templates) => {
      if (
        !isProtagonistTemplateContent(input.name, input.body) ||
        (input.id !== undefined && !isProtagonistTemplateId(input.id))
      )
        throw new Error(
          "Protagonist template requires a single-line name of 1–80 characters and a Markdown body of 1–16 KiB",
        );
      const template: ProtagonistTemplate = {
        id: input.id ?? `template-${randomUUID()}`,
        name: input.name,
        body: input.body,
        updatedAt: Date.now(),
      };
      if (input.id === undefined) templates.push(template);
      else templates[findTemplate(templates, input.id)] = template;
    });
  }

  copy(id: string): Promise<ProtagonistTemplatesView> {
    return this.#mutate((templates) => {
      const source = templates[findTemplate(templates, id)]!;
      templates.push({
        ...source,
        id: `template-${randomUUID()}`,
        updatedAt: Date.now(),
      });
    });
  }

  delete(id: string): Promise<ProtagonistTemplatesView> {
    return this.#mutate((templates) => {
      templates.splice(findTemplate(templates, id), 1);
    });
  }

  async #mutate(
    operation: (templates: ProtagonistTemplate[]) => void,
  ): Promise<ProtagonistTemplatesView> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const view = await this.#read();
      operation(view.templates);
      await this.#write(view);
      return view;
    } finally {
      release();
    }
  }

  async #read(): Promise<ProtagonistTemplatesView> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { templates: [] };
      throw error;
    }
    try {
      return validateDocument(JSON.parse(contents));
    } catch (error: unknown) {
      throw new Error(
        `${fileName} is invalid: expected schemaVersion 1 with valid protagonist templates`,
        { cause: error },
      );
    }
  }

  async #write(view: ProtagonistTemplatesView): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = join(this.#root, `.${fileName}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, ...view }, null, 2)}\n`,
        "utf8",
      );
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function findTemplate(templates: ProtagonistTemplate[], id: string): number {
  if (!isProtagonistTemplateId(id))
    throw new Error("Invalid protagonist template id");
  const index = templates.findIndex((template) => template.id === id);
  if (index < 0) throw new Error("Protagonist template was not found");
  return index;
}

function validateDocument(value: unknown): ProtagonistTemplatesView {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.templates)
  )
    throw new Error("Invalid template document");
  const ids = new Set<string>();
  for (const template of value.templates) {
    if (
      !isRecord(template) ||
      Object.keys(template).length !== 4 ||
      !isProtagonistTemplateId(template.id) ||
      ids.has(template.id) ||
      !isProtagonistTemplateContent(template.name, template.body) ||
      typeof template.updatedAt !== "number" ||
      !Number.isSafeInteger(template.updatedAt) ||
      template.updatedAt < 0
    )
      throw new Error("Invalid template");
    ids.add(template.id);
  }
  return {
    templates: structuredClone(value.templates) as ProtagonistTemplate[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
