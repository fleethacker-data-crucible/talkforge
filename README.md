# TalkForge

Client-side neural text-to-speech in the browser. Runs Piper TTS models entirely in-browser (ONNX Runtime Web + WASM) with multi-speaker support, local-asset offline mode, and simple static servers for Linux and constrained Windows environments.

## Quick start

### Linux / macOS
```bash
git clone https://github.com/seakintruth/talkforge.git
cd talkforge
./populate-assets.sh          # optional: downloads large models if not using a Release
./serve.sh                    # starts on http://127.0.0.1:25000 (or next free port)
```

### Windows (PowerShell 5.1, no admin)
```bat
git clone https://github.com/seakintruth/talkforge.git
cd talkforge
populate-assets.bat           # optional: downloads large models
serve.bat                     # starts the local server and opens the page
```

Open `piper-tts.html` in a browser. The page prefers local assets and falls back to CDN for development.

## What’s in the repo vs. a Release

| In the repo (cloned) | In a GitHub Release (tagged `v*`) |
|----------------------|-----------------------------------|
| Source, scripts, CI, docs | All `.onnx` model files |
| Small JS (piper-tts-web, lamejs, engine) | `piper_phonemize.data` (~17 MB) |
| Small WASM (`piper_phonemize.wasm`) | ONNX Runtime WASM binaries |
| `.onnx.json` configs | |

A Release is created automatically when you push a tag matching `v*`:
```bash
git tag v0.1.0
git push origin v0.1.0
```

After the workflow finishes, download the large files from the Release page (or point `populate-assets` at the Release URLs).

## Features

- Multi-speaker models (LibriTTS-R, VCTK) with searchable speaker list
- Background first-sentence synthesis for faster start
- Read-all / selection / click-to-read modes
- MP3 download of generated audio
- Speed control
- Debug panel with copy-to-clipboard
- Pure-function test suite (`node tests/tts-utils.test.mjs`)
- Optional GitHub Actions tests (non-blocking)

## Layout

```
piper-tts.html
assets/
  vendor/          # JS libraries and engine
  wasm/            # phonemizer WASM (data + onnx/ come from Release)
  models/          # .onnx.json configs (models come from Release)
populate-assets.sh / .ps1 / .bat
serve.sh / serve-windows.ps1 / serve.bat
tests/
.github/workflows/
```

## License

MIT for the page and scripts. Model files follow the licenses of the upstream Piper voices (see each model’s MODEL_CARD on Hugging Face).
