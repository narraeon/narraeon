import { FoldToggle } from "./PlayerViewFold.tsx";
import {
  entryTitle,
  foldPreview,
  isFoldable,
  useFold,
} from "./PlayerViewFoldState.ts";
import { uiText } from "./i18n.ts";

/**
 * `path` identifies the value for fold state. Containers nested inside a value
 * start collapsed; the item that holds the value decides its own default.
 */
export function PlayerValue({
  value,
  path = "",
}: {
  value: unknown;
  path?: string;
}): React.JSX.Element {
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
          <ListEntry
            key={index}
            path={path + "/" + String(index)}
            index={index}
            entry={entry}
          />
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
          <Entry
            key={key}
            path={path + "/" + key}
            label={key}
            value={child}
            defaultOpen={false}
          />
        ))}
      </dl>
    );
  }
  if (typeof value === "bigint") return <span>{value.toString()}</span>;
  if (typeof value === "symbol")
    return <span>{value.description ?? "Symbol"}</span>;
  return <span className="empty-value">{uiText("[无法显示]")}</span>;
}

/** A labelled value row; a foldable value gets a toggle in place of its label. */
export function Entry({
  path,
  label,
  value,
  defaultOpen,
}: {
  path: string;
  label: string;
  value: unknown;
  defaultOpen: boolean;
}): React.JSX.Element {
  const { open, toggle } = useFold(path, defaultOpen);
  if (!isFoldable(value))
    return (
      <div>
        <dt>{label}</dt>
        <dd>
          <PlayerValue value={value} path={path} />
        </dd>
      </div>
    );
  return (
    <div className="player-fold-row">
      <dt>
        <FoldToggle
          open={open}
          onToggle={toggle}
          label={label}
          hint={foldPreview(value)}
        />
      </dt>
      <dd className="player-fold-body" hidden={!open}>
        <PlayerValue value={value} path={path} />
      </dd>
    </div>
  );
}

function ListEntry({
  path,
  index,
  entry,
}: {
  path: string;
  index: number;
  entry: unknown;
}): React.JSX.Element {
  const { open, toggle } = useFold(path, false);
  if (!isFoldable(entry))
    return (
      <li>
        <PlayerValue value={entry} path={path} />
      </li>
    );
  return (
    <li className="player-fold-row">
      <FoldToggle
        open={open}
        onToggle={toggle}
        label={entryTitle(entry, index)}
        hint={foldPreview(entry)}
      />
      <div className="player-fold-body" hidden={!open}>
        <PlayerValue value={entry} path={path} />
      </div>
    </li>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
