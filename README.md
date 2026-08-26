# Narraeon（叙典）

Narraeon 是一个以提示词编排和本地权威连续性为核心的开放式角色扮演工作区。世界、配置、模型凭据和历史保存在本机，浏览器只连接同机 Runtime。

## 直接启动

需要 Node.js 24.12 或更高版本：

```bash
npx narraeon web
```

命令会在 `127.0.0.1:4317` 启动服务，监听成功后打开默认浏览器。终端进程需要保持运行；按 `Ctrl+C` 停止服务。

可用选项：

```bash
npx narraeon web --port 4318
npx narraeon web --no-open
npx narraeon --help
```

如果目标端口已经运行兼容的 Narraeon，命令会直接复用并打开现有页面；如果被其他服务占用，则明确报错。

## 本地数据

默认数据位置遵循当前操作系统的标准用户目录。需要隔离一份独立实例时，可以在启动前设置：

- `NARRAEON_DATA_ROOT`
- `NARRAEON_CONFIG_ROOT`
- `NARRAEON_LOG_ROOT`
- `NARRAEON_PORT`

服务只监听 `127.0.0.1`，不会自动暴露到局域网。

AI 请求发生 Provider／响应格式／Runtime 工具／候选自检错误时，Runtime 会在
`NARRAEON_LOG_ROOT/ai-failures` 自动创建一份 JSONL 诊断记录。记录从首次错误的
原始 Provider request 与 response 开始，继续追加同一操作后续的模型交换，直到
游玩调用链、创作计划或设定候选恢复成功；Provider 实际返回的 reasoning／thinking
也会原样保留。API key 和请求 header 不会写入，但提示词、世界内容、工具参数和
思维过程可能包含私密信息，因此日志目录与文件分别使用仅当前用户可访问的权限。
Provider 没有返回的隐藏思维过程不会被推断或补造。

## 仓库开发

```bash
npm ci
npm run build
npm run check
TMPDIR=/tmp npm run test
TMPDIR=/tmp npm run test:package
```

`test:package` 会生成真实 npm tarball，在仓库外的临时目录安装它，再通过发布版 CLI 检查健康端点、首页和重复启动行为。

## License

Apache-2.0
