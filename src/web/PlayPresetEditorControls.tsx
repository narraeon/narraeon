import { uiText } from "./i18n.ts";
import type { ArtifactMountName } from "./ArtifactExtensionHost.tsx";
import { mountChoices, describePresetFile } from "./playPresetEditorLabels.ts";
export function MountSelect({
  ariaLabel,
  value,
  allowNone = false,
  onChange,
}: {
  ariaLabel: string;
  value: ArtifactMountName | "";
  allowNone?: boolean;
  onChange: (value: ArtifactMountName | "") => void;
}): React.JSX.Element {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) =>
        onChange(event.currentTarget.value as ArtifactMountName | "")
      }
    >
      {allowNone ? <option value="">{uiText("不在页面显示")}</option> : null}
      {mountChoices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {uiText(choice.label)} — {uiText(choice.description)}
        </option>
      ))}
    </select>
  );
}

export function PathChecklist({
  ariaLabel,
  paths,
  selected,
  emptyText,
  onChange,
}: {
  ariaLabel: string;
  paths: string[];
  selected: string[];
  emptyText: string;
  onChange: (paths: string[]) => void;
}): React.JSX.Element {
  const available = [...new Set([...paths, ...selected])].sort();
  if (available.length === 0)
    return <p className="play-preset-empty-copy">{emptyText}</p>;
  return (
    <ul className="play-preset-path-checklist" aria-label={ariaLabel}>
      {available.map((path) => (
        <li key={path}>
          <label>
            <input
              type="checkbox"
              checked={selected.includes(path)}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...new Set([...selected, path])].sort()
                    : selected.filter((candidate) => candidate !== path),
                )
              }
            />
            <span>{describePresetFile(path, "").title}</span>
            <code>{path}</code>
          </label>
        </li>
      ))}
    </ul>
  );
}
