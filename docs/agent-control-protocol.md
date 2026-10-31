# 控制与证据协议

实现：`src/agent/controlProtocol.ts`、`src/agent/evidenceCatalog.ts`、`src/agent/completion.ts`。

当前控制协议版本为 2.0.0，模型适配协议版本另见 [模型协议](model-protocol-v3.md)。

计划和结束使用有限代码，本地渲染中文。引用由模型选择当前反馈中的 evidenceId；callId、路径和完整事实保留在本地审计中。旧轮次、过期会话、伪造标识以及无关元数据不能替代统计证据。

完成检查核对任务要求、数值证据及实际最终应用状态。遇到缺参数、不可比较、执行失败或超出限制时，使用对应状态，不把它们解释为成功。

schema 错误返回字段路径、类型或边界诊断，模型只能在恢复次数限制内纠正。当前回归与真实模型结果见 [项目评估](project-assessment.md)。
