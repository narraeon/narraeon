import type { ModelProviderKind } from "./modelConnections.ts";
import type { OrchestrationSurface } from "./orchestrationSession.ts";

export const promptRoleOrderErrorCode = "prompt_role_order_unsupported";

export interface PromptRoleOrderTarget {
  id: string;
  revision: string;
  surface: OrchestrationSurface;
  entryId?: string;
}

export interface PromptRoleOrderDiagnostic {
  provider: Extract<
    ModelProviderKind,
    "anthropic_messages" | "google_interactions"
  >;
  orchestration?: PromptRoleOrderTarget;
}
