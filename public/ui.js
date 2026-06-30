// Navigation and Screen management
const screens = {
  login: document.getElementById("screen-login"),
  setup: document.getElementById("screen-setup"),
  loader: document.getElementById("screen-loader"),
  game: document.getElementById("screen-game"),
  leaderboard: document.getElementById("screen-leaderboard"),
  results: document.getElementById("screen-results"),
};

// Global State
const session = {
  username: "Guest",
  mode: "standard", // 'standard', 'mania', 'spectrogram', or 'osu-file'
  importedMode: null,
  songTitle: "",
  audioUrl: "",
  beats: [],
  spectrogramUrl: null,
  importedAudioObjectUrl: null,
};

let selectedLocalSong = null;
let localSongs = [];
let nativeManiaMaps = [];
let selectedNativeManiaMap = null;
let nativeManiaSearchQuery = "";
const osuImportPanel = document.getElementById("osu-import-panel");
const osuImportStatus = document.getElementById("osu-import-status");
const nativeManiaList = document.getElementById("native-mania-list");
const nativeManiaSearchInput = document.getElementById("native-mania-search");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function revokeImportedAudioUrl() {
  if (session.importedAudioObjectUrl) {
    URL.revokeObjectURL(session.importedAudioObjectUrl);
    session.importedAudioObjectUrl = null;
  }
}

function playParsedOsuData(parsed, audioFile) {
  if (!parsed.beats || parsed.beats.length === 0) {
    throw new Error("No playable hit objects were found in this map.");
  }
  if (!audioFile) {
    throw new Error("Please select the matching audio file before playing this map.");
  }

  revokeImportedAudioUrl();
  const audioUrl = URL.createObjectURL(audioFile);
  session.importedAudioObjectUrl = audioUrl;

  session.importedMode = parsed.mode;
  session.songTitle = parsed.title;
  session.audioUrl = audioUrl;
  session.beats = parsed.beats;
  session.spectrogramUrl = null;

  if (osuImportStatus) {
    const conversionLabel = parsed.convertedFromStandard ? ", converted: standard->mania" : "";
    osuImportStatus.textContent = `Loaded ${parsed.beats.length} objects (map: ${parsed.mapMode}, playing: ${parsed.mode}${conversionLabel}, holds: ${parsed.holdCount}, taps: ${parsed.tapCount}).`;
  }
  launchGame();
}

function parseSectionLine(line) {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  return key ? { key, value } : null;
}

function parseOsuBeatmap(osuContent, fallbackName, forcedMode = "standard") {
  const lines = osuContent.replace(/\r/g, "").split("\n");
  let section = "";
  const general = {};
  const metadata = {};
  const difficulty = {};
  const timingPoints = [];
  const hitObjects = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line;
      continue;
    }

    if (section === "[General]" || section === "[Metadata]" || section === "[Difficulty]") {
      const parsed = parseSectionLine(line);
      if (!parsed) continue;
      if (section === "[General]") general[parsed.key] = parsed.value;
      if (section === "[Metadata]") metadata[parsed.key] = parsed.value;
      if (section === "[Difficulty]") difficulty[parsed.key] = parsed.value;
      continue;
    }

    if (section === "[TimingPoints]") {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 2) {
        const time = Number(parts[0]);
        const beatLength = Number(parts[1]);
        const uninherited = Number(parts[6] ?? "1");
        if (Number.isFinite(time) && Number.isFinite(beatLength)) {
          timingPoints.push({ time, beatLength, uninherited });
        }
      }
      continue;
    }

    if (section === "[HitObjects]") {
      hitObjects.push(line);
    }
  }

  timingPoints.sort((a, b) => a.time - b.time);

  if (forcedMode !== "standard" && forcedMode !== "mania" && forcedMode !== "standard-to-mania") {
    throw new Error("Please choose Standard, Mania, or Standard converted to Mania before importing.");
  }

  const sliderMultiplier = Number.isFinite(Number(difficulty.SliderMultiplier)) ? Number(difficulty.SliderMultiplier) : 1.4;
  const rawMode = Number(general.Mode ?? "0");
  const mapMode = rawMode === 0 ? "standard" : rawMode === 3 ? "mania" : null;
  if (!mapMode) {
    throw new Error(`This beatmap mode (Mode: ${general.Mode ?? "unknown"}) is not supported. Only osu!standard and osu!mania maps are supported.`);
  }

  const convertingStandardToMania = forcedMode === "standard-to-mania";
  const playMode = convertingStandardToMania ? "mania" : forcedMode;

  if (convertingStandardToMania && mapMode !== "standard") {
    throw new Error("Standard converted to Mania can only be used for osu!standard maps (Mode: 0).");
  }

  if (!convertingStandardToMania && mapMode !== playMode) {
    throw new Error(`Selected mode "${playMode}" does not match this map's mode "${mapMode}". Please choose ${mapMode}.`);
  }
  const title = metadata.TitleUnicode || metadata.Title || fallbackName || "Imported osu! Beatmap";

  const getTimingState = (timeMs) => {
    let beatLength = 500;
    let svMultiplier = 1;
    for (let i = 0; i < timingPoints.length; i++) {
      const tp = timingPoints[i];
      if (tp.time > timeMs) break;
      if (tp.uninherited === 1 && tp.beatLength > 0) {
        beatLength = tp.beatLength;
      } else if (tp.uninherited === 0 && tp.beatLength < 0) {
        svMultiplier = clamp(-100 / tp.beatLength, 0.1, 10);
      }
    }
    return { beatLength, svMultiplier };
  };

  const beats = [];
  let holdCount = 0;
  let tapCount = 0;

  for (const line of hitObjects) {
    const parts = line.split(",");
    if (parts.length < 5) continue;

    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const timeMs = Number(parts[2]);
    const type = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(timeMs) || !Number.isFinite(type)) continue;
    const isSlider = (type & 2) > 0;
    const isSpinner = (type & 8) > 0;

    if (playMode === "mania") {
      const lane = clamp(Math.floor((clamp(x, 0, 511.999) / 512) * 4), 0, 3);
      if (mapMode === "mania") {
        const isHold = (type & 128) > 0;
        let durationSec = 0.1;

        if (isHold && parts[5]) {
          const endTime = Number(parts[5].split(":")[0]);
          if (Number.isFinite(endTime) && endTime > timeMs) {
            durationSec = (endTime - timeMs) / 1000;
          }
        }
        beats.push({
          time: Number((timeMs / 1000).toFixed(3)),
          duration: Number(clamp(durationSec, 0.1, 6).toFixed(3)),
          pitch: 48 + lane * 8,
          lane,
          strength: 1,
          type: isHold ? "hold" : "tap",
        });
        if (isHold) holdCount++;
        else tapCount++;
      } else {
        // Explicit osu!standard -> mania conversion mode.
        let durationSec = 0.1;
        let noteType = "tap";
        let strength = 1;

        if (isSlider) {
          const repeats = Number(parts[6]) || 1;
          const pixelLength = Number(parts[7]) || 0;
          const { beatLength, svMultiplier } = getTimingState(timeMs);
          const sliderSpeed = (100 * sliderMultiplier * svMultiplier) / Math.max(1, beatLength);
          const durationMs = sliderSpeed > 0 ? (pixelLength * repeats) / sliderSpeed : 380;
          durationSec = clamp(durationMs / 1000, 0.22, 8);
          noteType = "hold";
          strength = 1.08;
        } else if (isSpinner) {
          const endMs = Number(parts[5]);
          durationSec = Number.isFinite(endMs) && endMs > timeMs ? (endMs - timeMs) / 1000 : 0.9;
          durationSec = clamp(durationSec, 0.5, 8);
          noteType = "hold";
          strength = 1.2;
        }

        beats.push({
          time: Number((timeMs / 1000).toFixed(3)),
          duration: Number(clamp(durationSec, 0.1, 8).toFixed(3)),
          pitch: 48 + lane * 8,
          lane,
          strength,
          type: noteType,
        });
        if (noteType === "hold") holdCount++;
        else tapCount++;
      }
      continue;
    }

    const normalizedX = clamp(x / 512, 0, 1);
    const normalizedY = clamp(y / 384, 0, 1);

    if (isSpinner) {
      const endMs = Number(parts[5]);
      const durationSec = Number.isFinite(endMs) && endMs > timeMs ? (endMs - timeMs) / 1000 : 0.8;
      beats.push({
        time: Number((timeMs / 1000).toFixed(3)),
        duration: Number(clamp(durationSec, 0.4, 8).toFixed(3)),
        pitch: 60,
        strength: 1.2,
        type: "slider",
        x: 0.5,
        y: 0.5,
        endX: 0.5,
        endY: 0.5,
      });
      holdCount++;
      continue;
    }

    if (isSlider) {
      const repeats = Number(parts[6]) || 1;
      const pixelLength = Number(parts[7]) || 0;
      const { beatLength, svMultiplier } = getTimingState(timeMs);
      const sliderSpeed = (100 * sliderMultiplier * svMultiplier) / Math.max(1, beatLength);
      const durationMs = sliderSpeed > 0 ? (pixelLength * repeats) / sliderSpeed : 380;
      const durationSec = clamp(durationMs / 1000, 0.28, 8);

      let endX = normalizedX;
      let endY = normalizedY;
      const curveData = parts[5] || "";
      const controlPoints = curveData.split("|").slice(1);
      if (controlPoints.length > 0) {
        const endPoint = controlPoints[controlPoints.length - 1].split(":");
        if (endPoint.length === 2) {
          const endRawX = Number(endPoint[0]);
          const endRawY = Number(endPoint[1]);
          if (Number.isFinite(endRawX) && Number.isFinite(endRawY)) {
            endX = clamp(endRawX / 512, 0, 1);
            endY = clamp(endRawY / 384, 0, 1);
          }
        }
      }

      beats.push({
        time: Number((timeMs / 1000).toFixed(3)),
        duration: Number(durationSec.toFixed(3)),
        pitch: 60,
        strength: 1.05,
        type: "slider",
        x: Number(normalizedX.toFixed(3)),
        y: Number(normalizedY.toFixed(3)),
        endX: Number(endX.toFixed(3)),
        endY: Number(endY.toFixed(3)),
      });
      holdCount++;
      continue;
    }

    beats.push({
      time: Number((timeMs / 1000).toFixed(3)),
      duration: 0.1,
      pitch: 60,
      strength: 1,
      type: "tap",
      x: Number(normalizedX.toFixed(3)),
      y: Number(normalizedY.toFixed(3)),
      endX: Number(normalizedX.toFixed(3)),
      endY: Number(normalizedY.toFixed(3)),
    });
    tapCount++;
  }

  beats.sort((a, b) => a.time - b.time || (a.lane ?? 0) - (b.lane ?? 0));
  return { title, mode: playMode, mapMode, convertedFromStandard: convertingStandardToMania, beats, holdCount, tapCount };
}

// Navigate to a screen
function showScreen(targetScreen) {
  Object.values(screens).forEach((screen) => {
    screen.classList.remove("active");
  });
  targetScreen.classList.add("active");

  if (targetScreen === screens.setup) {
    loadLocalSongs();
  }
}

// 1. LOGIN SCREEN ACTION
document.getElementById("btn-login-next").addEventListener("click", () => {
  const inputVal = document.getElementById("username-input").value.trim();
  if (inputVal) {
    session.username = inputVal;
  }
  document.getElementById("display-username").textContent = session.username;
  showScreen(screens.setup);
});

// 2. SETUP SCREEN ACTIONS

// Volume Slider Control
document.getElementById("volume-slider").addEventListener("input", (e) => {
  const val = e.target.value;
  document.getElementById("volume-val").textContent = val + "%";
  if (typeof window.setVolume === "function") {
    window.setVolume(val / 100);
  }
});

// Mode Card Selection
const modeCards = document.querySelectorAll(".mode-card");
modeCards.forEach((card) => {
  card.addEventListener("click", () => {
    modeCards.forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    session.mode = card.getAttribute("data-mode");
    if (session.mode !== "osu-file") {
      session.importedMode = null;
    }
    if (osuImportPanel) {
      osuImportPanel.style.display = session.mode === "osu-file" ? "block" : "none";
      if (session.mode === "osu-file") {
        loadNativeManiaLibrary();
      }
    }
  });
});

// Log out / Back to Login
document.getElementById("btn-logout").addEventListener("click", () => {
  showScreen(screens.login);
});

// Fetch and display Leaderboard
document.getElementById("btn-show-scores").addEventListener("click", () => {
  showScreen(screens.leaderboard);
  fetchLeaderboard();
});

document.getElementById("btn-close-scores").addEventListener("click", () => {
  showScreen(screens.setup);
});

// Load Song from YouTube URL or Local Selection
document.getElementById("btn-load-song").addEventListener("click", () => {
  if (session.mode === "osu-file") {
    processOsuFileImport();
    return;
  }

  const url = document.getElementById("youtube-url-input").value.trim();

  if (selectedLocalSong && !url) {
    processSong(selectedLocalSong.url, selectedLocalSong.video_id);
    return;
  }

  if (!url) {
    alert("Please enter a YouTube video URL or select a downloaded song from the list below.");
    return;
  }

  processSong(url);
});

const loadOsuButton = document.getElementById("btn-load-osu-file");
if (loadOsuButton) {
  loadOsuButton.addEventListener("click", () => {
    processOsuFileImport();
  });
}

const refreshNativeManiaButton = document.getElementById("btn-refresh-native-mania");
if (refreshNativeManiaButton) {
  refreshNativeManiaButton.addEventListener("click", () => {
    loadNativeManiaLibrary();
  });
}

if (nativeManiaSearchInput) {
  nativeManiaSearchInput.addEventListener("input", (e) => {
    nativeManiaSearchQuery = (e.target.value || "").toLowerCase().trim();
    const filtered = nativeManiaMaps.filter((map) => {
      const haystack = `${map.artist || ""} ${map.title || ""} ${map.version || ""} ${map.file || ""}`.toLowerCase();
      return haystack.includes(nativeManiaSearchQuery);
    });
    renderNativeManiaLibrary(filtered);
  });
}

// Clear selection when user starts typing a YouTube URL
document.getElementById("youtube-url-input").addEventListener("input", () => {
  document.querySelectorAll(".local-song-item").forEach((el) => {
    el.classList.remove("selected");
  });
  selectedLocalSong = null;
});

// Demo Song Action. The button is optional in index.html, so guard it to keep the rest of the UI alive.
const demoSongButton = document.getElementById("btn-demo-song");
if (demoSongButton) {
  demoSongButton.addEventListener("click", () => {
    session.songTitle = "Local Demo Song";
    session.audioUrl = ""; // Empty string triggers synthesized/demo beep beats

    const beats = [];
    let t = 2.0; // Start beats at 2 seconds
    for (let i = 0; i < 150; i++) {
      const isHold = Math.random() < 0.18;
      const isChord = session.mode === "mania" && Math.random() < 0.12;
      const duration = isHold ? 0.35 + Math.random() * 0.65 : 0.1;
      const pitch = 45 + Math.floor(Math.random() * 32); // MIDI pitch range 45 to 77
      const lane = i % 8 < 4 ? i % 4 : 3 - (i % 4);

      beats.push({
        time: t,
        duration: duration,
        pitch: pitch,
        lane: lane,
        strength: isHold ? 1.25 : 0.8 + Math.random() * 0.5,
        type: isHold ? "hold" : "tap",
      });

      if (isChord) {
        beats.push({
          time: t,
          duration: 0.1,
          pitch: pitch + 12,
          lane: 3 - lane,
          strength: 1.15,
          type: "tap",
        });
      }

      t += 0.38 + Math.random() * 0.38; // Spacing of notes
    }
    session.beats = beats;

    launchGame();
  });
}

// 3. API CALLS TO BACKEND

function fetchLeaderboard() {
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading scores...</td></tr>';

  fetch("/api/scores")
    .then((res) => res.json())
    .then((data) => {
      tbody.innerHTML = "";
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No scores posted yet. Be the first!</td></tr>';
        return;
      }

      data.forEach((row, index) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>#${index + 1}</strong></td>
          <td>${escapeHtml(row.username)}</td>
          <td>${escapeHtml(row.song)}</td>
          <td><span style="font-size: 0.8rem; text-transform: uppercase; color: ${row.mode === "mania" ? "var(--accent-neon-pink)" : row.mode === "spectrogram" ? "var(--accent-neon-green)" : "var(--accent-neon-blue)"}">${row.mode}</span></td>
          <td style="font-weight: bold; color: var(--accent-neon-green);">${row.score}</td>
        `;
        tbody.appendChild(tr);
      });
    })
    .catch((err) => {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--accent-neon-pink);">Failed to load scores: ${err.message}</td></tr>`;
    });
}

function processSong(url, videoId) {
  revokeImportedAudioUrl();
  const loaderStatus = document.getElementById("loader-status");
  const loaderSub = document.getElementById("loader-substatus");
  const isSpectrogramMode = session.mode === "spectrogram";

  loaderStatus.textContent = "Connecting to Server...";
  loaderSub.textContent = "Initiating audio parser scripts on backend...";
  showScreen(screens.loader);

  // Poll-like status mock updates for UX
  const intervals = isSpectrogramMode
    ? [
        { time: 1000, text: "Checking cached audio...", sub: "Verifying local assets..." },
        { time: 3000, text: "Downloading YouTube Audio stream...", sub: "Spawning yt-dlp. This takes a few seconds." },
        { time: 8000, text: "Building 30-second preview...", sub: "Using FFmpeg trim with stream copy mode." },
        { time: 13000, text: "Generating spectrogram image...", sub: "Using FFmpeg showspectrumpic filter." },
      ]
    : [
        { time: 1000, text: "Checking cached beatmaps...", sub: "Verifying local assets..." },
        { time: 3000, text: "Downloading YouTube Audio stream...", sub: "Spawning yt-dlp. This takes a few seconds." },
        { time: 9000, text: "Converting Stream to WAV format...", sub: "Spawning FFmpeg to output PCM wav at 44.1kHz." },
        { time: 15000, text: "Analyzing Audio Beats...", sub: "Executing C++ aubio-tempo beat detector tool." },
        { time: 21000, text: "Structuring Beatmaps...", sub: "Generating timelines and syncing notes." },
      ];

  const timers = intervals.map((item) => {
    return setTimeout(() => {
      loaderStatus.textContent = item.text;
      loaderSub.textContent = item.sub;
    }, item.time);
  });

  fetch("/api/songs/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, videoId, mode: session.mode }),
  })
    .then((res) => {
      timers.forEach((t) => clearTimeout(t)); // Clear UX updates
      if (!res.ok) throw new Error("Server failed to process song URL");
      return res.json();
    })
    .then((data) => {
      session.songTitle = data.title;
      session.audioUrl = data.audioUrl;
      session.beats = Array.isArray(data.beats) ? data.beats : [];
      session.spectrogramUrl = data.spectrogramUrl || null;

      launchGame();
    })
    .catch((err) => {
      timers.forEach((t) => clearTimeout(t));
      alert("Error processing song: " + err.message);
      showScreen(screens.setup);
    });
}

function processOsuFileImport() {
  const osuInput = document.getElementById("osu-file-input");
  const audioInput = document.getElementById("osu-audio-input");
  const playModeSelect = document.getElementById("osu-play-mode-select");
  const osuFile = osuInput?.files?.[0];
  const audioFile = audioInput?.files?.[0];
  const selectedPlayMode = playModeSelect?.value || "standard";

  if (!osuFile) {
    alert("Please select an .osu beatmap file.");
    return;
  }
  if (!audioFile) {
    alert("Please select the matching audio file.");
    return;
  }

  if (osuImportStatus) {
    osuImportStatus.textContent = "Parsing .osu file...";
  }

  osuFile
    .text()
    .then((content) => {
      const parsed = parseOsuBeatmap(content, osuFile.name.replace(/\.osu$/i, ""), selectedPlayMode);
      playParsedOsuData(parsed, audioFile);
    })
    .catch((err) => {
      if (osuImportStatus) {
        osuImportStatus.textContent = `Import failed: ${err.message}`;
      }
      alert(`Failed to import .osu file: ${err.message}`);
    });
}

function loadNativeManiaLibrary() {
  if (!nativeManiaList) return;
  nativeManiaList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 12px">Loading native mania maps...</div>`;

  fetch("/api/osu/native-mania")
    .then((res) => {
      if (!res.ok) throw new Error("Failed to load native mania library.");
      return res.json();
    })
    .then((maps) => {
      nativeManiaMaps = Array.isArray(maps) ? maps : [];
      const filtered = nativeManiaSearchQuery
        ? nativeManiaMaps.filter((map) => {
            const haystack = `${map.artist || ""} ${map.title || ""} ${map.version || ""} ${map.file || ""}`.toLowerCase();
            return haystack.includes(nativeManiaSearchQuery);
          })
        : nativeManiaMaps;
      renderNativeManiaLibrary(filtered);
    })
    .catch((err) => {
      nativeManiaList.innerHTML = `<div style="text-align: center; color: var(--accent-neon-pink); font-size: 0.85rem; padding: 12px">${err.message}</div>`;
    });
}

function renderNativeManiaLibrary(maps) {
  if (!nativeManiaList) return;
  nativeManiaList.innerHTML = "";

  if (!maps.length) {
    nativeManiaList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 12px">${
      nativeManiaSearchQuery ? "No native mania maps match your search." : "No native mania maps found in repository library."
    }</div>`;
    return;
  }

  maps.forEach((map) => {
    const item = document.createElement("div");
    item.className = "local-song-item";
    if (selectedNativeManiaMap && selectedNativeManiaMap.file === map.file) {
      item.classList.add("selected");
    }

    const info = document.createElement("div");
    info.className = "local-song-info";

    const title = document.createElement("span");
    title.className = "local-song-title";
    title.textContent = map.title ? `${map.artist ? `${map.artist} - ` : ""}${map.title}${map.version ? ` [${map.version}]` : ""}` : map.file;

    const meta = document.createElement("span");
    meta.className = "local-song-meta";
    meta.textContent = map.audioFilename ? `Audio: ${map.audioFilename}` : "Native mania map";

    info.appendChild(title);
    info.appendChild(meta);

    const playBtn = document.createElement("button");
    playBtn.className = "local-song-play-btn";
    playBtn.textContent = "Play";

    item.appendChild(info);
    item.appendChild(playBtn);

    const selectOnly = () => {
      selectedNativeManiaMap = map;
      nativeManiaList.querySelectorAll(".local-song-item").forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
    };

    const playMap = () => {
      const playModeSelect = document.getElementById("osu-play-mode-select");
      const selectedPlayMode = playModeSelect?.value || "standard";
      const audioInput = document.getElementById("osu-audio-input");
      const audioFile = audioInput?.files?.[0];
      if (!audioFile) {
        alert("Please select the matching audio file in the Audio File field before playing native maps.");
        return;
      }
      if (osuImportStatus) {
        osuImportStatus.textContent = `Loading native map ${map.file}...`;
      }

      fetch(map.mapUrl)
        .then((res) => {
          if (!res.ok) throw new Error("Failed to read native map file.");
          return res.text();
        })
        .then((content) => {
          const parsed = parseOsuBeatmap(content, map.title || map.file.replace(/\.osu$/i, ""), selectedPlayMode);
          playParsedOsuData(parsed, audioFile);
        })
        .catch((err) => {
          if (osuImportStatus) {
            osuImportStatus.textContent = `Native map load failed: ${err.message}`;
          }
          alert(`Failed to load native map: ${err.message}`);
        });
    };

    item.addEventListener("click", selectOnly);
    item.addEventListener("dblclick", () => {
      selectOnly();
      playMap();
    });
    playBtn.addEventListener("click", () => {
      selectOnly();
      playMap();
    });

    nativeManiaList.appendChild(item);
  });
}

// 4. GAME ENTRY & EXIT
function launchGame() {
  showScreen(screens.game);

  // Call startGame implementation in game.js
  if (typeof window.startGame === "function") {
    const playMode = session.mode === "osu-file" ? session.importedMode || "standard" : session.mode;
    window.startGame(session.beats, session.audioUrl, session.songTitle, playMode, session.username, session.spectrogramUrl);
  } else {
    console.error("startGame function not loaded in game.js");
  }
}

// Quit Game back to setup
document.getElementById("btn-exit-game").addEventListener("click", () => {
  if (typeof window.stopGame === "function") {
    window.stopGame();
  }
  showScreen(screens.setup);
});

// 5. RESULTS SCREEN ACTION
document.getElementById("btn-results-continue").addEventListener("click", () => {
  showScreen(screens.setup);
});

// Helper for escaping HTML strings
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// 6. LOCAL/DOWNLOADED SONGS LIST
function loadLocalSongs() {
  const songsListContainer = document.getElementById("local-songs-list");

  fetch("/api/songs/local")
    .then((res) => {
      if (!res.ok) throw new Error("Failed to fetch local songs list");
      return res.json();
    })
    .then((data) => {
      localSongs = data;
      // Preserve selection if the selected song is still in the list
      if (selectedLocalSong) {
        const stillExists = localSongs.some((s) => s.video_id === selectedLocalSong.video_id);
        if (!stillExists) selectedLocalSong = null;
      }
      renderLocalSongs(localSongs);
    })
    .catch((err) => {
      console.error("Failed to load local songs:", err);
      songsListContainer.innerHTML = `<div style="text-align: center; color: var(--accent-neon-pink); font-size: 0.85rem; padding: 20px;">Failed to load songs: ${err.message}</div>`;
    });
}

function renderLocalSongs(songs) {
  const songsListContainer = document.getElementById("local-songs-list");
  songsListContainer.innerHTML = "";

  if (songs.length === 0) {
    songsListContainer.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 20px;">No downloaded songs found.</div>`;
    return;
  }

  songs.forEach((song) => {
    const item = document.createElement("div");
    item.className = "local-song-item";
    if (selectedLocalSong && selectedLocalSong.video_id === song.video_id) {
      item.classList.add("selected");
    }

    const songInfo = document.createElement("div");
    songInfo.className = "local-song-info";

    const titleSpan = document.createElement("span");
    titleSpan.className = "local-song-title";
    titleSpan.textContent = song.title;

    const metaSpan = document.createElement("span");
    metaSpan.className = "local-song-meta";
    metaSpan.textContent = song.url ? "Source: YouTube" : "Source: Local File";

    songInfo.appendChild(titleSpan);
    songInfo.appendChild(metaSpan);

    const playBtn = document.createElement("button");
    playBtn.className = "local-song-play-btn";
    playBtn.textContent = "Play";

    item.appendChild(songInfo);
    item.appendChild(playBtn);

    // Event Listeners
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("local-song-play-btn")) {
        return; // Handled by playBtn listener
      }

      document.querySelectorAll(".local-song-item").forEach((el) => {
        el.classList.remove("selected");
      });
      item.classList.add("selected");
      selectedLocalSong = song;

      // Clear YouTube URL input to make selection distinct
      document.getElementById("youtube-url-input").value = "";
    });

    item.addEventListener("dblclick", () => {
      selectedLocalSong = song;
      processSong(song.url, song.video_id);
    });

    playBtn.addEventListener("click", () => {
      selectedLocalSong = song;
      processSong(song.url, song.video_id);
    });

    songsListContainer.appendChild(item);
  });
}

// Search box listener
document.getElementById("local-song-search").addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase().trim();
  const filtered = localSongs.filter((song) => {
    return song.title.toLowerCase().includes(query) || song.video_id.toLowerCase().includes(query);
  });
  renderLocalSongs(filtered);
});
