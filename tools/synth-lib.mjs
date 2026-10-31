// tools/synth-lib.mjs - pure helpers for synth-cli (no engine, no disk): script parsing,
// WAV/PCM handling, timing. Everything here is unit-tested in tests/synth-cli.test.mjs.
import { splitSentences } from '../assets/vendor/tts-utils.js';

export const DEFAULT_SENTENCE_GAP = 0.32; // seconds of silence between sentences inside a scene

// Speed (1 = normal, 2 = twice as fast) -> Piper lengthScale (duration multiplier).
export function speedToLengthScale(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) throw new Error(`Invalid speed: ${speed}`);
  if (s < 0.25 || s > 4) throw new Error(`Speed ${s} is out of range (0.25 to 4)`);
  return 1 / s;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function applyPronunciations(text, pron) {
  let out = text;
  for (const [from, to] of Object.entries(pron || {})) {
    if (!from) continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), () => String(to));
  }
  return out;
}

// Turn a script into a validated scene list.
//   Plain text: one scene per blank-line-separated paragraph (ids scene-01, scene-02, ...).
//   JSON: an array of scenes or strings, or { voice, speed, speaker, sceneGap, pronunciations, scenes }.
//   A scene is { id?, text (alias: tts), voice?, speed?, speaker?, pauseAfter? }.
// defaults: { voice, speed, speaker, sceneGap } from the command line / built-ins.
export function parseScript(source, { isJson = false, defaults = {} } = {}) {
  let top = {};
  let rawScenes;
  if (isJson) {
    let data;
    try { data = JSON.parse(source.replace(/^﻿/, '')); }
    catch (e) { throw new Error(`Script is not valid JSON: ${e.message}`); }
    if (Array.isArray(data)) rawScenes = data;
    else if (data && Array.isArray(data.scenes)) { top = data; rawScenes = data.scenes; }
    else throw new Error('JSON script must be an array of scenes or an object with a "scenes" array');
  } else {
    rawScenes = source.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  }
  if (!rawScenes.length) throw new Error('Script has no scenes');

  const base = {
    voice: top.voice ?? defaults.voice,
    speed: top.speed ?? defaults.speed ?? 1,
    speaker: top.speaker ?? defaults.speaker ?? 0,
    sceneGap: top.sceneGap ?? defaults.sceneGap ?? 0
  };
  const width = Math.max(2, String(rawScenes.length).length);
  const seen = new Set();
  return rawScenes.map((raw, i) => {
    const sc = typeof raw === 'string' ? { text: raw } : raw;
    if (!sc || typeof sc !== 'object') throw new Error(`Scene ${i + 1} must be a string or an object`);
    const id = sc.id != null ? String(sc.id) : `scene-${String(i + 1).padStart(width, '0')}`;
    if (!ID_RE.test(id)) throw new Error(`Scene ${i + 1}: id "${id}" must use only letters, digits, . _ - (it becomes the file name)`);
    if (seen.has(id.toLowerCase())) throw new Error(`Duplicate scene id: ${id}`);
    seen.add(id.toLowerCase());
    const rawText = sc.text ?? sc.tts;
    if (typeof rawText !== 'string' || !rawText.trim()) throw new Error(`Scene "${id}" has no text`);
    const text = applyPronunciations(rawText, top.pronunciations);
    const speed = sc.speed ?? base.speed;
    speedToLengthScale(speed); // validates
    const speaker = Number(sc.speaker ?? base.speaker);
    if (!Number.isInteger(speaker) || speaker < 0) throw new Error(`Scene "${id}": invalid speaker ${sc.speaker}`);
    const pauseAfter = Number(sc.pauseAfter ?? base.sceneGap);
    if (!Number.isFinite(pauseAfter) || pauseAfter < 0) throw new Error(`Scene "${id}": invalid pauseAfter`);
    return { id, text, voice: sc.voice ?? base.voice, speed: Number(speed), speaker, pauseAfter };
  });
}

export function splitScene(text, maxWords = 40) {
  return splitSentences(text, maxWords);
}

// 16-bit mono PCM (Buffer) -> complete WAV file (Buffer): one header, then the data.
export function wavFromPcm(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Complete WAV file (Buffer) from PiperEngine -> { sampleRate, pcm }. Walks chunks, 16-bit mono only.
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Engine did not return a RIFF/WAVE file');
  }
  let fmt = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), sampleRate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error('Expected 16-bit mono PCM WAV');
      return { sampleRate: fmt.sampleRate, pcm: buf.subarray(o + 8, Math.min(o + 8 + size, buf.length)) };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

// Join sentence PCM buffers with silence between them.
export function joinPcm(parts, sampleRate, gapSeconds) {
  const gap = Buffer.alloc(Math.round(Math.max(0, gapSeconds) * sampleRate) * 2);
  const out = [];
  parts.forEach((p, i) => { if (i > 0 && gap.length) out.push(gap); out.push(p); });
  return Buffer.concat(out);
}

// Peak and RMS of 16-bit PCM, normalised 0..1. Used to detect silent output.
export function pcmStats(pcm) {
  const n = Math.floor(pcm.length / 2);
  let peak = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
    if (v > peak) peak = v;
    sum += v * v;
  }
  return { samples: n, peak, rms: n ? Math.sqrt(sum / n) : 0 };
}

// scenes: [{ id, file, seconds, pauseAfter, ... }] in order -> timeline with start/duration.
// Scene files carry no trailing silence; pauseAfter only moves the next start.
export function buildTiming(entries, meta = {}) {
  let t = 0;
  const scenes = entries.map((e) => {
    const start = t;
    t += e.seconds + (e.pauseAfter || 0);
    return {
      id: e.id, file: e.file, start: round3(start), duration: round3(e.seconds),
      voice: e.voice, speed: e.speed, speaker: e.speaker, text: e.text
    };
  });
  const last = scenes[scenes.length - 1];
  return { ...meta, totalSeconds: last ? round3(last.start + last.duration) : 0, scenes };
}

export function round3(x) { return Math.round(x * 1000) / 1000; }
