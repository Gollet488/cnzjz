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

Ollama 是可选的本机服务，不属于 pnpm 依赖。自行准备已安装且支持 tools 的本地模型，在 Agent 页填写本机根地址（默认 `http://127.0.0.1:11434`）、选择模型并“验证并连接”。模型下载由用户自行完成，本项目不会自动下载。

若浏览器提示跨域错误，需在 Ollama 服务的启动环境设置 `OLLAMA_ORIGINS` 为页面实际来源，例如 `http://127.0.0.1:5173`，重启 Ollama 后重试。地址中的 localhost / 127.0.0.1、协议和端口应与页面来源一致。`OLLAMA_ORIGINS` 由 Ollama 进程读取，写入本项目 `.env` 不会替外部服务配置它。

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
