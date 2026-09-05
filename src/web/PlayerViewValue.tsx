import { uiText } from "./i18n.ts";
export function PlayerValue({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="empty-value">—</span>;
  if (typeof value === "string")
    return <span className="text-value">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    const entries = value as unknown[];
    return (
      <ul className="player-value-list">
        {entries.map((entry, index) => (
          <li key={index}>
            <PlayerValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    if (typeof value.$ref === "string")
      return (
        <span className="document-reference">
          {typeof value.title === "string" ? value.title : value.$ref}
          {typeof value.ref === "string" ? ` · @${value.ref}` : ""}
        </span>
      );
    return (
      <dl className="player-value-map">
        {Object.entries(value).map(([key, child]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <PlayerValue value={child} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === "bigint") return <span>{value.toString()}</span>;
  if (typeof value === "symbol")
    return <span>{value.description ?? "Symbol"}</span>;
  return <span className="empty-value">{uiText("[无法显示]")}</span>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
