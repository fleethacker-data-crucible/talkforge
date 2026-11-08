# TalkForge speech-to-text (Listen) - v1

TalkForge was text-to-speech only. This adds speech-to-text, in the same repo,
on the same stack, with no new native code.

## What v1 is

- `TalkForge-stt.html` - Listen page, served by the same `Start-TalkForge.ps1`
  server on the same 25000-25009 block. Open it from the TalkForge folder.
- Hold to talk, or toggle recording. Microphone is closed at all other times.
- Transcript in the page: edit, copy, download as `.txt`.
- Whisper `whisper-tiny.en`, English only, `q8`, WASM, in a Web Worker.
  Audio is downsampled to 16 kHz in an AudioWorklet, then transcribed in the
  page. Nothing is uploaded. The browser's own SpeechRecognition is never used,
  because it streams audio to the browser vendor's servers.
- Disabled, with a named missing-file list, until the STT assets are installed.
  Exactly like the TTS page: missing files are an error, never a download.

## What v1 is not

- Not a Handy clone. No native app, no global shortcut, no paste into other
  apps, no system tray, no SQLite history, no LLM post-processing, no GPU
  backend, no installer, no auto-updater. Those need Rust/Tauri, a compiled
  binary and system permissions, and do not fit the fleet stack.
- No always-listening hail mode. PacketRat has an opt-in hail; TalkForge v1
  deliberately does not. Mic open only while you hold or toggle.
- No Silero VAD. Handy uses Silero (neural) VAD. V1 uses the PacketRat energy
  VAD in `assets/vendor/stt-utils.js` - no extra model file, weaker in noise.
  Silero is a v2 candidate if a small ONNX Silero model can be vendored and
  hash-checked.
- No headless `transcribe` command yet. `tools/stt-status.mjs` is the preflight
  (`node tools/stt-status.mjs`, exit 0 ready / 2 not ready / 64 bad usage,
  `--json`, `--no-hash`). A headless transcribe that runs the same Whisper
  model under Node is v2, not v1.
- No TTS round-trip yet. The STT page links to the TTS page; it does not push
  transcript into the TTS text box. That is a v2 page integration, not a
  silent change to `TalkForge-tts.html` (which v1 leaves untouched).

## Files

| File | What |
| --- | --- |
| `TalkForge-stt.html` | Listen page, module script, UI kit, missing-asset check |
| `assets/vendor/stt-utils.js` | Pure helpers: downsample, energy VAD, required paths, missing message. Node-tested. |
| `assets/stt/stt-worker.js` | Module worker: transformers.js, local models only, remote models off |
| `assets/stt/stt-worklet.js` | AudioWorklet, 4096-frame batches, processor `talkforge-capture` |
| `tests/stt-utils.test.mjs` | `node tests/stt-utils.test.mjs` - no browser, no model |
| `tools/stt-status.mjs` | Asset preflight against `assets-manifest.json` |
| `assets-manifest-stt.json` (in this PR bundle) | STT entries to merge into `assets-manifest.json` |

The worker reuses the TTS ONNX Runtime WASM in `assets/vendor/onnx/` - it is
not duplicated. The STT model files themselves are release assets, not git.

## Assets and releases

STT entries go into `assets-manifest.json` with the SHA-256 values copied from
PacketRat `Config/voice-assets.json` (verified 2026-11-02). Those hashes are
the check, not a claim that the files are already in TalkForge. Only the 9
Whisper model files go in v1.

- `populate-assets` already iterates the manifest, so once the entries are in
  and the files are on a `.0` release, it fetches them the same way it fetches
  TTS models. No populate code change is needed in v1. Note: populate skips
  a manifest entry with no `url`, so every entry in v1 carries a Hugging
  Face `resolve/main` URL, fallback-only, `preferRelease` true - the same
  pattern the existing TTS manifest already uses. Pinning those URLs to an
  exact Xenova revision is a follow-up, not a reason to ship a guessed URL.
- `release.yml` must upload, on `.0` tags only:
  `assets/stt/models/whisper-tiny.en/*.json` and
  `assets/stt/models/whisper-tiny.en/onnx/*.onnx`.
- `transformers.min.js` is pinned to transformers.js 3.8.1 (`@huggingface/transformers@3.8.1/dist/transformers.min.js`
  on jsDelivr, Apache-2.0). Its SHA-256 `aa5002b7…65fa` matches the hash PacketRat already lists, and jsDelivr's
  package metadata confirms it. Its bundled ONNX Runtime Web is a 1.22.0 build, the same line as the shared
  `vendor/onnx/` WASM. Uploading it on the next `.0` release is still to do; until then populate fetches it
  from the pinned jsDelivr URL.
- If a hash mismatches at populate time, populate fails that file and keeps
  nothing. That is the correct outcome, not a reason to relax the check.

## How to test v1 (WIN11, no assets needed for the pure tests)

1. `node tests/stt-utils.test.mjs` - must pass, no browser, no model.
2. `node tools/stt-status.mjs` on a clone without STT assets - must exit 2
   and list every STT file as MISSING, not crash.
3. Start TalkForge, open `TalkForge-stt.html` without STT assets - page must
   show the missing list, disable Load/Hold/Toggle, and make no request
   outside the local server.
4. With STT assets installed (from a `.0` release, hash-verified): Load model,
   hold to talk, release, transcript appears, copy and download work.
   Step 4 cannot be done in this PR's WIN11 job, because the model files are
   not in the repo and are not uploaded yet - it is the first test after the
   next `.0` release, and the PR body says so plainly.

## 508 / accessibility

Buttons are text buttons, not icon-only. Status is `aria-live="polite"`.
Transcript is a labelled, editable textarea. Focus styling comes from the
fleet UI kit, as on the TTS page.

## Handy comparison (summary)

Full comparison is in `docs/HANDY-COMPARISON.md` in this bundle. In short:
borrow Handy's UX (hold/toggle, local-only, VAD, model choice, transcript
history in the app) and its privacy stance; do not borrow its stack
(Rust/Tauri/React/Vulkan, installers, global shortcut, system paste) or its
larger/GPU models. The fleet already had the right STT pattern in PacketRat -
Whisper in the page, hash-checked local files, no cloud fallback - and v1 is
that pattern, moved into TalkForge, not a Handy port.
