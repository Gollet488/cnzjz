# Agent 执行循环

入口：`src/agent/runtime.ts`。供应商接口位于 `src/agent/provider.ts`；页面可选择本机 Ollama 或通过同源回环代理连接 DeepSeek 官方 API，复用同一个执行器和工具注册表。

模型根据用户目标选择结构化工具；本地执行器负责参数校验、工具执行、证据映射、完成检查和审计。自由文本与模型内部思考不会直接作为已验证分析呈现。

默认每轮限制：12 个模型轮次、24 次工具调用、3 次错误恢复、240 秒总超时、60 秒单请求超时。错误、取消、超时和引用失效均有独立状态。

DeepSeek 页面总超时为 120 秒，仍最多 12 次模型请求、24 次工具调用和 3 次恢复，无自动重试。浏览器 `DeepSeekPageProvider` 仅 POST 同源 `/__deepseek/probe`（空对象）或 `/__deepseek/complete`（`{messages,tools}`）。代理内嵌于 Vite 开发/生产预览进程，不另开端口；固定调用 `https://api.deepseek.com/chat/completions` 和 `deepseek-flash`，不接受地址、模型、推理设置或凭据覆盖。校验 socket 回环、本机精确 Host、相同 Origin 和 Sec-Fetch-Site，无 CORS 开放；请求体上限 256000 字节、单请求 60 秒、响应由现有适配器限制 1 MB。浏览器断开、取消和服务关闭时中止上游；上游失败仅返回固定错误，不回传诊断正文。代理不记录请求内容。

启动开发：`node scripts/start-demo.mjs --no-open`；生产先 `pnpm build`，再 `node scripts/start-demo.mjs --production --no-open --port 5173`；二者均通过 `node scripts/stop-demo.mjs` 核对 PID/命令行后退出。也可 `pnpm dev` / `pnpm preview` 前台运行并 Ctrl+C 结束。服务只能绑定回环；将 host 改为外网地址会拒绝启动。纯静态部署没有此代理，不能直接使用 API。Node 优先读取进程环境，Windows 可回退读取真实用户环境中的 `DEEPSEEK_API_KEY`，无需重启 Codex；不把密钥放到 VITE_*、页面输入、文件或命令参数中。连接探测单列，逐次实际 model/system_fingerprint 进入本地审计和页面，缺失指纹保持 null。

完成分析需要匹配当前任务的真实工具结果；比较、最终视图、报告和导出分别核验。UI 应用和审计失败不能被模型的一次 completed 声明掩盖。

模型连接先检查 tools 能力，再执行真实结构化探测。地址限本机根地址，不接受凭据、任意路径或 cloud 模型。原始媒体在浏览器本地处理。

Node 对照评测使用 `node scripts/evaluate-agent.mjs --provider deepseek --model deepseek-flash --case compare --repeat 1 --max-business-requests 12 --max-business-ms 120000 --output .qa/core-work/<唯一目录>/compare.json`；quality 必须另开一次独立评测。凭据仅从该 Node 进程的 `DEEPSEEK_API_KEY` 环境变量读取，不支持密钥命令行参数，不进入配置/正文/审计，不导入页面。地址固定为 `https://api.deepseek.com`；现有 run-agent-screen.mjs 原始记录器仍仅支持 Ollama，并在 IO 前拒绝其他 provider。

DeepSeek provider 只翻译原生工具格式：assistant 的 JSON 参数串与匹配的 tool_call_id 成对重建，不补业务值或工具结果。实际请求固定 `thinking={type:"disabled"}`、temperature=0、max_tokens=2048、stream=false、tool_choice=auto，不使用强制 JSON/strict 解码，不增加恢复预算或自动重试。禁用思考使其与现有无思考协议直接兼容；不能将此配置的结论外推到思考模式。每次响应的 model/system_fingerprint/id/finish_reason 进入 reply 审计；指纹未提供时为 null，不伪装已锁定服务端权重。注入 HTTP 或 provider 的回归明确记为 scripted-protocol-only。

官方说明 `deepseek-flash` 当前对应 DeepSeek-V4.1-Flash-1017，调用格式见 [首次调用](https://api-docs.deepseek.com/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/) 和 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。该别名由服务端维护，评测时须核对返回标识/指纹；接入、连通或脚本通过均不等于真实业务完成。

真实页面单轮入口为 `tests/browser/deepseek-page.real.spec.ts`，用现有 `playwright.real.config.ts` 运行：在真实用户环境设置 `BROWSER_CHANNEL=chrome`、`REAL_AGENT_PROVIDER=deepseek` 和全新 `BROWSER_REAL_OUTPUT=.qa/core-work/<唯一标识>/page-acceptance` 后执行 `pnpm test:browser:real`。它使用产品自带合成演示，先独立比较/质量各一次，两类首轮均通过才按相同配置各累计 3/3；每次最多 12 业务请求/120 秒，探测单列，全部失败和超时保留，不重试。通过页面控制和审计导出核验真实图表、当轮引用/冻结来源、采样数/单位/限制及重算失效；先由 QA 手动导出的材料快照仅用于独立复算，不代表模型要求 CSV。该入口不执行真实多轮或报告/CSV，也不代表人体输入或原生文件选择器验收。独立 Node 基线和页面材料不得混用数值；清理 CSV 前须核对保留的原始点 gzip 可重新复算。

三轮成果评测复用同一 Node 入口：选择 `--case multi_turn_delivery --repeat 1 --max-business-requests 36 --max-business-ms 360000`，每个目标仍限 12 请求/120 秒，三次目标共享 runtime/TaskContext/素材；首个目标失败立即停止，不自动重跑。依次比较双膝 [0,5]/[15,20]、仅右膝改后段 [12,17]、最后才准备右膝比较报告与 [0,17] CSV；保持实际 [0,17] filtered 视图。Node 只验证句柄和 headless 应用，不代表文件已保存。

生产 Chrome 三轮入口在上述页面环境变量之外设置 `REAL_AGENT_FLOW=multi_turn_delivery`，运行 `tests/browser/deepseek-multiturn.real.spec.ts`。每次独立浏览器上下文内连续执行三个目标；默认计划三个会话，可用 `REAL_AGENT_SESSIONS=1..3` 限定本次独立会话数，失败即停，不替换或抹去旧失败。首个完整会话及文件核验通过才累计。逐轮审计与原始点 gzip 保留，先由 QA 导出材料，再连接真实 API；工具结果由下载的实际原始点独立重放。最后通过页面保存报告 JSON/CSV，并独立核对侧别、两段 ROM/有效样本/单位/冻结版本及 CSV 全行与 [0,17] 范围；检查准备阶段没有自动下载、保存后仍保持最终视图、重算后保存入口禁用。明确只验 Blob 下载，原生选择器与人体输入另行实测。相同配置是否通过以统一计划和实际审计为准。

相关说明：[模型协议](model-protocol-v3.md)、[任务规格](task-spec.md)、[上下文](task-context.md)。当前验收状态见 [统一执行计划](core-execution-plan.md)。
