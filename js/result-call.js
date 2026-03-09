// js/result-call.js

let pc = null;
let localStream = null;
let sessionRef = null;
let myRole = null; 
let micMuted = false;

const statusEl = document.getElementById("callStatus");
const remoteAudio = document.getElementById("remoteAudio");
const remoteCanvasVideo = document.getElementById("remoteCanvasStream");

const btnStartAudio = document.getElementById("btnStartAudio");
const btnMute = document.getElementById("btnMute");
const btnHangup = document.getElementById("btnHangup");

function setStatus(msg) {
  if (statusEl) statusEl.textContent = `Status: ${msg}`;
  console.log(msg);
}

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  video: false
};

async function ensureAnonAuth() {
  const auth = firebase.auth();
  if (auth.currentUser) return auth.currentUser;
  const cred = await auth.signInAnonymously();
  return cred.user;
}

async function assignRole(db, code, uid) {
  const participantsRef = db.ref(`sessions/${code}/call/participants`);
  await participantsRef.transaction((p) => {
    p = p || {};
    if (p[uid]) return p; 
    const count = Object.keys(p).length;
    const role = (count === 0) ? "host" : "guest";
    p[uid] = { role, joinedAt: Date.now() };
    return p;
  });
  const snap = await participantsRef.child(`${uid}/role`).get();
  return snap.val() || "guest";
}

async function initPeerConnection(db, code) {
  sessionRef = db.ref(`sessions/${code}/call/webrtc`);
  pc = new RTCPeerConnection(RTC_CONFIG);

  // 1. Handle Incoming Tracks (Audio & Canvas Video)
  pc.ontrack = (event) => {
    const track = event.track;
    const stream = event.streams[0];

    if (track.kind === "audio") {
      remoteAudio.srcObject = stream;
      setStatus("Remote audio connected");
    } else if (track.kind === "video") {
      // This routes their artwork into your visible video element!
      remoteCanvasVideo.srcObject = stream;
      remoteCanvasVideo.play().catch(e => console.warn("Video play blocked:", e));
      setStatus("Remote canvas connected");
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const candPath = (myRole === "host") ? "hostCandidates" : "guestCandidates";
    sessionRef.child(candPath).push(event.candidate.toJSON());
  };

  // 2. Add Local Audio
  try {
    localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    setStatus("Mic ready");
  } catch (err) {
    console.error("Mic error:", err);
    setStatus("Mic denied or unavailable");
  }

  // 3. Capture Invisible Local Canvas and Add to Connection
  const localCanvas = document.getElementById("artCanvas");
  if (localCanvas) {
    try {
      const canvasStream = localCanvas.captureStream(30); // Capture at 30fps
      canvasStream.getTracks().forEach(track => {
        pc.addTrack(track, canvasStream);
      });
      setStatus("Mic & Canvas ready for streaming");
    } catch(e) {
      console.error("Canvas capture error:", e);
    }
  } else {
    console.warn("artCanvas not found. Only streaming audio.");
  }
}

async function hostFlow() {
  setStatus("host: creating offer…");
  await sessionRef.child("offer").remove();
  await sessionRef.child("answer").remove();
  await sessionRef.child("hostCandidates").remove();
  await sessionRef.child("guestCandidates").remove();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sessionRef.child("offer").set({
    type: offer.type,
    sdp: offer.sdp,
    ts: Date.now()
  });

  setStatus("host: offer sent — waiting for guest…");

  sessionRef.child("answer").on("value", async (snap) => {
    const ans = snap.val();
    if (!ans || !pc || pc.currentRemoteDescription) return;
    await pc.setRemoteDescription(new RTCSessionDescription(ans));
    setStatus("call live");
  });

  sessionRef.child("guestCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand || !pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
    catch (e) { console.warn("addIceCandidate failed", e); }
  });
}

async function guestFlow() {
  setStatus("guest: waiting for offer…");

  sessionRef.child("offer").on("value", async (snap) => {
    const offer = snap.val();
    if (!offer || !pc || pc.currentRemoteDescription) return;

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    setStatus("guest: offer received — sending answer…");

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await sessionRef.child("answer").set({
      type: answer.type,
      sdp: answer.sdp,
      ts: Date.now()
    });

    setStatus("call live");
  });

  sessionRef.child("hostCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand || !pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
    catch (e) { console.warn("addIceCandidate failed", e); }
  });
}

function setButtons(inCall) {
  if (btnStartAudio) btnStartAudio.disabled = inCall;
  if (btnMute) btnMute.disabled = !inCall;
  if (btnHangup) btnHangup.disabled = !inCall;
}

async function startCall() {
  const code = (window.__PULSE_SESSION__ || "").trim();
  if (!code) {
    setStatus("missing session code (?session=XXXXXX)");
    return;
  }

  try {
    setStatus("signing in…");
    const user = await ensureAnonAuth();
    const db = firebase.database();

    setStatus("assigning role…");
    myRole = await assignRole(db, code, user.uid);
    setStatus(`role = ${myRole}`);

    await initPeerConnection(db, code);
    setButtons(true);

    if (myRole === "host") await hostFlow();
    else await guestFlow();

  } catch (err) {
    console.error(err);
    setStatus("error: " + err.message);
    setButtons(false);
  }
}

function toggleMute() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => (t.enabled = !micMuted));
  if (btnMute) btnMute.textContent = micMuted ? "Unmute Mic" : "Mute Mic";
}

async function hangUp() {
  setStatus("ending call…");
  try {
    if (pc) {
      pc.close();
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (remoteAudio) remoteAudio.srcObject = null;
    if (remoteCanvasVideo) remoteCanvasVideo.srcObject = null;
  } catch (e) {
    console.warn(e);
  }
  setButtons(false);
  setStatus("idle");
}

if (btnStartAudio) btnStartAudio.addEventListener("click", startCall);
if (btnMute) btnMute.addEventListener("click", toggleMute);
if (btnHangup) btnHangup.addEventListener("click", hangUp);