import { withContinuityScaffold } from "../continuity-scaffold.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { SampleContentPackageId } from "../../protocol/sampleContentPackages.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { sampleStoryDescription } from "./catalog.ts";
import { lastProofEnglish } from "./last-proof-en.ts";
import { lastProofChinese } from "./last-proof-zh.ts";
import { lostSignalEnglish } from "./lost-signal-en.ts";
import { lostSignalChinese } from "./lost-signal-zh.ts";
import { missingReelEnglish } from "./missing-reel-en.ts";
import { missingReelChinese } from "./missing-reel-zh.ts";
import { rainyInnEnglish } from "./rainy-inn-en.ts";
import { rainyInnChinese } from "./rainy-inn-zh.ts";
import { screeningNightEnglish } from "./screening-night-en.ts";
import { screeningNightChinese } from "./screening-night-zh.ts";
import { tideVaultEnglish } from "./tide-vault-en.ts";
import { tideVaultChinese } from "./tide-vault-zh.ts";

export interface SampleContentPackage {
  title: string;
  files: readonly ContentTreeFile[];
}

const stories = {
  "rainy-inn": { en: rainyInnEnglish.files, "zh-CN": rainyInnChinese.files },
  "missing-reel": { en: missingReelEnglish, "zh-CN": missingReelChinese },
  "screening-night": {
    en: screeningNightEnglish,
    "zh-CN": screeningNightChinese,
  },
  "last-proof": { en: lastProofEnglish, "zh-CN": lastProofChinese },
  "tide-vault": { en: tideVaultEnglish, "zh-CN": tideVaultChinese },
  "lost-signal": { en: lostSignalEnglish, "zh-CN": lostSignalChinese },
} satisfies Record<
  SampleContentPackageId,
  Record<AppLocale, readonly ContentTreeFile[]>
>;

/** Each caller receives an ordinary, independent content-tree seed. */
export function sampleContentPackageForLocale(
  locale: AppLocale,
  id: SampleContentPackageId = "rainy-inn",
): SampleContentPackage {
  return {
    title: sampleStoryDescription(id, locale).title,
    files: withContinuityScaffold(stories[id][locale], locale),
  };
}
