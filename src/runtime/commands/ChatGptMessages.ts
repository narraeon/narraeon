import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ChatGptAuthErrorCode } from "../../protocol/chatGptAuth.ts";

const messages: Record<ChatGptAuthErrorCode, readonly [string, string]> = {
  local_only: [
    "请在运行 Narraeon 的同一台电脑上直接打开本地工作区，再使用 ChatGPT 套餐。",
    "Open the local workspace directly on the computer running Narraeon to use a ChatGPT plan.",
  ],
  busy: [
    "ChatGPT 登录仍在进行。请回到系统浏览器完成操作。",
    "A ChatGPT sign-in is in progress. Finish it in your system browser.",
  ],
  account_not_found: [
    "这台电脑的当前工作区找不到该 ChatGPT 账号。请重新登录。",
    "This ChatGPT account was not found in the local workspace. Sign in again.",
  ],
  sign_in_required: [
    "请在模型连接中登录 ChatGPT，然后重试。",
    "Sign in to ChatGPT in Model Connections and try again.",
  ],
  plan_permission_required: [
    "已登录 ChatGPT。请在模型连接中授权使用套餐后重试。",
    "You are signed in to ChatGPT. Enable plan usage in Model Connections and try again.",
  ],
  authorization_failed: [
    "未能完成 ChatGPT 授权。请重新登录。",
    "ChatGPT authorization could not be completed. Sign in again.",
  ],
  authorization_expired: [
    "此次 ChatGPT 登录已过期。请重新登录。",
    "This ChatGPT sign-in expired. Sign in again.",
  ],
  service_unavailable: [
    "暂时无法连接 ChatGPT。请稍后重试。",
    "ChatGPT is temporarily unavailable. Try again later.",
  ],
  invalid_response: [
    "无法确认 ChatGPT 的回复。请稍后重试。",
    "The ChatGPT response could not be verified. Try again later.",
  ],
  reauthorization_required: [
    "ChatGPT 授权已失效。请在模型连接中重新登录。",
    "ChatGPT authorization has expired or been revoked. Sign in again in Model Connections.",
  ],
  catalog_unavailable: [
    "暂时无法读取此 ChatGPT 账号的模型。请刷新授权并重新加载模型。",
    "The models for this ChatGPT account could not be loaded. Refresh authorization and reload the list.",
  ],
};

export function chatGptMessage(
  code: ChatGptAuthErrorCode,
  locale: AppLocale,
): string {
  return messages[code][locale === "zh-CN" ? 0 : 1];
}
