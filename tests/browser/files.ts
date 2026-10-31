import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../../src/analysis/session.ts';
import { POINT_NAMES } from '../../src/config.ts';
import { createToolRegistry } from '../../src/analysis/tools.ts';
import { serializeCSV } from '../../src/utils/csv.ts';

// Independent CSV parser: handles quoted delimiters, doubled quotes and CRLF.
export function parseCSV(bytes: Buffer) {
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const text = bytes.toString('utf8').slice(1);
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (c === '\n') {
        rows.push(row);
        row = [];
      }
    } else field += c;
  }
  assert.equal(quoted, false);
  if (row.length || field) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift()!;
  assert.equal(header.length, 354);
  assert.ok(rows.length);
  return rows.map((values) => {
    assert.equal(values.length, header.length);
    return Object.fromEntries(header.map((key, i) => [key, values[i]]));
  });
}

export async function downloadFile(
  page: Page,
  info: TestInfo,
  button: ReturnType<Page['getByRole']>,
  name: string,
) {
  const waiting = page.waitForEvent('download');
  await button.click();
  const download = await waiting;
  expect(await download.failure()).toBeNull();
  const path = info.outputPath(name);
  await download.saveAs(path);
  await info.attach(name, { path });
  return { path, bytes: await readFile(path) };
}

export async function fullCSV(page: Page, info: TestInfo, name: string) {
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  return parseCSV(
    (
      await downloadFile(
        page,
        info,
        page.getByRole('button', { name: '下载 CSV 数据', exact: true }),
        name,
      )
    ).bytes,
  );
}

export function replayCSV(rows: Record<string, string>[]) {
  const first = rows[0];
  const session = new AnalysisSession(first.source as any, {
    threshold: Number(first.confidence_threshold),
    window: Number(first.filter_window_frames),
    aspect: Number(first.source_aspect),
    metricVersion: '2.0',
  });
  if (first.source === 'file' && first.synthetic === 'true') session.setFileSynthetic(true);
  for (const row of rows) {
    const points =
      row.raw_nose_x === ''
        ? []
        : (POINT_NAMES.map((name) =>
            Object.fromEntries(
              ['x', 'y', 'z', 'visibility'].map((key) => [key, Number(row[`raw_${name}_${key}`])]),
            ),
          ) as any);
    session.append(points, Number(row.time_s));
    const frame = session.frames.at(-1)!;
    for (const [key, value] of [
      ['filtered_knee_right_deg', frame.angles.knee.right],
      ['filtered_knee_left_deg', frame.angles.knee.left],
      ['raw_knee_right_deg', frame.rawAngles.knee.right],
      ['filtered_knee_right_velocity_deg_s', frame.velocity.knee.right],
      ['center_y', frame.center?.y ?? null],
    ] as const) {
      if (value === null) assert.equal(row[key], '');
      else {
        assert.notEqual(row[key], '');
        assert.ok(Math.abs(Number(row[key]) - value) < 1e-8, `${key}: ${row[key]} != ${value}`);
      }
    }
    assert.equal(row.session_id, first.session_id);
    assert.equal(row.session_revision, first.session_revision);
    assert.equal(row.synthetic, first.synthetic);
  }
  return session;
}

// Recompute every saved cell from raw points, including all joint channels,
// filter coordinates, missing values, units and source/acquisition metadata.
export function replayFullCSV(rows: Record<string, string>[]) {
  const session = replayCSV(rows);
  const first = rows[0];
  const info = session.info();
  info.sessionId = first.session_id;
  info.revision = Number(first.session_revision);
  if (first.acquisition_mode)
    info.acquisition = {
      mode: 'webcodecs',
      status: first.acquisition_status as any,
      expectedFrames: Number(first.source_expected_frames),
      processedFrames: Number(first.source_processed_frames),
      codec: first.source_codec,
      rotation: Number(first.source_rotation_deg),
      mediaTimeOffset: Number(first.media_time_offset_s),
    };
  const markers = rows
    .filter((row) => row.markers)
    .map((row) => ({ time: Number(row.time_s), label: row.markers }));
  const expected = parseCSV(Buffer.from(serializeCSV(session.frames, markers, info), 'utf8'));
  const numeric = new Set([
    'time_s',
    'confidence',
    'center_x',
    'center_y',
    'asymmetry_percent',
    'window_start_s',
    'window_end_s',
    'shoulder_height_delta',
    'hip_height_delta',
    'knee_height_delta',
    ...Object.keys(first).filter((key) => key.startsWith('raw_') || key.startsWith('filtered_')),
  ]);
  let numericCells = 0,
    maxAbsoluteDifference = 0;
  assert.equal(rows.length, expected.length);
  rows.forEach((row, i) => {
    for (const key of Object.keys(row)) {
      const actual = row[key],
        value = expected[i][key];
      if (numeric.has(key) && actual !== '' && value !== '') {
        assert.ok(Number.isFinite(Number(actual)) && Number.isFinite(Number(value)), `${i}/${key}`);
        numericEqual(Number(actual), Number(value), `${i}/${key}`);
        maxAbsoluteDifference = Math.max(
          maxAbsoluteDifference,
          Math.abs(Number(actual) - Number(value)),
        );
        numericCells++;
      } else assert.equal(actual, value, `${i}/${key}`);
    }
  });
  return {
    rows: rows.length,
    columns: Object.keys(first).length,
    numericCells,
    maxAbsoluteDifference,
  };
}

export function rom(rows: Record<string, string>[], interval: number[], channel: string) {
  const values = rows
    .filter((r) => Number(r.time_s) >= interval[0] && Number(r.time_s) <= interval[1])
    .map((r) => r[`filtered_knee_${channel}_deg`])
    .filter((v) => v !== '')
    .map(Number);
  return { value: Math.max(...values) - Math.min(...values), samples: values.length };
}

// Independent Node execution from the *downloaded raw samples*, not copied
// browser tool results. Random handles and new replay reference are normalized.
export function verifyAudit(rows: Record<string, string>[], audit: any) {
  const session = replayCSV(rows);
  const registry = createToolRegistry(session, {
    setChartView: (view) => view,
    seekToTime: (time) => ({
      appliedTime: session.frames.reduce((a, b) =>
        Math.abs(b.time - time) < Math.abs(a.time - time) ? b : a,
      ).time,
    }),
  });
  const normalized = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [
          key,
          key === 'sessionId'
            ? '<session>'
            : key === 'revision'
              ? 0
              : key === 'handle'
                ? '<handle>'
                : normalized(v),
        ]),
      );
    return value;
  };
  const checked: string[] = [];
  assert.equal(audit.run.reference.sessionId, rows[0].session_id);
  assert.equal(audit.run.reference.revision, Number(rows[0].session_revision));
  const checkReferences = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'sessionId')) assert.equal(value.sessionId, rows[0].session_id);
    if (Object.hasOwn(value, 'revision'))
      assert.equal(value.revision, Number(rows[0].session_revision));
    for (const child of Object.values(value)) checkReferences(child);
  };
  for (const call of audit.run.calls) {
    if (!registry.definitions.some((d) => d.name === call.name) || !call.output.ok) continue;
    checkReferences(call.arguments);
    checkReferences(call.output);
    const args =
      call.name === 'get_session_info'
        ? {}
        : {
            ...call.arguments,
            sessionId: session.info().sessionId,
            revision: session.info().revision,
          };
    const result = registry.execute(call.name, args);
    numericEqual(normalized(result), normalized(call.output));
    checked.push(call.name);
  }
  return checked;
}

export function numericEqual(actual: any, expected: any, path = '') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(
      Math.abs(actual - expected) <= 1e-8 + Math.abs(expected) * 1e-12,
      `${path}: ${actual} != ${expected}`,
    );
  } else if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(actual))
      numericEqual(actual[key], expected[key], `${path}/${key}`);
  } else assert.deepEqual(actual, expected, path);
}
