# Local Asset Manifest for TalkForge-tts Intranet Build

This directory holds all vendor libraries, WASM binaries, and voice models required for fully offline / intranet-only operation.

## Directory layout

```
assets/
├── vendor/
│   ├── piper-tts-web.js          # ESM build of @realtimex/piper-tts-web (or equivalent)
│   ├── lame.min.js               # lamejs MP3 encoder
│   └── onnxruntime-web/          # Optional: full onnxruntime-web package if not bundled
│       ├── ort.min.js
│       ├── ort-wasm.wasm
│       └── ...
├── wasm/
│   ├── onnx/                     # ONNX Runtime WebAssembly files
│   │   ├── ort-wasm.wasm
│   │   ├── ort-wasm-simd.wasm
│   │   └── ...
│   ├── piper_phonemize.wasm
│   └── piper_phonemize.data
└── models/
    ├── en_US-libritts_r-medium.onnx
    ├── en_US-libritts_r-medium.onnx.json
    ├── en_US-libritts-high.onnx          # optional
    ├── en_US-libritts-high.onnx.json     # optional
    ├── en_US-lessac-medium.onnx          # optional
    └── en_US-lessac-medium.onnx.json     # optional
```

## Required files (minimum viable)

| File | Approx. size | Source |
|------|--------------|--------|
| piper-tts-web.js | ~25 KB | npm pack `@realtimex/piper-tts-web` or build from source |
| lame.min.js | ~100 KB | npm `lamejs` or jsDelivr |
| piper_phonemize.wasm | ~1–2 MB | `@diffusionstudio/piper-wasm` or library dist |
| piper_phonemize.data | ~5–10 MB | same |
| ONNX Runtime WASM | ~5–15 MB | `onnxruntime-web` package |
| en_US-libritts_r-medium.onnx | ~75 MB | huggingface.co/rhasspy/piper-voices |
| en_US-libritts_r-medium.onnx.json | ~20 KB | same |

## Optional models

- `en_US-libritts-high` (~137 MB) – higher quality, 904 speakers
- `en_US-lessac-medium` / `en_US-lessac-high` – single-speaker alternatives

## Notes

- All paths in the revised `TalkForge-tts.html` are relative and point into this `assets/` tree.
- Place the files exactly as listed; the page will fail gracefully with a clear status message if a required asset is missing.
- After the first successful load, models are also cached in the browser’s Origin Private File System by the library.
- For production intranet, serve the entire `artifacts/` folder (or just the HTML + assets) from any static file server.
