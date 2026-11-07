// tests/stt-utils.test.mjs - pure-function tests (Node, no browser, no model)
// Mirrors tests/tts-utils.test.mjs in style.
import { normalizeTranscript, downsample, createVad, requiredSttAssetPaths, formatMissingSttAssets, STT_MODEL_ID, STT_SAMPLE_RATE } from '../assets/vendor/stt-utils.js';
import assert from 'node:assert/strict';

function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log('stt-utils tests');

test('model is whisper-tiny.en at 16 kHz', () => {
  assert.equal(STT_MODEL_ID, 'whisper-tiny.en');
  assert.equal(STT_SAMPLE_RATE, 16000);
});

test('normalizeTranscript lowercases and collapses', () => {
  assert.equal(normalizeTranscript('Hello,  WORLD!'), 'hello world');
  assert.equal(normalizeTranscript(''), '');
  assert.equal(normalizeTranscript(null), '');
});

test('downsample empty and same rate', () => {
  assert.equal(downsample(new Float32Array(0), 16000).length, 0);
  assert.deepEqual([...downsample(new Float32Array([0.5, -0.5]), 16000)], [0.5, -0.5]);
});

test('downsample 48 kHz to 16 kHz averages triples', () => {
  const out = downsample(new Float32Array([0.3, 0.3, 0.3, 0.9, 0.9, 0.9]), 48000);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0] - 0.3) < 0.001);
  assert.ok(Math.abs(out[1] - 0.9) < 0.001);
});

test('downsample below 16 kHz throws', () => {
  assert.throws(() => downsample(new Float32Array([0.1, 0.2]), 8000), /below/);
});

function loudChunk(n) { return new Float32Array(n).fill(0.5); }
function quietChunk(n) { return new Float32Array(n).fill(0); }

test('VAD silence only returns null', () => {
  const vad = createVad();
  assert.equal(vad.feed(quietChunk(1600)), null);
  assert.equal(vad.feed(quietChunk(1600)), null);
});

test('VAD speech then silence returns the utterance', () => {
  const vad = createVad({ minSpeechMs: 100, endSilenceMs: 100 });
  assert.equal(vad.feed(loudChunk(1600)), null);
  assert.equal(vad.feed(loudChunk(1600)), null);
  const out = vad.feed(quietChunk(1600));
  assert.ok(out instanceof Float32Array);
  assert.ok(out.length >= 3200);
});

test('VAD speech shorter than minSpeech is dropped', () => {
  const vad = createVad({ minSpeechMs: 1000, endSilenceMs: 100 });
  vad.feed(loudChunk(160));
  const out = vad.feed(quietChunk(1600));
  assert.equal(out, null);
});

test('required STT assets include Whisper, exclude Piper and remote URLs', () => {
  const paths = requiredSttAssetPaths();
  assert.ok(paths.includes('stt/models/whisper-tiny.en/onnx/encoder_model_quantized.onnx'));
  assert.ok(paths.includes('stt/models/whisper-tiny.en/onnx/decoder_model_merged_quantized.onnx'));
  assert.ok(paths.includes('stt/transformers.min.js'));
  assert.ok(paths.includes('vendor/onnx/ort-wasm-simd-threaded.wasm'));
  assert.ok(!paths.some((p) => p.includes('piper') || p.includes('libritts') || p.startsWith('http')));
});

test('formatMissingSttAssets names files and the populate step', () => {
  const msg = formatMissingSttAssets(['stt/models/whisper-tiny.en/onnx/encoder_model_quantized.onnx']);
  assert.ok(msg.includes('encoder_model_quantized.onnx'));
  assert.ok(msg.includes('populate-assets'));
  assert.equal(formatMissingSttAssets([]), '');
});
