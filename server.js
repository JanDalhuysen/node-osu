const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ensure directory structures exist
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
const songDir = path.join(__dirname, "public", "assets", "songs");
if (!fs.existsSync(songDir)) {
  fs.mkdirSync(songDir, { recursive: true });
}
const nativeManiaDir = path.join(dataDir, "native_mania_maps");
if (!fs.existsSync(nativeManiaDir)) {
  fs.mkdirSync(nativeManiaDir, { recursive: true });
}
app.use("/assets/native-mania", express.static(nativeManiaDir));

// Locate tools in parent directory or system path
const getToolPath = (toolName) => {
  const winExt = process.platform === "win32" ? ".exe" : "";
  const localPath = path.join(__dirname, "..", toolName + winExt);
  if (fs.existsSync(localPath)) {
    return `"${localPath}"`;
  }
  return toolName;
};

const ytDlp = getToolPath("yt-dlp");
const wavToBeats = getToolPath("wav_to_beats");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function createSeededRng(seedInput) {
  let seed = 2166136261;
  const seedText = String(seedInput || "default-seed");

  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  return () => {
    seed += 0x6d2b79f5;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getPitchAnchorLane(pitch) {
  const minPitch = 44;
  const maxPitch = 84;
  if (pitch <= minPitch) return 0;
  if (pitch >= maxPitch) return 3;
  const normalized = (pitch - minPitch) / (maxPitch - minPitch);
  return clamp(Math.round(normalized * 3), 0, 3);
}

function clampPosition(pos) {
  const bounds = { minX: 0.12, maxX: 0.88, minY: 0.14, maxY: 0.86 };
  return {
    x: clamp(pos.x, bounds.minX, bounds.maxX),
    y: clamp(pos.y, bounds.minY, bounds.maxY),
  };
}

function getLaneFromPitch(pitch) {
  const minPitch = 48;
  const maxPitch = 78;
  if (pitch <= minPitch) return 0;
  if (pitch >= maxPitch) return 3;
  return clamp(Math.floor(((pitch - minPitch) / (maxPitch - minPitch)) * 4), 0, 3);
}

function normalizeBeatEvent(event) {
  if (typeof event === "number") {
    return { time: event, duration: 0.1, pitch: 60 };
  }

  if (!event || typeof event !== "object") {
    return { time: NaN, duration: 0.1, pitch: 60 };
  }

  return {
    time: Number(event.time),
    duration: Number.isFinite(Number(event.duration)) ? Number(event.duration) : 0.1,
    pitch: Number.isFinite(Number(event.pitch)) ? Number(event.pitch) : 60,
    lane: Number.isInteger(event.lane) ? clamp(event.lane, 0, 3) : undefined,
    strength: Number.isFinite(Number(event.strength)) ? Number(event.strength) : undefined,
    type: event.type,
  };
}

function createStandardBeatmap(normalized, rng) {
  const intervals = [];
  for (let i = 1; i < normalized.length; i++) {
    const gap = normalized[i].time - normalized[i - 1].time;
    if (gap >= 0.12 && gap <= 1.2) {
      intervals.push(gap);
    }
  }

  const typicalGap = clamp(median(intervals) || 0.42, 0.26, 0.55);
  const minGap = clamp(typicalGap * 0.9, 0.24, 0.46);
  const chart = [];
  let lastTime = -Infinity;
  let lastSliderTime = -Infinity;
  let phraseCount = 0;
  let position = { x: 0.5, y: 0.62 };
  let heading = Math.PI * 1.15;

  for (let i = 0; i < normalized.length; i++) {
    const event = normalized[i];
    const previous = normalized[i - 1];
    const next = normalized[i + 1];
    const localGap = previous ? event.time - previous.time : Infinity;
    const nextGap = next ? next.time - event.time : Infinity;
    const strength = clamp(event.strength || event.duration / 0.16 || 1, 0.35, 1.6);

    const isPhraseStart = localGap > typicalGap * 1.8;
    const isStrongAccent = strength >= 1.05 || event.duration >= 0.22 || isPhraseStart;
    const enoughSpace = event.time - lastTime >= minGap;
    const canAddFastAccent = event.time - lastTime >= 0.2 && isStrongAccent && phraseCount < 2;

    if (!enoughSpace && !canAddFastAccent) {
      continue;
    }

    const sliderCandidate = event.duration >= 0.32 || (isStrongAccent && nextGap > minGap * 1.4 && event.duration >= 0.22);
    const isSlider = sliderCandidate && event.time - lastSliderTime > 2.4 && event.time - lastTime >= minGap * 1.2;
    const duration = isSlider ? Number(clamp(event.duration, 0.38, 0.9).toFixed(3)) : 0.1;
    const pitchNorm = clamp((event.pitch - 42) / 44, 0, 1);
    const melodicTilt = next ? clamp((next.pitch - event.pitch) / 12, -1, 1) : 0;
    const rhythmDensity = clamp(typicalGap / Math.max(localGap, 0.08), 0.6, 2.2);
    const jumpDistance = clamp(0.17 + strength * 0.07 + (isPhraseStart ? 0.08 : 0) - (rhythmDensity - 1) * 0.06, 0.11, 0.33);

    const phraseTurn = isPhraseStart ? (rng() > 0.5 ? 0.95 : -0.95) : 0;
    heading += melodicTilt * 0.55 + (pitchNorm - 0.5) * 0.25 + phraseTurn;

    let nextPos = {
      x: position.x + Math.cos(heading) * jumpDistance,
      y: position.y + Math.sin(heading) * jumpDistance,
    };

    if (nextPos.x < 0.12 || nextPos.x > 0.88) {
      heading = Math.PI - heading;
      nextPos.x = position.x + Math.cos(heading) * jumpDistance;
    }
    if (nextPos.y < 0.14 || nextPos.y > 0.86) {
      heading = -heading;
      nextPos.y = position.y + Math.sin(heading) * jumpDistance;
    }
    nextPos = clampPosition(nextPos);

    if (Math.hypot(nextPos.x - position.x, nextPos.y - position.y) < 0.09) {
      const nudge = 0.1 + rng() * 0.06;
      heading += rng() > 0.5 ? Math.PI / 2 : -Math.PI / 2;
      nextPos = clampPosition({
        x: nextPos.x + Math.cos(heading) * nudge,
        y: nextPos.y + Math.sin(heading) * nudge,
      });
    }

    const sliderLength = clamp(0.12 + strength * 0.08 + Math.max(0, duration - 0.24) * 0.18, 0.13, 0.34);
    const sliderHeading = heading + clamp(melodicTilt * 0.65, -0.85, 0.85);
    const sliderEnd = isSlider
      ? clampPosition({
          x: nextPos.x + Math.cos(sliderHeading) * sliderLength,
          y: nextPos.y + Math.sin(sliderHeading) * (sliderLength * 0.75),
        })
      : nextPos;

    chart.push({
      time: Number(event.time.toFixed(3)),
      duration,
      pitch: Math.round(event.pitch || 60),
      strength: Number(strength.toFixed(2)),
      type: isSlider ? "slider" : "tap",
      x: Number(nextPos.x.toFixed(3)),
      y: Number(nextPos.y.toFixed(3)),
      endX: Number(sliderEnd.x.toFixed(3)),
      endY: Number(sliderEnd.y.toFixed(3)),
    });

    if (isSlider) {
      lastSliderTime = event.time;
    }
    phraseCount = nextGap > typicalGap * 1.8 ? 0 : phraseCount + 1;
    lastTime = event.time;
    position = nextPos;
  }

  return chart;
}

function createManiaBeatmap(normalized, rng) {
  if (normalized.some((event) => Number.isInteger(event.lane))) {
    return normalized
      .map((event) => ({
        time: Number(event.time.toFixed(3)),
        duration: Number(clamp(event.duration || 0.1, 0.05, 1.2).toFixed(3)),
        pitch: Math.round(event.pitch || 60),
        lane: Number.isInteger(event.lane) ? event.lane : getLaneFromPitch(event.pitch || 60),
        strength: Number(clamp(event.strength || 1, 0.35, 1.6).toFixed(2)),
        type: event.type || (event.duration > 0.25 ? "hold" : "tap"),
      }))
      .sort((a, b) => a.time - b.time || a.lane - b.lane);
  }

  const snapToGrid = (time, step, offset) => Math.max(0, offset + Math.round((time - offset) / step) * step);
  const quantizeDuration = (value, step, minValue, maxValue) => {
    const snapped = Math.round(value / step) * step;
    return clamp(snapped, minValue, maxValue);
  };

  const intervals = [];
  for (let i = 1; i < normalized.length; i++) {
    const gap = normalized[i].time - normalized[i - 1].time;
    if (gap >= 0.08 && gap <= 0.8) {
      intervals.push(gap);
    }
  }

  const gridSize = clamp(median(intervals) || 0.16, 0.085, 0.2);
  const fineGrid = clamp(gridSize / 2, 0.042, 0.11);
  const gridOffset = normalized[0].time;
  const durations = normalized.map((event) => clamp(event.duration || 0.1, 0.05, 1.2));
  const durationCenter = median(durations) || 0.1;
  const chart = [];
  const occupied = new Map();
  const laneAvailableAt = [0, 0, 0, 0];
  const laneCounts = [0, 0, 0, 0];
  const laneHeat = [0, 0, 0, 0];
  let previousLane = -1;
  let previousSide = -1;
  let sameLaneRun = 0;
  let lastHoldTime = -Infinity;
  let previousEventTime = normalized[0].time;

  for (let i = 0; i < normalized.length; i++) {
    const event = normalized[i];
    const prevEvent = normalized[i - 1];
    const coarseSnappedTime = snapToGrid(event.time, gridSize, gridOffset);
    const coarseBucket = coarseSnappedTime.toFixed(3);
    const eventsInBucket = occupied.get(coarseBucket) || [];
    const nearPrevious = chart.length > 0 ? coarseSnappedTime - chart[chart.length - 1].time : Infinity;
    const deltaTime = Math.max(0.02, event.time - previousEventTime);
    const heatDecay = Math.exp(-deltaTime / 0.42);
    for (let laneIndex = 0; laneIndex < 4; laneIndex++) {
      laneHeat[laneIndex] *= heatDecay;
    }
    previousEventTime = event.time;

    const duration = clamp(event.duration || 0.1, 0.05, 1.2);
    const strength = clamp(event.strength || duration / Math.max(durationCenter, 0.05), 0.35, 1.6);
    const prevGap = prevEvent ? Math.max(0.02, event.time - prevEvent.time) : Infinity;
    const next = normalized[i + 1];
    const nextGap = next ? Math.max(0.02, next.time - event.time) : Infinity;
    const localGap = Math.min(prevGap, nextGap);
    const densityFactor = clamp(gridSize / Math.max(localGap, 0.045), 0.55, 2.8);
    const weakNote = strength < 0.72 && duration < durationCenter * 1.05;

    if (nearPrevious < Math.max(0.05, fineGrid * 0.68) && weakNote && eventsInBucket.length === 0) {
      continue;
    }

    const preferredSnap = localGap < gridSize * 0.7 ? fineGrid : gridSize;
    const snappedTime = snapToGrid(event.time, preferredSnap, gridOffset);
    const snappedBucket = snappedTime.toFixed(3);
    const snappedEvents = occupied.get(snappedBucket) || eventsInBucket;

    const fallbackLane = Number.isInteger(event.lane) ? event.lane : getLaneFromPitch(event.pitch);
    const anchorLane = getPitchAnchorLane(event.pitch);
    const melodicDirection = prevEvent ? clamp(event.pitch - prevEvent.pitch, -12, 12) : 0;
    const directionalPreference = melodicDirection === 0 ? 0 : melodicDirection > 0 ? 1 : -1;
    const laneNoise = [rng() * 0.04, rng() * 0.04, rng() * 0.04, rng() * 0.04];
    let lane = fallbackLane;
    const preferredLane = lane;

    if (lane === previousLane) {
      sameLaneRun++;
      if (sameLaneRun >= 2) {
        lane = (lane + 1 + (i % 2)) % 4;
        sameLaneRun = 0;
      }
    } else {
      sameLaneRun = 0;
    }

    const laneOrder = [lane, (lane + 1) % 4, (lane + 3) % 4, (lane + 2) % 4].sort((a, b) => {
      const aDirectionalPenalty =
        previousLane >= 0 && directionalPreference !== 0 ? ((directionalPreference > 0 && a < previousLane) || (directionalPreference < 0 && a > previousLane) ? 1.05 : 0) : 0;
      const bDirectionalPenalty =
        previousLane >= 0 && directionalPreference !== 0 ? ((directionalPreference > 0 && b < previousLane) || (directionalPreference < 0 && b > previousLane) ? 1.05 : 0) : 0;
      const aSide = a < 2 ? 0 : 1;
      const bSide = b < 2 ? 0 : 1;
      const aPenalty =
        (snappedEvents.includes(a) ? 100 : 0) +
        (laneAvailableAt[a] > snappedTime ? 20 : 0) +
        laneCounts[a] * 0.14 +
        laneHeat[a] * 1.15 +
        (a === previousLane ? 1.18 : 0) +
        (previousSide === aSide ? 0.18 : 0) +
        Math.abs(a - preferredLane) * 0.08 +
        Math.abs(a - anchorLane) * 0.76 +
        laneNoise[a] +
        aDirectionalPenalty;
      const bPenalty =
        (snappedEvents.includes(b) ? 100 : 0) +
        (laneAvailableAt[b] > snappedTime ? 20 : 0) +
        laneCounts[b] * 0.14 +
        laneHeat[b] * 1.15 +
        (b === previousLane ? 1.18 : 0) +
        (previousSide === bSide ? 0.18 : 0) +
        Math.abs(b - preferredLane) * 0.08 +
        Math.abs(b - anchorLane) * 0.76 +
        laneNoise[b] +
        bDirectionalPenalty;
      return aPenalty - bPenalty;
    });
    lane = laneOrder[0];

    if (snappedEvents.includes(lane)) {
      lane = [0, 1, 2, 3].find((candidate) => !snappedEvents.includes(candidate));
      if (lane === undefined) {
        continue;
      }
    }

    const canUseLane = laneAvailableAt[lane] <= snappedTime;
    const melodicStability = prevEvent && next ? 1 - clamp((Math.abs(event.pitch - prevEvent.pitch) + Math.abs(next.pitch - event.pitch)) / 24, 0, 1) : 0.6;
    const sustainFromDuration = clamp((duration - Math.max(0.16, durationCenter * 1.1)) / Math.max(0.2, durationCenter * 2.2), 0, 1);
    const transientPenalty = clamp((densityFactor - 1.15) * 0.42, 0, 0.58) + (Math.abs(melodicDirection) >= 9 ? 0.15 : 0);
    const sustainScore = clamp(sustainFromDuration * 0.62 + melodicStability * 0.28 + (strength > 1.05 ? 0.12 : 0) - transientPenalty, 0, 1);
    const minHoldDuration = Math.max(0.26, preferredSnap * 2.2);
    const holdMaxDuration = Number.isFinite(nextGap) ? Math.min(1.85, Math.max(minHoldDuration + 0.08, nextGap + preferredSnap * (sustainScore > 0.7 ? 1.7 : 1.05))) : 1.85;
    const holdCandidateDuration = quantizeDuration(duration * (0.9 + sustainScore * 0.8), fineGrid, minHoldDuration, holdMaxDuration);
    const denseWindow = nearPrevious < Math.max(0.105, gridSize * 0.78) || nextGap < Math.max(0.115, gridSize * 0.82);
    const isHold = canUseLane && sustainScore >= 0.4 && !denseWindow && snappedTime - lastHoldTime > Math.max(0.2, gridSize * 1.25) && holdCandidateDuration >= minHoldDuration;
    const playableDuration = isHold ? Number(holdCandidateDuration.toFixed(3)) : 0.1;
    chart.push({
      time: Number(snappedTime.toFixed(3)),
      duration: playableDuration,
      pitch: Math.round(event.pitch),
      lane,
      strength: Number(strength.toFixed(2)),
      type: isHold ? "hold" : "tap",
    });

    snappedEvents.push(lane);
    laneCounts[lane]++;
    laneHeat[lane] += isHold ? 1.1 : 1;
    laneAvailableAt[lane] = snappedTime + playableDuration + (isHold ? 0.06 : Math.max(0.105, preferredSnap * 1.05));
    if (isHold) {
      lastHoldTime = snappedTime;
    }

    const chordIntent = clamp((strength - 0.76) * 0.9 + (densityFactor - 1) * 0.3 + (nextGap < gridSize * 1.35 ? 0.1 : 0), 0, 0.55);
    const canAddChord = snappedEvents.length < 2 && nearPrevious > Math.max(0.11, preferredSnap * 1.0) && !isHold && rng() < chordIntent;
    if (canAddChord) {
      const chordLane = [3 - lane, (lane + 2) % 4, (lane + 1) % 4, (lane + 3) % 4].find(
        (candidate) => !snappedEvents.includes(candidate) && laneAvailableAt[candidate] <= snappedTime && Math.abs(candidate - lane) >= 1,
      );
      if (chordLane !== undefined) {
        chart.push({
          time: Number(snappedTime.toFixed(3)),
          duration: 0.1,
          pitch: Math.round(next.pitch || event.pitch),
          lane: chordLane,
          strength: Number(clamp(strength * 0.9, 0.35, 1.4).toFixed(2)),
          type: "tap",
        });
        snappedEvents.push(chordLane);
        laneCounts[chordLane]++;
        laneHeat[chordLane] += 0.8;
        laneAvailableAt[chordLane] = snappedTime + Math.max(0.1, preferredSnap * 1.05);

        const canAddTriple = chordIntent >= 0.44 && snappedEvents.length < 3 && rng() < 0.18;
        if (canAddTriple) {
          const tripleLane = [0, 1, 2, 3].find((candidate) => !snappedEvents.includes(candidate) && laneAvailableAt[candidate] <= snappedTime);
          if (tripleLane !== undefined) {
            chart.push({
              time: Number(snappedTime.toFixed(3)),
              duration: 0.1,
              pitch: Math.round(event.pitch),
              lane: tripleLane,
              strength: Number(clamp(strength * 0.82, 0.35, 1.2).toFixed(2)),
              type: "tap",
            });
            snappedEvents.push(tripleLane);
            laneCounts[tripleLane]++;
            laneHeat[tripleLane] += 0.65;
            laneAvailableAt[tripleLane] = snappedTime + Math.max(0.1, preferredSnap * 1.0);
          }
        }
      }
    }

    occupied.set(snappedBucket, snappedEvents);
    previousLane = lane;
    previousSide = lane < 2 ? 0 : 1;
  }

  chart.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return enhanceManiaChart(chart, rng, gridSize, fineGrid);
}

function enhanceManiaChart(chart, rng, gridSize, fineGrid) {
  if (!Array.isArray(chart) || chart.length === 0) return [];
  const sorted = [...chart].sort((a, b) => a.time - b.time || a.lane - b.lane);
  const offset = sorted[0].time;
  const snap = (time, step) => Math.max(0, offset + Math.round((time - offset) / step) * step);
  const keyOf = (time) => Number(time.toFixed(3)).toFixed(3);
  const occupied = new Map();

  for (const note of sorted) {
    const key = keyOf(note.time);
    if (!occupied.has(key)) occupied.set(key, new Set());
    occupied.get(key).add(note.lane);
  }

  const nextSameLaneWindow = new Array(sorted.length).fill(Infinity);
  const nextLaneTime = [Infinity, Infinity, Infinity, Infinity];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const lane = sorted[i].lane;
    nextSameLaneWindow[i] = nextLaneTime[lane] - sorted[i].time;
    nextLaneTime[lane] = sorted[i].time;
  }

  const additions = [];

  for (let i = 0; i < sorted.length; i++) {
    const note = sorted[i];
    const next = sorted[i + 1];
    const nextGap = next ? next.time - note.time : Infinity;

    if (note.type === "tap") {
      const holdWindow = nextSameLaneWindow[i];
      const holdChance = clamp(0.09 + (note.strength - 0.82) * 0.24 + (holdWindow > 0.56 ? 0.13 : 0), 0.07, 0.34);
      if (holdWindow > 0.3 && rng() < holdChance) {
        const maxLen = Math.min(1.05, holdWindow - 0.08);
        if (maxLen >= 0.24) {
          note.type = "hold";
          note.duration = Number(clamp(snap(maxLen * 0.58, fineGrid), 0.24, maxLen).toFixed(3));
        }
      }

      const chordChance = clamp(0.12 + (note.strength - 0.85) * 0.3 + (nextGap < gridSize * 1.4 ? 0.07 : 0), 0.08, 0.36);
      if (rng() < chordChance) {
        const key = keyOf(note.time);
        const atTime = occupied.get(key) || new Set();
        if (atTime.size < 2) {
          const pref = [3 - note.lane, (note.lane + 2) % 4, (note.lane + 1) % 4, (note.lane + 3) % 4];
          const lane = pref.find((candidate) => !atTime.has(candidate));
          if (lane !== undefined) {
            const chordNote = {
              time: note.time,
              duration: 0.1,
              pitch: note.pitch,
              lane,
              strength: Number(clamp(note.strength * 0.86, 0.35, 1.25).toFixed(2)),
              type: "tap",
            };
            additions.push(chordNote);
            atTime.add(lane);
            occupied.set(key, atTime);
          }
        }
      }
    }
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const gap = next.time - current.time;
    if (gap <= Math.max(0.34, gridSize * 2.1)) continue;

    const fillerCount = gap > 0.62 ? 2 : 1;
    for (let j = 1; j <= fillerCount; j++) {
      const t = Number(snap(current.time + (gap * j) / (fillerCount + 1), fineGrid).toFixed(3));
      if (t <= current.time + 0.05 || t >= next.time - 0.05) continue;

      const key = keyOf(t);
      const atTime = occupied.get(key) || new Set();
      if (atTime.size >= 2) continue;

      const preferred = [(current.lane + 1) % 4, (current.lane + 3) % 4, 3 - current.lane, next.lane];
      const lane = preferred.find((candidate) => !atTime.has(candidate) && candidate !== current.lane);
      if (lane === undefined) continue;

      additions.push({
        time: t,
        duration: 0.1,
        pitch: Math.round((current.pitch + next.pitch) / 2),
        lane,
        strength: 0.78,
        type: "tap",
      });
      atTime.add(lane);
      occupied.set(key, atTime);
    }
  }

  return sorted.concat(additions).sort((a, b) => a.time - b.time || a.lane - b.lane);
}

function createPlayableBeatmap(rawEvents, mode = "mania", seed = "default-seed") {
  const sourceEvents = Array.isArray(rawEvents) ? rawEvents : [];
  const normalized = sourceEvents
    .map(normalizeBeatEvent)
    .filter((event) => Number.isFinite(event.time) && event.time >= 0)
    .sort((a, b) => a.time - b.time);

  if (normalized.length === 0) {
    return [];
  }

  const rng = createSeededRng(seed);
  return mode === "standard" ? createStandardBeatmap(normalized, rng) : createManiaBeatmap(normalized, rng);
}

// SQLite Database Setup
const dbPath = path.join(dataDir, "osu.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Failed to connect to SQLite:", err.message);
  } else {
    console.log("Connected to SQLite database at", dbPath);
    initializeDatabase();
  }
});

// Helper to extract YouTube video ID or create a hash of URL
function getSongId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  if (match && match[2].length === 11) {
    return match[2];
  }
  // Fallback to MD5 hashing if not a standard YouTube link
  const crypto = require("crypto");
  return crypto.createHash("md5").update(url).digest("hex").substring(0, 11);
}

function isYoutubeUrl(url) {
  if (!url) return false;
  return url.includes("youtube.com") || url.includes("youtu.be");
}

function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      score INTEGER NOT NULL,
      song TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'standard'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cached_songs (
      url TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      beats TEXT NOT NULL
    )`);
  });
}

// API Routes

// 0. List bundled native osu!mania maps copied from local osu cache
app.get("/api/osu/native-mania", (req, res) => {
  const indexPath = path.join(nativeManiaDir, "index.json");
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      const maps = Array.isArray(parsed) ? parsed : [];
      return res.json(
        maps
          .filter((m) => typeof m.file === "string" && m.file.endsWith(".osu"))
          .map((m) => ({
            ...m,
            mapUrl: `/assets/native-mania/${encodeURIComponent(m.file)}`,
          })),
      );
    } catch (err) {
      console.warn("Failed to parse native mania map index:", err.message);
    }
  }

  fs.readdir(nativeManiaDir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: "Failed to read native mania maps." });
    }
    const maps = files
      .filter((f) => f.endsWith(".osu"))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => ({
        file,
        title: file.replace(/\.osu$/i, ""),
        mapUrl: `/assets/native-mania/${encodeURIComponent(file)}`,
      }));
    res.json(maps);
  });
});

// 1. Download & Process Song
app.post("/api/songs/download", (req, res) => {
  const { url, videoId, mode } = req.body;
  if (!url && !videoId) {
    return res.status(400).json({ error: "YouTube URL or Video ID is required" });
  }

  const songId = videoId || getSongId(url);
  const targetUrl = url || `https://www.youtube.com/watch?v=${songId}`;
  const selectedMode = mode === "standard" || mode === "spectrogram" ? mode : "mania";
  const mp3Filename = `${songId}.mp3`;
  const mp3Path = path.join(songDir, mp3Filename);
  const wavPath = path.join(songDir, `${songId}.wav`);
  const relativeAudioUrl = `/assets/songs/${mp3Filename}`;
  const previewFilename = `${songId}_preview30.mp3`;
  const previewPath = path.join(songDir, previewFilename);
  const relativePreviewAudioUrl = `/assets/songs/${previewFilename}`;
  const spectrogramFilename = `${songId}_spectrogram30.png`;
  const spectrogramPath = path.join(songDir, spectrogramFilename);
  const relativeSpectrogramUrl = `/assets/songs/${spectrogramFilename}`;

  // Get Cached Song Title (but bypass cached beats to force regeneration via wav_to_beats.exe)
  db.get(`SELECT title FROM cached_songs WHERE url = ? OR video_id = ?`, [targetUrl, songId], (err, cached) => {
    if (err) {
      console.warn("Database query failed:", err.message);
    }

    const knownTitle = cached ? cached.title : null;

    const handleProcessing = (title) => {
      const runSpectrogramPreviewGeneration = () => {
        const trimCmd = `ffmpeg -y -i "${mp3Path}" -t 30 -c copy "${previewPath}"`;
        exec(trimCmd, (trimErr) => {
          if (trimErr) {
            console.error("FFmpeg preview trim failed:", trimErr.message);
            return res.status(500).json({ error: "Failed to create 30-second preview audio." });
          }

          const spectrogramCmd = `ffmpeg -y -i "${previewPath}" -lavfi "showspectrumpic=s=1280x720:legend=disabled" "${spectrogramPath}"`;
          exec(spectrogramCmd, (spectroErr) => {
            if (spectroErr) {
              console.error("FFmpeg spectrogram generation failed:", spectroErr.message);
              return res.status(500).json({ error: "Failed to generate spectrogram image." });
            }

            db.run(`INSERT OR REPLACE INTO cached_songs (url, video_id, title, beats) VALUES (?, ?, ?, ?)`, [targetUrl, songId, title, JSON.stringify([])], (dbErr) => {
              if (dbErr) {
                console.warn("Failed to cache song metadata in database:", dbErr.message);
              }
            });

            res.json({
              title,
              audioUrl: relativePreviewAudioUrl,
              beats: [],
              spectrogramUrl: relativeSpectrogramUrl,
            });
          });
        });
      };

      const runFfmpegAndBeatDetection = () => {
        // Convert MP3 to 44100Hz WAV for beat detector
        const convertCmd = `ffmpeg -y -i "${mp3Path}" -ar 44100 "${wavPath}"`;
        exec(convertCmd, (err) => {
          if (err) {
            console.error("FFmpeg conversion failed:", err.message);
            return res.status(500).json({ error: "Failed to convert audio file." });
          }

          // Run wav_to_beats.exe
          const beatCmd = `${wavToBeats} "${wavPath}"`;
          exec(beatCmd, (err, stdout) => {
            // Delete temporary WAV file to save space
            if (fs.existsSync(wavPath)) {
              try {
                fs.unlinkSync(wavPath);
              } catch (e) {}
            }

            if (err) {
              console.error("Beat detection failed:", err.message);
              return res.status(500).json({ error: "Failed to detect beats in audio." });
            }

            // Parse raw detector notes (format: start_time duration pitch), then shape them into playable events.
            const rawBeats = stdout
              .split("\n")
              .map((line) => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                  return {
                    time: parseFloat(parts[0]),
                    duration: parseFloat(parts[1]),
                    pitch: parseInt(parts[2], 10),
                    strength: Number.isFinite(parseFloat(parts[3])) ? parseFloat(parts[3]) : undefined,
                  };
                }
                if (parts.length === 1 && Number.isFinite(parseFloat(parts[0]))) {
                  return {
                    time: parseFloat(parts[0]),
                    duration: 0.1,
                    pitch: 60,
                  };
                }
                return null;
              })
              .filter((item) => item !== null);

            const beats = createPlayableBeatmap(rawBeats, selectedMode, songId);
            console.log(`Successfully detected ${rawBeats.length} raw beats and generated ${beats.length} playable ${selectedMode === "standard" ? "standard" : "mania"} notes.`);

            // Save Cache to Database (overwriting previous beats with fresh ones)
            db.run(`INSERT OR REPLACE INTO cached_songs (url, video_id, title, beats) VALUES (?, ?, ?, ?)`, [targetUrl, songId, title, JSON.stringify(beats)], (dbErr) => {
              if (dbErr) {
                console.warn("Failed to cache song in database:", dbErr.message);
              } else {
                console.log(`Cached song in SQLite database: ${title}`);
              }
            });

            res.json({
              title,
              audioUrl: relativeAudioUrl,
              beats,
              spectrogramUrl: null,
            });
          });
        });
      };

      if (fs.existsSync(mp3Path)) {
        console.log(`MP3 file already exists at ${mp3Path}, skipping download.`);
        if (selectedMode === "spectrogram") {
          runSpectrogramPreviewGeneration();
        } else {
          runFfmpegAndBeatDetection();
        }
      } else {
        // Download MP3
        const downloadCmd = `${ytDlp} -x --audio-format mp3 -o "${mp3Path}" "${targetUrl}"`;
        exec(downloadCmd, (err) => {
          if (err) {
            console.error("yt-dlp download failed:", err.message);
            return res.status(500).json({ error: "Failed to download audio." });
          }
          if (selectedMode === "spectrogram") {
            runSpectrogramPreviewGeneration();
          } else {
            runFfmpegAndBeatDetection();
          }
        });
      }
    };

    // Determine Title and handle processing
    if (knownTitle) {
      console.log(`Using cached title: ${knownTitle} (${songId}), regenerating beatmaps...`);
      handleProcessing(knownTitle);
    } else if (isYoutubeUrl(targetUrl)) {
      const titleCmd = `${ytDlp} --simulate --print "%(title)s" "${targetUrl}"`;
      exec(titleCmd, (err, stdout) => {
        const title = err || !stdout ? videoId || "Downloaded Song" : stdout.trim();
        console.log(`Song Title (via yt-dlp): ${title}`);
        handleProcessing(title);
      });
    } else {
      const title = videoId || "Downloaded Song";
      console.log(`Song Title (local/fallback): ${title}`);
      handleProcessing(title);
    }
  });
});

// 1.5 Get Available Local/Downloaded Songs
app.get("/api/songs/local", (req, res) => {
  fs.readdir(songDir, (err, files) => {
    if (err) {
      console.error("Failed to read songs directory:", err.message);
      return res.status(500).json({ error: "Failed to read songs directory." });
    }

    const mp3Files = files.filter((f) => f.endsWith(".mp3") && f !== "key-press-1.mp3" && !f.endsWith("_preview30.mp3"));

    // Fetch all cached songs from database
    db.all(`SELECT url, video_id, title FROM cached_songs`, [], (dbErr, rows) => {
      if (dbErr) {
        console.error("Failed to fetch cached songs:", dbErr.message);
        return res.status(500).json({ error: "Database query failed." });
      }

      const cacheMap = new Map();
      rows.forEach((row) => {
        cacheMap.set(row.video_id, row);
      });

      const songsList = mp3Files.map((filename) => {
        const videoId = filename.replace(".mp3", "");
        const cached = cacheMap.get(videoId);
        return {
          video_id: videoId,
          title: cached ? cached.title : videoId,
          url: cached ? cached.url : null,
          audioUrl: `/assets/songs/${filename}`,
        };
      });

      res.json(songsList);
    });
  });
});

// 2. Fetch Leaderboard Scores
app.get("/api/scores", (req, res) => {
  const query = `SELECT username, score, song, mode FROM scores ORDER BY score DESC LIMIT 50`;
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// 3. Save Score
app.post("/api/scores", (req, res) => {
  const { username, score, song, mode } = req.body;
  if (!username || score === undefined || !song) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const query = `INSERT INTO scores (username, score, song, mode) VALUES (?, ?, ?, ?)`;
  db.run(query, [username, score, song, mode || "standard"], function (err) {
    if (err) {
      console.error("Failed to save score locally:", err.message);
      return res.status(500).json({ error: "Database insertion error" });
    }

    // Forward to remote score database (like original C++ curl call)
    axios
      .post("http://129.151.168.7/scores", {
        username: username,
        score: score,
        song: song,
      })
      .then(() => {
        console.log("Successfully posted score to external remote server.");
      })
      .catch((err) => {
        console.warn("Failed to post score to external server:", err.message);
      });

    res.json({ success: true, id: this.lastID });
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
