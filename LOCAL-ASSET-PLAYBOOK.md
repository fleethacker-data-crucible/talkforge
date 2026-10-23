# Piper TTS Local-Asset Playbook

Self-hosting guide for the client-side Piper TTS page so it runs entirely on an intranet with no external CDN or Hugging Face calls.

## Goal

Replace every external dependency with files served from the same origin (or an internal static host) so the page works offline or behind a firewall.

## Directory structure

```
piper-tts.html
assets/
├── MANIFEST.md
├── vendor/
│   ├── piper-tts-web.js
│   └── lame.min.js
├── wasm/
│   ├── onnx/                  # ONNX Runtime WASM binaries
│   ├── piper_phonemize.wasm
│   └── piper_phonemize.data
└── models/
    ├── en_US-libritts_r-medium.onnx
    ├── en_US-libritts_r-medium.onnx.json
    └── ... (other voices)
```

## Step 1 – Obtain the JavaScript libraries

### piper-tts-web
```bash
npm pack @realtimex/piper-tts-web@1.1.1
# or clone the repo and build
# Extract dist/piper-tts-web.js into assets/vendor/
```

### lamejs
```bash
npm pack lamejs
# copy lame.min.js (or lame.all.js) into assets/vendor/
```

Alternatively download once from a machine that has internet access and copy the files across.

## Step 2 – Obtain WASM binaries

The library expects ONNX Runtime WebAssembly and the Piper phonemizer.

Typical sources:
- `onnxruntime-web` npm package → `dist/*.wasm`
- `@diffusionstudio/piper-wasm` or the files referenced in the piper-tts-web fixtures

Place them under `assets/wasm/` as shown above.  
Update the `wasmPaths` object in the HTML if your filenames differ.

## Step 3 – Obtain voice models

Download from the official Piper voices repository:

- https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/libritts_r/medium
- https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/libritts/high
- (or the diffusionstudio mirror used by some browser builds)

Required pair for the default model:
- `en_US-libritts_r-medium.onnx` (~75 MB)
- `en_US-libritts_r-medium.onnx.json`

Copy into `assets/models/`.

## Step 4 – Configure the page

The revised `piper-tts.html` already defaults to relative paths:

```js
const ASSET_BASE = './assets';
// ...
wasmPaths: {
  onnxWasm: `${ASSET_BASE}/wasm/onnx/`,
  piperData: `${ASSET_BASE}/wasm/piper_phonemize.data`,
  piperWasm: `${ASSET_BASE}/wasm/piper_phonemize.wasm`
}
```

If you need a different base path (e.g. `/static/tts/`), change the single `ASSET_BASE` constant.

## Step 5 – Serve

Any static file server works:

```bash
# from the directory containing piper-tts.html and assets/
python3 -m http.server 8080
# or nginx, Caddy, IIS, etc.
```

Open `http://your-intranet-host/piper-tts.html`.

## Verification checklist

- [ ] `piper-tts.html` loads without console 404s for JS
- [ ] Model selector shows “LibriTTS-R Medium”
- [ ] First Play triggers local model load (progress bar) and speech
- [ ] Subsequent plays are instant (browser + OPFS cache)
- [ ] Download MP3 produces a single concatenated file
- [ ] Network tab shows zero requests to jsdelivr, unpkg, or huggingface.co

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| “Failed to fetch” on model | Model file missing or wrong name | Confirm exact filename in `assets/models/` |
| WASM load error | Incorrect `wasmPaths` | Match paths to actual files |
| No sound | Audio autoplay policy | Ensure Play is triggered by a user gesture |
| Slow first load | Large model download | Expected; later loads use cache |
| MP3 encode fails | lamejs not loaded | Confirm `assets/vendor/lame.min.js` exists |

## Optional enhancements

- Add a service worker to pre-cache all assets for true offline use.
- Host only the models you need to reduce storage.
- Use a reverse proxy to rewrite any residual absolute URLs if the library hard-codes them.
- For multi-speaker models, the page already exposes speaker IDs 0–119; extend the dropdown if required.

## Version notes

- Page written against `@realtimex/piper-tts-web@1.1.1` and `lamejs@1.2.1`.
- Model files from the rhasspy/piper-voices catalog (MIT license).
- All inference and encoding remain client-side; no server-side TTS is required.

Once the assets are in place, the page is fully intranet-ready.
