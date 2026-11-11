# 构建与交付

## 2026-11-05 HTTPS 发布

隔离候选为 [36f75ea](https://github.com/Gollet488/cnzjz/commit/36f75ea3e5407e30944795c37ed163de9cf6907d)。构建使用冻结锁文件和 `pnpm build --base /cnzjz/`，工作流只上传 `dist/`。[Checks](https://github.com/Gollet488/cnzjz/actions/runs/42028811793) · [Pages 工作流](https://github.com/Gollet488/cnzjz/actions/runs/42028811980)

Pages 目标地址为 [Kinetic Pose Lab](https://gollet488.github.io/cnzjz/)。仓库管理员在 [Settings → Pages](https://github.com/Gollet488/cnzjz/settings/pages) 将 Source 设为 GitHub Actions 后，可继续候选的部署。发布验收需打开最终 HTTPS 页面，复验本地视频分析、实际资源请求、图表与片段、354 列 CSV、PNG、摄像头和 Ollama 回环权限。

Chrome 156 已在本机 HTTPS 候选上完成实际视频推理、下载与真实摄像头权限、采集和轨道释放。已验证本机 Web 加 DeepSeek 回环代理的完整多轮交付及重算失效。Ollama 已验证连接探测及允许、拒绝、服务离线三种状态，完整业务验收待可用模型。安装、来源配置与本机入口见 [环境配置](environment.md#ollama)。

本轮原始证据位于本机 `.qa/core-work/20261105-https-release/`。真实人体素材、私人审计、密钥和旧交付压缩包留在发布目录之外。以下内容为历史记录。

更新日期：2026-10-31（Asia/Shanghai）。按参赛要求补齐代码仓库资料，由用户自行上传 GitHub。本次不创建提交、不推送，保留当前仓库和原有开发历史。

2026-11-03 补充：本文保留当时的交付检查；当前完成度及后续任务以 [统一执行计划](core-execution-plan.md) 为准，历史未提交状态、服务 PID 和测试结果不能当作当前实况。

## 当前仓库整理

本次新增 [系统架构](architecture.md)、[环境配置](environment.md)、根目录 `.env.example`、明确加载本机配置的 `dev:env` / `preview:env` 脚本及 [仓库提交清单](submission-checklist.md)。README 已补充架构与“CN终结者，3 人”团队信息，按用户要求不列成员姓名和分工。交付清单工具已包含安全的环境模板，实际密钥文件仍排除。浏览器检查发现并修复了首次导入 FFmpeg 时的开发依赖预打包问题。

当前检查结果和上传前待办统一记录在 [仓库提交清单](submission-checklist.md)。下方 2026-10-30 的结果保留为历史记录，不代替本次检查。

## 2026-10-30 历史检查

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

需要从文件加载 DeepSeek 密钥时，先复制 `.env.example` 为 `.env` 并在本机填写，再使用 `pnpm dev:env` 或构建后的 `pnpm preview:env`。普通启动命令及 Windows 双击脚本使用进程环境或 Windows 用户环境；详细变量说明见 [环境配置](environment.md)。

浏览器回归在安装 Playwright Chromium 后运行 `pnpm test:browser`；已有 Chrome 时可在 PowerShell 中先设置 `$env:BROWSER_CHANNEL='chrome'`。真实模型测试为独立可选检查，本轮没有发起真实模型请求。

## 2026-10-31 历史手动上传说明

参赛要求保留完整 Git 提交历史，应从**当前项目根目录**提交和推送。本地目前有 13 条可达提交（本次检查时），远程已配置为 `https://github.com/Gollet488/cnzjz.git`。不要在副本中重新 `git init`，也不要只通过网页上传文件或 ZIP 来替代现有历史。

先检查即将提交的改动：

```powershell
git status --short
git diff --stat
git remote -v
git branch --show-current
```

确认改动中包含当前功能源码、测试素材、本次文档和 `public/ffmpeg/` 运行资源，再提交。`.gitignore` 会排除依赖、构建、日志、私人配置和本地交付产物；只有无密钥的 `.env.example` 允许入库。

```powershell
git add .
git diff --cached --stat
git diff --cached --check
git commit -m "Complete video support and competition repository documentation"
git push -u origin HEAD
```

上述提交会包含当前尚未提交的多格式视频功能与本次仓库完善内容，提交前请按暂存差异核对。若推送提示远程已更新，先获取并检查远程改动、合并解决冲突后再推送；保留两侧历史，不使用强制覆盖。若改用另一个空仓库，通过修改当前仓库的远程地址继续推送即可保留历史，无需重新初始化。

GitHub Desktop 也可直接添加当前本地仓库，检查 Changes、创建提交后 Push origin。不要选择 `.delivery/kinetic-pose-lab/`：`.delivery/` 中的目录、ZIP 和校验清单是 2026-10-30 的旧快照，不含本次修改，也不包含 `.git/` 历史。

发布后确认仓库设为 Public，或已给予评审访问权限；确认 README、`.env.example`、`.github/`、必要模型/WASM/测试素材及提交历史都可访问。仓库可见性、评审权限和远程分支状态需由上传者最终确认，本次未访问远程账户设置。

上传后现有 GitHub Actions 会执行 Windows/Linux 的格式、lint、单元测试和构建；远程 CI 结果以仓库实际运行结果为准。本次未执行远程 CI。

## 2026-10-31 历史部署与模型连接

生成的 `dist/` 可通过根路径 HTTP 静态服务访问，不要双击 `index.html` 用 `file://` 运行。MediaPipe 模型、WASM 与推理 Worker 一同分发，资源校验固定版本、模型 SHA-256 和依赖包分发字节。摄像头需要浏览器许可与安全上下文，本机使用 localhost/127.0.0.1。

本项目使用 `/mediapipe/` 等根路径资源；尚未适配 GitHub Pages 的仓库子路径。上传源码不会自动部署网站，本轮也未新增 Pages 发布配置。

Agent 的两种连接方式：

- Ollama：在本机运行已安装且支持 tools 的模型，允许页面精确来源跨域访问。在 Agent 页选择模型、输入任务并发送。
- 云端模型：从本机 Vite 开发服务或生产预览打开页面。Node 读取凭据和已启用的模型，选择后即可发送。配置步骤见 [Agent 模型配置与验收](agent-model-selection.md)。

视频、画面和姿态推理留在浏览器。选用云端模型时，用户指令与必要的有界工具反馈经本机代理发送到官方 API。完整工具审计保存在本机浏览器 IndexedDB。

## 阶段限制

- 本轮未重新采集真实摄像头、未运行真实人体视频，也未调用真实 Ollama/DeepSeek。历史真人视频、人工摄像头 CSV 与真实 DeepSeek 多轮结果保留在统一计划和本机审计中，不能等同于本轮重测。
- 工具自动操作真实摄像头媒体时钟/轨道、Windows 原生保存选择器及设备性能仍待实测；人工操作反馈与模拟用例分别保留。
- 2026-11-03 V1 已接入双视频分析与显示设置、独立滤波窗口及各视频源宽高比校正；约 10 Hz 预览不等于严格逐帧序列配准，对比距离不用于严格相似度结论。
- 单目二维投影、遮挡、视角和置信度影响指标；最多保留 18,000 帧，不识别运动类型、不评分、不判断动作对错。

后续开发使用 [统一执行计划](core-execution-plan.md) 中最新的“当前下一条指令”；旧的设备单项等待队列已由 2026-11-03 的条件队列替代。

## 现有交付工具

启动/停止脚本记录并核验项目 PID、命令行、创建时间和健康响应。端口被其他进程占用时拒绝替换；停止前必须确认进程归属。

交付清单工具可按明确证据列表生成哈希清单并校验，不能把哈希完整性当成功能验收。旧运行记录不是生产运行依赖。

历史评估见 [2026-10-29 项目评估](project-assessment.md)，它保留当时的模型配置与失败记录，不替代上方本轮结果。
