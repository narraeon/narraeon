import {
  defaultEnabledBuiltin,
  type BuiltinPlayPrompt,
  type OrderedPlayPrompt,
  type PromptMessageRole,
  type PromptGroup,
} from "./ordered-play-prompts.ts";

/** Only user content and explicit deviations belong to the portable preset. */
export interface PromptArrangement {
  entries?: OrderedPlayPrompt[];
  overrides?: {
    builtin: string;
    id?: string;
    enabled?: boolean;
    messageRole?: PromptMessageRole;
    turnGuide?: string;
  }[];
  /** Keys refer to builtin identities or user/world identities, never catalog positions. */
  order?: string[];
  groups?: Partial<Record<PromptGroup, string[]>>;
}

export const retiredBuiltinReplacements: Record<
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

export function promptArrangementKey(entry: OrderedPlayPrompt): string {
  return entry.kind === "builtin"
    ? `builtin:${entry.builtin}`
    : `entry:${entry.id}`;
}

function reserveBuiltinPromptId(
  preferred: string,
  builtin: string,
  used: Set<string>,
): string {
  let id = preferred;
  let suffix = 0;
  while (used.has(id)) id = `builtin-${builtin}-${++suffix}`;
  used.add(id);
  return id;
}

/** Expand retired identities in place; an explicit successor always wins. */
export function expandRetiredPrompts(
  entries: readonly OrderedPlayPrompt[],
): OrderedPlayPrompt[] {
  const explicit = new Set(
    entries.flatMap((e) => (e.kind === "builtin" ? [e.builtin] : [])),
  );
  const usedIds = new Set(
    entries
      .filter(
        (entry) =>
          entry.kind !== "builtin" ||
          !retiredBuiltinReplacements[entry.builtin],
      )
      .map((entry) => entry.id),
  );
  return entries.flatMap((entry): OrderedPlayPrompt[] => {
    if (entry.kind !== "builtin") return [entry];
    const replacements = retiredBuiltinReplacements[entry.builtin];
    if (!replacements) return [entry];
    return replacements
      .filter((r) => !explicit.has(r.builtin))
      .map(({ builtin, selected }) => {
        const id = reserveBuiltinPromptId(builtin, builtin, usedIds);
        return {
          ...entry,
          id,
          builtin,
          enabled: selected === false ? false : entry.enabled,
        };
      });
  });
}

/**
 * Missing defaults follow the nearest preceding catalog neighbor, otherwise the
 * nearest following neighbor. Existing entries never move relative to each other.
 */
export function resolvePromptArrangement(
  arrangement: PromptArrangement,
  catalog: readonly BuiltinPlayPrompt[],
  worldRequired = true,
): OrderedPlayPrompt[] {
  const defaults: OrderedPlayPrompt[] = catalog.map((item) => ({
    id: item.id,
    kind: "builtin",
    builtin: item.id,
    enabled: defaultEnabledBuiltin(item, catalog),
  }));
  if (worldRequired) defaults.push({ id: "world", kind: "world" });
  const overrides = expandRetiredPrompts(
    (arrangement.overrides ?? []).map((o) => ({
      ...o,
      id: o.id ?? o.builtin,
      kind: "builtin" as const,
      enabled:
        o.enabled ??
        (catalog.some((c) => c.id === o.builtin)
          ? defaultEnabledBuiltin(
              catalog.find((c) => c.id === o.builtin)!,
              catalog,
            )
          : true),
    })),
  );
  const values = defaults.map((entry) => {
    if (entry.kind !== "builtin") return entry;
    const override = overrides.find(
      (o) => o.kind === "builtin" && o.builtin === entry.builtin,
    );
    const item = catalog.find((c) => c.id === entry.builtin)!;
    const selection =
      item.group === undefined ? undefined : arrangement.groups?.[item.group];
    const selected = selection?.flatMap(
      (id) =>
        retiredBuiltinReplacements[id]
          ?.filter((r) => r.selected !== false)
          .map((r) => r.builtin) ?? [id],
    );
    return {
      ...entry,
      ...override,
      ...(selected === undefined
        ? {}
        : { enabled: selected.includes(item.id) }),
    };
  });
  const custom = structuredClone(arrangement.entries ?? []);
  const world = custom.find((e) => e.kind === "world");
  if (world !== undefined)
    values.splice(
      values.findIndex((e) => e.kind === "world"),
      1,
      world,
    );
  values.push(...custom.filter((e) => e.kind !== "world"));
  // A newly shipped identity must not collide with an existing user's identity.
  const aliases = new Map(
    (arrangement.overrides ?? []).flatMap((override) =>
      override.id === undefined ||
      !catalog.some((item) => item.id === override.builtin)
        ? []
        : [[override.builtin, override.id] as const],
    ),
  );
  const usedIds = new Set([...custom.map((e) => e.id), ...aliases.values()]);
  for (const entry of values) {
    if (entry.kind !== "builtin") continue;
    entry.id =
      aliases.get(entry.builtin) ??
      reserveBuiltinPromptId(entry.id, entry.builtin, usedIds);
  }
  const byKey = new Map(values.map((e) => [promptArrangementKey(e), e]));
  const explicitOrder = new Set(arrangement.order ?? []);
  const order = (arrangement.order ?? []).flatMap((key) => {
    const old = key.startsWith("builtin:")
      ? retiredBuiltinReplacements[key.slice(8)]
      : undefined;
    return old
      ? old
          .filter((r) => !explicitOrder.has(`builtin:${r.builtin}`))
          .map((r) => `builtin:${r.builtin}`)
      : [key];
  });
  const result: OrderedPlayPrompt[] = [];
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry && !result.includes(entry)) result.push(entry);
  }
  const defaultKeys = defaults.map(promptArrangementKey);
  for (const entry of values) {
    if (result.includes(entry)) continue;
    const position = defaultKeys.indexOf(promptArrangementKey(entry));
    const previous = defaultKeys
      .slice(0, position)
      .reverse()
      .map((key) => result.findIndex((e) => promptArrangementKey(e) === key))
      .find((i) => i >= 0);
    const following = defaultKeys
      .slice(position + 1)
      .map((key) => result.findIndex((e) => promptArrangementKey(e) === key))
      .find((i) => i >= 0);
    const at =
      position < 0
        ? result.length
        : previous !== undefined
          ? previous + 1
          : (following ?? result.length);
    result.splice(at, 0, entry);
  }
  return result;
}

export function customizePromptArrangement(
  input: readonly OrderedPlayPrompt[],
  catalog: readonly BuiltinPlayPrompt[],
  worldRequired = true,
): PromptArrangement {
  const entries = expandRetiredPrompts(input);
  const arrangement: PromptArrangement = {};
  const custom = entries.filter(
    (e) =>
      e.kind !== "builtin" &&
      !(e.kind === "world" && e.id === "world" && e.messageRole === undefined),
  );
  if (custom.length) arrangement.entries = structuredClone(custom);
  const overrides: NonNullable<PromptArrangement["overrides"]> = [];
  for (const entry of entries) {
    if (entry.kind !== "builtin") continue;
    const item = catalog.find((c) => c.id === entry.builtin);
    if (!item) throw new Error(`Unknown builtin: ${entry.builtin}`);
    const override: NonNullable<PromptArrangement["overrides"]>[number] = {
      builtin: entry.builtin,
    };
    if (entry.id !== entry.builtin) override.id = entry.id;
    if (
      item.group === undefined &&
      (!entry.enabled || entry.enabled !== defaultEnabledBuiltin(item, catalog))
    )
      override.enabled = entry.enabled;
    if (entry.messageRole !== undefined)
      override.messageRole = entry.messageRole;
    if (entry.turnGuide !== undefined) override.turnGuide = entry.turnGuide;
    if (Object.keys(override).length > 1) overrides.push(override);
    if (item.group !== undefined) {
      arrangement.groups ??= {};
      arrangement.groups[item.group] ??= [];
      if (entry.enabled) arrangement.groups[item.group]!.push(item.id);
    }
  }
  if (overrides.length) arrangement.overrides = overrides;
  const keys = entries.map(promptArrangementKey);
  const effective = resolvePromptArrangement(
    arrangement,
    catalog,
    worldRequired,
  );
  const existing = new Set(keys);
  if (
    JSON.stringify(keys) !==
    JSON.stringify(
      effective.map(promptArrangementKey).filter((key) => existing.has(key)),
    )
  )
    arrangement.order = keys;
  return arrangement;
}
