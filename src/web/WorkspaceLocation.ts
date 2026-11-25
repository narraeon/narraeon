export type WorkspaceLocation =
  | { screen: "home" | "library" | "create" | "preview" | "model" }
  | { screen: "content"; packageId: string }
  | { screen: "world"; worldId: string }
  | { screen: "plays"; presetId?: string };

export interface WorkspaceNavigationProtection {
  dirty: boolean;
  busy: boolean;
}

export const idleWorkspaceNavigation: WorkspaceNavigationProtection = {
  dirty: false,
  busy: false,
};

export interface CreationSelection {
  packageId: string;
  templateId: string;
}

export interface BrowserWorkspaceEntry {
  hash: string;
  key: string | undefined;
  position: number | undefined;
  historyLength: number;
  creationSelection?: CreationSelection;
}

export function readBrowserWorkspaceEntry(): BrowserWorkspaceEntry {
  const entry = window.navigation?.currentEntry;
  const state: unknown = window.history.state;
  const hash = window.location.hash;
  const creationSelection =
    hash === "#/create" &&
    typeof state === "object" &&
    state !== null &&
    "narraeonCreation" in state
      ? readCreationSelection(state.narraeonCreation)
      : undefined;
  const position =
    typeof state === "object" && state !== null && "narraeonPosition" in state
      ? state.narraeonPosition
      : undefined;
  return {
    hash,
    key: entry?.key,
    historyLength: window.history.length,
    position:
      entry !== undefined && entry !== null && entry.index >= 0
        ? entry.index
        : typeof position === "number" && Number.isSafeInteger(position)
          ? position
          : undefined,
    ...(creationSelection === undefined ? {} : { creationSelection }),
  };
}

function readCreationSelection(value: unknown): CreationSelection | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "packageId" in value &&
    typeof value.packageId === "string" &&
    "templateId" in value &&
    typeof value.templateId === "string"
  )
    return { packageId: value.packageId, templateId: value.templateId };
}

export function writeBrowserWorkspaceEntry(
  hash: string,
  mode: "push" | "replace",
  position: number,
  creationSelection?: CreationSelection,
): BrowserWorkspaceEntry {
  const state = {
    narraeonPosition: position,
    ...(creationSelection === undefined
      ? {}
      : { narraeonCreation: creationSelection }),
  };
  if (mode === "replace") window.history.replaceState(state, "", hash);
  else window.history.pushState(state, "", hash);
  return readBrowserWorkspaceEntry();
}

export function sameBrowserWorkspaceEntry(
  a: BrowserWorkspaceEntry,
  b: BrowserWorkspaceEntry,
): boolean {
  return a.hash === b.hash && a.key === b.key && a.position === b.position;
}

export function returnToBrowserWorkspaceEntry(
  original: BrowserWorkspaceEntry,
  destination: BrowserWorkspaceEntry,
): boolean {
  if (original.key !== undefined && original.key !== destination.key) {
    const { committed, finished } = window.navigation.traverseTo(original.key);
    // A new browser navigation can supersede this traversal.
    void Promise.allSettled([committed, finished]);
    return true;
  }
  if (original.position === undefined || destination.position === undefined)
    return false;
  const delta = original.position - destination.position;
  if (delta !== 0) window.history.go(delta);
  else if (original.hash !== destination.hash) {
    // A same-entry replacement has no history step to walk.
    writeBrowserWorkspaceEntry(
      original.hash,
      "replace",
      original.position ?? 0,
      original.creationSelection,
    );
  }
  return true;
}

export function parseWorkspaceHash(hash: string): WorkspaceLocation | null {
  switch (hash) {
    case "":
    case "#/":
      return { screen: "home" };
    case "#/library":
      return { screen: "library" };
    case "#/create":
      return { screen: "create" };
    case "#/preview":
      return { screen: "preview" };
    case "#/models":
      return { screen: "model" };
    case "#/presets": // Pre-1.0 bookmark alias.
    case "#/orchestrations":
      return { screen: "plays" };
    case "#/content":
      return { screen: "content", packageId: "" };
    case "#/world":
      return { screen: "world", worldId: "" };
  }
  const match = /^#\/(world|content|orchestrations|presets)\/([^/]+)$/u.exec(
    hash,
  );
  if (match === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[2]!);
  } catch {
    id = "";
  }
  if (match[1] === "world") return { screen: "world", worldId: id };
  if (match[1] === "content") return { screen: "content", packageId: id };
  return { screen: "plays", presetId: id };
}

export function workspaceHash(location: WorkspaceLocation): string {
  switch (location.screen) {
    case "home":
      return "#/";
    case "library":
      return "#/library";
    case "content":
      return `#/content/${encodeURIComponent(location.packageId)}`;
    case "world":
      return `#/world/${encodeURIComponent(location.worldId)}`;
    case "plays":
      return location.presetId
        ? `#/orchestrations/${encodeURIComponent(location.presetId)}`
        : "#/orchestrations";
    case "model":
      return "#/models";
    case "create":
      return "#/create";
    case "preview":
      return "#/preview";
  }
}
