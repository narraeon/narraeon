import { uiText } from "./i18n.ts";
import type { ArtifactMountName } from "./ArtifactExtensionHost.tsx";
import { defaultSettingImprovementPromptPath } from "../shared/default-setting-improvement-prompt.ts";
export const mountChoices: {
  value: ArtifactMountName;
  label: string;
  description: string;
}[] = [
  { value: "story", label: "剧情内容区", description: "跟随剧情正文显示" },
  { value: "sidebar", label: "右侧栏", description: "适合持续状态面板" },
  {
    value: "composer_above",
    label: "输入框上方",
    description: "适合行动建议或临时提示",
  },
  {
    value: "composer_below",
    label: "输入框下方",
    description: "适合不打断输入的辅助内容",
  },
  { value: "overlay", label: "浮层", description: "覆盖在游玩页面上方" },
  { value: "debug", label: "调试区", description: "只用于检查原始产物" },
];

export function mountLabel(mount: ArtifactMountName): string {
  const label = mountChoices.find(({ value }) => value === mount)?.label;
  return label === undefined ? mount : uiText(label);
}

export function withCurrentPath(paths: string[], current?: string): string[] {
  return [
    ...new Set([...paths, ...(current === undefined ? [] : [current])]),
  ].sort();
}

export function markdownTitle(contents: string): string {
  return /^#\s+(.+)$/mu.exec(contents)?.[1]?.trim() ?? uiText("未命名提示内容");
}

export function markdownExcerpt(contents: string): string {
  const excerpt = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join(" ");
  return excerpt.length > 88 ? `${excerpt.slice(0, 88)}…` : excerpt;
}

interface PresetFileDescription {
  path: string;
  title: string;
  kind: string;
  description: string;
}

export function describePresetFile(
  path: string,
  contents: string,
): PresetFileDescription {
  if (path === "preset.yaml")
    return {
      path,
      title: uiText("预设入口"),
      kind: uiText("核心 YAML"),
      description: uiText(
        "连接设定完善提示、调用链、界面显示位置、玩家视图面板和扩展资源；它回答“这份预设由哪些部分组成”。",
      ),
    };
  if (path === "call-chain.yaml")
    return {
      path,
      title: uiText("调用链与产物"),
      kind: uiText("核心 YAML"),
      description: uiText(
        "声明主响应使用哪些叙事提示、结束后有哪些后置请求，以及每个请求可以生成什么产物。",
      ),
    };
  if (path === "frame.yaml")
    return {
      path,
      title: uiText("主持规则顺序"),
      kind: uiText("核心 YAML"),
      description: uiText(
        "决定 Runtime 机械说明、主持规则块和世界指令以什么顺序进入稳定 bootstrap。",
      ),
    };
  if (path.startsWith("blocks/") && path.endsWith(".md"))
    return {
      path,
      title: markdownTitle(contents),
      kind: uiText("主持规则"),
      description: uiText(
        "跨世界成立的主持语义；是否发送给模型以及发送顺序由“提示内容”页控制。",
      ),
    };
  if (path === defaultSettingImprovementPromptPath)
    return {
      path,
      title: markdownTitle(contents),
      kind: uiText("设定完善提示"),
      description: uiText(
        "约束 AI 怎样理解、规划和创作内容包；工具定义、参数与说明仍由 Runtime 内置。",
      ),
    };
  if (path.startsWith("prompts/") && path.endsWith(".md"))
    return {
      path,
      title: markdownTitle(contents),
      kind: uiText("调用链提示"),
      description: uiText(
        "主响应或某个后置请求实际读取的 Markdown 指令；普通编辑可在“调用链”直接修改。",
      ),
    };
  if (path.startsWith("renderers/"))
    return {
      path,
      title: uiText("界面模板"),
      kind: "HTML renderer",
      description: uiText("把产物内容或玩家视图变成页面上的 HTML 结构。"),
    };
  if (path.startsWith("scripts/"))
    return {
      path,
      title: uiText("界面交互脚本"),
      kind: "JavaScript",
      description: uiText(
        "为 renderer 添加本地交互；导入预设后默认停用，只有显式信任后才执行。",
      ),
    };
  if (path.startsWith("assets/"))
    return {
      path,
      title: uiText("界面样式或资源"),
      kind: uiText("扩展资源"),
      description: uiText("供 renderer 或脚本读取的样式、文字或其他普通资源。"),
    };
  if (path.startsWith("regex/"))
    return {
      path,
      title: uiText("产物文本处理规则"),
      kind: "Regex YAML",
      description: uiText("在显示前对产物正文执行有界、可预览的正则处理。"),
    };
  return {
    path,
    title: path.split("/").at(-1) ?? uiText("未命名文件"),
    kind: uiText("普通文件"),
    description: uiText("随玩法预设保存和导出的普通业务文件。"),
  };
}

export function splitLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
