# node-osu

A browser-based **osu!-inspired rhythm game** built with **Node.js + Express + HTML5 Canvas**.

It supports:

- **Standard mode** (click/tap circles and sliders)
- **osu!mania 4K mode** (keyboard lanes)
- **Spectrogram mode** (30-second audio visualization)
- **.osu beatmap import** (osu!standard and osu!mania, including standard -> mania conversion)

## Features

- Download and process songs from YouTube
- Audio analysis pipeline using:
  - `yt-dlp` (download/extract audio)
  - `ffmpeg` (conversion + spectrogram image generation)
  - `wav_to_beats` (C++/aubio note detection)
- Playable beatmap generation for Standard and Mania
- Local SQLite storage for:
  - Cached song metadata/beatmaps
  - Leaderboard scores
- Native mania map library support via bundled `.osu` files in `data/native_mania_maps`

## Tech Stack

- **Backend:** Node.js, Express, SQLite, Axios
- **Frontend:** Vanilla JavaScript, HTML5 Canvas, CSS
- **Native tool:** C++ (`wav_to_beats`) using aubio

## Requirements

1. **Node.js** 18+ recommended
2. **ffmpeg** available on your system `PATH`
3. **yt-dlp** available either:
   - on your `PATH`, or
   - as `yt-dlp.exe` in the repository root (Windows)
4. **wav_to_beats** available either:
   - on your `PATH`, or
   - as `wav_to_beats.exe` in the repository root (Windows)

## Installation

```bash
npm install
```

## Run

```bash
node server.js
```

Then open:

```text
http://localhost:3000
```

## Gameplay Controls

### Standard mode

- **Mouse:** Click circles/sliders
- **Keyboard:** `Z`, `X`, or `Space` to trigger hits

### Mania mode (4K)

- `D`, `F`, `J`, `K` for lanes 1-4

## How to Use

1. Enter a username.
2. Choose a mode:
   - Standard
   - Mania (4K)
   - Spectrogram
   - Import Existing `.osu`
3. Load content by:
   - pasting a YouTube URL, or
   - selecting a previously downloaded local song, or
   - importing a `.osu` file + matching audio file
4. Play and submit score to local leaderboard.

## API Endpoints

- `GET /api/osu/native-mania` List bundled native mania `.osu` maps.

- `POST /api/songs/download` Download/process song and return audio URL + generated beat events. Body:

  ```json
  { "url": "...", "videoId": "...", "mode": "standard|mania|spectrogram" }
  ```

- `GET /api/songs/local` List downloaded local songs from `public/assets/songs`.

- `GET /api/scores` Get top leaderboard scores.

- `POST /api/scores` Save score. Body:
  ```json
  { "username": "Guest", "score": 12345, "song": "Song Name", "mode": "mania" }
  ```

## Data and Files

- `public/` - frontend app
  - `index.html` - screens/UI
  - `ui.js` - flow, imports, setup/leaderboard
  - `game.js` - gameplay engine
- `server.js` - backend routes + processing pipeline
- `data/osu.db` - SQLite database
- `data/native_mania_maps/` - bundled native mania maps
- `public/assets/songs/` - downloaded/generated audio assets

## Building `wav_to_beats` (Optional)

If `wav_to_beats(.exe)` is missing, build from source using CMake:

```bash
cmake -S . -B build
cmake --build build --config Release
```

The executable should be named `wav_to_beats` (or `wav_to_beats.exe` on Windows).

## Notes

- The server creates required directories automatically on startup.
- Scores are stored locally in SQLite and also attempted to be forwarded to an external score endpoint.
- `npm test` is currently a placeholder script.
