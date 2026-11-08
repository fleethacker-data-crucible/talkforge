// tests/smoke-synth.test.mjs - offline synthesis smoke test: a short text through the REAL engine
// (ONNX Runtime Web + phonemizer WASM, under Node) and checks on the WAV it produces.
//
// Needs the local assets. By default a missing asset SKIPS the test (fresh clone, no models);
// with TALKFORGE_REQUIRE_ASSETS=1 (set in CI) a missing asset FAILS it, so CI cannot go green
// without actually synthesizing. TALKFORGE_ASSETS and TALKFORGE_TEST_VOICE override the
// assets folder and voice (CI uses en_US-libritts-high, which was trained from scratch).
import assert from 'node:assert/strict';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, findMissingAssets, loadVoice } from '../tools/node-engine.mjs';
import { parseWav, pcmStats } from '../tools/synth-lib.mjs';

const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
const TEXT = 'Hello from TalkForge. This is an offline smoke test.';

console.log(`smoke-synth (voice ${voice}, assets ${assetsDir})`);

const missing = await findMissingAssets(assetsDir, voice);
if (missing.length) {
  if (process.env.TALKFORGE_REQUIRE_ASSETS) {
    console.error(`  FAIL assets required but missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`  skip ${missing.length} asset file(s) missing (run populate-assets); set TALKFORGE_REQUIRE_ASSETS=1 to fail instead`);
  process.exit(0);
}

let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

const { engine, sampleRate } = await loadVoice(voice, assetsDir);
const synth = async (text, lengthScale = 1) => Buffer.from(await (await engine.synthesize(text, 0, lengthScale)).arrayBuffer());

let normal;
await test('engine returns a valid WAV (header sizes consistent, 16-bit mono PCM)', async () => {
  normal = await synth(TEXT);
  assert.equal(normal.toString('latin1', 0, 4), 'RIFF');
  assert.equal(normal.toString('latin1', 8, 12), 'WAVE');
  assert.equal(normal.readUInt32LE(4), normal.length - 8, 'RIFF size');
  const { sampleRate: rate, pcm } = parseWav(normal);
  assert.equal(rate, sampleRate);
  assert.equal(normal.readUInt32LE(40), pcm.length, 'data size');
  assert.equal(pcm.length % 2, 0);
});

await test('audio is plausible speech length and not silent', () => {
  const { pcm } = parseWav(normal);
  const seconds = pcm.length / 2 / sampleRate;
  assert.ok(seconds > 1.5 && seconds < 8, `duration ${seconds.toFixed(2)} s`);
  const st = pcmStats(pcm);
  assert.ok(st.peak > 0.05, `peak ${st.peak.toFixed(3)}`);
  assert.ok(st.rms > 0.01, `rms ${st.rms.toFixed(4)}`);
  assert.ok(st.peak <= 1);
});

await test('speed applies once: lengthScale 0.5 is clearly shorter than 1.0', async () => {
  const fast = await synth(TEXT, 0.5);
  const a = parseWav(normal).pcm.length;
  const b = parseWav(fast).pcm.length;
  assert.ok(b < a * 0.75, `fast ${b} vs normal ${a}`);
  assert.ok(b > a * 0.3, `fast ${b} vs normal ${a}`);
});

process.exit(failed ? 1 : 0);
