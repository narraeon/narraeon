import type { AppLocale } from "../protocol/appPreferences.ts";

/** Mechanical reading guidance shared by production prompts and tool help. */
export function historyUseGuidance(locale: AppLocale, legacy = false): string {
  if (!legacy) return currentHistoryUseGuidance[locale];
  return locale === "zh-CN"
    ? `## 历史读取
- 按需：已有上下文足够时不检索；仅在缺失细节影响人物行为、承诺、因果或玩家选择时查阅，足够判断即停（重要矛盾可追查）。
- 方法：仅用本会话冻结的旧工具定义查读最近原文；记不清原词时用单个 query 提候选词字面搜索并按需读前后文。参考原文长度小步扩展，无需固定 list→search→read。
- 边界：零命中不证明未发生，可改词、扩大范围或读邻近上下文。历史背景仅记采集时刻状态，非当前世界状态，不认证句内时间；前后标记结合原文回忆、梦境与局部时间解释，搜索只匹配原文。
- 证据：玩家原文可能是尝试或主张，结果看后续叙事；主持原文可含角色谎言、猜测或梦境，role=narrator 不证明属实。过去持有不代表现在持有，明确当前修订优先于旧叙事；主持读取不自动成为角色知识。
- 注入历史是已提交材料，非本轮新请求，勿重复最后一条历史玩家行动。`
    : `## History reading
- On demand: skip searches when existing context suffices; query only when missing details affect behavior, promises, causality or player choices, and stop once originals decide it (follow up on key contradictions).
- Method: use only this session's frozen legacy tool definitions for recent originals; when exact wording is unknown, try candidate terms with a single literal query and read nearby context. Expand in small windows using lengths; no fixed list→search→read ritual.
- Bounds: zero literal matches do not prove non-existence; change terms, widen scope or read adjacent context. Historical background records capture-time state only, not current state or sentence timestamps; interpret before/after markers with memories, dreams and local times, and searches match originals only.
- Evidence: player originals may be attempts or claims (check later narrative); narrator originals may contain lies, guesses or dreams (role=narrator is not proof). Past possession is not current; explicit current revisions take precedence; host reads are not automatically character knowledge.
- Injected history is committed material, not a new request; never repeat a final historical player action.`;
}

const currentHistoryUseGuidance: Record<AppLocale, string> = {
  "zh-CN": `## 历史读取
- **按需查阅**：现有上下文够用时不查；只在缺失细节会影响人物反应、承诺、因果或玩家选择时检索，查清即停。
- **查阅方式**：缺近期内容直接用 \`history_read({latest: 4})\`；记不清原词用 \`history_search\` 传 1–3 个候选关键词（\`any\`/\`all\`，\`all\` 要求同条命中），再按需读前后文，无需机械执行 \`list -> search -> read\`。
- **结果边界**：需要继续确认时，可换词、放宽为 \`any\` 或读邻近段落。历史附带的背景只记录当时采集的状态，不代表当前世界状态，也不代表对话里提到“明天”“昨晚”时的实际故事时间；搜索只匹配原文。
- **区分证据**：玩家原文可能是尝试或主张，结果看后续叙事；主持人原文可能包含角色谎言、猜测或梦境，\`role=narrator\` 不等于事实成立。当前明确修订优先于旧叙事；主持人查到的历史不等于角色知道。
- 注入的历史是已提交的过去内容，不是本轮新输入，不要重复最后一条历史玩家行动。`,
  en: `## History reading
- **Read on demand**: Skip searches when current context is enough; query only when missing details affect character behavior, promises, causality, or player choices, and stop once verified.
- **How to look up**: For recent gaps, call \`history_read({latest: 4})\` directly; when exact wording is unclear, try 1–3 candidate keywords with \`history_search\` (\`any\`/\`all\`, where \`all\` matches within one message) and read nearby context. No fixed \`list -> search -> read\` ritual is needed.
- **Limits**: To check further, try different terms, relax to \`any\`, or read adjacent turns. Saved historical background captures state at commit time only, not current state or relative times spoken inside dialogue; search matches original text only.
- **Weighing evidence**: Player text may be an attempt or claim (check later prose); narrator text may include lies, guesses, or dreams (\`role=narrator\` is not proof). Current explicit revisions override older narrative, and what the GM looks up does not automatically become character knowledge.
- Injected history is committed past narrative, not a new request; never repeat the last historical player action.`,
};
