// assets/vendor/stt-utils.js - pure helpers for TalkForge speech-to-text (Node + browser).
// No browser APIs, no network, no model code here. Adapted from the fleet precedent
// in PacketRat Web/voice-input.js (energy VAD, downsample), not from Handy.
// TalkForge STT v1: Whisper tiny.en, English only, in-browser, local assets only.
export const STT_MODEL_ID = 'whisper-tiny.en';
export const STT_SAMPLE_RATE = 16000;

export function normalizeTranscript(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function downsample(input, inRate, outRate) {
  outRate = outRate || STT_SAMPLE_RATE;
  if (!input || !input.length) return new Float32Array(0);
  if (inRate === outRate) return Float32Array.from(input);
  if (inRate < outRate) throw new Error('Input rate is below ' + outRate + ' Hz.');
  const ratio = inRate / outRate;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

// Energy VAD: feed 16 kHz chunks, get back one Float32Array per finished utterance (or null).
// Handy uses Silero (neural) VAD; v1 uses this energy VAD, the PacketRat precedent, because it
// needs no extra model file. It is weaker in noise than Silero - that is a documented v1 limit.
export function createVad(opts) {
  opts = opts || {};
  const rate = opts.rate || STT_SAMPLE_RATE;
  const threshold = opts.threshold || 0.015;
  const minSpeech = (opts.minSpeechMs || 250) * rate / 1000;
  const endSilence = (opts.endSilenceMs || 700) * rate / 1000;
  const maxLen = (opts.maxMs || 15000) * rate / 1000;
  let buf = [];
  let speech = 0;
  let silence = 0;
  let active = false;
  function rms(c) {
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    return Math.sqrt(s / (c.length || 1));
  }
  function flush() {
    let out = null;
    if (active && speech >= minSpeech) {
      const total = buf.reduce((n, c) => n + c.length, 0);
      out = new Float32Array(total);
      let o = 0;
      buf.forEach((c) => { out.set(c, o); o += c.length; });
    }
    buf = [];
    speech = 0;
    silence = 0;
    active = false;
    return out;
  }
  return {
    feed(chunk) {
      const loud = rms(chunk) >= threshold;
      if (!active) { if (!loud) return null; active = true; }
      buf.push(chunk);
      if (loud) { speech += chunk.length; silence = 0; } else silence += chunk.length;
      const len = buf.reduce((n, c) => n + c.length, 0);
      if (silence >= endSilence || len >= maxLen) return flush();
      return null;
    },
    reset() { buf = []; speech = 0; silence = 0; active = false; }
  };
}

// Files the STT page must find under assets/, relative to assets/.
// No Piper files here: STT does not need a TTS voice. ORT WASM is shared with TTS
// and is already in assets/vendor/onnx/ - it is listed here so the page can check it,
// not so it is downloaded twice.
export function requiredSttAssetPaths() {
  return [
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
}

export function formatMissingSttAssets(missing) {
  if (!missing || !missing.length) return '';
  return 'Speech-to-text assets missing: ' + missing.join(', ') + '. Run populate-assets (see docs/STT.md) on a machine with access, then copy the folder to this workstation. Nothing is downloaded at run time.';
}
