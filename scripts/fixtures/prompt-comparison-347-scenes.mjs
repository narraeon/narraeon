import { stringify } from "yaml";
import {
  packageFiles as originalPackageFiles,
  scenes as originalScenes,
} from "./prompt-comparison-344-scenes.mjs";

const fieldsByScene = {
  inn: {
    fixed: {
      房间规矩:
        "叶岚保管二楼房钥匙。每晚四枚铜钱，先付款后给钥匙。叶岚不赊房、不因一句求情改价，允许在大厅公共坐席避雨。",
      失物盒规矩:
        "门旁公用失物盒有投入口，投递无需许可，东西落进去后归盒子保管。你知道这些规矩。",
      职责: "沈荷无权处置客房。唐九不替陌生人付钱。",
    },
    facts: {
      现场: "傍晚，你在盐钟客栈大厅。窗沿有雾，黄铜壁灯一直亮着，木钟有轻响。你、掌柜叶岚、修靴匠沈荷和驿差唐九在场。",
      正在做的事: "沈荷在等补靴材料，唐九还要送路单，急着走。",
      房钱: "你未付房钱，也未订房或欠债。",
      担保: "你没有别人担保。",
      抵押: "你没带可抵押的东西。",
      当前保管: "你只有袖袋里的一枚青玻璃扣。",
    },
    voices: [
      "叶岚说话像点账，习惯纠正条件与数目。",
      "沈荷闲谈时善用干巴巴的玩笑，观察物件细节。",
      "唐九话短，常省主语。",
    ],
    negativeFields: ["房钱", "担保", "抵押"],
  },
  harbor: {
    fixed: {
      专渡规矩:
        "阿弦管跳板，只向当班登记的船主发放专渡船，不能私放，谁求也一样。他可以告知你早班公共渡船。",
      还件箱规矩:
        "栏杆上钉着一个可以直接投放还件的公共还件箱，木楔投入后由箱子保管。你知道这些规矩。",
      职责: "许葵和罗麦管不了船。",
    },
    facts: {
      现场: "入夜前，你在纸灯埠候船雨棚。你、阿弦、许葵和罗麦在场。白纸灯、湿麻绳气味和轻敲木桩的潮尺就在附近。",
      正在做的事: "许葵在收摊，罗麦正在记一次平常潮数，有一点好奇。",
      资格: "你不在名单，也没有凭条。",
      船资: "你没有付船资。",
      担保: "你没有找到担保人。",
      承诺: "你没有作过承诺。",
      当前保管: "身上有一枚公共坡道用的木楔，你已临时借用完毕。",
    },
    voices: [
      "阿弦说话先给结论，再给一条理由。",
      "许葵常拿当事人的原话反问，以鱼摊生意解释事情。",
      "罗麦说话爱补一个很具体的数字。",
    ],
    negativeFields: ["资格", "船资", "担保", "承诺"],
  },
};

export const scenes = originalScenes.map((original) => {
  const { fixed, facts, voices, negativeFields } = fieldsByScene[original.id];
  return {
    ...original,
    situation: [...Object.values(fixed), ...Object.values(facts), ...voices],
    fixed,
    facts,
    voices,
    negativeFields,
  };
});

export function packageFiles(scene) {
  return originalPackageFiles(scene).flatMap((file) => {
    if (file.path === "world/current-situation.yaml") {
      const head = file.contents.slice(
        0,
        file.contents.indexOf("situation:\n"),
      );
      return [
        {
          ...file,
          contents:
            head + stringify({ 固定条件: scene.fixed, 情境: scene.facts }),
        },
      ];
    }
    if (file.path === "control/frame.yaml") {
      return [
        {
          ...file,
          contents: file.contents.replace(
            "instructions: []",
            "instructions:\n  - markdown: voices.md",
          ),
        },
        {
          path: "control/voices.md",
          contents:
            "# 人物写法\n\n" +
            scene.voices.map((voice) => "- " + voice + "\n").join(""),
        },
      ];
    }
    return [file];
  });
}
