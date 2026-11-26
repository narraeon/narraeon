import type {
  V1SettingImprovementHistoryItem,
  V1SettingImprovementView,
} from "./v1.ts";
import type {
  PromptGameplayScope,
  PromptMessageRole,
} from "../shared/ordered-play-prompts.ts";

export type OrchestrationSurface = "playPrompts" | "authorPrompts";

export type OrchestrationSessionRequest =
  | { type: "orchestration.overview"; presetId: string }
  | {
      type:
        | "orchestration.session.read"
        | "orchestration.session.delete"
        | "orchestration.cancel";
      presetId: string;
      sessionId: string;
    }
  | {
      type: "orchestration.message";
      presetId: string;
      requestId: string;
      message: string;
      expectedRevision: string;
      surface: OrchestrationSurface;
      focusedEntryId?: string;
      continuation:
        | { kind: "fresh_context" }
        | { kind: "continue_context"; sessionId: string };
    }
  | {
      type: "orchestration.resume";
      presetId: string;
      sessionId: string;
      requestId: string;
      recovery?: "continue_partial";
    }
  | {
      type: "orchestration.undo";
      presetId: string;
      sessionId: string;
      changeSetId: string;
      expectedRevision: string;
    }
  | {
      type: "orchestration.call.context";
      presetId: string;
      sessionId: string;
      callId: string;
    }
  | {
      type: "orchestration.request.preview";
      presetId: string;
      sessionId: string;
      requestId: string;
    };

export interface V1OrchestrationEntry {
  id: string;
  kind: "builtin" | "user" | "world" | "tail";
  name: string;
  text: string;
  enabled: boolean;
  messageRole: PromptMessageRole | null;
  turnGuide: string | null;
  /** Distinguishes a builtin default from an explicit override, including an empty one. */
  turnGuideOverride: string | null;
  gameplay: PromptGameplayScope | null;
  index: number;
}

export interface V1OrchestrationChangeSet {
  id: string;
  requestId: string;
  responseId: string;
  operationIds: string[];
  beforeRevision: string;
  afterRevision: string;
  undone: boolean;
  undoAvailable: boolean;
  provenance?: { operationId: string; entryId: string; value: unknown }[];
  entries: {
    surface: OrchestrationSurface;
    entryId: string;
    /** An explicit move changed this entry's order relative to surviving entries. */
    moved?: true;
    before: V1OrchestrationEntry | null;
    after: V1OrchestrationEntry | null;
  }[];
}

export interface V1OrchestrationView extends Omit<
  V1SettingImprovementView,
  "packageId" | "legacyDraft"
> {
  presetId: string;
  revision: string;
  currentRevision: string;
  changes: V1OrchestrationChangeSet[];
}

export interface V1OrchestrationOverview {
  presetId: string;
  revision: string;
  currentRevision: string;
  latest: V1OrchestrationView | null;
  history: V1SettingImprovementHistoryItem[];
}

export interface V1OrchestrationStatus {
  /** Durable observation token (increases on persisted conversation changes). */
  revision: string;
  /** The effective draft version, including when there is no unapplied draft. */
  draftRevision: string;
  currentRevision: string;
  selected: Pick<
    V1OrchestrationView,
    "sessionId" | "runStatus" | "progress"
  > | null;
}
