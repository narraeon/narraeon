import {
  promptRoleOrderErrorCode,
  type PromptRoleOrderTarget,
} from "../protocol/promptRoleOrder.ts";
import { isResponseRecord, RuntimeRequestError } from "./RuntimeResponse.ts";
import { uiText } from "./i18n.ts";

export type ModelSendRecovery =
  | { kind: "protocol_mismatch" }
  | { kind: "prompt_role_order"; target?: PromptRoleOrderTarget };

export function modelSendRecovery(error: unknown): ModelSendRecovery | null {
  if (!(error instanceof RuntimeRequestError) || error.kind !== "runtime")
    return null;
  if (error.protocolCode === "model_protocol_mismatch")
    return { kind: "protocol_mismatch" };
  if (error.protocolCode !== promptRoleOrderErrorCode) return null;
  const target = isResponseRecord(error.details)
    ? error.details.orchestration
    : undefined;
  if (
    isResponseRecord(target) &&
    typeof target.id === "string" &&
    typeof target.revision === "string" &&
    (target.surface === "playPrompts" || target.surface === "authorPrompts")
  )
    return {
      kind: "prompt_role_order",
      target: {
        id: target.id,
        revision: target.revision,
        surface: target.surface,
        ...(typeof target.entryId === "string"
          ? { entryId: target.entryId }
          : {}),
      },
    };
  return { kind: "prompt_role_order" };
}

export function promptRoleOrderRule(): string {
  return uiText(
    "当前协议要求所有 System 提示排在第一条 User 或 Assistant 提示之前。",
  );
}
