import { Ajv } from "ajv";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  sillyTavernImportReportPath,
  type SillyTavernDiagnostic,
} from "../../shared/sillytavern-preset.ts";
import type { SillyTavernSourceSnapshot } from "../../shared/sillytavern-source.ts";

const text = { type: "string" };
const flag = { type: "boolean" };
const number = { type: "number" };
const texts = { type: "array", items: text };
const reason = {
  enum: [
    "missing_builtin",
    "marker",
    "unsupported_macro",
    "depth_injection",
    "trigger",
    "overrides",
    "unsupported_fields",
    "unplaced",
  ],
};
const ajv = new Ajv();
const validateSnapshot = ajv.compile<SillyTavernSourceSnapshot>({
  type: "object",
  additionalProperties: false,
  required: ["version", "groupId", "entries"],
  properties: {
    version: { const: 1 },
    groupId: { type: "string", minLength: 1 },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "path",
          "name",
          "ordered",
          "selected",
          "marker",
          "missing",
          "macros",
          "reasons",
        ],
        properties: {
          id: text,
          path: text,
          name: text,
          ordered: flag,
          order: { type: "integer", minimum: 0 },
          selected: flag,
          enabled: flag,
          marker: flag,
          missing: flag,
          content: text,
          role: { enum: ["system", "user", "assistant"] },
          injectionPosition: number,
          injectionDepth: number,
          injectionOrder: number,
          triggers: texts,
          macros: texts,
          forbidOverrides: flag,
          systemPrompt: flag,
          extension: flag,
          position: { anyOf: [number, text] },
          reasons: { type: "array", items: reason },
          targetEntryId: text,
        },
      },
    },
  },
});
const validateDiagnostic = ajv.compile<SillyTavernDiagnostic>({
  type: "object",
  additionalProperties: false,
  required: ["code", "path", "result"],
  properties: {
    code: {
      enum: [
        ...reason.enum,
        "ignored_setting",
        "prompt_selection",
        "unsupported_field",
      ],
    },
    path: text,
    name: text,
    result: {
      enum: ["ignored", "enabled", "disabled", "not_selected", "not_imported"],
    },
  },
});

/** Stable across cold reads and copies, independent of JSON field order. */
export function sillyTavernSnapshotFingerprint(
  snapshot: SillyTavernSourceSnapshot,
): string {
  const canonical = JSON.stringify(snapshot, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

interface LegacySillyTavernReport {
  groupId?: string;
  prompts: (Record<string, unknown> & {
    sourceId: string;
    targetId?: string;
  })[];
  report: SillyTavernDiagnostic[];
}

export function readLegacySillyTavernReport(
  files: Record<string, string>,
): LegacySillyTavernReport | undefined {
  const contents = files[sillyTavernImportReportPath];
  if (contents === undefined) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    return;
  }
  if (!isRecord(decoded) || decoded.format !== "narraeon.sillytavern-import/v1")
    return;
  const { sourceGroupId, prompts, report } = decoded;
  if (
    (sourceGroupId !== undefined && typeof sourceGroupId !== "string") ||
    !Array.isArray(prompts) ||
    !Array.isArray(report) ||
    !prompts.every(
      (prompt): prompt is LegacySillyTavernReport["prompts"][number] =>
        isRecord(prompt) &&
        typeof prompt.sourceId === "string" &&
        (prompt.targetId === undefined || typeof prompt.targetId === "string"),
    )
  )
    return;
  return {
    ...(sourceGroupId === undefined ? {} : { groupId: sourceGroupId }),
    prompts,
    report: report.filter((entry) => validateDiagnostic(entry)),
  };
}

/** Local, read-only source attached to a live orchestration identity. */
export class SillyTavernSourceStore {
  readonly #directory: string;

  constructor(root: string) {
    this.#directory = join(root, "orchestration-sillytavern-sources");
  }

  async read(presetId: string): Promise<SillyTavernSourceSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.#directory, filename(presetId)), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const decoded = JSON.parse(raw) as unknown;
    if (
      !validateSnapshot(decoded) ||
      decoded.entries.some(
        (entry) =>
          (!entry.selected || entry.marker || entry.missing) &&
          (entry.content !== undefined ||
            entry.macros.length > 0 ||
            entry.targetEntryId !== undefined),
      )
    )
      throw new Error(
        "The local SillyTavern source snapshot could not be read",
      );
    return decoded;
  }

  async save(
    presetId: string,
    snapshot: SillyTavernSourceSnapshot,
  ): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, filename(presetId));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(presetId: string): Promise<void> {
    await rm(join(this.#directory, filename(presetId)), { force: true });
  }

  async removeOrphans(presetIds: string[]): Promise<void> {
    const live = new Set(presetIds.map(filename));
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      names
        .filter(
          (name) =>
            !live.has(name) &&
            /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/u.test(name),
        )
        .map((name) => rm(join(this.#directory, name), { force: true })),
    );
  }
}

function filename(presetId: string): string {
  return `${createHash("sha256").update(presetId).digest("hex")}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
