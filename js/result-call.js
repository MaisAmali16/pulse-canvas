let pc = null;
let localStream = null;
let sessionRef = null;
let myRole = null;
let micMuted = false;
let callStarted = false;

const callStatusEl = document.getElementById("callStatus");
const remoteAudio = document.getElementById("remoteAudio");
const remoteCanvasVideo = document.getElementById("remoteCanvasStream");

const btnStartAudio = document.getElementById("btnStartAudio");
const btnMute = document.getElementById("btnMute");
const btnHangup = document.getElementById("btnHangup");

function setStatus(msg) {
  if (callStatusEl) callStatusEl.textContent = `Status: ${msg}`;
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
    const role = count === 0 ? "host" : "guest";

    p[uid] = { role, joinedAt: Date.now() };
    return p;
  });

  const snap = await participantsRef.child(`${uid}/role`).get();
  return snap.val() || "guest";
}

async function waitForCanvas() {
  return new Promise((resolve) => {
    let tries = 0;

    const check = () => {
      const canvas =
        document.querySelector(".p5Canvas") ||
        document.getElementById("defaultCanvas0");

      if (canvas && canvas.width > 0) {
        resolve(canvas);
        return;
      }

      tries++;
      if (tries > 50) {
        console.warn("Canvas never appeared");
        resolve(null);
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

async function initPeerConnection(db, code) {
  sessionRef = db.ref(`sessions/${code}/call/webrtc`);
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.ontrack = (event) => {
    const track = event.track;
    const stream = event.streams[0];

    if (track.kind === "audio") {
      if (remoteAudio) {
        remoteAudio.srcObject = stream;
        remoteAudio.muted = false;
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true;
      }
      setStatus("Remote audio connected");
    }

    if (track.kind === "video") {
      if (remoteCanvasVideo) {
        remoteCanvasVideo.srcObject = stream;
        remoteCanvasVideo.muted = true;
        remoteCanvasVideo.autoplay = true;
        remoteCanvasVideo.playsInline = true;

        remoteCanvasVideo.onloadedmetadata = () => {
          remoteCanvasVideo.play().catch(() => {});
        };
      }

      setStatus("Remote canvas connected");
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const candPath = myRole === "host" ? "hostCandidates" : "guestCandidates";
    sessionRef.child(candPath).push(event.candidate.toJSON());
  };

  // MIC
  try {
    localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    setStatus("Mic ready");
  } catch (err) {
    console.error("Mic error:", err);
    setStatus("Mic denied or unavailable");
  }

  // WAIT FOR P5 CANVAS
  const localCanvas = await waitForCanvas();

  if (localCanvas) {
    try {
      const canvasStream = localCanvas.captureStream(30);

      canvasStream.getTracks().forEach(track => {
        pc.addTrack(track, canvasStream);
      });

      setStatus("Mic & Canvas streaming");
    } catch (e) {
      console.error("Canvas capture error:", e);
    }
  } else {
    console.warn("Canvas not found");
  }
}

async function hostFlow() {
  setStatus("Host creating offer");

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

  sessionRef.child("answer").on("value", async (snap) => {
    const ans = snap.val();
    if (!ans) return;
    if (pc.currentRemoteDescription) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(ans));
      setStatus("Call live");
    } catch (e) {
      console.warn("Answer already applied");
    }
  });

  sessionRef.child("guestCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch {}
  });
}

async function guestFlow() {
  setStatus("Waiting for host");

  sessionRef.child("offer").on("value", async (snap) => {
    const offer = snap.val();
    if (!offer) return;
    if (pc.currentRemoteDescription) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
    } catch {
      return;
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await sessionRef.child("answer").set({
      type: answer.type,
      sdp: answer.sdp,
      ts: Date.now()
    });

    setStatus("Call live");
  });

  sessionRef.child("hostCandidates").on("child_added", async (snap) => {
    const cand = snap.val();
    if (!cand) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch {}
  });
}

function setButtons(inCall) {
  if (btnStartAudio) btnStartAudio.disabled = inCall;
  if (btnMute) btnMute.disabled = !inCall;
  if (btnHangup) btnHangup.disabled = !inCall;
}

async function startCall() {
  if (callStarted) return;
  callStarted = true;

  const code = (window.__PULSE_SESSION__ || "").trim();

  if (!code) {
    setStatus("Missing session code");
    return;
  }

  try {
    const user = await ensureAnonAuth();
    const db = firebase.database();

    myRole = await assignRole(db, code, user.uid);

    await initPeerConnection(db, code);
    setButtons(true);

    if (myRole === "host") {
      await hostFlow();
    } else {
      await guestFlow();
    }

  } catch (err) {
    console.error(err);
    setStatus("Error starting call");
    setButtons(false);
  }
}

function toggleMute() {
  if (!localStream) return;

  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => (t.enabled = !micMuted));

  if (btnMute) {
    btnMute.textContent = micMuted ? "Unmute Mic" : "Mute Mic";
  }
}

async function hangUp() {
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());

  if (remoteAudio) remoteAudio.srcObject = null;
  if (remoteCanvasVideo) remoteCanvasVideo.srcObject = null;

  setButtons(false);
  setStatus("Idle");
}

btnMute?.addEventListener("click", toggleMute);
btnHangup?.addEventListener("click", hangUp);