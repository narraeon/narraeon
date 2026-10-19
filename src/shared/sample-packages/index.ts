import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { rainyInnEnglish } from "./rainy-inn-en.ts";
import { rainyInnChinese } from "./rainy-inn-zh.ts";

export interface SampleContentPackage {
  title: string;
  files: readonly ContentTreeFile[];
}

/** Each caller receives an ordinary, independent content-tree seed. */
export function sampleContentPackageForLocale(
  locale: AppLocale,
): SampleContentPackage {
  const sample = locale === "zh-CN" ? rainyInnChinese : rainyInnEnglish;
  return {
    title: sample.title,
    files: sample.files.map((file) => ({ ...file })),
  };
}
