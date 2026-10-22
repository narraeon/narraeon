import { createHash } from "node:crypto";
import { isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import {
  builtinPlayPrompts,
  isPromptMessageRole,
  promptGroups,
  type OrderedPlayPrompt,
  type BuiltinPlayPrompt,
  type PromptGroup,
} from "../../shared/ordered-play-prompts.ts";

/** One turn-guide line: no line breaks, bounded length; empty clears a builtin default. */
const turnGuideLine = /^[^\r\n\0]{0,1000}$/u;
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
      (typeof item.turnGuide === "string" &&
        turnGuideLine.test(item.turnGuide));
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
      turnGuideLine.test(item.body) &&
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
      exact(["id", "kind", "builtin", "enabled"]) &&
      typeof item.enabled === "boolean"
    ) {
      const enabled = item.enabled;
      return retired.flatMap(({ builtin, selected }) => {
        if (builtins.has(builtin) || ids.has(builtin)) return [];
        builtins.add(builtin);
        ids.add(builtin);
        return [
          {
            id: builtin,
            kind: "builtin" as const,
            builtin,
            enabled: selected === false ? false : enabled,
            ...messageRole,
          },
        ];
      });
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
  if (
    worlds !== (worldRequired ? 1 : 0) ||
    catalog.some((item) => item.required && !builtins.has(item.id))
  )
    return fail();
  return entries;
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

/**
 * Insert the tabletop builtins that an ordered preset does not list yet.
 * play.tabletop goes just before the world placeholder and author.tabletop just
 * after author.guidance. Files that are not ordered v2 or do not parse come back
 * unchanged, and nothing else in them is rewritten. The same object is returned
 * when nothing needs inserting, so callers can detect a change by identity.
 */
export function withTabletopPromptBuiltins(
  files: Record<string, string>,
): Record<string, string> {
  const document = orderedPresetDocument(files);
  if (document === undefined) return files;
  let changed = false;
  const playPrompts = document.get("playPrompts", true);
  if (isSeq(playPrompts) && !hasEntry(playPrompts, "play.tabletop")) {
    const world = playPrompts.items.findIndex(
      (item) => entryField(item, "kind") === "world",
    );
    playPrompts.items.splice(
      world < 0 ? playPrompts.items.length : world,
      0,
      document.createNode({
        id: "play.tabletop",
        kind: "builtin",
        builtin: "play.tabletop",
        enabled: true,
      }),
    );
    changed = true;
  }
  const authorPrompts = document.get("authorPrompts", true);
  if (isSeq(authorPrompts) && !hasEntry(authorPrompts, "author.tabletop")) {
    const guidance = authorPrompts.items.findIndex(
      (item) => entryField(item, "id") === "author.guidance",
    );
    authorPrompts.items.splice(
      guidance < 0 ? authorPrompts.items.length : guidance + 1,
      0,
      document.createNode({
        id: "author.tabletop",
        kind: "builtin",
        builtin: "author.tabletop",
        enabled: true,
      }),
    );
    changed = true;
  }
  return changed ? { ...files, "preset.yaml": document.toString() } : files;
}

/**
 * The retired composite builtins and the blocks that replaced each of them.
 * A stored entry for a retired builtin is replaced in place by its successors,
 * which inherit its enabled state and message role; the unselected members of
 * a choice group arrive disabled. User copies of the old text are not touched.
 */
const retiredBuiltinReplacements: Record<
  string,
  { builtin: string; selected?: boolean }[]
> = {
  "play.style": [{ builtin: "play.prose" }, { builtin: "play.scene" }],
  "play.adjudication": [
    { builtin: "play.agency-default" },
    { builtin: "play.agency-strict", selected: false },
    { builtin: "play.agency-open", selected: false },
    { builtin: "play.facts" },
    { builtin: "play.npc" },
  ],
  "play.narrative": [
    { builtin: "play.stop-beat" },
    { builtin: "play.stop-scene", selected: false },
    { builtin: "play.ending" },
    { builtin: "play.output" },
  ],
  "play.state": [
    { builtin: "play.save-timing" },
    { builtin: "play.ownership" },
    { builtin: "play.situation" },
    { builtin: "play.checkpoint-policy" },
  ],
};

export const retiredPlayBuiltins = Object.keys(retiredBuiltinReplacements);

/**
 * Replace the retired composite builtins (style, adjudication, narrative and
 * state) with the single-rule blocks that succeeded them, each at the old
 * entry's position. Same identity contract as the other insertions.
 */
export function withRestructuredPromptBuiltins(
  files: Record<string, string>,
): Record<string, string> {
  const document = orderedPresetDocument(files);
  if (document === undefined) return files;
  const playPrompts = document.get("playPrompts", true);
  if (!isSeq(playPrompts)) return files;
  let changed = false;
  for (const [retired, replacements] of Object.entries(
    retiredBuiltinReplacements,
  )) {
    const at = playPrompts.items.findIndex(
      (item) =>
        entryField(item, "kind") === "builtin" &&
        entryField(item, "builtin") === retired,
    );
    if (at < 0) continue;
    const old = playPrompts.items[at];
    const enabled = entryField(old, "enabled") === true;
    const messageRole = entryField(old, "messageRole");
    const successors = replacements
      .filter(({ builtin }) => !hasEntry(playPrompts, builtin))
      .map(({ builtin, selected }) =>
        document.createNode({
          id: builtin,
          kind: "builtin",
          builtin,
          enabled: selected === false ? false : enabled,
          ...(typeof messageRole === "string" ? { messageRole } : {}),
        }),
      );
    playPrompts.items.splice(at, 1, ...successors);
    changed = true;
  }
  return changed ? { ...files, "preset.yaml": document.toString() } : files;
}

/**
 * A group of alternative builtins (one enabled, the rest disabled) that a
 * stored preset may still lack. It is inserted right after the first of
 * `after` that the list contains, or before the first of `before` (or the
 * world placeholder) when none is present. A preset that already lists any
 * member is left alone, so a player who swapped them keeps that choice.
 */
interface AlternativeBuiltinGroup {
  after: string[];
  before: string[];
  entries: OrderedPlayPrompt[];
}

const alternativeGroups = (): AlternativeBuiltinGroup[] => {
  const members = (group: PromptGroup) =>
    builtinPlayPrompts("en")
      .filter((item) => item.group === group)
      .map(({ id }) => id);
  const order = promptGroups.map((group) => members(group));
  // The default list runs mechanics, then the choice groups in `promptGroups`
  // order, then the policy blocks: a missing group lands after the previous
  // group (or mechanics), else ahead of the first later group or policy block.
  return promptGroups.map((group, index) => ({
    after: [...order.slice(0, index).flat().reverse(), "play.mechanics"],
    before: [
      ...order.slice(index + 1).flat(),
      "play.prose",
      "play.scene",
      "play.ending",
      "play.output",
      "play.facts",
      "play.tabletop",
    ],
    entries: groupPromptEntries(group),
  }));
};

/**
 * Insert the choice-group builtins (person, continuation, agency, stopping)
 * that an ordered preset does not list yet. Same identity contract as the
 * tabletop insertion.
 */
export function withAlternativePromptBuiltins(
  files: Record<string, string>,
): Record<string, string> {
  const document = orderedPresetDocument(files);
  if (document === undefined) return files;
  const playPrompts = document.get("playPrompts", true);
  if (!isSeq(playPrompts)) return files;
  let changed = false;
  for (const group of alternativeGroups()) {
    if (group.entries.some((entry) => hasEntry(playPrompts, entry.id)))
      continue;
    const anchor = group.after
      .map((id) =>
        playPrompts.items.findIndex((item) => entryField(item, "id") === id),
      )
      .find((index) => index >= 0);
    const fallback = playPrompts.items.findIndex((item) => {
      const id = entryField(item, "id");
      return (
        (typeof id === "string" && group.before.includes(id)) ||
        entryField(item, "kind") === "world"
      );
    });
    const at =
      anchor !== undefined
        ? anchor + 1
        : fallback >= 0
          ? fallback
          : playPrompts.items.length;
    playPrompts.items.splice(
      at,
      0,
      ...group.entries.map((entry) => document.createNode(entry)),
    );
    changed = true;
  }
  return changed ? { ...files, "preset.yaml": document.toString() } : files;
}

/** Every builtin upgrade a stored or imported ordered preset must receive. */
export function withCurrentPromptBuiltins(
  files: Record<string, string>,
): Record<string, string> {
  return withAlternativePromptBuiltins(
    withRestructuredPromptBuiltins(withTabletopPromptBuiltins(files)),
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

function hasEntry(sequence: YAMLSeq, id: string): boolean {
  return sequence.items.some((item) => entryField(item, "id") === id);
}

function entryField(item: unknown, key: string): unknown {
  return isMap(item) ? item.get(key) : undefined;
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
  return entries;
}
