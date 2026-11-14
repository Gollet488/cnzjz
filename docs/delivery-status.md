# 当前交付状态

更新于 2026-11-13（北京时间）。

## 已核验发布

- `main` 发布 SHA 为 `b36c10b88f488830c3671a514163fa826df9824c`，由 PR #9 合并。干净检出通过历史候选清单的 233 项验签、冻结安装、固定资源、18 项浏览器素材以及根路径和 `/cnzjz/` 构建。[合并提交](https://github.com/Gollet488/cnzjz/commit/b36c10b88f488830c3671a514163fa826df9824c) · [历史清单](evidence/20261113-release-candidate/manifest.json)
- Checks `43387249475` 的 Windows 和 Ubuntu 均成功。Pages `43387249510` 构建、静态烟测、上传和部署均成功。部署 `7759982767` 指向同一 SHA。[Checks](https://github.com/Gollet488/cnzjz/actions/runs/43387249475) · [Pages](https://github.com/Gollet488/cnzjz/actions/runs/43387249510) · [部署作业](https://github.com/Gollet488/cnzjz/actions/runs/43387249510/job/131759695090)
- Pages 归档 `14018878631`、线上 HTTP 200 响应和本机同 SHA 的 Pages 构建，29 个文件逐字节一致。归档 ZIP 的 SHA-256 为 `70e4eeee742c09aa18edd4f194bcf86455ace32997fe8b8e9fa5ac681c8de64f`。[公开站点](https://gollet488.github.io/cnzjz/)
- 公开 HTTPS 的 Chrome 首轮 10 通过、1 失败、0 跳过。授权真人视频验证 2,011 个源 PTS、2,011 行 × 354 列 CSV、PNG、片段重算和旧会话失效。普通双路播放及合成摄像头轨道释放通过。慢网首错和定向复测见下文。根路径产物匹配本机验收归档，沿用真人 Qwen 独立质量查询 1/1。[本机验收口径](evidence/20261113-release-candidate/review.md)

发布原始记录留在 `.qa/core-work/20261113-release-candidate/`。`main-actions.json` 和 `main-pages-deployment.json` 记录同 SHA 的作业及部署，`main-public-artifact-equivalence.json` 记录产物对照，`release-acceptance.md` 索引公开 HTTPS 首轮与定向复测。

## 本轮工作树验收

- 冻结的 1080p filtered 双膝 ROM 任务（0–5 秒、15–20 秒）恢复评测入口的本地引用组装。修前归档回放首次提交缺 7 项，最终达到轮次上限。修后从正常入口回放前 6 份回复，首次提交通过 20/20。每条引用可回查到同一运行、同一会话版本的成功工具输出。图表已应用，报告和 CSV 句柄已准备。离线 CSV 复算 601 行 × 354 列，除本轮会话 ID 外与冻结快照逐格一致，包含源 PTS、raw/filtered 和空值。720p 双肘回归保留 `not_comparable` 和右肘连续 127 个无效样本。
- 真实 DeepSeek `deepseek-flash` 单目标通过 1/1。结构化探测 1 次、业务 6 次约 13.1 秒、自动重试 0 次。一次任务声明因不支持的比较指标被拒绝，模型在原预算内修正。模型提交的 20 个引用中 15 个命中必需项，最终 20 条逐项回查通过。CLI 使用冻结帧并核验交付准备状态。实际 CSV 文件回读由离线回归覆盖。
- 公开 HTTPS 的慢网首错发生在原测试的 30 秒转换断言。注入 17 秒 WASM 响应延迟后，归档中两个响应体约在 29–36 秒收完，两路约在 36 秒就绪，点击后约 15 秒均触发 `playing`。本轮使用固定 AVI/WebM 在本机 `/cnzjz/` 复测，两个响应体在约 17.83/17.88 秒收完，两路约 18.39 秒转换就绪。点击约 0.53 秒后两路触发 `playing`，约 0.80 秒后首个配对画面发布，两路媒体时钟各推进至 0.29 秒。Chrome 定向 5/5，含 FFmpeg Worker/WASM 404 和约 45 秒初始化超时，三种故障均核验 Worker 终止及重选后完成分析。
- 历史 Worker 候选 `a4bea61` 在其基线将首次最长主线程任务中位数从 291.8 ms 降至 3.7 ms。其双路推理迁移基于较早的对比组件。当前组件还需保持独立对齐起点、重叠区间、最大差异回看、按采样位置续播及换源隔离。本轮慢网测试未采集可将实际等待归因到主线程推理的 CPU trace。复现播放或首对画面超标时，以当前生产构建采集按阶段对齐的 Chrome CPU trace，再决定是否移植现有 Worker。

Agent 定向单测通过 95/95。扩展单测通过 441/441，包含该定向套件，另有端口保护用例 1/1。格式、Lint、类型及两套生产构建通过。两套各 29 个文件，分别与发布基线对应构建逐字节一致。离线回归读取本机冻结快照及原审计，缺少归档的检出会跳过该用例。

本轮本机证据位于 `.qa/core-work/20261113-agent-delivery/`。`agent-before.log`、`agent-final.log`、`real-summary.json` 及对应审计记录引用和交付核验，`pages-final-results.json` 附件记录各阶段时间。

## 剩余验收条件

| 项目 | 条件 |
| --- | --- |
| 正式参赛成品 | 技术 PDF 最多 30 页。MP4 演示 5–8 分钟且至少 1080p。盘点范围与结果见 [提交清单](submission-checklist.md)。 |
| 实体摄像头 | 需可用且已获授权的设备，按原验收核对实际权限、源时钟、轨道、释放及相关设备性能。 |
| 原生 CSV 保存 | 需可操作系统文件选择器并核验实际落盘文件。Blob 下载已有证据。 |
| 人体测量精度 | 需独立同帧参考、参考不确定度及预先冻结的验收阈值，再按关节、侧别和可见性分层评估。[参考准入](core-execution-plan.md#q1-参考准入与重开材料) |
| Windows 完整启停 | 本机 `Win32_Process` 查询遇到 CIM `0x80041003`。启停脚本、测试和 Checks 工作流与发布基线相同，同 SHA 的 Windows `pnpm test` 已通过。后续若改动该路径，需在可查询进程命令行和创建时间的 Windows 会话验收。 |
