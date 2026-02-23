// js/session.js
// Creates / joins a session code, then redirects both participants to:
// result.html?session=XXXXXX
// WebRTC call + visuals will run on the Results page.

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const codeInput = document.getElementById("sessionCode");

function setStatus(msg, ok = true) {
  const el = document.getElementById("status");
  if (!el) return;
  el.style.color = ok ? "lime" : "red";
  el.textContent = msg;
}

function getPrefs() {
  // Keep this for accessibility settings (sound-free mode)
  // You can expand later if you add more settings.
  const soundPref = document.getElementById("soundPref")?.value || "sound";
  return { soundPref };
}

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function goToResults(code) {
  // Keep it simple: Results page reads session from URL
  window.location.href = `result.html?session=${encodeURIComponent(code)}`;
}

async function createSession() {
  if (!window.currentUid) {
    setStatus("Not signed in yet — wait 1–2 seconds and try again.", false);
    return;
  }

  const code = makeCode(6);
  const prefs = getPrefs();

  const sessionRef = firebase.database().ref("sessions/" + code);

  await sessionRef.set({
    createdAt: Date.now(),
    hostUid: window.currentUid,
    hostPrefs: prefs,
    joinUid: null,
    joinPrefs: null,
    status: "waiting"
  });

  // Show code to host
  codeInput.value = code;
  setStatus("Session created. Share this code: " + code);

  // Listen for a joiner
  sessionRef.on("value", (snap) => {
    const data = snap.val();
    if (!data) return;

    if (data.status === "paired") {
      setStatus("Paired! Redirecting…");
      // Stop listening once paired (prevents duplicate redirects)
      sessionRef.off();
      // Short delay so the user sees the message
      setTimeout(() => goToResults(code), 600);
    }
  });
}

async function joinSession() {
  if (!window.currentUid) {
    setStatus("Not signed in yet — wait 1–2 seconds and try again.", false);
    return;
  }

  const code = (codeInput.value || "").trim().toUpperCase();
  if (!code) {
    setStatus("Enter a session code first.", false);
    return;
  }

  const sessionRef = firebase.database().ref("sessions/" + code);
  const snap = await sessionRef.get();

  if (!snap.exists()) {
    setStatus("No session found for that code.", false);
    return;
  }

  const prefs = getPrefs();
  const data = snap.val();

  // Block joining if already paired
  if (data.status === "paired") {
    setStatus("This session is already paired. Try a new code.", false);
    return;
  }

  // Write join info
  await sessionRef.update({
    joinUid: window.currentUid,
    joinPrefs: prefs,
    status: "paired"
  });

  setStatus("Paired! Redirecting…");
  setTimeout(() => goToResults(code), 600);
}

// Button listeners
createBtn?.addEventListener("click", () => {
  createSession().catch((e) => {
    console.error(e);
    setStatus("Create ERROR: " + e.message, false);
  });
});

joinBtn?.addEventListener("click", () => {
  joinSession().catch((e) => {
    console.error(e);
    setStatus("Join ERROR: " + e.message, false);
  });
});

// Optional: keep global functions for inline onclick (if ever used)
window.createSession = createSession;
window.joinSession = joinSession;