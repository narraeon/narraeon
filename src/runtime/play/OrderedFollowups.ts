import type {
  PlayPresetDefinition,
  PlayPresetFollowupDefinition,
} from "./FileNativePlayPresetStore.ts";
import { builtinFollowupExample } from "../../shared/ordered-followups.ts";
import type { FollowupItem } from "../../shared/ordered-followups.ts";

/** Strict portable permissions, shared by import and structured saves. */
export function parseFollowupItems(
  value: unknown,
  definitions: readonly { id: string }[],
): FollowupItem[] {
  if (!Array.isArray(value))
    throw new Error("Follow-up order must be an array");
  const items: FollowupItem[] = value.map((raw: unknown) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("id" in raw) ||
      !("kind" in raw) ||
      !("enabled" in raw) ||
      Object.keys(raw).some(
        (key) => !["id", "kind", "enabled"].includes(key),
      ) ||
      typeof raw.id !== "string" ||
      typeof raw.enabled !== "boolean" ||
      !["user", "builtin", "content-package"].includes(String(raw.kind))
    )
      throw new Error(
        "Invalid follow-up reference; system content is read-only",
      );
    return {
      id: raw.id,
      kind: raw.kind as FollowupItem["kind"],
      enabled: raw.enabled,
    };
  });
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.filter((item) => item.kind === "builtin").length !== 1 ||
    !items.some(
      (item) => item.kind === "builtin" && item.id === "builtin:summary",
    ) ||
    items.filter((item) => item.kind === "content-package").length !== 1 ||
    !items.some(
      (item) =>
        item.kind === "content-package" && item.id === "package:followups",
    ) ||
    items.filter((item) => item.kind === "user").length !==
      definitions.length ||
    definitions.some(
      (def) =>
        !items.some((item) => item.kind === "user" && item.id === def.id),
    )
  )
    throw new Error(
      "Follow-up order must contain every user request, the read-only system example and content-package group exactly once",
    );
  return items;
}

/** Empty package groups intentionally expand to nothing until a world supplies definitions. */
export function effectiveFollowupDefinitions(
  definition: PlayPresetDefinition,
  locale: "en" | "zh-CN",
): {
  definition: PlayPresetFollowupDefinition;
  body: string | undefined;
}[] {
  if (definition.followupItems === undefined)
    return definition.followups.map((entry) => ({
      definition: entry,
      body: definition.files[entry.prompt.path],
    }));
  return definition.followupItems.flatMap<{
    definition: PlayPresetFollowupDefinition;
    body: string | undefined;
  }>((item) => {
    if (!item.enabled || item.kind === "content-package") return [];
    if (item.kind === "builtin") return [builtinFollowupExample(locale)];
    const entry = definition.followups.find((entry) => entry.id === item.id);
    if (entry === undefined)
      throw new Error(`Missing follow-up definition: ${item.id}`);
    return [{ definition: entry, body: definition.files[entry.prompt.path] }];
  });
}
