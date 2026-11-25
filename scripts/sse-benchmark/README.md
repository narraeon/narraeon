# 长对话游玩 SSE 基准

使用项目要求的 Node 版本。首次运行先在仓库根目录安装依赖和 Chromium，并构建生产 Web 页面。

```sh
npm ci
npx playwright install chromium
npm run build
mkdir -p .scratch/262-sse
node scripts/sse-benchmark/measure.mjs --out .scratch/262-sse/normal --turns 500
node scripts/sse-benchmark/measure.mjs --out .scratch/262-sse/dense --fixture .scratch/262-sse/normal/fixture --chunk-ms 8
```

第二条测量命令从完全相同的存档开始，缩短 Provider 分块间隔。三个组每轮交错，轮换六种顺序。每套忽略一轮热身，默认留下 8 组普通样本和 4 组详细采样。输出目录必须是新目录。复用存档时，`fixture.json` 记录的 loopback 端口须可用，保存的模型连接会直接使用它。项目数据使用临时克隆，每次运行保留原始存档。

## 怎么测

- 用普通 `play.chain.start` 和 `play.chain.append` 创建历史。每次试验从同一份数据和配置的文件副本启动 Runtime，预读同一调用链，等待初始连接和页面读取结束。
- `none` 用无订阅的 HTTP JSON 命令，等到 Runtime 完成生成并返回回执，全程没有轮询。 `wire` 用相同命令和一个完整消费的真实 HTTP SSE 连接。 `page` 用生产构建的世界页输入框和追加按钮，保留其原生 EventSource、React 更新和只读刷新。每次都核对连接数、Provider 请求字节的 SHA-256、命令回执和磁盘上已提交叙事的完整正文，页面组再核对最终 DOM 正文。
- 独立于 Runtime 的本地 Chat Completions 测试端点按固定绝对节拍发文字分块，记录每个计划与实际写入时刻、结束信号和请求大小。Provider 等待从收到请求体至首块写入，派发开销从 Runtime 命令入口至收到请求体，结算开销从 Provider 结束至 Runtime 回执。
- Node CPU 是服务端进程的 user + system 时间。主要结果取 HTTP 命令入口到回执，另取回执后约 150 ms 的一致窗口纳入延后发送的终态和额外页面读取。两窗口均排除热身、原始日志落盘与结果校验。为减少日志波动，Fastify 日志关闭。页面的 Chromium `TaskDuration` 单列，覆盖点击前采样至最终正文进入 DOM。
- 详细组在独立 Runtime 进程加探针，记录 `readConversation` 和其中扩展控制版本读取次数及累计墙钟，逐次计时 SSE 路径的 JSON 字符串化和更新构建，并保留实际写入的 SSE 帧。更新构建耗时含其内部等值比较。帧字节数含 SSE 事件与字段封装，按 UTF-8 计，HTTP 头和分块封装在外。正常组用于 CPU 主对照，详细组用于归因和观察探针对结果的影响。
- 浏览器探针记录原生 EventSource 投递、DOM 更新与下一次 `requestAnimationFrame`，并测量探针回调自身的时长。为模拟盯着新回复的读者，在待定段落出现时滚动一次。通过字形范围命中测试记录是否进入视口。首个增量以点击起算，同时给出从 Provider 写入起算的延迟。后续每个 Provider 分块匹配到首次包含该前缀的事件和渲染帧，因此自动包含合批。帧时间代表绘制机会，实际像素呈现可能更晚。跨进程时间戳使用同机单调计时的 Unix 时间锚。
- 普通生成对照覆盖本机环回、单观察者、普通游玩、故事模式和一次无工具正文回复。远程网络、低性能设备、多观察者、工具循环和后置请求需要独立样本。

## 输出

| 文件 | 内容 |
| --- | --- |
| `environment.json` | 版本、设备、存档规模、输入、回复分块和节拍 |
| `samples.jsonl` | 每次试验一行，含热身、原始时刻、CPU、每帧探针、最终正文和散列 |
| `summary.json` | 每组的中位数、p95、最小值和最大值，以及同轮配对差值 |
| `fixture/` | 新造的合成长存档及重用配置，复用既有档时见 `environment.json` 的绝对路径 |

后续分块统计合并各样本中的分块观测，样本数同时给出可匹配与预期总数。p95 使用最近秩，小样本中可等于最大值。

## 长回复、生成中上翻和双窗口

沿用上面的 Runtime、Provider、合成长历史、生产 Web 构建与诊断探针。以下跑桌面有界面的 Chromium，使用 500 次玩家发送的合成存档。每组默认保留 4 次普通采样和 2 次 Runtime 诊断采样，每种采样另有一次短回复热身。

```sh
npm run build
mkdir -p .scratch
node scripts/sse-benchmark/measure.mjs --out .scratch/328-desktop --play-reading --headed --turns 500
```

Markdown 合入后，短验收同时检查流式和提交后的标题、强调与列表排版，以及回执与历史文件内逐字一致的原文。构建后通常约一分钟，输出目录须未存在。

```sh
npm run build
mkdir -p .scratch
node scripts/sse-benchmark/measure.mjs --out .scratch/328-after-markdown --play-reading --expect-markdown --headed --turns 60 --repeats 1 --diagnostics 1
```

如需按原存档规模比较合入前后，用 `--fixture .scratch/328-desktop/fixture` 替换 `--turns 60`，保留相同复跑数与 `--chunk-ms`，合入后加 `--expect-markdown`。`--mobile` 另跑 Chromium 的 Pixel 7 视口和触控手势模拟，它仍使用运行脚本的电脑 CPU、图形与回环网络。真机 Android WebView 另测。`--headed` 打开同一 Chromium 进程里的两个独立窗口。省略它可在无显示环境运行两个独立浏览器上下文。双窗口的可见性按各自视口计算，Playwright 保持被遮挡窗口的浏览器渲染调度。

- `short` 沿用 #262 的短正文和分块。`long`、`history` 和 `dual` 用同一份中英文长回复，每段含标题、强调、正文和列表。长短组采用相同的首块等待、分块时间间隔及结束等待。每轮轮换组顺序，并核对四组的 Provider 请求散列一致。
- 普通阅读组在第一段待定文字出现时移动一次到底部，之后保持手动阅读位置。`history` 此后在生成中用真实浏览器滚轮或模拟触控上翻，逐个更新帧及提交时检查同一历史字形仍在无遮挡视口内，位置容差为 2 CSS 像素。各组记录最新字形是否在视口内，提交后再滚到底部确认尾字可达。
- `dual` 由一个窗口提交，另一个窗口只观察同一世界。两个窗口各使用原生观察连接，各自确认待定和已提交的正文。Runtime 同时核对只收到一次派发和一个 Provider 请求。每次从同一存档的独立副本开始，验证历史只多出一条玩家原文和一条主持原文。
- 每个窗口记录点击至首个可见文字、Provider 发出分块至对应的 SSE 投递及 DOM 帧、连续 `requestAnimationFrame` 间隔、Chromium Long Tasks 和渲染主线程 `TaskDuration`。待定和已提交正文的 DOM 探针可跨嵌套元素读取。位置和分块匹配使用这份固定实测文本中的内容字符，排除它使用的 Markdown 标记和空白。原文另由 Runtime 回执和磁盘历史全文校验。可见性判断排除页头和底部输入区，通过字形命中测试。第一次模拟滚到底部和字形查询也会产生布局开销，样本另列探针耗时。帧数据代表绘制机会，长任务代表浏览器报告的约 50 ms 及以上主线程占用。
- Runtime 普通组保留 CPU 和命令墙钟。诊断组另存投影读取和扩展控制版本读取次数、累计墙钟、SSE 帧数及字节。双窗口的计数为服务端合计。读取计数反映调用路径，累计墙钟可包含等待或并发重叠。

原始证据位于输出目录的 `samples.jsonl`，`environment.json` 保存版本、视口、固定样稿及每组节拍，`summary.json` 按窗口及分组汇总，并报告匹配到更新帧的块数。分块 p95 同时给出合并统计和逐轮 p95 的最小／最大值，便于看波动。常规复跑应在机器空闲时进行。真实模型、远程网络、工具步骤、真机与超长回复需要独立采样。
