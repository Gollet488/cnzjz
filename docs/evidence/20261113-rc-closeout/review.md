# 2026-11-13 本机发布候选审阅

候选基线为 `8ccb2034972d1bd9c6e93aa529f3c3a451969002` 加当前工作树。本地 `origin/main` 记录指向同一基线。暂存区为空，候选提交待发布者指定。[当前签核清单](manifest-verified.json) · [构建与交付](../../delivery.md) · [下一步 Codex 指令](../../core-execution-plan.md#当前下一条指令完整可复制)

**本机签核通过。** 当前工作树的 Pages 和 Agent 独立质量两项均通过。发布签核待发布者指定候选 SHA，再核对同一 SHA 的 Checks、Pages 部署和公开 HTTPS。

## 文件范围

开始时 Git 有 75 个已修改的跟踪文件和 12 个未跟踪文件。将旧清单的 226 个条目逐个比对工作树字节数和 SHA-256，差异恰为 `docs/core-execution-plan.md`、`src/agent/modelProtocol.ts` 与 `tests/localQualityAgent.test.ts`。旧快照的验签命令首个失败为 `Delivery snapshot mismatch: docs/core-execution-plan.md`。首次错误和完整的逐文件差异保存在本机 `.qa/core-work/20261113-rc-closeout/legacy-verify.log` 与 `initial-scope.json`。这是快照生成后输入发生变化；收口复用现有生成器写入新输出名。

| 审阅范围 | 文件与行为 |
| --- | --- |
| 采集与比较 | 视频探测和转换、采样连续性、姿态有效性、双视频手动起点对齐及两路源时间回看。新增 `src/video/probe.worker.ts`、`src/utils/humanPose.ts`、`src/analysis/sampleTiming.ts`。 |
| 图表和证据 | 记录来源、区间、抽样和会话版本，驱动图表、导出与证据卡。新增 `src/analysis/sourceDisplay.ts`、`src/utils/chartEngine.ts`、`src/components/AgentEvidenceScope.vue`。 |
| Agent 和本机代理 | 模型协议、工作台、ROM 参数审阅、临时 Key、供应商工具回合和云端传输。新增 `scripts/cloud-transport.mjs`。 |
| 测试和发布 | 新增 `tests/humanPose.test.ts`、`tests/browser/human-agent.real.spec.ts`。收录 Pages Playwright 配置、冻结安装引用的 FFmpeg 补丁、固定资源及文档附件。 |

签核范围含全部跟踪文件、九个新增运行或测试文件、旧候选三份原始证据、入场快照、当前证据清单和本文。快照自身无法收录自身的哈希。原始视频、真人下载、完整审计、私人路径、密钥、依赖和本机构建产物留在忽略目录或本机原位置。[选定证据](evidence-list.json) · [旧候选审阅](../20261113-local-rc/review.md)

## 已核对并复用的候选证据

Node 24.22.1、pnpm 11.25.0。下列命令为入场快照生成前的检查记录，日志保存在 `.qa/core-work/20261113-rc-closeout/`。

```powershell
git diff --check
node --test tests/delivery.test.ts tests/localQualityAgent.test.ts tests/localQuality.test.ts tests/modelProtocol.test.ts tests/romIntent.test.ts tests/cloudModels.test.ts tests/deepseekProxy.test.ts tests/video.test.ts tests/humanPose.test.ts tests/poseCompare.test.ts tests/visualization.test.ts tests/browserFiles.test.ts
pnpm format:check
pnpm lint
node scripts/check-browser-fixtures.mjs
pnpm build --outDir .qa/core-work/20261113-rc-closeout/root-dist
pnpm build --base /cnzjz/ --outDir .qa/core-work/20261113-rc-closeout/pages-dist
```

- 定向测试 200/200，含交付测试 8/8。校验拒绝错误哈希、重复条目、密钥路径、自哈希和覆盖旧快照。范围测试覆盖 Pages 配置、FFmpeg 补丁和文档数据文件。
- 两条原问法和一条等价表达在离线协议回放中保留 35.01–40.01 秒。`sampled` 与错误端点在绑定前拒绝；正确声明只运行一次质量工具，绑定、调用及证据区间一致，实际采样 35.05–40 秒，共 100 帧。冲突范围与缺少侧别和口径进入 `needs_input`，质量工具和引用均为 0。全片、相对范围和后续修改侧别仍通过。
- 固定浏览器素材校验 18 项。两套构建均验证固定运行资源并通过类型检查，各产出 29 个文件，其中各 24 个与修复前归档字节一致；其余为入口 HTML 和四个 JS 分块。产物指纹见本机 `build-fingerprints.json`。ECharts 分块约 595 kB，构建保留大小提示。

## 当前候选新增验收

入场时有 76 个已修改的跟踪文件和 15 个未跟踪文件，暂存区为空。入场快照 229 项全部校验通过，清单路径加快照自身恰好覆盖 Git 跟踪及非忽略新增文件。入场快照原字节保留，SHA-256 为 127244a8c35f5924b0045d391cd5446ed35a789fa688b821f6f5ac47dc3c2a98。[入场快照](manifest.json)

### Pages 生产产物

从归档 .qa/core-work/20261113-rc-closeout/pages-dist 复用 29 个文件，逐一核对 SHA-256 及目录文件数。仓库 Pages 配置默认启动静态服务读 dist。本轮用忽略目录中的 Playwright 配置继承原筛选、Chrome 项目和测试套件，显式给同一个 pages-smoke-server.mjs 传入归档目录并管理所启动的进程。服务启动后、测试启动前，从实际 HTTP 读取 HTML 和 JS，均返回 200 且哈希与归档一致。

| HTTP 路径 | SHA-256 |
| --- | --- |
| /cnzjz/ | 4f287b8e83bf88727efa6d661a8f434bf3db9825ee36c4fedd74986211c12423 |
| /cnzjz/assets/index-CEU4sp-z.js | d04d13dc6d843b45c3e806e896040be07e5c014fe79816320812ec640964af73 |

Playwright JSON 实收 **12 通过、0 失败、0 跳过、0 重试**。Chrome 157.0.8103.51。通过项覆盖严格子路径及挂载外 404、MediaPipe 模型与 WASM、FFmpeg 转换与失败恢复、两路转换视频播放和慢 WASM 响应、取消与换源、图表渲染及 CSV/PNG Blob 下载。原授权真人素材全程 2011 帧，2006 帧检测到人体；逐帧对照源 PTS，重算前后回放 2011 行 × 354 列 CSV，核对二维几何及 PNG 像素。合成摄像头用例通过轨道释放验证。归档目录原样复用，本轮构建 0 次。

本机证据位于 .qa/core-work/20261113-rc-closeout-verification/。pages-preflight.json 记录目录和 HTTP 指纹，pages.log 与 pages/results.json 记录全部用例。报告 SHA-256 为 33b127cc40d278330c60f8f11030c348dcb8c6d468c093ca17e0ae66657dcda4。真人下载、截图及 human-verification.json 在 Pages 用例产物目录。

### Agent 独立质量查询

沿用上一节的离线协议回放和原授权真人 CSV 离线质量计算。合成回放实际采样 35.05–40 秒、100 帧，三种表达均核验最终引用来自正确调用。冻结真人 CSV 的离线结果为 35.033333–40 秒、82/150 有效、68/150 无效；本机计算见 .qa/human-agent-20261113/repo-entry-quality-offline.json。

真实验收只选 human_acceptance 的 quality。Chrome 使用已核对的 root-dist 生产预览；HTTP HTML 哈希 bc40f62763eeee0baeea035af979334bb544dc3b1d0847aca73b6670f14aa5e8，入口 /assets/index-D4tastSe.js 哈希 752a7a8d946e9e119562e46491fffe2804cb047d5b8275a59568f5622d856815。素材 SHA-256 为 4619fc6b5571dfeac86420cea76e3ee27506c4b8c571ad0058d72c3138c38303。Ollama 0.40.16，qwen2.5:7b-instruct 的 digest 为 063edb72580111bfb8d60517fce4744732d2c2d06106da86b60535993fc0833c。复用同一 Playwright 用例、项目和预算，忽略目录中的运行配置仅将默认构建与预览替换为已核对的归档预览并归档结果。

**1 通过、0 失败、0 跳过。** 结构化探测 1 次、业务 4 次、重试 0 次，均为 HTTP 200 且返回同一模型。目标业务墙时 12.435 秒，沿用每目标 12 次请求／120 秒上限。

| 核对项 | 实际结果 |
| --- | --- |
| 用户请求、任务绑定、工具参数和证据区间 | 35.01–40.01 秒，raw 右膝；仅一次 get_quality_summary |
| 实际采样 | 35.033333–40 秒，共 150 帧 |
| 有效、无效和帧覆盖率 | 82 有效、68 无效，其中全帧未检出 0；82/150 = 54.7% |
| 最终引用 | 10 条均从同一次成功调用回查，包含 validSamples=82、invalidSamples=68、coverage=0.5466666666666666；最长无效段 37.266667–38.966667 秒、52 帧的引用也一致 |
| 页面与会话 | 终态已完成，证据卡呈现请求及实际采样范围，定位后图表使用相同区间；重算保留源 PTS，并使旧证据操作失效 |

原始结果和审计位于本机 .qa/human-agent/runs/20261113-rc-closeout-quality/。results.json SHA-256 为 8ab47ea303a7252a2e285e68a300098351f3712c350fc3a96afa40691c137e16，turn-1-audit.json SHA-256 为 0833a71f75bc8c9c6b07f1d68eb4c31f76e2f0fad22eaf58d5042505a1537a05。两个浏览器运行启动的服务器均已回收。

## 复用的验收与待验条件

| 范围 | 证据与重开条件 |
| --- | --- |
| 历史全量 Chrome、脚本化 Agent 与真实模型 | 修复前 Chrome 开发及生产各 62 通过、5 跳过，真人生产 Chrome/Qwen 2/2、真实 CLI 3/3。修复后已有脚本化 Chrome 开发及生产合计 4/4。当前新增真人质量证据见上，后续按受影响范围复验。 |
| Windows 完整单测与启停 | 复用历史正常权限 438/438，保留受限首跑 435/438。三项启停失败的首错为 Win32_Process 返回 CIM 0x80041003，最小复现是以 Get-CimInstance Win32_Process 按 PID 查询并选择 CommandLine、CreationDate。本轮核对启动、停止、进程归属脚本及 engineering.test.ts 指纹与旧清单一致。首败和权限恢复结果分别见本机 .qa/human-agent-20261113/repo-entry-unit.log 与 repo-entry-unit-windows.log。当前候选完整启停验收在允许查询这些字段的 Windows 会话重开，保留进程归属保护。 |
| 历史 1080 引用缺口 | 归档保留。仅在原审计可离线验证新修复假设后重开，沿用 20 项引用、12 次业务请求、120 秒上限。 |
| 设备、原生保存、人体精度及云端 | 实体摄像头需可用且已获授权；原生 CSV 保存需交互文件选择器并核对落盘；人体精度需独立同帧参考、不确定度及验收阈值；真实云端需可用模型、密钥与调用授权。 |
| 发布签核 | 待发布者指定已获授权的候选 SHA。核对同一 SHA 的 Windows/Ubuntu Checks、Pages 构建与部署及实际公开 HTTPS。 |

[旧候选审阅与复跑命令](../20261113-local-rc/review.md)

## 清单和发布核对

```powershell
git status --short --branch
git rev-parse HEAD
git diff --stat HEAD
git diff --check
git ls-files --others --exclude-standard
pnpm verify:delivery --manifest docs/evidence/20261113-rc-closeout/manifest-verified.json
```

`head` 是快照生成时的 Git 基线。清单校验比较原始工作树字节，其他检出目录需匹配 Windows `core.autocrlf=true` 和仓库 `.gitattributes`。清单生成后如需改动纳入哈希的文件，完成编辑，再用 `pnpm create:delivery --output <新的清单路径> --evidence-list docs/evidence/20261113-rc-closeout/evidence-list.json` 生成新快照并验证。覆盖检查应比对 Git 的跟踪文件、非忽略新增文件与清单路径，确认只剩新清单自身。

待发布者指定已获授权的候选 SHA 后，从该 SHA 的干净检出核对冻结安装、构建与访问权限，确认 Windows/Ubuntu Checks 均成功，核对 Pages 的 /cnzjz/ 构建、静态烟测、上传产物与部署均对应同一 SHA。随后从实际公开 HTTPS 打开 `/cnzjz/`，检查入口及静态资源、视频分析、图表、双视频对比、CSV/PNG 和所需设备权限。每项失败保留首错及最小复现，按故障层和条件变化决定复跑。[下一步完整指令](../../core-execution-plan.md#当前下一条指令完整可复制)
