import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const driftlineEchoesChinese: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `碎石港三号泊位的气闸发出最后一声泄压轻响，你脚下的“灰燕号”终于完成了常规加注。舷窗外，这座由废矿岩凿成的边境补给站正缓缓旋转，停泊区里挤满了满身焊疤的拾荒船、私运驳船和过路货轮。

你是老旧勘测船“灰燕号”的船长。星图台上正亮着三道微弱的残响坐标——十年前失联的深空科考队“远望号”，在星域边缘留下了三枚尚未彻底熄灭的自动信标：红移-04、冰带-09 与静默港-12。找到并拼齐它们，就是这趟远航的核心主线。

轮机长索尔擦了擦手上的机油，敲了敲主控台旁的燃料表：“聚变芯勉强够跑完一个来回，但外环星区没几家正经船坞。要是顺路能接点零活赚些备件，或者换套新的滤波线圈，咱们后半程会稳当得多。”

导航员林溪正戴着半边耳机调试公共频段，忽然抬头把一段刚截获的杂音转到扬声器里——先是碎石港调度塔挂出的一条高酬测绘委托，紧接着又插进半句断断续续的民用求救呼号，方向正好偏离三条主信标，落在碎石港外侧的空白碎石带里。

林溪按下暂停键，转向你：“船长，三道残响信标都在图上。咱们是直接定一条信标航线出港，先去港站酒馆打听那单高酬委托，还是先顺着那半句求救呼号去外侧碎石带看看？”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.driftline-echoes
  ref: current-situation
  title: 灰燕号当前航行局面
  summary: 灰燕号在边境星域的当前时间、所在位置与待决事项。
  aliases: []
背景:
  时间: 航行第 1 日 · 泊位待命
  地点: 碎石港三号民用泊位，灰燕号舰桥
在场:
  - { $ref: character.de-captain }
  - { $ref: character.de-sol }
  - { $ref: character.de-linxi }
当前待决:
  航向选择: 林溪刚截获碎石港测绘委托与外侧空白碎石带的断续民用求救呼号；船长尚未决定直接定一条主信标航线出港、进站打听委托，还是先去碎石带查求救信号。
  现场: 星图台亮着红移-04、冰带-09、静默港-12 三个未探方向；灰燕号刚完成加注。
`,
  },
  {
    path: "world/characters/captain.yaml",
    contents: `$document:
  id: character.de-captain
  ref: protagonist
  title: 灰燕号船长
  summary: 驾旧勘测船闯荡边境星域的船长，姓名、过往与行事准则均由玩家决定。
  aliases: []
职责: 决定航线顺序、是否响应空白星区信号或港站私活、招募新船员，以及如何与边境派系打交道。
随身设备:
  - 船长加密星图密钥与多频段手持扫描仪
  - 民用宇航服与应急磁力钩索
`,
  },
  {
    path: "world/characters/sol.yaml",
    contents: `$document:
  id: character.de-sol
  ref: sol
  title: 索尔
  summary: 灰燕号轮机长，沉默务实，靠改装旧零件让这艘老勘测船一直撑在深空里。
  aliases: []
动机: 保证灰燕号引擎不断电、船体不漏气，攒够信用点换一套可靠的深空滤波线圈。
行事: 爱泼冷水但极靠谱；玩家若在支线里弄来稀缺零件或旧船核心，他能现场改装出实打实的新功能。
认知:
  知道: 碎石港的船坞黑市什么都敢卖，但要价狠；外环空白碎石带里常有拾荒帮设伏，也可能漂着没人认领的好零件。
`,
  },
  {
    path: "world/characters/lin-xi.yaml",
    contents: `$document:
  id: character.de-linxi
  ref: lin-xi
  title: 林溪
  summary: 灰燕号导航员兼信号破译员，对十年前失联科考队“远望号”的残响频段研究极深。
  aliases: []
动机: 拼齐三道残响信标里的碎片数据，弄清“远望号”当年究竟在星域边缘发现了什么。
行事: 好奇心强、反应快，既关心主线信标，也不反对顺路响应求救或接几单能换星图情报的私活。
认知:
  知道: 红移-04、冰带-09、静默港-12 三道信标目前只传回微弱周期脉冲，必须抵近扫描才能提取完整数据。
`,
  },
  {
    path: "world/locations/gravel-port.yaml",
    contents: `$document:
  id: location.de-gravel-port
  ref: gravel-port
  title: 碎石港与灰燕号
  summary: 边境小行星补给站，以及作为移动基地的老旧勘测船灰燕号。
  aliases: []
固定设施:
  灰燕号: 小型三人制老旧勘测船，配有跃迁引擎、深空频段阵列、可改装货舱与两套标准舱外服。
  碎石港: 凿在旋转小行星内的民用中转站，设有停泊坞、拾荒者酒馆、零件黑市与调度塔公告屏。
`,
  },
  {
    path: "world/case/star-chart.yaml",
    contents: `$document:
  id: case.de-star-chart
  ref: star-chart
  title: 星图与航行日志
  summary: 记录灰燕号船况补给、三道未探残响信标方向及当前支线与委托。
  aliases: []
船况与补给: 船体完好；聚变燃料足够一趟近外环往返；备件偏紧，滤波线圈老化。
启程星图信标:
  红移-04: 位于高温尘埃带边缘，周期脉冲最清晰（星区近况待抵近或打听）。
  冰带-09: 藏在冰晶小行星环深处，信号时断时续（星图未标明细）。
  静默港-12: 最远端的废弃中继浮标方向，脉冲微弱（航路近况未知）。
支线与委托:
  - 碎石港调度塔挂出一单高酬测绘委托，详情未询。
  - 公共频段截获外侧空白碎石带的断续民用求救呼号。
`,
  },
  {
    path: "world/archives/lost-survey-core.yaml",
    contents: `$document:
  id: archive.de-lost-survey
  ref: lost-survey-core
  title: 远望号失联与残响信标底档
  summary: 用于核对十年前远望号公开航线与三道残响信标频段关联的背景档案。
  aliases: []
事实记录:
  拆分背景: 十年前“远望号”科考队在边境发现一条罕见的低能耗天然跃迁裂隙，因担心被星域财团强占，临撤离前将完整航道数据与日志拆成三段加密残响，分别留在了红移-04、冰带-09 与静默港-12，随后关闭应答器驶入深空。
  单枚信标可证实内容:
    红移-04: 存有裂隙入口星历与第一段校验码，以及领队的一段短录音，证实当年撤离并非事故而是为躲避财团追查，但未写明稳定窗口与远端出口。
    冰带-09: 存有裂隙内部的引力稳定窗口与第二段校验码，以及副领队与领队关于“公开坐标还是永久封存”的争执日志，指向第三枚信标留有最终去向。
    静默港-12: 存有远端出口的安全落点坐标、第三段校验码，以及出口端浮标当年收到的一段科考队抵达应答信号（确认主力已从此处安全穿出并向深空撤离），但单靠它仍缺少入口星历与稳定窗口，无法安全进入。
`,
  },
  ...storyControlFiles(
    "zh-CN",
    "gravel-port",
    `# 残响航线（核心主线 + AI 自主生长星域）

这是一场边境星域的开放式太空探索。核心主线是驾驶灰燕号追寻并拼齐红移-04、冰带-09、静默港-12 三道残响信标，但星图之外的广阔星区、过路船只、黑市委托与派系纠纷全部刻意留白——请充分运用“从种子持续生长世界”的能力。

## 鼓励自主扩展星域与支线（world_create）

- 三个信标星区以及碎石港外侧的空白碎石带、酒馆委托人、拾荒帮、前哨遗民与可招募新船员均未预写文档。不要把玩家强行限定在“只跑三个信标”的直线流程里。
- 当玩家回应求救、接下黑市或测绘委托、探索空白星区、结识过路船长或卷入星站派系冲突时，请现场生成质感克制、有真实太空生活细节的新星站、新人物与支线事件；只要新星站或新人物会在后续航程中继续产生影响，就调用 world_create 写入 world/locations/ 或 world/characters/，而需要共同追溯的重要事件与救援/委托结果则写入已有的 @important-events（不要尝试创建 world/events/）。
- 让支线真正改变主线，并让人情与信任在稀缺瓶颈上兑现成陌生人拿不到的实质差异：当玩家带着支线里救下的人情、私密频段、换来的改装零件或星图情报面对紧俏泊位、稀缺部件、星区封锁或危险航道时，应转化为优先留位、安全捷径、免去盘查或独门条件，而不是口头致谢却给出与普通船只相同的待遇。

## 信息隔离与状态维护

- @lost-survey-core 是按需读取的核心背景档，仅在玩家成功破译任一道残响信标或查到远望号旧记录时再通过 context_read 读取，严禁在玩家尚未破译前剧透科考队当年发现的实情。
- 每次跃迁、消耗燃料、获得改装零件、推进信标破译或接下新委托时，同步更新 @current-situation（只保留眼下待决定的事项，清理已落定的旧选择）与 @star-chart；长期约定写入 @pending-matters，派系与人物关系写入 @relationships；当玩家把关键航程或破译结果当面告知某位人物时，尽量在当轮同步更新该人物文档的「认知」。
`,
    ["star-chart"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "ship-log",
          title: "灰燕号航志",
          items: [
            {
              id: "hull-fuel",
              label: "船况与补给",
              document: "star-chart",
              locator: ["船况与补给"],
            },
            {
              id: "beacon-vectors",
              label: "启程星图信标",
              document: "star-chart",
              locator: ["启程星图信标"],
            },
            {
              id: "contracts-signals",
              label: "支线与委托",
              document: "star-chart",
              locator: ["支线与委托"],
            },
          ],
        },
      ],
    },
  ),
];
