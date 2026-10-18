import type { AppLocale } from "./appPreferences.ts";

export const resolutionSchemes = ["d20", "d100", "bag"] as const;
export type ResolutionScheme = (typeof resolutionSchemes)[number];
export type Gameplay =
  | { mode: "interactive-fiction" }
  | { mode: "tabletop"; scheme: ResolutionScheme };

export const fictionGameplay: Gameplay = { mode: "interactive-fiction" };
export const gameplayPath = "control/gameplay.json";
const gameplayFormat = "narraeon.gameplay/v1";

interface GameplayFileSource {
  path: string;
  contents: string;
  encoding?: string;
}

export function parseGameplay(value: unknown): Gameplay {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid gameplay choice / 玩法选择无效");
  const record = value as Record<string, unknown>;
  if (record.mode === "interactive-fiction" && Object.keys(record).length === 1)
    return { mode: "interactive-fiction" };
  if (
    record.mode === "tabletop" &&
    Object.keys(record).every((key) => key === "mode" || key === "scheme") &&
    resolutionSchemes.some((scheme) => scheme === record.scheme)
  )
    return { mode: "tabletop", scheme: record.scheme as ResolutionScheme };
  throw new Error(
    "Unknown gameplay type or resolution scheme / 未知的玩法类型或判定方案",
  );
}

/** A missing file is interactive fiction, so existing packages need no migration. */
export function readGameplay(files: readonly GameplayFileSource[]): Gameplay {
  const matches = files.filter(
    (file) => file.path.toLowerCase() === gameplayPath,
  );
  if (matches.length === 0) return { ...fictionGameplay };
  const file = matches[0]!;
  if (
    matches.length !== 1 ||
    file.path !== gameplayPath ||
    file.encoding !== undefined
  )
    throw new Error(
      "Gameplay identity must be canonical UTF-8 control/gameplay.json / 玩法身份必须是规范的 UTF-8 control/gameplay.json",
    );
  let value: unknown;
  try {
    value = JSON.parse(file.contents);
  } catch (error: unknown) {
    throw new Error(
      "Gameplay identity must be valid JSON / 玩法文件必须是合法 JSON",
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid gameplay identity / 玩法文件无效");
  const { format, ...gameplay } = value as Record<string, unknown>;
  if (format !== gameplayFormat)
    throw new Error("Unknown gameplay format / 未知的玩法文件格式");
  return parseGameplay(gameplay);
}

export function gameplayFile(gameplay: Gameplay): {
  path: string;
  contents: string;
} {
  return {
    path: gameplayPath,
    contents: `${JSON.stringify({ format: gameplayFormat, ...parseGameplay(gameplay) }, null, 2)}\n`,
  };
}

/** Content authoring may change the resolution scheme but never the gameplay mode. */
export function assertSameGameplayMode(
  before: readonly GameplayFileSource[],
  after: readonly GameplayFileSource[],
): void {
  if (readGameplay(before).mode !== readGameplay(after).mode)
    throw new Error(
      "Gameplay mode is fixed / 玩法模式不能在互动式小说与跑团之间切换",
    );
}

/** A world keeps both its gameplay mode and its resolution scheme. */
export function assertSameGameplay(
  before: readonly GameplayFileSource[],
  after: readonly GameplayFileSource[],
): void {
  if (gameplayKey(readGameplay(before)) !== gameplayKey(readGameplay(after)))
    throw new Error(
      "Gameplay mode and resolution scheme are fixed / 玩法模式与判定方案固定，不能修改",
    );
}

export function gameplayLabel(gameplay: Gameplay, locale: AppLocale): string {
  if (gameplay.mode !== "tabletop")
    return locale === "zh-CN" ? "互动式小说" : "Interactive fiction";
  const scheme =
    gameplay.scheme === "bag"
      ? locale === "zh-CN"
        ? "混乱袋"
        : "Chaos bag"
      : gameplay.scheme;
  return locale === "zh-CN" ? `跑团 · ${scheme}` : `Tabletop · ${scheme}`;
}

function gameplayKey(gameplay: Gameplay): string {
  return gameplay.mode === "tabletop" ? gameplay.scheme : gameplay.mode;
}
