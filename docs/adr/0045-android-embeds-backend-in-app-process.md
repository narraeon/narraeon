---
status: accepted
---

# Android 端把后端嵌入 App 进程，运行时为 nodejs-mobile

Android 版本把整个后端作为 App 进程内的 Node 运行时运行，不引入额外服务进程，也不依赖外部服务器。运行时使用 digidem/nodejs-mobile 的 `libnode.so`，固定为 Node 24.20.0 的发布版本（`v24.20.0-0`），只打 `arm64-v8a`，并以 sha256 校验的 release 压缩包取得；压缩包与解出的库不入库。原生壳保持最薄：Kotlin 前台服务（`dataSync`）通过 JNI 调用 `node::Start`，WebView 访问 `127.0.0.1:4317` 展示现有 Web 前端。不引入 Capacitor 或 React Native。

后端入口是 `src/server/mobile.ts`。它只读取环境变量（端口、静态资源目录与三个数据根目录），固定监听 `127.0.0.1`，不注册信号处理，也不调用 `process.exit()`，并在监听成功后向 stdout 输出 `NARRAEON_READY <port>`。桌面的 `src/server/main.ts` 与 CLI 不变。`npm run build:android` 把构建产物与生产依赖暂存到 `android/app/src/main/assets/narraeon/`；原生侧按 `bundle-version.txt` 把它拷贝到 `filesDir/narraeon/`，用户数据目录位于其外，升级不会覆盖。

被拒绝的方案：

- **Capacitor 或 React Native 等跨平台壳**。它们引入额外的桥接层与构建体系，而前端已经是 Web 应用，只需要一个能运行 Node 的原生容器。
- **子进程方式运行 Node**。Android 上 App 不能可靠地派生并管理与自身生命周期解耦的进程，`child_process` 也不可用；嵌入进程内的运行时可以随前台服务存活。
- **自行编译 Node 或使用 lite 构建**。首版使用 full 版以减少变量；lite 版（去掉 ICU、inspector、`node:sqlite` 与类型剥离）作为后续的体积优化单独评估。

[ADR-0044](0044-runtime-is-single-process-and-recovers-by-retry.md) 的单进程假设与此兼容：Node 运行时在一个 App 进程里只启动一次，崩溃后由玩家重试。
