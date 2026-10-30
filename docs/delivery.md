# 构建与交付

更新日期：2026-10-30（Asia/Shanghai）。当前按用户要求暂时停在本阶段，保留可运行源码，供用户自行上传 GitHub；未创建提交、推送或远程发布。

## 本轮检查

| 检查 | 结果 |
| --- | --- |
| 当前本机网站 `http://127.0.0.1:5173/` | HTTP 200，现有生产预览服务保留 |
| 格式 / ESLint | 通过 |
| 单元、协议和工程测试 | 346/346 通过，包含 Windows 启停与进程归属检查 |
| 类型、MediaPipe 固定资源和生产构建 | 通过；charts 约 595 kB 的体积告警保留 |
| Chrome 浏览器回归 | 开发 / 生产共 36 项通过，2 项需要真实人体视频的用例跳过 |

浏览器回归直接打开真实页面，覆盖图表和版本失效、60fps/VFR/旋转 MP4、真实 MediaPipe/Worker、时间戳、暂停恢复、取消重置、区间/标记/重算、CSV/PNG 下载，以及脚本化 Ollama/DeepSeek 的图表、报告、导出和取消。已查看生产页面截图。模拟摄像头错误和脚本化模型响应不能替代真实设备与模型验收。

本轮修正：交付工具改为使用 `requirement.md`；评测测试按场景 ID 选择用例，补齐新增三轮交付的脚本声明；Windows 检查点原子替换对短暂占用增加有界重试并清理临时文件；开发服务忽略本地测试和上传产物，避免文件整理触发页面重载。

初次受限沙箱中的两项启停检查被 CIM 进程查询权限阻止，允许查询后复验通过。浏览器用例结束后，测试框架等待临时服务退出，核对身份后只清理了本轮 5186/5187 服务，报告成功写出；原有 5173 服务未停止。最终本机记录在 `.qa/github-handoff-20261030/` 和 `test-results/`，不包含在上传副本中。

## 安装与运行

依赖固定在 pnpm-lock.yaml；环境固定 Node 24.22.1 和 pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

开发运行 `pnpm dev`；生产构建后运行 `pnpm preview`，访问终端显示的地址。Windows 可双击根目录的“启动Demo.cmd”；该脚本默认启动开发服务，停止使用“停止Demo.cmd”。生产模式可使用：

```powershell
node scripts/start-demo.mjs --production
```

已有资源可直接校验，不需要重复下载模型。缺失时，`pnpm prepare:assets` 会从固定官方地址准备资源。

浏览器回归在安装 Playwright Chromium 后运行 `pnpm test:browser`；已有 Chrome 时可在 PowerShell 中先设置 `$env:BROWSER_CHANNEL='chrome'`。真实模型测试为独立可选检查，本轮没有发起真实模型请求。

## 手动上传 GitHub

整理后的文件位于原项目的 `.delivery/` 内：

- `kinetic-pose-lab/`：干净源码副本，可直接作为新仓库目录使用。
- `kinetic-pose-lab-source.zip`：同一副本的压缩包，解压后使用。
- `package-info.json`：本机文件数量、字节数与 SHA-256 校验记录。

副本保留 `src/`、`public/`、`scripts/`、`tests/`、`docs/`、`.github/`、锁文件、配置及 Windows 启停脚本。模型、WASM、Worker 和必要的微型合成测试素材均保留，便于在新电脑上复现。

副本排除 `.git/`、`node_modules/`、`dist/`、`.qa/`、`.demo/`、`test-results/`、Playwright 报告、缓存、日志、`.env*`、构建增量文件及上传包本身。私人摄像头 CSV 和人体视频未打包；原项目的历史材料仍保留在本机。

你可以用 GitHub Desktop 将 `kinetic-pose-lab/` 创建为仓库后发布，或在该副本内执行以下命令。先在 GitHub 创建一个空仓库，再替换下方远程地址：

```powershell
git init -b main
git add .
git commit -m "Initial project snapshot"
git remote add origin https://github.com/YOUR_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

如果通过 GitHub 网页上传，上传解压后的源码与隐藏配置文件；只上传 ZIP 会将其保存为压缩附件。`.github/` 与 `.gitignore` 等文件也需要上传。原工作区已有 Git 历史和未提交修改，本轮没有重置、暂存或改动其提交记录。

上传后 GitHub Actions 会执行 Windows/Linux 的格式、lint、单元测试和构建；远程 CI 结果以仓库实际运行结果为准。本轮未执行远程 CI。

## 网站部署与模型连接

生成的 `dist/` 可通过根路径 HTTP 静态服务访问，不要双击 `index.html` 用 `file://` 运行。MediaPipe 模型、WASM 与推理 Worker 一同分发，资源校验固定版本、模型 SHA-256 和依赖包分发字节。摄像头需要浏览器许可与安全上下文，本机使用 localhost/127.0.0.1。

本项目使用 `/mediapipe/` 等根路径资源；尚未适配 GitHub Pages 的仓库子路径。上传源码不会自动部署网站，本轮也未新增 Pages 发布配置。

Agent 的两种连接方式：

- Ollama：在本机运行已安装且支持 tools 的模型，允许页面精确来源跨域访问，然后在 Agent 页读取模型并验证连接。
- DeepSeek：使用本项目的本机 Vite 开发或生产预览服务，Node 进程环境或 Windows 用户环境提供 `DEEPSEEK_API_KEY`，再在 Agent 页选择 DeepSeek 并验证连接。密钥只由 Node 读取，不写入源码或前端。纯静态托管不包含此回环代理。

视频、画面和姿态推理留在浏览器；选用 DeepSeek 时，用户指令与必要的有界工具反馈会发送到官方 API。完整工具审计保存在本机浏览器 IndexedDB，不随源码上传。

## 阶段限制

- 本轮未重新采集真实摄像头、未运行真实人体视频，也未调用真实 Ollama/DeepSeek。历史真人视频、人工摄像头 CSV 与真实 DeepSeek 多轮结果保留在统一计划和本机审计中，不能等同于本轮重测。
- 工具自动操作真实摄像头媒体时钟/轨道、Windows 原生保存选择器及设备性能仍待实测；人工操作反馈与模拟用例分别保留。
- 双视频姿态对比仍使用固定阈值/窗口，未统一不同画幅比例，约 10 Hz 预览不等于严格逐帧序列配准。主分析链路可用，对比距离暂不用于严格相似度结论。
- 单目二维投影、遮挡、视角和置信度影响指标；最多保留 18,000 帧，不识别运动类型、不评分、不判断动作对错。

恢复开发时使用 [统一执行计划](core-execution-plan.md)，当前不继续其中旧的下一条指令。

## 现有交付工具

启动/停止脚本记录并核验项目 PID、命令行、创建时间和健康响应。端口被其他进程占用时拒绝替换；停止前必须确认进程归属。

交付清单工具可按明确证据列表生成哈希清单并校验，不能把哈希完整性当成功能验收。旧运行记录不是生产运行依赖。

历史评估见 [2026-10-29 项目评估](project-assessment.md)，它保留当时的模型配置与失败记录，不替代上方本轮结果。
