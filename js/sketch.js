// ========================
// Pulse Canvas — Sound + Heart Sensor + Voice Analysis + Face Emotion
// Fusion Logic:
// Heart Rate → arousal level (calm → neutral → excited → panicked)
// Face → influences visual interpretation
// Voice → adds intensity and dynamics
// Sensor Lost = instant jump when BPM=0 (no stage fade-through)
// ========================

let audioStarted = false;

let calmSound, neutralSound, excitedSound, panicSound;
let currentSound = null;
let lastState = "";

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

function preload() {
  calmSound = loadSound("calm.mp3");
  neutralSound = loadSound("neutral.mp3");
  excitedSound = loadSound("excited.mp3");
  panicSound = loadSound("panic.mp3");
}

function mousePressed() {
  userStartAudio();
}

// SERIAL (Heart Sensor)
let port;
let reader;
let lineBuffer = "";

// Calm state rain
let calmRain = [];
let calmRainCount = 180;

// Enhanced particles for excited/firework state
let fireworks = [];
let sparks = [];
let glowParticles = [];

// Stress/Panic particles
let stressParticles = [];
let shockwaves = [];

// ================= FACE =================
let video;
let detections = null;
let faceEmotion = "neutral";
let faceLoaded = false;

// Expression smoothing (EMA)
let faceExprSmooth = null;
const FACE_SMOOTH_ALPHA = 0.35;

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

// ================= FUSION =================
let fusion = {
  arousal: "calm",
  arousalLevel: 0,
  valence: "neutral",
  valenceScore: 0,
  face: "neutral",
  voiceContext: "silent",
  voiceIntensity: 0,
  state: "Calm"
};

// Smooth display values for UI (slower updates)
let displayBPM = 70;
let displayFaceEmotion = "neutral";
let displayVoiceContext = "silent";
let displayVoiceIntensity = 0;
let displayArousal = "calm";
let displayState = "Calm";

//startscreen
let started = false;

function computeArousalFromBpm(bpmValue) {
  let arousal, lvl;

  if (bpmValue < 65) {
    arousal = "calm";
    lvl = map(bpmValue, 40, 65, 0.0, 0.33, true);
  } else if (bpmValue < 85) {
    arousal = "neutral";
    lvl = map(bpmValue, 65, 85, 0.33, 0.66, true);
  } else if (bpmValue < 110) {
    arousal = "excited";
    lvl = map(bpmValue, 85, 110, 0.66, 0.9, true);
  } else {
    arousal = "panicked";
    lvl = map(bpmValue, 110, 160, 0.9, 1.0, true);
  }

  return { arousal, lvl: constrain(lvl, 0, 1) };
}

function computeValenceFromFace(exprSmooth, dominant) {
  if (!exprSmooth) {
    if (dominant === "happy") return { valence: "positive", score: 0.35 };
    if (["sad", "angry", "fearful", "disgusted"].includes(dominant)) {
      return { valence: "negative", score: -0.35 };
    }
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

  if (dominant === "happy") {
    valence = "positive";
    score = max(score, 0.25);
  }

  if (["sad", "angry", "fearful", "disgusted"].includes(dominant)) {
    valence = "negative";
    score = min(score, -0.25);
  }

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
  const faceThreat =
    faceDominant === "fearful" ||
    faceDominant === "angry" ||
    faceDominant === "disgusted";

  if (arousal === "calm") {
    if (valence === "negative") return "Neutral";
    return "Calm";
  }

  if (arousal === "neutral") {
    if (faceDominant === "surprised" && (voiceIntensity > 0.35 || voiceContext === "speaking-fast")) {
      return "Excited";
    }

    if (valence === "positive") return "Excited";
    if (valence === "negative") return "Neutral";
    return "Neutral";
  }

  if (arousal === "excited") {
    if (faceThreat && (voiceIntensity > 0.45 || voiceContext === "speaking-fast")) {
      return "Panic";
    }
    return "Excited";
  }

  return "Panic";
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

  // smooth display values for UI
  displayBPM = lerp(displayBPM, bpm, 0.05);
  displayFaceEmotion = faceEmotion;
  displayVoiceContext = fusion.voiceContext;
  displayVoiceIntensity = lerp(displayVoiceIntensity, fusion.voiceIntensity, 0.05);
  displayArousal = fusion.arousal;
  displayState = fusion.state;
}

function setup() {
  let c = createCanvas(windowWidth, windowHeight);
  c.style("position", "fixed");
  c.style("top", "0");
  c.style("left", "0");
  c.style("z-index", "1");

  background(5, 8, 20);
  smooth();

  textAlign(CENTER);
  textSize(16);

  mic = new p5.AudioIn();

  let connectBtn = createButton("Connect Heart Sensor");
  connectBtn.position(20, 20);
  connectBtn.mousePressed(connectSerial);
  connectBtn.style("z-index", "1000");

  fft = new p5.FFT(0.8, 2048);
  fft.setInput(mic);

  // ---------- FACE (hidden) ----------
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();
  loadFaceAPI();

  for (let i = 0; i < calmRainCount; i++) calmRain.push(createCalmDrop());

  // Initialize particles
  for (let i = 0; i < 30; i++) fireworks.push(createFirework());
  for (let i = 0; i < 50; i++) sparks.push(createSpark());
  for (let i = 0; i < 40; i++) glowParticles.push(createGlowParticle());
  for (let i = 0; i < 50; i++) stressParticles.push(createStressParticle());

  lastGoodBpmMs = millis();

  displayBPM = bpm;
  displayVoiceIntensity = 0;

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

function playStateSound(state) {
  let nextSound = null;

  if (state === "Calm") nextSound = calmSound;
  else if (state === "Neutral") nextSound = neutralSound;
  else if (state === "Excited") nextSound = excitedSound;
  else if (state === "Panic") nextSound = panicSound;

  // don't restart same state sound
  if (state === lastState) return;
  lastState = state;

  // store old sound BEFORE changing currentSound
  let oldSound = currentSound;

  // fade out old sound
  if (oldSound && oldSound.isPlaying()) {
    oldSound.setVolume(0, 0.5);
    setTimeout(() => {
      oldSound.stop();
    }, 500);
  }

  // start new sound
  if (nextSound) {
    if (!nextSound.isPlaying()) {
      nextSound.loop();
    }
    nextSound.setVolume(1, 0.5);
    currentSound = nextSound;
  }
}

// ================= FACE LOAD =================
async function loadFaceAPI() {
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);

    faceLoaded = true;
    console.log("Face API Loaded");

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
      smoothExpressions(detections.expressions);
      faceEmotion = getDominantEmotion(faceExprSmooth || detections.expressions);
    } else {
      faceEmotion = "neutral";
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

function createFirework() {
  return {
    x: random(-width / 3, width / 3),
    y: random(-height / 3, height / 3),
    targetY: random(-height / 4, height / 4),
    exploded: false,
    explosionTime: 0,
    particles: [],
    color: [random(200, 255), random(150, 220), random(50, 150)],
    size: random(3, 6)
  };
}

function createSpark() {
  return {
    x: random(-width / 2, width / 2),
    y: random(-height / 2, height / 2),
    vx: random(-3, 3),
    vy: random(-3, 3),
    life: random(0.5, 1),
    color: [random(200, 255), random(150, 200), random(0, 100)],
    size: random(2, 5)
  };
}

function createGlowParticle() {
  return {
    x: random(-width / 2, width / 2),
    y: random(-height / 2, height / 2),
    vx: random(-0.5, 0.5),
    vy: random(-0.5, 0.5),
    size: random(5, 20),
    pulseSpeed: random(0.01, 0.03),
    phase: random(TWO_PI),
    color: [random(200, 255), random(150, 200), random(50, 100)]
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
    userStartAudio();
    mic.start();
    audioStarted = true;
  }

  fft.analyze();
  let high = fft.getEnergy("treble");
  pitchEnergy = lerp(pitchEnergy, high / 255, 0.1);
}

function analyzeVoice() {
  let spectrum = fft.analyze();

  voiceAnalysis.volume = mic.getLevel();
  let pitch = fft.getCentroid();
  voiceAnalysis.pitch = pitch;

  voiceAnalysis.pitchHistory.push(pitch);
  if (voiceAnalysis.pitchHistory.length > 50) voiceAnalysis.pitchHistory.shift();

  if (voiceAnalysis.pitchHistory.length > 10) {
    let avg = voiceAnalysis.pitchHistory.reduce((a, b) => a + b, 0) / voiceAnalysis.pitchHistory.length;
    let variance = voiceAnalysis.pitchHistory.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / voiceAnalysis.pitchHistory.length;
    voiceAnalysis.pitchVariance = Math.sqrt(variance) / (avg + 0.01);

    let recent = voiceAnalysis.pitchHistory.slice(-10);
    if (recent.length >= 10) {
      let firstHalf = recent.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      let secondHalf = recent.slice(5).reduce((a, b) => a + b, 0) / 5;
      voiceAnalysis.pitchTrend = (secondHalf - firstHalf) / (firstHalf + 0.01);
    }
  }

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
      voiceAnalysis.speechSegments.push({ duration: speechDuration, time: currentTime });
      voiceAnalysis.speechSegments = voiceAnalysis.speechSegments.filter((s) => currentTime - s.time < 30000);
    }
  }

  if (voiceAnalysis.speechSegments.length > 0) {
    let recentSegments = voiceAnalysis.speechSegments.filter((s) => currentTime - s.time < 10000);
    voiceAnalysis.speechRate = recentSegments.length * 6;
  } else {
    voiceAnalysis.speechRate = 0;
  }

  let lowFreq = fft.getEnergy(20, 500);
  let highFreq = fft.getEnergy(2000, 8000);
  if (lowFreq > 0) voiceAnalysis.breathiness = highFreq / lowFreq;

  if (amplitude > speechThreshold) {
    let midFreq = fft.getEnergy(500, 2000);
    if (midFreq > 0) voiceAnalysis.tension = highFreq / midFreq;
  } else {
    voiceAnalysis.tension = lerp(voiceAnalysis.tension, 0, 0.05);
  }

  if (voiceAnalysis.lastSpectrum) {
    let flux = 0;
    for (let i = 0; i < spectrum.length; i++) {
      flux += Math.abs(spectrum[i] - voiceAnalysis.lastSpectrum[i]);
    }
    voiceAnalysis.spectralFlux = flux / spectrum.length / 255;
  }
  voiceAnalysis.lastSpectrum = [...spectrum];

  voiceAnalysis.emotionalQualities.excitement = constrain(
    voiceAnalysis.pitchVariance * 2 + max(0, voiceAnalysis.pitchTrend) * 3 + voiceAnalysis.speechRate / 100, 0, 1
  );

  voiceAnalysis.emotionalQualities.calmness = constrain(
    (1 - voiceAnalysis.pitchVariance) * 1.5 + (1 - voiceAnalysis.speechRate / 150) * 0.8 + (1 - voiceAnalysis.tension), 0, 1
  );

  voiceAnalysis.emotionalQualities.stress = constrain(
    voiceAnalysis.tension * 2 + voiceAnalysis.spectralFlux * 2 + (voiceAnalysis.pitch > 300 ? 0.3 : 0), 0, 1
  );

  voiceAnalysis.emotionalQualities.sadness = constrain(
    (1 - voiceAnalysis.pitchVariance) * 1.2 + max(0, -voiceAnalysis.pitchTrend) * 2 + voiceAnalysis.breathiness * 0.5, 0, 1
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
  if (!started) return;

  background(5, 8, 20, 40);
  fill(10, 20, 40, 15);
  rect(0, 0, width, height);

  startAudio();
  analyzeVoice();
  updateFusion();
  
  playStateSound(fusion.state); 

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

  if (useHeartSensor && millis() - lastGoodBpmMs > LOST_AFTER_MS) {
    sensorLost = true;
    bpmTarget = 0;
  }

  updateFusion();
  
  

  translate(width / 2, height / 2);
  
  // Always draw subtle background layers
  drawHeartLayer(speed);
  drawVoiceLayer(speed);
  drawFaceLayer(speed);

  if (sensorLost) {
    drawSensorLost(speed);
  } else {
    const label = fusion.state;
    speed *= lerp(0.9, 1.6, fusion.voiceIntensity);

    if (label === "Calm") drawCalm(speed);
    else if (label === "Neutral") drawNeutral(speed);
    else if (label === "Excited") drawExcited(speed);
    else if (label === "Panic") drawStress(speed);
  }

  drawLabel();
  drawSoundLevelBar();
}

// ================= INPUT =================
function keyPressed() {
  if (!useHeartSensor) {
    if (key === "1") { bpm = 60; bpmTarget = 60; }  // Calm
    if (key === "2") { bpm = 75; bpmTarget = 75; }  // Neutral
    if (key === "3") { bpm = 95; bpmTarget = 95; }  // Excited
    if (key === "4") { bpm = 130; bpmTarget = 130; } // Panic
  }

  startAudio();

  if (key === "a" || key === "A") motionSpeed = max(0.2, motionSpeed - 0.1);
  if (key === "d" || key === "D") motionSpeed = min(2.0, motionSpeed + 0.1);
}

// ================= VISUAL STATES =================

// 🟦 CALM
function drawCalm(speed) {
  push();

  let t = frameCount * 0.005 * speed;
  let calmIntensity = map(bpm, 40, 65, 0.8, 1.4) * (1 - speechActivity * 0.15);
  let voiceCalmFactor = 1 - voiceAnalysis.emotionalQualities.stress * 0.3;
  calmIntensity *= voiceCalmFactor;

  let colors = {
    deep: color(60, 100, 170, 40),
    mid: color(100, 150, 200, 60),
    light: color(150, 200, 240, 80),
    accent: color(180, 220, 255, 100),
    glow: color(120, 180, 240, 30)
  };

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

  // Flowing ribbon trails
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
      let y = sin(x * 0.03 + ribbonSpeed) * 150 * calmIntensity +
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

  // Rain
  let density = map(speechActivity, 0, 3, 0.6, 1.4);
  let rainSpeed = speed * map(bpm, 40, 65, 0.4, 1.0) * 1.5;

  for (let d of calmRain) {
    let depth = map(d.y, -height / 2, height / 2, 0, 1);
    let blueHue = lerp(colors.deep.levels[1], colors.light.levels[1], depth);
    let tensionEffect = 1 + voiceAnalysis.tension * 2;
    let alpha = d.alpha * (0.7 + 0.3 * sin(t * 3 * tensionEffect + d.x * 0.1));

    stroke(colors.mid.levels[0], blueHue, colors.mid.levels[2], alpha);
    strokeWeight(d.thick * (0.8 + 0.4 * sin(t * 4 * tensionEffect + d.x)));

    line(d.x, d.y, d.x + d.drift * 6 + sin(t * 2 * tensionEffect + d.y * 0.1) * 3, d.y + d.len * (0.9 + 0.2 * sin(t * 5)));

    stroke(colors.light.levels[0], colors.light.levels[1], colors.light.levels[2], alpha * 0.3);
    line(d.x - 1, d.y + 2, d.x - 1 + d.drift * 5 + cos(t * 2 * tensionEffect + d.y * 0.1) * 2, d.y + d.len * 0.8);

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

  pop();
}

// ⚪ NEUTRAL
function drawNeutral(speed) {
  push();
  noFill();

  let t = frameCount * 0.005 * speed;
  let neutralIntensity = map(bpm, 65, 85, 0.8, 1.2, true);
  
  let colors = {
    primary: color(180, 200, 220, 100),
    secondary: color(150, 170, 200, 80),
    accent: color(200, 210, 230, 120)
  };

  // Gentle pulsing rings
  for (let i = 0; i < 5; i++) {
    let pulse = sin(t * 2 + i) * 0.2 + 0.8;
    let size = 150 + i * 60 + sin(t * 3 + i) * 20 * neutralIntensity;
    let alpha = 60 - i * 10 * pulse;
    
    stroke(colors.primary.levels[0], colors.primary.levels[1], colors.primary.levels[2], alpha);
    strokeWeight(1.5 - i * 0.2);
    ellipse(0, 0, size);
  }

  // Subtle rotating lines
  push();
  rotate(t * 0.5);
  for (let i = 0; i < 8; i++) {
    let angle = (TWO_PI / 8) * i;
    let lineLength = 100 + sin(t * 2 + i) * 20;
    stroke(colors.secondary.levels[0], colors.secondary.levels[1], colors.secondary.levels[2], 40);
    line(cos(angle) * 60, sin(angle) * 60, cos(angle) * lineLength, sin(angle) * lineLength);
  }
  pop();

  pop();
}

// 🔥 EXCITED - Firework/Joy vibe
function drawExcited(speed) {
  push();
  blendMode(ADD);

  let t = frameCount * 0.01 * speed;
  let bpmBoost = map(bpm, 85, 110, 0.8, 1.6, true);
  let excitementLevel = voiceAnalysis.emotionalQualities.excitement;

  // Firework color palette - warm and vibrant
  let colors = {
    primary: color(255, 220, 100, 200),   // Warm yellow
    secondary: color(255, 150, 50, 180),   // Orange
    accent: color(255, 100, 150, 220),     // Pink
    sparkle: color(255, 255, 200, 255),    // Warm white
    glow: color(255, 200, 100, 140),       // Golden glow
    firework: [                           // Firework burst colors
      color(255, 200, 50, 200),   // Gold
      color(255, 100, 100, 200),  // Red
      color(255, 150, 200, 200),  // Pink
      color(200, 255, 100, 200),  // Lime
      color(255, 100, 255, 200)   // Purple
    ]
  };

  noFill();
  
  // Dynamic color based on excitement
  let joyColor = lerpColor(colors.primary, colors.accent, pitchEnergy * (1 + excitementLevel * 0.5));
  
  stroke(red(joyColor), green(joyColor), blue(joyColor), 140);
  
  // Voice tension affects stroke weight
  let tensionFactor = 1 - voiceAnalysis.tension * 0.5;
  strokeWeight((2 + soundLevel * 6) * tensionFactor);

  // Core sun/burst
  let coreSize = 120 + sin(t * 2.0 * bpmBoost) * 30 + speechActivity * 30 + soundLevel * 50 + excitementLevel * 60;
  ellipse(0, 0, coreSize);

  // Radiating rings
  let ringCount = int(6 + speechActivity * 8 + excitementLevel * 10);
  for (let i = 0; i < ringCount; i++) {
    let r = coreSize + i * 35 * bpmBoost + sin(t + i * 2) * 15;
    strokeWeight(1.5 * tensionFactor);
    let ringColor = colors.firework[i % colors.firework.length];
    stroke(red(ringColor), green(ringColor), blue(ringColor), map(i, 0, ringCount, 140, 10));
    ellipse(0, 0, r);
  }

  // FIREWORK BURSTS - Explosion effect
  if (frameCount % max(5, 15 - floor(excitementLevel * 10)) < 3) {
    let burstCount = 3 + floor(excitementLevel * 5);
    for (let b = 0; b < burstCount; b++) {
      let burstAngle = random(TWO_PI);
      let burstDist = coreSize * 0.8 + random(50, 150);
      let burstX = cos(burstAngle) * burstDist;
      let burstY = sin(burstAngle) * burstDist;
      
      // Create explosion
      for (let p = 0; p < 20; p++) {
        let angle = random(TWO_PI);
        let dist = random(10, 40);
        let size = random(3, 8);
        let col = colors.firework[floor(random(colors.firework.length))];
        
        push();
        noStroke();
        fill(red(col), green(col), blue(col), 200);
        ellipse(burstX + cos(angle) * dist, burstY + sin(angle) * dist, size);
        
        // Trail effect
        fill(red(col), green(col), blue(col), 100);
        ellipse(burstX + cos(angle) * dist * 0.6, burstY + sin(angle) * dist * 0.6, size * 1.5);
        pop();
      }
    }
  }

  // Main particles
  let particleCount = int(80 + speechActivity * 60 + excitementLevel * 80);
  noStroke();
  for (let i = 0; i < particleCount; i++) {
    let angle = TWO_PI * (i / particleCount) + t * (1.4 + excitementLevel);
    let radius = coreSize * 0.5 + sin(t * 2.3 + i) * 60 + noise(i, t) * 50;
    let rise = (frameCount * (0.4 + excitementLevel * 0.2) + i * 20) % (height * 2) - height;

    let px = cos(angle) * radius;
    let py = sin(angle) * radius - rise * 0.2;

    let size = 2 + soundLevel * 8 + sin(t * 4 + i) * 2 + excitementLevel * 4;

    // Color variations
    let particleColor;
    let rand = random();
    if (rand < 0.3) particleColor = colors.primary;
    else if (rand < 0.6) particleColor = colors.secondary;
    else particleColor = colors.accent;
    
    fill(red(particleColor), green(particleColor), blue(particleColor), 200);
    ellipse(px, py, size);
    
    // Glow trail
    if (i % 3 == 0) {
      fill(red(particleColor), green(particleColor), blue(particleColor), 60);
      ellipse(px - cos(t * 2) * 5, py - sin(t * 2) * 5, size * 1.5);
    }
  }

  // Sparkles
  let sparkleCount = 40 + floor(excitementLevel * 50);
  for (let i = 0; i < sparkleCount; i++) {
    let x = noise(i, t * 2) * width - width / 2;
    let y = noise(i + 100, t * 1.2) * height - height / 2;
    let sparkleSize = noise(i, t * 3) * 5 + 1 + excitementLevel * 3;
    
    let sparkleColor = colors.firework[floor(random(colors.firework.length))];
    fill(red(sparkleColor), green(sparkleColor), blue(sparkleColor), 150);
    ellipse(x, y, sparkleSize);
    
    // Double sparkle for excitement
    if (random() < excitementLevel * 0.5) {
      fill(red(sparkleColor), green(sparkleColor), blue(sparkleColor), 80);
      ellipse(x + random(-5,5), y + random(-5,5), sparkleSize * 0.7);
    }
  }

  // Glow particles
  for (let g of glowParticles) {
    g.x += g.vx * speed * (1 + excitementLevel);
    g.y += g.vy * speed * (1 + excitementLevel);
    
    if (abs(g.x) > width / 2) g.x *= -0.9;
    if (abs(g.y) > height / 2) g.y *= -0.9;
    
    let pulse = sin(t * g.pulseSpeed * 10 + g.phase) * 0.3 + 0.7;
    let col = g.color;
    
    fill(col[0], col[1], col[2], 30 * pulse);
    noStroke();
    ellipse(g.x, g.y, g.size * pulse);
    
    // Inner core
    fill(col[0], col[1], col[2], 80 * pulse);
    ellipse(g.x, g.y, g.size * 0.3);
  }

  // Golden rays
  if (frameCount % max(5, 20 - floor(excitementLevel * 15)) < 3) {
    push();
    stroke(colors.glow);
    strokeWeight(1.5);
    let rayCount = 12 + floor(excitementLevel * 10);
    for (let i = 0; i < rayCount; i++) {
      let rayAngle = (TWO_PI / rayCount) * i + t * (0.8 + excitementLevel);
      let rayLength = coreSize * 2 + sin(t * 3 + i) * 40 + excitementLevel * 100;
      line(
        cos(rayAngle) * coreSize * 0.3,
        sin(rayAngle) * coreSize * 0.3,
        cos(rayAngle + sin(t * 2 + i) * 0.2) * rayLength,
        sin(rayAngle + sin(t * 2 + i) * 0.2) * rayLength
      );
    }
    pop();
  }

  blendMode(BLEND);
  pop();
}

// 🔴 STRESS/PANIC - Your stress function as Panic state
function drawStress(speed) {
  push();
  
  let t = frameCount * 0.02 * speed;
  let stressIntensity = map(bpm, 110, 130, 0.4, 1.2, true) * intensity;
  
  // Voice stress directly affects visual stress
  stressIntensity *= (1 + voiceAnalysis.emotionalQualities.stress);
  
  // Pitch variance adds chaos
  let chaosFactor = 1 + voiceAnalysis.pitchVariance * 2;
  
  // Dynamic color palette for stress
  let colors = {
    primary: color(220, 40, 40, 200),
    secondary: color(180, 20, 20, 150),
    accent: color(255, 100, 100, 180),
    dark: color(100, 20, 20, 100)
  };
  
  // Background pulsing aura
  push();
  let auraSize = width * (0.8 + sin(t * 3 * chaosFactor) * 0.1 * stressIntensity);
  for (let i = 5; i > 0; i--) {
    let alpha = map(i, 0, 5, 10, 40) * stressIntensity;
    fill(180, 30, 30, alpha);
    noStroke();
    ellipse(0, 0, auraSize * (i/5), auraSize * (i/5));
  }
  pop();
  
  // Electrical storm effect
  push();
  blendMode(ADD);
  strokeWeight(1.5);
  for (let i = 0; i < 8 * stressIntensity * (1 + voiceAnalysis.spectralFlux); i++) {
    let angle = random(TWO_PI);
    let startRadius = random(50, 200);
    let endRadius = startRadius + random(100, 300) * stressIntensity;
    
    let startX = cos(angle) * startRadius;
    let startY = sin(angle) * startRadius;
    let endX = cos(angle + random(-0.3, 0.3)) * endRadius;
    let endY = sin(angle + random(-0.3, 0.3)) * endRadius;
    
    // Create jagged lightning
    let steps = 10;
    let prevX = startX;
    let prevY = startY;
    
    for (let j = 1; j <= steps; j++) {
      let progress = j / steps; 
      let targetX = lerp(startX, endX, progress);
      let targetY = lerp(startY, endY, progress);
      
      // Add jitter
      targetX += random(-10, 10) * stressIntensity * (1 + voiceAnalysis.tension);
      targetY += random(-10, 10) * stressIntensity * (1 + voiceAnalysis.tension);
      
      // Fade out along the arc
      let arcAlpha = map(j, 0, steps, 255, 50) * stressIntensity;
      stroke(255, 100, 100, arcAlpha);
      
      line(prevX, prevY, targetX, targetY);
      
      prevX = targetX;
      prevY = targetY;
    }
  }
  blendMode(BLEND);
  pop();
  
  // Stress particles with heat shimmer
  push();
  noStroke();
  for (let particle of stressParticles) {
    // Update particle
    particle.x += particle.vx * speed * stressIntensity * (1 + voiceAnalysis.tension);
    particle.y += particle.vy * speed * stressIntensity * (1 + voiceAnalysis.tension);
    particle.life = 0.8 + sin(t * particle.pulseSpeed * chaosFactor) * 0.2;
    
    // Wrap around edges
    if (abs(particle.x) > width/2) particle.x *= -0.9;
    if (abs(particle.y) > height/2) particle.y *= -0.9;
    
    // Heat shimmer effect
    let shimmerX = particle.x + sin(t * 10 * chaosFactor + particle.y * 0.1) * 5 * stressIntensity * (1 + voiceAnalysis.spectralFlux);
    let shimmerY = particle.y + cos(t * 10 * chaosFactor + particle.x * 0.1) * 5 * stressIntensity * (1 + voiceAnalysis.spectralFlux);
    
    // Draw particle with glow
    for (let glow = 2; glow >= 0; glow--) {
      let alpha = glow === 0 ? 180 : 60;
      fill(220, 40, 40, alpha * particle.life);
      ellipse(shimmerX, shimmerY, particle.size * (1 + glow * 0.5), particle.size * (1 + glow * 0.5));
    }
    
    // Random movement
    particle.vx += random(-0.2, 0.2) * stressIntensity * (1 + voiceAnalysis.pitchVariance);
    particle.vy += random(-0.2, 0.2) * stressIntensity * (1 + voiceAnalysis.pitchVariance);
    
    // Limit speed
    particle.vx = constrain(particle.vx, -3, 3);
    particle.vy = constrain(particle.vy, -3, 3);
  }
  pop();
  
  // Pulsing stress rings with distortion
  push();
  noFill();
  let ringCount = int(3 + speechActivity * 2 + voiceAnalysis.tension * 3);
  for (let i = 0; i < ringCount; i++) {
    let ringPhase = t * 2 * chaosFactor + i;
    let ringSize = 100 + i * 60 + sin(ringPhase) * 20 * stressIntensity;
    
    // Distorted ring
    beginShape();
    for (let a = 0; a < TWO_PI; a += 0.1) {
      let distortion = noise(cos(a) + i, sin(a) + t * chaosFactor) * 30 * stressIntensity * (1 + voiceAnalysis.breathiness);
      let r = ringSize + distortion;
      let x = cos(a + t * chaosFactor) * r;
      let y = sin(a + t * chaosFactor) * r;
      
      // Color based on distortion
      let ringColor = lerpColor(colors.primary, colors.accent, distortion/50);
      stroke(ringColor);
      strokeWeight(1 + sin(ringPhase) * 0.5);
      
      vertex(x, y);
    }
    endShape(CLOSE);
  }
  pop();
  
  // Blood vessel-like patterns
  push();
  stroke(colors.dark);
  strokeWeight(1);
  let vesselCount = int(6 + speechActivity * 4 + voiceAnalysis.tension * 5);
  for (let i = 0; i < vesselCount; i++) {
    let angle = (TWO_PI / vesselCount) * i + t * 0.5 * chaosFactor;
    let startR = 80;
    let endR = 300 + sin(t * 3 * chaosFactor + i) * 50;
    
    beginShape();
    for (let r = startR; r <= endR; r += 10) {
      let branchAngle = angle + sin(r * 0.05 + t * 5 * chaosFactor) * 0.5 * stressIntensity;
      let x = cos(branchAngle) * r;
      let y = sin(branchAngle) * r;
      
      // Thickness varies
      strokeWeight(map(r, startR, endR, 3, 0.5));
      
      // Color pulses
      let pulseAlpha = map(sin(r * 0.1 + t * 10 * chaosFactor), -1, 1, 100, 200);
      stroke(180, 40, 40, pulseAlpha);
      
      vertex(x, y);
    }
    endShape();
  }
  pop();
  
  // Occasional shockwave
  if (random() < 0.02 * stressIntensity + voiceAnalysis.emotionalQualities.stress * 0.05) {
    shockwaves.push({
      radius: 50,
      maxRadius: width/2,
      life: 1.0,
      speed: random(5, 10) * stressIntensity * (1 + voiceAnalysis.spectralFlux)
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
    
    // Secondary ring
    stroke(255, 100, 100, 100 * wave.life);
    strokeWeight(1 * wave.life);
    ellipse(0, 0, wave.radius * 1.8);
  }
  pop();
  
  // Central core - chaotic pulsing
  push();
  let coreSize = 40 + sin(t * 10 * chaosFactor) * 10 * stressIntensity + soundLevel * 30 + voiceAnalysis.tension * 50;
  for (let i = 3; i > 0; i--) {
    let alpha = map(i, 0, 3, 200, 50);
    fill(220, 40, 40, alpha);
    noStroke();
    ellipse(
      sin(t * 15 * chaosFactor) * 5 * stressIntensity,
      cos(t * 13 * chaosFactor) * 5 * stressIntensity,
      coreSize * (i/3),
      coreSize * (i/3)
    );
  }
  pop();
  
  pop();
}

// ================= BACKGROUND LAYERS =================

// ❤️ HEART layer
function drawHeartLayer(speed) {
  push();
  noFill();

  const lvl = (typeof fusion !== "undefined") ? fusion.arousalLevel : map(bpm, 50, 140, 0, 1, true);

  const bpmHz = bpm / 60.0;
  const beat = (sin(frameCount * 0.12 * bpmHz) * 0.5 + 0.5);
  const t = frameCount * 0.01;

  const baseR = min(width, height) * 0.14;
  const beatAmp = min(width, height) * (0.01 + lvl * 0.02);

  const aMain = 10 + lvl * 14;
  const aSoft = 5 + lvl * 9;

  strokeWeight(0.9);

  for (let i = 0; i < 3; i++) {
    const r = baseR + i * (min(width, height) * 0.07) + beat * beatAmp + sin(t + i) * 2;

    stroke(255, 170, 200, aMain * (1 - i * 0.18));
    ellipse(0, 0, r * 2);

    stroke(255, 220, 235, aSoft * (1 - i * 0.22));
    ellipse(0, 0, r * 1.85);
  }

  noStroke();
  const dotA = 8 + lvl * 10;
  fill(255, 210, 230, dotA);
  ellipse(0, 0, 2 + beat * 3);

  pop();
}

// 🎤 VOICE layer
function drawVoiceLayer(speed) {
  push();
  noFill();

  const vInt = (typeof fusion !== "undefined") ? fusion.voiceIntensity : 0;
  const v = constrain(voiceAnalysis.volume * 18, 0, 1);
  const speak = voiceAnalysis.isSpeaking ? 1 : 0;

  if (drawVoiceLayer._amp === undefined) drawVoiceLayer._amp = 0;
  const targetAmp = (vInt * 0.7 + v * 0.6 + constrain(speechActivity / 3, 0, 1) * 0.35) * (0.7 + 0.3 * speak);
  drawVoiceLayer._amp = lerp(drawVoiceLayer._amp, targetAmp, 0.12);

  const amp = drawVoiceLayer._amp;
  const t = frameCount * 0.02 * (0.8 + amp * 1.4);

  const baseR = min(width, height) * 0.18;
  const wobbleMax = min(width, height) * 0.035;
  const wobble = wobbleMax * amp;

  const a1 = 18 + amp * 25;
  const a2 = 8 + amp * 16;

  const pv = constrain(voiceAnalysis.pitchVariance * 2.5, 0, 1);
  const freq = 5 + pv * 7;

  stroke(140, 220, 255, a1);
  strokeWeight(1.0);

  beginShape();
  for (let ang = 0; ang <= TWO_PI + 0.001; ang += 0.10) {
    const wave = sin(ang * freq + t * (2.2 + pv * 2.0)) * wobble +
                 sin(ang * (freq * 0.5) - t * 1.3) * wobble * 0.35 +
                 (noise(cos(ang) + 10, sin(ang) + 10, t * 0.25) - 0.5) * wobble * 0.45;

    const r = baseR + wave;
    vertex(cos(ang) * r, sin(ang) * r);
  }
  endShape(CLOSE);

  stroke(200, 160, 255, a2);
  strokeWeight(0.8);

  beginShape();
  for (let ang = 0; ang <= TWO_PI + 0.001; ang += 0.14) {
    const wave = sin(ang * (freq * 0.8) - t * 1.6) * wobble * 0.45 +
                 (noise(cos(ang) + 50, sin(ang) + 50, t * 0.2) - 0.5) * wobble * 0.25;

    const r = baseR * 0.78 + wave;
    vertex(cos(ang) * r, sin(ang) * r);
  }
  endShape(CLOSE);

  const vCtx = (typeof fusion !== "undefined") ? fusion.voiceContext : "silent";
  const sweepSpeed = (vCtx === "speaking-fast") ? 2.4 : (vCtx === "speaking") ? 1.7 : 1.1;

  noStroke();
  const dotA = 10 + amp * 30;
  fill(180, 230, 255, dotA * 0.6);
  const dotAng = t * sweepSpeed;
  const dotR = baseR + wobble * 0.6;
  ellipse(cos(dotAng) * dotR, sin(dotAng) * dotR, 3 + amp * 4);

  pop();
}

// 🙂 FACE layer
function drawFaceLayer(speed) {
  push();
  noFill();

  const dominant = (typeof fusion !== "undefined") ? fusion.face : faceEmotion;

  const happy = faceExprSmooth ? (faceExprSmooth.happy || 0) : (dominant === "happy" ? 1 : 0);
  const sad = faceExprSmooth ? (faceExprSmooth.sad || 0) : (dominant === "sad" ? 1 : 0);
  const angry = faceExprSmooth ? (faceExprSmooth.angry || 0) : (dominant === "angry" ? 1 : 0);
  const fearful = faceExprSmooth ? (faceExprSmooth.fearful || 0) : (dominant === "fearful" ? 1 : 0);
  const surprised = faceExprSmooth ? (faceExprSmooth.surprised || 0) : (dominant === "surprised" ? 1 : 0);
  const neutral = faceExprSmooth ? (faceExprSmooth.neutral || 0) : (dominant === "neutral" ? 1 : 0);

  let col = color(170, 170, 185, 20);
  if (happy > 0.35) col = color(255, 220, 140, 22);
  if (sad > 0.35) col = color(140, 180, 255, 22);
  if (angry > 0.35) col = color(255, 120, 120, 24);
  if (fearful > 0.35) col = color(210, 160, 255, 24);
  if (surprised > 0.35) col = color(255, 240, 170, 24);

  const strength = constrain(happy * 0.4 + sad * 0.45 + angry * 0.55 + fearful * 0.5 + surprised * 0.35, 0, 1);

  const t = frameCount * 0.02 * (0.9 + strength * 1.1);

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

  const dotCount = 4 + floor(strength * 4);
  const orbitR = baseR * 1.35;

  noStroke();
  for (let i = 0; i < dotCount; i++) {
    const a = t * (1.2 + strength) + (TWO_PI / dotCount) * i;
    const localR = orbitR + sin(t * 2 + i) * (4 + strength * 6);

    const s = 2 + strength * 3;
    const dotA = 10 + strength * 22;

    fill(red(col), green(col), blue(col), dotA);
    ellipse(cos(a) * localR, sin(a) * localR, s);

    fill(255, 255, 255, dotA * 0.25);
    ellipse(cos(a) * localR - 1, sin(a) * localR - 1, s * 0.5);
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
  
  // Draw semi-transparent background for text
  noStroke();
  fill(0, 0, 0, 180);
  rectMode(CENTER);
  rect(width / 2, height - 25, width * 0.95, 30, 10);
  
  // Draw text with better visibility
  fill(255, 255, 255, 240);
  textSize(14);
  textAlign(CENTER);
  textStyle(BOLD);

  const label = sensorLost ? " SENSOR LOST" : displayState;

  // Format the display text with rounded values
  let statusText =
    label +
    " | BPM: " + nf(displayBPM, 0, 0) +
    " | Arousal: " + displayArousal +
    " | Face: " + displayFaceEmotion +
    " | Valence: " + fusion.valence +
    " | Voice: " + displayVoiceContext +
    " | Voice Int: " + nf(displayVoiceIntensity, 1, 2) +
    " | Speed: " + nf(motionSpeed, 1, 1) +
    (useHeartSensor ? " | Heart: ON" : " | Heart: OFF");
  
  // Add instructions line
  let instructions = "Keys: 1(Calm) 2(Neutral) 3(Excited) 4(Panic) | A/D: Speed -/+";
  
  // Draw main status
  text(statusText, width / 2, height - 30);
  
  // Draw instructions below
  textSize(11);
  fill(200, 200, 200, 200);
  text(instructions, width / 2, height - 12);
}

function drawSoundLevelBar() {
  resetMatrix();
  noStroke();
  fill(100, 200, 255, 200);
  let barWidth = map(soundLevel, 0, 2, 0, width * 0.8);
  rectMode(CENTER);
  rect(width / 2, height - 60, barWidth, 20, 10);
  
  // Add label
  fill(255, 255, 255, 200);
  textSize(10);
  textAlign(LEFT);
  text("Sound Level", width/2 - barWidth/2, height - 65);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

document.addEventListener("DOMContentLoaded", () => {

  const startBtn = document.getElementById("btnStartAudio");

  if (!startBtn) {
    console.error("Start button missing in HTML");
    return;
  }

  startBtn.addEventListener("click", async () => {

    startBtn.disabled = true;

    // Start the visual experience
    if (typeof started !== "undefined") {
      started = true;
    }

    const startScreen = document.getElementById("startScreen");
    if (startScreen) startScreen.style.display = "none";

    // Resume AudioContext (required for browsers)
    if (window.getAudioContext && window.getAudioContext().state === "suspended") {
      await window.getAudioContext().resume();
    }

    // Start p5 audio
    if (typeof userStartAudio === "function") {
      await userStartAudio();
    }

    // Start microphone if available
    if (window.mic && !window.mic.enabled) {
      window.mic.start();
    }

    // Start the call
    if (typeof startCall === "function") {
      startCall();
    } else {
      console.error("startCall not found");
      const el = document.getElementById("callStatus");
      if (el) el.textContent = "Connection script missing.";
    }

    console.log("System fully started");

  });

});