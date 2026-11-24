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
