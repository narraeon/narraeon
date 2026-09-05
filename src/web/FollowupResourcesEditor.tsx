import { uiText } from "./i18n.ts";

/** Edit author resources in place; paths are assigned only when a resource is added. */
export function FollowupResourcesEditor({
  files,
  renderer,
  scripts,
  assets,
  onWrite,
  onAttach,
}: {
  files: Record<string, string>;
  renderer: string | undefined;
  scripts: string[] | undefined;
  assets: string[] | undefined;
  onWrite: (path: string, body: string) => void;
  onAttach: (
    kind: "renderer" | "scripts" | "assets",
    path: string,
    body: string,
  ) => void;
}): React.JSX.Element {
  const kinds = [
    {
      kind: "renderer" as const,
      label: "HTML 模板",
      paths: renderer ? [renderer] : [],
      directory: "renderers",
      suffix: "html",
      initial: "<main><!-- narraeon:content --></main>",
    },
    {
      kind: "scripts" as const,
      label: "JavaScript",
      paths: scripts ?? [],
      directory: "scripts",
      suffix: "js",
      initial: "// Render the artifact using the extension bridge.\n",
    },
    {
      kind: "assets" as const,
      label: "样式与资源",
      paths: assets ?? [],
      directory: "assets",
      suffix: "css",
      initial: "body { font-family: sans-serif; }\n",
    },
  ];
  return (
    <details>
      <summary>{uiText("编辑渲染资源")}</summary>
      {kinds.map((entry) => (
        <section key={entry.kind}>
          <h6>{uiText(entry.label)}</h6>
          {entry.kind === "scripts" ? (
            <p>{uiText("JavaScript 仅在 app 模式且已允许脚本时运行。")}</p>
          ) : null}
          {entry.paths.map((path, index) => (
            <label key={path}>
              {uiText(entry.label)} {index + 1}
              <textarea
                aria-label={`${uiText(entry.label)} ${index + 1}`}
                rows={6}
                value={files[path] ?? ""}
                onChange={(event) => onWrite(path, event.currentTarget.value)}
              />
            </label>
          ))}
          {(entry.kind !== "renderer" || entry.paths.length === 0) && (
            <button
              type="button"
              onClick={() =>
                onAttach(
                  entry.kind,
                  `${entry.directory}/followup-${crypto.randomUUID()}.${entry.suffix}`,
                  entry.initial,
                )
              }
            >
              {uiText("添加")} {uiText(entry.label)}
            </button>
          )}
        </section>
      ))}
    </details>
  );
}
