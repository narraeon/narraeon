import { builtinAuthorPrompts } from "../../shared/ordered-author-prompts.ts";
import {
  expandRetiredPrompts,
  customizePromptArrangement,
  resolvePromptArrangement,
  retiredBuiltinReplacements,
} from "../../shared/prompt-arrangement.ts";
import { createHash } from "node:crypto";
import { isMap, parseDocument } from "yaml";
import {
  builtinPlayPrompts,
  isPromptMessageRole,
  isTurnGuideLine,
  promptGroups,
  type OrderedPlayPrompt,
  type BuiltinPlayPrompt,
  type PromptGroup,
} from "../../shared/ordered-play-prompts.ts";

const promptName = /^[^\r\n\0]{1,160}$/u;

/** The same strict permission gate is used by portable imports and structured saves. */
export function parseOrderedPlayPrompts(
  value: unknown,
  catalog: BuiltinPlayPrompt[] = builtinPlayPrompts("en"),
  worldRequired = true,
): OrderedPlayPrompt[] {
  const fail = (): never => {
    throw new Error(
      "Invalid ordered play prompts: unique identities, current builtins, enabled mechanics and one world placeholder are required",
    );
  };
  if (!Array.isArray(value) || value.length > 256) return fail();
  const ids = new Set<string>();
  const builtins = new Set<string>();
  let worlds = 0;
  const entries = value.flatMap((raw): OrderedPlayPrompt[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return fail();
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,128}$/u.test(item.id) ||
      ids.has(item.id)
    )
      return fail();
    ids.add(item.id);
    if (
      item.messageRole !== undefined &&
      !isPromptMessageRole(item.messageRole)
    )
      return fail();
    const messageRole =
      item.messageRole === undefined ? {} : { messageRole: item.messageRole };
    const exact = (keys: string[], optional: string[] = []) =>
      Object.keys(item).every(
        (key) =>
          keys.includes(key) ||
          optional.includes(key) ||
          key === "messageRole" ||
          key === "id" ||
          key === "kind",
      ) && keys.every((key) => Object.hasOwn(item, key));
    const validTurnGuide =
      item.turnGuide === undefined ||
      (typeof item.turnGuide === "string" && isTurnGuideLine(item.turnGuide));
    const turnGuide =
      typeof item.turnGuide === "string" ? { turnGuide: item.turnGuide } : {};
    if (item.kind === "world" && exact(["id", "kind"])) {
      worlds++;
      return [{ id: item.id, kind: "world", ...messageRole }];
    }
    if (
      item.kind === "tail" &&
      exact(["id", "kind", "name", "enabled", "body"]) &&
      item.messageRole === undefined &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      promptName.test(item.name) &&
      typeof item.body === "string" &&
      isTurnGuideLine(item.body) &&
      typeof item.enabled === "boolean"
    )
      return [
        {
          id: item.id,
          kind: "tail",
          name: item.name,
          enabled: item.enabled,
          body: item.body,
        },
      ];
    if (
      item.kind === "user" &&
      exact(
        ["id", "kind", "name", "enabled", "body"],
        ["gameplay", "turnGuide"],
      ) &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      promptName.test(item.name) &&
      typeof item.body === "string" &&
      typeof item.enabled === "boolean" &&
      validTurnGuide &&
      (item.gameplay === undefined || item.gameplay === "tabletop")
    )
      return [
        {
          id: item.id,
          kind: "user",
          name: item.name,
          enabled: item.enabled,
          body: item.body,
          ...messageRole,
          ...(item.gameplay === "tabletop"
            ? { gameplay: "tabletop" as const }
            : {}),
          ...turnGuide,
        },
      ];
    // A frozen list (an old preset revision, or the preset a stored author
    // session captured) may still name a retired composite builtin. It reads
    // as the single-rule blocks that replaced it, exactly as the stored
    // library migrates it, so old bindings keep parsing and compiling.
    const retired =
      item.kind === "builtin" && typeof item.builtin === "string"
        ? retiredBuiltinReplacements[item.builtin]
        : undefined;
    if (
      retired !== undefined &&
      exact(["id", "kind", "builtin", "enabled"], ["turnGuide"]) &&
      validTurnGuide &&
      typeof item.enabled === "boolean"
    ) {
      if (builtins.has(item.builtin as string)) return fail();
      builtins.add(item.builtin as string);
      return [
        {
          id: item.id,
          kind: "builtin",
          builtin: item.builtin as string,
          enabled: item.enabled,
          ...messageRole,
          ...turnGuide,
        },
      ];
    }
    const builtin = catalog.find((entry) => entry.id === item.builtin);
    if (
      item.kind !== "builtin" ||
      !exact(["id", "kind", "builtin", "enabled"], ["turnGuide"]) ||
      !builtin ||
      builtins.has(builtin.id) ||
      typeof item.enabled !== "boolean" ||
      !validTurnGuide ||
      (builtin.required &&
        (!item.enabled ||
          (item.messageRole !== undefined && item.messageRole !== "system")))
    )
      return fail();
    builtins.add(builtin.id);
    return [
      {
        id: item.id,
        kind: "builtin",
        builtin: builtin.id,
        enabled: item.enabled,
        ...messageRole,
        ...turnGuide,
      },
    ];
  });
  const expanded = expandRetiredPrompts(entries);
  if (
    worlds !== (worldRequired ? 1 : 0) ||
    catalog.some((item) => {
      if (!item.required) return false;
      const entry = expanded.find(
        (entry) => entry.kind === "builtin" && entry.builtin === item.id,
      );
      return (
        entry?.kind !== "builtin" ||
        !entry.enabled ||
        (entry.messageRole !== undefined && entry.messageRole !== "system")
      );
    })
  )
    return fail();
  return expanded;
}

/** The required identities are part of each released list-format contract.
 * New catalog requirements apply after conversion, never while validating old bytes. */
export function releasedPromptRequiredIdentities(
  worldRequired: boolean,
): readonly string[] {
  return worldRequired
    ? ["play.mechanics"]
    : ["author.mechanics", "author.target"];
}

export function parseReleasedOrderedPrompts(
  value: unknown,
  catalog = builtinPlayPrompts("en"),
  worldRequired = true,
): OrderedPlayPrompt[] {
  const required = releasedPromptRequiredIdentities(worldRequired);
  return parseOrderedPlayPrompts(
    value,
    catalog.map((item) => ({ ...item, required: required.includes(item.id) })),
    worldRequired,
  );
}

function orderedPresetDocument(files: Record<string, string>) {
  const source = files["preset.yaml"];
  if (source === undefined) return undefined;
  const document = parseDocument(source, { uniqueKeys: true });
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    !isMap(document.contents) ||
    document.get("format") !== "narraeon.play-preset/v2"
  )
    return undefined;
  return document;
}

export const retiredPlayBuiltins = Object.keys(retiredBuiltinReplacements);

/** One-time released v2 -> v3 encoding conversion, never a catalog migration. */
export function upgradeOrderedPromptFormat(
  files: Record<string, string>,
): Record<string, string> {
  const document = orderedPresetDocument(files);
  if (!document) return files;
  try {
    const source = document.toJS() as {
      playPrompts: unknown;
      authorPrompts?: unknown;
    };
    document.set(
      "playPrompts",
      customizePromptArrangement(
        parseReleasedOrderedPrompts(source.playPrompts),
        builtinPlayPrompts("en"),
      ),
    );
    const author = document.get("authorPrompts");
    if (author !== undefined)
      document.set(
        "authorPrompts",
        customizePromptArrangement(
          parseReleasedOrderedPrompts(
            source.authorPrompts,
            builtinAuthorPrompts("en"),
            false,
          ),
          builtinAuthorPrompts("en"),
          false,
        ),
      );
    document.set("format", "narraeon.play-preset/v3");
    return { ...files, "preset.yaml": document.toString() };
  } catch {
    // Invalid drafts stay repairable, without dropping their original bytes.
    return files;
  }
}

/** Decode portable customizations through the same resolver used by every caller. */
export function parsePromptArrangement(
  value: unknown,
  catalog = builtinPlayPrompts("en"),
  worldRequired = true,
): OrderedPlayPrompt[] {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const fail = (): never => {
    throw new Error("Invalid prompt customizations");
  };
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) => !["entries", "overrides", "order", "groups"].includes(k),
    )
  )
    return fail();
  if (
    value.entries !== undefined &&
    (!Array.isArray(value.entries) ||
      value.entries.length > 256 ||
      value.entries.some((e) => !record(e) || e.kind === "builtin"))
  )
    return fail();
  const entries = (value.entries ?? []) as OrderedPlayPrompt[];
  const entryIds = new Set(entries.map((e) => e.id));
  if (
    entryIds.size !== entries.length ||
    entries.filter((e) => e.kind === "world").length > (worldRequired ? 1 : 0)
  )
    return fail();
  if (value.overrides !== undefined) {
    if (!Array.isArray(value.overrides) || value.overrides.length > 256)
      return fail();
    const seen = new Set<string>();
    const overrideIds = new Set<string>();
    for (const o of value.overrides) {
      if (
        !record(o) ||
        typeof o.builtin !== "string" ||
        seen.has(o.builtin) ||
        (!catalog.some((c) => c.id === o.builtin) &&
          !retiredBuiltinReplacements[o.builtin]) ||
        Object.keys(o).some(
          (k) =>
            !["builtin", "id", "enabled", "messageRole", "turnGuide"].includes(
              k,
            ),
        ) ||
        (o.enabled !== undefined && typeof o.enabled !== "boolean") ||
        (o.messageRole !== undefined && !isPromptMessageRole(o.messageRole)) ||
        (o.turnGuide !== undefined &&
          (typeof o.turnGuide !== "string" || !isTurnGuideLine(o.turnGuide))) ||
        (o.id !== undefined && typeof o.id !== "string")
      )
        return fail();
      if (typeof o.id === "string") {
        if (entryIds.has(o.id) || overrideIds.has(o.id)) return fail();
        overrideIds.add(o.id);
      }
      seen.add(o.builtin);
    }
  }
  if (
    value.order !== undefined &&
    (!Array.isArray(value.order) ||
      value.order.length > 512 ||
      value.order.some((k) => typeof k !== "string") ||
      new Set(value.order).size !== value.order.length)
  )
    return fail();
  if (
    Array.isArray(value.order) &&
    value.order.some((key) => {
      if (typeof key !== "string") return true;
      if (key.startsWith("entry:"))
        return (
          !entryIds.has(key.slice(6)) &&
          !(worldRequired && key === "entry:world")
        );
      return (
        !key.startsWith("builtin:") ||
        (!catalog.some((c) => c.id === key.slice(8)) &&
          !retiredBuiltinReplacements[key.slice(8)])
      );
    })
  )
    return fail();
  if (value.groups !== undefined) {
    if (!record(value.groups)) return fail();
    for (const [group, ids] of Object.entries(value.groups)) {
      if (
        !promptGroups.some((item) => item === group) ||
        !Array.isArray(ids) ||
        ids.some(
          (id) =>
            typeof id !== "string" ||
            !catalog.some(
              (c) =>
                (c.id === id ||
                  retiredBuiltinReplacements[id]?.some(
                    (r) => r.builtin === c.id,
                  )) &&
                c.group === group,
            ),
        ) ||
        new Set(ids).size !== ids.length
      )
        return fail();
    }
  }
  return parseOrderedPlayPrompts(
    resolvePromptArrangement(value, catalog, worldRequired),
    catalog,
    worldRequired,
  );
}

/** A choice group's entries: the first member enabled, the rest disabled. */
function groupPromptEntries(group: PromptGroup): OrderedPlayPrompt[] {
  return builtinPlayPrompts("en")
    .filter((item) => item.group === group)
    .map(({ id }, index) => ({
      id,
      kind: "builtin",
      builtin: id,
      enabled: index === 0,
    }));
}

/** Recognized v1 content becomes user text, never a locked builtin inferred from a path. */
export function migrateLegacyPlayPrompts(
  files: Record<string, string>,
  narrative: { path: string }[],
  excludedPaths: string[] = [],
): OrderedPlayPrompt[] {
  const document = parseDocument(files["frame.yaml"] ?? "", {
    uniqueKeys: true,
    strict: true,
  });
  const frame: unknown = document.toJS({ maxAliasCount: 0 });
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const roles = ["runtime_system", "author_instruction", "world_context"];
  if (
    document.errors.length ||
    document.warnings.length ||
    !record(frame) ||
    frame.format !== "narraeon.host-frame/v1" ||
    !record(frame.roles) ||
    Object.keys(frame.roles).length !== 3
  )
    throw new Error("Legacy host frame is invalid; repair it before migrating");
  const items: Record<string, { markdown?: string; include?: string }[]> = {};
  const runtime = new Set<string>();
  let worldInstructions = 0;
  let worldContext = 0;
  let coverage = 0;
  for (const role of roles) {
    items[role] = [];
    const roleItems: unknown = frame.roles[role];
    if (!Array.isArray(roleItems))
      throw new Error("Legacy host role must be an array");
    for (const item of roleItems as unknown[]) {
      if (!record(item) || Object.keys(item).length !== 1)
        throw new Error("Legacy host entry is invalid");
      if (role === "author_instruction" && typeof item.markdown === "string")
        items[role].push({ markdown: item.markdown });
      else if (
        role === "author_instruction" &&
        item.include === "world.instructions"
      ) {
        worldInstructions++;
        items[role].push({ include: item.include });
      } else if (role === "world_context" && item.include === "world.context") {
        worldContext++;
        items[role].push({ include: item.include });
      } else if (
        role === "world_context" &&
        item.builtin === "runtime.coverage"
      )
        coverage++;
      else if (
        role === "runtime_system" &&
        typeof item.builtin === "string" &&
        [
          "runtime.play-contract",
          "runtime.tool-contract",
          "runtime.operation-contract",
        ].includes(item.builtin) &&
        !runtime.has(item.builtin)
      )
        runtime.add(item.builtin);
      else throw new Error("Legacy host entry is unknown or misplaced");
    }
  }
  if (
    runtime.size !== 3 ||
    coverage !== 1 ||
    worldInstructions !== 1 ||
    worldContext !== 1
  )
    throw new Error(
      "Legacy host frame is missing or duplicates required includes",
    );
  const entries: OrderedPlayPrompt[] = [
    {
      id: "play.mechanics",
      kind: "builtin",
      builtin: "play.mechanics",
      enabled: true,
    },
  ];
  const used = new Set<string>(excludedPaths);
  const occurrences = new Map<string, number>();
  let world = false;
  const add = (path: string, enabled: boolean) => {
    if (!enabled && used.has(path)) return;
    const occurrence = occurrences.get(path) ?? 0;
    occurrences.set(path, occurrence + 1);
    used.add(path);
    const body = files[path];
    if (body === undefined) throw new Error(`Missing legacy prompt: ${path}`);
    const heading = /^#[ \t]+([^\r\n]+)$/mu.exec(body)?.[1]?.trim() ?? "";
    const stem = path.replace(/^.*\//u, "").replace(/\.md$/u, "");
    const name =
      heading.length > 0 ? heading : stem.length > 0 ? stem : "Prompt";
    entries.push({
      id: `legacy-${createHash("sha256").update(path).digest("hex").slice(0, 32)}-${occurrence}`,
      kind: "user",
      name: name.slice(0, 160),
      enabled,
      body,
    });
  };
  for (const role of [
    "runtime_system",
    "author_instruction",
    "world_context",
  ]) {
    for (const item of items[role] ?? []) {
      if (item.markdown) add(item.markdown, true);
      if (item.include?.startsWith("world.") && !world) {
        entries.push({ id: "world", kind: "world" });
        world = true;
      }
    }
    if (role === "author_instruction")
      for (const prompt of narrative) add(prompt.path, true);
  }
  if (!world) entries.push({ id: "world", kind: "world" });
  for (const path of Object.keys(files).sort())
    if (
      (path.startsWith("blocks/") || path.startsWith("prompts/")) &&
      path.endsWith(".md")
    )
      add(path, false);
  // Converted presets gain the choice-group builtins and then the tabletop
  // builtin just before the world placeholder. The legacy block copies keep
  // their own wording as user text; the current builtins arrive beside them.
  const worldIndex = entries.findIndex((entry) => entry.kind === "world");
  entries.splice(
    worldIndex,
    0,
    ...promptGroups.flatMap((group) => groupPromptEntries(group)),
    {
      id: "play.tabletop",
      kind: "builtin",
      builtin: "play.tabletop",
      enabled: true,
    },
  );
  const listed = new Set(
    entries.flatMap((entry) =>
      entry.kind === "builtin" ? [entry.builtin] : [],
    ),
  );
  entries.splice(
    entries.findIndex(
      (entry) => entry.kind === "builtin" && entry.builtin === "play.tabletop",
    ),
    0,
    ...builtinPlayPrompts("en")
      .filter((item) => !listed.has(item.id))
      .map((item) => ({
        id: item.id,
        kind: "builtin" as const,
        builtin: item.id,
        enabled: false,
      })),
  );
  return entries;
}
