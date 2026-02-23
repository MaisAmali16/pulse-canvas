// js/result-call.js
// WebRTC voice call using Firebase Realtime Database as signaling.
// Works best on HTTPS (GitHub Pages).

let pc = null;
let localStream = null;
let sessionRef = null;
let myRole = null; // "host" or "guest"
let micMuted = false;

const statusEl = document.getElementById("callStatus");
const remoteAudio = document.getElementById("remoteAudio");

const btnStartAudio = document.getElementById("btnStartAudio");
const btnMute = document.getElementById("btnMute");
const btnHangup = document.getElementById("btnHangup");

function setStatus(msg) {
  statusEl.textContent = `Status: ${msg}`;
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

// Assign roles safely using a transaction so both laptops don’t become "host".
async function assignRole(db, code, uid) {
  const participantsRef = db.ref(`sessions/${code}/call/participants`);

  await participantsRef.transaction((p) => {
    p = p || {};
    if (p[uid]) return p; // keep role if already assigned

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

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    remoteAudio.srcObject = stream;
    setStatus("remote audio connected");
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const candPath = (myRole === "host") ? "hostCandidates" : "guestCandidates";
    sessionRef.child(candPath).push(event.candidate.toJSON());
  };

  localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  setStatus("mic ready");
}

async function hostFlow() {
  setStatus("host: creating offer…");

  // Clean old signaling (helps if someone reloaded)
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

  // Answer listener
  sessionRef.child("answer").on("value", async (snap) => {
    const ans = snap.val();
    if (!ans || !pc || pc.currentRemoteDescription) return;
    await pc.setRemoteDescription(new RTCSessionDescription(ans));
    setStatus("call live");
  });

  // Guest ICE listener
  sessionRef.child("guestCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand || !pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
    catch (e) { console.warn("addIceCandidate failed", e); }
  });
}

async function guestFlow() {
  setStatus("guest: waiting for offer…");

  // Wait until offer exists
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

  // Host ICE listener
  sessionRef.child("hostCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand || !pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); }
    catch (e) { console.warn("addIceCandidate failed", e); }
  });
}

function setButtons(inCall) {
  btnStartAudio.disabled = inCall;
  btnMute.disabled = !inCall;
  btnHangup.disabled = !inCall;
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
  btnMute.textContent = micMuted ? "Unmute Mic" : "Mute Mic";
}

async function hangUp() {
  setStatus("ending call…");
  try {
    if (pc) pc.close();
    pc = null;

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    remoteAudio.srcObject = null;

    // NOTE: We do NOT delete the session automatically here,
    // because it can break the other person mid-call.
  } catch (e) {
    console.warn(e);
  }
  setButtons(false);
  setStatus("idle");
}

btnStartAudio.addEventListener("click", startCall);
btnMute.addEventListener("click", toggleMute);
btnHangup.addEventListener("click", hangUp);