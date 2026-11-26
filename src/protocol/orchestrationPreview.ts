import type { Gameplay } from "./gameplay.ts";
import type { ModelProviderKind } from "./modelConnections.ts";
import type {
  PromptGroup,
  PromptMessageRole,
} from "../shared/ordered-play-prompts.ts";
import type { TurnGuideWarning } from "../shared/turn-guide.ts";

export type OrchestrationSurface = "play" | "author";
export type OrchestrationAuthorTarget = "setting" | "world-revision";

export interface OrchestrationPreviewInput {
  presetId: string;
  /** The selected stored revision and, when supplied, the base of the candidate. */
  revision: string;
  candidate?: {
    files: Record<string, string>;
    structure?: Record<string, unknown>;
  };
  surface: OrchestrationSurface;
  gameplay: Gameplay;
  authorTarget?: OrchestrationAuthorTarget;
  connection?: "active" | "none";
}

export type OrchestrationPlaceholderKind =
  | "world-instructions"
  | "world-material"
  | "world-turn-guide"
  | "player-turn-note"
  | "author-target"
  | "author-preload";

export interface OrchestrationPlaceholder {
  kind: OrchestrationPlaceholderKind;
  entryId?: string;
  source: string;
  timing: "prefix" | "fresh-context" | "after-author-prompts" | "turn-guide";
}

export interface OrchestrationPreviewEntry {
  identity: string;
  id: string;
  name: string;
  kind: "builtin" | "user" | "world" | "tail";
  builtin?: string;
  source: string;
  position: number;
  enabled: boolean;
  applies: boolean;
  messageRole?: PromptMessageRole;
  group?: PromptGroup;
  gameplay?: "tabletop";
  /** Saved prose even when disabled or out of scope. */
  configuredMarkdown?: string;
  configuredTurnGuide?: string;
  /** Compile-time portion of emitted text. */
  markdown?: string;
  turnGuide?: string;
  placeholders: OrchestrationPlaceholderKind[];
}

export interface OrchestrationPreviewMessage {
  role: PromptMessageRole;
  entryIds: string[];
  /** Static messages shown as joined below may be separated by a dynamic one. */
  conditional: boolean;
}

export interface CompiledOrchestrationPreview {
  revision: string;
  surface: OrchestrationSurface;
  gameplay: Gameplay;
  authorTarget?: OrchestrationAuthorTarget;
  entries: OrchestrationPreviewEntry[];
  messages: OrchestrationPreviewMessage[];
  mergeConsecutiveMessages: boolean;
  messageOrder: "determined" | "conditional";
  placeholders: OrchestrationPlaceholder[];
  turnGuide?: {
    worldLineInsertIndex: number;
    lines: { entryId: string; source: string; text: string }[];
    warnings: TurnGuideWarning[];
    lineCount: "over-limit" | "conditional";
    limits: { lines: number; lineLength: number };
  };
  protocol:
    | { status: "not-checked" }
    | {
        status: "compatible" | "conditional" | "incompatible";
        provider: ModelProviderKind;
        /** Entry IDs of System messages or placeholders that can violate ordering. */
        conflictingIds: string[];
      };
}

export interface OrchestrationPreviewComparison {
  baseRevision: string;
  selectedRevision: string;
  changes: {
    identity: string;
    before?: OrchestrationPreviewEntry;
    after?: OrchestrationPreviewEntry;
  }[];
  mergeConsecutiveMessagesChanged: boolean;
}

export interface OrchestrationPreviewResult {
  presetId: string;
  presetName: string;
  isCurrentPreset: boolean;
  selected: CompiledOrchestrationPreview;
  selectedKind: "current" | "draft" | "stored" | "candidate";
  candidateBaseRevision?: string;
  comparison: OrchestrationPreviewComparison;
}
