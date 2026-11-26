import type { AppLocale } from "../../protocol/appPreferences.ts";
import {
  sampleContentPackageIds,
  type SampleContentPackageId,
} from "../../protocol/sampleContentPackages.ts";

const descriptions = {
  "rainy-inn": {
    en: {
      genre: "Cozy mystery",
      title: "A Letter at the Rain Lantern Inn",
      premise:
        "Take shelter from the rain and help three strangers look for a missing letter.",
    },
    "zh-CN": {
      genre: "温馨日常",
      title: "雨灯旅店的一封信",
      premise: "进旅店避雨，顺手帮三位陌生人找一封不见了的信。",
    },
  },
  "missing-reel": {
    en: {
      genre: "Detective",
      title: "The Missing Reel",
      premise:
        "A recording vanishes before a public listening party. The people who had access remember the last hour differently.",
    },
    "zh-CN": {
      genre: "侦探破案",
      title: "消失的母带",
      premise:
        "公开试听会前，一盘母带不翼而飞。几位能接触母带的人对过去一小时的说法各不相同。",
    },
  },
  "screening-night": {
    en: {
      genre: "Campus life",
      title: "The Night the Courtyard Flooded",
      premise:
        "Rain moves in on your campus film night. Your friends have three ideas and a room booking that expires at six.",
    },
    "zh-CN": {
      genre: "校园生活",
      title: "院子积水的那一晚",
      premise:
        "一场雨搅了校园露天放映。社团伙伴各有主意，而备用教室的预约六点就要过期。",
    },
  },
  "last-proof": {
    en: {
      genre: "Urban romance",
      title: "The Last Print",
      premise:
        "Help a neighbor finish a print for your shared building on the eve of a print shop’s move.",
    },
    "zh-CN": {
      genre: "都市恋爱",
      title: "搬走前的最后一印",
      premise:
        "街角印刷店明天搬家。邻居在收工前约你一起印完一张属于这栋楼的海报。",
    },
  },
} satisfies Record<
  SampleContentPackageId,
  Record<AppLocale, { genre: string; title: string; premise: string }>
>;

export function sampleStoryDescription(
  id: SampleContentPackageId,
  locale: AppLocale,
) {
  return descriptions[id][locale];
}

export function sampleStoryChoices(locale: AppLocale) {
  return sampleContentPackageIds.map((id) => ({
    id,
    ...sampleStoryDescription(id, locale),
  }));
}
