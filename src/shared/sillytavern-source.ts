import type {
  SillyTavernDiagnostic,
  SillyTavernReason,
} from "./sillytavern-preset.ts";

export interface SillyTavernSourceEntry {
  id: string;
  path: string;
  name: string;
  ordered: boolean;
  /** Zero-based position in the source order group. */
  order?: number;
  selected: boolean;
  enabled?: boolean;
  marker: boolean;
  missing: boolean;
  content?: string;
  role?: string;
  injectionPosition?: number;
  injectionDepth?: number;
  injectionOrder?: number;
  triggers?: string[];
  macros: string[];
  forbidOverrides?: boolean;
  systemPrompt?: boolean;
  extension?: boolean;
  position?: string | number;
  reasons: SillyTavernReason[];
  targetEntryId?: string;
}

export interface SillyTavernSourceSnapshot {
  version: 1;
  groupId: string;
  entries: SillyTavernSourceEntry[];
}

export type SillyTavernSource =
  | { kind: "snapshot"; snapshot: SillyTavernSourceSnapshot }
  | { kind: "legacy"; groupId?: string; report: SillyTavernDiagnostic[] }
  | { kind: "none" };
