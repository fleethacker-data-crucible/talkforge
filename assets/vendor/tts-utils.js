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

// Speed slider (1.0 = normal, 2.0 = twice as fast) -> Piper lengthScale.
// lengthScale is the duration multiplier, so it is the reciprocal of speed.
// This is the ONLY place speed is applied; do not also set playbackRate.
export function speedToLengthScale(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1.0;
  return 1 / Math.min(4, Math.max(0.25, s));
}

// Parse a canonical PCM WAV (walks chunks, so extra chunks such as LIST are tolerated).
export function parseWav(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let fmt = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      const end = Math.min(body + size, bytes.length);
      return { ...fmt, pcm: bytes.subarray(body, end) };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

// Join several WAV files into ONE valid WAV: a single header plus the concatenated
// PCM data. All inputs must share sample rate, channels and bit depth.
// gapSeconds inserts silence between parts.
export function concatWavBuffers(buffers, gapSeconds = 0) {
  if (!buffers.length) throw new Error('No audio to join');
  const parts = buffers.map(parseWav);
  const first = parts[0];
  if (first.format !== 1) throw new Error('Only PCM WAV is supported');
  for (const p of parts) {
    if (p.format !== first.format || p.channels !== first.channels
      || p.sampleRate !== first.sampleRate || p.bitsPerSample !== first.bitsPerSample) {
      throw new Error('Cannot join WAV files with different formats');
    }
  }
  const frameBytes = first.channels * (first.bitsPerSample / 8);
  const gapBytes = Math.round(Math.max(0, gapSeconds) * first.sampleRate) * frameBytes;
  const dataLen = parts.reduce((n, p) => n + p.pcm.length, 0) + gapBytes * (parts.length - 1);
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const str = (o, t) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, first.channels, true); view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.sampleRate * frameBytes, true); view.setUint16(32, frameBytes, true);
  view.setUint16(34, first.bitsPerSample, true);
  str(36, 'data'); view.setUint32(40, dataLen, true);
  let pos = 44;
  parts.forEach((p, i) => {
    if (i > 0) pos += gapBytes; // already zero-filled
    out.set(p.pcm, pos);
    pos += p.pcm.length;
  });
  return out.buffer;
}

// Share one in-flight async load per key. Callers that arrive while a load is running get the same
// promise, so the work (for example a 137 MB model) is not started twice. A failed load is forgotten
// so the next call retries.
export function loadOnce(inFlight, key, start) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve().then(start).finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}
