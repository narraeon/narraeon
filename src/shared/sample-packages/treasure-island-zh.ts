import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const treasureIslandChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `布里斯托尔码头的海雾带着焦油和咸腥味。三桅纵帆船“伊斯帕尼奥拉号”正随着涨潮轻轻吱呀作响，甲板上的提灯把水手们的影子拉得很长。明早天一亮，这艘船就要起锚驶向南大西洋，去寻那座只在旧海图上留名的骷髅岛。

你受李甫西医生与屈利劳尼乡绅雇佣，以随船见习绘图员的身份登船。刚才你在货舱口点验过，淡水和干粮都备齐了。抬眼时，你无意间撞见两名新招的水手正压低声音核对一张撕掉半角的岛屿草图；见你走近，两人立刻收起纸片，笑着说不过是在认南方的星位。

此时你刚踏上主甲板，身形挺拔、神情冷峻的斯莫莱特船长正把一份水手名册折进大衣口袋，朝你低声道：“年轻人，我不喜欢这趟买卖——全船人似乎都知道我们要去找财宝，偏偏只瞒着我这个船长。而且火药和枪支都堆在前舱，紧挨着水手们的吊床。”

话音未落，厨房门帘一掀，拄着单拐、肩头停着一只绿毛鹦鹉的独脚厨师朗·约翰·西尔弗端着热朗姆酒笑盈盈走来：“船长先生，雾重风凉，给新来的绘图小哥暖暖身子吧。伙计们可都盼着明早顺风扬帆呢！”

斯莫莱特船长没有接酒，只侧眼看向你：“你刚才从货舱上来。启航前最后一晚，你打算先跟我和医生私下谈谈，还是去和西尔弗以及甲板上的水手们套套近乎？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.treasure-island
  ref: current-situation
  title: 金银岛当前情境
  summary: 记录眼下的航程阶段、时地、在场人物与玩家待决定的事。
  aliases: []
背景:
  时间: 第 1 夜 · 启航前夕（布里斯托尔码头）
  地点: 伊斯帕尼奥拉号主甲板与码头栈桥
  航程阶段: 第一幕 · 启航前夜
在场:
  - { $ref: character.ti-protagonist }
  - { $ref: character.ti-smollett }
  - { $ref: character.ti-silver }
待决定:
  选择: 绘图员要先与斯莫莱特船长和医生私谈，还是去和西尔弗及甲板上的水手交谈？
  现场: 船长没有接酒；西尔弗还端着热朗姆酒站在几步外。
`,
  },
  {
    path: "world/characters/protagonist.yaml",
    contents: `$document:
  id: character.ti-protagonist
  ref: protagonist
  title: 随船见习绘图员
  summary: 受雇随伊斯帕尼奥拉号出海的年轻绘图员，姓名、来历与立场选择均由玩家决定。
  aliases: []
状态:
  体力: 12 / 12（完好）
  士气: 沉着
专长加值:
  航海与攀爬: +3
  观察与绘图: +4
  交涉与察言: +2
  潜行与机敏: +3
  格斗与射击: +1
随身装备:
  - 黄铜袖珍罗盘与绘图炭笔
  - 折刀一把与防水油纸卷
  - 乡绅签发的登船委任状
立场: 由玩家在航程中决定。
`,
  },
  {
    path: "world/characters/smollett.yaml",
    contents: `$document:
  id: character.ti-smollett
  ref: smollett
  title: 斯莫莱特船长
  summary: 负责指挥伊斯帕尼奥拉号的船长。
  aliases: [船长]
动机: 保证航行安全、守住枪械火药并把忠实船员平安带回英国；只要拿到确凿证据，他会立刻采取果断防备。
行事: 说话直率不留情面，但言出必行、绝不亏待忠诚部下。
认知:
  知道: 乡绅把寻宝的风声漏了出去，而整批水手几乎全由独脚厨师西尔弗代为招募；枪械与火药目前存放在离船尾舱太远的前舱。
  不知: 尚未拿到水手密谋兵变的实据，也不知道货舱口那张撕掉半角的岛屿草图。
`,
  },
  {
    path: "world/characters/silver.yaml",
    contents: `$document:
  id: character.ti-silver
  ref: silver
  title: 朗·约翰·西尔弗
  summary: 伊斯帕尼奥拉号上拄着单拐的独脚厨师。
  aliases: [西尔弗]
动机: 拿到弗林特船长埋在骷髅岛的宝藏，但最看重自身性命与实利——形势不利时他随时能倒戈谈判，绝不盲目硬拼。
行事: 在人前永远笑眯眯、待小辈格外热络，擅长用人情话术试探底细；一旦察觉被识破，反应极快且心狠手辣。
认知:
  知道: 船上大半水手是旧海盗同伙，计划等宝藏装船后再动手夺船（详见 @ship-roster）；他已叮嘱手下在启航前切勿惹事。
  防备: 留意到玩家刚从货舱口上来，正借端酒的工夫不动声色试探玩家有没有听见什么。
`,
  },
  {
    path: "world/characters/livesey.yaml",
    contents: `$document:
  id: character.ti-livesey
  ref: livesey
  title: 李甫西医生
  summary: 随船医生，与屈利劳尼乡绅一同雇用了绘图员。
  aliases: [医生]
所在: { $ref: location.ti-bristol-quay }
兼任: 治安官。
动机: 保护同行伙伴性命，确保寻宝之行不演变成流血惨剧。
行事: 善于倾听、处变不惊，在船长与乡绅争执时总能拿出折中而稳妥的办法；若玩家带回货舱见闻，他会立刻意识到事态严重。
认知:
  知道: 真正的藏宝图原件锁在屈利劳尼乡绅贴身暗袋里，尚未落入水手之手。
`,
  },
  {
    path: "world/characters/hands.yaml",
    contents: `$document:
  id: character.ti-hands
  ref: hands
  title: 伊斯雷尔·汉兹
  summary: 伊斯帕尼奥拉号上经验丰富的舵手。
  aliases: [汉兹]
隐情: 表面服从管教，实为西尔弗手下最危险的同伙之一。
动机: 贪图宝藏与朗姆酒，对西尔弗的“先忍耐后动手”颇不耐烦，容易在酒后或孤立时露出破绽。
认知:
  知道: 刚才在货舱口与同伙核对那张撕掉半角的岛屿草图时撞见了玩家，心里正盘算要不要趁夜试探或警告玩家。
`,
  },
  {
    path: "world/characters/ben-gunn.yaml",
    contents: `$document:
  id: character.ti-ben-gunn
  ref: ben-gunn
  title: 本·冈恩
  summary: 一名水手。
  aliases: []
所在: { $ref: location.ti-island-shore }
经历: 被旧海盗同伙遗弃在骷髅岛已三年，熟悉全岛的小路。
动机: 极度渴望吃上一口真正的英国奶酪、乘船回家，并避开西尔弗的报复。
认知:
  知道: 早在两年前就独自挖出了弗林特的宝藏，并秘密搬进了北山隐蔽岩洞（详见 @island-notes）；还藏着一艘亲手做的兽皮小舟。
`,
  },
  {
    path: "world/locations/bristol-quay.yaml",
    contents: `$document:
  id: location.ti-bristol-quay
  ref: bristol-quay
  title: 布里斯托尔码头与甲板
  summary: 布里斯托尔的码头栈桥、靠岸船只与酒馆“望远镜”。
  aliases: []
格局: 船尾舱住着船长、医生与乡绅；前舱紧挨水手吊床；码头尽头是西尔弗常去的“望远镜”酒馆。
可做之事: 可向船长与医生汇报货舱所见以推动重新分配火药舱，可潜入酒馆或前舱听风声，也可趁启航前在码头添置补给。
`,
  },
  {
    path: "world/locations/hispaniola-hold.yaml",
    contents: `$document:
  id: location.ti-hold
  ref: hispaniola-hold
  title: 伊斯帕尼奥拉号舱室
  summary: 伊斯帕尼奥拉号的厨房、货舱与船尾舱。
  aliases: []
隐蔽处: 主甲板与厨房交界处摆着一只半空的大苹果桶，夜深时躲在里面可以听清西尔弗与海盗同伙的密谈（需潜行检定，详见 @ship-roster）。
风险: 一旦起锚出海，船上人手对立会迅速白热化；火药和枪械的归属将直接决定双方强弱。
`,
  },
  {
    path: "world/locations/island-shore.yaml",
    contents: `$document:
  id: location.ti-island-shore
  ref: island-shore
  title: 骷髅岛海滩与松林
  summary: 骷髅岛的海湾、白沙海滩与沿岸松林。
  aliases: []
地形: 沼泽与白沙海滩交错，林间有清泉与蜿蜒兽径；海盗登岸放风时，林中常有暗哨。
遇险与机缘: 独自或带少量同伴潜入北侧松林时，可能撞见衣衫褴褛却熟悉全岛的本·冈恩（@island-notes）。
`,
  },
  {
    path: "world/locations/stockade.yaml",
    contents: `$document:
  id: location.ti-stockade
  ref: stockade
  title: 山腰旧木寨
  summary: 骷髅岛山坡上的圆木围寨与林中空地。
  aliases: []
防御: 圆木围墙带射击孔，屋内有淡水井与干柴；谁先占领木寨并运来弹药粮草，谁就掌握了岛上对峙的主动权。
谈判: 西尔弗惯用白旗来木寨外谈判，随时准备按局势提出停战或交换海图的条件（详见 @parley-notes）。
`,
  },
  {
    path: "world/locations/spyglass-hill.yaml",
    contents: `$document:
  id: location.ti-spyglass-hill
  ref: spyglass-hill
  title: 望远镜山
  summary: 骷髅岛上长满松树的高地。
  aliases: []
现场: 红叉大松树下其实早已只剩一个空坑与几枚零星旧金币；真正的宝藏藏在北坡高处本·冈恩的岩洞里。
`,
  },
  {
    path: "world/case/voyage-log.yaml",
    contents: `$document:
  id: case.ti-voyage-log
  ref: voyage-log
  title: 航海与暗流记录
  summary: 记录玩家已知的补给与武备、已察觉的异常和同行人物。
  aliases: []
补给与武备:
  淡水与干粮: 绘图员已在货舱口点验齐备
  枪械与火药: 船长说存放在前舱，紧挨水手吊床
已察觉异常:
  货舱草图: 两名新水手在货舱口低声核对一张撕掉半角的岛屿草图，见绘图员走近便收起，声称在认南方星位。
  船长疑虑: 斯莫莱特船长说寻宝的风声似乎传遍了全船，也担心武备离水手吊床太近。
同行人物:
  斯莫莱特船长: 在主甲板叫住绘图员，提议与医生一起私下交谈
  李甫西医生: 与屈利劳尼乡绅一同雇用绘图员
  朗·约翰·西尔弗: 随船厨师，在主甲板端来热朗姆酒
`,
  },
  {
    path: "world/archives/ship-roster.yaml",
    contents: `$document:
  id: archive.ti-mutiny-roster
  ref: ship-roster
  title: 伊斯帕尼奥拉号船员档案
  summary: 伊斯帕尼奥拉号船上人员与航行安排的备查记录。
  aliases: []
事实记录:
  人员比例: 全船二十六人中，包括西尔弗与汉兹在内有十九人是弗林特旧部，已知忠于雇主的有船长、医生、乡绅及三名老实水手共六人，玩家的立场由游玩决定。
  原定计划: 西尔弗主张等船长把船安全开到岛上、找到宝藏装船后再趁回程动手；汉兹等急躁水手则随时想提前夺船。
`,
  },
  {
    path: "world/archives/island-notes.yaml",
    contents: `$document:
  id: archive.ti-ben-gunn-hoard
  ref: island-notes
  title: 骷髅岛札记
  summary: 骷髅岛往事与现况的备查记录。
  aliases: []
事实记录:
  宝藏去向: 弗林特原藏宝坑早在两年前就被流放水手本·冈恩挖空，七十万英镑金币与银条已分批搬进北坡干燥岩洞。
  本·冈恩诉求: 他渴望吃上一块英国奶酪并搭船安全返航，愿以岩洞位置和藏在岸边的兽皮小舟作为交换。
`,
  },
  {
    path: "world/archives/parley-notes.yaml",
    contents: `$document:
  id: archive.ti-silver-bargain
  ref: parley-notes
  title: 交涉札记
  summary: 航程中可能用到的交涉资料。
  aliases: []
事实记录:
  真实立场: 西尔弗对海盗同伙并无死忠，最怕回英国上绞刑架。
  可谈底线: 只要对方能保他免受绞刑并留一份活路，他愿意反过来稳住暴躁海盗，甚至协助夺回帆船。
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "d20" }),
  ...storyControlFiles(
    "zh-CN",
    "bristol-quay",
    `# 金银岛：暗流航程（d20 长线航海冒险）

这是一场跨布里斯托尔启航、海上暗流与骷髅岛博弈的三幕长线冒险。保留古典航海冒险的爽快节奏与人物锋芒，允许玩家改写原著走向，甚至中途走完全不同的阵营路线。

## d20 跑团判定与状态维护

- 日常交谈与普通行动直接叙事；只在存在显著风险、潜行偷听、风浪操帆、高难度说服、夺堡交火或荒岛追踪时发起 d20 检定，参考 @protagonist 的专长加值并给出清晰难度（DC）。
- 检定失败永远推动局势演变：如打草惊蛇、耗费补给、体力受损、被迫退守木寨或让某名水手倒向西尔弗，绝不原地卡关。
- 体力、士气或随身装备变化时更新 @protagonist。时地、在场人物或待决定事项变化时更新 @current-situation 正文，保持标题和简介稳定。换幕时只在 @current-situation 的「背景／航程阶段」更新航程阶段。
- @voyage-log 只记录玩家已知的补给与武备、已察觉的异常和同行人物。按观察或证词记录来源，随玩家获得的新信息更新相应条目。

## 按需读取与三幕推进

- 除起点 @bristol-quay 外，其余四处地点与 @ship-roster、@island-notes、@parley-notes 三份档案均按需通过 context_read 读取，严禁在玩家尚未触发对应剧情前提前剧透。
- 随玩家选择自然推进「第一幕 启航前夜 → 第二幕 海上暗流 → 第三幕 骷髅岛对峙」，在每个关键阵营或战术节点停下交由玩家拍板。
`,
    ["voyage-log"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "sailor-sheet",
          title: "绘图员状态",
          items: [
            {
              id: "vitality-morale",
              label: "状态",
              document: "protagonist",
              locator: ["状态"],
            },
            {
              id: "bonuses",
              label: "专长加值（d20）",
              document: "protagonist",
              locator: ["专长加值"],
            },
            {
              id: "gear",
              label: "随身装备",
              document: "protagonist",
              locator: ["随身装备"],
            },
          ],
        },
        {
          id: "voyage-board",
          title: "航程与暗流",
          items: [
            {
              id: "voyage-act",
              label: "航程阶段",
              document: "current-situation",
              locator: ["背景", "航程阶段"],
            },
            {
              id: "supplies-arms",
              label: "补给与武备",
              document: "voyage-log",
              locator: ["补给与武备"],
            },
            {
              id: "noticed-signs",
              label: "已察觉异常",
              document: "voyage-log",
              locator: ["已察觉异常"],
            },
            {
              id: "shipmates",
              label: "同行人物",
              document: "voyage-log",
              locator: ["同行人物"],
            },
          ],
        },
      ],
    },
  ),
];
