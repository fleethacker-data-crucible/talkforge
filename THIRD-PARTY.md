# Third-party notices

TalkForge is client-side neural text-to-speech in the browser, Piper
voice models plus ONNX Runtime Web, local assets only, no CDN at run
time. The components below are vendored under assets/vendor or loaded
from local assets. TalkForge itself is MIT licensed, see LICENSE.
This file does not change that license.

## ONNX Runtime Web

- Project: ONNX Runtime Web
- Source: https://github.com/microsoft/onnxruntime
- Vendored under: assets/vendor/onnx
- License: MIT License
- Copyright: Copyright (c) Microsoft Corporation

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Piper TTS, approach and models

- Project: Piper TTS, voice models and phonemization
- Approach: assets/vendor/piper-engine.js is based on the approach
  from clowerweb/piper-tts-web-demo, source
  https://github.com/clowerweb/piper-tts-web-demo
- Original engine: https://github.com/rhasspy/piper, archived Oct 2025
- Active engine: https://github.com/OHF-Voice/piper1-gpl

License flag, read before public distribution: do NOT treat Piper as
MIT on the strength of the old repo. The original rhasspy/piper repo
was MIT and is archived. The actively maintained repo,
OHF-Voice/piper1-gpl, is GPL-3.0-or-later, and the espeak-ng
phonemization it embeds is GPL. Voice model licenses vary per voice;
each voice MODEL_CARD is authoritative for that voice, and some voices
are non-commercial. TalkForge vendors Piper voice models and the
piper_phonemize WASM, not a Piper engine binary, and this notice does
not resolve the GPL question. A human license check is required before
public distribution of a TalkForge build that ships those assets.

## lamejs, if vendored

- File: assets/vendor/lame.min.js, when present in the build
- Project: lamejs, MP3 encoding in the browser
- License: as stated in the header of lame.min.js in this repo at the
  time of the build, check that header before distribution, it is not
  restated here because the vendored file is the authority.

## UI kit, internal only

- assets/vendor/ui-kit is derived from data-noodler and phoenix-lai,
  both fleethacker-data-crucible repos, both MIT. No external
  attribution is needed for that part.