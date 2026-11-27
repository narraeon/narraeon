import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const bakerStreetFogChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `十一月的伦敦被一场化不开的灰黄大雾罩住。贝克街 221B 的煤气灯早早就点了起来，壁炉里的煤块噼啪作响，窗外马车轮碾过湿石板的声音闷闷地传进来。

你是近期协助贝克街 221B 处理外勤查访的年轻调查助手。桌面上压着福尔摩斯留给你的三张折叠便签，墨迹还没干透——半小时前，他和华生医生匆匆赶去泰晤士河南岸盯守一桩线索，临行前把伦敦城内三条看似毫不相干的急件交给你分头核实。

房东哈德森太太刚端来一壶滚烫的红茶，门外就传来急促的脚步声。苏格兰场的雷斯垂德探长抖着湿大衣走进来，把一枚边缘刻着海锚暗记的旧金币拍在茶几上：“福尔摩斯又跑了？正好你在。白教堂的旧当铺今早收进这枚金币，典当人报的正是昨天失踪的那位航运文书的名字——可伙计说，来典当的人左手少了一截小指，根本不是文书本人！”

与此同时，窗台下传来两声清脆的口哨。贝克街小分队的领头少年维金斯正隔着雾气朝楼上挥手，手里举着一张从大英博物馆阅览室抄来的借书单。

雷斯垂德探长擦了擦礼帽上的雾水，看着你：“我的马车就在楼下。你是先拆福尔摩斯的便签、叫维金斯上来问借书单，还是现在就跟我去白教堂当铺看看？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.baker-street-fog
  ref: current-situation
  title: 灰雾中的三条急件
  summary: 福尔摩斯与华生外出盯梢，三条指向伦敦不同街区的线索同时汇到贝克街 221B。
  aliases: []
背景:
  时间: 十一月，周三下午三点四十分（大雾第一日）
  地点: 贝克街 221B 客厅
  伦敦雾情: 浓雾渐重，傍晚码头与白教堂能见度极低
在场:
  - { $ref: character.bs-assistant }
  - { $ref: character.bs-lestrade }
  - { $ref: character.bs-hudson }
待回应:
  说话者: { $ref: character.bs-lestrade }
  原话: 我的马车就在楼下。你是先拆福尔摩斯的便签、叫维金斯上来问借书单，还是现在就跟我去白教堂当铺看看？
  现场: 茶几上放着福尔摩斯未拆的三张外勤便签与雷斯垂德带来的海锚暗记金币；楼下维金斯正举着博物馆借书单挥手。
`,
  },
  {
    path: "world/characters/assistant.yaml",
    contents: `$document:
  id: character.bs-assistant
  ref: protagonist
  title: 贝克街外勤助手
  summary: 协助福尔摩斯与华生处理伦敦外勤查访的调查助手，姓名与背景由玩家决定。
  aliases: []
身份与权限: 以贝克街 221B 外勤助手身份行动，持有福尔摩斯手写介绍信；可调动贝克街小分队盯梢，也可借雷斯垂德的苏格兰场权限查访商行与码头。
随身物品:
  - 福尔摩斯的封蜡介绍信与放大镜
  - 伦敦街区袖珍地图与硬皮笔记簿
  - 雇佣马车与打点线人的零钱
`,
  },
  {
    path: "world/characters/lestrade.yaml",
    contents: `$document:
  id: character.bs-lestrade
  ref: lestrade
  title: 雷斯垂德探长
  summary: 苏格兰场精明务实却偶有急躁的老牌探长，正追查航运文书失踪案。
  aliases: [雷斯垂德]
动机: 抢在媒体把航运文书失踪案炒成丑闻前破案；嘴上常跟福尔摩斯较劲，心里却极看重贝克街的判断。
行事: 偏爱先抓可疑人物再审问；若玩家拿出清晰物证链劝他暂缓打草惊蛇，他会配合设局。
认知:
  知道: 泰晤士航运公司文书“亚瑟·芬奇”昨夜未归；今早白教堂旧当铺收到一枚刻有海锚暗记的旧主权金币，典当人左手缺半截小指却冒用芬奇之名。
  不知: 尚未把此案与大英博物馆失踪的海事年鉴、以及伦敦码头仓库联系起来。
`,
  },
  {
    path: "world/characters/hudson.yaml",
    contents: `$document:
  id: character.bs-hudson
  ref: hudson
  title: 哈德森太太
  summary: 贝克街 221B 的房东，细心周到，记性极佳。
  aliases: []
认知:
  知道: 今天中午曾有一位穿灰呢大衣、戴厚手套的绅士在贝克街对面报摊停留了二十分钟，一直盯着 221B 的门窗，见福尔摩斯和华生乘马车离开后才转身走向地铁站。
  日常: 随时替玩家保管带回的物证、转交华生或福尔摩斯的电报，并照料来访的委托人。
`,
  },
  {
    path: "world/characters/wiggins.yaml",
    contents: `$document:
  id: character.bs-wiggins
  ref: wiggins
  title: 维金斯
  summary: 贝克街街头少年小分队的领头人，腿脚利索、耳目遍布伦敦码头与车站。
  aliases: []
所在: { $ref: location.bs-221b }
动机: 赚取先令酬劳并赢得福尔摩斯夸奖。
认知:
  知道: 大英博物馆古籍室昨天下午有一本 1874 年《泰晤士暗礁与潮汐年鉴》被人借走后未归还，借书单上留着“A·芬奇”的签名，但笔迹歪斜得像左手代签；他可以随时带伙伴去盯梢码头或当铺。
`,
  },
  {
    path: "world/characters/holmes-watson.yaml",
    contents: `$document:
  id: character.bs-holmes-watson
  ref: holmes-watson
  title: 福尔摩斯与华生
  summary: 正在泰晤士河南岸盯守另一条线索的搭档，随时可通过电报或在晚间回 221B 与玩家汇合推演。
  aliases: [福尔摩斯, 华生]
所在: { $ref: location.bs-dock-warehouse }
便签内容:
  便签一（航运文书）: 查明亚瑟·芬奇在泰晤士航运公司负责的最后三份保单编号。
  便签二（白教堂当铺）: 核实旧主权金币上的海锚暗记是否出自哪家私人造币厂或海运商行。
  便签三（博物馆年鉴）: 查清 1874 年海事年鉴中究竟哪一页被撕走或抄录。
合作方式: 玩家每带回一条实质线索，都可发电报给他们或在晚间于 221B 炉火旁交叉印证，绝不替玩家包办推理。
`,
  },
  {
    path: "world/characters/finch.yaml",
    contents: `$document:
  id: character.bs-finch
  ref: finch
  title: 亚瑟·芬奇
  summary: 昨夜失踪的泰晤士航运公司老实文书，实际被软禁在东区驳船码头的货舱阁楼。
  aliases: [芬奇]
所在: { $ref: location.bs-barge-wharf }
处境: 平安无事但被反锁在阁楼，只因他在核对旧保单时发现公司副经理伪造沉船理赔（详见 @insurance-ring-truth）。
`,
  },
  {
    path: "world/locations/baker-street-221b.yaml",
    contents: `$document:
  id: location.bs-221b
  ref: baker-street-221b
  title: 贝克街 221B
  summary: 温暖而凌乱的调查基地，满墙剪报、化学实验台与电报收发记录。
  aliases: []
功能: 可拆阅福尔摩斯的三张外勤便签、用化学试剂或放大镜检验物证、向哈德森太太打听街对面可疑盯梢者、派维金斯盯梢伦敦各处，或发电报联系福尔摩斯与华生。
`,
  },
  {
    path: "world/locations/whitechapel-pawnshop.yaml",
    contents: `$document:
  id: location.bs-pawnshop
  ref: whitechapel-pawnshop
  title: 白教堂旧当铺
  summary: 雾气深处的窄门当铺，店主记账极细，柜台后挂满典当票据。
  aliases: []
线索: 店主证实今早典当海锚金币的男子左手缺半截小指、袖口沾着深红封蜡屑与煤灰，操泰晤士河驳船水手口音，离开时还顺手买走了一张去东区驳船码头的渡船票（详见 @anchor-coin-origin）。
`,
  },
  {
    path: "world/locations/british-museum-room.yaml",
    contents: `$document:
  id: location.bs-museum
  ref: british-museum-room
  title: 大英博物馆古籍阅览室
  summary: 穹顶高耸的静谧阅览室，管理员保留着全部借阅存根与归还登记。
  aliases: []
线索: 借书存根显示借走 1874 年海事年鉴的“A·芬奇”其实用的是左手签名，且随书借阅了同一时期的泰晤士河口险滩图；管理员记得此人曾向助手打听“黑水弯废驳船码头”的退潮水深（详见 @almanac-cipher）。
`,
  },
  {
    path: "world/locations/dock-warehouse.yaml",
    contents: `$document:
  id: location.bs-dock-warehouse
  ref: dock-warehouse
  title: 泰晤士航运公司账房与码头仓库
  summary: 伦敦码头区的红砖账房，亚瑟·芬奇的办公桌仍原样保留。
  aliases: []
线索: 芬奇抽屉里的吸墨纸上反向印着三艘“拟报全损”货轮的保单号，以及副经理马库斯·韦尔的私人印章号；仓库苦力提到马库斯昨晚曾与一名左手缺小指的驳船工密谈（详见 @insurance-ring-truth）。
`,
  },
  {
    path: "world/locations/barge-wharf.yaml",
    contents: `$document:
  id: location.bs-barge-wharf
  ref: barge-wharf
  title: 黑水弯废驳船码头
  summary: 雾锁河湾的僻静旧码头，停着一艘挂假货旗的驳船与两层木阁楼。
  aliases: []
现场: 亚瑟·芬奇被关在二楼阁楼，码头下方的驳船正趁今夜大雾偷运本该“沉没”的高价茶叶与瓷器；左手缺小指的水手正与副经理马库斯准备在涨潮时起航。
`,
  },
  {
    path: "world/case/case-ledger.yaml",
    contents: `$document:
  id: case.bs-ledger
  ref: case-ledger
  title: 伦敦案卷与物证板
  summary: 仅记录玩家已经亲眼核实或从可靠证人处得到的线索与人脉，绝不提前写入幕后黑手。
  aliases: []
已核实物证:
  海锚暗记金币: 雷斯垂德从白教堂旧当铺带回，典当人左手缺半截小指，却冒用失踪文书亚瑟·芬奇之名。
  博物馆借书单: 维金斯正在楼下挥手，手里举着一张从大英博物馆阅览室抄来的借书单（内容尚未过目）。
待查线索:
  - 拆阅福尔摩斯留在桌上的三张外勤便签
  - 叫维金斯上来查看他抄回的博物馆借书单
  - 核实白教堂当铺典当人的体貌与去向
  - 查清失踪文书亚瑟·芬奇在航运公司经手的最后文件
线人与关系:
  雷斯垂德探长: 急于破案，目前愿意载你同行
  维金斯（小分队）: 随时可派去伦敦各街区盯梢
  哈德森太太: 照看 221B，留意着门外动静
`,
  },
  {
    path: "world/archives/anchor-coin-origin.yaml",
    contents: `$document:
  id: archive.bs-anchor-coin
  ref: anchor-coin-origin
  title: 海锚暗记金币来历
  summary: 微缩海锚暗记金币的真实用途与典当经过。
  aliases: []
事实记录:
  信物用途: 这种在女王头像下方加刻微缩海锚的旧主权金币，是泰晤士航运公司副经理马库斯·韦尔私下发给黑市驳船水手的“定金信物”，凭币可在黑水弯废驳船码头领尾款。
  典当经过: 左手缺小指的水手因贪杯私自典当了一枚，并随口胡报了被他们抓来的文书“芬奇”的名字。
`,
  },
  {
    path: "world/archives/almanac-cipher.yaml",
    contents: `$document:
  id: archive.bs-almanac-cipher
  ref: almanac-cipher
  title: 1874 年海事年鉴与黑水弯暗道
  summary: 失踪海事年鉴所载暗槽与冒名借阅者的真实目的。
  aliases: []
事实记录:
  年鉴内容: 1874 年《泰晤士暗礁与潮汐年鉴》第 88 页记载了黑水弯废驳船码头一条已被废弃的雾夜深水暗槽，只有大雾加涨潮时驳船才能避开海关巡逻艇悄然入海。
  借阅者身份: 冒名借走年鉴的并非芬奇本人，而是替副经理马库斯踩点的同伙，意在趁今晚浓雾把掉包下来的货船货物偷运出港。
`,
  },
  {
    path: "world/archives/insurance-ring-truth.yaml",
    contents: `$document:
  id: archive.bs-insurance-ring
  ref: insurance-ring-truth
  title: 泰晤士航运沉船骗保案真相
  summary: 副经理马库斯·韦尔的走私骗保计划与亚瑟·芬奇失踪经过。
  aliases: []
事实记录:
  主谋与计划: 泰晤士航运公司副经理马库斯·韦尔串通走私驳船团伙，计划在今晚大雾中把投保高额海险的货轮精品茶叶与瓷器暗中卸到黑水弯驳船转卖，再让空船故意搁浅骗取理赔。
  失踪经过: 忠厚文书亚瑟·芬奇核对旧账时撞破保单破绽，被马库斯派缺指水手劫持软禁在黑水弯阁楼，打算等今夜货船出事后再伪造芬奇畏罪潜逃的假象。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "baker-street-221b",
    `# 贝克街的灰雾委托（互动式小说 · 长线侦探）

这是一场纯叙事驱动的维多利亚伦敦长线探案，不依赖掷骰，而靠玩家真实的观察、盘问、物证交叉印证与街区调度推进。保持柯南·道尔原著的冷峻推理质感、干脆对话与雾都氛围。

## 信息隔离与长线案卷维护

- 仅将玩家亲眼所见、亲耳听闻或查实的物证与证词写入 @case-ledger；严禁把尚未调查的幕后主谋或未访地点内容提前泄露给玩家或雷斯垂德。
- 每次伦敦时间推进、街区移动或雾情变化时更新 @current-situation；每次派维金斯盯梢、与雷斯垂德达成默契或发电报联系福尔摩斯/华生时，将长期关系变化写入 @relationships，未兑现的约定写入 @pending-matters。

## 按需读取与多日推演

- 除基地 @baker-street-221b 外，其余四处伦敦地点与 @anchor-coin-origin、@almanac-cipher、@insurance-ring-truth 三份档案均按需通过 context_read 读取。
- 鼓励玩家自由决定三条线的查访顺序；即使走弯路或暂时被雷斯垂德的急躁带偏，也能通过新物证或回到 221B 与福尔摩斯/华生复盘把拼图重新拼完整。
`,
    ["case-ledger"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "london-case-board",
          title: "案卷与物证",
          items: [
            {
              id: "verified-evidence",
              label: "已核实物证",
              document: "case-ledger",
              locator: ["已核实物证"],
            },
            {
              id: "pending-leads",
              label: "待查线索",
              document: "case-ledger",
              locator: ["待查线索"],
            },
            {
              id: "informants",
              label: "线人与关系",
              document: "case-ledger",
              locator: ["线人与关系"],
            },
          ],
        },
      ],
    },
  ),
];
