// js/generator.js
// Pulse Canvas – Topic Generator (random + confirm required)

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

let lastIndex = -1;
let currentTopic = "";

function getRandomTopic() {
  if (topics.length === 0) return "No topics available.";
  if (topics.length === 1) return topics[0];

  let index = Math.floor(Math.random() * topics.length);
  if (index === lastIndex) {
    index = (index + 1 + Math.floor(Math.random() * (topics.length - 1))) % topics.length;
  }
  lastIndex = index;
  return topics[index];
}

document.addEventListener("DOMContentLoaded", () => {
  const topicBox = document.getElementById("generatedTopic");
  const btnGen = document.getElementById("generateBtn");
  const btnConfirm = document.getElementById("confirmBtn");
  const status = document.getElementById("topicStatus");
  const nextBtn = document.getElementById("nextBtn");

  if (!topicBox || !btnGen || !btnConfirm || !status || !nextBtn) return;

  // If they already confirmed earlier (refresh), restore it
  const confirmed = sessionStorage.getItem("pulse_topic_confirmed");
  if (confirmed) {
    currentTopic = confirmed;
    topicBox.textContent = confirmed;
    btnConfirm.disabled = true;
    status.textContent = "Topic selected.";
    nextBtn.setAttribute("aria-disabled", "false");
  } else {
    status.textContent = "Generate a topic, then click “Use this topic”.";
    nextBtn.setAttribute("aria-disabled", "true");
  }

  // Block Next unless confirmed
  nextBtn.addEventListener("click", (e) => {
    const ok = !!sessionStorage.getItem("pulse_topic_confirmed");
    if (!ok) {
      e.preventDefault();
      status.textContent = "Please select a topic first (click “Use this topic”).";
    }
  });

  btnGen.addEventListener("click", () => {
    currentTopic = getRandomTopic();
    topicBox.textContent = currentTopic;
    btnConfirm.disabled = false;
    status.textContent = "If you both agree, click “Use this topic”.";
  });

  btnConfirm.addEventListener("click", () => {
    if (!currentTopic) {
      status.textContent = "Generate a topic first.";
      return;
    }
    sessionStorage.setItem("pulse_topic_confirmed", currentTopic);
    btnConfirm.disabled = true;
    status.textContent = "Topic selected.";
    nextBtn.setAttribute("aria-disabled", "false");
  });
});