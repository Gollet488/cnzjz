# 浏览器回归

入口为 playwright.config.ts 和 tests/browser/flows.spec.ts，分别启动开发服务和生产构建，操作正式 index.html 页面。

```powershell
$env:BROWSER_CHANNEL='chrome'
pnpm test:browser
```

默认使用 Playwright Chromium；也可选择已安装的 Chrome。测试会创建隔离浏览器上下文，输出到 test-results。必要测试 MP4 由 scripts/check-browser-fixtures.mjs 校验固定哈希。

覆盖：图表状态和失效、60fps/VFR/旋转素材、真实 Worker 解码、CSV/PNG、暂停恢复、取消重置、片段与标记，以及脚本化 Agent 的视图、报告、CSV 和过期保护。

Agent 的脚本化 HTTP 响应只证明协议与 UI 集成。真实模型、摄像头、长运动视频、原生保存选择器及其他设备需分别验证。playwright.real.config.ts 提供独立真实模型入口。

当前实际结果见 [项目评估](project-assessment.md)。
