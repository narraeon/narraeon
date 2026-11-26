import {
  promptRoleOrderErrorCode,
  type PromptRoleOrderDiagnostic,
} from "../../protocol/promptRoleOrder.ts";
import { RuntimeDomainError } from "../RuntimeDomainError.ts";

export class PromptRoleOrderError extends RuntimeDomainError {
  readonly code = promptRoleOrderErrorCode;
  readonly details: PromptRoleOrderDiagnostic;

  constructor(
    details: PromptRoleOrderDiagnostic,
    message = `${details.provider === "anthropic_messages" ? "Anthropic" : "Google Interactions"}: place all System prompts before User/Assistant prompts. / 请将所有 System 提示放在 User/Assistant 提示之前。`,
  ) {
    super(message, {
      receipt: { code: promptRoleOrderErrorCode, details: { ...details } },
    });
    this.name = "PromptRoleOrderError";
    this.details = details;
  }
}
