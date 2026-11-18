import {
  ModelHostFailureError,
  type ModelHostAppendItem,
  type ModelHostResponse,
} from "./ModelHost.ts";

/** Only confirmed invalid model output belongs here. Transport and local persistence failures do not. */
export class ModelResponseFormatError extends ModelHostFailureError {
  notice(): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
    return {
      kind: "runtime_notice",
      notice: "response_correction",
      text: `Runtime rejected your previous response before executing its tools. ${this.message} Return a corrected response to the outstanding request.`,
    };
  }
}

export function validateModelToolCalls(
  response: ModelHostResponse,
  allowToolReplay = false,
): void {
  const ids = new Set<string>();
  for (const call of response.toolCalls ?? []) {
    if (!call.id?.trim() || !call.name?.trim())
      throw new ModelResponseFormatError(
        "Each tool call needs a nonempty ID and the name of a provided tool.",
      );
    if (!allowToolReplay && ids.has(call.id))
      throw new ModelResponseFormatError(
        "Two tool calls used the same ID. Give each tool call its own unique ID.",
      );
    ids.add(call.id);
  }
}
