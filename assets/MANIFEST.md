# Local assets for TalkForge-tts

Everything the page needs for offline use lives under this folder. `assets-manifest.json` (repo root) is the source of truth: every file in it has a `sha256`, and `populate-assets` downloads and verifies the large ones. Small files are committed.

## Layout

```
assets/
├── models.json                       # voice catalogue shown in the page (committed)
├── release-base.txt                  # release the large files come from (committed)
├── models/
│   ├── <voice>.onnx.json             # voice config (committed)
│   └── <voice>.onnx                  # model, 75-140 MB (populate-assets)
├── wasm/
│   ├── piper_phonemize.wasm          # phonemizer (committed)
│   └── piper_phonemize.data          # ~18 MB (populate-assets)
└── vendor/
    ├── piper-engine.js, tts-utils.js # engine and pure helpers (committed)
    ├── lame.min.js                   # MP3 encoder (committed)
    ├── dist/piper-o91UDS6e.js        # phonemizer loader (committed)
    ├── onnx/
    │   ├── ort.min.mjs, ort-wasm-simd-threaded.jsep.mjs   # ONNX Runtime Web (committed)
    │   └── ort-wasm-simd-threaded.jsep.wasm               # ~22 MB (populate-assets)
    └── ui-kit/                       # fonts and styles (committed)
```

## What a voice needs

For voice `<id>`: `models/<id>.onnx`, `models/<id>.onnx.json`, `vendor/onnx/ort-wasm-simd-threaded.jsep.wasm`, `wasm/piper_phonemize.wasm` and `wasm/piper_phonemize.data`. The page checks these five before loading and lists any that are missing; `node tools/talkforge.mjs voices list` shows which voices are installed.

## Getting the large files

Run `populate-assets.bat` (Windows) or `./populate-assets.sh`. They download from the GitHub Release named in `release-base.txt`, using the GitHub CLI when it is signed in, and verify every file against `assets-manifest.json`. See the README ("Integrity checks", "No CDN fallback").

## Notes

- All paths in `TalkForge-tts.html` are relative to this folder.
- The page and the Node tools make no network requests.
- Models are cached by the browser after the first load.
