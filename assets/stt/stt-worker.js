/* TalkForge speech-to-text worker. Loads transformers.js and a Whisper model ONLY from
   the TalkForge assets folder (same origin, SHA-256 listed in assets-manifest.json).
   Remote model hosts are switched off, so a missing file is an error, never a download.
   NOT exercised by the offline tests: it needs the assets, which are not in the repo.
   The page passes the asset URLs on the load message, so this worker never hard-codes
   an absolute origin path. Defaults are relative to this worker file in assets/stt/. */
let asr = null;

async function load(cfg) {
  cfg = cfg || {};
  const transformersUrl = cfg.transformersUrl || './transformers.min.js';
  const modelPath = cfg.modelPath || './models/';
  const wasmPaths = cfg.wasmPaths || '../vendor/onnx/';
  const lib = await import(transformersUrl);
  const env = lib.env;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelPath;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = wasmPaths;
  env.backends.onnx.wasm.numThreads = 1;
  asr = await lib.pipeline('automatic-speech-recognition', 'whisper-tiny.en', { dtype: 'q8', device: 'wasm' });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      await load(m.config);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'transcribe') {
      if (!asr) throw new Error('The speech model is not loaded.');
      const out = await asr(m.audio);
      self.postMessage({ type: 'text', id: m.id, text: String((out && out.text) || '').trim() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
