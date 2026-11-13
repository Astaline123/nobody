// A plain-words explainer of Nobody, for people who have never written code: what goes wrong
// today, what Nobody does about it, and how. film/explainer.html draws every picture. A voice reads
// the lines (Kokoro by default, see film/kokoro.mjs), and each picture lands on its word.
//
//   node film/explainer.mjs script <work>             narration.json, for film/kokoro.mjs or film/voice.ps1
//   node film/explainer.mjs stills <work> 2 9.5 31    PNG stills at those seconds, to check the drawing
//   node film/explainer.mjs record <work>             every frame, voice.wav and bed.wav
//
// scripts/explainer.ps1 runs all of it and writes docs/demo/nobody-explained.mp4.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode, work, ...times] = process.argv.slice(2);
if (!['script', 'stills', 'record'].includes(mode) || !work) {
  console.error('usage: node film/explainer.mjs script|stills|record <work> [seconds...]');
  process.exit(1);
}

const PAGE = new URL('./explainer.html', import.meta.url).href;
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const LEAD_MS = 700;
const TAIL_MS = 3000;
const DEBUG_PORT = 9351;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (number, size = 2) => String(number).padStart(size, '0');

// What the captions say. The voice reads the same words, saying NEAR as a word, not letters.
const LINES = [
  // The problem
  'On NEAR, people build apps that hold real money.',
  'One small mistake in the code, and a thief can take it all.',
  'A professional safety check usually costs thousands of dollars, and takes weeks.',
  'Most small builders skip it, and hope for the best.',
  // The idea
  'Meet Nobody.',
  'It checks your code for the common mistakes that get money stolen.',
  'A check costs one to five dollars, and takes minutes, not weeks.',
  'Who runs this company? Nobody.',
  'No staff, no office, not even a computer of its own.',
  // How it works
  'Share a link to your code, and pay with almost any coin, from almost any blockchain.',
  'Your payment wakes Nobody up. Between customers, it costs nothing.',
  'The check runs inside a sealed box.',
  'No one can look inside or change the result. Not even its makers.',
  "It goes through NEAR's own safety checklist.",
  'Then an AI double-checks every problem it finds.',
  'You get a private report that only you can open.',
  'Because a public list of your bugs would be a treasure map for thieves.',
  "And if the check can't be finished, your money comes back automatically.",
  // How it runs itself
  'Your payment is split by fixed rules.',
  'One fifth goes straight to the people who built it. The rest stays with the company.',
  'It even buys its own AI. Spare money sits in savings with NEAR AI, and the interest pays for the AI.',
  'A person sets a few rules: a price range, a daily AI budget, and a stop button.',
  'But there is no button to take the money out. Not even for the owner.',
  'Every coin in and out is shown on a public page, for anyone to check.',
  // Why it matters
  'The goal: fewer hacks, and more reasons to trust apps on NEAR.',
  "It's also a new kind of business: it runs itself, in the open, with nobody in charge.",
  'Nobody was built at the NEAR hackathon. It works in testing, and going live is next.',
];
// The first line of each picture and of each chapter. Longer pauses go before them.
const SCENES = [0, 2, 4, 5, 7, 9, 10, 11, 13, 15, 17, 18, 20, 21, 23, 24, 25, 26];
const CHAPTERS = [0, 4, 9, 18, 24, 26];
const PAUSE = { line: 300, scene: 650, chapter: 950 };
// Extra time after a line, so a picture can land before the next one: the stamp, then the title.
const HOLD = { 1: 500, 4: 700 };
// X takes videos up to 2 minutes 20 seconds from most accounts.
const X_LIMIT_MS = 140_000;

const spoken = (text) => text.replace(/\bNEAR\b/g, 'Near');
const norm = (word) => word.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9']/g, '');

if (mode === 'script') {
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'narration.json'), JSON.stringify(LINES.map(spoken)));
  const words = LINES.reduce((sum, line) => sum + line.split(/\s+/).length, 0);
  console.log(`${LINES.length} lines, ${words} words`);
  process.exit(0);
}

// ---- Timing: when each line starts, and when each of its words is said ----

function readWav(path) {
  const bytes = readFileSync(path);
  let at = 12;
  let format = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') format = { channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    if (id === 'data') {
      const pcm = bytes.subarray(at + 8, at + 8 + size);
      return { ...format, pcm, ms: (pcm.length / ((format.rate * format.channels * format.bits) / 8)) * 1000 };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`no audio in ${path}`);
}

/** The voice pads every line with up to a second of silence. Cut it, so the pauses are ours. */
function trim(voice) {
  const samples = voice.pcm.length / 2;
  const loud = (index) => Math.abs(voice.pcm.readInt16LE(index * 2)) > 400;
  let first = 0;
  while (first < samples && !loud(first)) first += 1;
  let last = samples - 1;
  while (last > first && !loud(last)) last -= 1;
  const from = Math.max(0, first - Math.round(voice.rate * 0.03));
  const to = Math.min(samples, last + Math.round(voice.rate * 0.12));
  return { ...voice, pcm: voice.pcm.subarray(from * 2, to * 2), ms: ((to - from) / voice.rate) * 1000, leadMs: (from / voice.rate) * 1000 };
}

/**
 * Without word times from the voice (Kokoro gives none), spread the words over the line by length,
 * with a pause after commas and full stops. The line's silence is already trimmed off both ends.
 */
function guessWords(text, ms) {
  const tokens = text.split(/\s+/);
  const weights = tokens.map((token) => token.length + 1 + (/[,;:]$/.test(token) ? 4 : /[.?!]$/.test(token) ? 7 : 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  let before = 0;
  return tokens.map((token, index) => {
    const at = 40 + ((ms - 190) * before) / sum;
    before += weights[index];
    return { w: norm(token), t: Math.round(at) };
  });
}

function plan() {
  const voices = LINES.map((_, index) => {
    const path = join(work, 'voice', `${pad(index)}.wav`);
    return existsSync(path) ? trim(readWav(path)) : null;
  });
  const voiced = voices.every(Boolean);
  if (mode === 'record' && !voiced) throw new Error('record needs every voice/NN.wav. Run film/voice.ps1 first.');
  const lengths = voices.map((voice, index) => voice?.ms ?? (LINES[index].split(/\s+/).length / 2.7) * 1000 + 300);
  const words = LINES.map((line, index) => {
    const path = join(work, 'voice', `${pad(index)}.json`);
    const cues = voices[index] && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : [];
    return cues.length ? cues.map((cue) => ({ w: norm(cue.text), t: Math.max(0, cue.ms - voices[index].leadMs) })) : guessWords(spoken(line), lengths[index]);
  });
  const starts = [];
  const ends = [];
  let at = LEAD_MS;
  LINES.forEach((_, index) => {
    if (index > 0) at += CHAPTERS.includes(index) ? PAUSE.chapter : SCENES.includes(index) ? PAUSE.scene : PAUSE.line;
    starts.push(Math.round(at));
    at += lengths[index];
    ends.push(Math.round(at));
    at += HOLD[index] ?? 0;
  });
  const total = Math.round(at + TAIL_MS);
  console.log(`${voiced ? 'voice' : 'estimated'} timing: ${(total / 1000).toFixed(1)}s`);
  writeFileSync(join(work, 'timing.json'), JSON.stringify({ lines: LINES, starts, ends, total }));
  if (total >= X_LIMIT_MS) console.warn(`WARNING: ${(total / 1000).toFixed(1)}s is longer than X accepts from most accounts (140s).`);
  return { voices, film: { lines: LINES, starts, ends, words, total, scenes: SCENES, chapters: CHAPTERS } };
}

// ---- The browser ----

const browsers = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function openPage(film) {
  const binary = browsers.find((path) => existsSync(path));
  if (!binary) throw new Error('No browser found. Set BROWSER to Edge or Chrome.');
  const profile = mkdtempSync(join(tmpdir(), 'nobody-explainer-'));
  const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let url = null;
  for (let attempt = 0; attempt < 100 && !url; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      url = pages.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch {
      // not listening yet
    }
    if (!url) await sleep(300);
  }
  if (!url) throw new Error('the browser did not start');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(`page: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result?.value;
  };
  const close = async () => {
    socket.close();
    browser.kill();
    await sleep(600);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // The browser may still hold a file for a moment. It is only a temp folder.
    }
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__film = ${JSON.stringify(film)};` });
    await send('Page.navigate', { url: PAGE });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = await evaluate('JSON.stringify({ ready: window.__ready === true, error: window.__error ?? null })').catch(() => '{}');
      const { ready, error } = JSON.parse(state || '{}');
      if (error) throw new Error(`the page refused the film: ${error}`);
      if (ready) return { send, evaluate, close };
      await sleep(250);
    }
    throw new Error('the page never became ready');
  } catch (error) {
    await close();
    throw error;
  }
}

// ---- Sound: the voice on one track, quiet music and stamp sounds on another ----

function writeWav(path, rate, channels, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

function writeVoice(path, voices, starts, total) {
  const { rate, channels, bits } = voices[0];
  if (channels !== 1 || bits !== 16 || voices.some((voice) => voice.rate !== rate || voice.channels !== 1 || voice.bits !== 16)) {
    throw new Error('expected 16-bit mono voice files at one rate');
  }
  const samples = new Float32Array(Math.ceil((total / 1000) * rate));
  voices.forEach((voice, index) => {
    const offset = Math.round((starts[index] / 1000) * rate);
    for (let at = 0; at < voice.pcm.length / 2 && offset + at < samples.length; at += 1) samples[offset + at] = voice.pcm.readInt16LE(at * 2) / 32768;
  });
  writeWav(path, rate, 1, samples);
}

/** A soft, slow arpeggio in C, kept far under the voice, plus a thump for each rubber stamp. */
function writeBed(path, total, cues) {
  const RATE = 44100;
  const length = Math.ceil((total / 1000) * RATE);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const hz = (note) => 440 * 2 ** ((note - 69) / 12);
  const play = (start, seconds, amp, pan, wave, envelope) => {
    const from = Math.max(0, Math.floor(start * RATE));
    const to = Math.min(length, Math.floor((start + seconds) * RATE));
    const toLeft = Math.cos(((pan + 1) * Math.PI) / 4);
    const toRight = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let index = from; index < to; index += 1) {
      const t = index / RATE - start;
      const value = amp * envelope(t) * wave(t);
      left[index] += value * toLeft;
      right[index] += value * toRight;
    }
  };
  const TAU = 2 * Math.PI;
  const pluck = (f) => (t) => Math.sin(TAU * f * t) + 0.26 * Math.sin(2 * TAU * f * t) + 0.07 * Math.sin(3 * TAU * f * t);
  const pluckShape = (t) => Math.min(1, t / 0.006) * Math.exp(-t / 0.45);
  const pad = (f) => (t) => 0.5 * Math.sin(TAU * f * 1.0015 * t) + 0.5 * Math.sin(TAU * f * 0.9985 * t) + 0.08 * Math.sin(3 * TAU * f * t);
  const smooth = (x) => x * x * (3 - 2 * x);
  const padShape = (seconds) => (t) => smooth(Math.min(1, t / 1.0)) * smooth(Math.min(1, Math.max(0, (seconds - t) / 1.0)));
  const bass = (f) => (t) => Math.sin(TAU * f * t) + 0.12 * Math.sin(2 * TAU * f * t);
  const bassShape = (t) => Math.min(1, t / 0.02) * Math.exp(-t / 1.1);

  const BEAT = 60 / 84;
  const BAR = BEAT * 4;
  const CHORDS = [
    { bass: 36, pad: [55, 60, 64], arp: [60, 64, 67, 72, 76, 72, 67, 64] },
    { bass: 43, pad: [55, 59, 62], arp: [59, 62, 67, 71, 74, 71, 67, 62] },
    { bass: 45, pad: [57, 60, 64], arp: [57, 60, 64, 69, 72, 69, 64, 60] },
    { bass: 41, pad: [53, 57, 60], arp: [57, 60, 65, 69, 72, 69, 65, 60] },
  ];
  const seconds = total / 1000;
  const bars = Math.ceil(seconds / BAR);
  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * BAR;
    const last = bar === bars - 1;
    const chord = last ? CHORDS[0] : CHORDS[bar % 4];
    const hold = last ? seconds - start : BAR + 1.0;
    chord.pad.forEach((note) => play(start, hold, 0.05, 0, pad(hz(note)), padShape(hold)));
    play(start, Math.min(hold, 3.2), 0.13, 0, bass(hz(chord.bass)), bassShape);
    if (bar >= 2 && !last) {
      const notes = Math.floor(bar / 8) % 2 ? [...chord.arp].reverse() : chord.arp;
      notes.forEach((note, step) => {
        const at = start + (step * BEAT) / 2;
        const pan = step % 2 ? 0.35 : -0.35;
        play(at, 1.8, 0.075, pan, pluck(hz(note)), pluckShape);
        play(at + BEAT * 0.75, 1.8, 0.022, -pan, pluck(hz(note)), pluckShape);
      });
    }
  }
  // Keep the music far below the voice: about -35 dBFS.
  let power = 0;
  for (let index = 0; index < length; index += 1) power += left[index] ** 2 + right[index] ** 2;
  const gain = 0.018 / Math.sqrt(power / (2 * length) || 1);
  for (let index = 0; index < length; index += 1) {
    left[index] *= gain;
    right[index] *= gain;
  }

  const stamp = (at) => {
    const from = Math.floor(at * RATE);
    let phase = 0;
    let noise = 0;
    for (let index = 0; index < 0.4 * RATE && from + index < length; index += 1) {
      const t = index / RATE;
      phase += (TAU * (50 + 120 * Math.exp(-t / 0.03))) / RATE;
      noise += 0.3 * (Math.random() * 2 - 1 - noise);
      const value = Math.sin(phase) * Math.exp(-t / 0.08) * 0.34 + noise * Math.exp(-t / 0.012) * 0.22;
      left[from + index] += value;
      right[from + index] += value;
    }
  };
  const ting = (at) => play(at, 0.6, 0.03, 0.2, (t) => Math.sin(TAU * 2093 * t) + 0.6 * Math.sin(TAU * 3136 * t), (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.11));
  const pop = (at) => {
    const from = Math.floor(at * RATE);
    let phase = 0;
    for (let index = 0; index < 0.12 * RATE && from + index < length; index += 1) {
      const t = index / RATE;
      phase += (TAU * (380 + 2600 * t)) / RATE;
      const value = Math.sin(phase) * Math.min(1, t / 0.004) * Math.exp(-t / 0.035) * 0.07;
      left[from + index] += value;
      right[from + index] += value;
    }
  };
  for (const cue of cues) {
    const at = cue.ms / 1000;
    if (cue.kind === 'stamp') stamp(at);
    else if (cue.kind === 'coin') ting(at);
    else pop(at);
  }

  const fadeIn = 1.2 * RATE;
  const fadeOut = 2.5 * RATE;
  const samples = new Float32Array(length * 2);
  for (let index = 0; index < length; index += 1) {
    const shape = Math.min(1, index / fadeIn, (length - index) / fadeOut);
    samples[index * 2] = left[index] * shape;
    samples[index * 2 + 1] = right[index] * shape;
  }
  writeWav(path, RATE, 2, samples);
}

// ---- Run ----

const { voices, film } = plan();
const page = await openPage(film);
try {
  if (mode === 'stills') {
    const folder = join(work, 'stills');
    mkdirSync(folder, { recursive: true });
    for (const second of times.map(Number)) {
      await page.evaluate(`__seek(${second * 1000})`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = join(folder, `at-${second.toFixed(1).padStart(5, '0')}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(file);
    }
    console.log(film.starts.map((start, index) => `${pad(index)} ${(start / 1000).toFixed(1).padStart(6)}s  ${LINES[index].slice(0, 60)}`).join('\n'));
  } else {
    const frames = join(work, 'frames');
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    const count = Math.ceil((film.total / 1000) * FPS);
    const began = Date.now();
    for (let frame = 0; frame < count; frame += 1) {
      await page.evaluate(`__seek(${(frame * 1000) / FPS})`);
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
      writeFileSync(join(frames, `${pad(frame, 6)}.jpg`), Buffer.from(shot.data, 'base64'));
      if (frame % 300 === 0) console.log(`frame ${frame} of ${count}, ${((Date.now() - began) / 1000).toFixed(0)}s`);
    }
    const cues = JSON.parse(await page.evaluate('JSON.stringify(window.__cues)'));
    writeVoice(join(work, 'voice.wav'), voices, film.starts, film.total);
    writeBed(join(work, 'bed.wav'), film.total, cues);
    console.log(`${count} frames, ${cues.length} sound cues, ${(film.total / 1000).toFixed(1)}s`);
  }
} finally {
  await page.close();
}
process.exit(0);
