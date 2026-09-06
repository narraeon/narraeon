import { PlayerValue } from "./PlayerViewValue.tsx";
import { uiText } from "./i18n.ts";

/** Safe host rendering for player-view panels that select no custom resources. */
export function BuiltinPlayerViewPanel({
  content,
}: {
  content: string;
}): React.JSX.Element | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return (
      <p role="status">{uiText("玩家视图格式无效，请检查文本处理规则。")}</p>
    );
  }
  if (!isRecord(payload)) return null;
  const config = isRecord(payload.config) ? payload.config : {};
  const items = Array.isArray(payload.items)
    ? payload.items.filter(isRecord)
    : [];
  if (items.length === 0 && config.empty === "hide") return null;
  const groups = Array.isArray(config.groups)
    ? config.groups.filter(isRecord)
    : [];
  const used = new Set<unknown>();
  const sections = groups.map((group) => {
    const selected = Array.isArray(group.itemIds)
      ? group.itemIds.flatMap((id) => {
          const item = items.find((item) => item.id === id);
          if (item === undefined || used.has(id)) return [];
          used.add(id);
          return [item];
        })
      : [];
    return {
      label: typeof group.label === "string" ? group.label : "",
      items: selected,
    };
  });
  sections.push({
    label: "",
    items: items.filter((item) => !used.has(item.id)),
  });
  const layout = config.layout === "grid" ? "grid" : "stack";
  return (
    <section className="player-view-card" data-player-view-layout={layout}>
      {typeof payload.title === "string" ? <h3>{payload.title}</h3> : null}
      {items.length === 0 && config.empty !== "show" ? (
        <p>
          {typeof config.emptyMessage === "string"
            ? config.emptyMessage
            : uiText("当前没有可显示项目。")}
        </p>
      ) : null}
      {sections
        .filter((section) => section.items.length > 0)
        .map((section, index) => (
          <section key={index}>
            {section.label === "" ? null : <h4>{section.label}</h4>}
            <dl
              style={{
                display: "grid",
                gap: "0.75rem",
                gridTemplateColumns:
                  layout === "grid"
                    ? "repeat(2, minmax(0, 1fr))"
                    : "minmax(0, 1fr)",
              }}
            >
              {section.items.map((item, index) => (
                <div key={index}>
                  <dt>{typeof item.label === "string" ? item.label : ""}</dt>
                  <dd>
                    <PlayerValue value={item.value} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
