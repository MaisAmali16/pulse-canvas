// js/firebase.js
// Uses Firebase "compat" SDK loaded via <script> tags in HTML

const firebaseConfig = {
  apiKey: "AIzaSyCIN2J2JhJoXM9h751i0EuXK7Mpvn94iJk",
  authDomain: "pulse-canvas-4700.firebaseapp.com",
  databaseURL: "https://pulse-canvas-4700-default-rtdb.firebaseio.com",
  projectId: "pulse-canvas-4700",
  storageBucket: "pulse-canvas-4700.firebasestorage.app",
  messagingSenderId: "542633123171",
  appId: "1:542633123171:web:85c81743a1edf1c568c756"
};

// Initialize Firebase once
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
