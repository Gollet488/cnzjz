# Kinetic Pose Lab

浏览器端通用人体姿态分析应用，使用 Vue 3、TypeScript、MediaPipe、ECharts 和 Element Plus。支持单人摄像头采集、多格式本地视频分析、时序指标、姿态对比、CSV/PNG 导出，以及支持本地与云端模型的 Agent。

本项目面向通用人体运动的姿态采集与量化分析，提供本地推理、可追溯数值和 Agent 工具调用。启动、保留 Git 历史的上传步骤和已知限制见 [构建与交付](docs/delivery.md)，参赛要求核对见 [仓库提交清单](docs/submission-checklist.md)，目标需求见 [requirement.md](requirement.md)。

2026-11-13 本机发布候选以 Git `8ccb203` 和待审阅的工作树为基线。隔离检出通过冻结安装、固定资源校验及根路径和 `/cnzjz/` 两套构建。构建产物与区间修复后的验收归档一致，沿用本机 Pages 12/12 和真人 Qwen 独立质量查询 1/1。发布验收等待发布者指定获授权的候选 SHA。[候选清单](docs/evidence/20261113-release-candidate/manifest.json) · [本机验收与证据版本](docs/evidence/20261113-release-candidate/review.md)

## 技术架构

Vue 3 / TypeScript 负责页面和状态，Element Plus 提供交互组件，ECharts 展示时序图表。MediaPipe Pose Landmarker Lite 在浏览器内提取人体关键点；本地视频经过 MP4Box 索引、WebCodecs 解码与 Worker 推理，其他格式先由 FFmpeg WebAssembly 转换。分析层计算通用几何与时序指标，Agent 通过受控工具读取分析结果并交付带证据的报告、视图或导出。

Ollama 由浏览器连接本机服务。DeepSeek、OpenAI GPT、Anthropic Claude、智谱 GLM 和 Moonshot Kimi 通过本机 Node 代理访问官方 API。系统数据流、模块职责和部署结构见 [系统架构](docs/architecture.md)，全部技术资料见 [文档索引](docs/README.md)。

## 启动

项目固定 Node 24.22.1、pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm dev
```

访问终端显示的本机地址。Windows 也可使用“启动Demo.cmd”和“停止Demo.cmd”。启动脚本验证项目进程身份；端口被其他程序占用时会报错。

`prepare:assets` 将锁定版本的 MediaPipe 运行文件和固定哈希的 Lite 模型放入 public，模型缺失时需要联网下载。已有资源可以用 `pnpm check:assets` 校验。

基础分析无需 API 密钥。使用云端模型时，在本机开发服务或生产预览的 Agent 页选模型、粘贴供应商的官方 API Key，再点「测试当前模型连接」。用完点击「清除 Key」，长期使用可通过本机 `.env` 配置。[模型连接指南](docs/agent-model-selection.md#快速连接)

## 使用

1. 默认页面使用明确标记的合成姿态演示数据。
2. 摄像头模式需要浏览器授权；保证单人、全身入镜。
3. 本地视频支持 MP4、MOV、MKV、AVI、WebM、FLV、WMV、MPEG、TS、3GP、OGV 等容器，不按扩展名拒绝文件。可直接分析的 H.264 视频保留原流程；其他输入自动使用本地 FFmpeg WebAssembly 转为 H.264 后分析，双视频对比使用同一流程。转换资源随 `prepare:assets` 准备，无需上传视频或连接 CDN。支持范围仍受实际编码、文件完整性与设备内存限制；加密文件无法保证支持。单文件最高 500 MB；转换可能耗时较长，可取消，转换结果缩放至不超过 1920×1080，时间轴与完整性以转换后视频为准。CSV 的 `acquisition_mode=webcodecs-transcoded` 标识转换流程。
4. 分析页可选关节、raw/filtered、区间与关键点，查看角度、速度、轨迹和左右差异。
5. 导出页保存 CSV 或 PNG；CSV 支持取消和进度，支持原生文件写入时使用文件流，否则使用内存 Blob。
6. 在 Agent 页输入目标并选择模型。首次使用可展开「首次连接？查看连接指南」，测试通过后再发送任务。自定义模型 ID 位于「模型设置」。也可使用两段 ROM 比较任务卡手动填参或让已选模型草拟，核对后确认运行。详见 [Agent 工作台指南](docs/agent-workbench.md)。

视频、画面、关键点推理和数值计算留在浏览器。云端任务的指令和必要的有界工具反馈经本机代理发送到供应商官方 API。临时 Key 仅保留在当前页面内存中，刷新后清除。Ollama 需允许页面来源跨域访问。

GitHub Pages 使用 `/cnzjz/` 静态构建，提供浏览器内视频分析、图表、双视频对比和 CSV/PNG 导出。摄像头需要安全上下文和设备授权，Ollama 需要本机服务允许当前网页来源且可被浏览器访问。官方云端 API 由本机 Vite 开发服务或生产预览的 Node 代理提供。

## 检查

```powershell
pnpm format:check
pnpm lint
pnpm test
pnpm build
pnpm test:browser
```

浏览器回归需要 Playwright Chromium 或已安装的 Chrome。在 PowerShell 中可选择已有 Chrome：

```powershell
$env:BROWSER_CHANNEL='chrome'
pnpm test:browser
```

真实模型检查独立运行；会使用已安装的模型和明确标记的合成姿态输入：

```powershell
node scripts/evaluate-agent.mjs --model <本地模型名> --repeat 1 --case compare,quality,multi_turn --output .qa/my-evaluation.json
```

浏览器功能回归包含合成素材、授权人体视频及脚本化模型响应。真实 Qwen CLI 使用合成会话，真人视频与真实 Qwen 的组合使用独立的生产浏览器入口。设备、原生保存和人体精度的补验条件见 [构建与交付](docs/delivery.md)。

## 目录

- `src/analysis`：会话、版本、区间索引、本地工具与校验。
- `src/agent`：模型适配、任务规格、执行循环、证据、审计和评测。
- `src/video`：MP4 索引、离线解码和 Worker。
- `src/components`、`src/composables`：采集、图表、工作台与 UI 发布。
- `src/utils`：几何计算、绘制和导出。
- `tests`：单元、协议与浏览器回归；`tests/fixtures` 是必要测试素材。
- `scripts`：资源准备、启停、回归、基准和交付工具。
- `docs`：使用与交付、数据契约、视频和 Agent 技术说明。
- `.github/workflows`：Windows / Linux 的基础 CI 检查。

当前最多保留 18,000 帧。超过此帧数的本地视频会抽样覆盖全片，进度与 CSV 会注明抽样。二维投影、遮挡、视角和置信度会影响指标；系统不识别运动种类、不评分、不判断动作对错。本机开发和默认生产预览使用根路径。

在「姿态对比」上传参考和待测视频，分别拖动起点滑块，将同一个动作的开始画面对齐。开始后按约 10 Hz 比较重叠时间段，显示各关节的二维夹角和「待测减参考」差值。可点击最大差异，回看对应的双路画面和各自的原视频时间。两路均通过置信度阈值时才显示该关节的差值。建议用相近的视角与动作节奏，回看结果来自已采样画面。

## 团队信息

| 项目 | 内容 |
| --- | --- |
| 团队名称 | CN终结者 |
| 团队人数 | 3 人 |

## 开发与提交

使用 TypeScript 类型检查、ESLint 和 Prettier 保持代码一致。改动签核后从当前 Git 仓库交付，保留开发历史。`.delivery/` 保存历史源码副本。[候选复核步骤](docs/delivery.md#核对候选与发布条件) · [核心功能执行计划](docs/core-execution-plan.md)
