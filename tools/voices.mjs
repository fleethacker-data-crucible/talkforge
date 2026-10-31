// tools/voices.mjs - which Piper voices exist in the local assets folder, and which are usable now.
// Offline: reads assets/models.json (the catalogue the page uses) and assets/models/*.onnx.json
// (tracked configs), and checks for the .onnx model file. No engine is loaded.
import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_VOICE } from './node-engine.mjs';

export const VOICES_SCHEMA = 'talkforge.voices/1';

async function readJson(file) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')); } catch { return null; }
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

// Returns [{ id, label, installed, default, speakers, sampleRate, quality, language }] sorted by id.
// installed = the .onnx model file is present (the config alone is not enough to speak).
export async function listVoices(assetsDir, defaultVoice = DEFAULT_VOICE) {
  const dir = resolve(assetsDir);
  const catalogue = (await readJson(join(dir, 'models.json')))?.models ?? [];
  const labels = new Map(catalogue.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m.label || m.id]));
  const ids = new Set(labels.keys());
  let files = [];
  try { files = await readdir(join(dir, 'models')); } catch { /* no models folder yet */ }
  for (const f of files) {
    const m = /^(.+)\.onnx(\.json)?$/.exec(f);
    if (m) ids.add(m[1]);
  }
  const voices = [];
  for (const id of [...ids].sort()) {
    const cfg = await readJson(join(dir, 'models', `${id}.onnx.json`));
    voices.push({
      id,
      label: labels.get(id) || id,
      installed: await exists(join(dir, 'models', `${id}.onnx`)),
      default: id === defaultVoice,
      speakers: cfg?.num_speakers || 1,
      sampleRate: cfg?.audio?.sample_rate ?? null,
      quality: cfg?.audio?.quality ?? null,
      language: cfg?.language?.code ?? null
    });
  }
  return voices;
}

export async function voicesDocument(assetsDir, { installedOnly = false, defaultVoice = DEFAULT_VOICE } = {}) {
  let voices = await listVoices(assetsDir, defaultVoice);
  if (installedOnly) voices = voices.filter((v) => v.installed);
  return { schema: VOICES_SCHEMA, default: defaultVoice, assets: resolve(assetsDir), voices };
}

export function formatVoices(doc) {
  const rows = doc.voices.map((v) => [v.id + (v.default ? ' *' : ''), v.installed ? 'installed' : 'missing', String(v.speakers), v.sampleRate ? `${v.sampleRate} Hz` : '-', v.language || '-']);
  const head = ['VOICE', 'STATE', 'SPEAKERS', 'RATE', 'LANG'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), ...rows.map(line), '', `* default voice (${doc.default}). "missing" voices need populate-assets before they can speak.`].join('\n');
}
