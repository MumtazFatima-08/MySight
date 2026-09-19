# MySight 👁️

### Voice-first indoor wayfinding for blind and low-vision users

**MySight turns a phone camera into a voice-first visual assistant for navigating indoor spaces.**

> **See → Understand → Speak → Warn**

Instead of requiring a complex touchscreen workflow, MySight combines voice input, camera vision, OCR and spoken feedback for questions such as:

- “What do you see?”
- “Find a chair.”
- “Where is the pharmacy?”
- “Which way?”
- “Read this.”
- “Stop.”

## Why MySight?

The last few metres inside a building can be difficult even after reaching the correct location. Hospitals, colleges, government offices and public buildings contain signs, counters, rooms, people and everyday obstacles that can be difficult to identify without sight.

MySight focuses on this **indoor, last-mile problem** with a browser-based prototype requiring no backend, account or API key.

## Core Features

### 🔎 Ask What You See
On-demand scene description from the live camera feed using object detection.

### 🎯 Find an Object
Say **“Find a chair”** or another supported object. When the model detects it, MySight reports its approximate **left / center / right** position and rough closeness.

### 🪧 Find a Sign / Destination
For targets outside the supported object classes, MySight can fall back to OCR. For example:

**“Find Pharmacy” → camera → OCR → target text → approximate position**

### 📖 Read This
Point the camera toward text and say **“Read this.”** Tesseract.js extracts visible text and MySight speaks the result.

### 🚨 Independent Safety Alerts
A separate safety loop checks supported objects that appear close and in the walking path. Safety messages can pre-empt normal narration.

Example: **“STOP. Person directly ahead.”**

### 🗣️ Natural Voice Commands
Multiple phrasings map to the same intent instead of relying on one exact sentence.

| Intent | Examples |
|---|---|
| Describe | “What do you see?” / “What’s in front of me?” |
| Find | “Find a chair” / “Where is a chair?” |
| Read | “Read this” / “Read the sign” |
| Direction | “Which way?” |
| Control | “Stop” / “Cancel” / “Repeat that” |
| Help | “Help” |

### 📳 Haptic Feedback
Where supported, vibration is used for important events such as interaction, target detection and safety alerts.

## How It Works

```text
Camera + Mic
     ↓
Intent Parser
     ↓
┌───────────────┬───────────────┬───────────────┐
│ Scene/Object  │ OCR / Sign    │ Read Text     │
│ Search        │ Search        │ On Demand     │
└───────────────┴───────────────┴───────────────┘
     ↓
Context + State
     ↓
Speech Manager
     ↓
Voice Feedback

Independent Safety Loop
Detect → Prioritize → Interrupt → Warn
```

## Technical Architecture

The application is modular even though it is a static web app.

### SpeechManager
- Single spoken-output queue
- Safety messages can pre-empt normal speech
- Recognition pauses while speaking
- Watchdog recovery prevents a stuck speaking state

### RecognitionManager
- Single SpeechRecognition instance
- Guards against duplicate starts
- Handles permission, no-speech and network errors
- Recovers after speech output

### VisionManager
- Camera lifecycle and retry handling
- COCO-SSD object detection
- Scene description
- Hazard detection
- Hysteresis to reduce repeated / flickering alerts

### OCRManager
- Tesseract.js OCR
- Throttled processing
- Busy lock prevents overlapping OCR jobs
- Bounding-box position used for sign location

### IntentParser / Commands
Converts natural language into actions such as:

```text
describe / find / read / direction / stop / repeat / help
```

### Context
Maintains short-term state such as:

- `currentIntent`
- `currentTarget`
- `lastObservation`
- `lastSpokenMessage`
- `mode`

This enables follow-ups such as **“Find the chair” → “Which way?”** without repeating the destination.

## Tech Stack

| Layer | Technology |
|---|---|
| UI | HTML + CSS |
| Application logic | Vanilla JavaScript |
| Object detection | TensorFlow.js + COCO-SSD |
| OCR | Tesseract.js |
| Voice input | Web Speech API |
| Voice output | SpeechSynthesis API |
| Backend | None |
| API keys | None required |

## Project Structure

```text
MySight/
├── index.html
├── diagnostics.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── .gitignore
└── README.md
```

### Diagnostics

`diagnostics.html` is a separate verification page for:

- Secure context
- Camera
- Microphone
- Speech recognition
- Speech synthesis
- AI model loading

For internal debugging, the main app supports `?debug=1` to expose runtime state and recent errors without changing the normal user experience.

## Browser Requirements

**Recommended:** Chrome on Android over HTTPS.

Important platform constraints:

- Camera and microphone require **HTTPS or localhost**
- Speech recognition support varies by browser
- COCO-SSD recognizes a fixed set of **80 COCO object categories**
- Doors, walls and windows are not guaranteed to be recognized by this model
- No depth sensor is used
- Position is reported as left / center / right rather than a fabricated distance in metres

## Safety & Responsible Design

MySight is an accessibility prototype, **not a certified mobility or medical device**.

The system deliberately avoids claims it cannot verify. It does **not**:

- Claim that a road is safe to cross
- Provide fake GPS navigation
- Invent metre-level distances
- Pretend to recognize unsupported objects
- Present heuristic obstacle detection as guaranteed safety
- Replace a mobility aid or human assistance

The safety detector is a heuristic based on supported object detections, position and bounding-box size. **False negatives are possible.**

## Demo Flow

1. Start MySight.
2. Ask **“What do you see?”**
3. Say **“Find a chair.”**
4. Put a supported object in view.
5. Show a printed **“Pharmacy”** sign and ask **“Find Pharmacy.”**
6. Ask **“Which way?”**
7. Point at visible text and say **“Read this.”**
8. Put a supported object/person in the lower-center view to demonstrate the safety interrupt.
9. Say **“Stop.”**

The intended responses come from the live camera / OCR pipeline rather than canned demo sentences.

## Known Limitations

### Vision
COCO-SSD is limited to its supported object categories. It is not a general-purpose indoor navigation model.

### Distance
There is no depth camera or depth-estimation pipeline. “Close” is an approximate visual heuristic, not a measured distance.

### OCR
OCR quality depends on lighting, focus, text size, angle and contrast.

### Speech
Browser speech recognition can vary by device, browser, permissions and network conditions.

### Safety
The safety detector can miss hazards that the underlying model cannot recognize.

## Running Locally

Camera and microphone access should not be tested by simply opening the file with `file://`.

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

For public use, deploy through an HTTPS host such as GitHub Pages.

## Design Principle

MySight is intentionally not a dashboard full of controls. The primary interaction is:

```text
USER
  │ voice
  ▼
MYSIGHT
  ├── understands the request
  ├── checks the camera
  ├── identifies supported visual evidence
  ├── prioritizes safety alerts
  └── speaks the result
```

The goal is to keep the interaction and cognitive load low for the person using it.

## Current Status

**Prototype:** Browser-based accessibility prototype  
**Focus:** Voice-first indoor visual assistance  
**Deployment:** Static web application  
**Backend:** Not required  
**API keys:** Not required

The project documents its model boundaries and browser limitations instead of presenting unsupported capabilities as working features.

## Repository

**GitHub:** [MumtazFatima-08/MySight](https://github.com/MumtazFatima-08/MySight)
