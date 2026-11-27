import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const canalEscortChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `清河码头的晨雾还没散尽，运河水拍打着“顺水号”的杉木船帮，发出闷闷的声响。栈桥尽头挂着过闸的红灯笼，再过半个月，北边河段就要起凌封河——你接下的这趟长镖，必须在封河前把一口盖着双色火漆的樟木箱平安送到通州官仓。

你是这趟镖的领队。樟木箱已经锁进后舱暗格，委托人只给了半块刻字木牌作交割凭据，嘱咐一路少生事端、莫轻易开箱。

跑了二十年运河的船老大老谭正蹲在船头系缆绳，抬头往北望了一眼：“十五天赶到通州，顺风顺水不算紧，可真要碰上卡闸、起雾或者沿途横生枝节，就得精打细算。刚才听过路盐船说，前头柳湾闸这两天查船查得紧。”

年轻镖师阿砚拎着两包干粮跳上甲板，眼里满是第一次走北线的新鲜劲：“头儿，刚才在码头茶棚，我还听见有人打听咱们顺水号是不是空舱北上，愿出双倍船资搭顺风船去白塔集。咱是这就起锚直奔柳湾闸，还是先去茶棚探探那搭船人的底细？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.canal-escort
  ref: current-situation
  title: 运河押镖当前局面
  summary: 顺水号北上押镖途中的当前时间、停靠位置与待决事项。
  aliases: []
背景:
  时间: 第 1 日 · 清晨
  地点: 清河码头，顺水号货船甲板
在场:
  - { $ref: character.ce-leader }
  - { $ref: character.ce-tan }
  - { $ref: character.ce-ayan }
当前待决:
  启程选择: 阿砚刚汇报码头茶棚有人愿出双倍船资搭船去白塔集；领队尚未决定即刻起锚直奔柳湾闸，还是先去茶棚探听来人底细。
  现场: 老谭手握缆绳待命；封蜡樟木箱已锁在后舱暗格；码头茶棚就在几十步外。
`,
  },
  {
    path: "world/characters/escort-leader.yaml",
    contents: `$document:
  id: character.ce-leader
  ref: protagonist
  title: 押镖领队
  summary: 负责将封蜡樟木箱沿运河送往通州官仓的领队，姓名、武艺或行商来历均由玩家决定。
  aliases: []
职责与风格: 决定航线停靠、是否接沿途私活或搭客、如何应对水闸盘查与江湖风波。
随身物件:
  - 委托人交付的半块刻字交割木牌
  - 沿途水闸通关文牒与镖单
  - 随身防身短刃与雨具
`,
  },
  {
    path: "world/characters/boatman-tan.yaml",
    contents: `$document:
  id: character.ce-tan
  ref: boatman-tan
  title: 老谭
  summary: 顺水号船老大，跑了二十年南北运河，熟悉水闸规矩、暗礁水文与码头人情。
  aliases: [谭老大]
动机: 稳稳挣完这趟北线运费，保住顺水号不在封河前冻在半路；重交情，只要领队讲义气、不坑船家，他肯冒点风险帮忙绕水路或托旧识。
行事: 嘴上爱算账、提醒风浪与耽搁，真遇上事却沉得住气。
认知:
  知道: 沿途柳湾闸、白塔集、盐仓镇、临清渡各有各的码头规矩与地头蛇；走小支流能避开大闸盘查，但吃水浅、费功夫。
  不知: 不知道封蜡樟木箱里装的究竟是什么，只看出委托人给的运费高得反常。
`,
  },
  {
    path: "world/characters/ayan.yaml",
    contents: `$document:
  id: character.ce-ayan
  ref: ayan
  title: 阿砚
  summary: 首次走北线长镖的年轻镖师，机灵热心，耳目灵敏，负责日常看护后舱货箱。
  aliases: []
动机: 想把人生第一趟大镖漂亮办成，也对运河沿途的市井风物和江湖传闻充满好奇。
行事: 跑腿打听消息最快，偶尔容易心软帮路人，但听领队调度。
认知:
  听闻: 清晨在清河码头茶棚听说有人愿出双倍船资搭顺风船去白塔集，尚未见到对方本人。
`,
  },
  {
    path: "world/locations/qinghe-wharf.yaml",
    contents: `$document:
  id: location.ce-qinghe-wharf
  ref: qinghe-wharf
  title: 清河码头与顺水号
  summary: 运河北线的启程码头，以及作为移动据点的顺水号平底货船。
  aliases: []
固定设施:
  顺水号: 一艘双桅平底运河货船，前舱堆杂货与干粮，后舱床板下设有带暗闩的藏货暗格，船尾挂小舢板一只。
  清河码头: 栈桥旁有早开张的码头茶棚、船行货栈与过闸司房，南来北往的脚夫与盐船常在此歇脚。
`,
  },
  {
    path: "world/case/escort-manifest.yaml",
    contents: `$document:
  id: case.ce-escort-manifest
  ref: escort-manifest
  title: 镖单与运河行程
  summary: 记录核心押镖期限、船况盘缠、沿途未探水镇传闻及玩家已接支线。
  aliases: []
核心期限与船况: 距封河尚有 15 日；顺水号完好，盘缠与干粮够半月之用，封蜡樟木箱安放后舱暗格。
交割约定: 封河前送抵通州官仓；凭半块刻字木牌对验交割；途中莫轻易开箱破封。
老谭航路簿所记站点:
  柳湾闸: 前方首道大闸；刚才南下的过路盐船称这两天查船极严。
  白塔集: 运河中段商镇；阿砚在茶棚听说有人愿出双倍船资搭船前往。
  盐仓镇: 官盐集散旧镇，水路岔口多（近况待沿途打听）。
  临清渡: 入北最后一处大渡口，常作水陆换乘处（水情待临近核实）。
沿途见闻与支线:
  - 码头茶棚传出双倍船资求搭顺风船的消息，尚未核实来人身份。
`,
  },
  {
    path: "world/archives/sealed-crate-origin.yaml",
    contents: `$document:
  id: archive.ce-crate-origin
  ref: sealed-crate-origin
  title: 封蜡樟木箱委托底档
  summary: 用于核对封蜡樟木箱的委托背景与通州官仓交割缘由。
  aliases: []
事实记录:
  箱内之物: 双色火漆封着的并非金银，而是一叠盖有旧盐政铜印的实收账册与证词，足以牵出沿河多处盐卡多年的亏空旧账。
  交割凭据: 通州官仓的接货主事持另一半刻字木牌，见牌验收；若火漆被无故拆毁，接货人会起疑并要求当面查验账册真伪。
  潜在各方: 沿途既可能有盐卡旧党暗中打听拦截，也可能有被冤屈的船户、地方小吏或江湖人顺藤摸瓜找上门来。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "qinghe-wharf",
    `# 运河押镖记（核心主线 + AI 自主生长支线）

这是一趟沿着大运河北上的开放式旅途。核心主线是十五日内把封蜡樟木箱平安送抵通州官仓，但沿途的风土人情、水镇风波与偶遇人物刻意留白——请把“从种子自然生长世界”当作本局的核心乐趣。

## 鼓励自主扩展世界与支线（world_create）

- 行程单上的柳湾闸、白塔集、盐仓镇、临清渡，以及玩家主动探访的任何茶棚、岔河小村、过路船只与搭船客，均未预写详细文档。不要因为它们不在初始文件里就把玩家硬拽回赶路。
- 当玩家停船探访、接下搭客或私活、卷入地方纠纷、结识新人物或开辟新路线时，请结合明清运河市井质感现场生成鲜活的人物、地点与支线风波；只要新人物或新地点会在后续回合持续产生影响，就调用 world_create 将其写入 world/characters/ 或 world/locations/，而需要共同追溯的重要事件与支线结果则写入已有的 @important-events（不要尝试创建 world/events/）。
- 支线应当与主线彼此呼吸：支线里结下的船户人情、拿到的手令、欠下的麻烦或赚到的盘缠，都可以在后续过闸、避寒、遇袭或换旱路时真正派上用场。

## 信息隔离与状态维护

- @sealed-crate-origin 是按需读取的幕后底档，仅在玩家设法查探箱子来历、与知情者交锋或拆封查验时再通过 context_read 读取，严禁在玩家尚未查验前泄露箱内实情。
- 封河倒计时只维护在 @escort-manifest 的「核心期限与船况」中，不在 @current-situation 重复记录。每次天数推进、停靠新水镇、船况/盘缠变动或接下新支线时，及时更新 @current-situation（只保留眼下仍未决定的事项，移除已落定的旧选择；若过闸盘查或交接只完成了一半，例如文书已验而货舱待验，应分开写明已完成与待处理部分）与 @escort-manifest；长期承诺写入 @pending-matters，重要人物往来写入 @relationships。
`,
    ["escort-manifest"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "escort-board",
          title: "押镖状态",
          items: [
            {
              id: "deadline-ship",
              label: "核心期限与船况",
              document: "escort-manifest",
              locator: ["核心期限与船况"],
            },
            {
              id: "handover-terms",
              label: "交割约定",
              document: "escort-manifest",
              locator: ["交割约定"],
            },
            {
              id: "route-rumors",
              label: "老谭航路簿所记站点",
              document: "escort-manifest",
              locator: ["老谭航路簿所记站点"],
            },
            {
              id: "side-threads",
              label: "沿途见闻与支线",
              document: "escort-manifest",
              locator: ["沿途见闻与支线"],
            },
          ],
        },
      ],
    },
  ),
];
