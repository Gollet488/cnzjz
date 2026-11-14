# Agent 模型配置与验收

在「AI Agent 分析」输入任务，在「模型」中明确选择一个模型，然后点击「发送」。下次打开同一浏览器来源时会恢复选择。模型失效时可刷新、重新选择，或前往「采集与分析」手动操作。运行中可以更改下一次发送使用的模型或取消当前任务。

## 快速连接

1. **打开已配置云端 Agent 的站点。** 使用自托管 HTTPS 地址，或在项目目录运行 `pnpm dev` 并打开终端显示的本机地址。GitHub Pages 支持基础姿态分析和允许该页面来源的本机 Ollama。[公网自托管步骤](delivery.md#公网部署云端-agent)
2. **选择模型并填 Key。** 在「AI Agent 分析」选择对应供应商的模型，从「首次连接？查看连接指南」里的官方控制台创建 API Key，确认余额、API 配额和模型权限，粘贴到页面上的 Key 输入框。需要自定义模型时，在「模型设置」选择供应商，输入官方模型 ID，再点「选择此模型」。
3. **测试并发送。** 点击「测试当前模型连接」，或在「模型设置」点击「测试连接」。看到「已连接」表示模型成功返回了结构化工具调用。随后可发送分析目标。临时 Key 可用于连续追问；点击「清除 Key」、切换供应商或刷新页面会清除。清除正在使用的 Key 会取消对应请求。

| 遇到的问题 | 怎么处理 |
| --- | --- |
| 无法访问模型服务 | 打开已部署 Agent 接口的 HTTPS 地址，或从 `pnpm dev` 的终端输出打开本机版，再刷新模型列表。 |
| Key 或账户权限错误（401/403） | 检查 Key 与供应商、账户权限和地区是否匹配。 |
| 找不到模型（404） | 在供应商控制台核对模型 ID 与权限。 |
| 余额不足（402）或限流（429） | 检查供应商 API 余额、调用额度；限流时稍后再试。 |
| 供应商暂时不可用或响应超时 | 检查本机网络、稍后重试，或换用响应较快的模型。 |
| 无法通过工具测试 | 确认该模型和接口支持结构化工具调用，或换用另一个模型。 |

## 选择模型版本

2026-11-12 核对的模型预设如下。菜单显示发送时使用的官方模型 ID。结果卡同时显示供应商实际返回的模型标识，完整审计逐次记录标识和供应商提供的指纹。

| 供应商 | 预设与使用场景 |
| --- | --- |
| OpenAI | `gpt-6.1-sol` 兼顾能力与成本，`gpt-6-luna` 适合大量常规任务，`gpt-6.1-terra` 侧重速度与效率，`gpt-6-astra` 适合复杂任务。列表也提供 `gpt-5.4-mini`。[OpenAI 官方模型目录](https://developers.openai.com/api/docs/models) |
| DeepSeek | `deepseek-flash` 和 `deepseek-v4-pro` 是供应商维护的别名，当前分别指向 V4.1 Flash 和 V4 Pro 系列。[DeepSeek 官方模型目录](https://api-docs.deepseek.com/quick_start/pricing/) |
| 智谱 GLM | `glm-5.3` 使用低推理档位，`glm-5.2` 使用非思考模式。[智谱思考模式](https://docs.z.ai/guides/capabilities/thinking-mode) |
| Moonshot Kimi | `kimi-k3.1-pro` 和 `kimi-k3` 使用低推理档位，`kimi-k2.6` 使用非思考模式。[Kimi 思考模型](https://platform.kimi.ai/docs/guide/use-thinking-models) |
| Anthropic Claude | 预设为 `claude-sonnet-4-6`。Fable 5.2 等采用自适应思考及前缀绑定的版本需要适配工具清单变动。[Claude Fable 5.2 接口变化](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2) |

实际可用版本取决于 API Key 的账户权限和额度。供应商提供固定快照时，可在「模型设置」手动填写快照 ID 来固定版本。选用别名时，供应商可更新其指向。

## 本机配置

本地 Ollama 默认使用 `http://127.0.0.1:11434`，模型来自 `ollama list` 对应的安装清单。在模型设置中可改用其他回环端口。若读取失败，运行 `ollama serve`，确认端口和浏览器本地网络权限，并在 Ollama 的 `OLLAMA_ORIGINS` 中允许实际页面来源。页面使用 Ollama 的 JSON Schema 结构化输出，并依次开放会话读取、任务声明、任务工具和证据提交。首次规格使用动作列表声明图表、报告和 CSV 等交付要求，仍经过本地任务和证据校验。[Ollama 结构化输出](https://docs.ollama.com/capabilities/structured-outputs)

本机版可将 `.env.example` 复制为项目根目录的 `.env`，为长期使用的供应商填写 API Key 和账户可用的工具模型 ID。多个 ID 用逗号分隔，留空使用该供应商的首个预设。服务启动时 Node 读取配置，进程环境变量优先。编辑后重启 `pnpm dev` 或 `pnpm preview`，点击模型设置里的「刷新模型列表」。有临时 Key 时优先使用临时 Key，留空时使用所选模型已有的服务配置。公网版始终使用访客在页面填写的官方 Key。

| 供应商 | 密钥和模型列表 | 默认官方接口 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODELS`（默认 `deepseek-flash`） | `https://api.deepseek.com/chat/completions` |
| OpenAI GPT | `OPENAI_API_KEY`、`OPENAI_MODELS` | `https://api.openai.com/v1/responses` |
| Anthropic Claude | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODELS` | `https://api.anthropic.com/v1/messages` |
| 智谱 GLM | `ZHIPU_API_KEY`、`ZHIPU_MODELS` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| Moonshot Kimi | `MOONSHOT_API_KEY`、`MOONSHOT_MODELS` | `https://api.moonshot.cn/v1/chat/completions` |

`*_ENDPOINT` 仅接受对应供应商的官方端点。国际版智谱和 Moonshot 分别可设 `ZHIPU_ENDPOINT=https://api.z.ai/api/paas/v4/chat/completions` 和 `MOONSHOT_ENDPOINT=https://api.moonshot.ai/v1/chat/completions`。Claude 使用工具块，OpenAI 使用 `store: false`。OpenAI 加密推理上下文与 GLM 5.3、Kimi K3 系列的思考上下文由本机 Node 代理在同一任务内回传给对应供应商，任务结束后释放。DeepSeek、GLM 5.2 和 Kimi K2.6 使用非思考工具调用。[OpenAI Responses](https://developers.openai.com/api/docs/guides/reasoning) · [Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) · [DeepSeek](https://api-docs.deepseek.com/guides/tool_calls/) · [Z.AI](https://docs.z.ai/api-reference/llm/chat-completion) · [Kimi](https://platform.kimi.ai/docs/guide/use-thinking-models)

「可发送」表示配置齐备，「已连接」表示测试或任务已收到结构化工具调用。读取配置和模型清单时不会执行推理。「测试连接」会调用所选模型，云端可能计费。供应商明确返回短期限流或过载时，代理在等待后最多补试一次。视频、原始关键点、数值计算、证据校验、图表和导出留在本机。任务指令和有界反馈经当前站点代理发送至供应商官方 API，临时 Key 同样经过该代理。浏览器持久化模型选择和本机任务审计，临时 Key 只保留在页面内存。

## 本轮生产验收

浏览器脚本回归覆盖 Ollama 和 DeepSeek 一次发送、多轮修改、ROM 回放校验、图表、报告/CSV、切换后历史模型标签、缺配置指引、主动探测、连接失败保留输入、重复提交、取消、恢复选择和手动分析入口。脚本化 HTTP 仅验证协议和页面行为。

| 模型或配置 | 协议回归 | 真实业务 |
| --- | --- | --- |
| Ollama `qwen2.5:7b-instruct` | JSON Schema 调用、任务补丁和证据回归通过 | 2026-11-12 的生产 Chrome 用两组等价指令完成三轮验收，独立核对比较、图表、报告、CSV、引用和重算后的失效行为 |
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

Ollama 的 CLI 评测和生产页面使用同一套 JSON Schema 工具约束。CLI 用本地计算结果核验任务，生产页面还会检查用户审阅、图表渲染和实际保存。

```powershell
$env:BROWSER_CHANNEL='chrome'
$env:REAL_AGENT_PROVIDER='ollama'
$env:OLLAMA_MODEL='qwen2.5:7b-instruct'
pnpm eval:agent:real --model $env:OLLAMA_MODEL --case compare,quality,multi_turn --repeat 1
pnpm test:browser:real
# 用另一组等价指令复验三轮。
$env:REAL_AGENT_FLOW='paraphrased_delivery'
pnpm test:browser:real
```

### 真人视频生产验收

在仓库根目录的 PowerShell 中设置 `HUMAN_VIDEO_PATH`，指向本机已授权且与
`.qa/human-agent-20261113/acceptance.md` 对应的原视频。入口会校验素材指纹。准备 Chrome 和已安装的
`qwen2.5:7b-instruct`，确认本机 Ollama 在 `127.0.0.1:11434` 运行并允许来源
`http://127.0.0.1:5187`，同时留空该生产预览端口。运行标准交付和独立质量查询的命令为

```powershell
$env:REAL_AGENT_PROVIDER='ollama'; $env:REAL_AGENT_FLOW='human_acceptance'; $env:BROWSER_CHANNEL='chrome'; pnpm test:browser:real --grep ': (standard|quality)$'
```

同一入口还可用 `--grep ': paraphrase$'` 复跑同义换述，或用 `--grep ': limited$'`
复跑低覆盖率下的不可比交付。每次执行会自动构建和关闭本地生产预览，独立的 `results.json`、用例汇总、
下载、截图和完整审计写入 Git 忽略的 `.qa/human-agent/runs/<运行标识>/`。
独立质量用例问「请查询绝对区间 [35.01, 40.01] 秒内 raw 右膝角度的样本质量。」它核对实际采样、区间内总帧数、
有效与无效样本、帧覆盖率、限制及可定位的引用。缺少必要参数时沿用 Agent 的澄清流程。
报告和 CSV 的浏览器保存使用 Blob 下载。视频和本机路径留在本机，Ollama 回环连接无需 API Key。
测试结束后可清除当前 PowerShell 的 `REAL_AGENT_FLOW` 来恢复原入口。

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
