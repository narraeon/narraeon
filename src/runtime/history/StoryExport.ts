import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { V1StoryExport, V1StoryExportFormat } from "../../protocol/v1.ts";
import type { HistoryMessageInput } from "./HistoryQuery.ts";

export function exportStory(
  title: string,
  messages: readonly HistoryMessageInput[],
  format: V1StoryExportFormat,
  locale: AppLocale,
): V1StoryExport {
  const player = locale === "zh-CN" ? "我" : "Me";
  const separator = locale === "zh-CN" ? "：" : ": ";
  const blocks = messages.map(({ role, text }) => {
    if (role === "narrator") return text;
    if (format === "text") return `${player}${separator}${text}`;
    return text
      .split("\n")
      .map((line, index) =>
        index === 0 ? `> **${player}**${separator}${line}` : `> ${line}`,
      )
      .join("\n");
  });
  return {
    fileName: storyFileName(title, format),
    content: [format === "markdown" ? `# ${title}` : title, ...blocks].join(
      "\n\n",
    ),
  };
}

function storyFileName(title: string, format: V1StoryExportFormat): string {
  const extension = format === "markdown" ? ".md" : ".txt";
  let stem = title
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "")
    .trim()
    .replace(/[. ]+$/u, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem))
    stem = `_${stem}`;
  const characters = Array.from(stem).slice(0, 80 - extension.length);
  // Also fit filesystems that limit a filename to 255 UTF-8 bytes.
  while (Buffer.byteLength(characters.join("") + extension, "utf8") > 255)
    characters.pop();
  stem = characters.join("").replace(/[. ]+$/u, "");
  return `${stem || "story"}${extension}`;
}
