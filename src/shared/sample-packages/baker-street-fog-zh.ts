import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const bakerStreetFogChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `十一月的伦敦被一场化不开的灰黄大雾罩住。贝克街 221B 的煤气灯早早就点了起来，壁炉里的煤块噼啪作响，窗外马车轮碾过湿石板的声音闷闷地传进来。今天是十一月十五日，周三，壁炉架上的钟指着下午三点四十分。

你是协助贝克街 221B 处理外勤查访的调查助手。茶几上压着福尔摩斯留给你的三张折叠便签，墨迹还没干透——半小时前，他和华生医生匆匆赶去泰晤士河南岸盯守一桩线索，临行前把伦敦城内三条看似毫不相干的急件交给你分头核实。

房东哈德森太太刚端来一壶滚烫的红茶，门外就传来急促的脚步声。苏格兰场的雷斯垂德探长抖着湿大衣走进来，把一枚边缘刻着海锚暗记的旧金币拍在茶几上：“福尔摩斯又跑了？正好你在。白教堂的旧当铺今早收进这枚金币，典当人报的正是昨晚失踪的航运文书亚瑟·芬奇的名字——可当铺店主说，来典当的人左手少了半截小指，根本不是文书本人！”

与此同时，窗台下传来两声清脆的口哨。贝克街小分队的领头少年维金斯正隔着雾气朝楼上挥手，手里举着一张从大英博物馆阅览室抄来的借书单。

雷斯垂德探长擦了擦礼帽上的雾水，看着你：“我的马车就在楼下。你是先拆福尔摩斯的便签、叫维金斯上来问借书单，还是现在就跟我去白教堂当铺看看？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.baker-street-fog
  ref: current-situation
  title: 当前情境
  summary: 记录调查的眼前局面和仍待玩家决定的事项。
  aliases: []
背景:
  时间: 十一月十五日，周三下午三点四十分（大雾第一日）
  地点: 贝克街 221B 客厅
  伦敦雾情: 浓雾渐重，傍晚码头与白教堂能见度极低
在场:
  - { $ref: character.bs-assistant }
  - { $ref: character.bs-lestrade }
  - { $ref: character.bs-hudson }
待决定:
  提问者: { $ref: character.bs-lestrade }
  选择: 拆阅福尔摩斯的便签、请维金斯上楼查看他抄来的借书单，或搭雷斯垂德等在楼下的马车去白教堂旧当铺。
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
  知道: 泰晤士航运公司文书亚瑟·芬奇于十一月十四日周二夜间未归。十一月十五日周三上午，白教堂旧当铺的店主告诉雷斯垂德，一名左手缺半截小指的男子冒用芬奇之名典当了一枚刻有海锚暗记的旧主权金币。
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
  所见: 十一月十五日周三，一位穿灰呢大衣、戴厚手套的绅士从下午两点五十分起，在对面的报摊盯着 221B 的门窗约二十分钟。下午三点十分左右，见福尔摩斯和华生乘马车离开，他才转身走向地铁站。
  日常: 随时替玩家保管带回的物证、转交华生或福尔摩斯的电报，并照料来访的委托人。
`,
  },
  {
    path: "world/characters/wiggins.yaml",
    contents: `$document:
  id: character.bs-wiggins
  ref: wiggins
  title: 维金斯
  summary: 眼尖的贝克街小分队领头人。
  aliases: []
所在: { $ref: location.bs-221b }
动机: 赚取先令酬劳并赢得福尔摩斯夸奖。
认知:
  知道: 十一月十四日周二下午，有人以“A·芬奇”的名字从大英博物馆阅览室借走 1874 年《泰晤士暗礁与潮汐年鉴》。签名歪斜，看着像左手写的。十一月十五日周三维金斯抄下借书单时，年鉴仍未归还。
可帮忙: 愿意带小分队去盯梢码头或当铺。
`,
  },
  {
    path: "world/characters/holmes-watson.yaml",
    contents: `$document:
  id: character.bs-holmes-watson
  ref: holmes-watson
  title: 福尔摩斯与华生
  summary: 以贝克街 221B 为据点的调查搭档。
  aliases: [福尔摩斯, 华生]
所在: 泰晤士河南岸，正盯守另一条线索，具体位置未明。
离开: 十一月十五日周三下午三点十分左右，二人从贝克街 221B 乘马车离开。
便签内容:
  便签一（航运文书）: 查明亚瑟·芬奇在泰晤士航运公司负责的最后三份保单编号。
  便签二（白教堂当铺）: 核实旧主权金币上的海锚暗记是否出自哪家私人造币厂或海运商行。
  便签三（博物馆年鉴）: 查清借阅者想找 1874 年年鉴的哪张图或哪一页，以及它是否被抄录或取走。
合作方式: 玩家可以和两人互发电报。两人预计十一月十五日周三晚回到 221B，在炉火旁与玩家交叉印证发现，把推理留给玩家。
`,
  },
  {
    path: "world/characters/finch.yaml",
    contents: `$document:
  id: character.bs-finch
  ref: finch
  title: 失踪的航运文书
  summary: 因失踪而引出调查的人。
  aliases: []
身份: 亚瑟·芬奇，泰晤士航运公司勤恳的文书。
所在: { $ref: location.bs-barge-wharf }
处境: 十一月十五日周三下午三点四十分，芬奇未受伤，已被反锁在码头的二楼阁楼。他于十一月十四日周二夜间失踪，此前核对保单时发现了副经理伪造的全损理赔记录（详见 @shipping-records）。
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
功能: 可拆阅福尔摩斯的三张外勤便签、用放大镜或化学仪器检验物证、向哈德森太太打听她是否留意到来客或街上的动静、派维金斯盯梢，或发电报联系福尔摩斯与华生。
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
线索: 据店主说，十一月十五日周三上午典当海锚金币的男子左手缺半截小指，袖口沾着深红封蜡屑与煤灰，操泰晤士河驳船水手口音，离开时买了一张向东去黑水弯的渡船票（详见 @pledge-records）。
`,
  },
  {
    path: "world/locations/british-museum-room.yaml",
    contents: `$document:
  id: location.bs-museum
  ref: british-museum-room
  title: 大英博物馆阅览室
  summary: 穹顶高耸的静谧阅览室，管理员保留着全部借阅存根与归还登记。
  aliases: []
线索: 十一月十四日周二下午的借书存根上写着“A·芬奇”，除了 1874 年海事年鉴还申请了泰晤士河口险滩图。管理员亲眼见到借阅者用左手签名，记得对方打听过黑水弯废驳船码头涨潮时的水深（详见 @reading-room-records）。
`,
  },
  {
    path: "world/locations/dock-warehouse.yaml",
    contents: `$document:
  id: location.bs-dock-warehouse
  ref: dock-warehouse
  title: 码头账房与仓库
  summary: 伦敦码头区的红砖商业建筑。
  aliases: []
线索: 十一月十五日周三调查开始时，泰晤士航运公司账房里亚瑟·芬奇的办公桌仍原样保留。抽屉里的吸墨纸反印着三艘拟报全损货轮的保单号和副经理马库斯·韦尔的私人印章。一名码头搬运工在十一月十四日周二傍晚看见韦尔与一名左手缺半截小指的驳船水手私下交谈（详见 @shipping-records）。
`,
  },
  {
    path: "world/locations/barge-wharf.yaml",
    contents: `$document:
  id: location.bs-barge-wharf
  ref: barge-wharf
  title: 旧驳船码头
  summary: 泰晤士河一处河湾里的旧泊位与木阁楼。
  aliases: []
名称: 黑水弯废驳船码头。
十一月十五日下午三点四十分的现场: 亚瑟·芬奇已被关在二楼阁楼。一艘挂假货旗的驳船泊在楼下。
十一月十五日晚的计划: 左手缺半截小指的水手与马库斯·韦尔计划把从投保货轮卸下的上等茶叶和瓷器装入驳船，再于夜间高潮时借浓雾掩护起航。
`,
  },
  {
    path: "world/case/case-ledger.yaml",
    contents: `$document:
  id: case.bs-ledger
  ref: case-ledger
  title: 伦敦案卷与物证板
  summary: 记录玩家已知的物证、有来源的证词、待查线索与联系人。
  aliases: []
手头物证:
  海锚暗记金币: 一枚边缘刻着微小海锚的旧金币，由雷斯垂德放在 221B 的茶几上。
转述证词:
  失踪的航运文书: 十一月十五日周三下午三点四十分，雷斯垂德说，这名文书于十一月十四日周二夜间失踪。
  白教堂典当: 雷斯垂德在十一月十五日同一次会面中转述当铺店主的说法。当日上午，一名左手缺半截小指的男子报了失踪文书的名字，当掉这枚金币。
待查线索:
  - 拆阅福尔摩斯留在桌上的三张未拆外勤便签
  - 请维金斯上来查看他抄回的尚未读过的大英博物馆阅览室借书单
  - 向白教堂旧当铺店主询问典当人的体貌与去向
线人与关系:
  雷斯垂德探长: 苏格兰场探长，在 221B 提议载你去白教堂。
  维金斯: 贝克街小分队的领头少年。
  哈德森太太: 贝克街 221B 的房东。
`,
  },
  {
    path: "world/archives/anchor-coin-origin.yaml",
    contents: `$document:
  id: archive.bs-anchor-coin
  ref: pledge-records
  title: 典当记录
  summary: 白教堂旧当铺一笔交易的参考资料。
  aliases: []
事实记录:
  信物用途: 这种在边缘加刻微缩海锚的旧主权金币，是泰晤士航运公司副经理马库斯·韦尔私下发给黑市驳船水手的定金信物，凭币可在黑水弯废驳船码头领尾款。
  典当经过: 十一月十五日周三上午，左手缺半截小指的水手为了换酒钱私自典当了一枚，随口报了他们劫持的文书亚瑟·芬奇的名字。
`,
  },
  {
    path: "world/archives/almanac-cipher.yaml",
    contents: `$document:
  id: archive.bs-almanac-cipher
  ref: reading-room-records
  title: 阅览室记录
  summary: 大英博物馆一笔借阅的参考资料。
  aliases: []
事实记录:
  年鉴内容: 1874 年《泰晤士暗礁与潮汐年鉴》第 88 页记载了黑水弯废驳船码头一条已被废弃的雾夜深水暗槽，只有大雾加涨潮时驳船才能避开海关巡逻艇悄然入海。
  借阅者身份: 十一月十四日周二下午，韦尔的同伙冒用芬奇的名字借走年鉴，为十一月十五日周三夜间计划走私出港的行动确定潮时。
`,
  },
  {
    path: "world/archives/insurance-ring-truth.yaml",
    contents: `$document:
  id: archive.bs-insurance-ring
  ref: shipping-records
  title: 航运记录
  summary: 码头生意与往来文件的参考资料。
  aliases: []
事实记录:
  主谋与计划: 泰晤士航运公司副经理马库斯·韦尔串通驳船走私团伙。他们计划于十一月十五日周三夜间借大雾把投了高额海险的货轮上的上等茶叶和瓷器暗中卸入藏在黑水弯的驳船转卖，再让卸空的货轮搁浅以骗取全损理赔。
  失踪经过: 亚瑟·芬奇核对保单账册时发现破绽。十一月十四日周二夜间，韦尔派左手缺半截小指的水手劫走芬奇，将他反锁在黑水弯的阁楼。韦尔打算等货轮搁浅后，再栽赃芬奇卷款潜逃。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "baker-street-221b",
    `# 贝克街的灰雾委托（互动式小说 · 长线侦探）

这是一场纯叙事驱动的维多利亚伦敦长线探案，不依赖掷骰，而靠玩家真实的观察、盘问、物证交叉印证与街区调度推进。保持柯南·道尔原著的冷峻推理质感、干脆对话与雾都氛围。

## 信息隔离与长线案卷维护

- 在 @case-ledger 分开记录查过的物证、标明来源的证词和尚未查验的线索。只添加玩家已经得知的信息，查明后从待查列表中移除。未发现的详情（包括主谋身份）留在主持资料里，等调查揭晓后再写进叙事和案卷。
- 伦敦时间推进、街区移动或雾情变化时更新 @current-situation 的正文，沿用适合跨场景的目录标题和简介，清理已经作答的决定。长久的信任变化写入 @relationships，尚在执行的计划或盯梢安排写入 @pending-matters。

## 按需读取与多日推演

- 除基地 @baker-street-221b 外，其他伦敦地点、人物和档案在调查触及时按需用 context_read 读取。按玩家与各角色已实际得知的信息叙事，目录条目和主持私见资料只供主持查阅。
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
              id: "evidence-in-hand",
              label: "手头物证",
              document: "case-ledger",
              locator: ["手头物证"],
            },
            {
              id: "reported-testimony",
              label: "转述证词",
              document: "case-ledger",
              locator: ["转述证词"],
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
