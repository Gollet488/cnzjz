// Synthetic color-block fixtures only. Usage: node scripts/generate-video-formats.mjs /path/to/ffmpeg
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ffmpeg = process.argv[2] || 'ffmpeg';
const fixtures = [
  ['format.mkv', '30fps.mp4', ['-c:v', 'copy']],
  ['format.mov', '30fps.mp4', ['-c:v', 'copy']],
  ['format.avi', '30fps.mp4', ['-c:v', 'mpeg4']],
  ['format.webm', '30fps.mp4', ['-c:v', 'libvpx-vp9']],
  ['format.flv', '30fps.mp4', ['-c:v', 'flv']],
  ['format.wmv', '30fps.mp4', ['-c:v', 'wmv2']],
  ['format.m2ts', '30fps.mp4', ['-c:v', 'copy', '-f', 'mpegts']],
  [
    'format-hevc.mp4',
    '30fps.mp4',
    ['-c:v', 'libx265', '-x265-params', 'pools=none:frame-threads=1', '-tag:v', 'hvc1'],
  ],
  ['format-vfr.mkv', 'vfr.mp4', ['-c:v', 'copy']],
];
const manifestURL = new URL('../tests/fixtures/browser-manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestURL, 'utf8'));
for (const [name, input, args] of fixtures) {
  const root = new URL('../tests/fixtures/', import.meta.url);
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-i',
      fileURLToPath(new URL(input, root)),
      '-an',
      '-threads',
      '1',
      ...args,
      fileURLToPath(new URL(name, root)),
    ],
    { windowsHide: true },
  );
  const data = await readFile(new URL(name, root));
  const entry = {
    name,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  manifest.files = manifest.files.filter((item) => item.name !== name);
  manifest.files.push(entry);
}
await writeFile(manifestURL, JSON.stringify(manifest, null, 2) + '\n');
