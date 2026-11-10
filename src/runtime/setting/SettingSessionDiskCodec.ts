import type { StoredSettingImprovementSession } from "./FileNativeSettingImprovementStore.ts";

type Fields = Record<string, unknown>;
type Reference = (value: unknown) => unknown;
interface SnapshotFields {
  compilation: Reference;
  preset: Reference;
}

// Only declared snapshot positions participate. Provider payloads and arbitrary
// author JSON may contain any field names and must remain opaque.
function record(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid setting session snapshot structure");
  return value as Fields;
}

function mapRecords(value: unknown, map: (entry: Fields) => Fields) {
  if (!Array.isArray(value))
    throw new Error("Invalid setting session snapshot list");
  return value.map((entry: unknown) => map(record(entry)));
}

function mapSession(
  session: Fields,
  refs: SnapshotFields,
  nested = false,
): Fields {
  const result: Fields = {
    ...session,
    bootstrap: refs.compilation(session.bootstrap),
  };
  if (session.playPreset !== undefined)
    result.playPreset = refs.preset(session.playPreset);
  if (session.requests !== undefined) {
    result.requests = mapRecords(session.requests, (request) => ({
      ...request,
      bootstrap: refs.compilation(request.bootstrap),
      playPreset: refs.preset(request.playPreset),
      ...(request.retryAttempts === undefined
        ? {}
        : {
            retryAttempts: mapRecords(request.retryAttempts, (attempt) => ({
              ...attempt,
              compilation: refs.compilation(attempt.compilation),
            })),
          }),
    }));
  }
  if (session.partialResponse !== undefined) {
    const partial = record(session.partialResponse);
    const request = record(partial.request);
    result.partialResponse = {
      ...partial,
      request: { ...request, bootstrap: refs.compilation(request.bootstrap) },
    };
  }
  if (session.pendingEdit !== undefined) {
    if (nested) throw new Error("Nested setting session edit is invalid");
    const edit = record(session.pendingEdit);
    result.pendingEdit = {
      ...edit,
      next: mapSession(record(edit.next), refs, true),
    };
  }
  return result;
}

function mapPreset(value: unknown, files: Reference): Fields {
  const preset = record(value);
  const definition = record(preset.definition);
  return {
    ...preset,
    files: files(preset.files),
    definition: { ...definition, files: files(definition.files) },
  };
}

function writer(kind: string) {
  const entries: unknown[] = [];
  const ids = new Map<string, string>();
  return {
    entries,
    ref: (value: unknown) => {
      const key = JSON.stringify(value);
      const found = ids.get(key);
      if (found !== undefined) return found;
      const id = kind + "/" + entries.length;
      entries.push(value);
      ids.set(key, id);
      return id;
    },
  };
}

function reader(kind: string, entries: unknown) {
  if (!Array.isArray(entries))
    throw new Error("Missing setting session snapshot table");
  const used = new Set<number>();
  return {
    get(id: unknown): unknown {
      if (typeof id !== "string" || !id.startsWith(kind + "/"))
        throw new Error("Invalid setting session snapshot reference type");
      const index = Number(id.slice(kind.length + 1));
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= entries.length ||
        id !== kind + "/" + index
      )
        throw new Error("Invalid setting session snapshot reference");
      used.add(index);
      return entries[index];
    },
    check() {
      if (used.size !== entries.length)
        throw new Error("Unreferenced setting session snapshot");
    },
  };
}

/** The runtime keeps the full v6 conversation. v7 is solely its disk representation. */
export function encodeSettingSession(
  session: StoredSettingImprovementSession,
): unknown {
  if (session.schemaVersion !== 6) return session;
  const compilations = writer("compilation");
  const presets = writer("preset");
  const files = writer("files");
  const fields = mapSession(record(session), {
    compilation: compilations.ref,
    preset: (value) => presets.ref(mapPreset(value, files.ref)),
  });
  return {
    ...fields,
    schemaVersion: 7,
    frozen: {
      compilations: compilations.entries,
      presets: presets.entries,
      files: files.entries,
    },
  };
}

/** Expand only the disk representation; the existing full-session codec validates its contents. */
export function decodeSettingSession(value: unknown): unknown {
  const session = record(value);
  if (session.schemaVersion !== 7) return session;
  const { frozen, ...fields } = session;
  const tables = record(frozen);
  if (Object.keys(tables).length !== 3)
    throw new Error("Invalid setting session snapshot tables");
  const compilations = reader("compilation", tables.compilations);
  const presets = reader("preset", tables.presets);
  const files = reader("files", tables.files);
  const expanded = mapSession(fields, {
    compilation: (id) => structuredClone(compilations.get(id)),
    preset: (id) =>
      mapPreset(structuredClone(presets.get(id)), (ref) =>
        structuredClone(files.get(ref)),
      ),
  });
  compilations.check();
  presets.check();
  files.check();
  return { ...expanded, schemaVersion: 6 };
}
