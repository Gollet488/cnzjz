// Agent control protocol v2. The model selects codes; only local templates enter
// the product's explanation/plan. No generated numeric prose is accepted.
import { enumeration } from '../analysis/schema.ts';

export const AGENT_PROTOCOL_VERSION = '2.0.0';
export const PLAN_TEXT = {
  read_session: '读取当前会话，确认参数与采样范围',
  check_quality: '检查采样质量与缺失情况',
  query_metrics: '查询指定关节与口径的指标',
  compare_intervals: '进一步分析指定区间，展示比较证据',
  apply_view: '应用请求的图表视图',
  seek: '定位到请求的采样时间',
  prepare_report: '准备分析报告',
  prepare_export: '准备导出成果',
  present_evidence: '展示证据与限制，一并核对交付条件',
  clarify: '请求补充必要参数',
} as const;
export const MESSAGE_TEXT = {
  evidence_ready: '已呈现工具证据，请结合采样限制一并阅读。',
  no_samples: '暂无采样，请先采集数据后重试。',
  specify_parameters: '请补充任务规格中尚未明确的参数。',
  range_unavailable: '请求的区间无法用于当前采样，请确认区间。',
  partial_delivery: '已呈现部分证据，请一并查看待补交付条件。',
  comparison_limited: '当前证据不足以支持所请求的区间比较，请查看限制。',
  execution_failed: '所需交付尚未完成，请查看调用记录与待补条件。',
} as const;
export const planCodeSchema = enumeration(...Object.keys(PLAN_TEXT));
export const messageCodeSchema = enumeration(...Object.keys(MESSAGE_TEXT));
export type PlanCode = keyof typeof PLAN_TEXT;
export type MessageCode = keyof typeof MESSAGE_TEXT;

export function checkRenderedControl(message: string, steps: string[]) {
  if (
    !Object.values(MESSAGE_TEXT).some((text) => text === message) ||
    steps.some((step) => !Object.values(PLAN_TEXT).some((text) => text === step))
  )
    throw new Error('UNVERIFIED_CONTROL_TEXT');
}
