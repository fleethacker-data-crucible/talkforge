# TalkForge vs Handy - comparison, and what to rebuild

Handy: cjpais/Handy, v0.10.0, MIT. TalkForge: fleethacker-data-crucible/talkforge,
main f658bdf, v2.2.3, MIT. Fleet stack: comms STANDARDS.md + docs/TECH-STACK-BASELINE.md,
edge-ops CONVENTIONS.md. Read 2026-11-02.

## What each does today

| | TalkForge (before this change) | Handy |
| --- | --- | --- |
| Direction | Text to speech only: Piper ONNX in browser, multi-speaker, MP3/WAV download, voiceover CLI, headless `speak`/`serve` loopback endpoint | Speech to text only: press shortcut, speak, paste into any app |
| Engine | Piper ONNX Runtime Web + WASM, local assets | Whisper (Small/Medium/Turbo/Large) + Parakeet V3, via transcribe-cpp (GGUF/ggml, native backends) |
| VAD | None (TTS) | Silero VAD |
| Where it runs | Browser page, PS 5.1 static server, loopback 25000-25009, no admin | Native desktop app, Windows/macOS/Linux, tray, global shortcut, clipboard paste |
| Models at run time | Release assets only on `.0` tags, SHA-256 verified, no CDN fallback | Downloaded from Hugging Face at run time (hf-hub), GPU when available |
| Stack | PS 5.1, vanilla JS, ONNX Runtime Web 1.22, no build step, no .exe/.dll in git | Tauri 2 + React 18 + TypeScript + Vite + Rust, Bun, Vulkan SDK, C++ build tools, .msi/.deb installers |
| Licence | MIT | MIT - licence is compatible, stack is not |

## What Handy gets right (borrow the idea, not the code)

- One job, one shortcut: hold to record / toggle, release to transcribe.
- Local-only privacy: voice stays on the machine, no cloud call.
- Silence filtering before transcription (Silero VAD).
- Model choice, with a small model as the constrained default.
- Transcript history in the app, copy/paste out, CLI flags to control a
  running instance, a transcription hook for post-processing.

## What does not fit the fleet, and is not rebuilt

- Rust/Tauri/React/Vite/Bun/Vulkan/C++ toolchain. Fleet Windows tools are
  PS 5.1 + .NET Framework 4.x + C# 5 via Add-Type (framework assemblies only)
  + vanilla JS in the browser, no build step, no .csproj, no installer.
- A compiled .exe/.dll, an .msi, admin or accessibility permissions.
  Fleet tools run without admin, unpack into the user profile, and end users
  on app-whitelisted Windows cannot run non-whitelisted .exe files.
- Global shortcut + paste into any other app. That needs a native global
  hook, clipboard injection and accessibility permissions - exactly the
  native layer the fleet stack avoids.
- GPU backends (Vulkan), Large/Medium Whisper, Parakeet V3. Constrained
  devices, CPU WASM, tiny model first.
- Runtime model download from Hugging Face. Fleet rule: large assets are
  release assets on `.0` tags only, SHA-256 verified, never in git, never
  fetched at run time.
- Cloud speech recognition, LLM post-processing by default. PacketRat and
  TalkForge both forbid the browser's cloud SpeechRecognition; any LLM
  post-processing would go to local phoenix-lai on loopback, opt-in, and is
  not in v1.

## What the fleet already had (the real precedent)

PacketRat `Web/voice-input.js`, `Web/voice-worker.js`, `Web/voice-worklet.js`,
`Config/voice-assets.json`, read 2026-11-02:

- Whisper in the page from hash-checked local files, transformers.js,
  `allowRemoteModels = false`, `whisper-tiny.en`, `q8`, WASM, 1 thread.
- AudioWorklet capture, downsample to 16 kHz, energy VAD, hold-to-talk and
  an opt-in hail (TalkForge v1 takes hold/toggle only, no hail).
- Server serves only listed files whose SHA-256 still matches.
- The model path "has not been run" in PacketRat's own README - so TalkForge
  v1 must not claim a working model test until assets are on a `.0` release
  and the page is run with them.

TalkForge v1 is therefore a PacketRat-pattern port into TalkForge, with
Handy's UX as the design reference, not a Handy code port. No Handy source,
no Rust, no Tauri, no Vulkan, no installer enters TalkForge.

## Rebuild list (v1, this bundle)

1. Listen page + worker + worklet + pure utils + node tests (done, local).
2. Manifest STT entries (SHA-256 from PacketRat, release source only).
3. Release workflow upload for STT assets on `.0` tags.
4. `stt-status` preflight tool.
5. Docs: STT.md + this comparison.

## Deferred (not in v1, say so in the PR)

- Silero VAD, larger Whisper models, hail/wake mode, global shortcut/paste,
  headless `transcribe` under Node, TTS text-box round-trip, LLM
  post-processing via local phoenix-lai. Each needs its own check against
  the stack and its own asset hashes - none is smuggled into v1.
