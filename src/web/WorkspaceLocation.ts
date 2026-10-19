export type WorkspaceLocation =
  | { screen: "home" | "create" | "preview" | "model" }
  | { screen: "content"; packageId: string }
  | { screen: "world"; worldId: string }
  | { screen: "plays"; presetId?: string };

export function parseWorkspaceHash(hash: string): WorkspaceLocation | null {
  switch (hash) {
    case "":
    case "#/":
      return { screen: "home" };
    case "#/create":
      return { screen: "create" };
    case "#/preview":
      return { screen: "preview" };
    case "#/models":
      return { screen: "model" };
    case "#/presets":
      return { screen: "plays" };
    case "#/content":
      return { screen: "content", packageId: "" };
    case "#/world":
      return { screen: "world", worldId: "" };
  }
  const match = /^#\/(world|content|presets)\/([^/]+)$/u.exec(hash);
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
    case "content":
      return `#/content/${encodeURIComponent(location.packageId)}`;
    case "world":
      return `#/world/${encodeURIComponent(location.worldId)}`;
    case "plays":
      return location.presetId
        ? `#/presets/${encodeURIComponent(location.presetId)}`
        : "#/presets";
    case "model":
      return "#/models";
    case "create":
      return "#/create";
    case "preview":
      return "#/preview";
  }
}
