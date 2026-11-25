# Narraeon

[简体中文](README.zh-CN.md) | [English](README.md)

Narraeon 是一个用于开放式 AI 角色扮演的本地优先工作区。你用易读的 YAML 和 Markdown 文件搭好世界，连接自己想用的模型服务，再通过浏览器连接同一台机器上的 Runtime 开始玩。

模型负责故事语义：扮演人物、回应玩家行动、按需读取世界材料，并提出需要持续保存的变化。Runtime 负责不应该交给模型记忆的部分：验证文件操作、保存精确的已提交叙事、维护不可改写的历史、故障恢复，以及创建彼此独立的世界分叉。

## Narraeon 提供什么

- **文件原生的世界。**人物、地点、规则、当前情境、开场白和世界专属指令都是普通 YAML／Markdown 文件。
- **可持续的连续性。**重要变化会写回自然承载它的文档；玩家和主持的精确原文则作为叙事历史提交。
- **模型主导的游玩。**同一条调用链里，模型可以叙事、读取额外材料，也可以通过 Runtime 工具更新世界文档。
- **可检查的提示词。**Prompt Preview 直接展示真实的逻辑 role、选中材料、工具定义、Provider 映射和缓存边界，不会调用模型。
- **不破坏旧历史。**修改早期玩家行动会调整当前时间线，但不删除旧 Authority 记录；“创建分叉”则会得到一个可以独立演化的新世界。
- **数据归你所有。**世界、配置、凭据、提示词、历史和恢复数据都保存在本机。模型请求只会发往你明确配置的 Provider 端点。

## 运行要求

- Docker Engine／Docker Desktop，或 Node.js **24.12.0 或更高版本**，二选一
- 现代浏览器
- 如果要进行 AI 游玩或设定完善，还需要与以下任一适配器兼容的模型端点和 API 凭据：
  - OpenAI Responses API
  - OpenAI 兼容的 Chat Completions
  - Anthropic Messages
  - Google Interactions

Narraeon 内置了多家 Provider 的连接预设，也允许手动填写自定义端点。建议选择工具调用能力稳定的模型。

Google Interactions 适配器支持标准和 CLIProxyAPI 连接，可以拉取模型列表或手动填写模型 ID，也可以配置推理强度和摘要。CLIProxyAPI 方言另支持兼容预算。针对具体模型和协议版本，覆盖游玩、设定完善、世界修订和后置请求的实模端到端验证仍待完成。[模型 Provider 规格](docs/specs/model-providers-and-resilience.md#14-google-interactions)

## 快速启动

无需全局安装，直接运行已发布的 Web 应用：

```bash
npx narraeon web
```

Narraeon 会在 <http://127.0.0.1:4317> 启动并打开默认浏览器。使用期间需要保持终端进程运行；按 `Ctrl+C` 停止服务。

常用选项：

```bash
npx narraeon web --port 4318
npx narraeon web --no-open
npx narraeon --help
```

服务只监听 `127.0.0.1`。CLI 只有在确认选定端口上的 Narraeon 使用同一个数据目录时才会复用。端口已被占用且无法复用时，可用 `--port` 换一个端口。

也可以直接运行 GitHub Container Registry 上的发布镜像：

```bash
docker run --detach --name narraeon \
  --publish 127.0.0.1:4317:4317 \
  --volume narraeon-data:/var/lib/narraeon \
  ghcr.io/narraeon/narraeon:latest
```

然后打开 <http://127.0.0.1:4317>。命名卷会在重建容器后继续保留世界、配置、凭据、日志和恢复数据。`NARRAEON_HOST=0.0.0.0` 让 Runtime 监听容器内的所有 IPv4 网卡。Docker 的 `--publish` 决定宿主机绑定哪个地址，上面的示例绑定到 `127.0.0.1`。

Narraeon 只应运行在回环地址或受信任的私网中。如果通过反向代理提供私网访问，请让代理先验证访问者身份，再转发请求。限制对 Runtime 端口的直接访问，让访问者只能通过代理连接。运行在 Docker 宿主机上的代理可沿用上面的映射，转发到 `127.0.0.1:4317`。

Runtime 默认接受监听端口上的 `127.0.0.1` 和 `localhost`。如果更改宿主机映射端口，或使用反向代理，请在容器的 `NARRAEON_TRUSTED_ORIGINS` 中按浏览器实际访问的 URL 填写来源，包含协议、主机名和非默认端口。多个来源用逗号分隔，例如 `http://127.0.0.1:8080,https://narraeon.example`。代理应保留传入的 `Host` 和 `Origin` 请求头，供 Runtime 校验请求。Narraeon 没有内置 Web 认证。

稳定版会移动 `latest`，预发布版会移动 `next`，每次发布还会保留精确版本标签。

### 从终端搜索世界故事

```bash
npx narraeon history grep "$world_id" "那封信"
```

命令以只读方式使用与 `narraeon web` 相同的数据目录，也识别 `NARRAEON_DATA_ROOT`。它在当前时间线的已提交叙事中做不区分大小写的字面搜索，按消息从新到旧输出引用、片段起始位置和原文片段。退出码 `0` 表示找到结果，`1` 表示无命中，`2` 表示用法或读取错误。

## 从源码运行

```bash
git clone https://github.com/narraeon/narraeon.git
cd narraeon
npm ci
npm run build
npm start
```

然后打开 <http://127.0.0.1:4317>。如果想通过已构建的 CLI 启动，而不是直接运行源码服务：

```bash
node dist/node/cli/main.js web
```

## 首次使用

1. **选择界面语言。**在顶部切换语言，选择会保存在本机。它会改变界面和 Runtime 自带的默认提示词，但不会重写你已经保存的内容或自定义提示词。
2. **准备内容包。**新建一份空白内容包，或者导入 ZIP。内容包是世界模板，不是正在游玩的存档。它主要包含：

   ```text
   opening.md                 玩家首次看到的故事正文
   world/                     初始人物、地点、规则和当前情境
   control/frame.yaml         决定提示材料的确定性编排
   control/blocks/*.md        只属于这个世界的指令
   control/player-views.yaml  故事旁边常驻显示的信息
   ```

3. **手工编辑或让模型完善设定。**你可以直接编辑文件，也可以接入模型来读取、讨论或修改内容包。每份完整工具响应结算时，成功的 AI 改动直接保存到内容包。
4. **检查编排方案。**系统自带的默认编排方案可以直接使用，并会跟随当前语言。编排方案包含可复用的主持方法、叙事提示、后置请求和可选界面扩展。
5. **创建世界。**把可用的内容包复制成独立世界。你可以先保存世界，随时重开并阅读开场白。
6. **准备游玩时配置模型。**在世界里打开“配置模型”，选择 Provider 预设或自定义端点，填写 API Key、模型 ID、上下文窗口和最大输出限制。保存并启用连接后会回到同一个世界，并保留你写下的行动。准备好后再发送。

## 怎么玩

打开世界后，已提交的故事是页面主体，玩家视图则在旁边常驻显示。写下你的角色准备做什么、说什么，或者作出什么决定，然后选择这次怎样发送：

| 操作             | 会做什么                                                                                     | 不会做什么                                         |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **全新上下文**   | 从世界当前端点、当前提示词、选定材料和近期叙事重建模型上下文，再追加新的玩家原文。           | 不会清空世界、页面上的故事或已保存的调用链历史。   |
| **追加上下文**   | 继续当前模型 transcript，并追加新玩家原文。没有既有上下文时，会自动按全新上下文开始。        | 当前上下文仍然活跃时，不会重新编译世界 bootstrap。 |
| **空输入时追加** | 上次请求中断时，原样重发已保存的 Provider 请求；上次响应完整时，从当前 transcript 继续生成。 | 不会偷偷补一条玩家指令，也不会提交空玩家消息。     |

响应会实时流式显示在页面上。模型可以直接叙事、精确读取一份文档或历史、更新世界文档、创建文档，也可以组合叙事和工具调用。工具调用只会修改未提交候选；Runtime 验证后才会接受并提交结果。后续 Provider 请求失败，也不会撤销前面已经提交的结果。

### 跨上下文保持连续

Narraeon 不依赖一段无限增长的聊天。全新上下文会从当前世界重新编译，已提交叙事和重要文档变化仍然作为持久连续性保留。短期场景细节可以留在近期叙事里；一旦忘掉就会导致明显矛盾的事实，则应当写进相关人物、地点、物品、规则或当前情境文档。

调用链面板保留真实请求轨迹供检查：玩家消息、模型正文、Runtime 工具及结果、usage、失败，以及 Provider 真实返回的 reasoning。内部处理过程不会被写成故事正文。

### 修改消息、创建分叉和世界修订

| 操作                     | 结果                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **修改已提交的玩家消息** | 把当前世界回退到这条消息之前，再从修改稿继续。此前的历史会保留，原消息及之后的故事、模型对话和产物会从当前世界永久删除。 |
| **创建分叉**             | 把选中的 Authority 前缀复制成一个全新的独立世界。来源世界不变，两个世界之后可以分别继续。                    |
| **世界修订**             | 在世界页打开 **世界修订**，在故事外手动或借助 AI 编辑世界状态和世界控制。预览改动后，可应用为一次提交，也可放弃草稿。[世界修订规格](docs/specs/authoring-and-world-revision.md#4-世界修订工作区与跨-epoch-会话) |

## 内容包与设定完善

内容包在创建世界前可以自由编辑。你可以保留多份内容包、复制、导出 ZIP，或者导入新包，不会覆盖已有的本地身份。

在设定完善对话中，你可以请模型讨论计划，也可以请它直接编辑内容包。Runtime 按顺序执行每份完整工具响应里的调用，再把所有成功改动一起发布到内容包当前树。对话中可查看逐调用的文件差异、引用检查和真实 Prompt Preview 等检查结果。创建世界时，Runtime 会为该世界独立复制内容包文件。

更详细的创作方法见 [docs/content-package-setting-authoring.md](docs/content-package-setting-authoring.md)。

## 语言行为

默认界面语言为英文。切换到简体中文后，以下内容会同步改变：

- Web 界面；
- Runtime 自带的默认主持提示和叙事提示；
- Runtime 工具说明和工具使用契约；
- 新建空白内容包时使用的初始文件。

已有内容包、世界、导入的编排方案、复制的编排方案和用户编辑过的提示文件不会被自动翻译或重写。

## Android

实验性的 Android 应用在 App 进程内运行同一套后端。前台服务启动内嵌的 Node 运行时，WebView 通过 Android 分配的回环端口打开应用。目前只支持 `arm64-v8a` 设备。构建步骤与运行时目录结构见 [android/README.md](android/README.md)。

## 本地数据与隐私

Narraeon 默认使用当前操作系统的标准用户应用目录。如果要隔离一份独立实例，或者自行指定存放位置，可在启动前设置：

| 环境变量               | 用途                               |
| ---------------------- | ---------------------------------- |
| `NARRAEON_DATA_ROOT`   | 内容包、世界、Authority 历史和产物 |
| `NARRAEON_CONFIG_ROOT` | 模型连接、应用偏好和编排方案       |
| `NARRAEON_LOG_ROOT`    | Runtime 日志和 AI 失败诊断         |
| `NARRAEON_PORT`        | 本地 Web 端口，默认为 `4317`       |

容器镜像把前三类存储目录统一放在 `/var/lib/narraeon` 下，因此 Docker 示例只需要持久化这一个目录。

默认情况下，浏览器只与同机 Runtime 通信。“本地优先”不等于远程模型推理也离线：提示词、选中的世界材料、工具交换和生成文本会发送到你配置的 Provider。API Key 保存在本地配置中，保存后不会再返回给浏览器。

发生 Provider、响应格式、Runtime 工具或候选检查错误时，Narraeon 会在 `NARRAEON_LOG_ROOT/ai-failures` 下创建 JSONL 事故记录。它会保存原始 Provider 交换和后续恢复尝试，包括 Provider 真实返回的 reasoning／thinking。它不会伪造隐藏思考，也不会记录 API Key 和请求 header。不过日志仍可能包含私密提示词、世界内容、工具参数和 Provider 返回的思考，因此应当把该目录视为敏感数据。

每个失败的 Runtime 请求、每次以中断结束的游玩调用、每次失败的对话实时同步，也会追加到 `NARRAEON_LOG_ROOT/runtime-errors/<UTC 日期>.jsonl`，记录请求类型、请求中的标识（世界、上下文、事件和操作 ID）以及错误信息、错误码、调用栈和 cause 链，不记录请求里的玩家原文和世界内容。反馈问题时附上对应的那一行即可。

## 升级世界

由 v0.3.0 至 v0.6.0 创建的世界会在当前版本第一次打开时自动升级。由 v0.2.0 及更早版本创建的世界不再直接升级：先用 v0.3.0–v0.6.0 各打开一次，再用当前版本打开。无法升级的世界会显示为不可打开，并且不会被修改。

## 仓库开发

```bash
npm ci
npm run build
npm run check
npx playwright install chromium
npm run test
npm run test:package
```

`npm run test:package` 会生成真实 npm tarball，在仓库外的临时目录安装，再检查发布版 CLI、健康端点、首页和重复启动行为。

项目契约、架构与作者指南：

- [GLOSSARY.md](GLOSSARY.md) —— 领域词汇
- [docs/product-foundation.md](docs/product-foundation.md) —— 顶层 V1 产品与架构宪法
- [docs/specs/](docs/specs/) —— 按子系统划分的权威工程、协议、存储与界面专题规格（完整导航见 `docs/product-foundation.md`）
- [docs/adr/](docs/adr/) —— 架构决策
- [docs/content-package-setting-authoring.md](docs/content-package-setting-authoring.md) 与 [docs/world-state-maintenance.md](docs/world-state-maintenance.md) —— 作者创作教程、状态维护实践与实模验证指南

## License

Apache-2.0
