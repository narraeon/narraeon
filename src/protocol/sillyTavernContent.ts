export interface ContentSourceEntry {
  id: string;
  path: string;
  name: string;
  content: string;
  enabled: boolean;
  rules: Record<string, unknown>;
}
export interface ContentInspection {
  kind: "character" | "worldbook";
  version: string;
  fields: Record<string, unknown>;
  entries: ContentSourceEntry[];
  diagnostics: { code: string; path: string }[];
}
export interface ContentSelection {
  character?: boolean;
  scenario?: boolean;
  opening?: string | undefined;
  example?: boolean;
  systemPrompt?: boolean;
  attachments?: string[];
  entries: Record<string, "world" | "attachment">;
}
