import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const qingzhouTalesChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `秋雨连下三日，青州城西的官道泥泞难行。你收伞跨进城西茶肆时，檐下的纸灯笼正被风吹得左右轻晃，灶上熬着生姜红糖茶，屋里飘着湿柴和艾草的气味。

孙掌柜刚给你斟满一碗热茶，靠窗那桌的年轻捕快沈青便叹了口气，把一张湿了半边的公文拍在桌上：“枯井驿站昨夜又丢了行商的生辰帖。人好端端睡在通铺里，醒来包袱分文未少，单单少了贴身收着的生辰八字帖——这已是本月第三桩。”

墙角烤火的老道士玄微子抬起眼皮，将一枚裂了细纹的桃木符搁回茶盘：“枯井那边抢的是活人运气，城外兰若废寺昨夜倒又响起了琴声，听着不像索命，倒像在压着什么。”

邻桌一位披着素白斗篷的年轻女子原本正低头翻书，听见“兰若”二字，翻页的指尖微微一顿。她抬眸看向你，神情从容温润：“这位客官面生，不知是往青州城里访友，还是路过柳溪？雨夜路滑，今夜打算留在茶肆歇脚，还是先问清楚哪一桩事？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.qingzhou-tales
  ref: current-situation
  title: 秋雨夜的城西茶肆
  summary: 三桩彼此暗牵的青州异闻在茶肆中同时浮出水面，等待行脚客择路查访。
  aliases: []
背景:
  时间: 深秋，雨夜，戌时初（第一夜）
  地点: 青州城西茶肆
  节气与忌讳: 霜降前夕，阴雨连绵，夜间山道多雾
在场:
  - { $ref: character.qingzhou-traveler }
  - { $ref: character.qingzhou-shen }
  - { $ref: character.qingzhou-xuanwei }
  - { $ref: character.qingzhou-suxin }
  - { $ref: character.qingzhou-sun }
待回应:
  说话者: { $ref: character.qingzhou-suxin }
  原话: 这位客官面生，不知是往青州城里访友，还是路过柳溪？雨夜路滑，今夜打算留在茶肆歇脚，还是先问清楚哪一桩事？
  现场: 沈青面前摊着枯井驿站的失帖公文；玄微子守着火盆把玩裂纹桃木符；白素心合上书页，平静地望着你。
`,
  },
  {
    path: "world/characters/traveler.yaml",
    contents: `$document:
  id: character.qingzhou-traveler
  ref: protagonist
  title: 行脚客
  summary: 途经青州府的游学书生或行脚医者，姓名、来历与处世立场均由玩家决定。
  aliases: []
精气神:
  体魄: 尚佳（微染秋寒）
  定力: 清明（未受幻象侵扰）
  晦气: 无
随身行囊:
  - 通关文牒与游学/行医随笔
  - 祖传半面旧铜镜（镜背刻云雷纹）
  - 朱砂小笔、黄纸数张与火折子
  - 碎银几两与干粮
处世边界: 既可重人情因果、居中调解人妖恩怨，也可仗义追查幕后邪术或只作旁观记录。
`,
  },
  {
    path: "world/characters/shen-qing.yaml",
    contents: `$document:
  id: character.qingzhou-shen
  ref: shen-qing
  title: 沈青
  summary: 青州县衙的年轻捕快，重实证、少迷信，正奉命追查枯井驿站失帖案。
  aliases: [沈捕快]
动机: 枯井驿站一月内丢了三张行商生辰帖，县令限期五日查明；他不信鬼神作祟，怀疑是熟悉驿站内情的人暗中勾结江湖术士。
行事: 说话干脆，讲究人证物证；若玩家拿出实在线索，他愿意借出县衙旧案卷或同行夜探。
认知:
  知道: 三名失主都在枯井驿站喝过驿丞端来的桂花热茶，且丢帖前夜都听见院里枯井传来细碎铜铃声。
  不知: 尚未把失帖案与柳溪旧宅、兰若废寺联系起来，也不知道白素心的真实来历。
`,
  },
  {
    path: "world/characters/xuanwei.yaml",
    contents: `$document:
  id: character.qingzhou-xuanwei
  ref: xuanwei
  title: 玄微子
  summary: 游方至青州的老道士，通晓符箓与古碑，并非见妖便斩的迂腐道人。
  aliases: [老道士]
动机: 察觉青州城西近月气运失衡，怀疑有人借邪术窃取活人生辰运气；同时想确认兰若废寺夜琴究竟是害人精魅，还是在镇压旧怨。
行事: 说话留三分余地，喜以茶酒论道；若玩家心术端正，愿赠安神符或传授辨认妖气与邪阵的门道。
认知:
  知道: 桃木符上的裂纹是昨夜路过枯井驿站外墙时无故震裂的，说明那里藏着人为布下的借运邪阵。
  观察: 隐约觉得邻桌白素心周身带着清雅药香与淡淡灵气，但并无血腥煞气，因此按兵不动，静观其变。
`,
  },
  {
    path: "world/characters/bai-suxin.yaml",
    contents: `$document:
  id: character.qingzhou-suxin
  ref: bai-suxin
  title: 白素心
  summary: 披素白斗篷的温润女客，实为修行百年的青丘狐女，暗中护着柳溪周家。
  aliases: [白姑娘]
动机: 十年前落难时曾得周言亡父搭救，如今察觉有人借枯井邪阵抽取柳溪一带的气运，连累周言体弱、新妇受惊，特来暗中周旋并查清幕后黑手。
行事: 进退有礼，对玄微子心存三分戒备，但极看重诚信与人情；若玩家不以异类相轻、愿共查枯井幕后主使，她会坦诚相告并相助。
认知:
  知道: 兰若废寺的夜琴正是她所弹，借古寺旧琴压住从枯井飘散过来的阴煞；她也知道柳溪周家的新妇并非凡人，却心性良善（详见 @lanruo-zither-debt 与 @mirror-bride-truth）。
  不知: 尚未查清枯井驿站背后究竟是谁在主持借运阵。
`,
  },
  {
    path: "world/characters/zhou-yan.yaml",
    contents: `$document:
  id: character.qingzhou-zhou
  ref: zhou-yan
  title: 周言
  summary: 柳溪旧宅的寒门书生，半年前新娶妻子阿蘅，近月常觉倦怠多梦。
  aliases: [周书生]
所在: { $ref: location.qingzhou-willow-manor }
动机: 珍视温柔贤淑的妻子阿蘅，却隐约察觉她从不照铜镜、灯下影子极淡；他既怕邻里流言伤她，也想弄明白自己近来夜夜梦见枯井是怎么回事。
认知:
  知道: 妻子嫁来时只带了一轴古仕女画卷，挂在书斋北墙；近来每逢夜半，画卷常有淡淡莲香，而他胸口却时常发闷。
`,
  },
  {
    path: "world/characters/tea-master-sun.yaml",
    contents: `$document:
  id: character.qingzhou-sun
  ref: tea-master-sun
  title: 孙掌柜
  summary: 城西茶肆掌柜，熟知青州西郊十年旧闻与行商往来。
  aliases: [孙老板]
动机: 盼着西郊早日太平，商旅敢在雨夜歇脚。
认知:
  旧闻: 记得十年前县衙曾有一名管户籍文书的旧吏“钱文远”，因私改田契和生辰档册被革职，后来据说流落到枯井驿站一带替人代写书信。
  日常: 茶肆楼上有两间干爽客房可供歇脚，柜台后挂着青州西郊简图。
`,
  },
  {
    path: "world/locations/westgate-teahouse.yaml",
    contents: `$document:
  id: location.qingzhou-teahouse
  ref: westgate-teahouse
  title: 城西茶肆
  summary: 青州西郊的落脚基地，行商、捕快与游方之人常在此避雨换消息。
  aliases: []
格局: 楼下有火盆、茶桌与西郊简图，楼上是两间客房。
功能: 玩家可在此休整恢复体魄与定力、向孙掌柜打听旧闻、与沈青或玄微子商议对策，或从此处分头前往四处志怪地点。
`,
  },
  {
    path: "world/locations/lanruo-ruin.yaml",
    contents: `$document:
  id: location.qingzhou-lanruo
  ref: lanruo-ruin
  title: 兰若废寺
  summary: 城外松林深处的荒废古刹，夜间常传出清越古琴声。
  aliases: []
景象: 残碑半埋荒草，大殿偏厢却出奇干爽，石案上留着半炷安魂香与几枚白梅花瓣。
线索: 仔细查验香灰与琴案刻痕，可察觉此处并非聚阴害人之所，反而设有一道温和的镇煞音阵（详见 @lanruo-zither-debt）。
`,
  },
  {
    path: "world/locations/willow-manor.yaml",
    contents: `$document:
  id: location.qingzhou-willow-manor
  ref: willow-manor
  title: 柳溪旧宅
  summary: 溪畔白墙青瓦的书生旧宅，屋里所有铜镜都用素绢蒙着。
  aliases: []
景象: 院中老柳垂水，书斋北墙悬着一轴旧仕女画；周言与新妇阿蘅住在此处。
线索: 若拿玩家行囊中的半面旧铜镜或玄微子的符水细察，能发现阿蘅身无血煞，反而是周言床头压着一枚被人暗中塞入的生辰纸人（详见 @mirror-bride-truth）。
`,
  },
  {
    path: "world/locations/dry-well-post.yaml",
    contents: `$document:
  id: location.qingzhou-dry-well
  ref: dry-well-post
  title: 枯井驿站
  summary: 官道旁的老旧驿站，后院有口干涸十年的石砌枯井。
  aliases: []
景象: 驿站灯火昏黄，代写书信的账房先生钱文远常在柜台后打盹；后院枯井边长满暗苔，井壁三尺下嵌着暗砖。
线索: 掀开枯井暗砖或潜查钱文远的账匣，可找到失踪的三张生辰帖、铜铃丝线与完整的借运邪阵（详见 @borrowed-fate-ledger）。
`,
  },
  {
    path: "world/locations/city-god-shrine.yaml",
    contents: `$document:
  id: location.qingzhou-shrine
  ref: city-god-shrine
  title: 城隍古庙
  summary: 青州城西香火清冷的老城隍庙，庙祝保管着旧年的义冢与户籍抄本。
  aliases: []
线索: 旧抄本里记着十年前一桩旧案——当年被革职的旧吏钱文远曾私吞流民赈银，而周言之父曾替无名孤女立碑安葬（与柳溪画卷和兰若旧债相连）。
功能: 在庙中上香问签或翻检旧抄本，可为判断三桩异闻的因果提供实据。
`,
  },
  {
    path: "world/case/rumor-ledger.yaml",
    contents: `$document:
  id: case.qingzhou-rumor-ledger
  ref: rumor-ledger
  title: 青州异闻录
  summary: 仅记录玩家亲耳听闻或查实的传闻、因果线与同道信任，绝不提前写入幕后真相。
  aliases: []
已知传闻:
  枯井失帖: 沈青称枯井驿站本月已丢三张行商生辰帖，财物却分文未动。
  兰若夜琴: 玄微子称城外兰若废寺昨夜又响起琴声，似在压制异动。
  柳溪线索: 白素心听见“兰若”二字神色微动，主动问起玩家是否路过柳溪。
待解因果:
  - 枯井驿站偷生辰帖的究竟是何人，意欲何为？
  - 兰若废寺夜半弹琴者是谁，与白素心有何关联？
  - 柳溪旧宅里藏着怎样的隐情？
同道关系:
  捕快沈青: 初识，愿分享失帖案实情
  道士玄微子: 初识，态度从容观望
  白素心: 初识，礼数周全而有所保留
`,
  },
  {
    path: "world/archives/lanruo-zither-debt.yaml",
    contents: `$document:
  id: archive.qingzhou-lanruo-debt
  ref: lanruo-zither-debt
  title: 兰若夜琴与旧报恩
  summary: 用于核对兰若废寺夜琴与周家旧事的关联。
  aliases: []
事实记录:
  旧恩: 白素心乃青丘狐女，十年前负伤躲入兰若寺，得周言之父以草药相救且未曾泄密。
  夜琴缘由: 近月她察觉枯井方向每晚飘来吸人精气的邪阵阴煞，正顺着溪水漫向柳溪，于是夜夜在兰若废寺抚琴布音阵挡煞，却因此耗损修为，才化装来城西茶肆打探邪阵源头。
`,
  },
  {
    path: "world/archives/mirror-bride-truth.yaml",
    contents: `$document:
  id: archive.qingzhou-mirror-bride
  ref: mirror-bride-truth
  title: 柳溪新妇不照镜之谜
  summary: 新妇阿蘅的真实来历与周言近月倦怠多梦的真正病因。
  aliases: []
事实记录:
  阿蘅来历: 阿蘅原是十年前病逝于青州驿路的孤女幽魂，感念周父当年立碑安葬之恩，寄身旧画卷中前来照料寒门书生周言，因幽魂照铜镜会现出淡影才蒙起镜子，从未害人。
  真正病因: 周言夜夜倦怠多梦并非阿蘅所致，而是钱文远半月前借代写家书之机，在周言枕下塞了“借运纸人”，把周家气运悄悄引向了枯井驿站。
`,
  },
  {
    path: "world/archives/borrowed-fate-ledger.yaml",
    contents: `$document:
  id: archive.qingzhou-borrowed-fate
  ref: borrowed-fate-ledger
  title: 枯井借运帖簿
  summary: 枯井驿站失帖案的幕后主谋、作案手法与物证所在。
  aliases: []
事实记录:
  主谋: 驿站里的代书先生钱文远，正是十年前因私改户籍与贪墨赈银被革职的旧吏。
  手法与物证: 他得了残缺的“枯井借运术”，借驿站代写书信与安神热茶之便窃取商旅与周言的生辰帖，连同铜铃丝线一并压入枯井壁三尺下的暗砖中，妄图借众人运气翻身谋复职。
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "bag" }),
  ...storyControlFiles(
    "zh-CN",
    "westgate-teahouse",
    `# 聊斋行脚：青州夜话（混乱袋长线志怪）

以清代志怪笔记的雅致白话与人情冷暖为主调，不走血腥恐吓，而重在“人鬼狐殊途却有情、贪念邪术反胜妖异”。让玩家自由决定先查哪一桩传闻、信任哪位同道，以及最终如何处置人情与法度。

## 混乱袋（Chaos bag）判定节奏与状态维护

- 寻常问路、喝茶闲谈和显而易见的观察直接叙事，不必抽签；只在夜探荒寺、辨识妖气幻象、潜查枯井暗砖、顶着压力说服同道或直面借运邪阵时触发混乱袋抽签，并把签果自然演绎为“逢凶化吉、机缘巧合、或阴差阳错”。
- 抽签失利永远推进剧情：可表现为沾染晦气、耗费时辰、惊动钱文远戒心、或让同道暂时产生误会，绝不让线索死胡同。
- 每次体魄、定力、晦气或行囊变动后更新 @protagonist；每次时辰与地点推进后更新 @current-situation；仅将玩家亲历或核实的信息写入 @rumor-ledger。

## 按需读取与因果层层揭晓

- 除基地 @westgate-teahouse 外，其余四处地点与 @lanruo-zither-debt、@mirror-bride-truth、@borrowed-fate-ledger 三份档案均按需通过 context_read 读取，严禁在玩家尚未到达或查访前剧透。
- 允许玩家多日往返青州西郊，在茶肆休整、复盘线索、调解玄微子与白素心的微妙戒备，最终收束属于自己的青州夜话结局。
`,
    ["rumor-ledger"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "traveler-status",
          title: "行脚状态",
          items: [
            {
              id: "vitality-mind",
              label: "精气神",
              document: "protagonist",
              locator: ["精气神"],
            },
            {
              id: "satchel",
              label: "随身行囊",
              document: "protagonist",
              locator: ["随身行囊"],
            },
          ],
        },
        {
          id: "qingzhou-ledger",
          title: "青州异闻录",
          items: [
            {
              id: "known-rumors",
              label: "已知传闻",
              document: "rumor-ledger",
              locator: ["已知传闻"],
            },
            {
              id: "unresolved-threads",
              label: "待解因果",
              document: "rumor-ledger",
              locator: ["待解因果"],
            },
            {
              id: "companion-trust",
              label: "同道关系",
              document: "rumor-ledger",
              locator: ["同道关系"],
            },
          ],
        },
      ],
    },
  ),
];
