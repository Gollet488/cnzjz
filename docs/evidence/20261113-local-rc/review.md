# 2026-11-13 本机发布候选

基线为 Git `8ccb2034972d1bd9c6e93aa529f3c3a451969002` 与本机未暂存工作树。整理前为 71 个跟踪文件已修改、9 个新增文件未跟踪。本地 `origin/main` 记录与 HEAD 对齐。候选尚无对应提交，远程 Checks、Pages 部署和公开 HTTPS 待对应提交核验。

## 范围与证据

| 范围 | 待审阅改动 | 验收证据及适用范围 |
| --- | --- | --- |
| 采集与 Worker | `src/video`、`PoseStage.vue`、`poseEngine.ts`、`humanPose.ts` 和 `public/pose-inference.worker.js`。Worker 探测容器和解码能力，FFmpeg 分段读入本地文件，保留源呈现时间和抽样标记。摄像头处理部分可见关节、丢失与重新检测。 | `video.test.ts`、`humanPose.test.ts`，以及归档 Chrome 的真人离线生命周期和 CSV 逐列回放、合成摄像头、Pages FFmpeg 重试及浏览器生成设备的轨道释放。 |
| 分析与图表 | `src/analysis`、`TimeChart.vue`、`PoseCompare.vue`、`App.vue`、几何和导出。按采样中断切分有效段，保留 raw 缺失；按源时间联动范围、标记和图表。对比可调整双路起点，回看对应源时间的最大关节差异。 | 局部质量、对比和可视化定向单测通过。归档 Chrome 和 Pages 覆盖区间、图表、双路对比、354 列 CSV、PNG 和重算失效。 |
| Agent | `src/agent`、`AgentPanel.vue`、证据及成果组件、本机代理和评测脚本。覆盖 ROM 审阅、区间声明、证据来源和版本、临时 Key、云端传输及供应商工具回合。 | 归档真人生产 Chrome/Qwen 2/2 和真实 Qwen CLI 3/3。本机云端代理与临时 Key 使用脚本化网络响应验证。离线回放另见下文。 |
| 测试与交付 | `playwright.real.config.ts`、`scripts/browser-server.mjs`、浏览器和单元用例。交付清单新增 Pages 配置、FFmpeg 安装补丁及文档附件；现有工作流、锁文件及 Playwright Pages 配置与基线一致。 | 清单覆盖测试 8/8，包含于定向 172/172。隔离冻结安装、两套生产构建和逐文件等价检查通过，原 Pages 配置可发现 11 个默认用例。 |

九个原未跟踪文件均在清单内。

| 文件 | 入口与用途 |
| --- | --- |
| `src/video/probe.worker.ts` | `prepare.ts` 启动的 MP4 探测 Worker。 |
| `src/utils/humanPose.ts` | `poseEngine.ts` 和 `PoseCompare.vue` 共用的姿态有效性筛选。 |
| `src/analysis/sampleTiming.ts` | 会话与分析工具共用的采样连续性判断。 |
| `src/utils/chartEngine.ts` | `TimeChart.vue` 异步加载的图表引擎。 |
| `src/analysis/sourceDisplay.ts` | 主页面、证据卡和 Agent 共用的来源与时间格式。 |
| `src/components/AgentEvidenceScope.vue` | 成果卡和证据卡共用的范围展示。 |
| `scripts/cloud-transport.mjs` | 本机云端代理使用的传输层，有协议单测。 |
| `tests/browser/human-agent.real.spec.ts` | `REAL_AGENT_FLOW=human_acceptance` 入口选择的真人生产测试。 |
| `tests/humanPose.test.ts` | `pnpm test` 包含的姿态有效性回归。 |

## 本次检查与已有验收

本次日志在本机 `.qa/core-work/20261113-local-rc/`。安装验证使用无 `node_modules` 的候选副本与隔离的 pnpm store 和元数据缓存副本。Node 24.22.1、pnpm 11.25.0 下，`pnpm install --frozen-lockfile --offline` 校验 233 条锁文件记录，复用 183 个包，下载 0 个。`prepare:assets` 校验 MediaPipe、Lite 模型及 FFmpeg，素材脚本校验 18 个固定文件。两套构建各 29 个文件与相应归档 SHA-256 一致，见 `root-build-equivalence.json`、`pages-build-equivalence.json`。ECharts 分块约 595 kB，构建保留大小提示。`workspace-check.json` 对照隔离输入核对本轮交付编辑之外的 218 个文件，字节均一致。

| 首次失败或限制 | 输入、实际结果与后续证据 |
| --- | --- |
| 本次清单覆盖失败 | 清单测试夹具含 `playwright.pages.config.ts`，生成后断言该路径缺失。`.github/workflows/pages.yml` 经 `pnpm test:browser:pages` 使用该配置；`pnpm-workspace.yaml` 同时引用漏列的 FFmpeg 补丁。把两项加入现有生成器后测试通过。文档附件也纳入源文件覆盖，证据继续显式选择。见 `manifest-first-failure.log`、`delivery-test.log`。 |
| 历史安装与权限 | 旧 D2 克隆使用当时隔离缓存，首败为 `ERR_PNPM_NO_OFFLINE_META`。本次使用完整度更高的本机缓存副本，冻结安装通过，见 `install-offline.log`。无缓存的机器需能访问包注册表，或提供包与供应链策略元数据。历史 Windows 单测首跑 435/438，三项 CIM `Win32_Process` 被拒，正常权限完整复验 438/438。 |
| 历史真人入口与质量 | 首次迁移因变量重复声明退出，业务 0；Windows 外部预览残留，随后改用同进程持有并关闭 Vite。两次质量查询都以全片执行，后改用现有绝对区间约束并定向复验通过。首败和退出记录见本机验收索引。 |

11 月 13 日原始验收入口为本机 `.qa/human-agent-20261113/acceptance.md`。以下文件名相对于该索引目录，根路径产物比对另使用本机 `test-results/browser-dist/`，真人最终构建的 chunk 名与验收日志一致。归档测试覆盖整理前的产品、测试和配置。两套构建的一致性覆盖静态字节，CLI、代理及测试执行范围还依据相关文件未被本次整理修改。

| 已有验收 | 实际结果 | 本机证据 |
| --- | --- | --- |
| 真人生产 Chrome + 本地 Qwen | 标准交付、独立质量 2/2，探测 2、业务 7、重试 0。标准交付逐轮确认，经 Blob 保存报告和 361 行 × 354 列 CSV，重算后旧成果失效。独立质量 raw 右膝请求 35.01–40.01 秒，实际采样 35.033333–40 秒，82/150 有效、68/150 无效，覆盖 54.7%。核对证据定位及过期保护。 | `repo-entry-browser-scoped.log`、`repo-entry-standard-equivalence.json`、`repo-entry-quality-offline.json`，以及 `.qa/human-agent/runs/2026-11-13T02-51-59-825Z-0e572ae7-f088-4dc6-9301-0d6fc37a0238/results.json`。 |
| 真实 Qwen CLI | 合成会话 compare、quality、multi_turn 3/3，业务 5/4/10，探测 1。归档记录的 97 个文件指纹中，96 个一致，另一个是本次交付清单生成器。 | `repo-entry-cli.json`，本次 `cli-source-equivalence.json`。 |
| Chrome 功能回归 | 开发、生产各 62 通过和 5 跳过，0 失败。两组均含授权视频，Agent HTTP 响应为脚本化；跳过的 Pages 专属用例均在静态回归通过。 | `runs/repo-entry-chrome/results.json`。 |
| 本机 Pages | 静态 `/cnzjz/` 12/12，含授权视频和浏览器生成的摄像头设备。使用现有配置与静态服务器，预览进程由本机受控启动及回收。 | `runs/repo-entry-pages/results.json`、`repo-entry-pages-build.log`，本次 `pages-build-equivalence.json`。 |
| 历史工程检查 | 同一验收轮的全仓格式、Lint、构建和正常权限单测 438/438。 | `repo-entry-format.log`、`repo-entry-lint.log`、`repo-entry-unit-windows.log`。 |

真人标准的任务卡确认是人机交互步骤，由测试按期望参数点击。Blob 下载、浏览器生成摄像头设备、CLI 合成会话和离线复算各有独立证据。原生选择器及落盘、实体设备采集、人体精度和外部云端模型本轮没有对应实测。

### Agent 质量范围离线复核

从两次历史失败审计提取原目标和 `set_task_spec` 参数，经现有 `AgentRuntime` 回放。两次请求均明确为 35.01–40.01 秒，模型声明 `interval=sampled`，任务绑定为 0–67 秒。质量工具执行该范围，引用也匹配该范围，协议可返回 `completed`。保持同一合成输入、侧别、口径和执行器，只替换声明区间，工具从全片 1341 帧缩到原请求的 100 个已采样帧，仍能提交有效数、无效数和覆盖率引用。终态审计的正确声明在同一回放中直接通过。见本次本机 `quality-replay.json`，真实模型请求为 0。

现有明确标注句式的单测验证 `sampled` 和错误端点均在绑定前拒绝，正确区间只调用一次质量工具。缺口径和侧别走既有 `needs_input`，没有质量计算。两条旧自然语言问法仍可在回放中触发范围误判。回放验证了声明端修正的效果，自动识别任意自由文本区间仍需独立用例。本候选保留已有产品约束和验收范围。重开时先在同一声明入口验证单一明确范围保留原值、冲突范围和缺参进入澄清，再决定是否需要原模型定向复验。

## 复跑

在仓库根目录核对文件、基线和交付入口。清单按原始工作树字节校验，基线使用本机 Windows `core.autocrlf=true` 的换行规则及仓库 `.gitattributes`。换平台检出出现字节差异时，先核对换行和 Git 内容。清单覆盖源码、配置、固定资源、仓库文档和显式证据。`head` 字段记录生成时的基线，校验命令核对文件哈希，Git 命令核对提交和改动。

```powershell
git rev-parse HEAD
git status --short --branch
git diff --check
git diff --stat
git ls-files --others --exclude-standard
pnpm verify:delivery --manifest docs/evidence/20261113-local-rc/manifest.json
node --test tests/delivery.test.ts tests/localQualityAgent.test.ts tests/localQuality.test.ts tests/modelProtocol.test.ts tests/romIntent.test.ts tests/cloudModels.test.ts tests/video.test.ts tests/humanPose.test.ts tests/poseCompare.test.ts tests/visualization.test.ts
```

候选内容有变更时，用新的输出文件名生成快照。

```powershell
pnpm create:delivery --output docs/evidence/20261113-local-rc/manifest-reviewed.json --evidence-list docs/evidence/20261113-local-rc/evidence-list.json
```

在隔离副本使用 Node 24.22.1 和 pnpm 11.25.0。离线复跑需包存储和策略元数据均可用。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
node scripts/check-browser-fixtures.mjs
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

浏览器检查使用本机 Chrome。用与本机验收索引匹配的授权文件设置 `HUMAN_VIDEO_PATH` 后，会纳入真人视频生命周期；未提供素材时，Pages 的默认选择为 11 项。

```powershell
$env:BROWSER_CHANNEL = 'chrome'
pnpm test:browser
pnpm build --base /cnzjz/
pnpm test:browser:pages
pnpm eval:agent:real --model qwen2.5:7b-instruct --case compare,quality,multi_turn --repeat 1 --output .qa/rc-cli-rerun.json
```

真人与真实模型的组合按验收索引准备同一授权视频、固定 digest 的 `qwen2.5:7b-instruct` 和允许 `http://127.0.0.1:5187` 的 Ollama 回环服务。[真人视频生产验收](../../agent-model-selection.md#真人视频生产验收)

```powershell
$env:REAL_AGENT_PROVIDER = 'ollama'
$env:REAL_AGENT_FLOW = 'human_acceptance'
$env:BROWSER_CHANNEL = 'chrome'
pnpm test:browser:real --grep ': (standard|quality)$'
```

## 发布条件

原视频、完整审计、真人下载、私人路径和密钥留在本机。发布者需确定候选提交，核对干净检出、评审访问、该提交的远程 Checks 和 Pages，最后从实际公开 HTTPS 检查产物与所需权限。原生文件选择器需交互环境，实体摄像头需可用且获授权，人体精度需独立同帧参考及不确定度。历史 1080 引用缺口等待新的离线验证方案，重开时沿用原门槛和预算。
