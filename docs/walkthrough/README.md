# TalkForge walkthrough

Turn text into natural speech entirely in the browser, offline, and download it as MP3 or WAV.

> **Status: skeleton.** The screenshots below are placeholders. Zombie Admin captures them with demo data, and the Chief of Staff scans them for sensitive content before they are added (team directive 10). Until then the image links do not resolve.

## Before you start

- Windows PowerShell 5.1 (part of Windows). No administrator rights and no installer.
- Microsoft Edge or Google Chrome.
- Launch: Run `populate-assets.bat` once for the voice models, then `serve.bat` (opens `http://127.0.0.1:25000` or the next free port).

## Steps

### 1. First launch

TalkForge opens with the text box, model and voice pickers and playback controls.

![TalkForge page on first launch, with the text box, model and voice pickers and the playback controls.](../assets/walkthrough/01-first-launch.png)

### 2. Add text and pick a voice

Paste or drop text, then choose a model, voice and speed.

![TalkForge with the demo paragraph pasted, the en_US-lessac-medium model and speed 1.0 selected.](../assets/walkthrough/02-text-and-voice.png)

### 3. Listen

Select **Play**. Use **Pause**, **Stop**, **Prev** and **Next** to move through the text.

![TalkForge reading the demo paragraph aloud, with the Pause, Stop, Prev and Next controls active.](../assets/walkthrough/03-playing.png)

### 4. Choose a speaker

Multi-speaker models have a searchable speaker list. Mark the ones you like as favourites.

![TalkForge Voice and Speaker list for a multi-speaker model, filtered by a search, with one speaker marked as a favourite.](../assets/walkthrough/04-multi-speaker.png)

### 5. Fix a pronunciation

Add `word=say` lines under **Pronunciation overrides**.

![TalkForge Pronunciation overrides box with one demo override in the word=say form.](../assets/walkthrough/05-pronunciation.png)

### 6. Download

Select **Download MP3** or **Download WAV** to save the audio.

![TalkForge after synthesis, with the Download MP3 and Download WAV buttons available.](../assets/walkthrough/06-download.png)

## About these images

Images live in [`docs/assets/walkthrough/`](../assets/walkthrough/), named `NN-<screen>.png` after the step they belong to. They are 1440x900 at 100% scale in the Dark theme, and show demo data only.
