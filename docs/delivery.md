# 构建与交付

## 2026-11-13 本机发布候选

当前交付基线为本地 `HEAD` `8ccb2034972d1bd9c6e93aa529f3c3a451969002` 加待审阅工作树。本地 `origin/main` 记录指向同一基线，发布验收等待发布者指定获授权的候选 SHA。[候选清单](evidence/20261113-release-candidate/manifest.json) · [本机验收与证据版本](evidence/20261113-release-candidate/review.md) · [仓库提交清单](submission-checklist.md)

本机隔离检出通过冻结安装、固定资源校验及两套生产构建。每套 29 个产物均与区间修复后的验收归档字节一致，沿用本机 Pages 12/12 和真人 Qwen 独立质量查询 1/1。Pages 工作流在 Ubuntu 安装冻结依赖、校验资源、执行工程检查和 `/cnzjz/` 浏览器回归，合格的 main 构建上传 `dist/` 供部署。Checks 在 Windows 和 Ubuntu 独立运行。[Pages 工作流](../.github/workflows/pages.yml) · [Checks 工作流](../.github/workflows/check.yml) · [公开目标](https://gollet488.github.io/cnzjz/)

## 安装与运行

使用 Node 24.22.1 和 pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

用 `pnpm dev` 启动开发服务，或构建后用 `pnpm preview` 启动生产预览。Windows 可双击“启动Demo.cmd”和“停止Demo.cmd”，生产启动使用 `node scripts/start-demo.mjs --production`。启停脚本核对项目进程身份和监听端口。

本机有固定资源时可运行 `pnpm check:assets` 校验；缺少模型时，`pnpm prepare:assets` 会从固定官方地址下载并核对哈希。浏览器测试使用 Playwright Chromium 或本机 Chrome，Pages 检查使用 Chrome。根路径和 Pages 的复跑命令见候选证据索引。

静态 Pages 支持浏览器内的视频分析、图表、双视频对比和 CSV/PNG 导出。对比由用户为每路选择起点，在重叠区间按约 10 Hz 采样，以两路可信关节的二维投影角度计算差值，可回看两路各自的源时间。摄像头需要安全上下文及授权。Ollama 需要本机服务允许页面来源且可被浏览器访问。官方云端 API 通过本机 Vite 开发或生产预览内的 Node 代理访问，可使用页面临时 Key 或本机 `.env`。[环境配置](environment.md) · [模型连接指南](agent-model-selection.md#快速连接)

## 核对候选与发布条件

```powershell
git status --short --branch
git rev-parse HEAD
git diff --stat
git diff --check
git ls-files --others --exclude-standard
pnpm verify:delivery --manifest docs/evidence/20261113-release-candidate/manifest.json
```

清单校验读取原始工作树字节，`.gitattributes` 固定候选文件的检出换行。发布者应按清单审阅改动和新增文件，从当前仓库交付并保留 Git 历史。如修改清单涵盖的文件，完成编辑后用 `create:delivery` 选择新输出名，再校验和对照文件范围。源视频、完整审计、真人下载、私人路径与密钥留在本机。[复核命令、首错与文件范围](evidence/20261113-release-candidate/review.md)

确定候选提交后，从干净检出验证安装与访问权限，核对同一提交的 Checks、Pages 构建和部署，随后打开实际公开 HTTPS 页面核验入口及资源、视频推理、图表与片段、CSV/PNG 和所需的设备权限。原生文件选择器与落盘需交互核验，实体摄像头需可用且已获授权的设备，人体精度需独立同帧参考和不确定度。

## 历史记录

- 2026-11-05 HTTPS 候选 `36f75ea` 有独立的 Checks、Pages 构建和本机 HTTPS、真实摄像头及 DeepSeek 多轮交付记录。原始材料位于本机 `.qa/core-work/20261105-https-release/`。[历史提交](https://github.com/Gollet488/cnzjz/commit/36f75ea3e5407e30944795c37ed163de9cf6907d) · [历史 Checks](https://github.com/Gollet488/cnzjz/actions/runs/42028811793) · [历史 Pages](https://github.com/Gollet488/cnzjz/actions/runs/42028811980)
- 2026-10-30 的本机 346 项单测、36 项浏览器回归及 2 项素材缺失跳过，以及随后提交清单的 348 项单测和 62 项浏览器回归，均为当时版本的记录。旧手工上传说明和日志可查 Git 历史与本机 `.qa/github-handoff-20261030/`。旧 `.delivery/` 为 10 月的上传副本。
- 更早的测试配置、模型结果和限制见 [2026-10-29 项目评估](project-assessment.md)。当前工作安排见 [核心功能统一执行计划](core-execution-plan.md)。
