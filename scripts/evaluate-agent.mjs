// CLI runs the selected real provider. Injected transports are protocol tests only.
import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release } from 'node:os';
import {
  FIXED_EVALUATIONS,
  assessRun,
  assessScenario,
  observeEvaluation,
  totalCosts,
  evaluationSession,
  EVAL_PARAMETERS,
  EVALUATION_VERSION,
} from '../src/agent/evaluation.ts';
import {
  AgentRuntime,
  AGENT_SYSTEM_PROMPT,
  AGENT_INSTRUCTION_VERSION,
  MAX_FINAL_CITATIONS,
  resolveCitation,
} from '../src/agent/runtime.ts';
import { same } from '../src/agent/taskSpec.ts';
import { AGENT_PROTOCOL_VERSION } from '../src/agent/controlProtocol.ts';
import {
  MODEL_PROTOCOL_VERSION,
  MODEL_INSTRUCTION_VERSION,
  MODEL_SYSTEM_PROMPT,
} from '../src/agent/modelProtocol.ts';
import { TASK_CONTEXT_VERSION, CONTEXT_LIMITS } from '../src/agent/taskContext.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { OllamaProvider, localOllamaURL } from '../src/agent/provider.ts';
import {
  DeepSeekProvider,
  DEEPSEEK_ADDRESS,
  DEEPSEEK_MODEL,
  DEEPSEEK_INFERENCE,
} from '../src/agent/providers/deepseek.ts';
import { serializeCSV } from '../src/utils/csv.ts';
import { intervalFrames } from '../src/analysis/frameIndex.ts';
import { POINT_NAMES } from '../src/config.ts';
import { channels, JOINT_KEYS } from '../src/utils/poseMath.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');

// These identities are the two historical grants, not a directory discovery rule.
const HUMAN_INPUTS = [
  {
    id: 'human-720',
    sha256: '4619fc6b5571dfeac86420cea76e3ee27506c4b8c571ad0058d72c3138c38303',
    frames: 2011,
    joint: 'elbow',
    first: [35, 42],
    second: [50, 57],
    cleanFirst: [0.3, 5.3],
    cleanSecond: [41, 46],
  },
  {
    id: 'human-1080',
    sha256: '38d02deb423e756eedd24a5af1bc24b34568d75692c9da4da2f4261bf4672264',
    frames: 1000,
    joint: 'knee',
    first: [0, 5],
    second: [15, 20],
  },
];

export function checkedProxyOrigin(value) {
  if (!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(value))
    throw new Error('Human proxy must be an exact http://127.0.0.1:<port> origin');
  const url = new URL(value);
  if (!url.port || Number(url.port) > 65535 || url.origin !== value)
    throw new Error('Invalid human proxy port');
  return value;
}

// Same body and routes as DeepSeekPageProvider. Node supplies Origin explicitly;
// the existing server still performs its exact Host/Origin/socket validation.
function loopbackPageProvider(origin) {
  checkedProxyOrigin(origin);
  async function request(path, body, signal) {
    if (!['probe', 'complete'].includes(path)) throw new Error('INVALID_PROXY_ROUTE');
    const response = await fetch(`${origin}/__deepseek/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data.error === 'string' &&
        /^(?:DEEPSEEK_[A-Z_]+|DEEPSEEK_PROXY_UPSTREAM_HTTP_[1-5][0-9]{2})$/.test(data.error)
          ? data.error
          : `DEEPSEEK_PROXY_HTTP_${response.status}`,
      );
    return data;
  }
  return {
    id: 'deepseek-api',
    model: DEEPSEEK_MODEL,
    requestBytes: (input) =>
      Buffer.byteLength(JSON.stringify({ messages: input.messages, tools: input.tools })),
    probe: (signal) => request('probe', {}, signal),
    complete: (input) =>
      request('complete', { messages: input.messages, tools: input.tools }, input.signal),
  };
}

export function humanScenarios() {
  return HUMAN_INPUTS.map((input) => {
    const selection = { joint: input.joint, channels: ['left', 'right'], basis: 'filtered' };
    const interval = [input.first[0], input.second[1]];
    const joint = input.joint === 'elbow' ? '肘' : '膝';
    const evidence =
      input.id === 'human-720'
        ? '引用前段左右各自的有效样本、受缺失影响侧的覆盖率、最长连续缺失的计数和源时间两端，以及前段左右各一个角度极值的源时间；如不可比，另引可比性结论或原因。'
        : '引用前后段左右各自的有效样本数、两段角度单位、左右各自后减前的 ROM 变化、两段每侧最小和最大角度的源时间，以及二维投影限制。前段有效样本引用局部质量结果。';
    const goal = `基于当前真实 file 人体视频的已采样数据，比较 filtered 左右${joint} ${input.first.join('–')} 秒与 ${input.second.join('–')} 秒的 ROM，判断是否有足够数据支持片段运动幅度比较；只在可比较时解释变化，不可比较时说明具体限制。检查前段相同关节和侧别的有效样本、覆盖及连续缺失。${evidence} 展示 ${interval.join('–')} 秒图表，即使不可比较也准备保留限制的比较报告及同范围 CSV。最终提交引齐图表、报告和 CSV 的证据。区分已采样可用性与人体测量准确率，保留缺失、不可比较和二维投影限制，不判断动作对错。`;
    return {
      id: input.id,
      group: 'business',
      turns: [
        {
          goal,
          status: [input.id === 'human-720' ? 'not_comparable' : 'completed'],
          expected: [
            {
              name: 'compare_intervals',
              args: { ...selection, first: input.first, second: input.second },
            },
            {
              name: 'get_quality_summary',
              args: { interval: input.first, selection },
            },
            { name: 'set_chart_view', args: { ...selection, interval } },
            {
              name: 'prepare_report',
              args: { ...selection, interval: input.first, comparison: input.second },
            },
            { name: 'prepare_export', args: { interval, format: 'csv' } },
          ],
        },
      ],
    };
  });
}

async function readAuthorizedHumanIndex(indexPath) {
  const permittedIndex = resolve(
    root,
    '.qa/core-work/20261030-input-closure-1793357317372/input-index.json',
  );
  if (resolve(indexPath) !== permittedIndex) throw new Error('UNAUTHORIZED_HUMAN_INPUT_INDEX');
  const indexBytes = await readFile(indexPath);
  const sha256 = hash(indexBytes);
  // Freeze the original authorization without publishing local paths or names.
  if (sha256 !== 'c0b937b41c09a2c274a282f9af9892d3bce43360c8a98522cfc35dab3131028b')
    throw new Error('UNAUTHORIZED_HUMAN_INPUT_SET');
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (!Array.isArray(index.videos) || index.videos.length !== HUMAN_INPUTS.length)
    throw new Error('UNAUTHORIZED_HUMAN_INPUT_SET');
  return { index, sha256 };
}

async function humanReplayMaterials(indexPath, caseIds) {
  const { index, sha256 } = await readAuthorizedHumanIndex(indexPath);
  const { parseCSV, replayCSV } = await import('../tests/browser/files.ts');
  const materials = new Map();
  for (const allowed of HUMAN_INPUTS.filter(({ id }) => caseIds.includes(id))) {
    const entry = index.videos.find((video) => video.sha256 === allowed.sha256);
    if (!entry || entry.frames !== allowed.frames)
      throw new Error(`HUMAN_INPUT_IDENTITY:${allowed.id}`);
    const videoBytes = await readFile(entry.path);
    if (videoBytes.length !== entry.bytes || hash(videoBytes) !== allowed.sha256)
      throw new Error(`HUMAN_INPUT_HASH:${allowed.id}`);
    const directory = resolve(
      dirname(indexPath),
      allowed.id,
      'flows-authorized-human-vid-cc156-SV-and-browser-measurements-production',
    );
    const csvPath = resolve(directory, 'human-complete.csv');
    const csvBytes = await readFile(csvPath);
    const rows = parseCSV(csvBytes); // Existing parser enforces all 354 columns on every row.
    const first = rows[0];
    const verificationPath = resolve(directory, 'human-verification.json');
    const verificationBytes = await readFile(verificationPath);
    const verification = JSON.parse(verificationBytes.toString('utf8'));
    if (
      !verification.passed ||
      verification.input.sha256 !== allowed.sha256 ||
      resolve(verification.input.path) !== resolve(entry.path) ||
      verification.fullCSV.rows !== entry.frames ||
      verification.fullCSV.columns !== 354 ||
      rows.length !== entry.frames ||
      !Array.isArray(entry.pts) ||
      entry.pts.length !== rows.length ||
      rows.some((row, i) => Number(row.time_s) !== entry.pts[i]) ||
      Number(first.time_s) !== entry.first ||
      Number(rows.at(-1).time_s) !== entry.last
    )
      throw new Error(`HUMAN_REPLAY_PTS_OR_VERIFICATION:${allowed.id}`);
    const keys = [
      'session_id',
      'session_revision',
      'source',
      'synthetic',
      'metric_version',
      'confidence_threshold',
      'filter_window_frames',
      'source_aspect',
      'acquisition_mode',
      'acquisition_status',
      'source_expected_frames',
      'source_processed_frames',
      'source_codec',
      'source_rotation_deg',
      'media_time_offset_s',
    ];
    if (
      rows.some((row) => keys.some((key) => row[key] !== first[key])) ||
      first.source !== 'file' ||
      first.synthetic !== 'false' ||
      first.metric_version !== '2.0' ||
      first.acquisition_mode !== 'webcodecs' ||
      first.acquisition_status !== 'completed' ||
      Number(first.source_expected_frames) !== entry.frames ||
      Number(first.source_processed_frames) !== entry.frames ||
      Number(first.source_aspect) !== entry.aspect ||
      first.source_codec !== entry.codec ||
      Number(first.source_rotation_deg) !== entry.rotation ||
      Number(first.media_time_offset_s) !== entry.mediaTimeOffset
    )
      throw new Error(`HUMAN_REPLAY_METADATA:${allowed.id}`);
    const session = replayCSV(rows); // Actual product session/filter/metrics, no inference.
    session.setAcquisition({
      mode: 'webcodecs',
      status: 'completed',
      expectedFrames: entry.frames,
      processedFrames: rows.length,
      codec: entry.codec,
      rotation: entry.rotation,
      mediaTimeOffset: entry.mediaTimeOffset,
    });
    const provenance = {
      id: allowed.id,
      kind: 'historical-human-inference-replay',
      newPageInference: false,
      original: {
        path: entry.path,
        bytes: entry.bytes,
        sha256: allowed.sha256,
        display: entry.display,
        codec: entry.codec,
        range: [entry.first, entry.last],
        frames: entry.frames,
        reference: { sessionId: first.session_id, revision: Number(first.session_revision) },
      },
      index: { path: indexPath, sha256 },
      csv: { path: csvPath, sha256: hash(csvBytes), columns: 354, rows: rows.length },
      verification: { path: verificationPath, sha256: hash(verificationBytes) },
      allSourcePTSMatch: true,
      complete: true,
      replay: session.info(),
      limitations: [
        '旧浏览器 MediaPipe 推理数据在当前 AnalysisSession 中回放；本轮没有新页面人体推理。',
        '可用性、置信度与 CSV 一致性不是真值；Q1 缺独立同帧参考，不能判断人体测量准确率。',
        '单人单目二维投影，不提供跨人物身份追踪、动作对错或医疗诊断。',
      ],
    };
    materials.set(allowed.id, { allowed, session, provenance });
  }
  return materials;
}

// The real acceptance tasks fit inside the frozen selected exports. Restore
// their computed frames directly, so the product tools can query them without
// opening a video or replaying the landmark filter.
export async function frozenHumanMaterials(indexPath, caseIds = HUMAN_INPUTS.map(({ id }) => id)) {
  const { index } = await readAuthorizedHumanIndex(indexPath);
  const { parseCSV } = await import('../tests/browser/files.ts');
  const baseline = JSON.parse(
    await readFile(resolve(root, '.qa/core-work/20261104-data-baseline/baseline.json'), 'utf8'),
  );
  const materials = new Map();
  for (const allowed of HUMAN_INPUTS.filter(({ id }) => caseIds.includes(id))) {
    const entry = baseline.materials.find((value) => value.id === allowed.id);
    const original = index.videos.find((video) => video.sha256 === allowed.sha256);
    if (
      !entry ||
      !original ||
      resolve(root, entry.index.path) !== resolve(indexPath) ||
      resolve(entry.original.path) !== resolve(original.path) ||
      entry.original.sha256 !== allowed.sha256 ||
      entry.original.frames !== allowed.frames ||
      !entry.historicalComplete ||
      !entry.historicalAllSourcePTSMatch
    )
      throw new Error(`HUMAN_FROZEN_IDENTITY:${allowed.id}`);
    const source = async (file) => {
      const path = resolve(root, file.path);
      const bytes = await readFile(path);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error(`HUMAN_FROZEN_HASH:${allowed.id}`);
      return bytes;
    };
    const sidecar = JSON.parse(await source(entry.localAnalysis));
    const rows = parseCSV(await source(entry.selectedCSV));
    const range = [allowed.first[0], allowed.second[1]];
    const { sessionId, revision } = entry.historicalReplayReference;
    if (
      rows.length !== entry.selectedCSV.rows ||
      Number(rows[0].time_s) !== range[0] ||
      Number(rows.at(-1).time_s) !== range[1] ||
      rows.some(
        (row, index) =>
          row.session_id !== sessionId ||
          Number(row.session_revision) !== revision ||
          row.source !== 'file' ||
          row.synthetic !== 'false' ||
          (index > 0 && !(Number(row.time_s) > Number(rows[index - 1].time_s))),
      ) ||
      sidecar.provenance.replay.sessionId !== sessionId ||
      sidecar.provenance.replay.revision !== revision ||
      sidecar.csvValidation.sha256 !== entry.selectedCSV.sha256 ||
      !sidecar.csvValidation.allSelectedSourcePTSMatch ||
      !sidecar.csvValidation.selectedJointNullSamplesPreserved
    )
      throw new Error(`HUMAN_FROZEN_SCOPE:${allowed.id}`);
    const frames = rows.map(restoreFrame);
    const info = {
      ...sidecar.provenance.replay,
      sessionId: randomUUID(),
      range,
      sampleCount: frames.length,
    };
    const session = {
      frames,
      info: () => structuredClone(info),
      assertCurrent(ref) {
        if (ref.sessionId !== info.sessionId || ref.revision !== info.revision)
          throw new Error('STALE_SESSION');
      },
    };
    const provenance = {
      ...sidecar.provenance,
      kind: 'frozen-computed-frame-snapshot',
      selectedCSV: entry.selectedCSV,
      frozenReference: entry.historicalReplayReference,
      replay: info,
    };
    materials.set(allowed.id, { allowed, session, provenance, sidecar });
  }
  return materials;
}

export function humanSubmissionEvidence(scenario, sidecar) {
  const quality = 'get_quality_summary';
  const compare = 'compare_intervals';
  const frozen = { [quality]: sidecar.report.quality, [compare]: sidecar.comparison };
  const requirements = [];
  const requireEvidence = (tool, ...paths) => {
    requirements.push({
      tool,
      facts: paths.map((path) => ({
        path,
        ...(frozen[tool] ? { value: resolveCitation(frozen[tool], path) } : {}),
      })),
    });
  };
  const limited = scenario.id === 'human-720';
  for (const side of [0, 1]) {
    requireEvidence(quality, `/selection/channels/${side}/validSamples`);
    if (limited) {
      requireEvidence(
        compare,
        ...['minimum', 'maximum'].map((event) => `/first/channels/${side}/events/${event}/time`),
      );
    } else {
      requireEvidence(compare, `/second/channels/${side}/angle/sampleCount`);
      requireEvidence(compare, `/differences/${side}/rom`);
      for (const part of ['first', 'second'])
        for (const event of ['minimum', 'maximum'])
          requireEvidence(compare, `/${part}/channels/${side}/events/${event}/time`);
    }
  }
  if (limited) {
    const right = '/selection/channels/1';
    requireEvidence(quality, `${right}/coverage`);
    for (const field of ['samples', 'interval/0', 'interval/1'])
      requireEvidence(quality, `${right}/longestMissingInterval/${field}`);
    requireEvidence(compare, '/comparable', '/reasons/0');
  } else {
    requireEvidence(compare, '/first/units/angle');
    requireEvidence(compare, '/second/units/angle');
    requireEvidence(compare, '/first/evidence/limitations/0', '/second/evidence/limitations/0');
  }
  requireEvidence('set_chart_view', '/view/basis');
  requireEvidence('prepare_report', '/handle');
  requireEvidence('prepare_export', '/handle');
  if (requirements.length > MAX_FINAL_CITATIONS)
    throw new Error(
      `HUMAN_CITATION_BUDGET:${scenario.id}:${requirements.length}/${MAX_FINAL_CITATIONS}`,
    );
  return {
    requiredCitations: requirements.length,
    gaps(run, citations) {
      const calls = new Map();
      for (const { name, args } of scenario.turns[0].expected) {
        const call = run.calls.findLast((c) => c.name === name && c.output.ok);
        if (call && Object.entries(args).every(([key, value]) => same(call.arguments[key], value)))
          calls.set(name, call);
      }
      return requirements.flatMap(({ tool, facts }) => {
        const call = calls.get(tool);
        const valid = call
          ? facts.filter(({ path, ...expected }) => {
              try {
                const value = resolveCitation(call.output.result, path);
                return Object.hasOwn(expected, 'value')
                  ? same(value, expected.value)
                  : value !== null;
              } catch {
                return false;
              }
            })
          : [];
        if (
          valid.some(({ path }) => citations.some((c) => c.callId === call.id && c.path === path))
        )
          return [];
        return [
          {
            tool,
            labels: (valid.length ? valid : facts).map(({ path }) =>
              path.slice(1).replaceAll('/', '.'),
            ),
            reason: !call
              ? 'missing_tool_or_scope'
              : valid.length
                ? 'missing_citation'
                : 'fact_mismatch',
          },
        ];
      });
    },
  };
}

function restoreFrame(row) {
  const number = (key) => (row[key] === '' ? null : Number(row[key]));
  const points = (basis) =>
    row[`${basis}_nose_x`] === ''
      ? []
      : POINT_NAMES.map((name) =>
          Object.fromEntries(
            ['x', 'y', 'z', 'visibility'].map((key) => [key, number(`${basis}_${name}_${key}`)]),
          ),
        );
  const angles = (basis, suffix) =>
    Object.fromEntries(
      JOINT_KEYS.map((joint) => [
        joint,
        Object.fromEntries(
          channels(joint).map((side) => [side, number(`${basis}_${joint}_${side}_${suffix}`)]),
        ),
      ]),
    );
  const variance = (basis) => ({
    value: number(`${basis}_coordinate_variance_norm2`),
    unit: 'normalized_coordinate²',
    windowFrames: number(`${basis}_window_frames`),
    validPoints: number(`${basis}_valid_points`),
    validSamples: number(`${basis}_valid_point_samples`),
    minSamplesPerPoint: number(`${basis}_min_samples_per_point`),
    maxSamplesPerPoint: number(`${basis}_max_samples_per_point`),
  });
  const filteredVariance = variance('filtered');
  return {
    time: number('time_s'),
    rawPoints: points('raw'),
    points: points('filtered'),
    angles: angles('filtered', 'deg'),
    velocity: angles('filtered', 'velocity_deg_s'),
    rawAngles: angles('raw', 'deg'),
    rawVelocity: angles('raw', 'velocity_deg_s'),
    variance: { raw: variance('raw'), filtered: filteredVariance },
    windowInterval: [number('window_start_s'), number('window_end_s')],
    center: row.center_x === '' ? null : { x: number('center_x'), y: number('center_y') },
    confidence: number('confidence'),
    asymmetry: number('asymmetry_percent'),
    heightDifference: {
      shoulder: number('shoulder_height_delta'),
      hip: number('hip_height_delta'),
      knee: number('knee_height_delta'),
    },
    stability: filteredVariance.value,
  };
}

async function writeHumanLocalOutputs(materials, output) {
  const written = [];
  const { parseCSV } = await import('../tests/browser/files.ts');
  const inputReview = {
    kind: 'authorized-human-input-and-product-gap-review',
    checkedAt: new Date().toISOString(),
    initialState: null,
    baselineTools: null,
    currentTools: {
      path: 'src/analysis/tools.ts',
      sha256: hash(await readFile(resolve(root, 'src/analysis/tools.ts'))),
    },
    inputs: [...materials.values()].map((v) => v.provenance),
    localBlindSpot: null,
    boundary:
      'No new inference or model/probe requests. All values are product-computed availability/2D projection statistics, not ground-truth accuracy.',
  };
  const initialPath = resolve(dirname(output), 'initial-state.json');
  try {
    const initialBytes = await readFile(initialPath);
    const initial = JSON.parse(initialBytes.toString('utf8'));
    inputReview.initialState = { path: initialPath, sha256: hash(initialBytes) };
    inputReview.baselineTools =
      initial.baseline?.find((file) => file.path === 'src/analysis/tools.ts') ?? null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const joints = ['shoulder', 'elbow', 'hip', 'knee', 'ankle', 'spine', 'wrist'];
  for (const { allowed, session, provenance } of materials.values()) {
    const registry = createToolRegistry(session);
    const info = session.info();
    const reference = { sessionId: info.sessionId, revision: info.revision };
    const execute = (name, args) => {
      const result = registry.execute(name, { ...reference, ...args });
      if (!result.ok)
        throw new Error(`LOCAL_HUMAN_TOOL:${allowed.id}:${name}:${result.error.code}`);
      return result.result;
    };
    const channelQuality = joints.map((joint) =>
      execute('get_quality_summary', {
        interval: info.range,
        selection: {
          joint,
          channels: joint === 'spine' ? ['midline'] : ['left', 'right'],
          basis: 'filtered',
        },
      }),
    );
    if (channelQuality.some((quality) => !quality.selection))
      throw new Error('LOCAL_JOINT_QUALITY_UNAVAILABLE');
    const selection = { joint: allowed.joint, channels: ['left', 'right'], basis: 'filtered' };
    const interval = [allowed.first[0], allowed.second[1]];
    const comparison = execute('compare_intervals', {
      ...selection,
      first: allowed.first,
      second: allowed.second,
    });
    const data = {
      sidecarVersion: '1.0.0',
      checkedAt: new Date().toISOString(),
      provenance,
      quality: execute('get_quality_summary', { interval: info.range }),
      channelQuality,
      selected: execute('query_metrics', { ...selection, interval: info.range }),
      comparison,
      cleanComparison: allowed.cleanFirst
        ? execute('compare_intervals', {
            ...selection,
            first: allowed.cleanFirst,
            second: allowed.cleanSecond,
          })
        : null,
      localBlindSpot:
        allowed.id === 'human-720'
          ? {
              quality: execute('get_quality_summary', { interval: [35, 42], selection }),
              metrics: execute('query_metrics', { ...selection, interval: [35, 42] }),
              limitation:
                '这是本地旁表检查范围；不能声称真实 Agent 已检查该区间，除非其审计存在对应工具调用。',
            }
          : null,
      report: execute('prepare_report', {
        ...selection,
        interval: allowed.first,
        comparison: allowed.second,
      }),
      csv: execute('prepare_export', { interval, format: 'csv' }),
      agentAcceptance: 'not_run_local_computation_only',
    };
    const jsonPath = `${output}.${allowed.id}.local.json`;
    const csvPath = `${output}.${allowed.id}.selected.csv`;
    const markdownPath = `${output}.${allowed.id}.analysis.md`;
    const exportedFrames = intervalFrames(session.frames, interval);
    const csv = serializeCSV(exportedFrames, [], info);
    const csvRows = parseCSV(Buffer.from(csv, 'utf8'));
    if (
      csvRows.length !== exportedFrames.length ||
      csvRows.some((row, i) => {
        const frame = exportedFrames[i];
        return (
          Number(row.time_s) !== frame.time ||
          row.session_id !== info.sessionId ||
          Number(row.session_revision) !== info.revision ||
          (row.raw_nose_x === '') !== (frame.rawPoints.length === 0) ||
          (row.filtered_nose_x === '') !== (frame.points.length === 0) ||
          ['left', 'right'].some(
            (channel) =>
              (row[`raw_${allowed.joint}_${channel}_deg`] === '') !==
                (frame.rawAngles[allowed.joint][channel] === null) ||
              (row[`filtered_${allowed.joint}_${channel}_deg`] === '') !==
                (frame.angles[allowed.joint][channel] === null),
          )
        );
      })
    )
      throw new Error(`HUMAN_SELECTED_CSV_CONTRACT:${allowed.id}`);
    data.csvValidation = {
      path: csvPath,
      sha256: hash(csv),
      rows: csvRows.length,
      columns: 354,
      allSelectedSourcePTSMatch: true,
      emptyFramesPreserved: true,
      selectedJointNullSamplesPreserved: true,
      currentReplayReferencePreserved: true,
      scope:
        '354-column structure, selected PTS, empty frames, selected angle nulls and current reference; no repeated full-column geometry or human-accuracy test',
    };
    const jsonContents = JSON.stringify(data, null, 2) + '\n';
    await writeFile(jsonPath, jsonContents, { flag: 'wx' });
    if (data.localBlindSpot)
      inputReview.localBlindSpot = {
        id: allowed.id,
        interval: [35, 42],
        globalSummaryUnderPreservedDefinition: {
          definition:
            'all 33 raw landmarks simultaneously above threshold; no selected-joint availability in the baseline API',
          computedWith: inputReview.currentTools,
          result: execute('get_quality_summary', { interval: [35, 42] }),
        },
        selectedJointSummary: data.localBlindSpot.quality,
        resultDifference:
          'Global reliability cannot distinguish the fully available left elbow from the long right-elbow gap; the selected-joint output supplies the missing side-specific evidence.',
      };
    await writeFile(csvPath, csv, { flag: 'wx' });
    const table = channelQuality.flatMap((q) =>
      q.selection.channels.map(
        (c) =>
          `| ${q.selection.joint} | ${c.channel} | ${c.validSamples}/${q.evidence.sampleCount} | ${(100 * c.coverage).toFixed(2)}% | ${c.longestMissingInterval ? `${c.longestMissingInterval.interval.join('–')} s (${c.longestMissingInterval.samples}帧)` : '无'} |`,
      ),
    );
    const changes = comparison.differences.map((d, i) => {
      const first = comparison.first.channels[i],
        second = comparison.second.channels[i];
      const extrema = [comparison.first, comparison.second].map((part) => {
        const channel = part.channels[i];
        return `${part.evidence.interval.join('–')} s：最小${channel.angle.min}°@${channel.events.minimum?.time ?? '缺失'} s，最大${channel.angle.max}°@${channel.events.maximum?.time ?? '缺失'} s`;
      });
      return `- ${d.channel}：前段 ROM ${first.rom}°，后段 ${second.rom}°，后减前 ${d.rom}°。${extrema.join('；')}。`;
    });
    const markdown = [
      `# ${allowed.id}：旧人体推理数据的当前产品分析`,
      '',
      `原件：${provenance.original.path}；SHA-256 ${allowed.sha256}。`,
      '',
      `源 PTS ${info.range.join('–')} s；解析 completed，${info.sampleCount}/${provenance.original.frames} 帧，与索引全部 PTS 一致。未检出 ${data.quality.missingSamples} 帧。当前回放版本 ${info.sessionId}@${info.revision}。`,
      '',
      '下表分母包含未检出帧；可用指所选二维角度非空，按当前阈值与滤波参数本地计算。连续区间端点是实际样本时刻，不代表精确遮挡起止或时间覆盖率。',
      '',
      '| 关节 | 侧别 | 有效/全部样本 | 帧覆盖 | 最长连续缺失 |',
      '| --- | --- | --- | --- | --- |',
      ...table,
      '',
      `同口径等长比较：filtered ${allowed.joint}，前段 ${allowed.first.join('–')} s，后段 ${allowed.second.join('–')} s；可比较=${comparison.comparable}；${comparison.reasons.join('；') || '两段均满足当前产品的样本/帧覆盖/时长门槛'}。`,
      '',
      ...changes,
      '',
      ...(data.cleanComparison
        ? [
            `另外的同口径可比片段：${allowed.cleanFirst.join('–')} s 与 ${allowed.cleanSecond.join('–')} s；filtered 双肘均各151/151有效。以下只描述这两个观测完整片段，不能补足35–42 s缺失：`,
            '',
            ...data.cleanComparison.differences.map(
              (d, i) =>
                `- ${d.channel}：前段ROM ${data.cleanComparison.first.channels[i].rom}°，后段 ${data.cleanComparison.second.channels[i].rom}°，后减前 ${d.rom}°。`,
            ),
            '',
          ]
        : []),
      ...(data.localBlindSpot
        ? [
            '35–42 s 双肘盲区：',
            '',
            ...data.localBlindSpot.quality.selection.channels.map(
              (c) =>
                `- ${c.channel}：${c.validSamples}/${data.localBlindSpot.quality.evidence.sampleCount} 有效；最长连续缺失 ${c.longestMissingInterval ? c.longestMissingInterval.interval.join('–') + ' s' : '无'}。`,
            ),
            '',
            '该区间侧别可用性明显不同，不能用全点平均置信度推断双肘数据完整，也不能将观测子集极值当成缺失时段的运动范围。',
            '',
          ]
        : []),
      '这些比较回答“所选两个片段的可观测投影角变化幅度是否不同”，不能单独解释训练改善、动作对错或医学意义。相同长度和高覆盖也不证明相同动作、视角或阶段，未做动作配准。',
      '',
      ...provenance.limitations.map((v) => `- ${v}`),
      '',
      `机器证据：${jsonPath}；354列选定区间 CSV：${csvPath}。全部质量/极值/报告由现有本地工具计算。真实 Agent 验收另见主记录；本文件本身不证明模型成功、页面绘制或原生落盘。`,
      '',
    ].join('\n');
    await writeFile(markdownPath, markdown, { flag: 'wx' });
    written.push({ id: allowed.id, jsonPath, csvPath, markdownPath, sha256: hash(jsonContents) });
  }
  const reviewPath = `${output}.input-review.json`;
  await writeFile(reviewPath, JSON.stringify(inputReview, null, 2) + '\n', { flag: 'wx' });
  written.push({ kind: 'input-and-gap-review', path: reviewPath });
  return written;
}

export function parseEvaluationArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      'skip-real': { type: 'boolean' },
      provider: { type: 'string', default: 'ollama' },
      address: { type: 'string' },
      model: { type: 'string' },
      repeat: { type: 'string', default: '2' },
      case: { type: 'string', multiple: true },
      output: { type: 'string' },
      conditions: { type: 'string' },
      'max-business-requests': { type: 'string' },
      'max-business-ms': { type: 'string' },
      'human-input-index': { type: 'string' },
      'proxy-origin': { type: 'string' },
      'local-only': { type: 'boolean' },
    },
  });
  const human = values['human-input-index'] !== undefined;
  if ((values['proxy-origin'] || values['local-only']) && !human)
    throw new Error('--proxy-origin and --local-only require --human-input-index');
  if (
    human &&
    (values.address ||
      (args.some((arg) => arg === '--repeat' || arg.startsWith('--repeat=')) &&
        values.repeat !== '1') ||
      (args.some((arg) => arg === '--provider' || arg.startsWith('--provider=')) &&
        values.provider !== 'deepseek'))
  )
    throw new Error('Human replay uses the selected fixed tasks once, without --address');
  if (human && values.model && values.model !== DEEPSEEK_MODEL)
    throw new Error('Human acceptance uses the existing deepseek-flash model only');
  const proxyOrigin = values['proxy-origin'] ? checkedProxyOrigin(values['proxy-origin']) : null;
  if (human && !values['local-only'] && !proxyOrigin)
    throw new Error('Human real acceptance requires --proxy-origin http://127.0.0.1:<port>');
  if (!['ollama', 'deepseek'].includes(values.provider))
    throw new Error('provider must be ollama or deepseek');
  if (
    values.provider === 'deepseek' &&
    values.address !== undefined &&
    values.address !== DEEPSEEK_ADDRESS
  )
    throw new Error('DeepSeek evaluation uses the official https://api.deepseek.com only');
  const repetitions = Number(values.repeat);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('repeat must be 1–5');
  const availableCases = (human ? HUMAN_INPUTS : FIXED_EVALUATIONS).map(({ id }) => id);
  const caseIds = [...new Set(values.case?.flatMap((v) => v.split(',')) ?? availableCases)];
  if (!caseIds.length || caseIds.some((id) => !availableCases.includes(id)))
    throw new Error(`Unknown --case; choose: ${availableCases.join(',')}`);
  const budget = {};
  for (const [flag, key] of [
    ['max-business-requests', 'requests'],
    ['max-business-ms', 'ms'],
  ]) {
    if (values[flag] !== undefined) {
      const value = Number(values[flag]);
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${flag} must be a positive integer`);
      budget[key] = value;
    }
  }
  if (human && ((budget.requests ?? 24) > 24 || (budget.ms ?? 240000) > 240000))
    throw new Error('Human batch budget cannot exceed 24 business requests / 240000 ms');
  return {
    help: values.help ?? false,
    skipReal: values['skip-real'] ?? false,
    provider: human ? 'deepseek' : values.provider,
    address: human
      ? proxyOrigin
      : values.provider === 'deepseek'
        ? DEEPSEEK_ADDRESS
        : localOllamaURL(values.address ?? 'http://127.0.0.1:11434'),
    model: human
      ? DEEPSEEK_MODEL
      : (values.model ?? (values.provider === 'deepseek' ? DEEPSEEK_MODEL : null)),
    humanInputIndex: human ? resolve(values['human-input-index']) : null,
    proxyOrigin,
    localOnly: values['local-only'] ?? false,
    conditions: values.conditions ? resolve(values.conditions) : null,
    repetitions: human ? 1 : repetitions,
    budget: human ? { requests: 24, ms: 240000, ...budget } : budget,
    caseIds,
    output: resolve(
      values.output ??
        `.qa/agent-evaluation-v${EVALUATION_VERSION}-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
    ),
  };
}

export async function evaluationFingerprints(config) {
  async function sources(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? sources(resolve(path, e.name))
            : /\.(ts|vue|mjs)$/.test(e.name)
              ? [resolve(path, e.name)]
              : [],
        ),
      )
    ).flat();
  }
  const paths = [
    ...(await sources(resolve(root, 'src'))),
    ...(await sources(resolve(root, 'scripts'))),
    resolve(root, 'package.json'),
    resolve(root, 'pnpm-lock.yaml'),
  ].sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: hash(await readFile(path)),
    })),
  );
  return {
    algorithm: 'sha256',
    config: hash(JSON.stringify(config)),
    code: hash(JSON.stringify(files)),
    material: hash(JSON.stringify(evaluationSession().frames.map((f) => [f.time, f.rawPoints]))),
    files,
  };
}

export function summarizeEvaluation(record, scenarios) {
  function counts(rows, planned) {
    const completed = rows.filter((r) => r.assessment !== null);
    const passed = completed.filter((r) => r.assessment.passed).length;
    return {
      planned,
      started: rows.length,
      executed: completed.length,
      passed,
      failed: completed.length - passed,
      incomplete: rows.length - completed.length,
      unexecuted: planned - completed.length,
      successRate: completed.length ? passed / completed.length : null,
      ...totalCosts(rows.flatMap((r) => r.turns.map((t) => t.run))),
    };
  }
  return {
    ...counts(record.runs, scenarios.length * record.repetitions),
    groups: Object.fromEntries(
      ['business', 'boundary', 'protection'].map((group) => [
        group,
        counts(
          record.runs.filter((r) => r.group === group),
          scenarios.filter((s) => s.group === group).length * record.repetitions,
        ),
      ]),
    ),
  };
}

export async function runEvaluation(options, dependencies = {}) {
  const human = !!options.humanInputIndex;
  const admittedProbe = dependencies.admittedHumanProbe;
  if (
    admittedProbe &&
    (!human ||
      options.localOnly ||
      options.skipReal ||
      admittedProbe.status !== 'passed' ||
      admittedProbe.requests !== 1 ||
      !admittedProbe.evidencePath)
  )
    throw new Error('INVALID_HUMAN_CONNECTION_ADMISSION');
  if (human && (dependencies.provider || dependencies.fetch || dependencies.apiKey))
    throw new Error('Human acceptance does not accept injected providers, fetch or credentials');
  if (
    human &&
    (options.repetitions !== 1 ||
      options.model !== DEEPSEEK_MODEL ||
      !Number.isSafeInteger(options.budget?.requests) ||
      options.budget.requests < 1 ||
      options.budget.requests > 24 ||
      !Number.isSafeInteger(options.budget?.ms) ||
      options.budget.ms < 1 ||
      options.budget.ms > 240000)
  )
    throw new Error('INVALID_HUMAN_ACCEPTANCE_BUDGET_OR_MODEL');
  const scenarios = (human ? humanScenarios() : FIXED_EVALUATIONS).filter((c) =>
    options.caseIds.includes(c.id),
  );
  const selectedCaseIds = scenarios.map(({ id }) => id);
  const deepseek = options.provider === 'deepseek';
  const scripted = !!(dependencies.provider || dependencies.fetch || dependencies.apiKey);
  const legacy = dependencies.modelProtocol === 'legacy-v2';
  const prompt = legacy ? AGENT_SYSTEM_PROMPT : MODEL_SYSTEM_PROMPT;
  const config = {
    evaluationVersion: EVALUATION_VERSION,
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
    modelProtocolVersion: legacy ? '2.0.0' : MODEL_PROTOCOL_VERSION,
    instructionVersion: legacy ? AGENT_INSTRUCTION_VERSION : MODEL_INSTRUCTION_VERSION,
    systemPrompt: { content: prompt, sha256: hash(prompt) },
    parameters: human ? 'per-human-replay-material' : EVAL_PARAMETERS,
    cases: scenarios,
    repetitions: options.repetitions,
    address: human ? options.proxyOrigin : options.address,
    provider: options.provider ?? 'ollama',
    model: options.model,
    skipReal: options.skipReal,
    inference: deepseek
      ? DEEPSEEK_INFERENCE
      : { temperature: 0, num_ctx: 16384, num_predict: 2048, stream: false, think: false },
    limits: {
      rounds: 12,
      calls: 24,
      recoveries: 3,
      timeoutMs: human ? 120000 : 240000,
      requestMs: 60000,
    },
    taskContextVersion: TASK_CONTEXT_VERSION,
    contextLimits: CONTEXT_LIMITS,
    ...(human
      ? {
          material: options.localOnly
            ? 'historical-human-inference-replay'
            : 'frozen-computed-frame-snapshot',
          humanInputIndex: options.humanInputIndex,
          localOnly: options.localOnly,
          perTargetBusinessBudget: { requests: 12, ms: 120000 },
          maximumBatchBusinessBudget: { requests: 24, ms: 240000 },
          firstFailureStopsBatch: true,
          retries: 0,
        }
      : {}),
    measurementConditions: {
      thermalState: 'unknown',
      powerMode: null,
      modelResidency: null,
      backgroundLoad: null,
      serviceVersion: null,
      modelFingerprint: null,
      ...(options.conditions ? JSON.parse(await readFile(options.conditions, 'utf8')) : {}),
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? null,
      logicalCPUs: cpus().length,
      totalMemoryBytes: totalmem(),
      pnpm: process.env.npm_config_user_agent?.match(/pnpm\/([^ ]+)/)?.[1] ?? null,
    },
  };
  config.businessBudget = options.budget ?? {};
  const record = {
    id: randomUUID(),
    evaluationVersion: EVALUATION_VERSION,
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
    checkedAt: new Date().toISOString(),
    provider: dependencies.provider?.id ?? (deepseek ? 'deepseek-api' : 'ollama-local'),
    model: options.model,
    address: human ? options.proxyOrigin : options.address,
    evidenceKind:
      human && options.localOnly
        ? 'local-product-computation'
        : scripted
          ? 'scripted-protocol-only'
          : 'real-model',
    synthetic: !human,
    status: 'not_run',
    plannedCases: scenarios.length,
    repetitions: options.repetitions,
    config,
    fingerprints: await evaluationFingerprints(config),
    ...(human ? { humanMaterials: [], localOutputs: [], retries: 0, protocolCorrections: [] } : {}),
    headlessViewPorts:
      'actual state application; chart rendering/browser CORS require separate browser evidence',
    runs: [],
    auditFiles: [],
    baseline: null,
    baselinePolicy: {
      status: 'skipped',
      reason: 'fixed_snapshot_summary_unrelated_to_agent_evaluation',
      requests: 0,
    },
    summary: null,
    error: null,
    connectionProbe: {
      status: 'not_run',
      requests: 0,
      scope: 'connection_only_excluded_from_business',
    },
    checkpoint: null,
    businessBudget: {
      ...config.businessBudget,
      startedAt: null,
      elapsedMs: 0,
      requests: 0,
      stoppedBy: null,
    },
    costs:
      'elapsedMs in milliseconds; rounds count returned model replies; requests include failed attempts; request inputBytes are UTF-8 normalized messages+tools, wireBytes are exact adapter JSON bytes when available, neither is tokens; token totals require every request reported, otherwise null with known subtotal; probe excluded; baseline separate; no estimated fees',
    remoteCI: 'not_run',
  };
  if (human) record.fingerprints.material = null;
  record.summary = summarizeEvaluation(record, scenarios);
  // Reserve a NEW file before any model request. Never overwrite historical records.
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  let sequence = 0;
  async function checkpoint(reason) {
    record.summary = summarizeEvaluation(record, scenarios);
    if (human) {
      const business = record.runs.flatMap((entry) =>
        entry.turns.flatMap((turn) => turn.run.requests ?? []),
      );
      record.requestAccounting = {
        probeRequests: record.connectionProbe.requests ?? 0,
        businessRequests: record.businessBudget.requests,
        retries: 0,
        failedBusinessRequests: business.filter((request) => request.status === 'failed').length,
        unknownTokenCostBusinessRequests: business.filter(
          (request) => request.inputTokens === null || request.outputTokens === null,
        ).length,
        unknownProbeCostRequests: record.connectionProbe.unknownCostRequests ?? 0,
        protocolRejectedCalls: record.runs.flatMap((entry) =>
          entry.turns.flatMap((turn) =>
            turn.run.calls
              .filter((call) => !call.output.ok)
              .map((call) => ({
                caseId: entry.caseId,
                runId: turn.run.id,
                callId: call.id,
                name: call.name,
                code: call.output.error.code,
              })),
          ),
        ),
      };
    }
    if (record.baseline)
      record.baseline.costs = totalCosts(
        record.baseline.turns.map((t) => ({
          calls: [],
          elapsedMs: t.elapsedMs,
          usage: {
            ...t.usage,
            reportedRequests: t.usage.inputTokens !== null || t.usage.outputTokens !== null ? 1 : 0,
          },
        })),
      );
    const path = `${options.output}.checkpoint-${String(++sequence).padStart(4, '0')}.json`;
    record.checkpoint = { sequence, reason, path, at: new Date().toISOString() };
    const contents = JSON.stringify(record, null, 2) + '\n';
    await writeFile(path, contents, { flag: 'wx' });
    const temporary = `${options.output}.${record.id}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    try {
      // Windows scanners/watchers can briefly hold the destination open.
      // Retry only sharing/permission errors, with a bounded wait; preserve
      // atomic replacement and never truncate the previous checkpoint.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, options.output);
          break;
        } catch (error) {
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
            attempt >= 5
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } finally {
      // A failed replace must not leave a temp file that masks the original
      // failure with EEXIST when the final checkpoint records the error.
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await dependencies.onCheckpoint?.(structuredClone(record));
  }
  let active;
  let budgetTimer;
  let targetTimer;
  let businessStarted;
  const humanEvidence = new Map();
  let humanMaterials;
  let exitCode = 0;
  const controller = dependencies.controller ?? new AbortController();
  const stopBudget = (reason) => {
    record.businessBudget.stoppedBy ??= reason;
    controller.abort(reason);
    active?.cancel();
  };
  const stop = () => {
    controller.abort('cancelled');
    active?.cancel();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
  try {
    await checkpoint('initialized');
    if (human) {
      humanMaterials = options.localOnly
        ? await humanReplayMaterials(options.humanInputIndex, selectedCaseIds)
        : await frozenHumanMaterials(options.humanInputIndex, selectedCaseIds);
      record.humanMaterials = [...humanMaterials.values()].map((v) => v.provenance);
      config.parameters = Object.fromEntries(
        record.humanMaterials.map((material) => [material.id, material.replay.parameters]),
      );
      record.fingerprints.config = hash(JSON.stringify(config));
      record.fingerprints.material = hash(JSON.stringify(record.humanMaterials));
      if (options.localOnly) {
        record.localOutputs = await writeHumanLocalOutputs(humanMaterials, options.output);
        await checkpoint('human_replay_and_local_outputs_verified');
      } else {
        for (const scenario of scenarios) {
          const evidence = humanSubmissionEvidence(
            scenario,
            humanMaterials.get(scenario.id).sidecar,
          );
          humanEvidence.set(scenario.id, evidence);
        }
        record.citationBudget = {
          maximum: MAX_FINAL_CITATIONS,
          required: Object.fromEntries(
            [...humanEvidence].map(([id, evidence]) => [id, evidence.requiredCitations]),
          ),
        };
        await checkpoint('frozen_human_inputs_verified');
      }
    }
    if (human && options.localOnly) record.status = 'local_only_no_model_requests';
    else if (options.skipReal) record.status = 'skipped_model_unavailable';
    else {
      if (!options.model)
        throw new Error(
          'Supply an installed local tools model with --model. No model is assumed or downloaded.',
        );
      const provider =
        dependencies.provider ??
        (human
          ? loopbackPageProvider(options.proxyOrigin)
          : deepseek
            ? new DeepSeekProvider(
                dependencies.apiKey ?? process.env.DEEPSEEK_API_KEY,
                options.model,
                dependencies.fetch,
              )
            : new OllamaProvider(options.address, options.model, dependencies.fetch));
      record.status = 'running';
      if (admittedProbe) {
        record.connectionProbe = { ...record.connectionProbe, ...admittedProbe };
      } else {
        await checkpoint('before_probe');
        const probeStarted = performance.now();
        record.connectionProbe.status = 'running';
        if (deepseek) record.connectionProbe.requests = 1;
        try {
          const probe = await provider.probe(signal());
          record.connectionProbe.status = 'passed';
          record.connectionProbe.usage = {
            inputTokens: probe?.usage?.inputTokens ?? null,
            outputTokens: probe?.usage?.outputTokens ?? null,
          };
          if (
            human &&
            (record.connectionProbe.usage.inputTokens === null ||
              record.connectionProbe.usage.outputTokens === null)
          )
            record.connectionProbe.unknownCostRequests = 1;
          record.connectionProbe.requests = probe?.requests ?? null;
          if (probe?.response) record.connectionProbe.response = probe.response;
        } catch (error) {
          record.connectionProbe.status = 'failed';
          if (human) record.connectionProbe.unknownCostRequests = 1;
          record.connectionProbe.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          record.connectionProbe.elapsedMs = performance.now() - probeStarted;
        }
      }
      await checkpoint('probe_completed');
      businessStarted = performance.now();
      record.businessBudget.startedAt = new Date().toISOString();
      if (options.budget?.ms)
        budgetTimer = setTimeout(() => stopBudget('business_time_budget'), options.budget.ms);
      for (let repeat = 1; repeat <= options.repetitions; repeat++) {
        for (const scenario of scenarios) {
          controller.signal.throwIfAborted();
          if (
            options.budget?.requests &&
            record.businessBudget.requests >= options.budget.requests
          ) {
            stopBudget('business_request_budget');
            throw new Error('BUSINESS_REQUEST_BUDGET');
          }
          const session = human
            ? humanMaterials.get(scenario.id).session
            : evaluationSession(scenario.id === 'empty');
          const viewState = { time: null, chart: null, applications: 0 };
          const base = createToolRegistry(session, {
            readWorkspace() {
              return { chart: viewState.chart, time: viewState.time };
            },
            seekToTime(time) {
              viewState.time = session.frames.reduce(
                (best, f) => (Math.abs(f.time - time) < Math.abs(best - time) ? f.time : best),
                session.frames[0].time,
              );
              viewState.applications++;
              return { appliedTime: viewState.time };
            },
            setChartView(view) {
              viewState.chart = structuredClone(view);
              viewState.applications++;
              return structuredClone(view);
            },
          });
          const interventions = { injectedFailure: false, intervened: false };
          const registry = {
            ...base,
            execute(name, input) {
              if (
                scenario.id === 'tool_error' &&
                name === 'query_metrics' &&
                !interventions.injectedFailure
              ) {
                interventions.injectedFailure = true;
                return {
                  ok: false,
                  tool: name,
                  error: {
                    code: 'EVAL_INJECTED_FAILURE',
                    message: '固定评测注入的可恢复工具失败，请重新读取。',
                  },
                };
              }
              return base.execute(name, input);
            },
          };
          let turnIndex = 0;
          const targetBudget = {
            requests: 0,
            elapsedMs: 0,
            maximumRequests: 12,
            maximumMs: 120000,
          };
          const targetStarted = performance.now();
          if (human) targetTimer = setTimeout(() => stopBudget('target_time_budget'), 120000);
          const instrumented = {
            id: provider.id,
            model: provider.model,
            requestBytes: provider.requestBytes?.bind(provider),
            async complete(request) {
              if (scenario.id === 'failure_recovery' && turnIndex === 0) {
                interventions.injectedFailure = true;
                throw new Error('EVAL_INJECTED_FAILURE');
              }
              const pending = provider.complete(request);
              if (!interventions.intervened && ['cancel', 'recalculate'].includes(scenario.id)) {
                interventions.intervened = true;
                queueMicrotask(() =>
                  scenario.id === 'cancel'
                    ? active.cancel()
                    : session.recalculate({ ...EVAL_PARAMETERS, window: 3 }),
                );
              }
              return pending;
            },
          };
          active = new AgentRuntime({
            limits:
              human || scenario.id === 'multi_turn_delivery'
                ? { timeoutMs: 120000, ...(human ? { rounds: 12 } : {}) }
                : undefined,
            beforeRequest() {
              if (human && performance.now() - businessStarted >= options.budget.ms) {
                stopBudget('business_time_budget');
                throw new Error('BUSINESS_TIME_BUDGET');
              }
              if (human && performance.now() - targetStarted >= 120000) {
                stopBudget('target_time_budget');
                throw new Error('TARGET_TIME_BUDGET');
              }
              if (
                options.budget?.requests &&
                record.businessBudget.requests >= options.budget.requests
              ) {
                stopBudget('business_request_budget');
                throw new Error('BUSINESS_REQUEST_BUDGET');
              }
              if (human && targetBudget.requests >= 12) {
                stopBudget('target_request_budget');
                throw new Error('TARGET_REQUEST_BUDGET');
              }
              controller.signal.throwIfAborted();
              record.businessBudget.requests++;
              if (human) targetBudget.requests++;
            },
            modelProtocol: dependencies.modelProtocol,
            submissionEvidence: humanEvidence.get(scenario.id)?.gaps,
            session,
            registry,
            provider: instrumented,
            onReady() {
              // Headless state application, not browser paint evidence.
              base.readWorkspace();
            },
            async onAudit(audit) {
              const path = `${options.output}.run-${audit.run.id}.audit.json`;
              const contents = JSON.stringify(audit, null, 2) + '\n';
              await writeFile(path, contents, { flag: 'wx' });
              record.auditFiles.push({
                runId: audit.run.id,
                path,
                sha256: createHash('sha256').update(contents).digest('hex'),
              });
              if (human)
                for (const [index, request] of audit.requests.entries()) {
                  const calls = request.reply?.calls;
                  if (
                    Array.isArray(calls) &&
                    (!calls.length ||
                      (calls.length > 1 && calls.some((call) => call.name === 'finish_analysis')))
                  )
                    record.protocolCorrections.push({
                      caseId: scenario.id,
                      runId: audit.run.id,
                      request: index + 1,
                      reason: calls.length
                        ? 'finish_mixed_with_other_calls'
                        : 'no_structured_calls',
                    });
                }
            },
          });
          const entry = {
            caseId: scenario.id,
            group: scenario.group,
            repeat,
            turns: [],
            assessment: null,
            interventions,
            viewState,
            ...(human ? { businessBudget: targetBudget } : {}),
          };
          record.runs.push(entry);
          await checkpoint('case_started');
          for (const turn of scenario.turns) {
            controller.signal.throwIfAborted();
            const submission = { submittedAt: Date.now(), monotonicAt: performance.now() };
            const run = await active.run(turn.goal, submission);
            const observation = observeEvaluation(
              run,
              { chart: viewState.chart, time: viewState.time },
              base,
            );
            const assessment = assessRun(run, scenario, session, observation, turnIndex);
            if (human) {
              const gaps = humanEvidence.get(scenario.id).gaps(run, run.citations);
              assessment.failures.push(
                ...gaps.map(({ tool, labels, reason }) => `${reason}:${tool}:${labels.join('|')}`),
              );
              if (run.reference.source !== 'file' || run.reference.synthetic)
                assessment.failures.push('human_source_or_provenance');
              if (run.auditStatus !== 'saved') assessment.failures.push('human_audit_not_saved');
              const limited = scenario.id === 'human-720';
              if (
                run.completion?.state !== (limited ? 'not_comparable' : 'ready') ||
                !same(run.completion?.missing, limited ? ['comparison'] : []) ||
                !['quality', 'view', 'report', 'export'].every((name) =>
                  run.completion.satisfied.includes(name),
                )
              )
                assessment.failures.push('human_completion_or_delivery');
              assessment.passed = assessment.failures.length === 0;
            }
            entry.turns.push({ run, observation, assessment });
            turnIndex++;
            await checkpoint('turn_completed');
            // The acceptance chain never retries a failed target or proceeds
            // with a different intent after its first failure.
            if ((human || scenario.id === 'multi_turn_delivery') && !assessment.passed) break;
          }
          entry.assessment = assessScenario(entry.turns, scenario, session);
          if (human) {
            clearTimeout(targetTimer);
            targetTimer = undefined;
            targetBudget.elapsedMs = performance.now() - targetStarted;
            if (targetBudget.elapsedMs >= 120000) {
              entry.assessment.passed = false;
              entry.assessment.failures.push('target_time_budget');
            }
          }
          if (
            (['tool_error', 'failure_recovery'].includes(scenario.id) &&
              !interventions.injectedFailure) ||
            (scenario.group === 'protection' && !interventions.intervened)
          ) {
            entry.assessment.passed = false;
            entry.assessment.failures.push('failure_path_not_exercised');
          }
          await checkpoint('case_completed');
          dependencies.log?.(
            `${scenario.id} #${repeat}: ${entry.assessment.passed ? 'pass' : 'fail'} / ${entry.assessment.calls} calls / ${entry.assessment.elapsedMs} ms`,
          );
          if (human && !entry.assessment.passed)
            throw new Error(`HUMAN_BATCH_FIRST_FAILURE:${scenario.id}`);
        }
      }
      clearTimeout(budgetTimer);
      record.businessBudget.elapsedMs = performance.now() - businessStarted;
      if (human && record.businessBudget.elapsedMs >= options.budget.ms) {
        stopBudget('business_time_budget');
        throw new Error('BUSINESS_TIME_BUDGET');
      }
      controller.signal.throwIfAborted();
      record.status = scripted ? 'executed_protocol_only' : 'executed_real_model';
    }
  } catch (error) {
    record.status = controller.signal.aborted ? 'cancelled' : 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  } finally {
    clearTimeout(budgetTimer);
    clearTimeout(targetTimer);
    if (businessStarted !== undefined && !record.businessBudget.elapsedMs)
      record.businessBudget.elapsedMs = performance.now() - businessStarted;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (record.runs.some((r) => !r.assessment?.passed)) exitCode = 1;
    await checkpoint('finished');
  }
  return { record, exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseEvaluationArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        'pnpm eval:agent:real [--provider ollama|deepseek] [--model <model>] [--case compare|quality] [--repeat 1] [--max-business-requests 12] [--max-business-ms 120000] [--output NEW.json] [--conditions measured-conditions.json] [--skip-real]',
      );
      console.log(
        'Human replay: --human-input-index .qa/core-work/20261030-input-closure-1793357317372/input-index.json --output NEW.json [--case human-720|human-1080] [--local-only | --proxy-origin http://127.0.0.1:<port>]. Defaults to both pinned tasks in order; local-only makes zero model/probe requests. Each real task is capped at 12 requests/120s, whole batch 24/240s; first failure stops without retry.',
      );
      console.log(
        `Evaluation ${EVALUATION_VERSION}; immutable checkpoints after each turn. --skip-real records zero executed cases. Existing outputs are refused. No model installation/downloads.`,
      );
      console.log(
        'Standard DeepSeek evaluation: official endpoint, deepseek-flash; its existing Node adapter owns credentials. Human mode uses only the existing loopback proxy and never reads credentials. Never pass keys as CLI arguments.',
      );
    } else {
      const { record, exitCode } = await runEvaluation(options, { log: console.log });
      process.exitCode = exitCode;
      console.log(
        `${record.status}: ${options.output} (${record.summary.passed}/${record.summary.executed}; unexecuted is not a zero success rate)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
