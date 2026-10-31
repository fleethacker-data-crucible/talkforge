// tts-utils.js — pure functions for the TalkForge-tts page (testable under Node)

// Collapse consecutive whitespace and newlines so blank lines don't become long pauses.
export function normalizeWhitespace(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

// Split on sentence boundaries, with a word-count cap so speaker changes land quickly.
export function splitSentences(text, maxWords = 40) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      if (words.length) chunks.push(words.join(' '));
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(' '));
    }
  }
  return chunks;
}

export function pcmToWavArrayBuffer(float32, sampleRate) {
  const numSamples = float32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

export function filterSpeakers(speakers, query) {
  const q = (query || '').toLowerCase();
  if (!q) return speakers;
  return speakers.filter(s =>
    s.name.toLowerCase().includes(q) || String(s.id).includes(q)
  );
}

export function parseModelsJson(data) {
  if (!data || !Array.isArray(data.models)) return [];
  return data.models
    .filter(m => m && typeof m.id === 'string')
    .map(m => ({ id: m.id, label: m.label || m.id, default: !!m.default }));
}

// Local files the page needs for a given model (paths relative to the assets folder).
export function requiredAssetPaths(modelId) {
  return [
    `models/${modelId}.onnx`,
    `models/${modelId}.onnx.json`,
    'vendor/onnx/ort-wasm-simd-threaded.jsep.wasm',
    'wasm/piper_phonemize.wasm',
    'wasm/piper_phonemize.data'
  ];
}

// Plain-language message for offline mode when files are absent.
export function formatMissingAssets(missing) {
  if (!missing || !missing.length) return '';
  const list = missing.map(p => `assets/${p}`).join(', ');
  return `Offline assets missing (${missing.length}): ${list}. ` +
    'TalkForge never downloads these itself. Run populate-assets.bat (Windows) or ./populate-assets.sh, then reload.';
}
