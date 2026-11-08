// tools/node-engine.mjs - load the real PiperEngine (ONNX Runtime Web + WASM) under Node, fully
// offline, from the local assets folder. No browser, no Playwright, no network.
//
// How it works: the engine is browser code. Node needs (1) fetch() to understand file: URLs,
// (2) require/__dirname for the Emscripten phonemizer, and (3) ORT run single-threaded so it
// imports its loader from disk instead of through a blob: URL. This module installs those
// shims, then calls PiperEngine.load exactly as the page does.
import { createRequire } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_VOICE = 'en_US-libritts-high';
export const DEFAULT_ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// Files a voice needs, relative to the assets folder (the same set the page checks).
export function requiredFiles(voice) {
  return [
    `models/${voice}.onnx`,
    `models/${voice}.onnx.json`,
    'vendor/onnx/ort-wasm-simd-threaded.jsep.wasm',
    'wasm/piper_phonemize.wasm',
    'wasm/piper_phonemize.data',
    'vendor/piper-engine.js',
    'vendor/onnx/ort.min.mjs',
    'vendor/onnx/ort-wasm-simd-threaded.jsep.mjs',
    'vendor/dist/piper-o91UDS6e.js'
  ];
}

export class MissingAssetsError extends Error {
  constructor(assetsDir, missing) {
    const list = missing.map((p) => `  - ${join(assetsDir, p)}`).join('\n');
    super(
      `TalkForge assets are missing (${missing.length} file(s)):\n${list}\n` +
      'Nothing is downloaded by this tool. Run populate-assets.ps1 (Windows) or ./populate-assets.sh ' +
      '(optionally limited with -Only / TALKFORGE_ONLY), or point --assets at a folder that has them.'
    );
    this.name = 'MissingAssetsError';
    this.missing = missing;
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Returns the list of required files (relative to assetsDir) that are not on disk.
export async function findMissingAssets(assetsDir, voice) {
  const missing = [];
  for (const rel of requiredFiles(voice)) {
    if (!(await exists(join(assetsDir, rel)))) missing.push(rel);
  }
  return missing;
}

let shimsInstalled = false;
function installShims(assetsDir) {
  if (shimsInstalled) return;
  shimsInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const s = String(input);
    if (s.startsWith('file:')) {
      const buf = await readFile(new URL(s));
      const type = s.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return new Response(buf, { status: 200, headers: { 'content-type': type } });
    }
    return realFetch(input, init);
  };
  // The Emscripten phonemizer calls require("fs") and uses __dirname when it detects Node.
  globalThis.require = createRequire(import.meta.url);
  globalThis.__dirname = join(assetsDir, 'vendor', 'dist');
}

// Load a voice. Resolves { engine, sampleRate }. Throws MissingAssetsError if files are absent.
export async function loadVoice(voice = DEFAULT_VOICE, assetsDir = DEFAULT_ASSETS_DIR) {
  assetsDir = resolve(assetsDir);
  const missing = await findMissingAssets(assetsDir, voice);
  if (missing.length) throw new MissingAssetsError(assetsDir, missing);
  installShims(assetsDir);
  const url = (rel) => pathToFileURL(join(assetsDir, rel)).href;
  // Same module instance the engine will import, so these settings take effect.
  const ort = await import(url('vendor/onnx/ort.min.mjs'));
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // PiperEngine.load would resolve a wasm location against window.location (browser only), so
  // set the wasm folder here and pass null for it.
  ort.env.wasm.wasmPaths = url('vendor/onnx/');
  const { PiperEngine } = await import(url('vendor/piper-engine.js'));
  const engine = await PiperEngine.load(
    url(`models/${voice}.onnx`),
    url(`models/${voice}.onnx.json`),
    null,
    { wasm: join(assetsDir, 'wasm', 'piper_phonemize.wasm'), data: join(assetsDir, 'wasm', 'piper_phonemize.data') }
  );
  return { engine, sampleRate: engine.voiceConfig.audio?.sample_rate || 22050 };
}
