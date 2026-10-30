# 任务规格

实现：`src/agent/taskSpec.ts`、`src/agent/completion.ts`。

TaskSpec 记录目标类型、关节、侧别、raw/filtered、前段、比较后段、指标、定位时刻和视图/报告/导出要求。字段来源与未解决项一并保存。

目标类型支持 metrics、comparison、quality、seek、view、report、export。比较方向为 second_minus_first。视图范围与统计范围、CSV 范围分别表达，比较视图需要覆盖两段。

来源需要可追溯到本轮用户原文或已接受的继承任务；false、空值和删除要求也不能无来源地改变。任务 ID、模型生成的解释以及会话元数据本身不代表用户意图。

缺少必要字段应请求补充。重叠或数据质量不足的区间保留限制。仅查质量或呈现正确中间结果，不能代替用户请求的比较和最终视图。

本地完成检查验证参数与证据一致，不构成完整语义理解证明。当前结论见 [项目评估](project-assessment.md)。
