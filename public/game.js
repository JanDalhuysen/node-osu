// HTML5 Canvas Game Engine
let canvas = document.getElementById("game-canvas");
let ctx = canvas.getContext("2d");

// Game State variables
let playing = false;
let gameMode = "standard"; // 'standard' or 'mania'
let username = "Guest";
let songTitle = "";

let beats = [];
let audio = null;
let audioCtx = null;
let hitSoundBuffer = null;
let spectrogramImage = null;
let spectrogramLoaded = false;
let spectrogramDuration = 30;

let masterVolume = 0.1; // Default to 10% volume softer

// Game stats
let score = 0;
let streak = 0;
let maxStreak = 0;
let totalHits = 0;
let totalNotes = 0;
let hitAccuracy = 100;
let timeDiffAvg = 0;
let noteIndex = 0;

// Game entities
let activeCircles = []; // For standard mode
let activeNotes = []; // For mania mode (lanes 0, 1, 2, 3)
let activeRatings = []; // For standard mode floating canvas text
let pointerDown = false;

// Timing and animation
let elapsedRealTime = 0;
let lastFrameTime = 0;
let countdownTimer = 0;
let countdownInterval = null;

// Sound Synthesizer Fallback (if audio fails or in Demo Mode)
let synthBeats = [];
let demoMode = false;
let demoStartTime = 0;

// Control configuration
const keysPressed = {
  // Standard mode triggers
  z: false,
  x: false,
  " ": false,
  // Mania mode triggers
  d: false,
  f: false,
  j: false,
  k: false,
};

// Hit Windows (seconds)
const HIT_WINDOW_PERFECT = 0.06;
const HIT_WINDOW_GOOD = 0.15;
const GRACE_PERIOD = 0.5; // Circle/Note lingers after hitting target time
const APPROACH_DURATION = 1.0; // Seconds target takes to approach/fall
const STANDARD_HIT_WINDOW_PERFECT = 0.09;
const STANDARD_HIT_WINDOW_GOOD = 0.24;
const STANDARD_GRACE_PERIOD = 0.8;
const STANDARD_APPROACH_DURATION = 1.25;

// Osu Mania configuration
const MANIA_LANES = 4;
const LANE_WIDTH = 90;
const HIT_LINE_Y_RATIO = 620 / 720;
const NOTE_HEIGHT = 30;
const SPECTROGRAM_PREVIEW_SECONDS = 30;

function normalizeBeatEvent(beat) {
  if (typeof beat === "number") {
    return { time: beat, duration: 0.1, pitch: 60, type: "tap" };
  }

  if (!beat || typeof beat !== "object") {
    return { time: NaN, duration: 0.1, pitch: 60, type: "tap" };
  }

  const time = Number(beat.time);
  const duration = Number.isFinite(Number(beat.duration)) ? Number(beat.duration) : 0.1;
  const pitch = Number.isFinite(Number(beat.pitch)) ? Number(beat.pitch) : 60;
  const lane = Number.isInteger(beat.lane) ? Math.max(0, Math.min(MANIA_LANES - 1, beat.lane)) : undefined;
  const strength = Number.isFinite(Number(beat.strength)) ? Number(beat.strength) : 1;

  return {
    time,
    duration,
    pitch,
    lane,
    strength,
    type: beat.type || (duration > 0.25 ? "hold" : "tap"),
    x: hasFiniteNumber(beat.x) ? Number(beat.x) : undefined,
    y: hasFiniteNumber(beat.y) ? Number(beat.y) : undefined,
    endX: hasFiniteNumber(beat.endX) ? Number(beat.endX) : undefined,
    endY: hasFiniteNumber(beat.endY) ? Number(beat.endY) : undefined,
  };
}

function hasFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function prepareBeats(beatTimes) {
  const sourceBeats = Array.isArray(beatTimes) ? beatTimes : [];
  return sourceBeats
    .map(normalizeBeatEvent)
    .filter((beat) => Number.isFinite(beat.time))
    .sort((a, b) => a.time - b.time || (a.lane ?? 0) - (b.lane ?? 0));
}

// Initialize audio context for synthesize beeps & sound effects
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

// Play hit sound effect (Synthesized beep if key-press-1.mp3 fails)
function playHitSound() {
  initAudio();
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  // Synthesizer beep
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.type = "sine";
  osc.frequency.setValueAtTime(880, audioCtx.currentTime); // Pitch
  gain.gain.setValueAtTime(0.15 * masterVolume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01 * masterVolume, audioCtx.currentTime + 0.1);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.1);
}

// Synthesize metronome for demo mode
function playDemoBeep() {
  initAudio();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = "triangle";
  osc.frequency.setValueAtTime(440, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.1 * masterVolume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01 * masterVolume, audioCtx.currentTime + 0.08);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

// START GAME INTERFACE
window.startGame = function (beatTimes, audioUrl, title, mode, user, spectrogramUrl = null) {
  initAudio();
  playing = true;
  gameMode = mode;
  username = user;
  songTitle = title;

  // Reset stats
  score = 0;
  streak = 0;
  maxStreak = 0;
  totalHits = 0;
  totalNotes = 0;
  hitAccuracy = 100;
  noteIndex = 0;
  activeCircles = [];
  activeNotes = [];
  activeRatings = [];

  const overlay = document.getElementById("rating-overlay");
  if (mode === "mania") {
    overlay.style.display = "block";
    overlay.style.top = "88%";
    overlay.style.fontSize = "2.2rem";
  } else {
    overlay.style.display = "none";
  }

  const scoreHud = document.querySelector(".score-hud");
  const comboHud = document.querySelector(".combo-hud");
  const accuracyHud = document.querySelector(".accuracy-hud");
  const scoreValue = document.getElementById("game-score");
  const comboValue = document.getElementById("game-combo");
  const accuracyValue = document.getElementById("game-accuracy");

  if (mode === "spectrogram") {
    if (scoreHud) scoreHud.style.display = "none";
    if (comboHud) comboHud.style.display = "none";
    if (accuracyHud) accuracyHud.style.display = "none";
    if (scoreValue) scoreValue.textContent = "-------";
    if (comboValue) comboValue.textContent = "--";
    if (accuracyValue) accuracyValue.textContent = "--.--%";
  } else {
    if (scoreHud) scoreHud.style.display = "";
    if (comboHud) comboHud.style.display = "";
    if (accuracyHud) accuracyHud.style.display = "";
  }

  if (mode !== "spectrogram") {
    updateHUD();
  }

  // Determine if Demo Mode (no audioUrl provided)
  if (!audioUrl) {
    demoMode = true;
    beats = prepareBeats(beatTimes);
    startCountdown();
  } else {
    demoMode = false;
    beats = prepareBeats(beatTimes);
    spectrogramImage = null;
    spectrogramLoaded = false;
    spectrogramDuration = SPECTROGRAM_PREVIEW_SECONDS;

    if (mode === "spectrogram" && spectrogramUrl) {
      spectrogramImage = new Image();
      spectrogramImage.onload = () => {
        spectrogramLoaded = true;
      };
      spectrogramImage.src = spectrogramUrl;
    }

    // Load Audio Element
    if (audio) {
      audio.pause();
      audio = null;
    }

    audio = new Audio(audioUrl);
    audio.preload = "auto";
    audio.volume = masterVolume;
    if (mode === "spectrogram") {
      audio.addEventListener(
        "loadedmetadata",
        () => {
          const finiteDuration = Number.isFinite(audio.duration) ? audio.duration : SPECTROGRAM_PREVIEW_SECONDS;
          spectrogramDuration = Math.min(SPECTROGRAM_PREVIEW_SECONDS, Math.max(1, finiteDuration));
        },
        { once: true },
      );
    }

    audio.addEventListener(
      "canplaythrough",
      () => {
        startCountdown();
      },
      { once: true },
    );

    audio.addEventListener("ended", () => {
      endGame();
    });

    audio.addEventListener("error", (e) => {
      console.warn("Audio loading failed, falling back to Demo Synthesizer", e);
      demoMode = true;
      startCountdown();
    });
  }
};

// STOP GAME
window.stopGame = function () {
  playing = false;
  if (audio) {
    audio.pause();
    audio = null;
  }
  spectrogramImage = null;
  spectrogramLoaded = false;
  spectrogramDuration = SPECTROGRAM_PREVIEW_SECONDS;
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  document.getElementById("countdown-modal").style.display = "none";
};

// Countdown Loop (3, 2, 1)
function startCountdown() {
  const modal = document.getElementById("countdown-modal");
  const text = document.getElementById("countdown-text");

  modal.style.display = "flex";
  countdownTimer = 3;
  text.textContent = countdownTimer;

  // Play short blip
  playDemoBeep();

  countdownInterval = setInterval(() => {
    countdownTimer--;
    if (countdownTimer > 0) {
      text.textContent = countdownTimer;
      playDemoBeep();
    } else {
      clearInterval(countdownInterval);
      modal.style.display = "none";

      // Begin Playback
      if (demoMode) {
        demoStartTime = performance.now();
      } else {
        audio.play().catch((err) => {
          console.warn("Audio play failed, playing demo-synthesizer style:", err.message);
          demoMode = true;
          demoStartTime = performance.now();
        });
      }

      // Start Game Canvas Loops
      lastFrameTime = performance.now();
      requestAnimationFrame(gameFrame);
    }
  }, 1000);
}

// Main Frame loop
function gameFrame(timestamp) {
  if (!playing) return;

  const dt = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;

  let currentAudioTime = 0;
  if (demoMode) {
    currentAudioTime = (timestamp - demoStartTime) / 1000;

    // Check if song has finished (all beats passed and no active elements)
    const lastBeat = beats[beats.length - 1];
    const lastBeatTime = lastBeat ? lastBeat.time + (lastBeat.duration || 0) : 0;
    if (currentAudioTime > lastBeatTime + 1.5 && activeCircles.length === 0 && activeNotes.length === 0) {
      endGame();
      return;
    }
  } else {
    currentAudioTime = audio.currentTime;
  }

  // Update time display
  document.getElementById("game-timer").textContent = currentAudioTime.toFixed(2) + "s";

  if (gameMode === "spectrogram") {
    updateSpectrogram(currentAudioTime);
    drawSpectrogram(currentAudioTime);
  } else if (gameMode === "standard") {
    // Spawn notes/circles based on current time
    spawnEntities(currentAudioTime);
    updateStandard(currentAudioTime, dt);
    drawStandard(currentAudioTime);
  } else {
    // Spawn notes/circles based on current time
    spawnEntities(currentAudioTime);
    updateMania(currentAudioTime, dt);
    drawMania(currentAudioTime);
  }

  requestAnimationFrame(gameFrame);
}

function updateSpectrogram(currentTime) {
  if (currentTime >= SPECTROGRAM_PREVIEW_SECONDS) {
    endGame();
  }
}

function drawSpectrogram(currentTime) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#07070b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (spectrogramLoaded && spectrogramImage) {
    ctx.drawImage(spectrogramImage, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "#111116";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#a0a5b5";
    ctx.font = "bold 32px Outfit";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Loading spectrogram image...", canvas.width / 2, canvas.height / 2);
  }

  const duration = Math.max(1, spectrogramDuration || SPECTROGRAM_PREVIEW_SECONDS);
  const lineX = Math.max(0, Math.min(canvas.width, (currentTime / duration) * canvas.width));
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(lineX, 0);
  ctx.lineTo(lineX, canvas.height);
  ctx.stroke();

  ctx.strokeStyle = "rgba(0, 240, 255, 0.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lineX + 2, 0);
  ctx.lineTo(lineX + 2, canvas.height);
  ctx.stroke();
}

// Spawns entities just before they are due
function spawnEntities(currentTime) {
  const spawnAhead = gameMode === "standard" ? STANDARD_APPROACH_DURATION : APPROACH_DURATION;

  // Find beats to spawn
  while (noteIndex < beats.length && beats[noteIndex].time <= currentTime + spawnAhead) {
    const noteData = beats[noteIndex];
    const beatTime = noteData.time;

    if (gameMode === "standard") {
      // Prefer server-generated music-aware positions; fallback to legacy random motion.
      let lastX = canvas.width / 2;
      let lastY = canvas.height / 2;

      if (activeCircles.length > 0) {
        lastX = activeCircles[activeCircles.length - 1].x;
        lastY = activeCircles[activeCircles.length - 1].y;
      }

      const radius = 35;
      const marginX = radius * 2;
      const marginY = radius * 2;
      const playWidth = canvas.width - marginX * 2;
      const playHeight = canvas.height - marginY * 2;

      const isSlider = noteData.type === "slider" || noteData.duration > 0.3;
      const strength = Math.max(0.35, Math.min(1.6, noteData.strength || 1));
      const travel = isSlider ? 260 + strength * 80 : 250;
      const hasGeneratedPosition = hasFiniteNumber(noteData.x) && hasFiniteNumber(noteData.y);

      let nextX;
      let nextY;
      if (hasGeneratedPosition) {
        nextX = marginX + Math.max(0, Math.min(1, Number(noteData.x))) * playWidth;
        nextY = marginY + Math.max(0, Math.min(1, Number(noteData.y))) * playHeight;
      } else {
        const rx = Math.random() * 2 - 1;
        const ry = Math.random() * 2 - 1;
        nextX = lastX + rx * travel;
        nextY = lastY + ry * travel;

        if (nextX < marginX) nextX = marginX;
        if (nextX > marginX + playWidth) nextX = marginX + playWidth;
        if (nextY < marginY) nextY = marginY;
        if (nextY > marginY + playHeight) nextY = marginY + playHeight;
      }

      let endX = nextX;
      let endY = nextY;
      const hasGeneratedSliderEnd = hasFiniteNumber(noteData.endX) && hasFiniteNumber(noteData.endY);
      if (isSlider && hasGeneratedSliderEnd) {
        endX = marginX + Math.max(0, Math.min(1, Number(noteData.endX))) * playWidth;
        endY = marginY + Math.max(0, Math.min(1, Number(noteData.endY))) * playHeight;
      } else if (isSlider) {
        const sliderAngle = Math.atan2(nextY - lastY, nextX - lastX) + (Math.random() * 1.2 - 0.6);
        endX = nextX + Math.cos(sliderAngle) * (180 + strength * 70);
        endY = nextY + Math.sin(sliderAngle) * (120 + strength * 45);
        if (endX < marginX) endX = marginX;
        if (endX > marginX + playWidth) endX = marginX + playWidth;
        if (endY < marginY) endY = marginY;
        if (endY > marginY + playHeight) endY = marginY + playHeight;
      }

      activeCircles.push({
        x: nextX,
        y: nextY,
        endX: isSlider ? endX : nextX,
        endY: isSlider ? endY : nextY,
        radius: radius,
        maxTime: beatTime,
        startTime: beatTime - spawnAhead,
        endTime: beatTime + (isSlider ? Math.max(0.35, noteData.duration) : 0),
        duration: isSlider ? Math.max(0.35, noteData.duration) : 0,
        isSlider,
        hitStarted: false,
        completed: false,
        lastTickTime: 0,
        strength,
        color: getRandomColor(),
      });
      totalNotes++;
    } else {
      // Mania Note Spawning prefers generated chart lanes, with pitch fallback for older beat maps.
      const lane = Number.isInteger(noteData.lane) ? noteData.lane : getLaneFromPitch(noteData.pitch);
      const isHoldNote = noteData.type === "hold" || noteData.duration > 0.25;

      if (isHoldNote) {
        // Hold Note / Slider
        activeNotes.push({
          lane: lane,
          maxTime: beatTime,
          startTime: beatTime - spawnAhead,
          endTime: beatTime + noteData.duration,
          duration: noteData.duration,
          isHold: true,
          hitStarted: false,
          hitEnded: false,
          missed: false,
          lastTickTime: 0,
          strength: noteData.strength || 1,
        });
      } else {
        // Normal Tap Note
        activeNotes.push({
          lane: lane,
          maxTime: beatTime,
          startTime: beatTime - spawnAhead,
          isHold: false,
          hit: false,
          strength: noteData.strength || 1,
        });
      }
      totalNotes++;
    }

    noteIndex++;
  }
}

// Map pitch (e.g. 36-96) to a lane index (0-3)
function getLaneFromPitch(pitch) {
  // Typical range of detected notes is 40 to 80
  const minPitch = 48;
  const maxPitch = 78;

  if (pitch <= minPitch) return 0;
  if (pitch >= maxPitch) return 3;

  const range = maxPitch - minPitch;
  const normalized = (pitch - minPitch) / range;
  return Math.min(3, Math.floor(normalized * 4));
}

// Get Random RGB Color (similar to Raylib GetRandomValue)
function getRandomColor() {
  const r = Math.floor(Math.random() * 150) + 100;
  const g = Math.floor(Math.random() * 150) + 100;
  const b = Math.floor(Math.random() * 150) + 100;
  return { r, g, b };
}

// ----------------------------------------------------
// STANDARD MODE LOGIC
// ----------------------------------------------------

function updateStandard(currentTime, dt) {
  for (let i = activeCircles.length - 1; i >= 0; i--) {
    let c = activeCircles[i];

    if (c.isSlider && c.hitStarted) {
      const follow = getSliderFollowPoint(c, currentTime);
      const followDist = Math.hypot(mouseX - follow.x, mouseY - follow.y);
      const stillHolding = pointerDown || keysPressed.z || keysPressed.x || keysPressed[" "];

      if (currentTime >= c.endTime) {
        score += 300;
        streak++;
        totalHits++;
        triggerRating("perfect", c.endX, c.endY);
        updateHUD();
        activeCircles.splice(i, 1);
        continue;
      }

      if (!stillHolding || followDist > c.radius * 1.75) {
        triggerRating("miss", follow.x, follow.y);
        streak = 0;
        updateHUD();
        activeCircles.splice(i, 1);
        continue;
      }

      if (currentTime - c.lastTickTime >= 0.1) {
        score += 10;
        c.lastTickTime = currentTime;
        updateHUD();
      }
    }

    if (!c.hitStarted && currentTime > c.maxTime + STANDARD_GRACE_PERIOD) {
      triggerRating("miss", c.x, c.y);
      streak = 0;
      updateHUD();
      activeCircles.splice(i, 1);
    }
  }

  // Update floating ratings
  for (let i = activeRatings.length - 1; i >= 0; i--) {
    let r = activeRatings[i];
    r.elapsed += dt;
    r.y -= 35 * dt; // Float up slowly
    if (r.elapsed > 0.5) {
      activeRatings.splice(i, 1);
    }
  }
}

function getSliderFollowPoint(c, currentTime) {
  if (!c.isSlider || c.duration <= 0) {
    return { x: c.x, y: c.y };
  }

  const t = Math.max(0, Math.min(1, (currentTime - c.maxTime) / c.duration));
  const control = getSliderControlPoint(c);
  const oneMinusT = 1 - t;
  return {
    x: oneMinusT * oneMinusT * c.x + 2 * oneMinusT * t * control.x + t * t * c.endX,
    y: oneMinusT * oneMinusT * c.y + 2 * oneMinusT * t * control.y + t * t * c.endY,
  };
}

function getSliderControlPoint(c) {
  return {
    x: (c.x + c.endX) / 2,
    y: Math.min(c.y, c.endY) - c.radius * 2,
  };
}

function drawStandard(currentTime) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dark Background with grid lines
  ctx.fillStyle = "#111116";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Render active circles
  activeCircles.forEach((c) => {
    if (currentTime < c.startTime) return;

    let alpha = 1.0;
    if (c.hitStarted) {
      alpha = 1.0;
    } else if (currentTime <= c.maxTime) {
      // Fade in approach
      alpha = (currentTime - c.startTime) / (c.maxTime - c.startTime);
    } else {
      // Fade out grace period
      let graceT = (currentTime - c.maxTime) / STANDARD_GRACE_PERIOD;
      alpha = Math.max(0, 1.0 - graceT);
    }

    if (c.isSlider) {
      const follow = getSliderFollowPoint(c, currentTime);
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = `rgba(${c.color.r}, ${c.color.g}, ${c.color.b}, 0.45)`;
      ctx.lineWidth = c.radius * 1.2;
      ctx.lineCap = "round";
      const control = getSliderControlPoint(c);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.quadraticCurveTo(control.x, control.y, c.endX, c.endY);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 255, 255, 0.45)`;
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(c.endX, c.endY, c.radius * 0.75, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${c.color.r}, ${c.color.g}, ${c.color.b}, ${alpha * 0.8})`;
      ctx.fill();

      if (c.hitStarted) {
        ctx.beginPath();
        ctx.arc(follow.x, follow.y, c.radius * 0.45, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(255, 255, 255, 0.95)`;
        ctx.shadowBlur = 12;
        ctx.shadowColor = "#ffffffaa";
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    // Outer approach ring
    if (currentTime <= c.maxTime) {
      let t = (currentTime - c.startTime) / (c.maxTime - c.startTime);
      let ringRadius = c.radius + c.radius * 0.7 * (1.0 - t);

      ctx.beginPath();
      ctx.arc(c.x, c.y, ringRadius, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(0, 240, 255, ${alpha})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Target circle body
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.radius, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${c.color.r}, ${c.color.g}, ${c.color.b}, ${alpha})`;
    ctx.shadowBlur = 10;
    ctx.shadowColor = `rgba(${c.color.r}, ${c.color.g}, ${c.color.b}, ${alpha * 0.4})`;
    ctx.fill();
    ctx.shadowBlur = 0; // Reset shadow

    // Inner circle core
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.radius * 0.25, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fill();
  });

  // Render floating ratings inside standard circles (or where they were hit/missed)
  activeRatings.forEach((r) => {
    let alpha = Math.max(0, 1.0 - r.elapsed / 0.5);
    ctx.save();
    ctx.font = "bold 20px Outfit";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const colors = {
      perfect: "#00f0ff",
      good: "#39ff14",
      miss: "#ff007f",
    };

    ctx.fillStyle = colors[r.type];
    ctx.shadowBlur = 6;
    ctx.shadowColor = colors[r.type] + "88";
    ctx.globalAlpha = alpha;
    ctx.fillText(r.type.toUpperCase(), r.x, r.y);
    ctx.restore();
  });
}

// ----------------------------------------------------
// MANIA MODE LOGIC
// ----------------------------------------------------

function updateMania(currentTime, dt) {
  const laneKeys = ["d", "f", "j", "k"];
  for (let i = activeNotes.length - 1; i >= 0; i--) {
    let n = activeNotes[i];

    if (!n.isHold) {
      // Normal note miss check
      if (!n.hit && currentTime > n.maxTime + HIT_WINDOW_GOOD) {
        triggerRating("miss");
        streak = 0;
        updateHUD();
        activeNotes.splice(i, 1);
      }
    } else {
      // Hold note logic
      if (!n.hitStarted) {
        // Missed head check
        if (currentTime > n.maxTime + HIT_WINDOW_GOOD) {
          triggerRating("miss");
          streak = 0;
          updateHUD();
          activeNotes.splice(i, 1);
        }
      } else if (!n.hitEnded) {
        const key = laneKeys[n.lane];
        if (!keysPressed[key]) {
          // Let go check - was it a good release or an early release miss?
          const releaseDiff = Math.abs(currentTime - n.endTime);
          if (releaseDiff <= HIT_WINDOW_GOOD) {
            // Good release!
            n.hitEnded = true;
            score += 100;
            const releaseRating = releaseDiff <= HIT_WINDOW_PERFECT ? "perfect" : "good";
            triggerRating(releaseRating);
            updateHUD();
            activeNotes.splice(i, 1);
          } else {
            // Released too early
            triggerRating("miss");
            streak = 0;
            updateHUD();
            activeNotes.splice(i, 1);
          }
        } else {
          // Award holding tick score every 0.1 seconds
          if (currentTime - n.lastTickTime >= 0.1) {
            score += 10;
            n.lastTickTime = currentTime;
            updateHUD();
          }
          // Completed hold release (held past the end)
          if (currentTime >= n.endTime) {
            n.hitEnded = true;
            score += 100;
            triggerRating("perfect");
            updateHUD();
            activeNotes.splice(i, 1);
          }
        }
      }
    }
  }
}

function drawManiaNoteHead(x, y, width, height, color, glyph) {
  const grad = ctx.createLinearGradient(0, y - height, 0, y);
  grad.addColorStop(0, "#ffffff22");
  grad.addColorStop(0.26, color);
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x, y - height, width, height, 6);
  ctx.fill();

  // White hit accent line under the head, matching osu!mania style.
  const lineHeight = Math.max(5, height * 0.14);
  const lineY = y - lineHeight - 2;
  ctx.fillStyle = "#f2f2f2";
  ctx.beginPath();
  ctx.roundRect(x + 2, lineY, width - 4, lineHeight, 4);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(16, height * 0.45)}px Outfit`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, x + width / 2, y - height / 2 + 1);
}

function drawMania(currentTime) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const playfieldWidth = MANIA_LANES * LANE_WIDTH;
  const laneXStart = (canvas.width - playfieldWidth) / 2;
  const hitLineY = Math.floor(canvas.height * HIT_LINE_Y_RATIO);
  const laneKeys = ["d", "f", "j", "k"];
  const laneColors = ["#f4bf38", "#ff7a00", "#e61d63", "#c63dff"];
  const laneBodyColors = ["#2e2303", "#220d00", "#28000d", "#1a0424"];

  // Background
  ctx.fillStyle = "#040406";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Lanes with dark color tints, closer to osu!mania look.
  for (let i = 0; i < MANIA_LANES; i++) {
    const laneX = laneXStart + i * LANE_WIDTH;
    const laneGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    laneGrad.addColorStop(0, laneBodyColors[i] + "ee");
    laneGrad.addColorStop(1, laneBodyColors[i] + "cc");
    ctx.fillStyle = laneGrad;
    ctx.fillRect(laneX, 0, LANE_WIDTH, canvas.height);
  }

  // Lane separators
  ctx.strokeStyle = "#050507";
  ctx.lineWidth = 4;
  for (let i = 0; i <= MANIA_LANES; i++) {
    const x = laneXStart + i * LANE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  // Press highlight overlays
  for (let i = 0; i < MANIA_LANES; i++) {
    if (!keysPressed[laneKeys[i]]) continue;
    ctx.fillStyle = laneColors[i] + "33";
    ctx.fillRect(laneXStart + i * LANE_WIDTH, 0, LANE_WIDTH, canvas.height);
  }

  // Receptor/hit area near bottom
  const receptorTop = Math.min(canvas.height - 68, hitLineY + 28);
  ctx.fillStyle = "rgba(170, 170, 170, 0.35)";
  ctx.fillRect(laneXStart, receptorTop, playfieldWidth, canvas.height - receptorTop);

  for (let i = 0; i < MANIA_LANES; i++) {
    const laneX = laneXStart + i * LANE_WIDTH;
    ctx.fillStyle = "rgba(204, 204, 204, 0.55)";
    ctx.beginPath();
    ctx.roundRect(laneX + 3, receptorTop - 6, LANE_WIDTH - 6, 12, 5);
    ctx.fill();
  }

  // Hit line
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(laneXStart, hitLineY);
  ctx.lineTo(laneXStart + playfieldWidth, hitLineY);
  ctx.stroke();

  // Lane key labels in small rings near the bottom
  for (let i = 0; i < MANIA_LANES; i++) {
    const labelX = laneXStart + i * LANE_WIDTH + LANE_WIDTH / 2;
    const labelY = canvas.height - 28;
    const pressed = keysPressed[laneKeys[i]];
    ctx.strokeStyle = pressed ? "#ffffff" : "#d7d7d7";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(labelX, labelY, 14, 0, Math.PI * 2);
    ctx.stroke();
  }

  activeNotes.forEach((n) => {
    if (currentTime < n.startTime) return;
    if (n.isHold && n.hitEnded) return;
    if (!n.isHold && n.hit) return;

    const x = laneXStart + n.lane * LANE_WIDTH + 4;
    const width = LANE_WIDTH - 8;
    const color = laneColors[n.lane];
    const strength = Math.max(0.35, Math.min(1.6, n.strength || 1));
    const noteHeight = NOTE_HEIGHT * (n.isHold ? 0.95 + strength * 0.16 : 1.45 + strength * 0.2);
    // const glyph = n.isHold ? "−" : "⌄";
    const glyph = "";

    if (!n.isHold) {
      const timeT = (currentTime - n.startTime) / APPROACH_DURATION;
      const y = hitLineY * timeT;
      drawManiaNoteHead(x, y, width, noteHeight, color, glyph);
      return;
    }

    let headY, tailY;
    if (!n.hitStarted) {
      const headT = (currentTime - n.startTime) / APPROACH_DURATION;
      headY = hitLineY * headT;
      const tailT = (currentTime - n.startTime - n.duration) / APPROACH_DURATION;
      tailY = hitLineY * tailT;
    } else {
      headY = hitLineY;
      const tailT = (currentTime - n.startTime - n.duration) / APPROACH_DURATION;
      tailY = hitLineY * tailT;
    }

    if (tailY < 0) tailY = 0;
    if (headY > hitLineY) headY = hitLineY;
    if (headY <= tailY) return;

    ctx.fillStyle = color + "88";
    ctx.fillRect(x, tailY, width, headY - tailY);
    ctx.strokeStyle = color + "aa";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, tailY, width - 2, headY - tailY);

    drawManiaNoteHead(x, headY, width, noteHeight, color, glyph);
  });
}

// ----------------------------------------------------
// INPUT & INTERACTIVE EVENT HANDLERS
// ----------------------------------------------------

// Mouse / Touch Clicks (Standard Mode only)
canvas.addEventListener("mousedown", (e) => {
  if (!playing || gameMode !== "standard") return;
  pointerDown = true;

  // Calculate relative cursor coordinates inside canvas bounds
  const rect = canvas.getBoundingClientRect();
  const clickX = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const clickY = ((e.clientY - rect.top) / rect.height) * canvas.height;

  checkStandardHit(clickX, clickY);
});

window.addEventListener("mouseup", () => {
  pointerDown = false;
});

// Keyboard Listeners
window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();

  if (key in keysPressed) {
    // Prevent default scrolling space bar actions
    if (key === " ") e.preventDefault();

    if (!keysPressed[key]) {
      keysPressed[key] = true;

      if (playing) {
        if (gameMode === "standard") {
          // Standard Mode click simulated by keys
          // Retrieve current cursor position
          const rect = canvas.getBoundingClientRect();
          // We can use standard mouse movement tracker
          checkStandardHit(mouseX, mouseY);
        } else {
          // Mania Mode keys
          checkManiaHit(key);
        }
      }
    }
  }
});

window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  if (key in keysPressed) {
    keysPressed[key] = false;
  }
});

// Cursor Tracking (for standard mode simulated keys)
let mouseX = 0;
let mouseY = 0;
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = ((e.clientX - rect.left) / rect.width) * canvas.width;
  mouseY = ((e.clientY - rect.top) / rect.height) * canvas.height;
});

// Check hit standard mode
function checkStandardHit(x, y) {
  let currentTime = demoMode ? (performance.now() - demoStartTime) / 1000 : audio.currentTime;

  for (let i = 0; i < activeCircles.length; i++) {
    let c = activeCircles[i];

    if (c.isSlider && c.hitStarted) {
      continue;
    }

    if (currentTime >= c.startTime) {
      const dist = Math.hypot(x - c.x, y - c.y);
      if (dist <= c.radius) {
        // Evaluate timing difference
        const timeDiff = Math.abs(currentTime - c.maxTime);

        let rating = "miss";
        let points = 0;

        if (timeDiff <= STANDARD_HIT_WINDOW_PERFECT) {
          rating = "perfect";
          points = 300;
        } else if (timeDiff <= STANDARD_HIT_WINDOW_GOOD) {
          rating = "good";
          points = 100;
        }

        if (points > 0) {
          if (c.isSlider) {
            c.hitStarted = true;
            c.lastTickTime = currentTime;
            score += points;
            triggerRating(rating, c.x, c.y);
          } else {
            score += points;
            streak++;
            totalHits++;
            triggerRating(rating, c.x, c.y);
            activeCircles.splice(i, 1);
          }
          updateHUD();
        }
        break; // Only click one circle
      }
    }
  }
}

// Check hit mania mode
function checkManiaHit(key) {
  const keyLanes = { d: 0, f: 1, j: 2, k: 3 };
  const targetLane = keyLanes[key];
  if (targetLane === undefined) return;

  let currentTime = demoMode ? (performance.now() - demoStartTime) / 1000 : audio.currentTime;

  // Search for the closest unhit note/head in that lane
  let closestNoteIndex = -1;
  let minDiff = Infinity;

  for (let i = 0; i < activeNotes.length; i++) {
    let n = activeNotes[i];
    if (n.lane === targetLane) {
      const isUnhit = !n.isHold ? !n.hit : !n.hitStarted;
      if (isUnhit) {
        const diff = Math.abs(currentTime - n.maxTime);
        if (diff < minDiff && diff <= HIT_WINDOW_GOOD) {
          minDiff = diff;
          closestNoteIndex = i;
        }
      }
    }
  }

  if (closestNoteIndex !== -1) {
    let n = activeNotes[closestNoteIndex];
    let rating = "miss";
    let points = 0;

    if (minDiff <= HIT_WINDOW_PERFECT) {
      rating = "perfect";
      points = 300;
    } else if (minDiff <= HIT_WINDOW_GOOD) {
      rating = "good";
      points = 100;
    }

    if (points > 0) {
      score += points;
      streak++;
      totalHits++;

      if (!n.isHold) {
        n.hit = true;
        activeNotes.splice(closestNoteIndex, 1);
      } else {
        n.hitStarted = true;
        n.lastTickTime = currentTime;
      }

      triggerRating(rating);
      playHitSound();
      updateHUD();
    }
  }
}

// HUD updates
function updateHUD() {
  if (gameMode === "spectrogram") {
    return;
  }

  document.getElementById("game-score").textContent = score.toString().padStart(7, "0");
  document.getElementById("game-combo").textContent = streak + "x";

  if (streak > maxStreak) maxStreak = streak;

  // Calculate Accuracy percentage
  if (totalNotes > 0) {
    // Approximated hits vs total generated
    const acc = Math.min(100, (totalHits / totalNotes) * 100);
    hitAccuracy = acc;
    document.getElementById("game-accuracy").textContent = acc.toFixed(2) + "%";
  } else {
    document.getElementById("game-accuracy").textContent = "100.00%";
  }
}

// Hit Timing Rating Banner overlay popup
function triggerRating(type, x, y) {
  if (gameMode === "standard") {
    activeRatings.push({
      x: x,
      y: y,
      type: type,
      elapsed: 0,
    });
  } else {
    const overlay = document.getElementById("rating-overlay");
    overlay.className = ""; // Reset classes

    // Trigger layout reflow to restart css animation
    void overlay.offsetWidth;

    overlay.textContent = type;
    overlay.classList.add(type);
  }
}

// GAME OVER EVALUATION
function endGame() {
  playing = false;
  if (audio) {
    audio.pause();
  }

  if (gameMode !== "spectrogram") {
    // Submit Score to Server DB
    saveScoreToServer();
  }

  // Load results screen
  document.getElementById("results-song-title").textContent = songTitle;
  document.getElementById("results-mode").textContent = gameMode === "standard" ? "Mode: Standard" : gameMode === "mania" ? "Mode: osu!mania (4K)" : "Mode: Spectrogram View (30s)";
  if (gameMode === "spectrogram") {
    document.getElementById("results-score").textContent = "N/A";
    document.getElementById("results-combo").textContent = "N/A";
    document.getElementById("results-accuracy").textContent = "N/A";
  } else {
    document.getElementById("results-score").textContent = score;
    document.getElementById("results-combo").textContent = maxStreak + "x";
    document.getElementById("results-accuracy").textContent = hitAccuracy.toFixed(2) + "%";
  }

  // Switch to Results Screen
  const screens = {
    game: document.getElementById("screen-game"),
    results: document.getElementById("screen-results"),
  };
  screens.game.classList.remove("active");
  screens.results.classList.add("active");
}

function saveScoreToServer() {
  fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: username,
      score: score,
      song: songTitle,
      mode: gameMode,
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      console.log("Score saved successfully, local id:", data.id);
    })
    .catch((err) => {
      console.error("Failed to post score to database:", err.message);
    });
}

// Adjust master volume dynamically
window.setVolume = function (vol) {
  masterVolume = vol;
  if (audio) {
    audio.volume = vol;
  }
};
