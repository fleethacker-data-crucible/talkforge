#!/usr/bin/env node
// tools/synth-cli.mjs - offline voiceover from a script: one audio file per scene + timing.json.
// Uses TalkForge's own Piper engine from the local assets folder. No browser, no network.
// See the "Voiceover CLI" section of README.md for the interface.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, MissingAssetsError, loadVoice } from './node-engine.mjs';
import {
  DEFAULT_SENTENCE_GAP, buildTiming, joinPcm, parseScript, parseWav, pcmStats,
  speedToLengthScale, splitScene, wavFromPcm
} from './synth-lib.mjs';

export const USAGE = `Usage: node tools/synth-cli.mjs <script> [options]

  <script>             .json (scenes) or plain text (one scene per blank-line paragraph)

Options:
  --out <dir>          output folder (default: ./voiceover)
  --voice <id>         default voice (default: ${DEFAULT_VOICE})
  --speed <n>          default speed, 1 = normal, 1.1 = 10% faster (default: 1)
  --speaker <n>        default speaker id for multi-speaker voices (default: 0)
  --format <wav|mp3>   audio format (default: wav)
  --scene-gap <sec>    silence between scenes in the timeline only (default: 0)
  --sentence-gap <sec> silence between sentences inside a scene (default: ${DEFAULT_SENTENCE_GAP})
  --assets <dir>       assets folder (default: <repo>/assets, or env TALKFORGE_ASSETS)
  -h, --help           show this help

Writes <out>/<scene id>.<format> and <out>/timing.json. Exit codes: 0 ok, 1 error,
2 assets missing (nothing is downloaded), 64 bad usage.`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { out: 'voiceover', voice: undefined, speed: undefined, speaker: undefined, format: 'wav',
    sceneGap: undefined, sentenceGap: DEFAULT_SENTENCE_GAP, assets: process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR, script: null, help: false };
  const needs = (i, name) => {
    if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`${name} must be a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '--out': opts.out = needs(i, a); i++; break;
      case '--voice': opts.voice = needs(i, a); i++; break;
      case '--speed': opts.speed = num(needs(i, a), a); i++; break;
      case '--speaker': opts.speaker = num(needs(i, a), a); i++; break;
      case '--format': opts.format = needs(i, a).toLowerCase(); i++; break;
      case '--scene-gap': opts.sceneGap = num(needs(i, a), a); i++; break;
      case '--sentence-gap': opts.sentenceGap = num(needs(i, a), a); i++; break;
      case '--assets': opts.assets = needs(i, a); i++; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`Unknown option: ${a}`);
        if (opts.script) throw new UsageError(`Only one script file is allowed (got "${opts.script}" and "${a}")`);
        opts.script = a;
    }
  }
  if (!opts.help && !opts.script) throw new UsageError('Missing <script>');
  if (!['wav', 'mp3'].includes(opts.format)) throw new UsageError(`--format must be wav or mp3, got "${opts.format}"`);
  if (opts.sentenceGap < 0) throw new UsageError('--sentence-gap must be 0 or more');
  return opts;
}

async function loadLame(assetsDir) {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(assetsDir, 'vendor', 'lame.min.js');
  let code;
  try { code = await readFile(file, 'utf8'); }
  catch { code = await readFile(join(here, '..', 'assets', 'vendor', 'lame.min.js'), 'utf8'); }
  const ctx = {}; ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.lamejs;
}

function encodeMp3(lamejs, pcm, sampleRate) {
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
  const enc = new lamejs.Mp3Encoder(1, sampleRate, 128);
  const out = [];
  for (let i = 0; i < samples.length; i += 1152) {
    const b = enc.encodeBuffer(samples.subarray(i, i + 1152));
    if (b.length) out.push(Buffer.from(b));
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}

// Programmatic entry point (the CLI is a thin wrapper). Returns the timing object.
//   options: { scriptPath, out, voice, speed, speaker, format, sceneGap, sentenceGap, assets, log }
export async function synthesizeScript(options) {
  const o = { out: 'voiceover', format: 'wav', sentenceGap: DEFAULT_SENTENCE_GAP, assets: DEFAULT_ASSETS_DIR, log: () => {}, ...options };
  const source = await readFile(o.scriptPath, 'utf8');
  const defaultVoice = o.voice ?? DEFAULT_VOICE;
  const scenes = parseScript(source, {
    isJson: extname(o.scriptPath).toLowerCase() === '.json',
    defaults: { voice: defaultVoice, speed: o.speed, speaker: o.speaker, sceneGap: o.sceneGap }
  });
  const outDir = resolve(o.out);
  const lamejs = o.format === 'mp3' ? await loadLame(resolve(o.assets)) : null;

  // Load every voice up front so a missing file fails before any audio is written.
  const engines = new Map();
  for (const v of new Set(scenes.map((s) => s.voice ?? defaultVoice))) {
    o.log(`Loading voice ${v} ...`);
    engines.set(v, await loadVoice(v, o.assets));
  }
  await mkdir(outDir, { recursive: true });

  const entries = [];
  for (const sc of scenes) {
    const voice = sc.voice ?? defaultVoice;
    const { engine, sampleRate } = engines.get(voice);
    const t0 = Date.now();
    const lengthScale = speedToLengthScale(sc.speed);
    const sentences = splitScene(sc.text);
    const parts = [];
    for (const sentence of sentences) {
      const wav = Buffer.from(await (await engine.synthesize(sentence, sc.speaker, lengthScale)).arrayBuffer());
      const parsed = parseWav(wav);
      if (parsed.sampleRate !== sampleRate) throw new Error(`Scene "${sc.id}": unexpected sample rate ${parsed.sampleRate}`);
      parts.push(parsed.pcm);
    }
    const pcm = joinPcm(parts, sampleRate, o.sentenceGap);
    const stats = pcmStats(pcm);
    if (stats.samples === 0 || stats.peak < 0.01) throw new Error(`Scene "${sc.id}" came out silent (peak ${stats.peak.toFixed(4)})`);
    const file = `${sc.id}.${o.format}`;
    const bytes = o.format === 'mp3' ? encodeMp3(lamejs, pcm, sampleRate) : wavFromPcm(pcm, sampleRate);
    await writeFile(join(outDir, file), bytes);
    const seconds = stats.samples / sampleRate;
    entries.push({ ...sc, voice, file, seconds });
    o.log(`${sc.id.padEnd(14)} ${seconds.toFixed(2)} s  ${sentences.length} sentence(s)  ${((Date.now() - t0) / 1000).toFixed(1)} s to synthesize`);
  }
  const timing = buildTiming(entries, {
    script: basename(o.scriptPath), voice: defaultVoice, format: o.format,
    sampleRate: engines.get(entries[0].voice).sampleRate, sentenceGap: o.sentenceGap
  });
  await writeFile(join(outDir, 'timing.json'), JSON.stringify(timing, null, 2) + '\n');
  return timing;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    console.error(`Error: ${e.message}\n\n${USAGE}`);
    return 64;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  try {
    const timing = await synthesizeScript({ ...opts, scriptPath: resolve(opts.script), log: (m) => console.log(m) });
    console.log(`Wrote ${timing.scenes.length} scene(s), ${timing.totalSeconds.toFixed(1)} s total, to ${resolve(opts.out)}`);
    console.log(`Timing: ${join(resolve(opts.out), 'timing.json')}`);
    return 0;
  } catch (e) {
    if (e instanceof MissingAssetsError) { console.error(`Error: ${e.message}`); return 2; }
    console.error(`Error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exit(code); });
}
