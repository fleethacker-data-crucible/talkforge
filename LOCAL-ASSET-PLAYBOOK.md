# TalkForge-tts local-asset playbook

How to get TalkForge-tts running on an intranet or an offline machine, with no CDN or Hugging Face calls at run time.

## What runs where

The page (`TalkForge-tts.html`) and the Node tools (`tools/talkforge.mjs`, `tools/synth-cli.mjs`) load everything from `assets/`. The layout and the files each voice needs are in [assets/MANIFEST.md](assets/MANIFEST.md).

## Step 1 - Get the files (on a machine with access)

```bash
git clone https://github.com/fleethacker-data-crucible/talkforge.git
cd talkforge
./populate-assets.sh          # or populate-assets.bat on Windows
```

`populate-assets` downloads the models, `piper_phonemize.data` and the ONNX Runtime WASM from the GitHub Release in `assets/release-base.txt`, and checks each against the SHA-256 in `assets-manifest.json`. It uses `gh release download` when the GitHub CLI is signed in (the repo is private); otherwise the anonymous release URL. Upstream CDN / Hugging Face is used only if you opt in (`-AllowUpstream` / `TALKFORGE_ALLOW_UPSTREAM=1`).

To carry only some voices, limit the run: `TALKFORGE_ONLY="models/en_US-lessac-high*,wasm/*,vendor/onnx/*.jsep.wasm" ./populate-assets.sh` (PowerShell: `-Only`).

## Step 2 - Move the folder to the offline machine

Copy the whole repo folder (it now contains the large files). Nothing else is needed at run time except a browser, and PowerShell 5.1 (Windows) or Python 3 (Linux) for the local server; Node 18+ if you use the command-line tools.

## Step 3 - Serve and open

- Windows: `TalkForge.bat` (starts `Start-TalkForge.ps1` on a free port in 25000-25009 and opens the page).
- Linux: `./serve.sh` (a dev convenience built on Python's `http.server`, bound to 127.0.0.1).

Any other static file server also works if it serves the repo folder and sends `.wasm` as `application/wasm`.

## Verification checklist

- [ ] The page loads with no 404s in the browser console.
- [ ] Pressing Play shows the model loading, then speech. If a file is missing, the status line names each missing `assets/...` file.
- [ ] Download WAV and Download MP3 each give one playable file.
- [ ] The Network tab shows requests to the local server only.
- [ ] `node tests/smoke-synth.test.mjs` synthesizes a short text (needs the assets).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "Offline assets missing" in the status line | A model or WASM file was not downloaded | Run `populate-assets` again |
| `populate-assets` reports a SHA-256 mismatch | Truncated or tampered download | Delete the named file and re-run |
| `populate-assets` gets 404 from the release | Private repo and no sign-in | `gh auth login`, then re-run |
| WASM load error in the page | Server sends the wrong MIME type | Use `TalkForge.bat` / `serve.sh`, or send `application/wasm` |
| No sound | Browser autoplay policy | Start playback from a click |
| MP3 fails | `assets/vendor/lame.min.js` missing | Restore it from git |

## Notes

- Voices come from the rhasspy/piper-voices catalogue (MIT licence); see each model card for details.
- All inference and encoding run locally; no server-side TTS is involved.
