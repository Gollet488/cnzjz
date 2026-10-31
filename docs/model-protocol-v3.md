# 模型适配协议

实现：`src/agent/modelProtocol.ts`。当前版本 3.10.0，指令版本 core-protocol-missing-boundary。

请求提供当前会话、当前用户来源、可继承任务、绑定标识和受状态约束的工具。模型必须自行声明目标参数与来源，本地适配器不按运动关键词代填业务意图。

- set_task_spec：首次声明完整任务及来源。同源时可提交一项 `{field:"task",origin:"derived",sourceId}`，适配器只将该来源展开为全部顶层业务字段（包括空值与 report=false），不补业务值；有推导选 derived。混合来源仍用互不重叠的原有字段，不可与 task 同时提交。展开后仍通过完整 TaskSpec、历史同值继承与来源校验。不相关字段仍显式声明 null/空数组，未要求报告声明 false，未要求 CSV 声明 null。首次只有当前用户来源时，origin 枚举仅允许 explicit/derived，采样范围不是历史用户意图。
- 模型侧 goalTypes 是三个必填布尔值 `{metrics,comparison,quality}`：分别选择独立单段统计、两段指标差值分析、数据质量/缺失/限制。仅比较 ROM 时不另外选择 metrics；用户确实要求混合分析时可多选。无分析仅定位/交付时三个值全部 false；定位由 time 独立声明，交付由 deliveries 独立声明。首次声明及 patch 的 goalTypes 都要求此对象，不接受旧数组、遗漏项、字符串布尔值或交付字段。适配器仅将显式 true 按 metrics/comparison/quality 顺序展开到底层分析数组；acceptedTask 和 previousTask 向模型投影同一布尔接口。底层 TaskSpec、控制协议、真实结果及审计保留数组，原始 modelArguments 保留模型布尔对象；来源字段仍为 goalTypes，不新增叶字段别名。只有分析/定位/交付全部为空才缺少目标；适配器不从用户文字推导选择，不补业务值、目标或来源。
- set_task_patch：接续修改，只列改变字段，未列字段保留。非空 time 必须实际定位并引用，不能仅保存参数便宣称完成。
- 模型侧全部 interval（统计前段、comparison.second、view/export.interval）可选绝对 `[起秒,止秒]`、`"sampled"` 或 `{anchor:"start"|"end",seconds:时长}`。相对选择必须有 derived 用户来源；本地仅按本轮冻结 range 展开为全部、开头或结尾，不分析用户文字，不裁剪超长时长，不修改绝对区间。审计同时保留原始选择和展开后参数；底层 TaskSpec、页面和工具仍接收绝对秒，覆盖/版本/引用检查不变。patch 在实际字段上展开后仍通过原有合并、来源和需求保留检查。
- rangeOptions 直接列出 `sampled` 选择与冻结的绝对范围、start/end 边界及最大时长，供模型核对全部采样的含义。仅最终视图的 interval 另允许显式选择 `"comparison"`：按模型声明（patch 时含未改继承值）的 interval 与 comparison.second 精确展开为最小包络；要求两段存在、顺序有效及视图 derived 来源。统计/CSV 不接受该选择，不推导分析目标、不扩大绝对视图，不替模型决定是否选全部采样或两段包络。
- 模型规格在锁定前核对内部必要字段。missingTaskFields 中缺项必须由模型明确列入 unresolved 才能作为待澄清规格接受；否则返回 TASK_SPEC_INCOMPLETE，模型仍可重新声明。此检查不判断自然语言语义，不删除误加目标，不禁止用户确实要求的质量与角度统计混合目标。真实未知参数仍允许 null/空数组及 unresolved，不能用默认值绕过。
- 已知结构化 unresolved 路径须对应声明任务的实际必要缺项；未要求或已满足的路径返回 TASK_SPEC_UNRESOLVED_CONFLICT，接受前拒绝、保持可重新声明，不自动清除。例如仅 quality 且 comparison=null 时 comparison.second 不是缺项；确实声明 comparison 却缺后段时可用 comparison.second 解释空 comparison。父子路径只在现有字段目录内匹配，不把自由文本当字段别名；自由文本真实问题继续保留并阻止无依据完成。patch 的未改 unresolved 仍继承，随后执行同一接受检查。
- 内部协议路径（sources/unresolved、来源/任务/会话/版本/调用/证据标识、bindings/userSources/availableEvidence 及其点分或数组子路径，可带 `$.`）不属于用户业务缺参，返回 TASK_SPEC_UNRESOLVED_PROTOCOL；拒绝前不接受、锁定或自动清除，模型须重新声明。只识别明确路径，不扫描自由文本中的单词。模型侧 schema 错误保留原 kind/path/expected，但将通用“不可用则请求澄清”建议替换为按当前 schema 和已提供绑定修正调用；不补参数或引用，也不改变底层校验。真实业务未知值仍由模型显式声明 null/空数组与 unresolved。
- 模型字段 schema 直接说明范围与对象的选择条件：全部采样使用现有 sampled，比较最终视图可选现有 comparison；可空 comparison/view/export 将 null 分支置前，不增加别名或可省略字段。接受前核对非空 comparison 必须对应 goalTypes 的 comparison 或 deliveries.report=true；否则 TASK_SPEC_ANALYSIS_CONFLICT，unresolved 不能绕过。模型自行依据原文重新声明，不自动删意图或补参数。显式混合分析、比较报告及真正缺参仍受支持；此一致性检查不证明模型理解了用户，也不能发现所有内部一致但语义错误的额外交付或范围。
- 业务工具只传本轮 taskRef（schema 枚举当前标识），绑定模型已声明并接受的规格。适配器冻结会话与版本；重复传业务参数、sessionId 或 revision 一律拒绝，不静默覆盖。底层本地工具仍要求完整参数与版本。
- inspect_result：callId 枚举本轮成功调用，path 枚举真实目录与已展开子树中的路径；模型自行选择调用、路径和页。枚举为多个调用的并集，执行时仍核对该调用真实存在此路径，不重写错误路径。深层字段可从父路径逐层读取，分页 limit 1–32，重复读取不创造新事实。
- finish_analysis：选择结局代码和当前 evidenceId，仍须通过本地完成校验。请求内 availableEvidence 汇集每种工具最新成功调用的真实任务目录，模型仍须自行跨工具选择引用；该索引不自动满足目标，不补引用。旧调用完整目录仍可 inspect_result 读取。

完整工具结果留在审计，后续模型请求使用有界投影、任务证据目录和最近错误。inspectedPages 从本轮真实成功调用去重索引已读 callId/path/start/limit；不同页不合并，重复页不新增事实。每次模型请求前重新核对 completion，引用为空时已计算目标仍可缺少最终引用，不表示无需引用或自动成功。get_session_info 是结束前提，模型仍负责实际调用；未提供的工具不能被提前执行。恢复预算不变。

完全相同的工具、原始参数和错误只在模型历史投影一次，选择最近两类不同拒绝，rejection 保留每次 callId 和 attempts；错误不同或参数不同仍分别保留。原始审计与恢复计数不去重，不修改 sources。结构有效但被拒的 set_task_spec 另投影 scopeReview：实际声明的前段/后段/视图区间、是否等于全部采样、是否覆盖两段及原始 unresolved。来源拒绝不能掩盖范围问题；范围关系通过也不证明用户语义正确。不对错误区间或 unresolved 做静默修复。

plan_analysis 可选且最多四步，真实执行不受展示步骤顺序约束。

协议具有结构与来源校验，但不能证明模型的自然语言理解正确。真实模型结果见 [项目评估](project-assessment.md)。
