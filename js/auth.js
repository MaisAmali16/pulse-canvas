// js/auth.js
const statusEl = document.getElementById("status");

function setStatus(msg, ok = true) {
  if (!statusEl) return;
  statusEl.style.color = ok ? "lime" : "red";
  statusEl.textContent = msg;
}

window.currentUid = null;

// Sign in anonymously as soon as page loads
firebase.auth().signInAnonymously()
  .then((cred) => {
    window.currentUid = cred.user.uid;
    setStatus("Firebase OK. Signed in.");
    console.log("Signed in UID:", window.currentUid);
  })
  .catch((err) => {
    console.error("Auth error:", err);
    setStatus("Firebase Auth ERROR: " + err.message, false);
  });
