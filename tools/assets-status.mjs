// tools/assets-status.mjs - preflight for a render stage: are the downloaded files a voice needs
// present and the right bytes? Offline: reads the manifest, stats and hashes local files, and prints
// the exact populate-assets command that would fetch what is missing. It never downloads anything.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, requiredFiles } from './node-engine.mjs';

export const ASSETS_SCHEMA = 'talkforge.assets/1';
export const DEFAULT_MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets-manifest.json');

// Same rule as populate-assets: .json files are hashed with CR bytes removed (checkouts may be CRLF).
export function sha256Of(buffer, dest) {
  const data = dest.endsWith('.json') ? Buffer.from(buffer.filter((b) => b !== 13)) : buffer;
  return createHash('sha256').update(data).digest('hex');
}

// Returns { schema, voice, assets, ok, files: [{ dest, state, expected, actual?, bytes? }], fetch }.
// state: ok | present (not hashed) | missing | mismatch.
export async function assetsStatus({ assetsDir = DEFAULT_ASSETS_DIR, manifestPath = DEFAULT_MANIFEST, voice = DEFAULT_VOICE, hash = true } = {}) {
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, ''));
  const byDest = new Map(manifest.assets.map((a) => [a.dest, a]));
  if (!byDest.has(`models/${voice}.onnx`)) {
    const known = manifest.assets.map((a) => /^models\/(.+)\.onnx$/.exec(a.dest)?.[1]).filter(Boolean);
    const e = new Error(`Voice "${voice}" is not in the asset manifest. Known voices: ${known.join(', ')}`);
    e.code = 'UNKNOWN_VOICE';
    throw e;
  }
  const root = resolve(assetsDir);
  const files = [];
  for (const dest of requiredFiles(voice).filter((d) => byDest.has(d))) {
    const expected = String(byDest.get(dest).sha256 || '').toLowerCase();
    const entry = { dest, state: 'missing', expected };
    let buf = null;
    try { buf = await readFile(join(root, dest)); entry.bytes = (await stat(join(root, dest))).size; } catch { /* missing */ }
    if (buf) {
      if (!hash) entry.state = 'present';
      else {
        entry.actual = sha256Of(buf, dest);
        entry.state = entry.actual === expected ? 'ok' : 'mismatch';
      }
    }
    files.push(entry);
  }
  const need = files.filter((f) => f.state === 'missing' || f.state === 'mismatch').map((f) => f.dest);
  return {
    schema: ASSETS_SCHEMA, voice, assets: root,
    ok: need.length === 0,
    files,
    fetch: need.length === 0 ? null : {
      note: 'Run on a build or internet-connected machine, then copy the files across. A file reported as mismatch must be deleted first; populate-assets will not overwrite it.',
      powershell: `powershell -ExecutionPolicy Bypass -File .\\populate-assets.ps1 -Only ${need.map((d) => `'${d}'`).join(',')}`,
      shell: `TALKFORGE_ONLY="${need.join(',')}" ./populate-assets.sh`
    }
  };
}

export function formatAssetsStatus(doc) {
  const rows = doc.files.map((f) => [f.state.toUpperCase(), f.dest, f.bytes != null ? `${(f.bytes / 1048576).toFixed(1)} MB` : '-']);
  const w = Math.max(...rows.map((r) => r[1].length));
  const lines = [`Voice ${doc.voice}  (assets: ${doc.assets})`, ...rows.map((r) => `  ${r[0].padEnd(8)} ${r[1].padEnd(w)}  ${r[2]}`)];
  lines.push(doc.ok ? 'All files present and verified.' : 'Not ready. To fetch what is missing:', ...(doc.fetch ? [`  ${doc.fetch.powershell}`, `  ${doc.fetch.shell}`, `  (${doc.fetch.note})`] : []));
  return lines.join('\n');
}
