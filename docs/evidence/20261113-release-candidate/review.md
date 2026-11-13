# 2026-11-13 本机发布候选复核

候选是 `8ccb2034972d1bd9c6e93aa529f3c3a451969002` 加待审阅工作树。清单中的 `head` 表示基线。暂存区为空，本地 `origin/main` 记录与基线一致。发布验收等待发布者指定获授权的候选 SHA。[候选清单](manifest.json) · [构建与交付](../../delivery.md) · [执行计划](../../core-execution-plan.md)

## 本轮验签与构建

入场时有 76 个跟踪修改、15 个未跟踪文件。旧 `manifest.json` 在 `docs/core-execution-plan.md` 首次报哈希不匹配，入场 `manifest-verified.json` 校验通过 230 项、64,893,951 字节。旧清单和两批原始证据以原字节保留。本轮只调整 `.gitattributes`、五处交付文档和本次证据入口。[旧验签记录](../20261113-rc-closeout/review.md) · [选定证据列表](evidence-list.json)

将 `git ls-files -z --cached --others --exclude-standard` 列出的候选文件复制到隔离仓库，执行 `git -c core.autocrlf=true add -A`。分别用 `git -c core.autocrlf=true checkout-index --all --prefix=<空目录>/` 和 `core.autocrlf=false` 生成两份干净检出，再从各自目录运行候选验签。隔离仓库的索引独立于原仓库。

| 隔离检出 | 修复前首错与定位 | 修复后 |
| --- | --- | --- |
| `core.autocrlf=true` | `Delivery snapshot mismatch: patches/@ffmpeg__ffmpeg@0.12.15.patch`，仅该补丁由 LF 转成 CRLF | 与候选逐文件字节一致，验签通过 |
| `core.autocrlf=false` | `Delivery snapshot mismatch: README.md`，共 24 个文件由 CRLF 转成 LF，范围为 Markdown、封面提示和姿态 Worker | 与候选逐文件字节一致，验签通过 |

`.gitattributes` 固定这些文件的现有换行，资源、夹具及归档证据沿用原字节保护。当前清单应覆盖 224 个源码、配置与资源文件和 9 个证据文件。将清单条目和清单自身合并后与 Git 跟踪及非忽略新增路径比对，检查缺项和多项。生成器与验签器沿用现有入口。[复核命令](../../delivery.md#核对候选与发布条件)

在修复后的隔离检出用 Node 24.22.1 和 pnpm 11.25.0 验证 `pnpm install --offline --frozen-lockfile --store-dir <既有离线存储> --cache-dir <既有缓存的副本>`。首跑仅通过环境变量定位缓存，pnpm 在供应链元数据校验阶段返回 `ERR_PNPM_NO_OFFLINE_META`，首个缺项为 `@babel/helper-string-parser` 的 `metadata-full` 条目。改用全新检出显式指定缓存目录，pnpm 识别已有锁文件政策校验记录并完成安装，下载 0。政策、补丁和锁文件沿用仓库配置。没有可用缓存时，需连通包仓库以完成标准 `pnpm install --frozen-lockfile`。

新验交付测试 8/8、全仓格式、`pnpm prepare:assets`、18 项固定浏览器素材、`pnpm build --outDir dist-root` 和 `pnpm build --base /cnzjz/ --outDir dist-pages` 均通过。两个构建各 29 个文件，路径及 SHA-256 与区间修复后的归档全部匹配。ECharts 分块大小提示仍见构建日志。本机复现及日志在 `.qa/core-work/20261113-release-candidate/`，其中 `before/` 保留检出首错和逐文件换行差异，`install-frozen.log` 保留安装首错，`build-equivalence.json` 保存构建对照。

## 证据适用版本

| 版本 | 已有证据与适用范围 |
| --- | --- |
| 区间修复后，`20261113-rc-closeout/manifest-verified.json` | 当前构建产物逐文件匹配该版本的验收归档。沿用本机 Pages 12/12，覆盖真人源 PTS、图表、双视频、2011 行 × 354 列 CSV 回放、PNG 及合成摄像头。沿用真人 Qwen 独立质量查询 1/1，raw 右膝请求 35.01–40.01 秒，实际采样 35.033333–40 秒，有效 82/150、无效 68/150、最终引用 10/10，重算后旧证据操作失效。原运行探测 1 次、业务 4 次、重试 0。 |
| 区间修复后，同一产品与测试输入 | 沿用定向回归 200/200、脚本化 Agent Chrome 4/4、Lint 与区间绑定离线回放。交付改动未触及产品、测试、模型、依赖或固定资源。 |
| 区间修复前，`20261113-local-rc/manifest.json` | 全量 Chrome、真人 Qwen 组合场景、真实 CLI 和正常权限 Windows 全量单测 438/438 保留为当时版本的证据。 |

本轮核对原 Pages 报告、真人 Qwen 报告和审计的 SHA-256，均与原记录一致。本轮模型探测、业务调用和重试均为 0。授权视频、真人下载、完整审计、私人路径和密钥留在本机。[区间修复后原始审阅](../20261113-rc-closeout/review.md) · [区间修复前原始审阅](../20261113-local-rc/review.md)

## 待验及重开条件

| 项目 | 所需条件与验收 |
| --- | --- |
| 发布验收 | 获授权的候选 SHA。核对其干净检出、冻结安装、固定资源及构建，核对同一 SHA 的 Windows/Ubuntu Checks、Pages 构建和部署产物，再验证公开 HTTPS 的入口与核心流程。 |
| Windows 完整启停 | 本轮以 `Get-CimInstance Win32_Process -Filter "ProcessId = $PID"` 复现 `0x80041003`。在可查询进程命令行与创建时间的 Windows 会话完成当前候选全量检查。 |
| 人体精度 | 具备独立同帧参考、参考不确定度和预先冻结的验收阈值后复验。 |
| 1080 双膝引用 | 历史真实专项最终缺 6 项引用。先用既有审计验证新的离线修复假设，获授权后沿用 20 项引用门槛和单目标 12 次业务请求、120 秒预算。 |
| 实体摄像头与原生 CSV 保存 | 摄像头需可用设备和授权。原生保存需能操作交互文件选择器并核对实际落盘。 |
| 真实云端 | 可用模型、密钥及调用授权齐备后，按既有单目标预算补验。 |
