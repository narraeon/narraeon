---
status: accepted
---

# Android 端把后端嵌入 App 进程，运行时为 nodejs-mobile

Android 版本把整个后端作为 App 进程内的 Node 运行时运行，不引入额外服务进程，也不依赖外部服务器。运行时使用 digidem/nodejs-mobile 的 `libnode.so`，固定为 Node 24.20.0 的发布版本（`v24.20.0-0`），只打 `arm64-v8a`，并以 sha256 校验的 release 压缩包取得；压缩包与解出的库不入库。原生壳保持最薄：Kotlin 前台服务（`dataSync`）通过 JNI 调用 `node::Start`，WebView 访问系统分配的回环端口，展示现有 Web 前端。不引入 Capacitor 或 React Native。

Kotlin 通过匿名管道传递端口、静态资源目录、数据根目录、缓存目录和启动密钥。`src/server/mobile-bootstrap.ts` 读取配置，在同一进程中启动一个拥有独立环境的 Node Worker 运行 `src/server/mobile.ts`。这样 Node 的临时文件使用 App 缓存目录，启动密钥无需放进命令行或 Android 进程环境。JNI 单独接收诊断文件路径，将 stdout 和 stderr 转发到 logcat，并保留 stderr 文件供诊断导出。

后端监听 `127.0.0.1`，接受 Android 传入的 `NARRAEON_PORT=0` 以请求可用端口。监听成功后，Worker 通过独立匿名管道把实际端口交给原生壳，并向 stdout 输出 `NARRAEON_READY <port>` 供诊断。后端不注册信号处理，也不调用 `process.exit()`。桌面 Web 与 CLI 默认端口仍为 4317。`npm run build:android` 把构建产物与生产依赖暂存到 `android/app/src/main/assets/narraeon/`；原生侧按 `bundle-version.txt` 把它拷贝到 `filesDir/narraeon/`，用户数据目录位于其外，升级不会覆盖。

Android 壳和嵌入式 Runtime 共用每次进程启动生成的随机密钥。壳在实际端口验证 Runtime 对新挑战的 HMAC 应答，并继续验证给 WebView 的首页和构建资源。WebView 与原生桥绑定该来源，Host／Origin 校验也使用实际端口。同一密钥以独立的 HMAC 消息导出调用方凭据。启动核验通过后，壳把凭据放入 WebView 私有的 `HttpOnly`、`SameSite=Strict` 会话 cookie，路径限制在 `/api/runtime/v1`。移动 HTTP 入口在解析请求体或办理业务前核对该凭据，覆盖命令、SSE、上传、下载检查和一次性下载。普通静态响应不签发凭据，进程重启使旧凭据失效。原生归档下载通过 `Proxy.NO_PROXY` 直接连接经过核验的本地 Runtime，不跟随重定向，连接超时 10 秒、读取超时 30 秒。桌面 Web 和 CLI 保留原有访问流程。

被拒绝的方案：

- **Capacitor 或 React Native 等跨平台壳**。它们引入额外的桥接层与构建体系，而前端已经是 Web 应用，只需要一个能运行 Node 的原生容器。
- **子进程方式运行 Node**。Android 上 App 不能可靠地派生并管理与自身生命周期解耦的进程，`child_process` 也不可用；嵌入进程内的运行时可以随前台服务存活。
- **自行编译 Node 或使用 lite 构建**。首版使用 full 版以减少变量；lite 版（去掉 ICU、inspector、`node:sqlite` 与类型剥离）作为后续的体积优化单独评估。

[ADR-0044](0044-runtime-is-single-process-and-recovers-by-retry.md) 的单进程假设与此兼容：Node 运行时在一个 App 进程里只启动一次，崩溃后由玩家重试。

Runtime 在接受游玩、设定完善或世界修订生成后，通过同进程 Unix socket 通知原生服务。服务只在生成期间持有部分唤醒锁，多项生成共用一次最长 15 分钟的持锁窗口，全部结算后才进入空闲。Android 15 回报 `dataSync` 超时时，服务释放锁并停止，等系统确认服务停止后结束 App 进程。再次打开 App 会在新进程中启动 Node，并从原数据目录恢复。
