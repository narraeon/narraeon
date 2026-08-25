# v1 采用 TypeScript 单进程本地 Web 实现栈

v1 在 Node 24 LTS 上以端到端 TypeScript 实现单个本地 Runtime 进程，使用 React/Vite 提供静态 SPA、以薄 Fastify 同源适配器暴露 `Runtime.execute/read`，并将权威提交、快照文件工作区和模型主持分别封装为 Runtime 内部深模块。相比 Rust/FFI、桌面壳、SSR 元框架、数据库、Agent 框架或后台任务系统，这一选择以较少语言和运行机制保留唯一提交者边界，并让协议、崩溃恢复、模型适配与完整浏览器路径能够分层测试；只有真实验收数据证明需要时才增加这些被拒绝机制。
