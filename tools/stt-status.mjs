#!/usr/bin/env node
// tools/stt-status.mjs - speech-to-text asset preflight (Node, no browser, no model).
// Mirrors `talkforge assets status` for TTS, but for the STT model only.
// Usage: node tools/stt-status.mjs [--json] [--no-hash] [--manifest <file>] [--assets <dir>]
// Exit 0 ready, 2 not ready, 64 bad usage. Never downloads anything.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: node tools/stt-status.mjs [--json] [--no-hash] [--manifest <file>] [--assets <dir>]

Checks every file TalkForge-stt.html needs (whisper-tiny.en + transformers.js + shared
ONNX Runtime WASM) against assets-manifest.json. Prints PRESENT/OK/MISSING/MISMATCH per
file and, when something is missing, the populate-assets command to fetch it.
Exit 0 when ready, 2 when not, 64 for bad usage. Never downloads.`;

const DEFAULT_MANIFEST = resolve(fileURLToPath(new URL('../assets-manifest.json', import.meta.url)));
const DEFAULT_ASSETS = resolve(fileURLToPath(new URL('../assets', import.meta.url)));
const STT_DESTS = [
  'stt/transformers.min.js',
  'stt/models/whisper-tiny.en/config.json',
  'stt/models/whisper-tiny.en/generation_config.json',
  'stt/models/whisper-tiny.en/preprocessor_config.json',
  'stt/models/whisper-tiny.en/tokenizer.json',
  'stt/models/whisper-tiny.en/tokenizer_config.json',
  'stt/models/whisper-tiny.en/added_tokens.json',
  'stt/models/whisper-tiny.en/special_tokens_map.json',
  'stt/models/whisper-tiny.en/onnx/encoder_model_quantized.onnx',
  'stt/models/whisper-tiny.en/onnx/decoder_model_merged_quantized.onnx',
  'vendor/onnx/ort-wasm-simd-threaded.wasm',
  'vendor/onnx/ort-wasm-simd-threaded.jsep.wasm'
];

function parseArgs(argv) {
  const o = { json: false, noHash: false, manifest: DEFAULT_MANIFEST, assets: DEFAULT_ASSETS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-hash') o.noHash = true;
    else if (a === '--manifest') o.manifest = resolve(argv[++i] || '');
    else if (a === '--assets') o.assets = resolve(argv[++i] || '');
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!o.manifest || !o.assets) throw new Error('Missing --manifest or --assets value');
  return o;
}

function hashFile(path, isJson) {
  let buf = readFileSync(path);
  if (isJson) buf = Buffer.from(buf.toString('utf8').replace(/\r/g, ''));
  return createHash('sha256').update(buf).digest('hex');
}

export function sttStatus(opts) {
  const manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
  const byDest = new Map((manifest.assets || []).map((a) => [a.dest, a.sha256]));
  const files = STT_DESTS.map((dest) => {
    const path = join(opts.assets, dest);
    const expected = byDest.get(dest);
    if (!expected) return { dest, state: 'NOT_IN_MANIFEST', expected: null, actual: null, bytes: 0 };
    if (!existsSync(path)) return { dest, state: 'MISSING', expected, actual: null, bytes: 0 };
    const buf = readFileSync(path);
    if (opts.noHash) return { dest, state: 'PRESENT', expected, actual: null, bytes: buf.length };
    const actual = hashFile(path, dest.endsWith('.json'));
    return { dest, state: actual === expected ? 'OK' : 'MISMATCH', expected, actual, bytes: buf.length };
  });
  const ok = files.every((f) => f.state === 'OK' || f.state === 'PRESENT');
  return { schema: 'talkforge.stt-status/1', model: 'whisper-tiny.en', assets: opts.assets, ok, files, fetch: ok ? null : 'populate-assets (see docs/STT.md)' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(USAGE); console.error(e.message); process.exit(64); }
  if (opts.help) { console.log(USAGE); process.exit(0); }
  let result;
  try { result = sttStatus(opts); } catch (e) { console.error('stt-status failed: ' + e.message); process.exit(1); }
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const f of result.files) console.log(`${f.state.padEnd(8)} ${f.dest}`);
    console.log(result.ok ? 'STT ready.' : `STT not ready. ${result.fetch}`);
  }
  process.exit(result.ok ? 0 : 2);
}
