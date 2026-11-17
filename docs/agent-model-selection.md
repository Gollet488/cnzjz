# Agent 模型配置与验收

在「AI Agent 分析」输入任务，在「模型」中明确选择一个模型，然后点击「发送」。下次打开同一浏览器来源时会恢复选择。模型失效时可刷新、重新选择，或前往「采集与分析」手动操作。运行中可以更改下一次发送使用的模型或取消当前任务。

## 快速连接

1. **打开已配置云端 Agent 的站点。** 使用自托管 HTTPS 地址，或在项目目录运行 `pnpm dev` 并打开终端显示的本机地址。GitHub Pages 支持基础姿态分析和允许该页面来源的本地模型服务。[公网自托管步骤](delivery.md#公网部署云端-agent)
2. **选择模型并配置 Key。** 在「AI Agent 分析」选择对应供应商的模型。已在本机服务中配置 Key 和模型时，可以直接测试。也可以从「首次连接？查看连接指南」里的官方控制台创建 API Key，并填入页面的「临时 API Key」。需要自定义模型时，在「模型设置」选择供应商，输入官方模型 ID，再点「选择此模型」。
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

1. 在项目目录运行 `pnpm dev`，打开终端显示的地址，再进入「AI Agent 分析」。已启动的本机服务会自动出现在模型列表中。启动服务或加载模型后，可在「模型设置」点击「刷新模型列表」。
2. 在主菜单选择「本地模型 · 检测与选择」，再从「检测到的本地模型」里选择。模型名称显示在主菜单旁。之后点击「模型设置」即可换本地模型。每个地址会先检查 Ollama 原生接口，随后按需检查 OpenAI 兼容接口，并根据服务返回的元数据标注部署类型。自动检测使用 `127.0.0.1`，需要时尝试 `localhost` 和 `[::1]`。
3. 点击「测试连接」。应用会用任务实际使用的接口发起推理，并校验 `connection_check` 及其参数。通过后显示「已连接」。

Ollama 的清单来自浏览器所在设备的服务。`/api/tags` 返回可用的模型，`/api/ps` 返回检测时已载入内存的模型，后者在列表中标记「已载入 Ollama」。实际用于本项目的模型由用户选择，选择按浏览器来源保存。其他客户端的模型选择不在这两个接口的返回范围内。[Ollama 模型清单](https://docs.ollama.com/api/tags) · [Ollama 已载入模型](https://docs.ollama.com/api/ps)

| 本地部署 | 常用端口 | 使用条件 |
| --- | --- | --- |
| Ollama | `11434` | 已启动 Ollama，已安装声明 `tools` 能力的模型。使用原生 API 和 JSON Schema 结构化输出。[Ollama 文档](https://docs.ollama.com/capabilities/structured-outputs) |
| LM Studio | `1234` | 在 Developer 中启动 API 服务，载入支持工具调用的模型或启用即时加载。[LM Studio 文档](https://lmstudio.ai/docs/developer/openai-compat/tools) |
| llama.cpp | `8080` | 启动 `llama-server` 并使用支持工具调用的模型及聊天模板。[llama.cpp 服务文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#tool-call-support) |
| vLLM | `8000` | 启动兼容 API 服务，为模型配置自动工具选择和对应的工具解析器。[vLLM 服务文档](https://docs.vllm.ai/en/latest/features/tool_calling/) |

自定义端口、Docker 或 WSL 部署可将 API 映射到浏览器所在设备的回环端口。打开「模型设置 → 本地模型」，填入实际地址并点击「应用地址」。根地址和带 `/v1` 的地址均可填写。兼容服务要求 Bearer 令牌时，在「本地服务令牌」中填写并应用地址。令牌仅保留在当前页面。支持兼容聊天接口但未提供模型清单时，可手动填写模型 ID，选择后测试连接。

通过 `pnpm dev` 或 `pnpm preview` 在本机运行时，模型清单若被浏览器拦截，可通过同源本机代理读取。Ollama 和兼容服务的推理请求优先走该代理。使用 GitHub Pages 或 HTTPS 自托管网页时，请允许浏览器访问本地网络，并在本地服务的 CORS 配置中允许网页的实际来源。Ollama 对应的环境变量为 `OLLAMA_ORIGINS`。[Ollama 本机配置](https://docs.ollama.com/faq)

本机版可以在启动 Node 的环境中设置供应商的 `*_API_KEY`，或在项目根目录的 `.env` 中配置。Windows 用户环境变量中的 Key 也可读取。优先级为进程环境变量、项目 `.env`、Windows 用户环境变量。使用 Windows 用户环境变量时，项目 `.env` 中的同名空值也会覆盖它，可删掉对应空行。编辑后重启 `pnpm dev` 或 `pnpm preview`，再刷新模型列表。

服务端 Key 配置好后，可直接选模型、测试并发送。`*_MODELS` 可指定账户可用的工具模型 ID，多个 ID 用逗号分隔，留空使用首个预设。页面临时 Key 优先用于该次连接。公网版使用访客在页面填写的官方 Key。

| 供应商 | 密钥和模型列表 | 默认官方接口 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODELS`（默认 `deepseek-flash`） | `https://api.deepseek.com/chat/completions` |
| OpenAI GPT | `OPENAI_API_KEY`、`OPENAI_MODELS` | `https://api.openai.com/v1/responses` |
| Anthropic Claude | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODELS` | `https://api.anthropic.com/v1/messages` |
| 智谱 GLM | `ZHIPU_API_KEY`、`ZHIPU_MODELS` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| Moonshot Kimi | `MOONSHOT_API_KEY`、`MOONSHOT_MODELS` | `https://api.moonshot.cn/v1/chat/completions` |

`*_ENDPOINT` 仅接受对应供应商的官方端点。国际版智谱和 Moonshot 分别可设 `ZHIPU_ENDPOINT=https://api.z.ai/api/paas/v4/chat/completions` 和 `MOONSHOT_ENDPOINT=https://api.moonshot.ai/v1/chat/completions`。Claude 使用工具块，OpenAI 使用 `store: false`。OpenAI 加密推理上下文与 GLM 5.3、Kimi K3 系列的思考上下文由本机 Node 代理在同一任务内回传给对应供应商，任务结束后释放。DeepSeek、GLM 5.2 和 Kimi K2.6 使用非思考工具调用。[OpenAI Responses](https://developers.openai.com/api/docs/guides/reasoning) · [Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) · [DeepSeek](https://api-docs.deepseek.com/guides/tool_calls/) · [Z.AI](https://docs.z.ai/api-reference/llm/chat-completion) · [Kimi](https://platform.kimi.ai/docs/guide/use-thinking-models)

云端模型的「可发送」表示配置齐备。「已连接」表示测试或任务已收到结构化工具调用。读取配置和模型清单时不会执行推理。「测试连接」会调用所选模型，云端可能计费。供应商明确返回短期限流或过载时，代理在等待后最多补试一次。视频、原始关键点、数值计算、证据校验、图表和导出留在本机。任务指令和有界反馈经当前站点代理发送至供应商官方 API，临时 Key 同样经过该代理。浏览器持久化模型选择和本机任务审计，临时 Key 只保留在页面内存。

## 本轮生产验收

### 2026-11-17 云端模型复验

DeepSeek `deepseek-flash` 在 Chrome 生产预览中使用合成演示数据完成了 ROM 比较、追问修改区间、图表及报告与 CSV 下载。关闭服务端 Key 后，页面临时 Key 也通过了真实结构化工具调用。清除临时 Key 后，发送按钮恢复为不可用。OpenAI、Anthropic、智谱和 Moonshot 的适配器通过了协议回归，真实推理需要相应供应商的官方 API Key。

### 2026-11-17 本地模型验证

在 Chrome 的生产预览页发现了本机 Ollama、LM Studio 和 llama.cpp，三项均通过真实结构化工具调用。Ollama 的 `qwen2.5:7b-instruct` 还完成了内置演示的整段右膝角度指标查询，页面展示了采样范围和数值引用。同一模型有一次将指定的 0–5 秒理解为整段，区间以结果面板中显示的工具参数和采样范围为准。vLLM 的服务识别已由浏览器回归覆盖，本次环境未启动该服务。浏览器实连记录保存在 `.qa/local-agent-20261117/browser-real.json`。

### 2026-11-14 Windows 实连补验

在 Chrome `157.0.8103.51` 打开本机生产预览，从应用的模型选择和「测试连接」入口发送真实结构化探测。三项各发起一次成功探测并收到 HTTP 200。LM Studio 与 llama.cpp 通过本机同源代理返回 `connection_check`，参数为 `{"echo":"kinetic"}`。本轮核验范围为模型发现和连接探测。

| 供应商 | 实测结果 |
| --- | --- |
| llama.cpp | Windows build `10642`，回环端口 `8080`，复用本机 Qwen 2.5 7B GGUF，启用 Jinja 工具模板后通过。 |
| LM Studio | 官方无界面服务 `llmster 0.0.27+1`，回环端口 `1234`，同一 GGUF 在 `llama.cpp-win-x86_64-avx2@2.66.0`、2048 上下文下通过。此前选择 NVIDIA 运行时时探测超时。 |
| DeepSeek | 既有密钥配置下，官方 API 的 `deepseek-flash` 通过。 |
| vLLM | 本机没有 WSL Linux 发行版，WSL2 状态报告虚拟化未启用。Windows 社区构建已校验下载，所需 CUDA 版 PyTorch 下载反复中断，服务未启动。[官方平台要求](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/#requirements) |
| OpenAI、Anthropic、智谱、Moonshot | 生产预览的供应商目录报告缺少各自的 API Key，未发送真实推理请求。 |

本机证据位于 `.qa/windows-real-20261114/`，其中包含三个成功探测的 `*-probe.json`、LM Studio 超时记录及 `cloud-catalog.json`。

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
