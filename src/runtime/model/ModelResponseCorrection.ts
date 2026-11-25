import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  ModelHostFailureError,
  type ModelHostAppendItem,
  type ModelHostResponse,
} from "./ModelHost.ts";

/** Only confirmed invalid model output belongs here. Transport and local persistence failures do not. */
export class ModelResponseFormatError extends ModelHostFailureError {
  readonly #chineseMessage: string | undefined;

  constructor(message: string, chineseMessage?: string) {
    super(message);
    this.#chineseMessage = chineseMessage;
  }

  notice(
    locale: AppLocale = "en",
  ): Extract<ModelHostAppendItem, { kind: "runtime_notice" }> {
    return {
      kind: "runtime_notice",
      notice: "response_correction",
      text:
        locale === "zh-CN"
          ? `Runtime 已拒绝上一条响应，其中的工具均未执行。${this.#chineseMessage ?? this.message} 请针对原请求返回格式正确的响应。`
          : `Runtime rejected your previous response before executing its tools. ${this.message} Return a corrected response to the outstanding request.`,
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
        "每个工具调用都需要非空 ID 和一个随附工具的名称。",
      );
    if (!allowToolReplay && ids.has(call.id))
      throw new ModelResponseFormatError(
        "Two tool calls used the same ID. Give each tool call its own unique ID.",
        "两个工具调用使用了相同的 ID。请为每个工具调用提供唯一 ID。",
      );
    ids.add(call.id);
  }
}
