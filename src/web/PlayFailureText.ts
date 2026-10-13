import type { PlayFailureKind } from "../protocol/playFailure.ts";
import { uiText } from "./i18n.ts";

export const failureText: Record<
  PlayFailureKind,
  { title: string; description: string }
> = {
  outcome_unknown: {
    title: "模型请求结果未知",
    description:
      "模型请求已发出，但结果未知。旧请求不能重发；为避免重复生成，请从全新上下文继续。",
  },
  context_limit: {
    title: "模型上下文已达上限",
    description:
      "当前上下文超过了模型的输入上限。旧请求不能重发，请从全新上下文继续。",
  },
  output_limit: {
    title: "模型输出已达上限",
    description:
      "模型回复达到输出上限，尚未完成。请在模型配置中调高最大输出 Token，保存后从全新上下文继续。推理也可能占用输出额度。",
  },
  context_unavailable: {
    title: "模型上下文无法继续",
    description:
      "当前上下文的续传信息不可用，或模型连接与原配置不兼容。旧请求不能重发，请从全新上下文继续。",
  },
  retryable: {
    title: "模型请求可以重新发送",
    description:
      "模型拒绝了请求，或请求尚未发出。可以重新发送已保存的请求，不会重复提交玩家原文。",
  },
  provider_error: {
    title: "模型连接发生错误",
    description:
      "模型服务未能完成请求。请检查模型连接；也可以从全新上下文继续。",
  },
  other: {
    title: "调用链中断",
    description:
      "处理这次请求时发生错误。旧请求不能重发；请查看技术详情，也可以从全新上下文继续。",
  },
};

export function playFailureDescription(
  kind: PlayFailureKind | undefined,
  canRetry: boolean,
): string {
  return uiText(
    failureText[kind ?? (canRetry ? "retryable" : "other")].description,
  );
}
