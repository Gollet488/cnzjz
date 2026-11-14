# 构建与交付

## 当前交付

已核验发布版本、远程作业、产物一致性、后续修复与待验条件统一见 [当前交付状态](delivery-status.md)。交付材料见 [仓库提交清单](submission-checklist.md)。

Pages 工作流在 Ubuntu 安装冻结依赖、校验资源、执行工程检查和 `/cnzjz/` 浏览器回归，合格的 main 构建上传 `dist/` 供部署。Checks 在 Windows 和 Ubuntu 独立运行。[Pages 工作流](../.github/workflows/pages.yml) · [Checks 工作流](../.github/workflows/check.yml)

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
```

清单校验读取原始工作树字节，`.gitattributes` 固定历史清单文件的检出换行。`20261113-release-candidate/manifest.json` 在已发布 SHA 的干净检出校验。后续发布如需清单，用 `create:delivery` 选择新输出名，再用 `verify:delivery --manifest <路径>` 校验并核对文件范围。源视频、完整审计、真人下载、私人路径与密钥留在本机。[历史复核命令、首错与文件范围](evidence/20261113-release-candidate/review.md)

发布新版本时，从干净检出验证安装与访问权限，核对同一提交的 Checks、Pages 构建和部署，并在公开 HTTPS 核验入口、资源及受改动影响的流程。设备、原生保存和人体精度按 [当前交付状态](delivery-status.md) 中的条件验收。

## 公网部署云端 Agent

GitHub Pages 发布静态版。要让访客在公网使用自己的官方 API Key，可在有域名的服务器上部署同源 HTTPS 版。以下配置使用 Node 24.22.1 和 Caddy，域名的 DNS 指向服务器，开放 80 和 443。Caddy 自动申请和续期证书，必须能读取构建后的 `dist` 目录。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

1. 从仓库检出待发布版本，执行 `pnpm install --frozen-lockfile`、`pnpm prepare:assets`、`pnpm build`，得到根路径的 `dist`。
2. 从项目根目录启动 `AGENT_PUBLIC_ORIGIN=https://pose.example.com pnpm start:agent`，将它交由服务器的进程管理器常驻。接口默认只监听 `127.0.0.1:8787`。视部署地区需要，在启动环境中设置 `ZHIPU_ENDPOINT` 或 `MOONSHOT_ENDPOINT` 选择对应官方端点。[端点列表](agent-model-selection.md)
3. 将 `deploy/Caddyfile` 安装为 Caddy 的站点配置，在 Caddy 的进程环境中设置 `POSE_DOMAIN=pose.example.com`、`POSE_DIST=/srv/cnzjz/dist`，再启动或重载 Caddy。站点直接接受公网流量时，Caddy 会覆盖客户端 IP 和协议头后将 `/__models/*` 转给本机接口。使用其他反向代理时也需保留原 Host、覆盖 `X-Real-IP`、设置 `X-Forwarded-Proto: https`，并确保 Node 端口只对本机代理开放。
4. 从 `https://pose.example.com` 打开「AI Agent 分析」，选择拥有调用权限的供应商模型，填入官方 Key 并测试。再用合成演示数据确认任务能完成、图表和 CSV 能保存。

公网代理仅使用随请求传入的访客 Key，所有推理计入访客的供应商账户。代理只连接固定的官方 HTTPS 端点，拒绝跨站调用，并限制请求体、并发和单 IP 请求频率。本站处理 Key、任务指令和必要工具反馈，代理代码不记录请求内容，不将 Key 写入磁盘。多轮工具调用所需的部分供应商上下文短暂保存在 Node 内存，运维反向代理与监控时应避免采集请求体和密钥。原始视频、原始关键点、数值计算和下载留在用户的浏览器内。

## 历史记录

- 2026-11-05 HTTPS 候选 `36f75ea` 有独立的 Checks、Pages 构建和本机 HTTPS、真实摄像头及 DeepSeek 多轮交付记录。原始材料位于本机 `.qa/core-work/20261105-https-release/`。[历史提交](https://github.com/Gollet488/cnzjz/commit/36f75ea3e5407e30944795c37ed163de9cf6907d) · [历史 Checks](https://github.com/Gollet488/cnzjz/actions/runs/42028811793) · [历史 Pages](https://github.com/Gollet488/cnzjz/actions/runs/42028811980)
- 2026-10-30 的本机 346 项单测、36 项浏览器回归及 2 项素材缺失跳过，以及随后提交清单的 348 项单测和 62 项浏览器回归，均为当时版本的记录。旧手工上传说明和日志可查 Git 历史与本机 `.qa/github-handoff-20261030/`。旧 `.delivery/` 为 10 月的上传副本。
- 更早的测试配置、模型结果和限制见 [2026-10-29 项目评估](project-assessment.md)。当前工作安排见 [核心功能统一执行计划](core-execution-plan.md)。
