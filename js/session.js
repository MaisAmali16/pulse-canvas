// js/session.js

const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const codeInput = document.getElementById("sessionCode");

const topics = [
  "What’s something small that made you smile recently, and why did it hit you that way?",
  "What’s a comfort food you love, and what’s the story behind it?",
  "What’s a routine you enjoy, and how did you build it over time?",
  "What’s something you’re looking forward to this week, and why does it matter to you?",
  "What’s a place you feel good in, and what about it creates that feeling?",
  "What’s a song you’ve replayed lately, and what do you think it brings out in you?",
  "Tell a story you always end up telling. Why do you think you keep coming back to it?",
  "Describe a memory that feels like a snapshot. What makes it so vivid to you?",
  "What’s a moment you felt unexpectedly proud of yourself, and what led up to it?",
  "What’s a value you care about more now than before—what changed for you?",
  "What’s a belief you changed your mind about, and what influenced that change?",
  "When do you feel most like yourself, and what about that moment brings it out?",
  "Describe a moment you felt truly understood. What did the other person do that helped?",
  "When you’re stressed, what kind of help actually works for you, and why does it work?",
  "What’s something you’re working on internally these days, and how are you approaching it?",
  "If you could design your perfect day, what happens—and why those choices?",
  "If you could pause time for one hour, how would you use it—and why that?",
  "If you could add one ‘app update’ feature to real life, what would it be—and how would it change your day?",
  "What kind of support feels most meaningful to you, and why does it land better than other kinds?",
  "What do you think makes a friendship last, and why do those things matter to you?"
];

function getRandomTopic() {
  return topics[Math.floor(Math.random() * topics.length)];
}

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
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function goToResults(code) {
  window.location.href = `result.html?session=${encodeURIComponent(code)}`;
}

// Lock the UI and visually "black out" the buttons using the CSS we added
function lockUI() {
  if(createBtn) createBtn.disabled = true;
  if(joinBtn) joinBtn.disabled = true;
  if(codeInput) codeInput.disabled = true;
}

function unlockUI() {
  if(createBtn) createBtn.disabled = false;
  if(joinBtn) joinBtn.disabled = false;
  if(codeInput) codeInput.disabled = false;
}

async function createSession() {
  if (!window.currentUid) {
    setStatus("Not signed in yet — wait 1–2 seconds and try again.", false);
    return;
  }

  lockUI(); // Prevent clicking Join!

  const code = makeCode(6);
  const prefs = getPrefs();
  const randomTopic = getRandomTopic(); // Instantly generate the idea

  const sessionRef = firebase.database().ref("sessions/" + code);

  await sessionRef.set({
    createdAt: Date.now(),
    hostUid: window.currentUid,
    hostPrefs: prefs,
    joinUid: null,
    joinPrefs: null,
    status: "waiting",
    topic: { text: randomTopic, ts: Date.now() }, 
    topicLocked: true
  });

  codeInput.value = code;
  setStatus("Session created! Share this code: " + code);

  // Show the generated topic on the screen so they can read it while waiting
  const topicArea = document.getElementById("topicDisplayArea");
  const topicText = document.getElementById("visibleGeneratedTopic");
  if (topicArea && topicText) {
    topicText.textContent = randomTopic;
    topicArea.style.display = "block";
  }

  sessionRef.on("value", (snap) => {
    const data = snap.val();
    if (!data) return;

    if (data.status === "paired") {
      setStatus("Paired! Redirecting…");
      sessionRef.off();
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

  lockUI(); // Prevent clicking Create!

  const sessionRef = firebase.database().ref("sessions/" + code);
  const snap = await sessionRef.get();

  if (!snap.exists()) {
    setStatus("No session found for that code.", false);
    unlockUI();
    return;
  }

  const prefs = getPrefs();
  const data = snap.val();

  if (data.status === "paired") {
    setStatus("This session is already paired. Try a new code.", false);
    unlockUI();
    return;
  }

  await sessionRef.update({
    joinUid: window.currentUid,
    joinPrefs: prefs,
    status: "paired"
  });

  setStatus("Paired! Redirecting…");
  setTimeout(() => goToResults(code), 600);
}

createBtn?.addEventListener("click", () => {
  createSession().catch((e) => {
    console.error(e);
    setStatus("Create ERROR: " + e.message, false);
    unlockUI();
  });
});

joinBtn?.addEventListener("click", () => {
  joinSession().catch((e) => {
    console.error(e);
    setStatus("Join ERROR: " + e.message, false);
    unlockUI();
  });
});