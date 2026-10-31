// tools/synth-core.mjs - text in, audio bytes out, offline. Shared by synth-cli (scripts),
// talkforge speak (one text) and talkforge serve (loopback endpoint).
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, loadVoice } from './node-engine.mjs';
import { DEFAULT_SENTENCE_GAP, joinPcm, parseWav, pcmStats, speedToLengthScale, splitScene, wavFromPcm } from './synth-lib.mjs';

export const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg' };

export async function loadLame(assetsDir) {
  const here = dirname(fileURLToPath(import.meta.url));
  let code;
  try { code = await readFile(join(assetsDir, 'vendor', 'lame.min.js'), 'utf8'); }
  catch { code = await readFile(join(here, '..', 'assets', 'vendor', 'lame.min.js'), 'utf8'); }
  const ctx = {}; ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.lamejs;
}

export function encodeMp3(lamejs, pcm, sampleRate) {
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

// Voices are loaded on first use and kept. Calls to render() are safe to overlap: they run one
// at a time, because one ONNX session should not be driven concurrently.
export function createSynthesizer({ assets = DEFAULT_ASSETS_DIR, defaultVoice = DEFAULT_VOICE, sentenceGap = DEFAULT_SENTENCE_GAP, log = () => {} } = {}) {
  const assetsDir = resolve(assets);
  const voices = new Map();
  let lame = null;
  let chain = Promise.resolve();

  async function load(voice = defaultVoice) {
    if (!voices.has(voice)) {
      log(`Loading voice ${voice} ...`);
      voices.set(voice, loadVoice(voice, assetsDir).catch((e) => { voices.delete(voice); throw e; }));
    }
    return voices.get(voice);
  }

  async function renderNow({ text, voice = defaultVoice, speed = 1, speaker = 0, format = 'wav', sentenceGap: gap = sentenceGap }) {
    if (!MIME[format]) throw new Error(`Unsupported format "${format}" (wav or mp3)`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('No text to speak');
    const lengthScale = speedToLengthScale(speed);
    const { engine, sampleRate } = await load(voice);
    const sentences = splitScene(text);
    const parts = [];
    for (const sentence of sentences) {
      const wav = Buffer.from(await (await engine.synthesize(sentence, speaker, lengthScale)).arrayBuffer());
      const parsed = parseWav(wav);
      if (parsed.sampleRate !== sampleRate) throw new Error(`Unexpected sample rate ${parsed.sampleRate}`);
      parts.push(parsed.pcm);
    }
    const pcm = joinPcm(parts, sampleRate, gap);
    const stats = pcmStats(pcm);
    if (stats.samples === 0 || stats.peak < 0.01) throw new Error(`Audio came out silent (peak ${stats.peak.toFixed(4)})`);
    if (format === 'mp3' && !lame) lame = await loadLame(assetsDir);
    const bytes = format === 'mp3' ? encodeMp3(lame, pcm, sampleRate) : wavFromPcm(pcm, sampleRate);
    return { bytes, mime: MIME[format], seconds: stats.samples / sampleRate, sampleRate, sentences: sentences.length, voice };
  }

  function render(req) {
    const run = chain.then(() => renderNow(req));
    chain = run.catch(() => {});
    return run;
  }

  return { load, render, assetsDir, defaultVoice };
}
