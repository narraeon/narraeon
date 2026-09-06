/** Runtime-owned, world-local choices. Keys identify definitions, never labels. */
export interface WorldExtensionControl {
  key: string;
  generation: number;
}
export interface WorldExtensionItem {
  key: string;
  id: string;
  name: string;
  source: "preset" | "package" | "builtin" | "world";
  kind: "request" | "group" | "panel" | "view";
  group?: string;
  defaultEnabled: boolean;
  selected: boolean;
  enabled: boolean;
  overridden: boolean;
  generation: number;
}
export interface WorldExtensionsView {
  revision: number;
  items: WorldExtensionItem[];
}
export type WorldExtensionChoice = "on" | "off" | "default";
export function isWorldExtensionControl(
  value: unknown,
): value is WorldExtensionControl {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    "generation" in value &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    Object.keys(value).length === 2
  );
}
export function requestControlKey(presetId: string, requestId: string): string {
  return requestId.startsWith("package:")
    ? requestId
    : `preset:${presetId}:request:${requestId}`;
}
