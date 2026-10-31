# TalkForge walkthrough

Turn text into natural speech entirely in the browser, offline, and download it as MP3 or WAV.

> **Screenshots:** captured with demo data and scanned by the Chief of Staff (team directive 10).

## Before you start

- Windows PowerShell 5.1 (part of Windows). No administrator rights and no installer.
- Microsoft Edge or Google Chrome.
- Launch: Run `populate-assets.bat` once for the voice models, then `TalkForge.bat` (`serve.bat` still works) (opens `http://127.0.0.1:25000` or the next free port).

## Steps

### 1. First launch

TalkForge opens with the text box, the model and voice pickers and the playback controls. The page header reads *TalkForge-tts* and the page version (v2.2.3 at the time of writing). The speech engine underneath is Piper TTS, credited in the page footer.

![TalkForge on first launch, headed with the page name and version, with the default sample text, the LibriTTS-R Medium model and its speaker list.](../assets/walkthrough/01-first-launch.png)

### 2. Add text and pick a voice

Paste or drop text, then choose a model, voice and speed.

![TalkForge with a short demo sentence pasted, the Lessac Medium single-speaker model selected and speed 1.0.](../assets/walkthrough/02-text-and-voice.png)

### 3. Listen

Select **Play**. Use **Pause**, **Stop**, **Prev** and **Next** to move through the text. **Reading mode** chooses whether to read everything, the selection, or from where you click.

![TalkForge playback controls while reading, with Read all selected and the Pause, Stop, Prev and Next buttons available.](../assets/walkthrough/03-playing.png)

### 4. Choose a speaker

Multi-speaker models have a searchable speaker list. Speakers are named *Speaker N*, so search by number. Select **Favorite** to mark the ones you like.

![TalkForge speaker list for the LibriTTS-R Medium model filtered by the search 2, with Speaker 2 selected and marked Favorited.](../assets/walkthrough/04-multi-speaker.png)

### 5. Fix a pronunciation

Add `word=say` lines under **Pronunciation overrides**.

![TalkForge Pronunciation overrides box with the demo override TalkForge=talk forge, below the playback and download buttons.](../assets/walkthrough/05-pronunciation.png)

### 6. Download

Select **Download MP3** or **Download WAV** to save the audio of your text.

![TalkForge controls with the Download MP3 and Download WAV buttons and an empty Pronunciation overrides box showing its example text.](../assets/walkthrough/06-download.png)

## About these images

Images live in [`docs/assets/walkthrough/`](../assets/walkthrough/), named `NN-<screen>.png` after the step they belong to. They are 1440x900 at 100% scale in the Dark theme, and show demo data only.
