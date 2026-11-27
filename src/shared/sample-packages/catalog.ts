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
  "tide-vault": {
    en: {
      genre: "Fantasy exploration",
      title: "The Vault at Ebb Tide",
      premise:
        "Lead two companions into a vault exposed by the tide. An old ward shows where the water will rise, and someone is knocking from inside.",
    },
    "zh-CN": {
      genre: "奇幻探险",
      title: "潮退后的遗迹",
      premise:
        "退潮露出古水闸。你带两名同伴下去，遇见预示涨潮的古老微光，也听见深处有人敲墙。",
    },
  },
  "lost-signal": {
    en: {
      genre: "Science-fiction first contact",
      title: "Last Light Listening",
      premise:
        "A starship lost twenty years ago asks your relay for a berth. What will you exchange before either side agrees to come closer?",
    },
    "zh-CN": {
      genre: "科幻首次接触",
      title: "末灯在听",
      premise: "失踪二十年的星船请求泊位。在双方同意靠近前，你准备交换什么？",
    },
  },
  "fogbell-harbor": {
    en: {
      genre: "Tabletop · d100",
      title: "Seven Days at Fogbell Harbor",
      premise:
        "Ice fog seals the harbor for seven nights. Hired to audit a missing lighthouse keeper’s books, you step ashore to hear the innkeeper murmur that the fogbell tolled three times in dead calm last night.",
    },
    "zh-CN": {
      genre: "跑团调查 · d100",
      title: "雾钟港七日",
      premise:
        "冰雾封港七夜。你受雇核查失踪守塔人的旧账，刚登岸，旅店老板娘便低声告诉你，昨夜无风，雾钟却自己响了三声。",
    },
  },
  "qingzhou-tales": {
    en: {
      genre: "Tabletop · Chaos bag",
      title: "Night Tales of Qingzhou",
      premise:
        "Autumn rain strands you outside Qingzhou. A ruined temple plays at midnight, a new bride avoids every mirror, and travelers lose their birth-tallies at an old post—three strange tales quietly entwined.",
    },
    "zh-CN": {
      genre: "跑团志怪 · 混乱袋",
      title: "聊斋行脚：青州夜话",
      premise:
        "秋雨困住青州西郊。城外废寺夜闻琴声、旧宅新妇不照镜、枯井驿站屡失生辰帖——三桩异闻彼此暗牵，由你择路查访。",
    },
  },
  "treasure-island": {
    en: {
      genre: "Tabletop · d20",
      title: "Treasure Island: Aboard the Hispaniola",
      premise:
        "On the eve of sailing for Skeleton Island, Captain Smollett distrusts the newly signed crew, two hands hide a torn island sketch in the hold, and genial one-legged cook Long John Silver brings warm rum on deck.",
    },
    "zh-CN": {
      genre: "跑团航海 · d20",
      title: "金银岛：暗流航程",
      premise:
        "伊斯帕尼奥拉号启航前夜，斯莫莱特船长对新水手满怀戒心，货舱里有人匆匆藏起撕角的岛屿草图，热情的独脚厨师西尔弗却笑盈盈递来热酒。",
    },
  },
  "baker-street-fog": {
    en: {
      genre: "Long-form detective",
      title: "A Study in Grey Fog",
      premise:
        "November fog traps London. With Holmes and Watson south of the Thames, three leads reach 221B: Holmes’s folded notes, a pawned anchor coin from Lestrade, and a museum call slip brought by Wiggins.",
    },
    "zh-CN": {
      genre: "长线侦探 · 互动小说",
      title: "贝克街的灰雾委托",
      premise:
        "十一月浓雾封锁伦敦。福尔摩斯与华生外出盯梢，桌上留着三张便签，雷斯垂德送来海锚暗记金币，维金斯也带来一张博物馆借书单。",
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
