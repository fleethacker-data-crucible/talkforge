// piper-engine.js — multi-speaker Piper TTS using ONNX Runtime Web + phonemizer
// Based on the approach from clowerweb/piper-tts-web-demo

export class PiperEngine {
  constructor(voiceConfig, session, ort) {
    this.voiceConfig = voiceConfig;
    this.session = session;
    this.ort = ort;
  }

  static async load(modelUrl, configUrl, wasmPaths) {
    const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.mjs');
    // Only set wasmPaths if it is an absolute URL; relative paths get incorrectly
    // resolved against the CDN module URL and break loading.
    if (wasmPaths && (wasmPaths.startsWith('http') || wasmPaths.startsWith('/'))) {
      ort.env.wasm.wasmPaths = wasmPaths;
    }
    // otherwise leave the default CDN wasmPaths so the runtime can load its own files

    const [modelBuf, config] = await Promise.all([
      fetch(modelUrl).then(r => r.arrayBuffer()),
      fetch(configUrl).then(r => r.json())
    ]);

    const session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ['wasm']
    });

    return new PiperEngine(config, session, ort);
  }

  async textToPhonemes(text) {
    if (this.voiceConfig.phoneme_type === 'text') {
      return [Array.from(text.normalize('NFD'))];
    }
    const { phonemize } = await import('https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm');
    const voice = this.voiceConfig.espeak?.voice || 'en-us';
    const phonemes = await phonemize(text, voice);
    const phonemeText = Array.isArray(phonemes) ? phonemes.join('') : String(phonemes || text);
    // Keep punctuation so the model inserts pauses between sentences.
    return [Array.from(phonemeText.normalize('NFD'))];
  }

  phonemesToIds(textPhonemes) {
    const idMap = this.voiceConfig.phoneme_id_map;
    const BOS = '^', EOS = '$', PAD = '_';
    const ids = [];
    for (const sentence of textPhonemes) {
      ids.push(idMap[BOS], idMap[PAD]);
      for (const ph of sentence) {
        if (ph in idMap) {
          ids.push(idMap[ph], idMap[PAD]);
        }
      }
      ids.push(idMap[EOS]);
    }
    return ids;
  }

  async synthesize(text, speakerId = 0, lengthScale = 1.0) {
    const textPhonemes = await this.textToPhonemes(text);
    const phonemeIds = this.phonemesToIds(textPhonemes);

    const noiseScale = this.voiceConfig.inference?.noise_scale ?? 0.667;
    const noiseW = this.voiceConfig.inference?.noise_w ?? 0.8;

    const inputs = {
      input: new this.ort.Tensor('int64', new BigInt64Array(phonemeIds.map(id => BigInt(id))), [1, phonemeIds.length]),
      input_lengths: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(phonemeIds.length)]), [1]),
      scales: new this.ort.Tensor('float32', Float32Array.from([noiseScale, lengthScale, noiseW]), [3])
    };

    if ((this.voiceConfig.num_speakers || 1) > 1) {
      inputs.sid = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]);
    }

    const results = await this.session.run(inputs);
    const pcm = results.output.data;
    const sampleRate = this.voiceConfig.audio?.sample_rate || 22050;
    return this.pcmToWavBlob(pcm, sampleRate);
  }

  pcmToWavBlob(float32, sampleRate) {
    const numSamples = float32.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
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
    return new Blob([buffer], { type: 'audio/wav' });
  }

  getSpeakers() {
    if ((this.voiceConfig.num_speakers || 1) <= 1) {
      return [{ id: 0, name: 'Default' }];
    }
    const map = this.voiceConfig.speaker_id_map || {};
    return Object.entries(map)
      .sort(([, a], [, b]) => a - b)
      .map(([orig, id]) => ({ id, name: `Speaker ${id}`, originalId: orig }));
  }
}
