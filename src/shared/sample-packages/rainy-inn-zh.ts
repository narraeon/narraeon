import type { SampleContentPackage } from "./index.ts";

export const rainyInnChinese: SampleContentPackage = {
  title: "雨灯旅店的一封信",
  files: [
    {
      path: "opening.md",
      contents: `雨水沿着旅店的檐角落下，门上的小铜铃还在轻轻晃动。你面前的柜台亮着一盏暖黄的灯，湿伞架旁飘来姜茶的香气。

柜台后，一位系着墨绿围裙的女人把空的蓝瓷碟翻过来，又放回原处。「刚才还在这里的。」她低声说。

窗边穿灰色针织衫的客人抬起头：「是一个浅蓝信封，明早要寄给我妹妹。还没有封口。」她看向柜台边抱着登记簿的年轻邮差。邮差停下擦拭书角的手，神情有些茫然。

女人转向你，递来一条干毛巾：「先擦擦雨吧。我们正找一封信——你愿意帮忙看看吗？」柜台、伞架和窗边的小桌都在灯光里，她等着你的回答。
`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.rainy-inn
  ref: current-situation
  title: 灯下的空瓷碟
  summary: 雨灯旅店大厅里的一次小小寻物。
  aliases: []
背景:
  时间: 秋日，雨夜，晚上九点
  地点: 溪桥镇，雨灯旅店大厅
在场人物:
  - $ref: character.shen-he
  - $ref: character.lin-lan
  - $ref: character.zhou-cheng
进行中事件:
  寻信: 林岚发现寄给妹妹的浅蓝信封不在柜台蓝瓷碟上；大厅里尚未有人开始系统寻找。
待回应:
  说话者: { $ref: character.shen-he }
  邀请: 先擦擦雨吧。我们正找一封信——你愿意帮忙看看吗？
短期局面:
  - 你刚抵达门口，沈禾递来的干毛巾尚未被接过。
  - 周澄抱着登记簿，刚停下擦拭湿书角的动作。
`,
    },
    {
      path: "world/characters/shen-he.yaml",
      contents: `$document:
  id: character.shen-he
  ref: shen-he
  title: 沈禾
  summary: 雨灯旅店的店主，做事细致，待客温和。
  aliases: [沈老板]
外貌: 短发，眉眼柔和，袖口上有一点面粉。
衣着: 米色衬衣，墨绿围裙，布鞋。
性格: 耐心，遇到疏漏先寻找补救办法，不轻易责怪人。
关系:
  林岚:
    对象: { $ref: character.lin-lan }
    看法: 常住的熟客，珍惜她带来的植物故事；希望她今晚能安心休息。
  周澄:
    对象: { $ref: character.zhou-cheng }
    看法: 邻居家的年轻邮差，热心但偶尔忙中出错；愿意让他说明情况。
认知:
  信件: 记得把林岚的浅蓝信封放在蓝瓷碟上，此后忙着烧姜茶，没有留意柜台。
  依据: { $ref: event.letter-entrusted }
`,
    },
    {
      path: "world/characters/lin-lan.yaml",
      contents: `$document:
  id: character.lin-lan
  ref: lin-lan
  title: 林岚
  summary: 途经溪桥镇的植物绘图员，喜欢用信分享见闻。
  aliases: []
外貌: 戴圆框眼镜，指尖有淡淡的铅笔灰。
衣着: 灰色针织衫，深蓝长裤，晾在伞架旁的棕色雨披。
性格: 观察细致，说话慢，担心时会反复核对细节。
关系:
  沈禾:
    对象: { $ref: character.shen-he }
    看法: 熟悉而可靠的店主，信不见了也不认为她会故意隐瞒。
  周澄:
    对象: { $ref: character.zhou-cheng }
    看法: 今晚才认识的邮差，相信他熟悉寄信流程，尚不了解他的习惯。
重要物品:
  给妹妹的信: 浅蓝信封，未封口，内有一页见闻和一张手绘叶片图；原计划明早寄出。
认知:
  信件: 知道自己把信交给了沈禾；只看到现在瓷碟空了，不知道它后来去了哪里。
  依据: { $ref: event.letter-entrusted }
`,
    },
    {
      path: "world/characters/zhou-cheng.yaml",
      contents: `$document:
  id: character.zhou-cheng
  ref: zhou-cheng
  title: 周澄
  summary: 镇上的年轻邮差，雨天也会顺路帮邻居跑腿。
  aliases: [小周]
外貌: 头发被雨压得贴在额前，笑起来有浅酒窝。
衣着: 蓝色雨衣敞着扣子，条纹衬衣，湿了鞋尖的帆布鞋。
性格: 热心，做事容易分心；一旦发现自己弄错，愿意承认并帮忙补救。
关系:
  沈禾:
    对象: { $ref: character.shen-he }
    看法: 从小认识的邻居，信任她，也在意自己能否帮上忙。
  林岚:
    对象: { $ref: character.lin-lan }
    看法: 刚认识的客人，她的植物画很有趣，想请她解释画里的树叶。
认知:
  自己记得的动作: 刚才挪开柜台上的浅蓝信封给湿登记簿腾地方，顺手把它夹进登记簿封底；以为那只是空信封。
  当前理解: 尚未听清林岚在找什么，没有把她的信与自己挪过的信封联系起来。
随身物品:
  登记簿: 抱在手里，封底书角被雨打湿。
`,
    },
    {
      path: "world/locations/rain-lantern-inn.yaml",
      contents: `$document:
  id: location.rain-lantern-inn
  ref: rain-lantern-inn
  title: 雨灯旅店
  summary: 溪桥镇桥头的小旅店，邻里常来避雨喝茶。
  aliases: []
大厅: 木柜台正对入口，柜台上有蓝瓷碟和铜灯；窗边放着小桌，门旁是伞架。
日常: 客人可在大厅休息、喝姜茶，店主替熟客暂存待寄信件。
`,
    },
    {
      path: "world/events/letter-entrusted.yaml",
      contents: `$document:
  id: event.letter-entrusted
  ref: letter-entrusted
  title: 柜台上的托付
  summary: 林岚把待寄信件交给沈禾暂存的一次托付。
  aliases: []
时间: 今晚约半小时前
经过: 林岚将未封口的浅蓝信封交给沈禾，说明里面有给妹妹的信和叶片图；沈禾当着她的面放在柜台蓝瓷碟上。
原话: 林岚说「明早我再来封口，麻烦先放这里」。沈禾答应替她暂存。
来源: 林岚与沈禾当时都在柜台旁。
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 3 }
  - slot: { kind: catalog, directory: locations, maxEntries: 4 }
  - slot: { kind: catalog, directory: events, maxEntries: 12 }
  - slot: { kind: document, document: "@rain-lantern-inn" }
  - slot:
      kind: reference_targets
      from:
        document: "@current-situation"
        locator: { yaml: [在场人物] }
      maxEntries: 3
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`,
    },
    {
      path: "control/blocks/world.md",
      contents: `<!-- opening.md 是玩家看到的开场；world/current-situation.yaml 记录背景与待回应局面；characters/ 各自保存人物状态、关系与认知；locations/ 保存地点；events/ 保存共同往事；frame.yaml 选择游玩材料；player-views.yaml 选择状态栏原值。可从这些文件改写自己的故事。 -->

# 本世界的题材与边界

以小镇旅店的日常交谈和轻微悬疑为主，线索来自物件、记忆和误会。保持温暖、适合所有年龄；不引入暴力、成人内容或威胁生命的阴谋。信件的私人内容由收信人与写信人决定是否分享。

## 本世界的文档与保存位置

人物之间的关系、各自看法与认知写在各自的 world/characters/ 人物文档中，不设统一真相或秘密字段。需要共同引用的事件经过写在 world/events/，人物通过引用关联，不重复抄写经过。地点的持续变化写回 world/locations/。信件先作为所属人物的重要物品维护，需要独立转移追踪时再建文档。
`,
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1
views:
  - id: scene-status
    title: 此刻
    items:
      - id: time
        label: 时间
        select:
          document: "@current-situation"
          locator: { yaml: [背景, 时间] }
      - id: place
        label: 地点
        select:
          document: "@current-situation"
          locator: { yaml: [背景, 地点] }
`,
    },
  ],
};
