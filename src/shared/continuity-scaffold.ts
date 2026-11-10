import type { AppLocale } from "../protocol/appPreferences.ts";
import type { ContentTreeFile } from "../protocol/v1.ts";

/** Ordinary author-owned documents; no runtime schema or migration is implied. */
export function withContinuityScaffold(
  files: readonly ContentTreeFile[],
  locale: AppLocale,
): ContentTreeFile[] {
  const zh = locale === "zh-CN";
  const documents = [
    [
      "important-events",
      "continuity.events",
      zh ? "重要事件" : "Important events",
      zh
        ? "按事件稳定键保存需要共同追溯的往事。"
        : "Shared past accounts indexed by stable event keys.",
      zh ? "事件" : "events",
    ],
    [
      "relationships",
      "continuity.relationships",
      zh ? "人物关系" : "Relationships",
      zh
        ? "按人物稳定键保存有方向的信任、立场、义务与边界及其依据。"
        : "Directional trust, stance, obligations, boundaries, and their reasons by stable person keys.",
      zh ? "人物" : "people",
    ],
    [
      "pending-matters",
      "continuity.pending",
      zh ? "未了事项" : "Pending matters",
      zh
        ? "仍有效且影响后续选择的承诺、约定和未决事项。"
        : "Active promises, arrangements, and unresolved matters affecting future choices.",
      zh ? "未了事项" : "pending",
    ],
  ];
  const guidance = zh
    ? `\n## 连续性写回\n\n叙事提交前，将已成立的持续变化写回自然所有者；眼前局面写入 @current-situation。@pending-matters 只保留有效承诺、约定与未决事项，兑现、撤销或失效后移除；重要经过转入 @important-events。意图不等于结果。\n\n@important-events 的「事件」按稳定事件键保存共同往事；@relationships 的「人物」按稳定人物键保存各方向的信任、立场、义务、边界及依据。已有独立事件或关系记录沿用并引用，避免重复维护。按需读取，例如 context_read({ref: "@relationships#/人物/人物键"}) 或 context_read({ref: "@important-events#/事件/事件键"})；新增键前先读父映射。\n\n创作人物文档时采用「认知」段，只记影响行动的已知、猜测／误解、依据与未知。个人认知与客观事实分开，主持所知不自动成为人物知识。\n`
    : `\n## Continuity writeback\n\nBefore submitting narration, write established lasting changes to their natural owner and immediate circumstances to @current-situation. @pending-matters holds only active promises, arrangements, and unresolved matters: remove fulfilled, withdrawn, or invalidated entries; preserve important accounts in @important-events. Intentions are not outcomes.\n\nIn @important-events, index the events mapping by stable event keys. In @relationships, index the people mapping by stable person keys. Record directional trust, stance, obligations, boundaries, and reasons. Reuse and reference existing independent event or relationship records; avoid duplicates. Read on demand, e.g. context_read({ref: "@relationships#/people/person-key"}) or context_read({ref: "@important-events#/events/event-key"}); read the parent mapping before adding keys.\n\nAuthor character documents with a Knowledge section for behaviorally important known facts, beliefs/misunderstandings, evidence, and unknowns. Personal knowledge differs from objective fact; host knowledge does not automatically become character knowledge.\n`;
  return [
    ...files.map((file) => {
      if (file.path === "control/blocks/world.md")
        return { ...file, contents: file.contents + guidance };
      return { ...file };
    }),
    ...documents.map(([name, id, title, summary, key]): ContentTreeFile => ({
      path: `world/continuity/${name}.yaml`,
      contents: `$document:\n  id: ${id}\n  ref: ${name}\n  title: ${title}\n  summary: ${summary}\n  aliases: []\n${key}: {}\n`,
    })),
  ];
}
