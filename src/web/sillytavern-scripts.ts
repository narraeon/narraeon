export interface ReadonlyScript {
  id: string;
  name: string;
  kind: "script" | "regex";
  enabled?: boolean;
  content?: string;
  reference?: string;
  findRegex?: string;
  replaceString?: string;
  rules: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Only project known fields from the uploaded preset, never arbitrary extension data. */
export function readScripts(source: string): ReadonlyScript[] {
  let root: Record<string, unknown> | undefined;
  try {
    root = object(JSON.parse(source) as unknown);
  } catch {
    return [];
  }
  const data = object(root?.data) ?? root;
  const extensions = object(data?.extensions);
  const scripts: ReadonlyScript[] = [];
  const pending: { entry: unknown; path: string; folder: string }[] = [];
  function enqueue(entries: unknown, path: string, folder: string): void {
    if (!Array.isArray(entries)) return;
    for (let index = entries.length - 1; index >= 0; index--)
      pending.push({
        entry: entries[index],
        path: `${path}[${index}]`,
        folder,
      });
  }
  enqueue(
    object(extensions?.tavern_helper)?.scripts,
    "extensions.tavern_helper.scripts",
    "",
  );
  while (pending.length) {
    const current = pending.pop()!;
    const item = object(current.entry);
    if (!item) continue;
    const name = string(item.name) ?? current.path;
    if (item.type === "folder")
      enqueue(
        item.scripts,
        `${current.path}.scripts`,
        `${current.folder}${name} / `,
      );
    else if (item.type === "script") {
      const enabled =
        typeof item.enabled === "boolean" ? item.enabled : undefined;
      const content = string(item.content);
      const reference =
        string(item.path) ?? string(item.url) ?? string(item.src);
      scripts.push({
        id: current.path,
        name: current.folder + name,
        kind: "script",
        ...(enabled === undefined ? {} : { enabled }),
        ...(content === undefined ? {} : { content }),
        ...(reference === undefined ? {} : { reference }),
        rules: [],
      });
    }
  }
  if (Array.isArray(extensions?.regex_scripts))
    for (const [index, entry] of extensions.regex_scripts.entries()) {
      const item = object(entry);
      if (!item) continue;
      const id = `extensions.regex_scripts[${index}]`;
      const findRegex = string(item.findRegex),
        replaceString = string(item.replaceString);
      const rules = [
        "placement",
        "disabled",
        "markdownOnly",
        "promptOnly",
        "runOnEdit",
        "substituteRegex",
        "minDepth",
        "maxDepth",
        "trimStrings",
      ].flatMap((key) => {
        const value = item[key];
        return typeof value === "string" ||
          typeof value === "boolean" ||
          typeof value === "number" ||
          (Array.isArray(value) &&
            value.every(
              (entry) => typeof entry === "string" || typeof entry === "number",
            ))
          ? [`${key}: ${JSON.stringify(value)}`]
          : [];
      });
      scripts.push({
        id,
        name: string(item.scriptName) ?? id,
        kind: "regex",
        ...(typeof item.disabled === "boolean"
          ? { enabled: !item.disabled }
          : {}),
        ...(findRegex === undefined ? {} : { findRegex }),
        ...(replaceString === undefined ? {} : { replaceString }),
        rules,
      });
    }
  return scripts;
}
