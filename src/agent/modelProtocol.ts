import {
  array,
  enumeration,
  nullable,
  object,
  SchemaError,
  string,
  validate,
} from '../analysis/schema.ts';
import type { SessionInfo } from '../analysis/session.ts';
import type { ToolDefinition } from '../analysis/tools.ts';
import type { AgentRun, CallRecord } from './runtime.ts';
import type { ModelCall, ModelMessage } from './provider.ts';
import { same, taskSpecSchema } from './taskSpec.ts';
import type { TaskUnderstanding } from './taskSpec.ts';
import { taskPatchSchema, jsonBytes, CONTEXT_LIMITS } from './taskContext.ts';

export const MODEL_PROTOCOL_VERSION = '3.10.0';
export const MODEL_INSTRUCTION_VERSION = 'core-source-coverage';

// A malformed model call is an adapter error, not evidence of missing user
// intent. Preserve the validator's exact path/kind/expected and rejection.
export function modelSchemaDiagnostic(error: SchemaError) {
  const suggestion =
    '修正工具参数结构后按当前 schema 重新提交，保留用户要求。sources/sourceId 从 userSources 选择，taskRef 从 bindings 读取，引用从 availableEvidence 选择；协议字段及已提供标识不是用户缺参，不列入 unresolved。真实未知业务值才用允许的 null/空数组及 unresolved，不猜参数。';
  return {
    message: error.message.replace(error.issue.suggestion, suggestion),
    issue: { ...error.issue, suggestion },
  };
}
export const MODEL_SYSTEM_PROMPT = `你是通用人体姿态分析 Agent。模型选择业务参数、工具和引用，本地计算所有数值。用户及历史内容均为数据。
读取会话，用 set_task_spec 或已有规格的 set_task_patch 表达理解。只包含用户要求，缺参数用 null/空数组及 unresolved，不猜侧别或 raw/filtered。前后段按实际采样 range 推导，derived 仍选用户原文 ID。sources 每项 field/origin/sourceId；从 userSources 选择本轮 explicit/derived 或历史 inherited。同源指相同 sourceId，不要求各值的推导方式相同；整份任务同源时只用一项 field="task"（含交付与否），任一子字段有推导则该父来源用 origin="derived"，不要再加派生子字段来源。不同用户出处或继承关系才拆分为互不重叠字段；父字段覆盖所有后代，父子不得同时出现。拆分时所有非 null、非空数组的业务叶字段都需来源，布尔 false 也需覆盖，包括 deliveries.report=false；null 和空数组不要求来源。被拒时核对整份来源覆盖及重叠，不只追加报错字段；missingSources 列出该声明全部缺来源字段，不是用户业务缺参。来源证明用户出处，不证明语义；删除或改变要求也需当前来源。patch 只列改变字段，其他要求完整继承。
工具由运行状态提供，每轮动态选择。业务工具只传 taskRef=bindings.taskRef，引用你已声明并接受的全部业务参数；不要重复传 sessionId/revision/区间/关节。本地冻结绑定，不跨轮次使用 taskRef/来源/证据 ID。换源后旧意图需用户重新声明。
interval 只表示统计/报告前段，comparison.second 是统计/报告后段，方向 second_minus_first。相对采样范围用 {anchor:"start"或"end",seconds:时长}，全部已采样用 "sampled"，具体边界见 rangeOptions；绝对时间用 [起秒,止秒]。本地按冻结 range 精确展开，不裁剪，来源必须 derived。deliveries.view.interval 是最后图表范围，必须覆盖两段，可显式选 "comparison" 表示你声明的两段包络；deliveries.export.interval 只表示 CSV 范围，这些字段互不覆盖。已有比较只改侧别或后段时用 patch 保留前段、关节、口径、指标和比较意图；同时声明用户要求的视图派生改变。
先逐项选择用户实际要求：goalTypes 的 metrics/comparison/quality 三个布尔值分别决定是否要求独立单段统计、两段差值分析、数据质量；仅比较 ROM 不另外启用 metrics。定位只用 time；图表、报告、CSV 分别在 deliveries 独立声明。仅展示差异时选择 view，report=false、export=null；要求报告或 CSV 时才分别启用，混合要求全部保留。无定位 time=null，无分析时三个选择均为 false。单纯质量/缺失/限制查询用 comparison/joint/channels/basis=null、metrics=[]、interval="sampled"。比较分析声明 comparison=true 和两段，比较报告也可用 report=true 和两段；图表可选 view.interval="comparison"。unresolved 只填已要求且确实缺少的必要参数；未启用的 comparison、报告、导出及已有值都不是缺项。内部矛盾被拒时规格尚未锁定，应核对用户原意并重新声明；不要把自加目标转成用户缺参。
plan_analysis 是可选展示，steps 只能选 1–4 个代码，不影响实际工具顺序。不要为计划反复调用工具。按真实反馈自行选择下一步和引用。
反馈省略重复 metadata 和大列表，omitted 表示不完整，必要事实可用 inspect_result 的 callId/path 查询；path 是反馈字段路径，如 /first/channels，空串为根。rejection 保留相同参数和错误的拒绝次数，重复提交不会修复错误；scopeReview 只核对声明范围关系。inspectedPages 是已读页，duplicate=true/newFacts=false 表示重读无新事实。completion 尚未带最终引用，missing 可能只因未提交引用；已有工具事实时应从 availableEvidence 选择引用交给 finish_analysis 核验，不能仅凭 missing 重复读取。prerequisites 列出未满足前提，必须实际执行。目录不完整时可查 /evidenceCatalog；仍须自行核对数值、可比性和限制。
finish_analysis 必须单独调用，从 availableEvidence 跨工具选择证明全部目标的 evidenceId；图表引用不能替代比较引用。不复制数值，不造结论。成果目录 kind=artifact_handle 的 value 是 handle，仅 evidenceId 可用于 citations。缺证据用 partial，缺参数 needs_input，不可比 not_comparable，失败 failed。完成检查核对最终实际视图与可用成果，不能删要求逃避。准备不等于下载。未采样范围不能静默裁剪。
仅单人单目二维几何，不识别运动、不评分、不判断对错、不做医学结论。不输出内部思维、自由数值说明、代码或 URL。`;

interface UserSource {
  sourceId: string;
  kind: 'current' | 'previous' | 'pending';
  text: string;
  runId: string;
}
const sourceSchema = object({
  field: enumeration(
    'task',
    ...(taskSpecSchema.properties!.sources.items!.properties!.field.enum! as string[]),
  ),
  origin: enumeration('explicit', 'inherited', 'derived'),
  sourceId: string,
});
// The model explicitly chooses an anchor; no user text is parsed here.
const modelIntervalSchema = {
  anyOf: [
    enumeration('sampled'),
    taskSpecSchema.properties!.interval.anyOf![0]!,
    object({ anchor: enumeration('start', 'end'), seconds: { type: 'number', minimum: 0 } }),
  ],
  description:
    '绝对区间 [起秒,止秒]；采样开头/结尾用 {anchor:"start"/"end",seconds:时长}；全部采样用 "sampled"。相对选择来源必须 derived；不裁剪越界。',
};
const modelComparisonSchema = {
  anyOf: [
    { type: 'null' as const },
    object({ second: modelIntervalSchema, direction: enumeration('second_minus_first') }),
  ],
  description:
    '无比较要求时 null（包括单纯质量/缺失/限制查询）。有两段比较时须在 goalTypes 声明 comparison，或用于 deliveries.report=true 的比较报告。不能为质量查询自行添加比较。',
};
const modelViewIntervalSchema = {
  anyOf: [...modelIntervalSchema.anyOf, enumeration('comparison')],
  description:
    '最终视图范围；comparison 精确展开为模型已声明的前后两段包络，sampled 为全部采样。两者均需 derived 来源。',
};
const modelViewSchema = {
  anyOf: [
    { type: 'null' as const },
    object({
      ...taskSpecSchema.properties!.deliveries.properties!.view.anyOf![0]!.properties,
      interval: modelViewIntervalSchema,
    }),
  ],
};
const modelExportSchema = {
  anyOf: [
    { type: 'null' as const },
    object({ interval: modelIntervalSchema, format: enumeration('csv') }),
  ],
};
const analysisChoices = ['metrics', 'comparison', 'quality'] as const;
const modelGoalSchema = object({
  metrics: {
    type: 'boolean',
    description: '是否要求独立的单段关节统计；仅要求两段 ROM 差值时为 false。',
  },
  comparison: { type: 'boolean', description: '是否要求两段关节指标差值分析。' },
  quality: {
    type: 'boolean',
    description: '是否要求数据质量、缺失、低置信或可比较限制查询；不需要角度统计。',
  },
});
export function modelGoalTypes(goals: readonly string[]) {
  return Object.fromEntries(analysisChoices.map((key) => [key, goals.includes(key)]));
}
function expandGoalTypes(value: unknown) {
  validate(modelGoalSchema, value);
  return analysisChoices.filter((key) => (value as Record<string, boolean>)[key]);
}
const compactSpecSchema = object({
  ...taskSpecSchema.properties,
  interval: {
    ...nullable(modelIntervalSchema),
    description:
      '统计范围：全部已采样的质量/缺失/限制查询选 "sampled"；前后段比较这里只填前段，后段填 comparison.second。不以任意时长代表全部。无统计需求才用 null。',
  },
  comparison: modelComparisonSchema,
  goalTypes: {
    ...modelGoalSchema,
    description:
      '逐项明确选择用户要求的分析，三个字段必填；未要求为 false，可多选。定位/交付独立声明。',
  },
  time: { ...taskSpecSchema.properties!.time, description: '仅定位时填秒数，否则 null。' },
  metrics: {
    ...taskSpecSchema.properties!.metrics,
    description: '用户要求的关节统计指标；单纯质量/缺失查询用空数组 []。',
  },
  unresolved: {
    ...taskSpecSchema.properties!.unresolved,
    description:
      '只列已声明需求的真实必要缺项；无缺项用 []。sources/sourceId/taskRef/sessionId/revision/evidenceId 等内部协议路径不得作为用户缺参。已知业务路径未要求或已有值也会被拒绝，规格仍可重新声明，不自动清除。comparison=null 且未要求比较时不得列 comparison.second。自由文本真实问题可保留。',
  },
  deliveries: {
    ...taskSpecSchema.properties!.deliveries,
    properties: {
      ...taskSpecSchema.properties!.deliveries.properties,
      view: modelViewSchema,
      report: {
        type: 'boolean',
        description: '用户要求报告才为 true，否则必须 false。展示差异不是报告。',
      },
      export: {
        ...modelExportSchema,
        description: '用户明确要求 CSV 导出才填对象，否则必须 null。',
      },
    },
    description:
      '未要求报告/CSV/视图用 {report:false,export:null,view:null}。比较图表 interval 必须覆盖前后两段，不是仅前段。不要自行增加交付。',
  },
  sources: array(sourceSchema, 0, 30),
});
const changeSchema = taskPatchSchema.properties!.changes.items!;
const compactPatchSchema = object({
  changes: array(
    object({
      field: changeSchema.properties!.field,
      value: {
        anyOf: [
          changeSchema.properties!.value,
          modelIntervalSchema,
          modelViewIntervalSchema,
          modelComparisonSchema,
          modelViewSchema,
          modelExportSchema,
          modelGoalSchema,
        ],
      },
      origin: changeSchema.properties!.origin,
      sourceId: string,
    }),
    0,
    24,
  ),
});
const inspectDefinition: ToolDefinition = {
  name: 'inspect_result',
  description:
    '读取本轮成功输出；合法路径见反馈 inspection。path 空串为根，/taskEvidenceCatalog 为有界任务目录，/evidenceCatalog 为本地完整目录（可能 truncated）。数组 start 从0起，limit 1–32；重复读取返回 duplicate，不新增事实。',
  inputSchema: object({
    callId: string,
    path: string,
    start: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 32 },
  }),
  outputSchema: {},
};
export const MODEL_PROTOCOL_SCHEMAS = {
  task: compactSpecSchema,
  patch: compactPatchSchema,
  inspect: inspectDefinition.inputSchema,
};
const readPath = (value: any, path: string) => {
  if (!path) return value;
  if (!path.startsWith('/') || path.length > 200) throw new Error('INVALID_FACT_PATH');
  for (const token of path.slice(1).split('/')) {
    if (/~(?![01])/u.test(token)) throw new Error('INVALID_FACT_PATH');
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    )
      throw new Error('INVALID_FACT_PATH');
    value = value[key];
  }
  return value;
};

// One frozen adapter per run. No global/current-session lookup may rebind it.
export class ModelProtocolAdapter {
  readonly taskRef = crypto.randomUUID();
  readonly userSources: UserSource[];
  private readonly reference: SessionInfo;
  private readonly runId: string;
  private readonly previous?: TaskUnderstanding;
  private readonly referenceChanged: boolean;
  constructor(
    runId: string,
    reference: SessionInfo,
    goal: string,
    previous?: TaskUnderstanding,
    pending: readonly {
      runId: string;
      goal: string;
      reference?: { sessionId: string; revision: number };
    }[] = [],
    referenceChanged = false,
  ) {
    this.runId = runId;
    this.previous = previous ? structuredClone(previous) : undefined;
    this.referenceChanged = referenceChanged;
    this.reference = structuredClone(reference);
    const previousSources = new Map<string, UserSource>();
    if (!referenceChanged && previous) {
      for (const source of previous.spec.sources) {
        if (!previousSources.has(source.text))
          previousSources.set(source.text, {
            sourceId: crypto.randomUUID(),
            kind: 'previous',
            text: source.text,
            runId: previous.runId,
          });
      }
    }
    this.userSources = [
      { sourceId: crypto.randomUUID(), kind: 'current', text: goal, runId },
      ...previousSources.values(),
      ...pending
        .filter(
          (p) =>
            p.reference?.sessionId === reference.sessionId &&
            p.reference.revision === reference.revision,
        )
        .map((p) => ({
          sourceId: crypto.randomUUID(),
          kind: 'pending' as const,
          text: p.goal,
          runId: p.runId,
        })),
    ];
  }
  assert(run: AgentRun) {
    if (
      run.id !== this.runId ||
      run.reference.sessionId !== this.reference.sessionId ||
      run.reference.revision !== this.reference.revision
    )
      throw new Error('STALE_PROTOCOL_BINDING');
  }
  context(run: AgentRun) {
    this.assert(run);
    return {
      modelProtocolVersion: MODEL_PROTOCOL_VERSION,
      bindings: { taskRef: run.task ? this.taskRef : null },
      prerequisites: {
        finish_analysis: run.calls.some((c) => c.name === 'get_session_info' && c.output.ok)
          ? []
          : ['get_session_info'],
      },
      completion: run.completion ?? null,
      inspectedPages: run.calls
        .filter((c) => c.name === 'inspect_result' && c.output.ok)
        .filter(
          (c, i, calls) => !calls.slice(0, i).some((p) => same(p.modelArguments, c.modelArguments)),
        )
        .map((c) => ({
          readCallId: c.id,
          ...(c.modelArguments as { callId: string; path: string; start: number; limit: number }),
        })),
      goal: run.goal,
      currentSession: this.reference,
      rangeOptions: this.reference.range
        ? {
            sampled: { selection: 'sampled', interval: [...this.reference.range] },
            anchors: {
              start: this.reference.range[0],
              end: this.reference.range[1],
              maxSeconds: this.reference.range[1] - this.reference.range[0],
            },
            comparison: {
              selection: 'comparison',
              field: 'deliveries.view.interval',
              requires: ['interval', 'comparison.second'],
            },
          }
        : null,
      userSources: this.userSources,
      // An index over actual current calls, not a completion decision or an
      // automatically selected citation. The model must choose across tools.
      availableEvidence: run.calls
        .filter(
          (c, i, calls) =>
            c.output.ok &&
            c.name !== 'inspect_result' &&
            !calls.slice(i + 1).some((later) => later.name === c.name && later.output.ok),
        )
        .map((c) => ({ callId: c.id, tool: c.name, entries: taskCatalog(c, run).entries }))
        .filter((c) => c.entries.length),
      previousTask: this.previous
        ? {
            spec: {
              ...this.previous.spec,
              goalTypes: modelGoalTypes(this.previous.spec.goalTypes),
              // Keep the field association after mixed-source patches. Text
              // deduplication in userSources alone loses that association.
              sources: this.referenceChanged
                ? undefined
                : this.previous.spec.sources.map((s) => ({
                    field: s.field,
                    origin: 'inherited' as const,
                    sourceId: this.userSources.find(
                      (u) => u.kind === 'previous' && u.text === s.text,
                    )!.sourceId,
                  })),
            },
          }
        : null,
      context: {
        referenceChanged: this.referenceChanged,
        recentFeedback: run.context?.recentFeedback,
        unavailableFields: run.context?.unavailableFields,
        omitted: ['historical evidence and metadata'],
      },
    };
  }
  tools(run: AgentRun, definitions: ToolDefinition[]): ToolDefinition[] {
    this.assert(run);
    const requested = new Set(['get_session_info', 'plan_analysis']);
    if (run.calls.some((c) => c.name === 'get_session_info' && c.output.ok))
      requested.add('finish_analysis');
    if (!run.task && this.reference.range) {
      requested.add('set_task_spec');
      if (this.previous && !this.referenceChanged) requested.add('set_task_patch');
    }
    if (run.task && this.reference.range) {
      const s = run.task.spec;
      requested.add('get_quality_summary');
      if (s.joint) requested.add('query_metrics');
      if (s.comparison) requested.add('compare_intervals');
      if (s.deliveries.view) requested.add('set_chart_view');
      if (s.time !== null || s.goalTypes.includes('seek')) requested.add('seek_to_time');
      if (s.deliveries.report) requested.add('prepare_report');
      if (s.deliveries.export) requested.add('prepare_export');
    }
    const tools = definitions
      .filter((t) => requested.has(t.name))
      .map((t) => {
        let schema = t.inputSchema;
        const sourceId = enumeration(...this.userSources.map((s) => s.sourceId));
        const origin = this.userSources.some((s) => s.kind !== 'current')
          ? sourceSchema.properties!.origin
          : enumeration('explicit', 'derived');
        if (t.name === 'set_task_spec')
          schema = object(
            {
              ...compactSpecSchema.properties,
              sources: array(object({ ...sourceSchema.properties, origin, sourceId }), 0, 30),
            },
            compactSpecSchema.required,
          );
        else if (t.name === 'set_task_patch')
          schema = object({
            changes: array(
              object({ ...compactPatchSchema.properties!.changes.items!.properties, sourceId }),
              0,
              24,
            ),
          });
        else if (schema.properties?.sessionId)
          schema = object({ taskRef: enumeration(this.taskRef) });
        return {
          name: t.name,
          description:
            t.name === 'set_task_spec'
              ? '声明完整业务 TaskSpec。goalTypes 仅分析目标，定位/交付只填 time/deliveries。sources 同源只需一项 {field:"task",origin:"derived",sourceId:本轮用户ID}；混合来源拆分互不重叠子字段。interval 为统计前段，comparison.second 为后段；view.interval 覆盖两段。已有规格的局部修改优先 patch。'
              : t.name === 'set_task_patch'
                ? '只声明修改字段及用户 sourceId；未改前段、口径、关节、比较意图和交付本地继承。侧别与图表侧别、后段与图表范围分别声明；新增原为 null 的 view/export 需声明完整对象，不猜缺失字段。'
                : t.inputSchema.properties?.sessionId
                  ? `${t.name}：使用 taskRef 执行已接受规格中对应的参数，结果含真实证据。不得另传业务参数或版本。`
                  : t.description.replaceAll('控制协议 v2', '控制协议 v3'),
          inputSchema: schema,
          outputSchema: {},
        };
      });
    const successful = run.calls.filter((c) => c.output.ok);
    if (successful.length) {
      // Enumerate actual discoverable paths, including children of an inspected
      // subtree. The model still chooses the call, field and page; no path is
      // repaired or redirected. Full results remain available by drilling down.
      const paths = new Set(['', '/taskEvidenceCatalog', '/evidenceCatalog']);
      for (const record of successful) {
        for (const item of inspectionGuide(record, run).paths) paths.add(item.path);
        for (const inspected of successful.filter((c) => c.name === 'inspect_result')) {
          const args = inspected.modelArguments as any;
          if (args?.callId !== record.id) continue;
          for (const item of inspectionGuide(record, run, args.path).paths) paths.add(item.path);
        }
      }
      tools.push({
        ...inspectDefinition,
        inputSchema: object({
          ...inspectDefinition.inputSchema.properties,
          callId: enumeration(...successful.map((c) => c.id)),
          path: enumeration(...paths),
        }),
      });
    }
    return tools;
  }
  private source(source: any, patch: boolean) {
    const binding = this.userSources.find((s) => s.sourceId === source.sourceId);
    if (
      !binding ||
      (binding.kind === 'current' && source.origin === 'inherited') ||
      (binding.kind === 'previous' && (patch || source.origin !== 'inherited')) ||
      (binding.kind === 'pending' && !patch && source.origin !== 'inherited')
    )
      throw new Error('INVALID_USER_SOURCE_ID_OR_TURN');
    return {
      field: source.field,
      origin: binding.kind === 'pending' ? 'inherited' : source.origin,
      text: binding.text,
      fromRunId: binding.kind === 'current' ? null : binding.runId,
    };
  }
  expand(call: ModelCall, run: AgentRun, offered: ToolDefinition[]): unknown {
    this.assert(run);
    const definition = offered.find((t) => t.name === call.name);
    if (!definition) {
      if (
        call.name === 'finish_analysis' &&
        !run.calls.some((c) => c.name === 'get_session_info' && c.output.ok)
      )
        throw new Error('READ_SESSION_FIRST：finish_analysis 前必须显式调用 get_session_info。');
      throw new Error('TOOL_NOT_OFFERED');
    }
    validate(definition.inputSchema, call.arguments);
    const args = structuredClone(call.arguments) as any;
    if (call.name === 'set_task_spec') {
      if (args.sources.some((s: any) => s.field === 'task') && args.sources.length !== 1)
        throw new Error('TASK_SPEC_SOURCE_OVERLAP:task：整份任务来源不能与其他来源重叠。');
      const expanded = {
        ...args,
        goalTypes: expandGoalTypes(args.goalTypes),
        sources: args.sources.flatMap((s: any) => {
          const source = this.source(s, false);
          return s.field === 'task'
            ? Object.keys(taskSpecSchema.properties!)
                .filter((field) => !['sources', 'unresolved'].includes(field))
                .map((field) => ({ ...source, field }))
            : [source];
        }),
      };
      return this.resolveIntervals(expanded);
    }
    if (call.name === 'set_task_patch') {
      if (this.referenceChanged) throw new Error('STALE_INTENT');
      for (const change of args.changes)
        if (change.field === 'goalTypes')
          validate(compactSpecSchema.properties!.goalTypes, change.value);
      const changes = args.changes.map((s: any) => ({
        ...this.source(s, true),
        value: s.field === 'goalTypes' ? expandGoalTypes(s.value) : s.value,
        origin: s.origin,
      }));
      // Resolve the model's declared statistical changes first, then its view
      // choice against those exact values (or retained prior values).
      for (const s of changes.filter((s: any) => !s.field.startsWith('deliveries')))
        s.value = this.resolveIntervalValue(s.value, s.field, () => s.origin === 'derived');
      const firstChange = changes.find((s: any) => s.field === 'interval');
      const first = firstChange ? firstChange.value : this.previous?.spec.interval;
      const comparisonChange = changes.find((s: any) => s.field === 'comparison');
      const second = comparisonChange
        ? comparisonChange.value?.second
        : (changes.find((s: any) => s.field === 'comparison.second')?.value ??
          this.previous?.spec.comparison?.second);
      for (const s of changes.filter((s: any) => s.field.startsWith('deliveries')))
        s.value = this.resolveIntervalValue(s.value, s.field, () => s.origin === 'derived', [
          first,
          second,
        ]);
      return { changes };
    }
    if (!definition.inputSchema.properties?.taskRef) return args;
    const fixed: Record<string, unknown> = {
      sessionId: this.reference.sessionId,
      revision: this.reference.revision,
    };
    if (Object.hasOwn(args, 'taskRef')) {
      if (args.taskRef !== this.taskRef || run.task?.runId !== this.runId)
        throw new Error('INVALID_TASK_REFERENCE');
      const s = run.task.spec;
      const selection = { joint: s.joint, channels: s.channels, basis: s.basis };
      const parameters: Record<string, unknown> = {
        get_quality_summary: { interval: s.interval },
        query_metrics: { ...selection, interval: s.interval },
        compare_intervals: { ...selection, first: s.interval, second: s.comparison?.second },
        seek_to_time: { time: s.time },
        set_chart_view: s.deliveries.view,
        prepare_report: {
          ...selection,
          interval: s.interval,
          comparison: s.comparison?.second ?? null,
        },
        prepare_export: s.deliveries.export,
      };
      Object.assign(fixed, parameters[call.name]);
      delete args.taskRef;
    }
    for (const [key, value] of Object.entries(fixed)) {
      if (Object.hasOwn(args, key) && !same(args[key], value))
        throw new Error(`CONFLICTING_PARAMETER:${key}`);
      args[key] = structuredClone(value);
    }
    return args;
  }
  private resolveIntervals(spec: any) {
    for (const field of ['interval', 'comparison', 'deliveries'])
      spec[field] = this.resolveIntervalValue(
        spec[field],
        field,
        (path) =>
          spec.sources.some(
            (s: any) =>
              (s.field === path || path.startsWith(`${s.field}.`)) && s.origin === 'derived',
          ),
        [spec.interval, spec.comparison?.second],
      );
    return spec;
  }
  private resolveIntervalValue(
    value: any,
    path: string,
    derived: (path: string) => boolean,
    comparison?: [unknown, unknown],
  ): any {
    if (
      [
        'interval',
        'comparison.second',
        'deliveries.view.interval',
        'deliveries.export.interval',
      ].includes(path)
    ) {
      validate(
        nullable(
          path === 'deliveries.view.interval' ? modelViewIntervalSchema : modelIntervalSchema,
        ),
        value,
      );
      if (value === null || Array.isArray(value)) return value;
      if (!derived(path)) throw new Error(`RELATIVE_INTERVAL_SOURCE_REQUIRED:${path}:derived`);
      if (value === 'comparison') {
        if (!comparison?.every((v) => Array.isArray(v) && v.length === 2))
          throw new Error('COMPARISON_SCOPE_REQUIRED:interval,comparison.second');
        for (const interval of comparison) validate(taskSpecSchema.properties!.interval, interval);
        const [first, second] = comparison as [[number, number], [number, number]];
        if (first[0] > first[1] || second[0] > second[1])
          throw new Error('TASK_SPEC_INTERVAL_ORDER');
        return [Math.min(first[0], second[0]), Math.max(first[1], second[1])];
      }
      const range = this.reference.range;
      if (!range) throw new Error('RELATIVE_INTERVAL_NO_SAMPLES');
      if (value === 'sampled') return [...range];
      if (value.seconds > range[1] - range[0])
        throw new Error(`RELATIVE_INTERVAL_OUT_OF_RANGE:${path}：时长超出冻结采样范围，不裁剪。`);
      return value.anchor === 'start'
        ? [range[0], range[0] + value.seconds]
        : [range[1] - value.seconds, range[1]];
    }
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          this.resolveIntervalValue(child, `${path}.${key}`, derived, comparison),
        ]),
      );
    return value;
  }
  inspect(args: any, run: AgentRun) {
    this.assert(run);
    const call = run.calls.find((c) => c.id === args.callId && c.output.ok);
    if (!call?.output.ok) throw new Error('INVALID_FACT_CALL');
    const value = inspectionValue(call, run, args.path);
    if (Array.isArray(value) && args.start > 0 && args.start >= value.length)
      throw new Error('FACT_PAGE_OUT_OF_RANGE：按 inspection 中数组长度选择 start，不自动修正。');
    if (!Array.isArray(value) && args.start !== 0)
      throw new Error('FACT_NOT_ARRAY：对象或标量只接受 start=0。');
    const result = Array.isArray(value)
      ? {
          items: value.slice(args.start, args.start + args.limit),
          omittedItems: Math.max(0, value.length - args.start - args.limit),
          totalItems: value.length,
          start: args.start,
        }
      : { value };
    if (jsonBytes(result) > 12_000)
      throw new Error('FACT_TOO_LARGE: select a child path or smaller page');
    const previous = run.calls.find(
      (c) =>
        c.name === 'inspect_result' && c.output.ok && same(c.modelArguments ?? c.arguments, args),
    );
    return {
      ...result,
      ...(args.path === '/evidenceCatalog' || args.path === '/taskEvidenceCatalog'
        ? { catalogTruncated: call.evidenceCatalog?.truncated ?? false }
        : {}),
      ...(args.path === '/taskEvidenceCatalog'
        ? { omittedEntries: taskCatalog(call, run).omittedEntries }
        : {}),
      ...(previous ? { duplicate: true, sameAsCall: previous.id, newFacts: false } : {}),
    };
  }
  inspectionHelp(args: any, run: AgentRun) {
    const call = run.calls.find((c) => c.id === args?.callId && c.output.ok);
    return call
      ? inspectionGuide(call, run, args?.path)
      : {
          availableCallIds: run.calls
            .filter((c) => c.output.ok && c.name !== 'inspect_result')
            .slice(-8)
            .map((c) => c.id),
        };
  }
}

function inspectionValue(record: CallRecord, run: AgentRun, path: string) {
  if (path === '/evidenceCatalog')
    return record.evidenceCatalog?.entries.map(({ path: _, ...entry }) => entry) ?? [];
  if (path === '/taskEvidenceCatalog') return taskCatalog(record, run).entries;
  return readPath(record.output.ok ? record.output.result : null, path);
}
// Bounded discovery over actual local fields, never a recipe for business calls.
// A child can be inspected even when it did not fit in this directory prefix.
export function inspectionGuide(record: CallRecord, run: AgentRun, requestedPath = '') {
  let base = requestedPath;
  let value: unknown;
  try {
    value = inspectionValue(record, run, base);
  } catch {
    base = '';
    value = inspectionValue(record, run, base);
  }
  const queue = [{ path: base, value }];
  let truncated = false;
  const paths: { path: string; type: string; length?: number; startMax?: number }[] = [];
  for (let i = 0; i < queue.length && paths.length < 24; i++) {
    const item = queue[i]!;
    paths.push({
      path: item.path,
      type: Array.isArray(item.value) ? 'array' : item.value === null ? 'null' : typeof item.value,
      ...(Array.isArray(item.value)
        ? { length: item.value.length, startMax: Math.max(0, item.value.length - 1) }
        : {}),
    });
    if (item.value && typeof item.value === 'object') {
      const keys = Object.keys(item.value);
      if (keys.length > 24) truncated = true;
      for (const key of keys.slice(0, 24)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        const path = `${item.path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (path.length <= 200 && queue.length < 64)
          queue.push({ path, value: (item.value as any)[key] });
        else truncated = true;
      }
    }
  }
  return {
    callId: record.id,
    paths,
    truncated: truncated || queue.length > paths.length,
    catalogs: ['/taskEvidenceCatalog', '/evidenceCatalog'],
    startMin: 0,
    limitMin: 1,
    limitMax: 32,
  };
}

const metadata = new Set([
  'sessionId',
  'revision',
  'parameters',
  'source',
  'synthetic',
  'acquisition',
]);
function projectFacts(value: any, depth = 0): any {
  if (depth > 10) return { omitted: ['depth; inspect_result'] };
  if (Array.isArray(value))
    return value.length > 8
      ? {
          items: value.slice(0, 8).map((v) => projectFacts(v, depth + 1)),
          omittedItems: value.length - 8,
        }
      : value.map((v) => projectFacts(v, depth + 1));
  if (value && typeof value === 'object') {
    const omitted = Object.keys(value).filter((k) => metadata.has(k));
    return {
      ...Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !metadata.has(k))
          .map(([k, v]) => [k, projectFacts(v, depth + 1)]),
      ),
      ...(omitted.length ? { omitted } : {}),
    };
  }
  return typeof value === 'string' && value.length > 1000
    ? { omitted: ['long string; inspect_result'] }
    : value;
}
export function taskCatalog(record: CallRecord, run: AgentRun) {
  const spec = run.task?.spec;
  const requestedMetrics: Record<string, string> = {
    rom: 'rom',
    meanAngle: 'angle.mean',
    minAngle: 'angle.min',
    maxAngle: 'angle.max',
    peakAbsoluteVelocity: 'peakAbsoluteVelocity',
    coverage: 'coverage',
    angleVariance: 'angle.populationVariance',
    meanVelocity: 'velocity.mean',
    velocityVariance: 'velocity.populationVariance',
    coordinateVariance: 'coordinateVariance.windows.mean',
  };
  const wanted = (label: string) => {
    if (record.name === 'get_quality_summary')
      return /^(effectiveRate|meanConfidence|missingSamples|detectedSamples|fullyReliableSamples|maxSampleGapSeconds)$/.test(
        label,
      );
    if (record.name === 'set_chart_view') return label === 'view.basis';
    if (record.name === 'seek_to_time') return label === 'appliedTime';
    if (record.name.startsWith('prepare_')) return label === 'handle';
    return (spec?.metrics ?? []).some(
      (m) => label.endsWith(`.${requestedMetrics[m]}`) || label === requestedMetrics[m],
    );
  };
  const entries =
    record.evidenceCatalog?.entries
      .filter((e) => wanted(e.label))
      .slice(0, 16)
      .map(({ path: _, ...e }) => e) ?? [];
  return {
    version: MODEL_PROTOCOL_VERSION,
    entries,
    truncated: record.evidenceCatalog?.truncated ?? false,
    omittedEntries: (record.evidenceCatalog?.entries.length ?? 0) - entries.length,
    taskCatalog: 'inspect_result /taskEvidenceCatalog',
    fullCatalog: 'inspect_result /evidenceCatalog',
  };
}
export function compactModelFeedback(run: AgentRun): ModelMessage[] {
  const latest = new Map<string, CallRecord>();
  const errors: { record: CallRecord; callIds: string[] }[] = [];
  for (const record of run.calls) {
    if (record.output.ok) latest.set(record.name, record);
    else {
      const repeated = errors.find(
        (e) =>
          e.record.name === record.name &&
          same(
            e.record.modelArguments ?? e.record.arguments,
            record.modelArguments ?? record.arguments,
          ) &&
          same(e.record.output, record.output),
      );
      if (repeated) {
        repeated.record = record;
        repeated.callIds.push(record.id);
      } else errors.push({ record, callIds: [record.id] });
    }
  }
  // Deduplicate the model history only, never the attempted sources or audit.
  // Repeated invalid assistant examples otherwise crowd out distinct feedback.
  const recentErrors = errors
    .sort((a, b) => run.calls.indexOf(a.record) - run.calls.indexOf(b.record))
    .slice(-CONTEXT_LIMITS.recentErrors);
  const selected = new Set([...latest.values(), ...recentErrors.map((e) => e.record)]);
  return run.calls
    .filter((record) => selected.has(record))
    .flatMap((record): ModelMessage[] => {
      let raw: any = record.output.ok ? record.output.result : record.output.error;
      // Exact local equality only: a cross-reference is never a new fact or a
      // substitute for model analysis. The original result stays inspectable.
      if (record.name === 'prepare_report' && record.output.ok) {
        raw = { ...raw };
        for (const key of ['facts', 'comparison', 'quality']) {
          const candidates = run.calls
            .slice(0, run.calls.indexOf(record))
            .filter((c) => c.output.ok);
          const duplicate = candidates.find((c) => c.output.ok && same(c.output.result, raw[key]));
          if (duplicate)
            raw[key] = {
              sameAsCall: duplicate.id,
              omitted: ['duplicate result; inspect original call'],
            };
        }
      }
      let result: unknown = record.output.ok ? projectFacts(raw) : raw;
      const rejection = !record.output.ok
        ? recentErrors.find((e) => e.record === record)
        : undefined;
      let scopeReview: unknown;
      if (record.name === 'set_task_spec' && !record.output.ok) {
        try {
          // Independent relationships remain visible even when provenance
          // validation rejects first. This never accepts or repairs the spec.
          validate(taskSpecSchema, record.arguments);
          const s = record.arguments as TaskUnderstanding['spec'];
          scopeReview = {
            sampled: [...(run.reference.range ?? [])],
            interval: s.interval,
            second: s.comparison?.second ?? null,
            view: s.deliveries.view?.interval ?? null,
            coversSampled: same(s.interval, run.reference.range),
            coversComparison:
              !s.deliveries.view || !s.interval || !s.comparison
                ? null
                : [s.interval, s.comparison.second].every(
                    ([a, b]) =>
                      s.deliveries.view!.interval[0] <= a && s.deliveries.view!.interval[1] >= b,
                  ),
            unresolved: s.unresolved,
          };
        } catch {
          /* A malformed declaration has no trustworthy range projection. */
        }
      }
      if (['set_task_spec', 'set_task_patch'].includes(record.name) && record.output.ok)
        result = { accepted: true, omitted: ['task copy: see bindings and acceptedTask'] };
      if (jsonBytes(result) > 10_000)
        result = { omitted: ['large result; inspect_result'], ok: record.output.ok };
      return [
        {
          role: 'assistant',
          content: '',
          calls: [{ name: record.name, arguments: record.modelArguments ?? record.arguments }],
        },
        {
          role: 'tool',
          toolName: record.name,
          content: JSON.stringify({
            callId: record.id,
            tool: record.name,
            ok: record.output.ok,
            [record.output.ok ? 'result' : 'error']: result,
            ...(rejection
              ? {
                  rejection: {
                    attempts: rejection.callIds.length,
                    callIds: rejection.callIds,
                    identicalArgumentsAndError: true,
                  },
                }
              : {}),
            ...(scopeReview ? { scopeReview } : {}),
            projection: 'task_facts_v3',
            evidenceCatalog: taskCatalog(record, run),
            ...(record.output.ok &&
            ![
              'inspect_result',
              'set_task_spec',
              'set_task_patch',
              'plan_analysis',
              'finish_analysis',
            ].includes(record.name)
              ? { inspection: inspectionGuide(record, run) }
              : {}),
          }),
        },
      ];
    });
}
