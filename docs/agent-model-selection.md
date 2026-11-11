# Agent 模型配置与验收

在「AI Agent 分析」输入任务，在「模型」中明确选择一个模型，然后点击「发送」。下次打开同一浏览器来源时会恢复选择。模型失效时可刷新、重新选择，或前往「采集与分析」手动操作。运行中可以更改下一次发送使用的模型或取消当前任务。

## 本机配置

本地 Ollama 默认使用 `http://127.0.0.1:11434`，模型来自 `ollama list` 对应的安装清单。在模型设置中可改用其他回环端口。若读取失败，运行 `ollama serve`，确认端口和浏览器本地网络权限，并在 Ollama 的 `OLLAMA_ORIGINS` 中允许实际页面来源。页面使用 Ollama 的 JSON Schema 结构化输出，并依次开放会话读取、任务声明、任务工具和证据提交。首次规格使用动作列表声明图表、报告和 CSV 等交付要求，仍经过本地任务和证据校验。[Ollama 结构化输出](https://docs.ollama.com/capabilities/structured-outputs)

云端将 `.env.example` 复制为项目根目录的 `.env`，为需要启用的供应商填写 API Key 和账户可用的工具模型 ID。多个 ID 用逗号分隔。服务启动时 Node 读取配置，进程环境变量优先。编辑后重启 `pnpm dev` 或 `pnpm preview`，点击模型设置里的「刷新模型列表」。

| 供应商 | 密钥和模型列表 | 默认官方接口 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODELS`（默认 `deepseek-flash`） | `https://api.deepseek.com/chat/completions` |
| OpenAI GPT | `OPENAI_API_KEY`、`OPENAI_MODELS` | `https://api.openai.com/v1/responses` |
| Anthropic Claude | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODELS` | `https://api.anthropic.com/v1/messages` |
| 智谱 GLM | `ZHIPU_API_KEY`、`ZHIPU_MODELS` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| Moonshot Kimi | `MOONSHOT_API_KEY`、`MOONSHOT_MODELS` | `https://api.moonshot.cn/v1/chat/completions` |

`*_ENDPOINT` 仅接受对应供应商的官方端点。国际版智谱和 Moonshot 分别可设 `ZHIPU_ENDPOINT=https://api.z.ai/api/paas/v4/chat/completions` 和 `MOONSHOT_ENDPOINT=https://api.moonshot.ai/v1/chat/completions`。Claude 使用工具块，OpenAI 使用 `store: false`，加密推理上下文在本机 Node 内为当前任务保留，任务结束后释放。DeepSeek、GLM 和 Kimi 使用非思考工具调用，需选择支持此模式的模型。[OpenAI Responses](https://developers.openai.com/api/docs/guides/reasoning) · [Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) · [DeepSeek](https://api-docs.deepseek.com/guides/tool_calls/) · [Z.AI](https://docs.z.ai/api-reference/llm/chat-completion) · [Kimi](https://platform.kimi.ai/docs/api/chat)

智谱可填账户已启用的 `glm-5.2`，Kimi 可填 `kimi-k2.6`。两者的官方接口均允许关闭思考。强制开启思考的 GLM-5.3 和 Kimi K3 系列需要额外的推理上下文适配。[GLM Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion) · [Kimi Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models)

「可发送」表示配置齐备。应用读取配置和模型清单时不会执行推理。「测试连接」发送一条结构化工具探测，云端可能计费。正常发送直接使用业务请求。视频、原始关键点、数值计算、证据校验、图表和导出留在本机。云端只收到任务指令和有界反馈。模型选择功能只持久化非敏感偏好，API Key 由 Node 读取。现有任务审计继续保存在本机浏览器。

## 本轮生产验收

浏览器脚本回归覆盖 Ollama 和 DeepSeek 一次发送、多轮修改、ROM 回放校验、图表、报告/CSV、切换后历史模型标签、缺配置指引、主动探测、连接失败保留输入、重复提交、取消、恢复选择和手动分析入口。脚本化 HTTP 仅验证协议和页面行为。

| 模型或配置 | 协议回归 | 真实业务 |
| --- | --- | --- |
| Ollama `qwen2.5:7b-instruct` | JSON Schema 调用、任务补丁和证据回归通过 | 2026-11-11 生产页面通过真实连接探测、双膝 ROM 比较、右膝改区间追问和简洁指令的报告/CSV 交付，三轮数值、视图和文件均经独立校验。长指令的第三轮仍会将导出范围解释为比较后段 |
| Ollama `llama3_1:8b-q4km-openai-eval` | 使用相同 Ollama 通道 | 原生工具协议下的基线业务未通过，本轮生产验收使用 Qwen |
| DeepSeek `deepseek-flash` | Chat Completions 与生产页面回归通过 | 2026-11-11 生产页面真实 API 通过一个三轮会话，完成 ROM 比较、追问改区间、图表和报告/CSV 保存，数值与 CSV 经独立复核 |
| OpenAI GPT（由 `OPENAI_MODELS` 指定） | Responses 加密上下文、原生调用 ID 和任务释放 | 按本轮范围使用协议测试 |
| Anthropic Claude（由 `ANTHROPIC_MODELS` 指定） | Messages 工具块及结果回传 | 按本轮范围使用协议测试 |
| 智谱 GLM（由 `ZHIPU_MODELS` 指定） | Chat Completions 工具参数及结果回传 | 按本轮范围使用协议测试 |
| Moonshot Kimi（由 `MOONSHOT_MODELS` 指定） | Chat Completions 工具调用及结果回传 | 按本轮范围使用协议测试 |

```powershell
node --test tests/cloudModels.test.ts tests/deepseek.test.ts tests/deepseekProxy.test.ts tests/agent.test.ts
$env:BROWSER_CHANNEL='chrome'
pnpm exec playwright test --project production --grep 'scripted protocol only|scripted DeepSeek cancel|Agent model setup'
```

本机真模型比较、追问、报告与 CSV，测试自动启动生产构建。

```powershell
$env:BROWSER_CHANNEL='chrome'
$env:REAL_AGENT_PROVIDER='ollama'
$env:OLLAMA_MODEL='qwen2.5:7b-instruct'
pnpm test:browser:real
# 单独复测简洁的第三轮交付指令。报告、CSV 和数值校验保持相同。
$env:REAL_AGENT_FLOW='concise_delivery'
pnpm test:browser:real
```

以下命令使用配置的 DeepSeek 凭据运行真实 API 三轮验收。每个任务最多 12 次模型请求。

```powershell
$env:BROWSER_CHANNEL='chrome'
$env:REAL_AGENT_PROVIDER='deepseek'
$env:REAL_AGENT_MODEL='deepseek-flash'
$env:REAL_AGENT_FLOW='multi_turn_delivery'
$env:REAL_AGENT_SESSIONS='1'
pnpm test:browser:real
```

真实回归将生产页面结果、审计和数值复算记录写入 `test-results/real-*`。浏览器测试需要空闲端口 5186/5187，Ollama 需要允许 `http://127.0.0.1:5187`。

2026-11-11 的记录位于 `test-results/real-deepseek-agent-20261111`、`test-results/real-ollama-concise-20261111` 和 `test-results/real-ollama-linked-20261111`。Ollama 简洁指令为「沿用上一轮比较和图表。准备报告，并准备 0–17 秒 CSV。」两种措辞的业务验收标准相同。
