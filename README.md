Pulse Canvas

Pulse Canvas is an interactive, two-person experience that explores how emotional expression can be translated into abstract visual forms to support empathy and reflective communication. The project combines biometric, vocal, and expressive data with generative visuals to create a shared emotional space between participants.

Rather than labeling or classifying emotions directly, Pulse Canvas uses abstraction to encourage interpretation, attentiveness, and emotional awareness during conversation.



Project Concept

Pulse Canvas is designed for two participants who engage in a guided conversation while their physiological and expressive signals are translated into generative visuals. Each participant views the other person’s visual output, shifting attention outward and reinforcing the project’s focus on empathy rather than self-monitoring.

The experience emphasizes:

Emotional presence rather than emotional labeling
Interpretation rather than instruction
Accessibility and sensory comfort during interaction

Abstract visuals are used intentionally to avoid prescriptive or judgment-based representations of emotion, allowing participants to reflect on emotional dynamics in a more open-ended way.



Interaction Flow

Participants access the website on their own devices.
The website introduces the experience and provides instructions.
One participant creates a session code; the other joins using that code.
Participants select basic comfort preferences (e.g., sound or sound-free mode).
After pairing, both participants are routed to the results page.
Each participant views their conversation partner’s generative visual output.

The website acts as both an entry point and a coordination layer, guiding participants through the experience and simplifying the physical setup of the installation.



Technical Overview

Frontend: HTML, CSS, JavaScript
Generative Visuals: p5.js
Backend Services: Firebase
Anonymous authentication (no personal data required)
Session pairing using shared codes

Data Inputs (in development):

Heart-rate data via pulse sensors
Voice-based features (pitch, loudness, speech rate)
Facial expression data 

The project is designed to be modular, allowing data sources and visual mappings to evolve throughout development.



Accessibility Considerations

Accessibility is treated as a core design principle rather than an afterthought. Current considerations include:
A sound-free interaction option for participants sensitive to audio stimuli
Visual design guidelines that avoid sudden flashes or abrupt motion
Gradual visual transitions to support emotional continuity
These decisions aim to support a wide range of participants while preserving the emotional intent of the experience.



Current Status

This repository contains the current implementation of the project website, including:

Page structure and navigation
Participant pairing logic
Result page setup with embedded p5 sketches (temporary placeholder)
Styling and layout aligned with the project’s visual direction
Live generative visuals and full sensor integration are under active development and will replace placeholder elements in future iterations.



Future Development

Planned next steps include:
Merging heart-rate, voice, and facial expression data into a single visual system
Refining visual mappings to ensure smooth and coherent multimodal interaction
Improving sensor reliability and data normalization
Replacing placeholder p5 sketches with finalized generative artwork



Team Contributions

This project is developed collaboratively by a group of students, with shared responsibility across research, technical development, visual prototyping, physical modeling, and documentation.



Notes

Pulse Canvas is an academic project developed for coursework. It is intended for experimental, exploratory, and educational purposes.
