# 打包 CLI 的 SIGTERM 验证

产品基线为 `c789fce`。[#272](https://github.com/narraeon/narraeon/issues/272)

## 复跑

在仓库根目录使用 Node 24.12.0 或更新版本运行。脚本向实际启动的 CLI 进程发送 POSIX 信号。

```sh
npm ci
npm run build
probe_package=$(mktemp -d)
npm pack --ignore-scripts --silent --pack-destination "$probe_package"
npm install --prefix "$probe_package/consumer" --ignore-scripts --no-audit --no-fund "$probe_package"/narraeon-*.tgz
probe_cli="$probe_package/consumer/node_modules/.bin/narraeon"
node scripts/cli-shutdown/probe.mjs --cli "$probe_cli" > "$probe_package/shutdown.json"
```

用以下命令等服务器自行回收普通 JSON 和 NDJSON 的 keep-alive 套接字。修复前这两个用例各需约 75 秒。

```sh
node scripts/cli-shutdown/probe.mjs --cli "$probe_cli" --natural-keepalive > "$probe_package/shutdown-natural.json"
```

探针使用已安装 npm 包的 bin，以 `web --no-open` 启动。每个用例分配独立的 loopback 端口和临时数据、配置、日志目录。重启同一用例时复用这些目录和端口。探针会清理自己的临时目录和子进程。Provider 是 loopback 上的 Chat Completions 模拟端点，先发正文增量，等探针放行再发尾段和完成事件。默认在 SIGTERM 后保持 Provider 活跃 1.5 秒。快速模式再观察 1.5 秒，若已完成的响应仍留下开放的套接字，探针主动关掉它并记录时间。另一个用例由探针向仍在生成的 CLI 发送 SIGKILL，专门验证重启恢复。所有这些时间都是实验控制量。

JSON 记录包含真实 SSE 观测、NDJSON 增量、终态回执、HTTP 消息是否完整和底层套接字关闭时刻。`exitMsAfterResponseClosed` 是响应结束到进程退出的时间差。`commitsAdded` 是放行 Provider 后重启读到的新增权威提交数，探针要求恰好一轮。以发送 SIGTERM 为零点的字段中，负值表示事件发生在信号前。退出码为 `null` 时，`signal` 指明终止进程的信号。端口由一个独立 TCP listener 试绑。

## #272 基线样本与结论

macOS arm64、Node v26.5.1、Fastify 5.12.8，安装的 Narraeon 包为 `0.9.0-preview.3`。下表取一次快速样本。所有用例退出后均可重新绑定原端口。

| 发信号时的状态                                | SIGTERM 至进程退出 | 退出终态           | 连接终态                                                               |
| --------------------------------------------- | -----------------: | ------------------ | ---------------------------------------------------------------------- |
| 空闲                                          |            27.7 ms | 退出码 0           | 无开放的观察或生成连接                                                 |
| 已收到 SSE `observation` 快照                 |            14.6 ms | 退出码 0           | 2.6 ms 时连接断开，客户端收到 `ECONNRESET`                             |
| NDJSON 已发完，套接字还在 keep-alive          |            10.4 ms | 退出码 0           | 信号前收到最终帧和完整 EOF，信号后 0.7 ms 时套接字关闭                 |
| NDJSON 生成中，客户端要求 `Connection: close` |         1,562.3 ms | 退出码 0           | 1,500.9 ms 时放行 Provider，1,552.1 ms 时收到最终帧和完整 EOF          |
| NDJSON 生成中，客户端保留 keep-alive          |         3,070.2 ms | 退出码 0           | 1,547.7 ms 时已收到最终帧和完整 EOF，3,057.3 ms 时由探针关掉空闲套接字 |
| 普通 JSON 生成中，客户端保留 keep-alive       |         3,041.4 ms | 退出码 0           | 1,527.8 ms 时已收到完整回执，3,034.2 ms 时由探针关掉空闲套接字         |
| NDJSON 生成中，Provider 一直保持打开          |         1,505.6 ms | 由探针发送 SIGKILL | 无最终帧，客户端收到 `ECONNRESET`，Provider 观察到对端关闭             |

自然回收样本中，信号后 1.568 秒收到最终 NDJSON 帧和完整 EOF，74.725 秒时套接字关闭，75.103 秒时 CLI 以退出码 0 退出。HTTP 回包声明 `Keep-Alive: timeout=72`，本次客户端等待对端关闭套接字。

可复现的最小条件是一个 HTTP/1.1 keep-alive 请求在 SIGTERM 到达时仍活跃，随后完成响应但套接字继续开放。Node v24.12.0 的快速复跑、普通 JSON 对照和原生 Node HTTP 的独立小实验都出现同样的行为。信号到达时已经空闲的 keep-alive 套接字会立即关闭。Fastify 调用 Node HTTP server 的 `close()` 时会停止监听并清理当时空闲的连接。样本中所有正在生成的用例在 Provider 仍活跃期间已经能试绑原端口，进程仍存活则由进程退出事件单独确认。

放行 Provider 后，重启同一目录可读到完整主持回复，世界端点由 `commit:3` 推进到 `commit:4`。SIGKILL 样本重启时保留两条玩家输入和此前完成的主持回复，世界端点仍为 `commit:3`，未结算正文保持中断且可重发。重启读取期间 Provider 收到零次新请求。显式重发产生的 Provider 请求体与中断前逐字节一致，成功后推进到 `commit:4`，每条玩家输入各出现一次。

## 后续变更可用的验收语义

- 发信号后停止接受新连接，结束只读 SSE。生成成功结算时，活跃请求收到最终回执和完整 EOF，响应结束后空闲套接字及时关闭，CLI 以退出码 0 退出。
- 若后续决定允许中断活跃生成，重启后保留已提交内容，将未结算生成显示为可显式重试的中断，重发沿用冻结请求且只结算一次。等待时限由后续产品决定。
