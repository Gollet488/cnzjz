# Kinetic Pose Lab

浏览器端通用人体姿态分析应用，使用 Vue 3、TypeScript、MediaPipe、ECharts 和 Element Plus。支持单人摄像头采集、多格式本地视频分析、时序指标、姿态对比、CSV/PNG 导出，以及 Ollama / DeepSeek Agent。

本项目面向通用人体运动的姿态采集与量化分析，提供本地推理、可追溯数值和 Agent 工具调用。启动、保留 Git 历史的上传步骤和已知限制见 [构建与交付](docs/delivery.md)，参赛要求核对见 [仓库提交清单](docs/submission-checklist.md)，目标需求见 [requirement.md](requirement.md)。

## 技术架构

Vue 3 / TypeScript 负责页面和状态，Element Plus 提供交互组件，ECharts 展示时序图表。MediaPipe Pose Landmarker Lite 在浏览器内提取人体关键点；本地视频经过 MP4Box 索引、WebCodecs 解码与 Worker 推理，其他格式先由 FFmpeg WebAssembly 转换。分析层计算通用几何与时序指标，Agent 通过受控工具读取分析结果并交付带证据的报告、视图或导出。

Ollama 由浏览器连接本机服务；DeepSeek 通过本机 Node 代理访问官方 API。系统数据流、模块职责和部署结构见 [系统架构](docs/architecture.md)，全部技术资料见 [文档索引](docs/README.md)。

## 启动

项目固定 Node 24.22.1、pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm dev
```

访问终端显示的本机地址。Windows 也可使用“启动Demo.cmd”和“停止Demo.cmd”。启动脚本验证项目进程身份；端口被其他程序占用时会报错。

`prepare:assets` 将锁定版本的 MediaPipe 运行文件和固定哈希的 Lite 模型放入 public，模型缺失时需要联网下载。已有资源可以用 `pnpm check:assets` 校验。

基础分析无需 API 密钥。使用 DeepSeek 时，将 [.env.example](.env.example) 复制为 `.env`，在本机填入密钥后运行 `pnpm dev:env`；生产构建后使用 `pnpm preview:env`。普通 `pnpm dev` / `pnpm preview` 使用进程环境或 Windows 用户环境中的密钥。环境变量、浏览器条件和排错见 [环境配置](docs/environment.md)。

## 使用

1. 默认页面使用明确标记的合成姿态演示数据。
2. 摄像头模式需要浏览器授权；保证单人、全身入镜。
3. 本地视频支持 MP4、MOV、MKV、AVI、WebM、FLV、WMV、MPEG、TS、3GP、OGV 等容器，不按扩展名拒绝文件。可直接分析的 H.264 视频保留原流程；其他输入自动使用本地 FFmpeg WebAssembly 转为 H.264 后分析，双视频对比使用同一流程。转换资源随 `prepare:assets` 准备，无需上传视频或连接 CDN。支持范围仍受实际编码、文件完整性与设备内存限制；加密文件无法保证支持。单文件最高 500 MB；转换可能耗时较长，可取消，转换结果缩放至不超过 1920×1080，时间轴与完整性以转换后视频为准。CSV 的 `acquisition_mode=webcodecs-transcoded` 标识转换流程。
4. 分析页可选关节、raw/filtered、区间与关键点，查看角度、速度、轨迹和左右差异。
5. 导出页保存 CSV 或 PNG；CSV 支持取消和进度，支持原生文件写入时使用文件流，否则使用内存 Blob。
6. Agent 页选择模型服务，先“验证并连接”，再提交目标。Ollama 使用本机地址和已安装且支持 tools 的模型；DeepSeek 使用本项目的本机开发/预览代理和 Node 环境中的 `DEEPSEEK_API_KEY`。

视频、画面、关键点推理和数值计算留在浏览器。Agent 会向所选模型发送指令和必要的有界工具反馈；选择 DeepSeek 时，这些文本和分析反馈会经本机代理发送到官方 API，密钥只由 Node 读取。页面不接收密钥；不要将密钥写入源码。Ollama 需允许页面来源跨域访问；Node 连接成功不代表浏览器 CORS 已通过。

DeepSeek 代理只在此项目的本机 Vite 开发服务或生产预览服务中可用，纯静态托管不包含代理。本项目不会自动安装或下载 Ollama 模型。

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

本轮自动回归使用合成视频和脚本化模型响应。真实设备、人体输入和真实模型的历史实测记录与当前未测项见交付说明，不能把自动回归解释为人体精度或真实模型成功率。

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

当前最多保留 18,000 帧。二维投影、遮挡、视角和置信度会影响指标；系统不识别运动种类、不评分、不判断动作对错。双视频对比目前是预览功能，参数跟随与跨画幅比例修正仍待完成，距离不能用于严格序列相似度结论。静态部署使用根路径 HTTP 服务；本项目未配置子路径资源前缀，上传源码到 GitHub 不会自动上线网站。

## 团队信息

| 项目 | 内容 |
| --- | --- |
| 团队名称 | CN终结者 |
| 团队人数 | 3 人 |

## 开发与提交

使用 TypeScript 类型检查、ESLint 和 Prettier 保持代码一致；复杂的数据契约、时间戳和工具协议有对应技术说明与回归测试。修改后运行上方检查命令，再从当前 Git 仓库提交和推送，保留真实开发历史。现有 `.delivery/` 是旧源码快照，不作为本次参赛仓库上传入口。功能规划和历史状态见 [核心功能执行计划](docs/core-execution-plan.md)。
