import { createContext, useContext, useMemo, useState } from "react";
import { uiText } from "./i18n.ts";

/**
 * Presentation-only fold state for the player-view panels. Keys are stable
 * paths (view / item / nested key), so folds survive the re-render that follows
 * every play step. Without a provider each fold keeps its own local state.
 */
export interface PlayerViewFold {
  isOpen: (path: string, defaultOpen: boolean) => boolean;
  setOpen: (path: string, open: boolean) => void;
}

const PlayerViewFoldContext = createContext<PlayerViewFold | null>(null);
export const PlayerViewFoldProvider = PlayerViewFoldContext.Provider;

export function usePlayerViewFoldController(): {
  fold: PlayerViewFold;
  expandAll: () => void;
  collapseAll: () => void;
} {
  const [state, setState] = useState<{
    all: boolean | null;
    overrides: Record<string, boolean>;
  }>({ all: null, overrides: {} });
  const fold = useMemo<PlayerViewFold>(
    () => ({
      isOpen: (path, defaultOpen) =>
        state.overrides[path] ?? state.all ?? defaultOpen,
      setOpen: (path, open) =>
        setState((current) => ({
          ...current,
          overrides: { ...current.overrides, [path]: open },
        })),
    }),
    [state],
  );
  return {
    fold,
    expandAll: () => setState({ all: true, overrides: {} }),
    collapseAll: () => setState({ all: false, overrides: {} }),
  };
}

export function useFold(
  path: string,
  defaultOpen: boolean,
): { open: boolean; toggle: () => void } {
  const fold = useContext(PlayerViewFoldContext);
  const [local, setLocal] = useState(defaultOpen);
  const open = fold === null ? local : fold.isOpen(path, defaultOpen);
  return {
    open,
    toggle: () => (fold === null ? setLocal(!open) : fold.setOpen(path, !open)),
  };
}

/** Non-empty objects and arrays fold; scalars and `$ref` links stay inline. */
export function isFoldable(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.$ref !== "string" && Object.keys(record).length > 0;
}

/** One-line summary shown beside a collapsed container. */
export function foldPreview(value: unknown): string {
  if (Array.isArray(value))
    return uiText("{count} 项", { count: String(value.length) });
  const keys = Object.keys(value as Record<string, unknown>);
  return (
    uiText("{count} 项", { count: String(keys.length) }) +
    " · " +
    keys.slice(0, 3).join("、") +
    (keys.length > 3 ? "…" : "")
  );
}

const titleKeys = ["name", "title", "名称", "名字", "标题"];

/** A readable name for a list entry, when the entry carries one. */
export function entryTitle(value: unknown, index: number): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of titleKeys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "")
        return candidate;
    }
  }
  return "#" + String(index + 1);
}
