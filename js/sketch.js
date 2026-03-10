// ========================
// Pulse Canvas — Sound + Heart Sensor + Keyboard + Voice Analysis + Face Emotion
// Fusion Logic:
// Heart Rate → arousal level (calm → excited → panicked)
// Face → valence (positive/negative) + specific emotion
// Voice → social context + intensity
// Sensor Lost = instant jump when BPM=0 (no stage fade-through)
// ========================

let audioStarted = false;

// --- HEART ---
let bpm = 70;           // displayed BPM (snaps to valid readings)
let bpmTarget = 70;     // last BPM from serial (or keyboard)
let useHeartSensor = false;

// Sensor Lost logic (instant on 0, plus backup timeout)
let sensorLost = false;
let lastGoodBpmMs = 0;
const LOST_AFTER_MS = 600; // if no valid BPM for 0.6s -> lost

// USER CONTROLS
let motionSpeed = 1.0;
let intensity = 1.0;

// SOUND
let mic;
let soundLevel = 0;
let prevSound = 0;
let speechActivity = 0;

// SERIAL (Heart Sensor)
let port;
let reader;
let lineBuffer = "";

// Calm state rain
let calmRain = [];
let calmRainCount = 180;

// Enhanced stress particles
let stressParticles = [];
let shockwaves = [];

// ================= FACE =================
let video;
let detections = null;
let faceEmotion = "neutral";
let faceLoaded = false;

// Expression smoothing (EMA)
let faceExprSmooth = null;
const FACE_SMOOTH_ALPHA = 0.35; // higher = reacts faster, lower = smoother

// Voice Analysis Variables
let voiceAnalysis = {
  volume: 0,
  pitch: 0,
  speechRate: 0,
  lastSpeechTime: 0,
  speechSegments: [],
  isSpeaking: false,
  pitchHistory: [],
  pitchVariance: 0,
  pitchTrend: 0,
  breathiness: 0,
  tension: 0,
  spectralFlux: 0,
  lastSpectrum: null,
  emotionalQualities: {
    excitement: 0,
    calmness: 0,
    stress: 0,
    sadness: 0
  }
};

// FFT for audio analysis
let fft;
let pitchEnergy = 0;

// ================= FUSION (Heart + Face + Voice) =================
let fusion = {
  arousal: "calm",        // calm | neutral | excited | panicked
  arousalLevel: 0,        // 0..1
  valence: "neutral",     // negative | neutral | positive
  valenceScore: 0,        // -1..1
  face: "neutral",        // dominant face emotion
  voiceContext: "silent", // silent | speaking | speaking-fast
  voiceIntensity: 0,      // 0..1
  state: "Neutral"        // Calm | Neutral | Joy | Anxiety | Stress | Panic
};

function computeArousalFromBpm(bpmValue) {
  let arousal, lvl;

  if (bpmValue < 65) {
    arousal = "calm";
    lvl = map(bpmValue, 40, 65, 0.0, 0.25, true);
  } else if (bpmValue < 85) {
    arousal = "neutral";
    lvl = map(bpmValue, 65, 85, 0.25, 0.45, true);
  } else if (bpmValue < 110) {
    arousal = "excited";
    lvl = map(bpmValue, 85, 110, 0.45, 0.75, true);
  } else {
    arousal = "panicked";
    lvl = map(bpmValue, 110, 160, 0.75, 1.0, true);
  }

  return { arousal, lvl: constrain(lvl, 0, 1) };
}

function computeValenceFromFace(exprSmooth, dominant) {
  // If you didn't implement smoothing, exprSmooth may be null — still works.
  if (!exprSmooth) {
    // fallback: valence from label only
    if (dominant === "happy") return { valence: "positive", score: 0.35 };
    if (["sad", "angry", "fearful", "disgusted"].includes(dominant)) return { valence: "negative", score: -0.35 };
    return { valence: "neutral", score: 0 };
  }

  const happy = exprSmooth.happy || 0;
  const neg =
    (exprSmooth.sad || 0) +
    (exprSmooth.angry || 0) +
    (exprSmooth.fearful || 0) +
    (exprSmooth.disgusted || 0);

  let score = constrain(happy - neg * 0.75, -1, 1);

  let valence = "neutral";
  if (score > 0.18) valence = "positive";
  else if (score < -0.18) valence = "negative";

  // Ensure label nudges valence too
  if (dominant === "happy") { valence = "positive"; score = max(score, 0.25); }
  if (["sad", "angry", "fearful", "disgusted"].includes(dominant)) { valence = "negative"; score = min(score, -0.25); }

  return { valence, score };
}

function computeVoiceContextAndIntensity() {
  const speakingNow = voiceAnalysis.isSpeaking && voiceAnalysis.volume > 0.01;

  let voiceContext = "silent";
  if (speakingNow) {
    voiceContext = (voiceAnalysis.speechRate > 45) ? "speaking-fast" : "speaking";
  }

  const v = constrain(voiceAnalysis.volume * 20, 0, 1);
  const ex = voiceAnalysis.emotionalQualities.excitement || 0;
  const st = voiceAnalysis.emotionalQualities.stress || 0;

  let voiceIntensity = constrain(v * 0.6 + ex * 0.45 + st * 0.45, 0, 1);
  return { voiceContext, voiceIntensity };
}

function decideVisualState(arousal, valence, faceDominant, voiceContext, voiceIntensity) {
  const faceThreat = (faceDominant === "fearful" || faceDominant === "angry" || faceDominant === "disgusted");

  if (arousal === "calm") {
    if (valence === "positive") return "Calm";
    if (valence === "negative") return "Neutral";
    return "Calm";
  }

  if (arousal === "neutral") {
    // Surprise "bumps" the neutral band, but only if there's some intensity
    if (faceDominant === "surprised") {
      if (voiceIntensity > 0.3 || voiceContext === "speaking-fast") return "Anxiety";
      return "Joy";
    }

    if (valence === "positive") return "Joy";
    if (valence === "negative") return "Anxiety";
    return "Neutral";
  }

  if (arousal === "excited") {
    if (valence === "positive") return "Joy";
    if (voiceIntensity > 0.55 || faceThreat) return "Stress";
    return "Anxiety";
  }

  // panicked
  if (valence === "positive") {
    if (voiceIntensity > 0.8) return "Panic";
    return "Stress";
  }

  if (voiceIntensity > 0.5 || faceThreat || voiceContext === "speaking-fast") return "Panic";
  return "Stress";
}

function updateFusion() {
  const a = computeArousalFromBpm(bpm);
  const v = computeValenceFromFace(faceExprSmooth, faceEmotion);
  const vc = computeVoiceContextAndIntensity();

  fusion.arousal = a.arousal;
  fusion.arousalLevel = a.lvl;
  fusion.face = faceEmotion;
  fusion.valence = v.valence;
  fusion.valenceScore = v.score;
  fusion.voiceContext = vc.voiceContext;
  fusion.voiceIntensity = vc.voiceIntensity;

  fusion.state = decideVisualState(
    fusion.arousal,
    fusion.valence,
    fusion.face,
    fusion.voiceContext,
    fusion.voiceIntensity
  );
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  background(5, 8, 20);
  smooth();

  textAlign(CENTER);
  textSize(16);

  mic = new p5.AudioIn();

  let connectBtn = createButton("Connect Heart Sensor");
  connectBtn.position(20, 20);
  connectBtn.mousePressed(connectSerial);

  fft = new p5.FFT(0.8, 2048);
  fft.setInput(mic);

  // ---------- FACE (hidden) ----------
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();
  loadFaceAPI();

  for (let i = 0; i < calmRainCount; i++) calmRain.push(createCalmDrop());

  // Initialize stress particles
  for (let i = 0; i < 50; i++) stressParticles.push(createStressParticle());

  lastGoodBpmMs = millis();

  // Hide any p5 sound indicators (renamed from 'style' to avoid confusion)
  let cssEl = document.createElement("style");
  cssEl.innerHTML = `
    .p5-recorder-indicator, .p5-sound-recorder-indicator,
    [class*="p5"][class*="recorder"], [class*="p5"][class*="indicator"] {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
      z-index: -9999 !important;
    }
  `;
  document.head.appendChild(cssEl);
}

// ================= FACE LOAD =================
async function loadFaceAPI() {
  // face-api.js models URL
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);

    faceLoaded = true;
    console.log("Face API Loaded");

    // detect every 0.5s
    setInterval(detectFace, 500);
  } catch (e) {
    console.log("Face API failed to load:", e);
    faceLoaded = false;
    faceEmotion = "neutral";
    faceExprSmooth = null;
  }
}

function smoothExpressions(newExpr) {
  if (!newExpr) return;

  if (!faceExprSmooth) {
    // init smooth object with all common keys
    faceExprSmooth = {
      neutral: newExpr.neutral || 0,
      happy: newExpr.happy || 0,
      sad: newExpr.sad || 0,
      angry: newExpr.angry || 0,
      fearful: newExpr.fearful || 0,
      disgusted: newExpr.disgusted || 0,
      surprised: newExpr.surprised || 0
    };
    return;
  }

  // EMA update
  for (let k in faceExprSmooth) {
    const v = (newExpr[k] !== undefined) ? newExpr[k] : 0;
    faceExprSmooth[k] = lerp(faceExprSmooth[k], v, FACE_SMOOTH_ALPHA);
  }
}

async function detectFace() {
  if (!faceLoaded) return;
  if (!video.elt || video.elt.readyState !== 4) return;

  try {
    detections = await faceapi
      .detectSingleFace(video.elt, new faceapi.SsdMobilenetv1Options())
      .withFaceExpressions();

    if (detections && detections.expressions) {
      // update smoothing
      smoothExpressions(detections.expressions);

      // choose dominant from smoothed expressions for stability
      faceEmotion = getDominantEmotion(faceExprSmooth || detections.expressions);
    } else {
      faceEmotion = "neutral";
      // gently relax smoothing toward neutral if you want
      if (faceExprSmooth) {
        faceExprSmooth.neutral = lerp(faceExprSmooth.neutral, 1, 0.15);
        for (let k in faceExprSmooth) {
          if (k !== "neutral") faceExprSmooth[k] = lerp(faceExprSmooth[k], 0, 0.15);
        }
      }
    }
  } catch (e) {
    faceEmotion = "neutral";
  }
}

function getDominantEmotion(expressions) {
  let maxV = 0;
  let dominant = "neutral";
  for (let emotion in expressions) {
    if (expressions[emotion] > maxV) {
      maxV = expressions[emotion];
      dominant = emotion;
    }
  }
  return dominant;
}

// ================= HELPERS =================
function createCalmDrop() {
  return {
    x: random(-width / 2, width / 2),
    y: random(-height / 2, height / 2),
    len: random(8, 18),
    speed: random(0.3, 1.2),
    drift: random(-0.2, 0.2),
    alpha: random(40, 120),
    thick: random(0.5, 1.2)
  };
}

function createStressParticle() {
  return {
    x: random(-width / 2, width / 2),
    y: random(-height / 2, height / 2),
    vx: random(-2, 2),
    vy: random(-2, 2),
    size: random(3, 15),
    life: random(0.5, 1),
    colorHue: random(0, 20),
    pulseSpeed: random(0.02, 0.05)
  };
}

// ================= AUDIO =================
function startAudio() {
  if (!audioStarted) {
    // browsers usually require a user gesture; still safe to call
    userStartAudio();
    mic.start();
    audioStarted = true;
  }

  fft.analyze();
  let high = fft.getEnergy("treble");
  pitchEnergy = lerp(pitchEnergy, high / 255, 0.1);
}

// Voice Analysis Functions
function analyzeVoice() {
  let spectrum = fft.analyze();

  // Volume
  voiceAnalysis.volume = mic.getLevel();

  // Pitch (centroid estimate)
  let pitch = fft.getCentroid();
  voiceAnalysis.pitch = pitch;

  // Pitch history for variance
  voiceAnalysis.pitchHistory.push(pitch);
  if (voiceAnalysis.pitchHistory.length > 50) voiceAnalysis.pitchHistory.shift();

  // Calculate pitch variance + trend
  if (voiceAnalysis.pitchHistory.length > 10) {
    let avg =
      voiceAnalysis.pitchHistory.reduce((a, b) => a + b, 0) /
      voiceAnalysis.pitchHistory.length;
    let variance =
      voiceAnalysis.pitchHistory.reduce((a, b) => a + Math.pow(b - avg, 2), 0) /
      voiceAnalysis.pitchHistory.length;
    voiceAnalysis.pitchVariance = Math.sqrt(variance) / (avg + 0.01);

    let recent = voiceAnalysis.pitchHistory.slice(-10);
    if (recent.length >= 10) {
      let firstHalf = recent.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      let secondHalf = recent.slice(5).reduce((a, b) => a + b, 0) / 5;
      voiceAnalysis.pitchTrend = (secondHalf - firstHalf) / (firstHalf + 0.01);
    }
  }

  // Speech rate detection
  let currentTime = millis();
  let amplitude = mic.getLevel();
  let speechThreshold = 0.01;

  if (amplitude > speechThreshold && !voiceAnalysis.isSpeaking) {
    voiceAnalysis.isSpeaking = true;
    voiceAnalysis.lastSpeechTime = currentTime;
  } else if (amplitude < speechThreshold && voiceAnalysis.isSpeaking) {
    voiceAnalysis.isSpeaking = false;
    let speechDuration = currentTime - voiceAnalysis.lastSpeechTime;

    if (speechDuration > 200) {
      voiceAnalysis.speechSegments.push({
        duration: speechDuration,
        time: currentTime
      });

      voiceAnalysis.speechSegments = voiceAnalysis.speechSegments.filter(
        (s) => currentTime - s.time < 30000
      );
    }
  }

  // Calculate speech rate
  if (voiceAnalysis.speechSegments.length > 0) {
    let recentSegments = voiceAnalysis.speechSegments.filter(
      (s) => currentTime - s.time < 10000
    );
    voiceAnalysis.speechRate = recentSegments.length * 6;
  } else {
    voiceAnalysis.speechRate = 0;
  }

  // Voice quality metrics
  let lowFreq = fft.getEnergy(20, 500);
  let highFreq = fft.getEnergy(2000, 8000);
  if (lowFreq > 0) voiceAnalysis.breathiness = highFreq / lowFreq;

  if (amplitude > speechThreshold) {
    let midFreq = fft.getEnergy(500, 2000);
    if (midFreq > 0) voiceAnalysis.tension = highFreq / midFreq;
  } else {
    voiceAnalysis.tension = lerp(voiceAnalysis.tension, 0, 0.05);
  }

  // Spectral flux
  if (voiceAnalysis.lastSpectrum) {
    let flux = 0;
    for (let i = 0; i < spectrum.length; i++) {
      flux += Math.abs(spectrum[i] - voiceAnalysis.lastSpectrum[i]);
    }
    voiceAnalysis.spectralFlux = flux / spectrum.length / 255;
  }
  voiceAnalysis.lastSpectrum = [...spectrum];

  // Map to emotional qualities
  voiceAnalysis.emotionalQualities.excitement = constrain(
    voiceAnalysis.pitchVariance * 2 +
      max(0, voiceAnalysis.pitchTrend) * 3 +
      voiceAnalysis.speechRate / 100,
    0,
    1
  );

  voiceAnalysis.emotionalQualities.calmness = constrain(
    (1 - voiceAnalysis.pitchVariance) * 1.5 +
      (1 - voiceAnalysis.speechRate / 150) * 0.8 +
      (1 - voiceAnalysis.tension),
    0,
    1
  );

  voiceAnalysis.emotionalQualities.stress = constrain(
    voiceAnalysis.tension * 2 +
      voiceAnalysis.spectralFlux * 2 +
      (voiceAnalysis.pitch > 300 ? 0.3 : 0),
    0,
    1
  );

  voiceAnalysis.emotionalQualities.sadness = constrain(
    (1 - voiceAnalysis.pitchVariance) * 1.2 +
      max(0, -voiceAnalysis.pitchTrend) * 2 +
      voiceAnalysis.breathiness * 0.5,
    0,
    1
  );
}

// ================= SERIAL =================
async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("Web Serial API not supported. Use Chrome or Edge.");
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable);
    reader = decoder.readable.getReader();

    useHeartSensor = true;
    sensorLost = false;
    lastGoodBpmMs = millis();

    readLoop();
  } catch (err) {
    alert("Serial connection failed");
  }
}

async function readLoop() {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) handleIncoming(value);
  }
}

function handleIncoming(chunk) {
  lineBuffer += chunk;
  let lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop();

  for (let line of lines) {
    let v = parseInt(line.trim());
    if (isNaN(v)) continue;

    useHeartSensor = true;

    // instant lost
    if (v === 0) {
      bpmTarget = 0;
      sensorLost = true;
      return;
    }

    if (v > 20 && v < 220) {
      bpmTarget = v;
      bpm = v;
      sensorLost = false;
      lastGoodBpmMs = millis();
    }
  }
}

// ================= DRAW =================
function draw() {
  background(5, 8, 20, 40);
  fill(10, 20, 40, 15);
  rect(0, 0, width, height);

  startAudio();
  analyzeVoice();

  // --- SOUND LEVEL ---
  let rawSound = mic.getLevel();
  let amplified = rawSound * 25;
  soundLevel = lerp(soundLevel, amplified, 0.1);
  soundLevel = constrain(soundLevel, 0, 4);

  // --- SPEECH SPEED ---
  let delta = abs(soundLevel - prevSound);
  speechActivity = lerp(speechActivity, delta * 12, 0.15);
  speechActivity = constrain(speechActivity, 0, 3);
  prevSound = soundLevel;

  // --- INTENSITY ---
  intensity = lerp(intensity, map(soundLevel, 0, 2, 0.6, 1.8), 0.1);

  // --- SPEED BLEND ---
  let soundSpeed = map(soundLevel, 0, 2, 0.8, 2.5);
  let speechSpeed = map(speechActivity, 0, 3, 0.6, 3.5);
  let speed = motionSpeed * lerp(soundSpeed, speechSpeed, 0.65);

  // Backup: if we stop receiving valid BPM for a bit, consider lost
  if (useHeartSensor && millis() - lastGoodBpmMs > LOST_AFTER_MS) {
    sensorLost = true;
    bpmTarget = 0;
  }

  // ✅ moved later (after audio-derived values update)
  updateFusion();

  translate(width / 2, height / 2);
  
  drawHeartLayer(speed);
  drawVoiceLayer(speed);
  drawFaceLayer(speed);

  // IMPORTANT: if sensorLost, DO NOT evaluate fusion stages
  if (sensorLost) {
    drawSensorLost(speed);
  } else {
    const label = fusion.state;

    // voice intensity = social intensity (affects motion speed)
    speed *= lerp(0.9, 1.6, fusion.voiceIntensity);

    if (label === "Calm") drawCalm(speed);
    else if (label === "Neutral") drawNeutral(speed);
    else if (label === "Joy") drawJoy(speed);
    else if (label === "Anxiety") drawAnxiety(speed);
    else if (label === "Stress") drawStress(speed);
    else drawPanic(speed);
  }

  drawLabel();
  drawSoundLevelBar();
}

// ================= INPUT =================
function keyPressed() {
  // Keyboard only when heart sensor is not providing data
  if (!useHeartSensor) {
    if (key === "1") { bpm = 60; bpmTarget = 60; }
    if (key === "2") { bpm = 72; bpmTarget = 72; }
    if (key === "3") { bpm = 88; bpmTarget = 88; }
    if (key === "4") { bpm = 102; bpmTarget = 102; }
    if (key === "5") { bpm = 120; bpmTarget = 120; }
    if (key === "6") { bpm = 135; bpmTarget = 135; }
  }

  startAudio();

  if (key === "a" || key === "A") motionSpeed = max(0.2, motionSpeed - 0.1);
  if (key === "d" || key === "D") motionSpeed = min(2.0, motionSpeed + 0.1);
}

// ================= VISUAL STATES =================

// 🟦 ENHANCED CALM - Peaceful but more dynamic
function drawCalm(speed) {
  push();

  let t = frameCount * 0.005 * speed;

  // Use voice analysis to affect calm state
  let calmIntensity = map(bpm, 40, 65, 0.8, 1.4) * (1 - speechActivity * 0.15);

  // Voice affects the calmness - more tension = less calm visuals
  let voiceCalmFactor = 1 - voiceAnalysis.emotionalQualities.stress * 0.3;
  calmIntensity *= voiceCalmFactor;

  // Calm color palette
  let colors = {
    deep: color(60, 100, 170, 40),
    mid: color(100, 150, 200, 60),
    light: color(150, 200, 240, 80),
    accent: color(180, 220, 255, 100),
    glow: color(120, 180, 240, 30)
  };

  // Breathiness adds more mist/fog
  let mistIntensity = 1 + voiceAnalysis.breathiness * 2;

  // Moving gradient background
  push();
  for (let i = 0; i < 8; i++) {
    let gradientX = sin(t * 0.5 + i) * 100;
    let gradientY = cos(t * 0.3 + i) * 80;
    let gradientSize = width * (0.9 - i * 0.08) + sin(t * 2 + i) * 30;
    let alpha = map(i, 0, 8, 8, 25);
    fill(colors.deep.levels[0], colors.deep.levels[1], colors.deep.levels[2], alpha);
    noStroke();
    ellipse(gradientX, gradientY, gradientSize, gradientSize);
  }
  pop();

  // Flowing ribbon trails - affected by speech rate
  push();
  noFill();
  strokeWeight(1.5);
  let ribbonCount = 12 + floor(voiceAnalysis.speechRate / 10);
  for (let r = 0; r < ribbonCount; r++) {
    let ribbonSpeed = t * 1.5 + r * 0.5;
    let alpha = map(r, 0, ribbonCount, 60, 15);
    stroke(colors.mid.levels[0], colors.mid.levels[1], colors.mid.levels[2], alpha);

    beginShape();
    for (let x = -width / 2; x < width / 2; x += 15) {
      let y =
        sin(x * 0.03 + ribbonSpeed) * 150 * calmIntensity +
        cos(x * 0.02 + ribbonSpeed * 0.8) * 80 * calmIntensity;
      vertex(x, y);
    }
    endShape();
  }
  pop();

  // Spinning mandala-like pattern
  push();
  translate(sin(t * 0.7) * 50, cos(t * 0.5) * 50);
  rotate(t * 0.3);

  for (let i = 0; i < 16; i++) {
    let angle = (TWO_PI / 16) * i;
    let radius = 120 + sin(t * 3 + i) * 40 * calmIntensity;
    let x = cos(angle) * radius;
    let y = sin(angle) * radius;

    let circleSize = 8 + sin(t * 5 + i) * 4;

    for (let g = 2; g > 0; g--) {
      fill(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], 60 - g * 20);
      noStroke();
      ellipse(x, y, circleSize * g, circleSize * g);
    }

    if (i % 3 == 0) {
      let nextI = (i + 4) % 16;
      let nextAngle = (TWO_PI / 16) * nextI;
      let nextRadius = 120 + sin(t * 3 + nextI) * 40;
      let nextX = cos(nextAngle) * nextRadius;
      let nextY = sin(nextAngle) * nextRadius;

      stroke(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], 30);
      strokeWeight(0.5);
      line(x, y, nextX, nextY);
    }
  }
  pop();

  // Enhanced rain
  let density = map(speechActivity, 0, 3, 0.6, 1.4);
  let rainSpeed = speed * map(bpm, 40, 65, 0.4, 1.0) * 1.5;

  for (let d of calmRain) {
    let depth = map(d.y, -height / 2, height / 2, 0, 1);
    let blueHue = lerp(colors.deep.levels[1], colors.light.levels[1], depth);

    let tensionEffect = 1 + voiceAnalysis.tension * 2;
    let alpha = d.alpha * (0.7 + 0.3 * sin(t * 3 * tensionEffect + d.x * 0.1));

    stroke(colors.mid.levels[0], blueHue, colors.mid.levels[2], alpha);
    strokeWeight(d.thick * (0.8 + 0.4 * sin(t * 4 * tensionEffect + d.x)));

    line(
      d.x,
      d.y,
      d.x + d.drift * 6 + sin(t * 2 * tensionEffect + d.y * 0.1) * 3,
      d.y + d.len * (0.9 + 0.2 * sin(t * 5))
    );

    stroke(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], alpha * 0.3);
    line(
      d.x - 1,
      d.y + 2,
      d.x - 1 + d.drift * 5 + cos(t * 2 * tensionEffect + d.y * 0.1) * 2,
      d.y + d.len * 0.8
    );

    d.y += d.speed * rainSpeed * density * 1.2 * (1 + voiceAnalysis.tension);
    d.x += d.drift * 0.15 * calmIntensity;

    if (d.y > height / 2) {
      d.y = -height / 2;
      d.x = random(-width / 2, width / 2);
      d.len = random(10, 30);
      d.speed = random(0.4, 1.5);
      d.drift = random(-0.3, 0.3);
    }
  }

  // Swirling mist
  push();
  noStroke();
  let mistCount = 40 * mistIntensity;
  for (let i = 0; i < mistCount; i++) {
    let mistX = noise(i, t * 0.2) * width - width / 2;
    let mistY = noise(i + 50, t * 0.15) * height - height / 2;
    let mistSize = noise(i + 100, t * 0.3) * 60 + 20;
    let mistAlpha = noise(i + 150, t * 0.1) * 40;

    fill(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], mistAlpha);
    ellipse(mistX, mistY, mistSize);
  }
  pop();

  // Floating bubbles
  push();
  noStroke();
  let bubbleCount = 25;
  for (let i = 0; i < bubbleCount; i++) {
    let bubblePhase = (t * 2 + i * 10) % height;
    let bubbleX = noise(i, t * 0.5) * width - width / 2;
    let bubbleY = -height / 2 + bubblePhase;
    let bubbleSize = noise(i + 200, t * 0.2) * 15 + 5;
    let bubbleAlpha = noise(i + 250, t * 0.1) * 80;

    fill(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], bubbleAlpha);
    ellipse(bubbleX, bubbleY, bubbleSize);

    fill(255, 255, 255, bubbleAlpha * 0.5);
    ellipse(bubbleX - 2, bubbleY - 2, bubbleSize * 0.3);
  }
  pop();

  // Pulsing energy waves
  push();
  noFill();
  strokeWeight(1);
  let wavePulse = sin(t * 4 * (1 + voiceAnalysis.pitchVariance)) * 0.5 + 0.5;
  for (let w = 0; w < 3; w++) {
    let waveRadius = 150 + w * 80 + sin(t * 3 + w) * 40;
    stroke(colors.mid.levels[0], colors.mid.levels[1], colors.mid.levels[2], 30 * wavePulse);
    ellipse(sin(t * 1.5) * 60, cos(t * 1.2) * 60, waveRadius);
  }
  pop();

  // Occasional sparkle
  if (random() < 0.03 + voiceAnalysis.emotionalQualities.excitement * 0.05) {
    push();
    let sparkleX = random(-width / 2.5, width / 2.5);
    let sparkleY = random(-height / 2.5, height / 2.5);
    for (let s = 3; s > 0; s--) {
      fill(255, 255, 255, 60 - s * 15);
      noStroke();
      ellipse(sparkleX, sparkleY, 25 * s, 25 * s);
    }
    pop();
  }

  // Gentle breathing effect
  let breathScale = 1.0 + sin(t * 3) * 0.01;
  scale(breathScale);

  pop();
}

// ⚪ NEUTRAL
function drawNeutral(speed) {
  noFill();

  let tensionColor = lerpColor(
    color(180, 200, 220, 100),
    color(200, 180, 180, 100),
    voiceAnalysis.tension
  );

  stroke(tensionColor);
  push();
  rotate(frameCount * 0.002 * speed);
  ellipse(0, 0, 260);
  ellipse(0, 0, 220);
  pop();
}

// 🟡 JOY
function drawJoy(speed) {
  push();
  blendMode(ADD);

  let t = frameCount * 0.01 * speed;
  let bpmBoost = map(bpm, 80, 95, 0.8, 1.6, true);

  let colors = {
    primary: color(255, 220, 100, 200),
    secondary: color(255, 180, 120, 180),
    accent: color(255, 240, 160, 220),
    sparkle: color(255, 255, 200, 255),
    glow: color(255, 200, 100, 140)
  };

  noFill();

  let excitementBoost = 1 + voiceAnalysis.emotionalQualities.excitement * 0.5;
  let joyColor = lerpColor(colors.primary, colors.accent, pitchEnergy * excitementBoost);

  stroke(red(joyColor), green(joyColor), blue(joyColor), 140);

  let tensionFactor = 1 - voiceAnalysis.tension * 0.5;
  strokeWeight((2 + soundLevel * 6) * tensionFactor);

  let coreSize =
    120 +
    sin(t * 2.0 * bpmBoost) * 30 +
    speechActivity * 30 +
    soundLevel * 50 +
    voiceAnalysis.emotionalQualities.excitement * 40;

  ellipse(0, 0, coreSize);

  let ringCount = int(map(speechActivity, 0, 3, 4, 12) + voiceAnalysis.emotionalQualities.excitement * 5);
  for (let i = 0; i < ringCount; i++) {
    let r = coreSize + i * 30 * bpmBoost + sin(t + i) * 12;

    strokeWeight(1.2 * tensionFactor);
    let ringColor = i % 2 == 0 ? colors.primary : colors.secondary;
    stroke(
      red(ringColor),
      green(ringColor),
      blue(ringColor),
      map(i, 0, ringCount, 140, 20)
    );
    ellipse(0, 0, r);
  }

  let particleCount = int(50 + speechActivity * 40 + voiceAnalysis.emotionalQualities.excitement * 50);
  noStroke();
  for (let i = 0; i < particleCount; i++) {
    let angle = TWO_PI * (i / particleCount) + t * 1.4;

    let radius =
      coreSize * 0.6 +
      sin(t * 1.3 + i) * 45 +
      noise(i, t) * 35;

    let rise = (frameCount * 0.4 + i * 20) % height - height / 2;

    let px = cos(angle) * radius;
    let py = sin(angle) * radius - rise * 0.15;

    let size = 3 + soundLevel * 7 + sin(t * 3 + i) * 1.5;

    let particleColor;
    let rand = random();
    if (rand < 0.4) particleColor = colors.primary;
    else if (rand < 0.7) particleColor = colors.secondary;
    else particleColor = colors.accent;

    fill(red(particleColor), green(particleColor), blue(particleColor), 180);
    ellipse(px, py, size);
  }

  let sparkleCount = 25 + floor(voiceAnalysis.emotionalQualities.excitement * 30);
  for (let i = 0; i < sparkleCount; i++) {
    let x = noise(i, t) * width - width / 2;
    let y = noise(i + 100, t * 0.6) * height - height / 2 - frameCount * 0.05;
    let sparkleSize = noise(i, t * 2) * 4 + 1;

    let sparkleColor = i % 3 == 0 ? colors.sparkle : colors.accent;
    fill(red(sparkleColor), green(sparkleColor), blue(sparkleColor), 100);
    ellipse(x, y, sparkleSize);

    if (i % 5 == 0) {
      fill(red(sparkleColor), green(sparkleColor), blue(sparkleColor), 40);
      ellipse(x, y, sparkleSize * 2);
    }
  }

  if (frameCount % (30 - floor(voiceAnalysis.emotionalQualities.excitement * 15)) < 3) {
    push();
    stroke(colors.glow);
    strokeWeight(1);
    let rayCount = 8 + floor(voiceAnalysis.emotionalQualities.excitement * 4);
    for (let i = 0; i < rayCount; i++) {
      let rayAngle = (TWO_PI / rayCount) * i + t * 0.5;
      let rayLength = coreSize * 1.5 + sin(t * 2 + i) * 20;
      line(
        cos(rayAngle) * coreSize * 0.5,
        sin(rayAngle) * coreSize * 0.5,
        cos(rayAngle) * rayLength,
        sin(rayAngle) * rayLength
      );
    }
    pop();
  }

  blendMode(BLEND);
  pop();
}

// 🟣 ANXIETY
function drawAnxiety(speed) {
  push();

  // --- fusion scalars ---
  const vInt = (typeof fusion !== "undefined") ? fusion.voiceIntensity : 0;
  const vCtx = (typeof fusion !== "undefined") ? fusion.voiceContext : "silent";
  const valence = (typeof fusion !== "undefined") ? fusion.valence : "neutral";
  const f = (typeof fusion !== "undefined") ? fusion.face : faceEmotion;

  const speakingBoost = (vCtx === "speaking-fast") ? 1.35 : (vCtx === "speaking") ? 1.18 : 1.0;
  const voiceChaos = 1 + vInt * 1.2;

  const faceThreat = (f === "angry" || f === "fearful" || f === "disgusted") ? 1 : 0;
  const faceSad = (f === "sad") ? 1 : 0;
  const faceSurprise = (f === "surprised") ? 1 : 0;

  let t = frameCount * 0.02 * speed * (0.9 + 0.4 * vInt) * speakingBoost;

  // Heart backbone (arousal)
  let anxietyIntensity = map(bpm, 95, 110, 0.7, 1.5, true) * intensity;

  // Voice tension directly increases anxiety intensity
  anxietyIntensity *= (1 + voiceAnalysis.tension * 2) * voiceChaos;

  // Face valence: negative increases discomfort, positive softens slightly
  if (valence === "negative") anxietyIntensity *= 1.12;
  if (valence === "positive") anxietyIntensity *= 0.92;

  // Pitch variance makes colors shift more rapidly (plus voice intensity)
  let colorShiftSpeed = (1 + voiceAnalysis.pitchVariance * 3) * (1 + vInt * 0.8);

  // Anxiety palette base
  let colors = {
    primary: color(140, 80, 160, 150),
    secondary: color(110, 140, 90, 140),
    accent: color(180, 100, 120, 160),
    flash: color(200, 180, 60, 180),
    dark: color(60, 40, 70, 130)
  };

  // Face steering
  if (faceThreat) {
    colors.primary = lerpColor(colors.primary, color(190, 40, 90, 170), 0.55);
    colors.accent  = lerpColor(colors.accent,  color(255, 40, 120, 180), 0.45);
    colors.flash   = lerpColor(colors.flash,   color(255, 80, 120, 200), 0.35);
  } else if (faceSad) {
    colors.primary = lerpColor(colors.primary, color(90, 90, 170, 160), 0.45);
    colors.dark    = lerpColor(colors.dark,    color(40, 50, 110, 150), 0.35);
  } else if (valence === "positive") {
    colors.flash = lerpColor(colors.flash, color(220, 210, 120, 140), 0.6);
  }

  // Unstable background pulses
  push();
  for (let i = 0; i < 3; i++) {
    let bgPulse = sin(t * 5 * colorShiftSpeed + i) * 0.3 + 0.7;
    let bgX = noise(t * 0.5 + i) * 50 - 25;
    let bgY = noise(t * 0.5 + i + 10) * 50 - 25;
    let bgSize = width * (0.8 + sin(t * 3 * colorShiftSpeed + i) * 0.1);

    const bgAlpha = 40 * bgPulse * (0.85 + 0.45 * vInt) * (valence === "negative" ? 1.1 : 0.95);
    fill(colors.dark.levels[0], colors.dark.levels[1], colors.dark.levels[2], bgAlpha);
    noStroke();
    ellipse(bgX, bgY, bgSize);
  }
  pop();

  // Main jittery rings
  let loopCount = int(map(speechActivity, 0, 3, 5, 12) + voiceAnalysis.pitchVariance * 5 + vInt * 6);
  loopCount = constrain(loopCount, 5, 22);

  // Screen shake
  let shakePower = anxietyIntensity * (1 + voiceAnalysis.tension * 2) * (0.9 + vInt * 1.0) * (1 + faceThreat * 0.35);
  let shakeX = noise(t * 10) * 8 * shakePower - 4 * shakePower;
  let shakeY = noise(t * 10 + 100) * 8 * shakePower - 4 * shakePower;
  translate(shakeX, shakeY);

  for (let i = 0; i < loopCount; i++) {
    push();

    let ringJitterX = noise(t * 8 * colorShiftSpeed + i) * 15 * anxietyIntensity - 7.5;
    let ringJitterY = noise(t * 8 * colorShiftSpeed + i + 50) * 15 * anxietyIntensity - 7.5;
    ringJitterX += (vCtx === "speaking-fast" ? sin(t * 18 + i) * 5 * vInt : 0);
    ringJitterY += (vCtx === "speaking-fast" ? cos(t * 16 + i) * 5 * vInt : 0);
    translate(ringJitterX, ringJitterY);

    let colorShift = sin(t * 3 * colorShiftSpeed + i) * 0.5 + 0.5;
    let ringColor = lerpColor(colors.primary, colors.secondary, colorShift);

    if (valence === "negative") ringColor = lerpColor(ringColor, colors.accent, 0.25);
    if (valence === "positive") ringColor = lerpColor(ringColor, colors.primary, 0.2);

    stroke(red(ringColor), green(ringColor), blue(ringColor), 140 - i * 10);
    strokeWeight((1.5 + soundLevel * 3) * (0.9 + vInt * 0.6));
    noFill();

    beginShape();
    let baseR =
      100 +
      i * 30 +
      sin(t * 4 * colorShiftSpeed + i) * 20 * anxietyIntensity * (1 + faceSurprise * 0.35);
    let phase = t * 3 * colorShiftSpeed + i * 5;

    for (let a = 0; a <= TWO_PI + 0.1; a += 0.1) {
      let noiseWarp1 =
        noise(cos(a) + i, sin(a) + t * 3) *
        50 *
        anxietyIntensity *
        (1 + voiceAnalysis.breathiness) *
        (1 + vInt * 0.6);

      let noiseWarp2 =
        noise(cos(a) * 2 + i + 10, sin(a) * 2 + t * 2) *
        30 *
        anxietyIntensity *
        (1 + faceThreat * 0.35);

      let jitter =
        sin(a * 6 + t * 12 * colorShiftSpeed + i) *
        20 *
        anxietyIntensity *
        (1 + voiceAnalysis.pitchVariance) *
        speakingBoost;

      let breath = sin(t * 2 + a) * 10 * anxietyIntensity;

      let r = baseR + noiseWarp1 + noiseWarp2 + jitter + breath;
      let x = cos(a + phase * 0.1) * r;
      let y = sin(a + phase * 0.1) * r;
      vertex(x, y);
    }
    endShape(CLOSE);

    pop();
  }

  // Crawling lines
  push();
  strokeWeight(1);
  let lineCount = int(15 + speechActivity * 15 + voiceAnalysis.tension * 20 + vInt * 18);
  for (let i = 0; i < lineCount; i++) {
    let linePhase = (t * 5 * colorShiftSpeed + i * 20) % TWO_PI;
    let lineRadius = 80 + i * 15 + sin(t * 8 * colorShiftSpeed + i) * 30 * (1 + vInt);

    let lineColor = i % 3 == 0 ? colors.accent : colors.flash;
    stroke(red(lineColor), green(lineColor), blue(lineColor), 100);

    let startAngle = linePhase;
    let endAngle = linePhase + PI / 2 + sin(t * 4 * colorShiftSpeed + i) * 0.5 * speakingBoost;

    let startX = cos(startAngle) * lineRadius;
    let startY = sin(startAngle) * lineRadius;
    let endX = cos(endAngle) * (lineRadius + 30 * (1 + vInt));
    let endY = sin(endAngle) * (lineRadius + 30 * (1 + vInt));

    startX += noise(t * 15 * colorShiftSpeed + i) * 5 - 2.5;
    startY += noise(t * 15 * colorShiftSpeed + i + 50) * 5 - 2.5;
    endX += noise(t * 15 * colorShiftSpeed + i + 100) * 5 - 2.5;
    endY += noise(t * 15 * colorShiftSpeed + i + 150) * 5 - 2.5;

    line(startX, startY, endX, endY);
  }
  pop();

  // Twitching dots
  push();
  noStroke();
  let dotCount = int(30 + anxietyIntensity * 30 + voiceAnalysis.pitchVariance * 40 + vInt * 45);
  for (let i = 0; i < dotCount; i++) {
    let dotAngle = noise(i, t * 2 * colorShiftSpeed) * TWO_PI * 2;
    let dotRadius = 50 + noise(i + 10, t) * 200 * (1 + vInt * 0.6);
    let dotX = cos(dotAngle + t * 2 * colorShiftSpeed) * dotRadius;
    let dotY = sin(dotAngle + t * 2 * colorShiftSpeed) * dotRadius;

    dotX += sin(t * 30 * colorShiftSpeed + i) * 15 * anxietyIntensity * speakingBoost;
    dotY += cos(t * 30 * colorShiftSpeed + i + 20) * 15 * anxietyIntensity * speakingBoost;

    let dotSize = noise(i + 20, t * 3 * colorShiftSpeed) * 8 + 2;

    let dotColor = (dotX + dotY) % 2 == 0 ? colors.flash : colors.accent;
    fill(red(dotColor), green(dotColor), blue(dotColor), 150);
    ellipse(dotX, dotY, dotSize);

    if (i % 3 == 0) {
      fill(red(dotColor), green(dotColor), blue(dotColor), 50);
      ellipse(dotX - dotSize, dotY - dotSize, dotSize * 0.8);
    }
  }
  pop();

  // Vibrating lines grid
  push();
  stroke(colors.dark, 100);
  strokeWeight(0.8);
  let gridCount = 8;
  for (let i = 0; i < gridCount; i++) {
    let gridPos = map(i, 0, gridCount - 1, -width / 3, width / 3);

    beginShape();
    for (let x = -width / 2; x < width / 2; x += 20) {
      let y =
        gridPos +
        sin(x * 0.02 + t * 8 * colorShiftSpeed) *
          10 *
          anxietyIntensity *
          (1 + voiceAnalysis.spectralFlux) *
          (1 + vInt) +
        noise(x * 0.1, t * 2 * colorShiftSpeed) * 15 * anxietyIntensity;
      vertex(x, y);
    }
    endShape();

    beginShape();
    for (let y = -height / 2; y < height / 2; y += 20) {
      let x =
        gridPos +
        cos(y * 0.02 + t * 8 * colorShiftSpeed) *
          10 *
          anxietyIntensity *
          (1 + voiceAnalysis.spectralFlux) *
          (1 + vInt) +
        noise(y * 0.1, t * 2 * colorShiftSpeed + 10) * 15 * anxietyIntensity;
      vertex(x, y);
    }
    endShape();
  }
  pop();

  // Radial flash
  const flashChance =
    0.1 * anxietyIntensity +
    voiceAnalysis.emotionalQualities.stress * 0.2 +
    (valence === "negative" ? 0.05 : 0) +
    (vCtx === "speaking-fast" ? 0.06 : 0) +
    (faceThreat ? 0.06 : 0);

  if (random() < flashChance) {
    push();
    let flashAlpha = random(10, 30) + voiceAnalysis.tension * 20 + vInt * 30;
    fill(colors.flash.levels[0], colors.flash.levels[1], colors.flash.levels[2], flashAlpha);
    noStroke();
    ellipse(0, 0, width * 0.8, height * 0.8);
    pop();
  }

  // Heartbeat-like spikes
  push();
  stroke(colors.accent, 120);
  strokeWeight(1.5);
  let spikeCount = int(5 + speechActivity * 5 + voiceAnalysis.tension * 10 + vInt * 10);
  for (let i = 0; i < spikeCount; i++) {
    let spikeAngle = (TWO_PI / spikeCount) * i + t * 4 * colorShiftSpeed;
    let spikeBase = 70 + sin(t * 6 * colorShiftSpeed + i) * 20;
    let spikeTip = spikeBase + 100 + soundLevel * 150 + vInt * 140;

    line(
      cos(spikeAngle) * spikeBase,
      sin(spikeAngle) * spikeBase,
      cos(spikeAngle + noise(t * 5 * colorShiftSpeed + i) * 0.2) * spikeTip,
      sin(spikeAngle + noise(t * 5 * colorShiftSpeed + i) * 0.2) * spikeTip
    );
  }
  pop();

  pop();
}

// 🔴 STRESS
function drawStress(speed) {
  push();

  const vInt = (typeof fusion !== "undefined") ? fusion.voiceIntensity : 0;
  const vCtx = (typeof fusion !== "undefined") ? fusion.voiceContext : "silent";
  const valence = (typeof fusion !== "undefined") ? fusion.valence : "neutral";
  const f = (typeof fusion !== "undefined") ? fusion.face : faceEmotion;

  const speakingBoost = (vCtx === "speaking-fast") ? 1.35 : (vCtx === "speaking") ? 1.18 : 1.0;
  const faceThreat = (f === "angry" || f === "fearful" || f === "disgusted") ? 1 : 0;

  let t = frameCount * 0.02 * speed * (1 + vInt * 0.45) * speakingBoost;

  let stressIntensity = map(bpm, 110, 130, 0.4, 1.2, true) * intensity;

  // Voice stress directly affects visual stress
  stressIntensity *= (1 + voiceAnalysis.emotionalQualities.stress) * (1 + vInt * 1.0);

  // Valence steering
  if (valence === "negative") stressIntensity *= 1.12;
  if (valence === "positive") stressIntensity *= 0.92;

  // Pitch variance adds chaos (plus voice intensity)
  let chaosFactor = (1 + voiceAnalysis.pitchVariance * 2) * (1 + vInt * 0.9);

  let colors = {
    primary: color(220, 40, 40, 200),
    secondary: color(180, 20, 20, 150),
    accent: color(255, 100, 100, 180),
    dark: color(100, 20, 20, 100)
  };

  // Face threat makes palette harsher/more violent
  if (faceThreat) {
    colors.primary = lerpColor(colors.primary, color(255, 30, 90, 220), 0.35);
    colors.accent  = lerpColor(colors.accent,  color(255, 160, 160, 210), 0.15);
    colors.dark    = lerpColor(colors.dark,    color(140, 10, 30, 130), 0.35);
  }

  // Background pulsing aura
  push();
  let auraSize = width * (0.8 + sin(t * 3 * chaosFactor) * 0.1 * stressIntensity);
  for (let i = 5; i > 0; i--) {
    let alpha = map(i, 0, 5, 10, 40) * stressIntensity * (0.9 + vInt * 0.6);
    fill(180, 30, 30, alpha);
    noStroke();
    ellipse(0, 0, auraSize * (i / 5), auraSize * (i / 5));
  }
  pop();

  // Electrical storm effect
  push();
  blendMode(ADD);
  strokeWeight(1.5);
  const boltCount = 8 * stressIntensity * (1 + voiceAnalysis.spectralFlux) * (1 + vInt * 0.9) * (faceThreat ? 1.15 : 1.0);
  for (let i = 0; i < boltCount; i++) {
    let angle = random(TWO_PI);
    let startRadius = random(50, 200);
    let endRadius = startRadius + random(100, 300) * stressIntensity * (1 + vInt);

    let startX = cos(angle) * startRadius;
    let startY = sin(angle) * startRadius;
    let endX = cos(angle + random(-0.3, 0.3)) * endRadius;
    let endY = sin(angle + random(-0.3, 0.3)) * endRadius;

    let steps = 10;
    let prevX = startX;
    let prevY = startY;

    for (let j = 1; j <= steps; j++) {
      let progress = j / steps;
      let targetX = lerp(startX, endX, progress);
      let targetY = lerp(startY, endY, progress);

      targetX += random(-10, 10) * stressIntensity * (1 + voiceAnalysis.tension) * speakingBoost;
      targetY += random(-10, 10) * stressIntensity * (1 + voiceAnalysis.tension) * speakingBoost;

      let arcAlpha = map(j, 0, steps, 255, 50) * stressIntensity;
      stroke(255, 100, 100, arcAlpha);

      line(prevX, prevY, targetX, targetY);

      prevX = targetX;
      prevY = targetY;
    }
  }
  blendMode(BLEND);
  pop();

  // Stress particles
  push();
  noStroke();
  const particleTurbulence = (valence === "negative" ? 1.2 : 1.0) * (1 + vInt * 1.0) * (faceThreat ? 1.1 : 1.0);

  for (let particle of stressParticles) {
    particle.x += particle.vx * speed * stressIntensity * (1 + voiceAnalysis.tension) * particleTurbulence;
    particle.y += particle.vy * speed * stressIntensity * (1 + voiceAnalysis.tension) * particleTurbulence;
    particle.life = 0.8 + sin(t * particle.pulseSpeed * chaosFactor) * 0.2;

    if (abs(particle.x) > width / 2) particle.x *= -0.9;
    if (abs(particle.y) > height / 2) particle.y *= -0.9;

    let shimmerX =
      particle.x +
      sin(t * 10 * chaosFactor + particle.y * 0.1) *
        5 *
        stressIntensity *
        (1 + voiceAnalysis.spectralFlux) *
        (1 + vInt);

    let shimmerY =
      particle.y +
      cos(t * 10 * chaosFactor + particle.x * 0.1) *
        5 *
        stressIntensity *
        (1 + voiceAnalysis.spectralFlux) *
        (1 + vInt);

    for (let glow = 2; glow >= 0; glow--) {
      let alpha = glow === 0 ? 180 : 60;
      fill(220, 40, 40, alpha * particle.life);
      ellipse(
        shimmerX,
        shimmerY,
        particle.size * (1 + glow * 0.5) * (1 + vInt * 0.35),
        particle.size * (1 + glow * 0.5) * (1 + vInt * 0.35)
      );
    }

    particle.vx += random(-0.2, 0.2) * stressIntensity * (1 + voiceAnalysis.pitchVariance) * particleTurbulence;
    particle.vy += random(-0.2, 0.2) * stressIntensity * (1 + voiceAnalysis.pitchVariance) * particleTurbulence;

    particle.vx = constrain(particle.vx, -3, 3);
    particle.vy = constrain(particle.vy, -3, 3);
  }
  pop();

  // Pulsing stress rings
  push();
  noFill();
  let ringCount = int(3 + speechActivity * 2 + voiceAnalysis.tension * 3 + vInt * 4);
  for (let i = 0; i < ringCount; i++) {
    let ringPhase = t * 2 * chaosFactor + i;
    let ringSize = 100 + i * 60 + sin(ringPhase) * 20 * stressIntensity;

    beginShape();
    for (let a = 0; a < TWO_PI; a += 0.1) {
      let distortion =
        noise(cos(a) + i, sin(a) + t * chaosFactor) *
        30 *
        stressIntensity *
        (1 + voiceAnalysis.breathiness) *
        (1 + vInt * 0.7);

      let r = ringSize + distortion;
      let x = cos(a + t * chaosFactor) * r;
      let y = sin(a + t * chaosFactor) * r;

      let ringColor = lerpColor(colors.primary, colors.accent, distortion / 50);
      stroke(ringColor);
      strokeWeight((1 + sin(ringPhase) * 0.5) * (0.9 + vInt * 0.6));

      vertex(x, y);
    }
    endShape(CLOSE);
  }
  pop();

  // Blood vessel-like patterns
  push();
  stroke(colors.dark);
  strokeWeight(1);
  let vesselCount = int(6 + speechActivity * 4 + voiceAnalysis.tension * 5 + vInt * 6);
  for (let i = 0; i < vesselCount; i++) {
    let angle = (TWO_PI / vesselCount) * i + t * 0.5 * chaosFactor;
    let startR = 80;
    let endR = 300 + sin(t * 3 * chaosFactor + i) * 50 * (1 + vInt);

    beginShape();
    for (let r = startR; r <= endR; r += 10) {
      let branchAngle = angle + sin(r * 0.05 + t * 5 * chaosFactor) * 0.5 * stressIntensity;
      let x = cos(branchAngle) * r;
      let y = sin(branchAngle) * r;

      strokeWeight(map(r, startR, endR, 3, 0.5));

      let pulseAlpha = map(sin(r * 0.1 + t * 10 * chaosFactor), -1, 1, 100, 200);
      stroke(180, 40, 40, pulseAlpha);

      vertex(x, y);
    }
    endShape();
  }
  pop();

  // Shockwaves
  if (random() < (0.02 * stressIntensity + voiceAnalysis.emotionalQualities.stress * 0.05 + vInt * 0.04 + (vCtx === "speaking-fast" ? 0.03 : 0))) {
    shockwaves.push({
      radius: 50,
      maxRadius: width / 2,
      life: 1.0,
      speed: random(5, 10) * stressIntensity * (1 + voiceAnalysis.spectralFlux) * (1 + vInt)
    });
  }

  // Draw shockwaves
  push();
  noFill();
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    let wave = shockwaves[i];
    wave.radius += wave.speed;
    wave.life -= 0.01;

    if (wave.life <= 0 || wave.radius > wave.maxRadius) {
      shockwaves.splice(i, 1);
      continue;
    }

    stroke(220, 60, 60, 150 * wave.life);
    strokeWeight(2 * wave.life);
    ellipse(0, 0, wave.radius * 2);

    stroke(255, 100, 100, 100 * wave.life);
    strokeWeight(1 * wave.life);
    ellipse(0, 0, wave.radius * 1.8);
  }
  pop();

  // Central core
  push();
  let coreSize =
    40 +
    sin(t * 10 * chaosFactor) * 10 * stressIntensity +
    soundLevel * 30 +
    voiceAnalysis.tension * 50 +
    vInt * 40;

  for (let i = 3; i > 0; i--) {
    let alpha = map(i, 0, 3, 200, 50);
    fill(220, 40, 40, alpha);
    noStroke();
    ellipse(
      sin(t * 15 * chaosFactor) * 5 * stressIntensity,
      cos(t * 13 * chaosFactor) * 5 * stressIntensity,
      coreSize * (i / 3),
      coreSize * (i / 3)
    );
  }
  pop();

  pop();
}

// 🔺 PANIC
function drawPanic(speed) {
  push();

  const vInt = (typeof fusion !== "undefined") ? fusion.voiceIntensity : 0;
  const vCtx = (typeof fusion !== "undefined") ? fusion.voiceContext : "silent";
  const valence = (typeof fusion !== "undefined") ? fusion.valence : "neutral";
  const f = (typeof fusion !== "undefined") ? fusion.face : faceEmotion;

  const speakingBoost = (vCtx === "speaking-fast") ? 1.45 : (vCtx === "speaking") ? 1.22 : 1.0;
  const faceThreat = (f === "angry" || f === "fearful" || f === "disgusted") ? 1 : 0;

  let t = frameCount * 0.03 * speed * (1 + vInt * 0.55) * speakingBoost;

  let panicIntensity = map(bpm, 130, 180, 0.8, 2.0, true) * intensity;

  // Voice panic increases intensity
  panicIntensity *= (1 + voiceAnalysis.emotionalQualities.stress * 1.5) * (1 + vInt * 1.25) * (faceThreat ? 1.12 : 1.0);

  // Panic color palette
  let colors = {
    primary: color(180, 20, 80, 200),
    secondary: color(140, 0, 60, 180),
    accent: color(255, 40, 120, 220),
    flash: color(255, 200, 255, 255),
    dark: color(80, 0, 40, 150)
  };

  // Face steering
  if (faceThreat || valence === "negative") {
    colors.primary = lerpColor(colors.primary, color(255, 20, 70, 230), 0.35);
    colors.accent  = lerpColor(colors.accent,  color(255, 80, 160, 255), 0.25);
    colors.dark    = lerpColor(colors.dark,    color(110, 0, 30, 170), 0.35);
  } else if (valence === "positive") {
    colors.flash = lerpColor(colors.flash, color(255, 255, 255, 255), 0.25);
    colors.accent = lerpColor(colors.accent, color(255, 140, 200, 230), 0.2);
  }

  // Vignette
  push();
  noStroke();
  for (let i = 0; i < 8; i++) {
    let vignetteSize = width * (1.0 - i * 0.08);
    let alpha = map(i, 0, 8, 5, 60) * panicIntensity * (1 + vInt * 0.8);
    fill(40, 0, 20, alpha);
    ellipse(0, 0, vignetteSize, vignetteSize);
  }
  pop();

  // Explosive radial lines
  push();
  blendMode(ADD);
  strokeWeight(1 + soundLevel * 4 * (1 + vInt * 0.6));
  let lineCount = int(20 + panicIntensity * 20 + voiceAnalysis.spectralFlux * 30 + vInt * 35 + (vCtx === "speaking-fast" ? 20 : 0));

  for (let i = 0; i < lineCount; i++) {
    let angle = (TWO_PI / lineCount) * i + t * 3 * (1 + voiceAnalysis.pitchVariance) * (1 + vInt);
    let lengthVar = sin(t * 5 * (1 + voiceAnalysis.pitchVariance) + i) * 100 * panicIntensity * (1 + vInt);
    let baseLength = 400 * panicIntensity * (1 + vInt * 0.6);

    let lineColor;
    let rand = random();
    if (rand < 0.3) lineColor = colors.primary;
    else if (rand < 0.6) lineColor = colors.secondary;
    else lineColor = colors.accent;

    stroke(red(lineColor), green(lineColor), blue(lineColor), 150);

    for (let j = 0; j < 3; j++) {
      let offset = j * 30;
      let startX = cos(angle + j * 0.5) * (50 + offset);
      let startY = sin(angle + j * 0.5) * (50 + offset);
      let endX = cos(angle + j * 0.5) * (baseLength - offset + lengthVar);
      let endY = sin(angle + j * 0.5) * (baseLength - offset + lengthVar);

      line(startX, startY, endX, endY);
    }
  }
  blendMode(BLEND);
  pop();

  // Chaotic particle explosion
  push();
  noStroke();
  let particleCount = int(80 + panicIntensity * 60 + voiceAnalysis.pitchVariance * 80 + vInt * 120);

  for (let i = 0; i < particleCount; i++) {
    let angle = noise(i, t * 2 * (1 + voiceAnalysis.pitchVariance)) * TWO_PI * 4;
    let distance = noise(i + 100, t) * 400 * panicIntensity * (1 + vInt * 0.7);
    let pSize =
      noise(i + 200, t) * 20 * panicIntensity +
      2 +
      voiceAnalysis.tension * 10 +
      vInt * 10;

    let x = cos(angle + t * 5 * (1 + voiceAnalysis.pitchVariance)) * distance;
    let y = sin(angle + t * 5 * (1 + voiceAnalysis.pitchVariance)) * distance;

    x += sin(t * 10 * (1 + voiceAnalysis.spectralFlux) + i) * 50 * (1 + vInt);
    y += cos(t * 8 * (1 + voiceAnalysis.spectralFlux) + i) * 50 * (1 + vInt);

    let rr = 180 + sin(t * 15 + i) * 75;
    let gg = 20 + cos(t * 12 + i) * 40;
    let bb = 80 + sin(t * 18 + i) * 100;

    fill(rr, gg, bb, 150);
    ellipse(x, y, pSize);

    fill(rr, gg, bb, 50);
    ellipse(x - cos(t * 10) * 20, y - sin(t * 10) * 20, pSize * 1.5);
  }
  pop();

  // Pulsing shockwaves
  push();
  noFill();
  let waveCount = 3;
  for (let i = 0; i < waveCount; i++) {
    let wavePhase = (t * 5 * (1 + voiceAnalysis.pitchVariance) + i * 2) % TWO_PI;
    let waveSize = 100 + i * 80 + sin(wavePhase) * 60 * panicIntensity * (1 + vInt);

    stroke(colors.primary, 100 - i * 30);
    strokeWeight(2 + i);
    ellipse(0, 0, waveSize);

    stroke(colors.accent, 60 - i * 20);
    strokeWeight(1 + i);
    ellipse(sin(t * 8) * 20 * (1 + vInt), cos(t * 8) * 20 * (1 + vInt), waveSize * 0.9);
  }
  pop();

  // Distortion grid
  push();
  stroke(colors.dark, 80);
  strokeWeight(0.5);
  let gridSize = 40;
  let distortionAmount = 30 * panicIntensity * (1 + voiceAnalysis.spectralFlux) * (1 + vInt * 1.2);

  for (let x = -width / 2; x < width / 2; x += gridSize) {
    for (let y = -height / 2; y < height / 2; y += gridSize) {
      let distortionX = noise(x * 0.02, y * 0.02, t * (1 + voiceAnalysis.pitchVariance)) * distortionAmount;
      let distortionY = noise(x * 0.02 + 100, y * 0.02 + 100, t * (1 + voiceAnalysis.pitchVariance)) * distortionAmount;

      point(x + distortionX, y + distortionY);

      if (random() < 0.1 + vInt * 0.15) {
        let nextX = x + gridSize + noise(x * 0.02 + 1, y * 0.02, t) * distortionAmount;
        let nextY = y + noise(x * 0.02, y * 0.02 + 1, t) * distortionAmount;
        line(x + distortionX, y + distortionY, nextX, nextY);
      }
    }
  }
  pop();

  // Central core
  push();
  let coreSize =
    60 +
    sin(t * 20 * (1 + voiceAnalysis.pitchVariance)) * 20 * panicIntensity +
    soundLevel * 50 +
    voiceAnalysis.tension * 40 +
    vInt * 50;

  let fragments = 8 + (vCtx === "speaking-fast" ? 6 : 0);

  for (let i = 0; i < fragments; i++) {
    let fragmentAngle = (TWO_PI / fragments) * i + t * 10 * (1 + voiceAnalysis.pitchVariance);
    let fragmentOffset = sin(t * 15 * (1 + voiceAnalysis.pitchVariance) + i) * 30 * panicIntensity * (1 + vInt);

    fill(colors.accent, 200);
    noStroke();
    ellipse(
      cos(fragmentAngle) * fragmentOffset,
      sin(fragmentAngle) * fragmentOffset,
      coreSize / 2,
      coreSize / 2
    );

    fill(colors.flash, 100);
    ellipse(
      cos(fragmentAngle) * fragmentOffset * 0.5,
      sin(fragmentAngle) * fragmentOffset * 0.5,
      coreSize / 3,
      coreSize / 3
    );
  }

  fill(255, 255, 255, 200);
  ellipse(0, 0, 10);
  pop();

  // Audio-reactive spikes
  push();
  stroke(colors.accent, 150);
  strokeWeight(1 + soundLevel * 5 * (1 + vInt * 0.7));
  let spikeCount = int(12 + soundLevel * 20 + voiceAnalysis.tension * 20 + vInt * 30);

  for (let i = 0; i < spikeCount; i++) {
    let angle = (TWO_PI / spikeCount) * i + t * 4 * (1 + voiceAnalysis.pitchVariance);
    let spikeLength =
      100 +
      soundLevel * 200 +
      sin(t * 10 * (1 + voiceAnalysis.pitchVariance) + i) * 50 +
      vInt * 180;

    let x1 = cos(angle) * 30;
    let y1 = sin(angle) * 30;
    let x2 = cos(angle + sin(t * 8 * (1 + voiceAnalysis.pitchVariance) + i) * 0.3) * spikeLength;
    let y2 = sin(angle + sin(t * 8 * (1 + voiceAnalysis.pitchVariance) + i) * 0.3) * spikeLength;

    line(x1, y1, x2, y2);
  }
  pop();

  pop();
}

// ================= BACKGROUND LAYERS (Heart / Voice / Face) =================
// These are subtle overlays that sit BEHIND the fused main state visuals.
// They should NOT interfere with the main visuals.

// ❤️ HEART layer: slow pulse rings + soft glow (uses BPM + arousalLevel)
function drawHeartLayer(speed) {
  push();
  noFill();

  const lvl = (typeof fusion !== "undefined") ? fusion.arousalLevel : map(bpm, 50, 140, 0, 1, true);

  // heartbeat oscillation (stable, not flashy)
  const bpmHz = bpm / 60.0;
  const beat = (sin(frameCount * 0.12 * bpmHz) * 0.5 + 0.5); // 0..1
  const t = frameCount * 0.01;

  const baseR = min(width, height) * 0.14;
  const beatAmp = min(width, height) * (0.01 + lvl * 0.02); // small radial change

  // low alpha so it stays background
  const aMain = 10 + lvl * 14;
  const aSoft = 5 + lvl * 9;

  strokeWeight(0.9);

  // 3 gentle rings
  for (let i = 0; i < 3; i++) {
    const r =
      baseR +
      i * (min(width, height) * 0.07) +
      beat * beatAmp +
      sin(t + i) * 2; // tiny drift

    stroke(255, 170, 200, aMain * (1 - i * 0.18));
    ellipse(0, 0, r * 2);

    stroke(255, 220, 235, aSoft * (1 - i * 0.22));
    ellipse(0, 0, r * 1.85);
  }

  // tiny center tick (like a soft heartbeat marker)
  noStroke();
  const dotA = 8 + lvl * 10;
  fill(255, 210, 230, dotA);
  ellipse(0, 0, 2 + beat * 3);

  pop();
}

// 🎤 VOICE layer: spectral “aurora” arcs + drifting points (uses volume, flux, pitchVariance)
function drawVoiceLayer(speed) {
  push();
  // blendMode(ADD);
  noFill();

  const vInt = (typeof fusion !== "undefined") ? fusion.voiceIntensity : 0;
  const v = constrain(voiceAnalysis.volume * 18, 0, 1); // 0..1
  const speak = voiceAnalysis.isSpeaking ? 1 : 0;

  // Smooth amplitude so it doesn't jitter
  if (drawVoiceLayer._amp === undefined) drawVoiceLayer._amp = 0;
  const targetAmp =
    (vInt * 0.7 + v * 0.6 + constrain(speechActivity / 3, 0, 1) * 0.35) * (0.7 + 0.3 * speak);
  drawVoiceLayer._amp = lerp(drawVoiceLayer._amp, targetAmp, 0.12);

  const amp = drawVoiceLayer._amp; // 0..~1
  const t = frameCount * 0.02 * (0.8 + amp * 1.4);

  // Ring settings (small + low alpha)
  const baseR = min(width, height) * 0.18;     // ring radius
  const wobbleMax = min(width, height) * 0.035; // max radial wobble
  const wobble = wobbleMax * amp;

  // Color / alpha (very light)
  // If you want it even quieter, reduce these alphas by half.
  const a1 = 18 + amp * 25; // main ring alpha
  const a2 = 8 + amp * 16;  // secondary ring alpha

  // Use pitchVariance for texture (small influence)
  const pv = constrain(voiceAnalysis.pitchVariance * 2.5, 0, 1);
  const freq = 5 + pv * 7; // how many waves around the circle

  // Main waveform ring
  stroke(140, 220, 255, a1);
  strokeWeight(1.0);

  beginShape();
  for (let ang = 0; ang <= TWO_PI + 0.001; ang += 0.10) {
    // wave + tiny noise ripple (kept low so it doesn't dominate)
    const wave =
      sin(ang * freq + t * (2.2 + pv * 2.0)) * wobble +
      sin(ang * (freq * 0.5) - t * 1.3) * wobble * 0.35 +
      (noise(cos(ang) + 10, sin(ang) + 10, t * 0.25) - 0.5) * wobble * 0.45;

    const r = baseR + wave;
    vertex(cos(ang) * r, sin(ang) * r);
  }
  endShape(CLOSE);

  // Softer inner ring (stabilizes the look)
  stroke(200, 160, 255, a2);
  strokeWeight(0.8);

  beginShape();
  for (let ang = 0; ang <= TWO_PI + 0.001; ang += 0.14) {
    const wave =
      sin(ang * (freq * 0.8) - t * 1.6) * wobble * 0.45 +
      (noise(cos(ang) + 50, sin(ang) + 50, t * 0.2) - 0.5) * wobble * 0.25;

    const r = baseR * 0.78 + wave;
    vertex(cos(ang) * r, sin(ang) * r);
  }
  endShape(CLOSE);

  // Optional: faint “sweep dot” that orbits faster when speaking-fast
  const vCtx = (typeof fusion !== "undefined") ? fusion.voiceContext : "silent";
  const sweepSpeed = (vCtx === "speaking-fast") ? 2.4 : (vCtx === "speaking") ? 1.7 : 1.1;

  noStroke();
  const dotA = 10 + amp * 30;
  fill(180, 230, 255, dotA * 0.6);
  const dotAng = t * sweepSpeed;
  const dotR = baseR + wobble * 0.6;
  ellipse(cos(dotAng) * dotR, sin(dotAng) * dotR, 3 + amp * 4);

  // blendMode(BLEND);
  pop();
}

// 🙂 FACE layer: emotion “halo” tint + subtle geometry (uses valenceScore + faceEmotion + smoothed expressions)
// 🙂 FACE layer (subtle): small halo + orbiting emotion dots
// - Color shifts with valence/emotion
// - Uses smoothed expressions when available
// - Minimal, never blocks main visuals
function drawFaceLayer(speed) {
  push();
  noFill();

  const vScore = (typeof fusion !== "undefined") ? fusion.valenceScore : 0; // -1..1
  const dominant = (typeof fusion !== "undefined") ? fusion.face : faceEmotion;

  // Expression strengths (prefer smoothed)
  const happy = faceExprSmooth ? (faceExprSmooth.happy || 0) : (dominant === "happy" ? 1 : 0);
  const sad = faceExprSmooth ? (faceExprSmooth.sad || 0) : (dominant === "sad" ? 1 : 0);
  const angry = faceExprSmooth ? (faceExprSmooth.angry || 0) : (dominant === "angry" ? 1 : 0);
  const fearful = faceExprSmooth ? (faceExprSmooth.fearful || 0) : (dominant === "fearful" ? 1 : 0);
  const surprised = faceExprSmooth ? (faceExprSmooth.surprised || 0) : (dominant === "surprised" ? 1 : 0);
  const neutral = faceExprSmooth ? (faceExprSmooth.neutral || 0) : (dominant === "neutral" ? 1 : 0);

  // Pick a subtle face color
  let col = color(170, 170, 185, 20); // neutral default
  if (vScore > 0.18) col = color(255, 220, 140, 22);     // warm positive
  if (vScore < -0.18) col = color(170, 150, 255, 22);    // cool negative

  // Emotion overrides (gentle)
  if (angry > 0.35) col = color(255, 120, 150, 24);
  if (fearful > 0.35) col = color(210, 160, 255, 24);
  if (sad > 0.35) col = color(140, 180, 255, 24);
  if (surprised > 0.35) col = color(255, 240, 170, 24);

  const strength = constrain(
    abs(vScore) * 0.7 + happy * 0.4 + sad * 0.45 + angry * 0.55 + fearful * 0.5 + surprised * 0.35,
    0,
    1
  );

  const t = frameCount * 0.02 * (0.9 + strength * 1.1);

  // Small halo ring (NOT a big blob)
  const baseR = min(width, height) * 0.11;
  const wobble = min(width, height) * 0.008 * (0.3 + strength);

  strokeWeight(0.8);
  stroke(red(col), green(col), blue(col), 8 + strength * 16);

  beginShape();
  for (let ang = 0; ang <= TWO_PI + 0.001; ang += 0.14) {
    const n = noise(cos(ang) + 20, sin(ang) + 20, t * 0.2);
    const r = baseR + (n - 0.5) * 2.0 * wobble + sin(t + ang * 2) * wobble * 0.6;
    vertex(cos(ang) * r, sin(ang) * r);
  }
  endShape(CLOSE);

  // Orbiting emotion dots (small & sparse)
  // count increases slightly when expressions are strong
  const dotCount = 4 + floor(strength * 4);
  const orbitR = baseR * 1.35;

  noStroke();
  for (let i = 0; i < dotCount; i++) {
    const a = t * (1.2 + strength) + (TWO_PI / dotCount) * i;
    const localR = orbitR + sin(t * 2 + i) * (4 + strength * 6);

    // size + alpha stays small
    const s = 2 + strength * 3;
    const dotA = 10 + strength * 22;

    fill(red(col), green(col), blue(col), dotA);
    ellipse(cos(a) * localR, sin(a) * localR, s);

    // tiny highlight
    fill(255, 255, 255, dotA * 0.25);
    ellipse(cos(a) * localR - 1, sin(a) * localR - 1, s * 0.5);
  }

  // Neutral state makes it even quieter
  if (neutral > 0.6 && strength < 0.2) {
    // fade quickly when truly neutral
    // (keeps face layer from "always showing")
    // you can remove this block if you want it always visible
  }

  pop();
}
// ==================================
// 🟤 SENSOR LOST
function drawSensorLost(speed) {
  push();
  noFill();
  stroke(140, 160, 190, 120);

  let t = frameCount * 0.01 * speed;

  for (let i = 0; i < 8; i++) {
    let r = 80 + i * 40 + sin(t + i) * 10;
    ellipse(0, 0, r);
  }

  let dx = sin(t * 1.2) * 40;
  let dy = cos(t * 1.0) * 30;
  strokeWeight(2);
  line(-40 + dx, dy, 40 + dx, dy);
  line(dx, -40 + dy, dx, 40 + dy);

  pop();
}

// ================= UI =================
function drawLabel() {
  resetMatrix();
  fill(200);
  textSize(13);
  textAlign(CENTER);

  const label = sensorLost ? "Sensor Lost" : fusion.state;

  text(
    label +
      " | BPM: " + int(bpm) +
      " | Arousal: " + fusion.arousal +
      " | Face: " + faceEmotion +
      " | Valence: " + fusion.valence +
      " | VoiceCtx: " + fusion.voiceContext +
      " | VoiceInt: " + fusion.voiceIntensity.toFixed(2) +
      " | Speed: " + motionSpeed.toFixed(1) +
      " | SpeechΔ: " + speechActivity.toFixed(2) +
      (useHeartSensor ? " | Heart: ON" : " | Heart: OFF"),
    width / 2,
    height - 25
  );
}

function drawSoundLevelBar() {
  resetMatrix();
  noStroke();
  fill(100, 200, 255, 180);
  let barWidth = map(soundLevel, 0, 2, 0, width * 0.8);
  rectMode(CENTER);
  rect(width / 2, height - 60, barWidth, 20, 10);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}