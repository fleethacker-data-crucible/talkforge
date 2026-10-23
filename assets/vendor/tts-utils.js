// tts-utils.js — pure functions for Piper TTS page (testable under Node)

export function splitSentences(text) {
  if (!text || !text.trim()) return [];
  const parts = text.match(/[^.!?]+[.!?]+|\S+/g) || [text];
  const chunks = [];
  let current = '';
  for (const p of parts) {
    if ((current + p).length > 280 && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? ' ' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
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
