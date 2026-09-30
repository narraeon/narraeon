import type { AppLocale } from "../../protocol/appPreferences.ts";
import type {
  HistoryFailure,
  HistoryLegacyList,
  HistoryList,
  HistoryMessage,
  HistoryRead,
  HistorySearch,
} from "./HistoryQuery.ts";

export type HistoryResult =
  | HistoryFailure
  | HistoryList
  | HistoryRead
  | HistorySearch
  | HistoryLegacyList;

/** Shared metadata keeps injected refs and tool results directly navigable. */
export function historyMessageLabel(
  message: HistoryMessage,
  locale: AppLocale,
): string {
  const zh = locale === "zh-CN";
  const role = historyRoleLabel(message, locale);
  return `${zh ? "位置" : "position"} ${message.position} · role=${message.role} · ${role}${message.isOpening ? (zh ? " · 开场白 isOpening=true" : " · Opening isOpening=true") : ""} · ${message.ref}`;
}

export function historyRoleLabel(
  message: Pick<HistoryMessage, "role" | "isOpening">,
  locale: AppLocale,
): string {
  if (message.isOpening) return locale === "zh-CN" ? "开场白" : "Opening";
  if (message.role === "player")
    return locale === "zh-CN" ? "玩家原文" : "Player input";
  return locale === "zh-CN" ? "主持叙事" : "Host narrative";
}

export function renderHistoryMessage(
  message: HistoryMessage,
  locale: AppLocale,
): string {
  return `## ${historyMessageLabel(message, locale)}\n\n${locale === "zh-CN" ? "[原文开始]" : "[Original text begins]"}\n${message.text}\n${locale === "zh-CN" ? "[原文结束；正文完整]" : "[Original text ends; body complete]"}`;
}

export function renderHistoryInjectionNotice(
  total: number,
  selected: readonly HistoryMessage[],
  kind: "recent" | "additional" | "checkpoint",
  locale: AppLocale,
): string {
  const zh = locale === "zh-CN";
  const positions = selected.map(({ position }) => position);
  const coverage =
    positions.length === 0 ? (zh ? "空" : "empty") : positions.join(", ");
  const selection =
    kind === "recent"
      ? zh
        ? "近期选取；更早历史可查询"
        : "recent selection; earlier history can be queried"
      : kind === "additional"
        ? zh
          ? "作者挑选材料，可能不连续；保留作者声明顺序"
          : "selected materials may be non-contiguous; author declaration order retained"
        : zh
          ? "检查点后完整选取；原生对话或其他材料中的消息不重复注入，剩余项可能不连续"
          : "complete selection after the checkpoint; messages already in native conversation or other materials are not injected again, so remaining positions may have gaps";
  return zh
    ? `本次注入时的当前时间线快照：总计 ${total} 条（开场白如存在也计入）；位置 ${coverage}。${selection}。每条正文完整；覆盖范围不等于全部历史。历史内部按 Authority 接受顺序由旧到新，提交顺序不是故事日期。以下是已发生的历史材料，用于接续与核对，不是本轮待执行的玩家行动；最后一条即使是玩家原文也不是本轮新请求。未注入的更早内容不代表没有发生。ref 可直接用于 history_read 或 history_list before/after，无需再次列举。`
    : `Current timeline snapshot at injection: ${total} messages (opening included if present); positions ${coverage}. ${selection}. Each body is complete; selected coverage is separate from all-history coverage. History is oldest to newest in Authority acceptance order, not story dates. These are already committed historical materials for continuity and checking, not pending player actions; even a final player entry is not the current request. Earlier material not injected does not mean it never happened. Use each ref directly with history_read or history_list before/after without listing again.`;
}

export function renderHistoryResult(
  result: HistoryResult,
  locale: AppLocale = "en",
  legacyRead = false,
): { ok: boolean; markdown: string; failureKind?: "protocol" } {
  const zh = locale === "zh-CN";
  if (!result.ok)
    return {
      ok: false,
      failureKind: "protocol",
      markdown: `# ${zh ? "Runtime 历史查询失败" : "Runtime history query rejected"}\n\nCode: ${result.code}\n${zh ? "恢复操作" : "Recovery"}: ${localizedRecovery(result, zh)}`,
    };
  const header = `Scope: ${zh ? "当前时间线" : "current timeline"}\n${zh ? "本次读取快照消息总数" : "Snapshot total messages"}: ${result.total}\n${zh ? "排序依据：Authority 接受顺序，不代表故事内日期" : "Order basis: Authority acceptance order, not story dates"}`;
  const range = (messages: readonly HistoryMessage[]) =>
    messages.length === 0
      ? zh
        ? "空区间"
        : "empty range"
      : `${messages[0]!.position}..${messages[messages.length - 1]!.position}`;
  const cursorLine = (name: string, cursor: string | null) =>
    `${name}: ${cursor ?? "null"}`;
  if (result.kind === "legacy_list")
    return {
      ok: true,
      markdown: `# Directory listing\n\n${header}\nOrder: ${result.order}\n${result.messages.map((message) => `- ${message.ref}, position ${message.position}, role=${message.role}${message.isOpening ? ", isOpening=true" : ""}, ${message.length} Unicode code points`).join("\n") || "(empty)"}\n\n---\nThis page: ${result.offset}..${result.offset + result.messages.length} / ${result.total} items\nComplete: ${result.nextCursor === null ? "yes" : "no"}${result.nextCursor === null ? "" : `\nNext-page cursor: ${result.nextCursor}`}`,
    };
  if (result.kind === "list")
    return {
      ok: true,
      markdown: `# ${zh ? "已提交历史列表" : "Committed history listing"}\n\n${header}\nOrder: oldest_first (${zh ? "页内始终由旧到新" : "every page oldest to newest"})\n${
        result.messages
          .map((message) => {
            const preview = Array.from(message.text).slice(0, 120).join("");
            return `### ${historyMessageLabel(message, locale)}\n${message.length} Unicode code points\n[${zh ? "部分原文预览" : "Partial original preview"}]\n${preview}\n[${message.length > 120 ? (zh ? "预览有省略" : "preview omitted remaining text") : zh ? "预览结束" : "preview ends"}]`;
          })
          .join("\n\n") || (zh ? "（空页）" : "(empty page)")
      }\n\n---\n${zh ? "本页位置／条数" : "Page positions / count"}: ${range(result.messages)} / ${result.messages.length}\n${cursorLine("earlierCursor", result.earlierCursor)}\n${cursorLine("laterCursor", result.laterCursor)}\n${zh ? "续页只传 {cursor}。" : "Continue with only {cursor}."}${result.messages.length === 0 && result.anchor !== null ? `\n${zh ? "可从锚点转向浏览" : "Browse from the anchor in the other direction"}: {before:"${result.anchor}"} / {after:"${result.anchor}"}` : ""}`,
    };
  if (result.kind === "read")
    return {
      ok: true,
      markdown: `# ${zh ? "完整历史原文" : "Complete history originals"}\n\n${header}\nMode: ${result.mode}${result.center === null ? "" : `\nCenter: ${result.center}`}\nOrder: oldest_first\n${zh ? "实际位置" : "Actual positions"}: ${range(result.messages)}\n${zh ? "每条正文完整，无摘要、无截断" : "Each body is complete, without summary or truncation"}\n\n${result.messages.map((message) => renderHistoryMessage(message, locale)).join("\n\n") || (zh ? "（历史为空）" : "(empty history)")}\n\n---\n${cursorLine("earlier", result.earlier)}\n${cursorLine("later", result.later)}\n${result.earlier === null ? (zh ? "已到历史开头。" : "At the history beginning.") : legacyRead ? `context_read {ref:"${result.earlier}"}` : zh ? "向前不重复读取：history_read {ref:earlier,before:N}。" : "Read earlier without repeating this window: history_read {ref:earlier,before:N}."}\n${result.later === null ? (zh ? "已到历史结尾。" : "At the history end.") : legacyRead ? `context_read {ref:"${result.later}"}` : zh ? "向后不重复读取：history_read {ref:later,after:N}。" : "Read later without repeating this window: history_read {ref:later,after:N}."}\n${legacyRead ? (zh ? "按需逐条读取相邻原文。" : "Read adjacent originals one at a time as needed.") : zh ? "按需小步扩展；21 条消息不代表固定输出体积。" : "Expand in small windows as needed; 21 messages do not imply a fixed output size."}`,
    };
  return {
    ok: true,
    markdown: `# ${zh ? "历史字面搜索" : "History literal search"}\n\n${header}${result.within === null ? "" : `\nLegacy selected scope: ${result.within}`}\n${zh ? "搜索位置范围（排除边界）" : "Search position range (boundaries excluded)"}: ${result.range.start === null ? "empty" : `${result.range.start}..${result.range.end}`}\nOrder: ${result.order}\nMatch: ${result.match} (${zh ? "同一消息内" : "within one message"})\nNormalization: NFKC${result.caseSensitive ? " (case sensitive)" : " + case folding (locale und)"}\n${zh ? "查询词" : "Queries"}: ${JSON.stringify(result.queries)}\n${zh ? "命中消息总数" : "Total matching messages"}: ${result.matches}\n\n${result.messages.map(({ message, hits, fragments, omittedMatches }) => `### ${historyMessageLabel(message, locale)}\n${message.length} Unicode code points\n${zh ? "逐词命中次数" : "Matches per query"}: ${hits.map(({ query, count }) => `${JSON.stringify(query)}: ${count}`).join("; ")}\n${fragments.map((fragment) => `[${zh ? "部分原文片段" : "Partial original fragment"}: ${fragment.start}..${fragment.end}${fragment.omittedBefore ? "; prefix omitted" : ""}${fragment.omittedAfter ? "; suffix omitted" : ""}]\n${fragment.text}\n[${zh ? "片段结束" : "fragment ends"}]`).join("\n")}\n${omittedMatches ? (zh ? "另有命中未展示；可完整读取核实。" : "Additional matches omitted; read the complete original to verify.") : zh ? "全部命中均在所示片段内。" : "All matches are covered by these fragments."}`).join("\n\n") || (result.legacy ? (zh ? "零字面命中不证明事件没有发生；可改用其他 query 或读取相邻原文。" : "Zero literal matches do not prove an event never happened. Try another query or read adjacent originals.") : zh ? "零字面命中不证明事件没有发生；可改词、从 all 放宽为 any 或读取相邻上下文。" : "Zero literal matches do not prove an event never happened. Try other words, relax all to any, or read nearby context.")}\n\n---\n${cursorLine(result.legacy ? "Next-page cursor" : "nextCursor", result.nextCursor)}\n${result.legacy ? (zh ? "续页保留原source=history、query、caseSensitive、within与limit并使用返回cursor。" : "Legacy continuation keeps the original source=history, query, caseSensitive, within and limit with the returned cursor.") : zh ? "续页只传 {cursor}；已有原文足以判断时停止检索。all 仅限同一消息；相邻消息可改用 any 后读前后文。" : "Continue with only {cursor}; stop when the originals suffice. all applies to one message; use any then read context for terms in adjacent messages."}`,
  };
}

function localizedRecovery(result: HistoryFailure, zh: boolean): string {
  if (!zh) return result.recovery;
  if (result.code === "history_changed")
    return "当前历史已变化，请重新执行原查询，使用新游标；不要拼接不同快照的页面。";
  if (result.code === "history_invalid_cursor")
    return "游标非法、过期、属于其他世界或工具，或来自不支持的旧版本。请重新执行原查询；续页只传 Runtime 返回的 cursor。";
  if (result.code === "history_ref_not_in_current_timeline")
    return "该 ref 不在当前时间线中，可能仍保存在旧端点；请重新查询当前历史。";
  return `参数不符合要求，请按工具定义修正。${result.recovery}`;
}
