// js/topic-sync.js
// Publishes a confirmed topic into the session once, then displays it for both participants.
// Session location: sessions/{code}/topic.text and sessions/{code}/topicLocked

document.addEventListener("DOMContentLoaded", async () => {
  const code = (window.__PULSE_SESSION__ || "").trim();

  const topicEl = document.getElementById("topicText");
  const statusEl = document.getElementById("topicStatus");
  const startBtn = document.getElementById("btnStartAudio");

  if (!topicEl || !statusEl) return;

  function setStatus(msg, ok = true) {
    statusEl.style.color = ok ? "rgba(200,255,200,0.9)" : "rgba(255,180,180,0.95)";
    statusEl.textContent = msg;
  }

  if (!code) {
    topicEl.textContent = "No session found.";
    setStatus("Go back and join a session from the Connect page.", false);
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const sessionRef = firebase.database().ref("sessions/" + code);

  // Keep UI live
  sessionRef.on("value", (snap) => {
    const data = snap.val() || {};
    const topic = data.topic?.text || "";
    const locked = !!data.topicLocked;

    if (topic) {
      topicEl.textContent = topic;
      setStatus(locked ? "Topic locked." : "Topic set.");
      if (startBtn) startBtn.disabled = false;
    } else {
      topicEl.textContent = "No topic selected yet.";
      setStatus("Please go back and select a topic, then return to the session.", false);
      if (startBtn) startBtn.disabled = true;
    }
  });

  // Try to publish confirmed topic (only if session doesn't already have one)
  const confirmed = (sessionStorage.getItem("pulse_topic_confirmed") || "").trim();

  await sessionRef.transaction((current) => {
    if (!current) return current;            // do not create sessions here
    if (current.topicLocked) return;         // already locked
    if (current.topic?.text) return;         // topic already chosen

    if (!confirmed) return;                  // no confirmed topic -> do nothing

    return {
      ...current,
      topic: { text: confirmed, ts: Date.now() },
      topicLocked: true
    };
  });

  // Clear confirmed topic locally after attempting publish
  // (safe even if topic was already set by the other participant)
  sessionStorage.removeItem("pulse_topic_confirmed");
});