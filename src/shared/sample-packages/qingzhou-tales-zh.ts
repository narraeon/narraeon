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
  title: 青州当前情境
  summary: 记录青州行脚途中此刻的时地、在场者与待回应事项。
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
  待决定: 行脚客是否说清来意，并选择留在茶肆歇脚或先打听一桩传闻。
  现场: 沈青面前放着枯井驿站的失帖公文；玄微子把裂纹桃木符搁回茶盘；白斗篷女客从书上抬起眼，等行脚客答话。
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
  summary: 青州县衙的年轻捕快，查案讲究人证物证。
  aliases: [沈捕快]
动机: 茶肆第一夜所在的那个月，枯井驿站丢了三张行商生辰帖，第三张丢在第一夜的前一夜。他不信鬼神作祟，怀疑是熟悉驿站内情的人暗中勾结江湖术士。
期限: 县令从城西茶肆开场的第一夜戌时初算起，给他五整日查案，到第六夜戌时初为止。
行事: 说话干脆，讲究人证物证；若玩家拿出实在线索，他愿意借出县衙旧案卷或同行夜探。
认知:
  知道: 三名失主都在生辰帖失窃的当夜喝过驿丞端来的桂花热茶，也听见院里枯井传来细碎铜铃声。
  不知: 尚未把失帖案与柳溪旧宅、兰若废寺联系起来，也不知道白素心的真实来历。
`,
  },
  {
    path: "world/characters/xuanwei.yaml",
    contents: `$document:
  id: character.qingzhou-xuanwei
  ref: xuanwei
  title: 玄微子
  summary: 游方至青州的老道士，通晓符箓与古碑。
  aliases: [老道士]
动机: 城西茶肆第一夜之前约一个月间，察觉青州城西气运失衡，怀疑有人借邪术窃取活人气运；同时想确认兰若废寺夜琴究竟是害人精魅，还是在镇压旧怨。
行事: 说话留三分余地，喜以茶酒论道；若玩家心术端正，愿赠安神符或传授辨认妖气与邪阵的门道。
认知:
  知道: 茶肆第一夜的前一夜，他路过枯井驿站外墙时，桃木符无故震裂，说明那里藏着人为布下的借运邪阵。
  观察: 隐约觉得邻桌白素心周身带着清雅药香与淡淡灵气，但并无血腥煞气，因此按兵不动，静观其变。
`,
  },
  {
    path: "world/characters/bai-suxin.yaml",
    contents: `$document:
  id: character.qingzhou-suxin
  ref: bai-suxin
  title: 白素心
  summary: 在青州西郊往来的白斗篷女客，待人温和有礼。
  aliases: [白姑娘]
身份: 修行百年的青丘狐女，暗中护着柳溪周家。
动机: 距茶肆第一夜约十年，她落难时曾得周言之父搭救。开场前察觉有人借枯井邪阵抽取柳溪一带的气运，连累周言体弱、新妇受惊，特来暗中周旋并查清幕后黑手。
行事: 进退有礼，对玄微子心存三分戒备，但极看重诚信与人情；若玩家不以异类相轻、愿共查枯井幕后主使，她会坦诚相告并相助。
认知:
  知道: 兰若废寺的夜琴正是她所弹，借古寺旧琴压住从枯井飘散过来的阴煞；她也知道柳溪周家的新妇并非凡人，却心性良善（详见 @lanruo-records 与 @willow-manor-records）。
  不知: 尚未查清枯井驿站背后究竟是谁在主持借运阵。
`,
  },
  {
    path: "world/characters/zhou-yan.yaml",
    contents: `$document:
  id: character.qingzhou-zhou
  ref: zhou-yan
  title: 周言
  summary: 住在柳溪旧宅的寒门书生。
  aliases: [周书生]
所在: { $ref: location.qingzhou-willow-manor }
动机: 距茶肆第一夜约半年，他娶了温柔贤淑的阿蘅。他珍视妻子，虽察觉她从不照铜镜、灯下影子极淡，仍想护她免受流言。茶肆第一夜前约一个月间，他常觉倦怠，到了开场时已夜夜梦见枯井，想弄明白缘由。
认知:
  知道: 妻子嫁来时只带了一轴古仕女画卷，挂在书斋北墙。茶肆第一夜前的一段时日里，画卷每到夜半常透出淡淡莲香，他也时常胸口发闷。
`,
  },
  {
    path: "world/characters/tea-master-sun.yaml",
    contents: `$document:
  id: character.qingzhou-sun
  ref: tea-master-sun
  title: 孙掌柜
  summary: 城西茶肆掌柜，熟知青州西郊的旧闻与行商往来。
  aliases: [孙老板]
动机: 盼着西郊早日太平，商旅敢在雨夜歇脚。
认知:
  旧闻: 距茶肆第一夜约十年，县衙管户籍文书的小吏钱文远因私改田契和生辰档册被革职，后来据说流落到枯井驿站一带替人代写书信。
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
  summary: 城外松林深处的荒废古刹。
  aliases: []
景象: 残碑半埋荒草，大殿偏厢却出奇干爽，石案上留着半炷安魂香与几枚白梅花瓣。
线索: 仔细查验香灰与琴案刻痕，可察觉此处并非聚阴害人之所，反而设有一道温和的镇煞音阵（详见 @lanruo-records）。
`,
  },
  {
    path: "world/locations/willow-manor.yaml",
    contents: `$document:
  id: location.qingzhou-willow-manor
  ref: willow-manor
  title: 柳溪旧宅
  summary: 柳溪畔一座白墙青瓦的旧宅。
  aliases: []
景象: 院中老柳垂水，书斋北墙悬着一轴旧仕女画，屋内的铜镜都用素绢蒙着。周言与新妇阿蘅住在此处。
线索: 若拿玩家行囊中的半面旧铜镜或玄微子的符水细察，能发现阿蘅身无血煞，反而是周言床头压着一枚被人暗中塞入的生辰纸人（详见 @willow-manor-records）。
`,
  },
  {
    path: "world/locations/dry-well-post.yaml",
    contents: `$document:
  id: location.qingzhou-dry-well
  ref: dry-well-post
  title: 枯井驿站
  summary: 青州西边官道旁供行旅歇脚的老驿站。
  aliases: []
景象: 驿站灯火昏黄，代写书信的账房先生钱文远常在柜台后打盹。后院的石井至茶肆第一夜已枯了约十年，井边长满暗苔，井壁三尺下嵌着暗砖。
线索: 掀开枯井暗砖或潜查钱文远的账匣，可找到失踪的三张生辰帖、铜铃丝线与完整的借运邪阵（详见 @dry-well-post-records）。
`,
  },
  {
    path: "world/locations/city-god-shrine.yaml",
    contents: `$document:
  id: location.qingzhou-shrine
  ref: city-god-shrine
  title: 城隍古庙
  summary: 青州城西一座香火清冷的老庙。
  aliases: []
线索: 庙祝保管义冢与户籍抄本。距茶肆第一夜约十年的两条记录分别写道，旧吏钱文远因私吞流民赈银而被革职，周言之父曾为一位无名孤女立碑安葬（与柳溪画卷和兰若旧债相连）。
功能: 在庙中上香问签或翻检旧抄本，可为判断三桩异闻的因果提供实据。
`,
  },
  {
    path: "world/case/rumor-ledger.yaml",
    contents: `$document:
  id: case.qingzhou-rumor-ledger
  ref: rumor-ledger
  title: 青州异闻录
  summary: 记录行脚客已听到的传闻、待查的问题和与同道的往来。
  aliases: []
已知传闻:
  枯井失帖: 在城西茶肆初遇时，沈青说枯井驿站当月已有三名行商丢了生辰帖。最近一桩就在初遇的前一夜，那名行商的财物分文未动。
  兰若夜琴: 玄微子说，茶肆初遇的前一夜，城外兰若废寺又传出琴声，听着像在压着什么。
  白斗篷女客: 听见“兰若”二字，她翻页的手停了一下，随后问行脚客是进青州城访友，还是路过柳溪。
待解因果:
  - 枯井驿站偷生辰帖的究竟是何人，意欲何为？
  - 兰若废寺是谁在弹琴，琴声因何而起？
  - 听见“兰若”时，白斗篷女客为何停下翻书？
同道关系:
  捕快沈青: 初识，在茶肆说起驿站失帖。
  道士玄微子: 初识，在茶肆说起废寺琴声。
  白斗篷女客: 初识，主动问起行脚客的来意和打算。
`,
  },
  {
    path: "world/archives/lanruo-records.yaml",
    contents: `$document:
  id: archive.qingzhou-lanruo-debt
  ref: lanruo-records
  title: 兰若废寺档案
  summary: 收录与兰若废寺有关的人物和往事。
  aliases: []
事实记录:
  旧恩: 白素心乃青丘狐女，距茶肆第一夜约十年，她负伤躲入兰若寺，得周言之父以草药相救且未曾泄密。
  夜琴缘由: 茶肆第一夜前约一个月间，她察觉枯井方向每晚飘来吸人精气的邪阵阴煞，正顺着溪水漫向柳溪，于是夜夜在兰若废寺抚琴布音阵挡煞，却因此耗损修为，才化装来城西茶肆打探邪阵源头。
`,
  },
  {
    path: "world/archives/willow-manor-records.yaml",
    contents: `$document:
  id: archive.qingzhou-mirror-bride
  ref: willow-manor-records
  title: 柳溪旧宅档案
  summary: 收录与柳溪旧宅有关的人物和往事。
  aliases: []
事实记录:
  阿蘅来历: 阿蘅是个孤女，距茶肆第一夜约十年病逝于青州驿路。她的幽魂感念周父当年立碑安葬之恩，寄身旧画卷来照料周言。她蒙起铜镜，只怕镜中的淡影吓到周言，从未害人。
  真正病因: 周言夜夜倦怠多梦并非阿蘅所致，而是钱文远在茶肆第一夜约半个月前借代写家书之机，在周言枕下塞了“借运纸人”，把周家气运悄悄引向了枯井驿站。
`,
  },
  {
    path: "world/archives/dry-well-post-records.yaml",
    contents: `$document:
  id: archive.qingzhou-borrowed-fate
  ref: dry-well-post-records
  title: 枯井驿站档案
  summary: 收录与枯井驿站有关的人物、往事与物件。
  aliases: []
事实记录:
  主谋: 驿站里的代书先生钱文远，正是距茶肆第一夜约十年时因私改田契、户籍与贪墨赈银被革职的旧吏。
  手法与物证: 他得了残缺的“枯井借运术”，借驿站代写书信的机会和下了安神药的桂花热茶窃取商旅与周言的生辰帖，连同铜铃丝线一并压入枯井壁三尺下的暗砖中，妄图借众人运气翻身谋复职。
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
- 抽签用默认袋，调用 bag_check 时省略 tokens。按眼前的行动定数值，无须给人物增设数值属性。
- 一般以 value 3 起算。有相关准备、合用器具或同道帮手可取 4；体力不支或手头受限可取 2。
- 有失手风险但局面有利时 difficulty 取 2，有明显阻碍取 3，压力或危险很大时取 4。抽签前定好目标和数值。
- 例如，夜入废寺偏厢时用行囊里的火折子照明，在雨滑处稳住脚步可取 value 4、difficulty 3。若独自冒雨探身查看枯井内壁，可取 value 3、difficulty 4。
- 抽签失利永远推进剧情：可表现为沾染晦气、耗费时辰、惊动钱文远戒心、或让同道暂时产生误会，绝不让线索死胡同。
- 体魄、定力、晦气或行囊有变动时更新 @protagonist。场景推进时更新 @current-situation 的正文，保持标题和简介稳定。
- @rumor-ledger 只记行脚客亲闻、亲见或查实的进展。传闻注明是谁说的，人物尚未自报姓名时用行脚客能辨认的称谓。给需要长期保留的时间加上固定参照，例如城西茶肆第一夜。

## 按需读取与因果层层揭晓

- 除基地 @westgate-teahouse 外，其余四处地点与 @lanruo-records、@willow-manor-records、@dry-well-post-records 三份档案均按需通过 context_read 读取，严禁在玩家尚未到达或查访前剧透。
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
