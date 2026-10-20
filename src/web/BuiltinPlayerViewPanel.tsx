import { FoldToggle } from "./PlayerViewFold.tsx";
import { useFold } from "./PlayerViewFoldState.ts";
import { Entry } from "./PlayerViewValue.tsx";
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
  const viewPath =
    typeof payload.viewId === "string"
      ? payload.viewId
      : typeof payload.title === "string"
        ? payload.title
        : "view";
  return (
    <FoldedView
      viewPath={viewPath}
      title={typeof payload.title === "string" ? payload.title : null}
      itemCount={items.length}
      layout={layout}
    >
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
          <FoldedGroup
            key={index}
            path={viewPath + "/group:" + String(index)}
            label={section.label}
          >
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
              {section.items.map((item, itemIndex) => (
                <Entry
                  key={typeof item.id === "string" ? item.id : itemIndex}
                  path={
                    viewPath +
                    "/" +
                    (typeof item.id === "string" ? item.id : String(itemIndex))
                  }
                  label={typeof item.label === "string" ? item.label : ""}
                  value={item.value}
                  defaultOpen
                />
              ))}
            </dl>
          </FoldedGroup>
        ))}
    </FoldedView>
  );
}

function FoldedView({
  viewPath,
  title,
  itemCount,
  layout,
  children,
}: {
  viewPath: string;
  title: string | null;
  itemCount: number;
  layout: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { open, toggle } = useFold(viewPath, true);
  return (
    <section className="player-view-card" data-player-view-layout={layout}>
      {title === null ? null : (
        <h3>
          <FoldToggle
            open={open}
            onToggle={toggle}
            label={title}
            hint={uiText("{count} 项", { count: itemCount })}
          />
        </h3>
      )}
      <div className="player-fold-body" hidden={title !== null && !open}>
        {children}
      </div>
    </section>
  );
}

function FoldedGroup({
  path,
  label,
  children,
}: {
  path: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { open, toggle } = useFold(path, true);
  if (label === "") return <section>{children}</section>;
  return (
    <section>
      <h4>
        <FoldToggle open={open} onToggle={toggle} label={label} />
      </h4>
      <div className="player-fold-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
