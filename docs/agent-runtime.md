# Agent 执行循环

执行入口为 `src/agent/runtime.ts`，供应商接口位于 `src/agent/provider.ts`。页面可直连本机 Ollama，或通过本机或公网 HTTPS 的同源代理调用 DeepSeek、OpenAI、Claude、智谱和 Kimi。各模型共用同一个执行器和本地工具注册表。[模型配置与验收](agent-model-selection.md)

模型根据用户目标选择结构化工具；本地执行器负责参数校验、工具执行、证据映射、完成检查和审计。自由文本与模型内部思考不会直接作为已验证分析呈现。

默认每轮限制：12 个模型轮次、24 次工具调用、3 次错误恢复、240 秒总超时、60 秒单请求超时。错误、取消、超时和引用失效均有独立状态。

DeepSeek 页面总超时为 120 秒，最多 12 次模型请求、24 次工具调用和 3 次恢复。页面通过 `/__models/catalog` 读取已配置模型，并用同源 `/__models/probe` 或 `/__models/complete` 发起请求。代理嵌入 Vite 开发及生产预览进程，校验 socket 回环、本机精确 Host、相同 Origin 和 Sec-Fetch-Site。模型和官方端点由 Node 配置，请求体上限 256000 字节，单请求上限 60 秒，供应商响应上限 1 MB。浏览器断开、取消和服务关闭时中止上游。供应商错误以固定代码返回，代理不记录请求内容。既有 `/__deepseek/*` 路由保留兼容原 DeepSeek 客户端。

本机可用 `pnpm dev` 或构建后用 `pnpm preview`，通过 Ctrl+C 结束。项目也提供 `node scripts/start-demo.mjs --no-open`、生产预览及 `node scripts/stop-demo.mjs`。云端代理需要回环 Node 服务。页面临时 Key 随业务或探测请求发给本机代理，代理仅使用对应的官方端点。服务配置优先读取进程环境，其次读取项目根目录的 `.env`，DeepSeek 在 Windows 上还可读取用户级环境变量。逐次供应商实际返回的模型标识及指纹进入本地审计，缺失指纹记为 null。

公网模式由 `pnpm start:agent` 启动，提供 `/__models/*`，要求 HTTPS 站点的精确 Host、Origin 和本机反代转发头。模型请求逐次要求访客 Key，代理按来源 IP 和活动请求数限制流量。[公网部署](delivery.md#公网部署云端-agent)

完成分析需要匹配当前任务的真实工具结果。比较、最终视图、报告和导出分别核验。UI 应用和审计失败不能被模型的一次 completed 声明掩盖。

Ollama 连接测试检查本地模型的 tools 能力，再发起结构化探测。CLI 评测和页面使用 Ollama 的 JSON Schema 模式约束工具调用，按会话读取、规格声明、业务执行和结果提交开放工具。模型声明的动作与变更被转换为原有任务规格和补丁。「比较前后各 N 秒」这类明确表述约束两段分别锚定采样起点和终点。模型用 `view: "comparison"` 绑定图表时，追问中的比较范围和侧别变更会同步到该图表。追问明确请求绝对区间的 CSV 时，补丁要求模型单独填写该范围。最终提交按工具选本轮真实证据，交由同一完成检查校验。原始媒体在浏览器本地处理。

Node 对照评测使用 `node scripts/evaluate-agent.mjs --provider deepseek --model deepseek-flash --case compare --repeat 1 --max-business-requests 12 --max-business-ms 120000 --output .qa/core-work/<唯一目录>/compare.json`；quality 必须另开一次独立评测。凭据仅从该 Node 进程的 `DEEPSEEK_API_KEY` 环境变量读取，不支持密钥命令行参数，不进入配置/正文/审计，不导入页面。地址固定为 `https://api.deepseek.com`；现有 run-agent-screen.mjs 原始记录器仍仅支持 Ollama，并在 IO 前拒绝其他 provider。

DeepSeek provider 只翻译原生工具格式：assistant 的 JSON 参数串与匹配的 tool_call_id 成对重建，不补业务值或工具结果。实际请求固定 `thinking={type:"disabled"}`、temperature=0、max_tokens=2048、stream=false、tool_choice=auto，不使用强制 JSON/strict 解码，不增加恢复预算或自动重试。禁用思考使其与现有无思考协议直接兼容；不能将此配置的结论外推到思考模式。每次响应的 model/system_fingerprint/id/finish_reason 进入 reply 审计；指纹未提供时为 null，不伪装已锁定服务端权重。注入 HTTP 或 provider 的回归明确记为 scripted-protocol-only。

官方说明 `deepseek-flash` 当前对应 DeepSeek-V4.1-Flash-1017，调用格式见 [首次调用](https://api-docs.deepseek.com/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/) 和 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。该别名由服务端维护，评测时须核对返回标识/指纹；接入、连通或脚本通过均不等于真实业务完成。

真实页面单轮入口为 `tests/browser/deepseek-page.real.spec.ts`，用现有 `playwright.real.config.ts` 运行：在真实用户环境设置 `BROWSER_CHANNEL=chrome`、`REAL_AGENT_PROVIDER=deepseek` 和全新 `BROWSER_REAL_OUTPUT=.qa/core-work/<唯一标识>/page-acceptance` 后执行 `pnpm test:browser:real`。它使用产品自带合成演示，先独立比较/质量各一次，两类首轮均通过才按相同配置各累计 3/3；每次最多 12 业务请求/120 秒，探测单列，全部失败和超时保留，不重试。通过页面控制和审计导出核验真实图表、当轮引用/冻结来源、采样数/单位/限制及重算失效；先由 QA 手动导出的材料快照仅用于独立复算，不代表模型要求 CSV。该入口不执行真实多轮或报告/CSV，也不代表人体输入或原生文件选择器验收。独立 Node 基线和页面材料不得混用数值；清理 CSV 前须核对保留的原始点 gzip 可重新复算。

三轮成果评测复用同一 Node 入口：选择 `--case multi_turn_delivery --repeat 1 --max-business-requests 36 --max-business-ms 360000`，每个目标仍限 12 请求/120 秒，三次目标共享 runtime/TaskContext/素材；首个目标失败立即停止，不自动重跑。依次比较双膝 [0,5]/[15,20]、仅右膝改后段 [12,17]、最后才准备右膝比较报告与 [0,17] CSV；保持实际 [0,17] filtered 视图。Node 只验证句柄和 headless 应用，不代表文件已保存。

生产 Chrome 三轮入口在上述页面环境变量之外设置 `REAL_AGENT_FLOW=multi_turn_delivery`，运行 `tests/browser/deepseek-multiturn.real.spec.ts`。每次独立浏览器上下文内连续执行三个目标；默认计划三个会话，可用 `REAL_AGENT_SESSIONS=1..3` 限定本次独立会话数，失败即停，不替换或抹去旧失败。首个完整会话及文件核验通过才累计。逐轮审计与原始点 gzip 保留，先由 QA 导出材料，再连接真实 API；工具结果由下载的实际原始点独立重放。最后通过页面保存报告 JSON/CSV，并独立核对侧别、两段 ROM/有效样本/单位/冻结版本及 CSV 全行与 [0,17] 范围；检查准备阶段没有自动下载、保存后仍保持最终视图、重算后保存入口禁用。明确只验 Blob 下载，原生选择器与人体输入另行实测。相同配置是否通过以统一计划和实际审计为准。

相关说明：[模型协议](model-protocol-v3.md)、[任务规格](task-spec.md)、[上下文](task-context.md)。当前验收状态见 [统一执行计划](core-execution-plan.md)。
