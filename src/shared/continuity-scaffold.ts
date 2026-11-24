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
        ? "按人物稳定键保存各人对彼此的信任、立场、义务、边界及依据（单向分开记录）。"
        : "One-way trust, stance, obligations, boundaries, and reasons indexed by stable person keys.",
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
    ? `\n## 连续性文档与保存位置\n\n持续变化需要保存时，写入对应的主体文档。眼前的短期局面记在 \`@current-situation\`。\`@pending-matters\` 的“未了事项”只保留仍有效的承诺、约定与未决事项；已兑现、撤销或失效的条目移出，需要共同追溯的经过记入 \`@important-events\`。\n\n\`@important-events\` 的“事件”按稳定事件键保存共同往事；\`@relationships\` 的“人物”按稳定人物键分别记录各人对彼此的信任、立场、义务、边界及依据。已有独立事件或关系记录时直接沿用并引用，避免重复维护。两份文档按需局部读取，例如 \`context_read({ref: "@relationships#/人物/人物键"})\` 或 \`context_read({ref: "@important-events#/事件/事件键"})\`；新增键前先读父节点。\n\n人物文档的“认知”段只记影响该人物行动的内容：知道什么、猜测或误解了什么、依据是什么，以及仍不清楚什么。\n`
    : `\n## Continuity documents and save locations\n\nWhen a lasting change needs to be saved, write it to its natural owner document. Immediate short-term circumstances go in @current-situation. In @pending-matters, the pending mapping holds only active promises, arrangements, and unresolved matters; remove fulfilled, withdrawn, or invalidated entries, and record accounts that need shared recall in @important-events.\n\nIn @important-events, index the events mapping by stable event keys; in @relationships, index the people mapping by stable person keys to record each person’s trust, stance, obligations, boundaries, and reasons toward others separately. Reuse and reference existing independent event or relationship records instead of duplicating them. Read both on demand, e.g. context_read({ref: "@relationships#/people/person-key"}) or context_read({ref: "@important-events#/events/event-key"}); read the parent node before adding keys.\n\nA character document's Knowledge section records only what affects that character's actions: what they know, what they guess or misunderstand, their basis, and what remains unknown to them.\n`;
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
