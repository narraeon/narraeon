import { withContinuityScaffold } from "../continuity-scaffold.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { SampleContentPackageId } from "../../protocol/sampleContentPackages.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { bakerStreetFogEnglish } from "./baker-street-fog-en.ts";
import { bakerStreetFogChinese } from "./baker-street-fog-zh.ts";
import { sampleStoryDescription } from "./catalog.ts";
import { fogbellHarborEnglish } from "./fogbell-harbor-en.ts";
import { fogbellHarborChinese } from "./fogbell-harbor-zh.ts";
import { lastProofEnglish } from "./last-proof-en.ts";
import { lastProofChinese } from "./last-proof-zh.ts";
import { lostSignalEnglish } from "./lost-signal-en.ts";
import { lostSignalChinese } from "./lost-signal-zh.ts";
import { missingReelEnglish } from "./missing-reel-en.ts";
import { missingReelChinese } from "./missing-reel-zh.ts";
import { qingzhouTalesEnglish } from "./qingzhou-tales-en.ts";
import { qingzhouTalesChinese } from "./qingzhou-tales-zh.ts";
import { rainyInnEnglish } from "./rainy-inn-en.ts";
import { rainyInnChinese } from "./rainy-inn-zh.ts";
import { screeningNightEnglish } from "./screening-night-en.ts";
import { screeningNightChinese } from "./screening-night-zh.ts";
import { tideVaultEnglish } from "./tide-vault-en.ts";
import { tideVaultChinese } from "./tide-vault-zh.ts";
import { treasureIslandEnglish } from "./treasure-island-en.ts";
import { treasureIslandChinese } from "./treasure-island-zh.ts";

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
  "fogbell-harbor": { en: fogbellHarborEnglish, "zh-CN": fogbellHarborChinese },
  "qingzhou-tales": { en: qingzhouTalesEnglish, "zh-CN": qingzhouTalesChinese },
  "treasure-island": {
    en: treasureIslandEnglish,
    "zh-CN": treasureIslandChinese,
  },
  "baker-street-fog": {
    en: bakerStreetFogEnglish,
    "zh-CN": bakerStreetFogChinese,
  },
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
