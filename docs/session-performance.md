# 会话与导出性能

工具：scripts/benchmark-session.mjs、i3-page-performance.mjs、i3-product-controls.mjs。

```powershell
node --expose-gc scripts/benchmark-session.mjs 18000 .qa/my-benchmark
```

Node 基准生成明确标记的合成姿态数据，测量采集、首次/缓存查询、区间汇总、CSV 分块写入和内存。浏览器页面基准另测实际图表、交互与绘制；两类数据不可混为真实设备性能。

会话仍在内存保留关键点与指标。分块 CSV 采用背压和有界批次，支持进度、取消和失败；Blob 回退仍在内存保留完整导出内容。

页面发布合并连续更新，索引/查询缓存绑定当前会话、版本和参数。MAX_FRAMES 当前为 18,000；达到上限后的行为须按采集模式理解，不能视为无限时长录像。

本次实测数字与条件见 [项目评估](project-assessment.md)。
