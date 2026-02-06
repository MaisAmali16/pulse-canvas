// js/session.js

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
  const soundPref = document.getElementById("soundPref")?.value || "sound";
  return { soundPref };
}

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Decide which results-mode to use
function pickMode(prefs) {
  if (!prefs) return "sound";
  if (prefs.soundPref === "silent") return "silent";
  return "sound";
}

async function createSession() {
  if (!window.currentUid) {
    setStatus("Not signed in yet—wait 1–2 seconds and try again.", false);
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

  codeInput.value = code;
  setStatus("Session created. Share this code: " + code);

  // Auto-listen for someone joining
  sessionRef.on("value", (snap) => {
    const data = snap.val();
    if (data && data.status === "paired") {
      setStatus("Paired! Redirecting…");
      const mode = pickMode(data.joinPrefs);
      window.location.href = `result.html?session=${code}&role=host&mode=${mode}`;
    }
  });
}

async function joinSession() {
  if (!window.currentUid) {
    setStatus("Not signed in yet—wait 1–2 seconds and try again.", false);
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

  if (data.status === "paired") {
    setStatus("This session is already paired. Try a new code.", false);
    return;
  }

  await sessionRef.update({
    joinUid: window.currentUid,
    joinPrefs: prefs,
    status: "paired"
  });

  setStatus("Paired! Redirecting…");

  const mode = pickMode(prefs);
  window.location.href = `result.html?session=${code}&role=join&mode=${mode}`;
}

createBtn?.addEventListener("click", () =>
  createSession().catch((e) => {
    console.error(e);
    setStatus("Create ERROR: " + e.message, false);
  })
);

joinBtn?.addEventListener("click", () =>
  joinSession().catch((e) => {
    console.error(e);
    setStatus("Join ERROR: " + e.message, false);
  })
);

// Optional: keep global functions if you ever use inline onclick
window.createSession = createSession;
window.joinSession = joinSession;
