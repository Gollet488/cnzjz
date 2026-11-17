# 浏览器回归

`playwright.config.ts` 运行 `tests/browser/` 下的 `*.flows.spec.ts`，分别启动开发服务和生产构建，操作正式页面。

```powershell
$env:BROWSER_CHANNEL='chrome'
pnpm test:browser
```

默认使用 Playwright Chromium；也可选择已安装的 Chrome。测试会创建隔离浏览器上下文，输出到 test-results。必要测试 MP4 由 scripts/check-browser-fixtures.mjs 校验固定哈希。

开发及生产测试服务默认使用本机 5186 和 5187 端口。如果端口已占用，可以在运行前分别用 `BROWSER_DEV_PORT` 和 `BROWSER_PREVIEW_PORT` 指定空闲端口。

回归覆盖采集和摄像头授权及失败恢复、多格式视频和真实 Worker 解码、历史帧键盘定位、片段与标记、图表与手动角度复核、双视频对比和模型读取重试、CSV/PNG、移动布局，以及脚本化 Agent 的模型连接、任务卡、报告和过期保护。

Agent 的脚本化 HTTP 响应只证明协议与 UI 集成。真实模型、摄像头、长运动视频、原生保存选择器及其他设备需分别验证。playwright.real.config.ts 提供独立真实模型入口。

## GitHub Pages 发布检查

```powershell
pnpm build --base /cnzjz/
pnpm test:browser:pages
```

需要已安装的 Chrome。测试用严格的静态服务器挂载 `dist/`，验证 MP4 逐帧时间戳、AVI 转码、双视频同步、回看与导出，以及转码资源加载失败后的重试。根路径请求直接返回 404。提交到 `main` 的 PR 会运行这组检查，合并后 Pages 通过同一检查再上传已测试的 `dist/`。

最新验收结果见 [当前交付状态](delivery-status.md)。
