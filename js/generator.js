const topics = [
  "Describe a moment you felt truly understood.",
  "What is something small that affects your mood a lot?",
  "Talk about a time you changed your perspective.",
  "What boundary have you learned to set recently?",
  "What do you wish people understood about you?",
  "Share a recent emotional challenge and what it taught you.",
  "When do you feel most safe being yourself?",
  "What is something you are quietly proud of?",
  "Describe a moment you felt deeply connected to someone.",
  "What helps you feel calm during stress?"
];

function getRandomTopic() {
  const index = Math.floor(Math.random() * topics.length);
  return topics[index];
}

document.addEventListener("DOMContentLoaded", () => {
  const topicBox = document.getElementById("generatedTopic");
  const btn = document.getElementById("generateBtn");

  if (!topicBox || !btn) return;

  btn.addEventListener("click", () => {
    topicBox.textContent = getRandomTopic();
  });
});
