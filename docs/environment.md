# 环境配置

## 必需环境

| 项目 | 要求 |
| --- | --- |
| Node.js | 24.22.1（`.node-version`；`package.json` 限定在 Node 24） |
| pnpm | 11.25.0（`packageManager`） |
| 依赖 | `package.json` 与完整 `pnpm-lock.yaml`，使用冻结锁文件安装 |
| 浏览器 | 支持 WebCodecs、Worker、OffscreenCanvas 的 Chrome / Edge；本地运行使用 localhost / 127.0.0.1 |
| 摄像头 | 可选，需要浏览器权限、单人全身入镜及安全上下文 |
| 网络 | 首次安装依赖、缺失模型下载，以及用户选择 DeepSeek 时需要网络 |

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm prepare:assets
pnpm dev
```

没有 pnpm 时，可先运行 `npm install --global pnpm@11.25.0`。Vite 默认开发端口为 5173，预览端口为 4173，以终端显示地址为准。资源准备脚本会复用哈希正确的模型；可单独运行 `pnpm check:assets` 校验。基础分析和合成演示无需模型服务或密钥。

## 环境变量模板与加载

根目录 `.env.example` 只包含空值和注释，可以提交；`.env`、`.env.local` 等实际配置由 `.gitignore` 排除。

```powershell
Copy-Item .env.example .env
# 用编辑器在 .env 中填写 DEEPSEEK_API_KEY，再启动：
pnpm dev:env
```

生产预览：

```powershell
pnpm build
pnpm preview:env
```

这两个 `:env` 脚本通过 Node 的 `--env-file=.env` 明确加载文件；若文件不存在会报错。普通 `pnpm dev` / `pnpm preview`、Windows 双击脚本和测试命令不承诺将 `.env` 注入 Node 代理或测试进程。也可在当前 PowerShell 设置 `$env:DEEPSEEK_API_KEY='本机真实密钥'`，再运行普通启动命令。已存在的进程环境变量优先于 `.env`；变更后重新启动服务。

| 变量 | 必需性 / 默认 | 读取位置与用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 仅 DeepSeek 需要；默认无 | 本机 Node 代理；Windows 还支持读取用户环境变量。不要使用 `VITE_` 前缀或写入源码 |
| `BROWSER_CHANNEL` | 可选；默认 Playwright Chromium | Playwright；设为 `chrome` 使用已安装的 Chrome |
| `BROWSER_VITE_CACHE` | 可选；默认 Vite 缓存目录 | 浏览器回归的开发服务缓存；同时运行日常开发服务时可设置为 `.qa/browser-vite-cache` 隔离预打包缓存 |
| `HUMAN_VIDEO_PATH` | 可选；默认跳过真人视频用例 | 浏览器测试读取授权的本机人体视频路径；素材不提交 |
| `OLLAMA_MODEL` | 可选；真实 Ollama 回归默认选模型清单首项 | `tests/browser/real.spec.ts` 的模型选择，建议显式指定已安装且支持工具调用的模型 |
| `REAL_AGENT_PROVIDER` | 可选；默认 Ollama 真实回归 | 设为 `deepseek` 切换到真实 DeepSeek 页面回归 |
| `REAL_AGENT_FLOW` | 可选 | `multi_turn_delivery` 选择 DeepSeek 多轮交付回归 |
| `REAL_AGENT_SESSIONS` | 可选；默认 3 | DeepSeek 多轮回归的计划会话数量 |
| `BROWSER_REAL_OUTPUT` | 可选；默认 `test-results/real-时间戳` | 真实浏览器回归输出目录，建议放在已忽略的 `test-results/` 内 |

上述测试变量在运行命令的 shell 中设置；`.env.example` 中注释掉的示例不会自动生效。`KINETIC_DEMO_TOKEN` 是启停脚本生成的内部健康检查标记，不需要手动配置。历史回归证据目录及性能条件等高级参数见对应 `scripts/` 和测试入口。

## Ollama

1. 安装 [Ollama for Windows](https://docs.ollama.com/windows)。退出系统托盘中已运行的 Ollama，再从 PowerShell 启动回环服务。当前候选的 Pages 来源为 `https://gollet488.github.io`，本机生产预览来源为 `http://127.0.0.1:4173`。

   ```powershell
   $env:OLLAMA_HOST='127.0.0.1:11434'
   $env:OLLAMA_ORIGINS='https://gollet488.github.io,http://127.0.0.1:4173'
   $env:OLLAMA_NO_CLOUD='1'
   ollama serve
   ```

   将实际页面的协议、主机和端口填入 `OLLAMA_ORIGINS`，不带 `/cnzjz/` 或末尾斜线。使用开发服务时可改为 `http://127.0.0.1:5173`。变量由 Ollama 启动进程读取。每次修改后重新启动该进程。

2. 在另一终端确认已安装 Qwen2.5-7B-Instruct-1M Q4_K_M。已有匹配权重和标签 `qwen2.5:7b-instruct` 时可直接使用。首次安装时核对 GGUF 的 SHA-256，再创建本机标签。模型清单中的 tools 标记用于初筛，页面连接仍需真实结构化探测。[模型文件](https://huggingface.co/second-state/Qwen2.5-7B-Instruct-1M-GGUF/blob/main/Qwen2.5-7B-Instruct-1M-Q4_K_M.gguf)

   ```powershell
   $file = 'Qwen2.5-7B-Instruct-1M-Q4_K_M.gguf'
   $expected = '6dba997502a27b5f0c840346f45d9d62c0a04e6eb3cf72adc6c7ceb18804f380'
   if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected) {
     throw 'GGUF SHA-256 mismatch'
   }
   @"
   FROM ./$file
   TEMPLATE {{ .Prompt }}
   PARAMETER temperature 0.7
   PARAMETER num_ctx 16384
   "@ | Set-Content -Encoding utf8 Modelfile
   ollama create qwen2.5:7b-instruct -f Modelfile
   ```

   本轮连接实测使用 Ollama 0.40.13。运行 `ollama list` 可核对标签。安装约需 4.7 GB 模型文件及足够的可用内存。

3. 安装项目依赖后执行 `pnpm build` 和 `pnpm preview --port 4173 --strictPort`。从 `http://127.0.0.1:4173/` 进入「AI Agent 分析」，地址填 `http://127.0.0.1:11434`，点击「读取模型」，选中标签后点击「验证并连接」。Chrome 请求访问回环网络时选择允许。拒绝后可在地址栏的站点设置中重新允许。

4. 用合成演示验证时，先采集到足够时间再暂停分析。提交目标后核对任务规格中的关节、侧别、口径和前后段，确认实际图表与证据一致，再保存报告或 CSV。任务失败时可在该轮点「保存完整本地审计」，保留实际工具参数和拒绝原因。

2026-11-05 的本机 Chrome 生产预览中，上述固定 Qwen2.5 通过了结构化连接探测和首轮来源声明，并执行了比较和图表工具。首轮把用户给出的绝对后段当成采样末尾 5 秒，未完成引用提交。该配置的三轮报告与 CSV 交付仍待验收。

| 现象 | 检查 |
| --- | --- |
| 服务离线 | 在本机访问 `http://127.0.0.1:11434/api/tags`。若连接被拒绝，检查 Ollama 终端是否仍在运行及地址端口是否一致 |
| 页面无法读取模型，但终端可以 | 确认浏览器回环权限和启动进程中的精确 `OLLAMA_ORIGINS`，重新加载页面 |
| 模型不显示或探测失败 | 用 `ollama list` 核对标签。选择实际支持 tools 的本地模型，查看 Ollama 终端错误和内存状况 |

浏览器通过回环向 Ollama 发送指令和有界工具反馈。Chrome 的回环权限和 Ollama 的 CORS 是两道独立检查。[Chrome Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)

完整三轮任务已通过本机 Web 与 DeepSeek 的回环代理验证。按本页「环境变量模板与加载」配置自己的 `DEEPSEEK_API_KEY`，执行 `pnpm build` 与 `pnpm preview:env --port 4173 --strictPort`。从 `http://127.0.0.1:4173/` 进入「AI Agent 分析」，选择 DeepSeek 并验证连接。指令和有界工具反馈由本机代理发送到 DeepSeek 官方 API，密钥由本机 Node 进程读取。

## 验证与排错

```powershell
pnpm format:check
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

已有 Chrome 可省去 Chromium 安装，先设置 `$env:BROWSER_CHANNEL='chrome'`。测试在 5186 / 5187 端口启动隔离开发/生产服务，需要端口空闲。真实模型测试独立运行，不属于普通回归，不建议在 CI 注入真实密钥。

| 现象 | 处理 |
| --- | --- |
| 资源缺失或哈希不匹配 | 核对依赖版本，执行 `pnpm prepare:assets`；模型哈希异常时先保留检查，不直接绕过校验 |
| DeepSeek 连接失败 | 核对是否通过本项目本机服务访问、密钥是否加载及账户/网络是否可用；静态托管无代理 |
| 本地视频提示缺少 WebCodecs | 使用具备所需 API 的 Chrome / Edge，确认地址为 localhost 或 HTTPS |
| 转换失败或内存不足 | 使用更短的视频，确认文件未损坏、未加密且不超过 500 MB；转换也受设备内存影响 |
| 摄像头不可用 | 检查浏览器权限、系统摄像头权限及其他程序占用 |
| 启动脚本提示端口被占用 | 根据终端信息更换端口或自行处理占用程序；脚本不会接管其他进程 |

CI 已配置 Windows / Linux 基础检查；本机检查不能替代远程 Actions 的实际结果。
