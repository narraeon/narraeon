import { isAlias, isNode, parseDocument, visit } from "yaml";
import {
  parseFollowups,
  parsePlayPresetRegexAsset,
  type PlayPresetFollowupDefinition,
  type PlayPresetMount,
} from "../play/FileNativePlayPresetStore.ts";
import type { ContentTreeFile } from "./ContentTreeFile.ts";

export interface PackageFollowup {
  definition: PlayPresetFollowupDefinition;
  enabled: boolean;
  mount: PlayPresetMount["mount"];
}

/** The world owns the copied control tree; source-package metadata is never consulted. */
export function readPackageFollowups(files: readonly ContentTreeFile[]): {
  followups: PackageFollowup[];
  files: Record<string, string>;
} {
  const source = files.find(({ path }) => path === "control/followups.yaml");
  const resources = Object.fromEntries(
    files
      .filter(
        ({ path, encoding }) =>
          path.startsWith("control/") && encoding === undefined,
      )
      .map(({ path, contents }) => [path.slice("control/".length), contents]),
  );
  if (source === undefined) return { followups: [], files: resources };
  if (source.encoding !== undefined)
    throw new Error("Package followups must be UTF-8 YAML");
  const document = parseDocument(source.contents, { uniqueKeys: true });
  let unsafe = false;
  visit(document, (_, node) => {
    if (
      isAlias(node) ||
      (isNode(node) &&
        (node.tag !== undefined || ("anchor" in node && Boolean(node.anchor))))
    )
      unsafe = true;
  });
  if (unsafe || document.errors.length > 0 || document.warnings.length > 0)
    throw new Error(
      "Invalid package followups YAML: aliases, tags and duplicate keys are not allowed",
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (
    !record(value) ||
    value.format !== "narraeon.package-followups/v1" ||
    Object.keys(value).some((key) => !["format", "followups"].includes(key)) ||
    !Array.isArray(value.followups)
  )
    throw new Error(
      "Expected narraeon.package-followups/v1 with a followups array",
    );
  const controls = value.followups.map((raw: unknown) => {
    if (
      !record(raw) ||
      typeof raw.enabled !== "boolean" ||
      typeof raw.mount !== "string" ||
      ![
        "story",
        "sidebar",
        "composer_above",
        "composer_below",
        "overlay",
        "debug",
      ].includes(raw.mount)
    )
      throw new Error(
        "Every package followup requires a boolean enabled and valid mount",
      );
    const { enabled, mount, ...definition } = raw;
    return { enabled, mount: mount as PlayPresetMount["mount"], definition };
  });
  const definitions = parseFollowups(
    controls.map((item) => item.definition),
    resources,
  );
  for (const definition of definitions)
    for (const artifact of definition.artifacts) {
      if (artifact.regex !== undefined)
        parsePlayPresetRegexAsset(resources[artifact.regex]!, artifact.regex);
    }
  return {
    followups: definitions.map((definition, index) => ({
      ...controls[index]!,
      definition,
    })),
    files: resources,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPackageFollowupControlPath(path: string): boolean {
  return (
    path === "control/followups.yaml" ||
    /^control\/(?:prompts\/[A-Za-z0-9._-]+\.md|renderers\/[A-Za-z0-9._-]+\.html|scripts\/[A-Za-z0-9._-]+\.js|regex\/[A-Za-z0-9._-]+\.yaml|assets\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/u.test(
      path,
    )
  );
}

/** Authorization and compilation must freeze the exact same request resource closure. */
export function packageFollowupResources(
  definition: PlayPresetFollowupDefinition,
  files: Record<string, string>,
): Record<string, string> {
  const paths = new Set(
    definition.artifacts.flatMap((artifact) =>
      [
        artifact.renderer,
        artifact.regex,
        ...(artifact.scripts ?? []),
        ...(artifact.assets ?? []),
      ].filter((path): path is string => path !== undefined),
    ),
  );
  return Object.fromEntries(
    [...paths].map((path) => {
      const source = files[path];
      if (source === undefined)
        throw new Error(`Missing package followup resource: ${path}`);
      return [path, source];
    }),
  );
}
