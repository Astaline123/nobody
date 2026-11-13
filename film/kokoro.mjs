// Speaks each line with Kokoro, a natural voice that runs on this machine (Apache 2.0), and then
// checks it. Nobody here can listen to the result, so Whisper transcribes every line and the words
// it heard are compared with the script.
//
//   node film/kokoro.mjs <work> [voice] [speed]
//   MODEL_CACHE=<folder>   use models already downloaded there, and download nothing
//
// It writes <work>/voice/NN.wav like film/voice.ps1 does, so film/explainer.mjs can use either. Kokoro
// gives no word times, so the film spreads each line's words over its length.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const [work, voice = 'af_bella', speedText = '1.0'] = process.argv.slice(2);
if (!work) {
  console.error('usage: node film/kokoro.mjs <work> [voice] [speed]');
  process.exit(1);
}
const speed = Number(speedText);
if (process.env.MODEL_CACHE) {
  env.cacheDir = process.env.MODEL_CACHE;
  env.allowRemoteModels = false;
}

const lines = JSON.parse(readFileSync(join(work, 'narration.json'), 'utf8'));
const out = join(work, 'voice');
mkdirSync(out, { recursive: true });

function writeWav(path, rate, audio) {
  const data = Buffer.alloc(audio.length * 2);
  audio.forEach((value, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

/** Whisper listens at 16 kHz. */
function to16k(audio, rate) {
  const ratio = rate / 16000;
  const result = new Float32Array(Math.floor(audio.length / ratio));
  for (let index = 0; index < result.length; index += 1) {
    const at = index * ratio;
    const low = Math.floor(at);
    const high = Math.min(audio.length - 1, low + 1);
    result[index] = audio[low] + (audio[high] - audio[low]) * (at - low);
  }
  return result;
}

const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', ten: '10', twenty: '20' };
/** Writes both sides the same way, so "A.I." and "AI", or "five" and "5", compare equal. */
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

const began = Date.now();
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
const listen = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' });
console.log(`Voice: Kokoro ${voice}, speed ${speed}. Models loaded in ${((Date.now() - began) / 1000).toFixed(0)}s`);

let seconds = 0;
let total = 0;
const doubtful = [];
for (let index = 0; index < lines.length; index += 1) {
  const result = await tts.generate(lines[index], { voice, speed });
  const audio = result.audio;
  const rate = result.sampling_rate;
  seconds += audio.length / rate;
  const name = String(index).padStart(2, '0');
  writeWav(join(out, `${name}.wav`), rate, audio);
  writeFileSync(join(out, `${name}.json`), '[]');
  const heard = (await listen(to16k(audio, rate))).text.trim();
  const score = similarity(words(lines[index]), words(heard));
  total += score;
  if (score < 0.8) doubtful.push({ line: lines[index], heard });
  console.log(`${name} ${score >= 0.8 ? 'ok  ' : 'LOOK'} ${(score * 100).toFixed(0).padStart(3)}%  ${(audio.length / rate).toFixed(1)}s  ${heard.slice(0, 80)}`);
}
console.log(`${lines.length} lines, ${seconds.toFixed(1)}s of voice, average match ${((total / lines.length) * 100).toFixed(1)}%, made in ${((Date.now() - began) / 1000).toFixed(0)}s`);
for (const { line, heard } of doubtful) console.log(`\nscript: ${line}\nheard:  ${heard}`);
