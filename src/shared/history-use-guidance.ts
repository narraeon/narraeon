import type { AppLocale } from "../protocol/appPreferences.ts";

/** Mechanical reading guidance shared by production prompts and tool help. */
export function historyUseGuidance(locale: AppLocale, legacy = false): string {
  return locale === "zh-CN"
    ? `## 历史读取
- 按需：已有上下文足够时不检索；仅在缺失细节影响人物行为、承诺、因果或玩家选择时查阅，足够判断即停（重要矛盾可追查）。
- 方法：${legacy ? "仅用本会话冻结的旧工具定义查读最近原文；记不清原词时用单个 query 提候选词字面搜索并按需读前后文" : "缺近期上下文直接 history_read {latest:4}；记不清原词用 history_search queries（any/all，all 限同条消息）提少量候选词并按需读前后文"}。参考原文长度小步扩展，无需固定 list→search→read。
- 边界：零命中不证明未发生，可改词、${legacy ? "扩大范围" : "放宽为 any"}或读邻近上下文。历史背景仅记采集时刻状态，非当前世界状态，不认证句内时间；前后标记结合原文回忆、梦境与局部时间解释，搜索只匹配原文。
- 证据：玩家原文可能是尝试或主张，结果看后续叙事；主持原文可含角色谎言、猜测或梦境，role=narrator 不证明属实。过去持有不代表现在持有，明确当前修订优先于旧叙事；主持读取不自动成为角色知识。
- 注入历史是已提交材料，非本轮新请求，勿重复最后一条历史玩家行动。`
    : `## History reading
- On demand: skip searches when existing context suffices; query only when missing details affect behavior, promises, causality or player choices, and stop once originals decide it (follow up on key contradictions).
- Method: ${legacy ? "use only this session's frozen legacy tool definitions for recent originals; when exact wording is unknown, try candidate terms with a single literal query and read nearby context" : "read recent gaps directly with history_read {latest:4}; when wording is unknown, try a few candidate terms with history_search queries (any/all; all within one message) and read nearby context"}. Expand in small windows using lengths; no fixed list→search→read ritual.
- Bounds: zero literal matches do not prove non-existence; change terms, ${legacy ? "widen scope" : "relax to any"} or read adjacent context. Historical background records capture-time state only, not current state or sentence timestamps; interpret before/after markers with memories, dreams and local times, and searches match originals only.
- Evidence: player originals may be attempts or claims (check later narrative); narrator originals may contain lies, guesses or dreams (role=narrator is not proof). Past possession is not current; explicit current revisions take precedence; host reads are not automatically character knowledge.
- Injected history is committed material, not a new request; never repeat a final historical player action.`;
}
