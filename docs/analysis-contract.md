# 分析契约

依据：`src/analysis/session.ts`、`src/analysis/tools.ts`、`src/utils/poseMath.ts`。

- 会话引用由 sessionId 和 revision 组成。追加、重算、采集元数据或素材来源改变后，旧引用失效；重置生成新 sessionId。
- 参数包含置信阈值、滤波窗口、来源宽高比和 metricVersion；当前指标版本为 2.0。
- 输入为 33 个有限坐标及 visibility，或无检测的空数组。源时间必须有限、非负且递增。
- raw 坐标独立保留；filtered 使用可配置均值窗口。缺失或低置信数据中断连续滤波与导数。
- 角度计算修正来源比例；速度采用实际源时间差。脊柱是单中线量，其余关节使用左右通道。
- ROM 为区间最大角度减最小角度。区间边界不借用区间外速度，单个有效样本不能构成活动范围。
- 髋中心是身体中心的二维近似。坐标总体方差不等同动作质量，主动运动、噪声与视角都会改变它。
- 比较差值的方向固定为第二段减第一段；不可比较时返回限制，不补造统计。

工具包括 get_session_info、get_quality_summary、query_metrics、compare_intervals、seek_to_time、set_chart_view、prepare_report、prepare_export。schema 校验先于执行，所有统计和数值由本地 TypeScript 计算。

证据包含会话版本、参数、来源、区间、口径、有效样本与单位。报告/导出句柄受当前版本约束，失效后须重新准备。

当前检查结果见 [项目评估](project-assessment.md)。
