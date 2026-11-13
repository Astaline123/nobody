// Checks the finished video by ear, without a human ear. Whisper transcribes the video's own mixed
// sound, cut line by line at the caption times, and the words are compared with the script. A good
// score shows the voice is clear over the music and lines up with the captions.
//
//   node film/check.mjs <work> [video.mp4]
//   MODEL_CACHE=<folder>   use models already downloaded there, and download nothing
//   FFMPEG=<ffmpeg.exe>    if ffmpeg is not in the usual place
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const [work, video = new URL('../docs/demo/nobody-explained.mp4', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] = process.argv.slice(2);
if (!work) {
  console.error('usage: node film/check.mjs <work> [video.mp4]');
  process.exit(1);
}
if (process.env.MODEL_CACHE) {
  env.cacheDir = process.env.MODEL_CACHE;
  env.allowRemoteModels = false;
}
const ffmpeg = process.env.FFMPEG ?? join(process.env.USERPROFILE ?? '', 'dev-tools', 'ffmpeg', 'ffmpeg.exe');
const timing = JSON.parse(readFileSync(join(work, 'timing.json'), 'utf8'));

// The video's sound as 16 kHz mono, which is what Whisper listens to.
const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
if (decoded.status !== 0) throw new Error(`ffmpeg failed: ${decoded.stderr}`);
const pcm = decoded.stdout;
const samples = new Float32Array(pcm.length / 2);
for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readInt16LE(index * 2) / 32768;
const cut = (fromMs, toMs) => samples.subarray(Math.max(0, Math.floor(fromMs * 16)), Math.min(samples.length, Math.ceil(toMs * 16)));

const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', ten: '10', twenty: '20' };
const words = (text) => text
  .toLowerCase()
  .replace(/\ba\.?\s?i\b/g, 'ai')
  .replace(/[^a-z0-9' ]/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => NUMBERS[word] ?? word);

function similarity(a, b) {
  const table = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) table[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - table[a.length][b.length] / Math.max(a.length, b.length);
}

const listen = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' });
let total = 0;
let doubtful = 0;
for (let index = 0; index < timing.lines.length; index += 1) {
  const heard = (await listen(cut(timing.starts[index] - 50, timing.ends[index] + 150))).text.trim();
  const score = similarity(words(timing.lines[index]), words(heard));
  total += score;
  if (score < 0.8) doubtful += 1;
  console.log(`${String(index).padStart(2, '0')} ${score >= 0.8 ? 'ok  ' : 'LOOK'} ${(score * 100).toFixed(0).padStart(3)}%  ${heard.slice(0, 80)}`);
}
console.log(`average match ${((total / timing.lines.length) * 100).toFixed(1)}% on the finished video's sound, ${doubtful} of ${timing.lines.length} lines to look at`);
