# Kinetic Pose Lab

浏览器端通用人体姿态分析应用，使用 Vue 3、TypeScript、MediaPipe、ECharts 和 Element Plus。支持单人摄像头采集、本地 MP4 逐帧分析、时序指标、姿态对比、CSV/PNG 导出，以及 Ollama / DeepSeek Agent。

当前阶段已暂停功能开发，先保留可运行版本，供手动上传 GitHub。启动、上传方式、本轮检查结果和已知限制见 [构建与交付](docs/delivery.md)，技术资料见 [文档索引](docs/README.md)，目标需求见 [requirement.md](requirement.md)。

后续如需恢复开发，沿用 [核心功能执行计划](docs/core-execution-plan.md)；其中旧的下一条指令暂不执行。

## 启动

项目固定 Node 24.22.1、pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm dev
```

访问终端显示的本机地址。Windows 也可使用“启动Demo.cmd”和“停止Demo.cmd”。启动脚本验证项目进程身份；端口被其他程序占用时会报错。

`prepare:assets` 将锁定版本的 MediaPipe 运行文件和固定哈希的 Lite 模型放入 public，模型缺失时需要联网下载。已有资源可以用 `pnpm check:assets` 校验。

## 使用

1. 默认页面使用明确标记的合成姿态演示数据。
2. 摄像头模式需要浏览器授权；保证单人、全身入镜。
3. 本地视频的完整分析使用 MP4Box、WebCodecs 和 Worker，支持范围受容器、编码和浏览器能力限制。
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
