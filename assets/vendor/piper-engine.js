// piper-engine.js — multi-speaker Piper TTS using ONNX Runtime Web + local piper_phonemize
// Based on the approach from clowerweb/piper-tts-web-demo

export class PiperEngine {
  constructor(voiceConfig, session, ort, phonemizeFactory, phonemePaths) {
    this.voiceConfig = voiceConfig;
    this.session = session;
    this.ort = ort;
    this.phonemizeFactory = phonemizeFactory;
    this.phonemePaths = phonemePaths;
  }

  static async load(modelUrl, configUrl, wasmPaths, phonemePaths) {
    // Local ONNX Runtime Web (no CDN). wasmPaths must be absolute and must
    // point at the directory that contains both the .mjs loaders and the .wasm
    // files (assets/vendor/onnx/).
    const ort = await import('./onnx/ort.min.mjs');
    if (wasmPaths) {
      const abs = wasmPaths.startsWith('http') || wasmPaths.startsWith('/')
        ? wasmPaths
        : new URL(wasmPaths, window.location.href).href;
      ort.env.wasm.wasmPaths = abs;
    }

    const [modelBuf, config, phonemizeMod] = await Promise.all([
      fetch(modelUrl).then(r => r.arrayBuffer()),
      fetch(configUrl).then(r => r.json()),
      import('./dist/piper-o91UDS6e.js')
    ]);

    const session = await ort.InferenceSession.create(modelBuf, {
      executionProviders: ['wasm']
    });

    const factory = phonemizeMod.createPiperPhonemize || phonemizeMod.default;
    return new PiperEngine(config, session, ort, factory, phonemePaths || {});
  }

  async textToPhonemeIds(text) {
    const voice = this.voiceConfig.espeak?.voice || 'en-us';
    const input = JSON.stringify([{ text: text.trim() }]);
    const paths = this.phonemePaths || {};
    const phonemeIds = await new Promise(async (resolve, reject) => {
      try {
        const module = await this.phonemizeFactory({
          print: (data) => {
            try { resolve(JSON.parse(data).phoneme_ids); }
            catch (e) { reject(e); }
          },
          printErr: (message) => reject(new Error(message)),
          locateFile: (url) => {
            if (url.endsWith('.wasm') && paths.wasm) return paths.wasm;
            if (url.endsWith('.data') && paths.data) return paths.data;
            return url;
          }
        });
        module.callMain([
          '-l', voice,
          '--input', input,
          '--espeak_data', '/espeak-ng-data'
        ]);
      } catch (e) {
        reject(e);
      }
    });
    return phonemeIds;
  }

  async synthesize(text, speakerId = 0, lengthScale = 1.0) {
    const phonemeIds = await this.textToPhonemeIds(text);

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
