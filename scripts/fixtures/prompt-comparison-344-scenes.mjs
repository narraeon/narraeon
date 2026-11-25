export const scenes = [
  {
    id: "inn",
    title: "盐钟客栈",
    opening:
      "窗玻璃下沿凝着雾。黄铜壁灯的火苗微微向右偏，柜台后的木钟慢半格才嗒一声。叶岚守着柜台，修靴匠沈荷坐在柜台侧面，驿差唐九刚把一叠路单抱进来。你站在柜台前。",
    situation: [
      "傍晚，你在盐钟客栈大厅。窗沿有雾，黄铜壁灯一直亮着，木钟有轻响。除了台前来客，在场只有掌柜叶岚、修靴匠沈荷、驿差唐九。",
      "通往安静二楼的楼梯在掌柜这一边。二楼房钥匙归叶岚，房钱每晚四枚铜钱，先付后给钥匙。叶岚不赊房，也不会因一句求情改价，但允许人在大厅公共坐席避雨。叶岚说话像点账，习惯纠正条件与数目。",
      "沈荷在等补靴材料，闲谈时善用干巴巴的玩笑，观察物件细节，无权处置客房。唐九还要送路单，话短，常省主语，急着走，不替陌生人付钱。",
      "你未付房钱，也未订房或欠债。你没有别人担保，没带可抵押的东西。你只有袖袋里的一枚青玻璃扣。门旁公用失物盒有投入口，投递无需许可，东西落进去后就归失物盒保管。你知道这些规矩。",
    ],
    object: "青玻璃扣",
    holder: "玩家袖袋",
    destination: "公用失物盒",
    turns: [
      "我走到灯下，朝叶岚说：‘楼上能给我一间房吗？我现在没有钱。’",
      "我站在原地，问沈荷和唐九：‘你们在这儿等的是同一件事吗？’",
      "我把袖袋里那枚青玻璃扣投入门边的公用失物盒，然后回柜台前。",
      "我留在柜台前，问叶岚：‘你能把房钥匙先交给我吗？我没说什么时候能付。’",
    ],
  },
  {
    id: "harbor",
    title: "纸灯埠",
    opening:
      "一股湿麻绳味从系缆柱旁散上来，檐下白纸灯晃了一下，缺口的潮尺轻敲木桩。渡船没有离开缆桩。渡头管事阿弦守着跳板，鱼摊老板许葵在刮木板，巡埠学徒罗麦蹲在近处抄潮数。",
    situation: [
      "入夜前，你在纸灯埠候船雨棚；你、阿弦、许葵和罗麦在场。白纸灯、湿麻绳气味和轻敲木桩的潮尺就在附近。",
      "渡头管事阿弦管跳板，专渡船只先向当班登记的船主发放，你不在名单，也没有凭条。阿弦不能私放专渡船，谁求也一样；他可以告知你早班公共渡船。他说话先给结论，再给一条理由。",
      "许葵常拿当事人的原话反问，以鱼摊生意解释事情，正在收摊，管不了船。罗麦正在记一次平常潮数，有一点好奇，说话爱补一个很具体的数字，也管不了船。",
      "你没有付船资、找到担保人或作过承诺。身上有一枚公共坡道用的木楔，你已临时借用完毕。栏杆上钉着一个可直接投放还件的公共还件箱，木楔投入后由箱子保管。你知道这些规矩。",
    ],
    object: "木楔",
    holder: "玩家衣袋",
    destination: "公共还件箱",
    turns: [
      "我在跳板前站住，对阿弦说：‘我没有凭条，能把专渡船先借给我吗？’",
      "我站在原地，分别问许葵和罗麦：‘你今晚还剩什么事没办？’",
      "我从衣袋取出借来的木楔，投进栏杆上的公共还件箱，随后走回跳板前。",
      "我留在跳板前，问阿弦：‘现在能把开船的钥匙给我吗？我没打算替任何人担保。’",
    ],
  },
];

export function packageFiles(scene) {
  const worldHeader = (id, ref, title, summary) =>
    `$document:\n  id: ${id}\n  ref: ${ref}\n  title: ${title}\n  summary: ${summary}\n  aliases: []\n`;
  return [
    { path: "opening.md", contents: scene.opening + "\n" },
    {
      path: "world/current-situation.yaml",
      contents:
        worldHeader(
          "situation.current",
          "current-situation",
          "当前情境",
          "现场地点、人物和已有条件",
        ) +
        "situation:\n" +
        scene.situation
          .map((line) => "  - " + JSON.stringify(line) + "\n")
          .join(""),
    },
    {
      path: "world/object.yaml",
      contents:
        worldHeader(
          "object.custody",
          "object-custody",
          "物品保管",
          "现场小物的当前保管位置",
        ) + `物品: ${scene.object}\n保管位置: ${scene.holder}\n`,
    },
    {
      path: "control/frame.yaml",
      contents:
        'format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions: []\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: document, document: "@object-custody" }\n  - slot: { kind: additional_materials }\n',
    },
    {
      path: "control/player-views.yaml",
      contents:
        "format: narraeon.player-views/v1\nviews:\n  - id: object\n    title: 物品\n    items:\n      - id: custody\n        label: 保管位置\n        select: { document: '@object-custody', locator: { yaml: [保管位置] } }\n",
    },
  ];
}
