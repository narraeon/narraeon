import { gameplayFile } from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const fogbellHarborChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `蒸汽渡轮的汽笛在冰雾里拖出一声闷响，很快被浪声吞掉。这是大雪封港前的最后一班船；下一班补给船要七个夜晚后——第八天黎明——才会再来。

你受航运公会委托，来核查雾钟港旧灯塔的补给账目——原守塔人三天前不见了，只留下一张没签字的交接单。栈桥尽头挂着一盏防风煤油灯，港口高处那座黑铁雾钟悬在浓雾里，纹丝不动。

穿厚呢大衣的港务长柯林迎上来，递过一本潮乎乎的登岸登记簿：“欢迎到雾钟港。账册我明天一早让人送到旅店，今晚风冷，先去雾钟旅店歇脚吧。至于旧灯塔，风浪大，这两天最好别靠近。”

几步外，提着热汤桶来接船的旅店老板娘梅姨正把目光从灯塔方向收回来。趁柯林低头找笔的工夫，她朝你极轻地摇了摇头，压低声音：“昨晚半夜无风，雾钟自己响了三声。灯塔顶上，还亮过一阵绿光。”

柯林抬起头，把蘸水笔递到你面前：“先签个名吧。你打算今晚就安顿下来，还是还有别的事想先问？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.fogbell-harbor
  ref: current-situation
  title: 雾钟港当前情境
  summary: 雾钟港调查此刻的时地、在场者与待回应事项。
  aliases: []
背景:
  时间: 第 1 天 · 傍晚
  地点: 雾钟港栈桥（通往雾钟旅店）
  气候与封港: 冰雾低垂，海面起浮冰，对外班船已停航
在场:
  - { $ref: character.fogbell-investigator }
  - { $ref: character.fogbell-colin }
  - { $ref: character.fogbell-mae }
待决定:
  选择: 调查员要如何回应柯林的登记请求？接下来是先去旅店安顿，还是留在栈桥问话？
  现场: 柯林把登岸登记簿和蘸水笔递到你面前；几步外梅姨提着汤桶，刚压低声音提起登岸前一夜的无风三响与灯塔绿光。
`,
  },
  {
    path: "world/characters/investigator.yaml",
    contents: `$document:
  id: character.fogbell-investigator
  ref: protagonist
  title: 调查员
  summary: 受航运公会委托来核查旧灯塔补给账目的外地调查员，姓名与过往由玩家决定。
  aliases: []
状态:
  体力: 10 / 10（完好）
  压力: 0 / 10（冷静）
技能参考:
  侦查: 65
  交涉: 60
  学识: 55
  机械: 50
  潜行: 45
  体能: 55
  意志: 60
随身装备:
  - 航运公会委托函（盖有火漆印）
  - 便携煤油手灯与防风火柴
  - 调查笔记本与铅笔
权限与边界: 可核查灯塔公开补给账目与访谈镇民；无权强行搜查私宅或拘捕镇民。
`,
  },
  {
    path: "world/characters/harbor-master.yaml",
    contents: `$document:
  id: character.fogbell-colin
  ref: harbor-master
  title: 港务长柯林
  summary: 雾钟港的港务主管，举止周全，极力想把调查限定在纸面账目上。
  aliases: [柯林]
动机: 希望调查员草草核对完近两年的灯油账目就乘下班船离开，绝不能让外人翻出十年前“海鸥号”沉船案的旧账。
行事: 表面热情周到，会主动安排食宿并强调风雪危险；若玩家追问灯塔钥匙或沉船旧事，会以安全规章推托，并暗中留意玩家行踪。
认知:
  知道: 守塔人老周失踪前曾向他追问“海鸥号”沉船当年的异常灯油核销单。老周带走了原始航志，柯林不知道他的下落。
  误判: 以为调查员登岸前一夜的灯塔绿光是有人偷溜进去避风所致。
`,
  },
  {
    path: "world/characters/innkeeper.yaml",
    contents: `$document:
  id: character.fogbell-mae
  ref: innkeeper
  title: 梅姨
  summary: 雾钟旅店老板娘，港口消息最灵通的人，对老周的失踪心存疑虑。
  aliases: [梅老板]
动机: 守塔人老周平日忠厚，绝不会不辞而别；她希望外地调查员能查清真相，但也不愿当众得罪掌握补给分配权的港务长。
行事: 人前说话滴水不漏，回旅店柜台后才肯压低声音细说。愿意替玩家介绍修船厂老陈与气象站林蔚。
认知:
  亲眼所见: 调查员登岸前一夜约十一点半，港内无风，雾钟却低沉地响了三声；几乎同时，旧灯塔顶层闪过两段间隔很短的绿光。
  传闻: 知道修船厂老陈十年前修过“海鸥号”的救生艇，此后就再也不提那晚的事。
`,
  },
  {
    path: "world/characters/shipwright.yaml",
    contents: `$document:
  id: character.fogbell-shipwright
  ref: shipwright
  title: 老陈
  summary: 雾钟港修船厂的老匠人，寡言谨慎，手头有一条能抗碎冰的小艇。
  aliases: [陈师傅]
动机: 保住修船厂和年轻学徒的生计，不想被港务长卡掉开春的木材指标；若玩家拿出确凿诚意或保住他与学徒退路，他愿意说出十年前的见闻。
行事: 对外人防备心重，问及“海鸥号”时会低头刨木头岔开话题；懂机械与船体结构，欣赏懂行或守信的人。
认知:
  知道: 十年前“海鸥号”触礁当晚，灯塔其实提前半小时熄过灯；打捞上来的木箱印着双重货号。修船厂账本里缺了两页，正是当年柯林亲自拿走的。
  边界: 不知道老周现在藏在哪里，但记得调查员登岸前一周，老周来借过一卷防水油布和两块干粮。
`,
  },
  {
    path: "world/characters/meteorologist.yaml",
    contents: `$document:
  id: character.fogbell-meteorologist
  ref: meteorologist
  title: 林蔚
  summary: 驻守悬崖气象站的年轻学者，用自制记录仪追踪雾钟港的异常低频声。
  aliases: []
动机: 查清无风夜雾钟自鸣的物理成因，也担心失踪的老周——老周在调查员登岸前一个月帮她搬过仪器，还提过灯塔地基下面有空腔回声。
行事: 说话直爽、重数据，只要玩家愿意分享实地见闻，她就乐意开放气压纸带、望远镜和潮汐表。
认知:
  观测记录: 调查员登岸前一夜十一点半前后，气压骤降的同时记录仪捕捉到来自沉船礁方向的 18 赫兹低频脉动，紧接着港口雾钟产生了三声共振。
  猜测: 怀疑水下有大型金属空腔或旧钟残骸与港口雾钟同频，打算查旅店的潮汐表，等礁底露出时实地核实。
`,
  },
  {
    path: "world/characters/keeper.yaml",
    contents: `$document:
  id: character.fogbell-keeper
  ref: keeper
  title: 老周
  summary: 旧灯塔守塔人，调查员登岸前三天失踪。
  aliases: [周守塔]
所在: { $ref: location.fogbell-wreck-reef }
处境: 带着防水油布、干粮和十年前的原始灯塔航志躲避柯林耳目，腿脚因湿冷有些抽筋，但神智清醒。
动机: 想等航运公会派来的外地核查员亲手接过原始航志（详见 @keeper-logbook），顺便提醒对方灯塔地下室封门后的共鸣异常。
行动: 偶尔趁深夜溜回灯塔顶层，用旧绿色滤光片朝旅店方向打短讯号，试探是否来了可信的外人。
`,
  },
  {
    path: "world/locations/fogbell-inn.yaml",
    contents: `$document:
  id: location.fogbell-inn
  ref: fogbell-inn
  title: 雾钟旅店
  summary: 港口唯一的客栈与调查基地，炉火常燃，渔民与水手傍晚常聚在此处。
  aliases: []
格局: 一楼是大厅与壁炉吧台，二楼靠海的房间能远眺旧灯塔顶层与黑铁雾钟架。
功能: 玩家可在此休整恢复体力、缓解压力、向梅姨打听港口人情、整理线索，或接收港务长送来的公开账册。
日常线索: 吧台后的公告板贴着本月潮汐表、补给船公告和十年前“海鸥号”海难捐款名单。
公开日程:
  计日: 调查员登岸当天为第 1 天。
  大低潮: 第 5 天大低潮是本季最低潮，约在午后至傍晚露出通往沉船礁的石堤。这是封港期间唯一能徒步探查礁底的窗口。
  补给船: 第 8 天黎明，封港满七夜，下一班蒸汽补给船抵港。
`,
  },
  {
    path: "world/locations/old-lighthouse.yaml",
    contents: `$document:
  id: location.fogbell-lighthouse
  ref: old-lighthouse
  title: 旧灯塔
  summary: 岬角尽头的石砌灯塔，门锁紧闭，塔底有一道被木板钉死的旧地窖门。
  aliases: []
进入方式: 正门挂着港务长加装的新铜锁（需钥匙、交涉借调或机械/潜行检定撬开）；海侧通风窗的铁栅已锈松。
油灯室: 账桌抽屉里留着撕掉三页的补给本。调查员登岸时，壁柜里的绿色玻璃滤光片边缘还留着新指印，说明登岸前有人进过油灯室。
地窖封门: 门后传来与海浪节拍略微错位的低沉嗡鸣；撬开封板需要工具与检定，里面藏着与沉船礁共振相关的先民观测碑（详见 @resonance-chamber）。
`,
  },
  {
    path: "world/locations/boatyard.yaml",
    contents: `$document:
  id: location.fogbell-boatyard
  ref: boatyard
  title: 修船厂
  summary: 堆满松木与旧锚链的半露天船坞，老陈和一名学徒在此修补渔船。
  aliases: []
可用资源: 船坞里停着一条包了铁皮的破冰小艇，经老陈同意或修复舵销后可划往沉船礁。
线索: 办公棚架子上放着十年前的修船流水账，11 月那两页被利刃裁掉，但下一页背面仍留有复写纸压出的“海鸥号 / 双重铅封 / 柯林签收”字痕（侦查检定可辨认）。
`,
  },
  {
    path: "world/locations/weather-station.yaml",
    contents: `$document:
  id: location.fogbell-weather-station
  ref: weather-station
  title: 悬崖气象站
  summary: 俯瞰全港的木结构观测屋，林蔚在此记录风速、气压与潮汐。
  aliases: []
设备: 高倍黄铜望远镜（可直接观测旧灯塔窗口与沉船礁搁浅驳船的炊烟/反光）、滚筒气压计、低频声波纸带记录仪。
线索: 调查员登岸前一夜的声波纸带显示，雾钟自鸣前两秒，信号源先从沉船礁水下发出；用望远镜搜寻沉船礁北侧旧驳船，可见一角深绿防水油布，调查员登岸时才刚绑上（侦查检定可确认有人居住）。
`,
  },
  {
    path: "world/locations/sailors-chapel.yaml",
    contents: `$document:
  id: location.fogbell-chapel
  ref: sailors-chapel
  title: 海员礼拜堂
  summary: 山坡上的石砌小礼拜堂，墙上钉着历年失事船只的铜名牌。
  aliases: []
线索: “海鸥号”铜名牌下方的祈福簿里，夹着老周在调查员登岸前四天写下的一行铅笔小字：“灯未坏，人关之；旧钟在下，潮落可见。”
日常: 白天无人看守，傍晚常有老渔民来点蜡烛，适合私下约见线人。
`,
  },
  {
    path: "world/locations/wreck-reef.yaml",
    contents: `$document:
  id: location.fogbell-wreck-reef
  ref: wreck-reef
  title: 沉船礁
  summary: 港外暗礁群，北侧搁浅着一艘半朽旧驳船，水下沉着“海鸥号”残骸。
  aliases: []
到达方式:
  小艇: 平日可经老陈带路或乘小艇穿过近岸浮冰。修舵销看机械，冒险在浮冰中划船看体能。
  石堤: 旅店潮汐表标注的大低潮露出通往礁底的湿滑石堤。若浪头、结冰或赶潮构成风险，用体能检定判断能否安全通过。
旧驳船: 老周藏身之处，舱内用防水油布挡风，藏着原始航志（@keeper-logbook）。
水下残骸与礁底: 大低潮时可见“海鸥号”断裂货舱里印着双重货号的走私铅箱，以及卡在礁缝深处的一口古老青铜巨钟残体（@resonance-chamber）。
`,
  },
  {
    path: "world/case/investigation-board.yaml",
    contents: `$document:
  id: case.fogbell-board
  ref: investigation-board
  title: 调查进度板
  summary: 仅记录玩家已经亲眼所见、亲耳听闻或查实的线索与阵营态度。
  aliases: []
已获线索:
  失踪与交接单: 原守塔人老周在调查员登岸前三天失踪，只留下一张未签字的补给交接单。
  无风鸣钟与绿光: 梅姨在调查员登岸时私下透露，登岸前一夜无风时雾钟自鸣三声，灯塔顶层亮过绿光。
待解疑点:
  - 老周究竟是遇险还是主动躲藏？调查员登岸前一夜，是谁在灯塔点了绿光？
  - 港务长柯林为何急于劝阻外人靠近旧灯塔？
  - 无风夜雾钟自鸣是自然现象、人为机关，还是另有隐情？
各方态度:
  港务长柯林: 接待客气，答应登岸后次日清晨送来账册，同时劝阻调查员靠近旧灯塔
  旅店梅姨: 友善，愿意私下帮忙
  修船厂老陈: 尚未接触
  气象站林蔚: 尚未接触
`,
  },
  {
    path: "world/archives/wreck-insurance-truth.yaml",
    contents: `$document:
  id: archive.fogbell-wreck-truth
  ref: wreck-insurance-truth
  title: 海鸥号沉船旧档
  summary: 用于核对十年前海鸥号沉船记录、货箱标记与港口账目的关联。
  aliases: []
事实记录:
  - 十年前寒冬，“海鸥号”名义上运载高价精铜，实则被货主与柯林合伙掉包成废铁并投保巨额海险。
  - 当晚柯林以检修为名支开前任守塔人并关掉灯塔主灯半小时，致使船只按预谋触礁沉没，随后由柯林主导“打捞核销”，私吞保险金并以此把持雾钟港补给线至今。
  - 老周失踪前整理旧油库时翻出了当年未烧毁的原始航志副页，因此遭到柯林试探与威胁，不得不带账本潜逃。
正在进行的计划: 若计划尚未被玩家识破或阻止，柯林会在第 3 天深夜派受雇的人乘小艇去沉船礁砸毁带双重货号的货箱铅封，赶在下一班补给船抵港前抹净物证。
`,
  },
  {
    path: "world/archives/keeper-logbook.yaml",
    contents: `$document:
  id: archive.fogbell-keeper-log
  ref: keeper-logbook
  title: 守塔人老周的原始航志
  summary: 海鸥号沉船当年的灯塔原始航志，附有守塔人老周的观测笔记。
  aliases: []
存放位置: 沉船礁北侧搁浅旧驳船内，由老周贴身保管。
记录内容:
  物证页: 清晰记载十年前“海鸥号”触礁当夜灯塔被人为熄灯 32 分钟的油位与值守签名，足以推翻当年的海难定论。
  异常附记: 老周失踪前半年在航志末尾记下十余次“低温大潮前的地窖嗡鸣”，并画下灯塔地窖石门后的潮汐刻痕图，标出“大低潮露出礁底时可见旧钟”。
`,
  },
  {
    path: "world/archives/resonance-chamber.yaml",
    contents: `$document:
  id: archive.fogbell-resonance
  ref: resonance-chamber
  title: 雾钟共鸣腔与旧观测碑
  summary: 无风夜雾钟自鸣的物理成因与灯塔地窖石碑所载内容。
  aliases: []
事实记录:
  物理与历史成因: 港口高处的黑铁雾钟原本是两百年前铸造的一对潮汐预警钟之一；另一口更大的青铜母钟在更早一次冰崩中坠入沉船礁缝，恰好卡在通往灯塔地基的天然海蚀溶洞口。
  共鸣现象: 每逢严冬极低气压叠加大低潮，海浪冲刷溶洞形成 18 赫兹次声驻波，带动水下母钟与山上黑铁雾钟隔空共振自鸣，既能震松礁石，也会令近距离靠近者产生强烈晕眩与幻听。
  先民碑文: 灯塔地窖内的旧石碑记录了如何用青铜楔卡住溶洞气口以平息共振，或将其保留作为大风暴前的天然警钟。
`,
  },
  gameplayFile({ mode: "tabletop", scheme: "d100" }),
  ...storyControlFiles(
    "zh-CN",
    "fogbell-inn",
    `# 雾钟港七日（d100 长线跑团调查）

这是一个为期七天的北方海港跑团调查沙盒。保持哥特海港的冷峻质感与清晰推理节奏，让玩家自由决定每日去向、调查手段、结盟对象与最终立场。

## d100 跑团判定与状态维护

- 常规观察、普通问话与无风险动作直接叙事，不必掷骰；只在存在明显风险、时间压力或对抗阻力时（如潜行入塔、撬锁、顶着戒备套话、冰海划船、辨认残缺复写字痕、抵御次声共振）发起 d100 检定，参考 @protagonist 的技能值并结合现场难度说明目标。
- 严格遵循“失败也推进剧情”：检定失败不能让线索彻底断绝，而应转化为代价——消耗额外时段、体力/压力受损、惊动港务长眼线、或被迫换一条路线获取同类线索。
- 体力、压力与装备变化写入 @protagonist；体能检定使用主角的体能技能值，按现场条件定难度。用 @current-situation 的「背景／时间」记录当前时刻，地点切换时也更新当前情境正文，保留文档标题。将玩家实际获得的线索写入 @investigation-board，注明来自亲见、他人转述或查证。线索发生时间以登岸等已经发生的事件为锚点。

## 按需读取与长线节奏

- 随调查按需用 context_read 精读基地外的地点与档案，等玩家有相应见闻或证据再揭示秘密。
- 以清晨、午后、傍晚、深夜推进七天周期，跟随 @fogbell-inn 的公开日程安排潮汐窗口和补给船抵港。推进至第三夜之前，用 context_read 核对 @wreck-insurance-truth 的幕后计划及其条件，根据调查进展决定是否发生，并在玩家可做出关键抉择的节点停下。
`,
    ["investigation-board"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "investigator-sheet",
          title: "调查员状态",
          items: [
            {
              id: "vitality",
              label: "状态",
              document: "protagonist",
              locator: ["状态"],
            },
            {
              id: "skills",
              label: "技能参考（d100）",
              document: "protagonist",
              locator: ["技能参考"],
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
          id: "investigation-progress",
          title: "调查进度",
          items: [
            {
              id: "confirmed-clues",
              label: "已获线索",
              document: "investigation-board",
              locator: ["已获线索"],
            },
            {
              id: "open-mysteries",
              label: "待解疑点",
              document: "investigation-board",
              locator: ["待解疑点"],
            },
            {
              id: "factions",
              label: "各方态度",
              document: "investigation-board",
              locator: ["各方态度"],
            },
          ],
        },
      ],
    },
  ),
];
