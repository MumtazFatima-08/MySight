# MySight

Voice-first indoor wayfinding for blind and low-vision users — built for
BuildForge Hackathon 2026.

## Project structure

```
index.html            Entry point — markup only
css/style.css         All styling
js/app.js             All application logic (camera, detection, voice)
diagnostics.html       Standalone page to test each browser capability separately
README.md
```

No build step, no dependencies to install. It's a static site — open
`index.html` (served over HTTPS or localhost) and it runs.

## Problem

Blind and low-vision users can reach the right building but still struggle
with the last few metres: finding the correct room, counter, or facility
inside hospitals, government offices, and college campuses.

Because the target user cannot operate a touchscreen UI to type a
destination, **the entire interaction is voice-in, voice-out.** The only
touch input in the whole app is a single large button to start.

## How it works

1. Tap **Start**. This requests camera and microphone permission.
2. MySight asks out loud: *"Where do you want to go, or what are you looking
   for?"*
3. Say a destination. Two paths, decided automatically:
   - If it matches one of the 80 object classes the vision model knows
     (chair, tv, laptop, cup, bottle, remote, book, clock, etc.) → MySight
     watches for that **object** and announces its direction when spotted.
   - Otherwise → MySight treats it as a **sign** and reads text in the frame
     with OCR, watching for that word.
4. A safety loop runs continuously and independently, interrupting with
   "Obstacle ahead, move slightly left/right" whenever something is close
   and in the lower-center of the frame — this always takes priority over
   normal narration.
5. It keeps listening quietly in the background afterward — no need to tap
   the mic again for a follow-up question.

Guidance is deliberately imprecise by design: "move slightly left," never a
fabricated centimetre measurement.

## Implementation

- **Obstacle + object detection**: TensorFlow.js + COCO-SSD, on-device.
- **Sign reading**: Tesseract.js OCR on captured frames.
- **Voice in**: Web Speech API `SpeechRecognition`.
- **Voice out**: Web Speech API `SpeechSynthesisUtterance`, with a warm-up
  utterance fired synchronously on the start tap (Android Chrome silently
  drops `speak()` calls that aren't tightly coupled to a user gesture or
  called before the voice list has loaded).
- No backend, no API keys.

## Known browser constraints (not bugs — platform limits)

- **HTTPS or localhost required.** Camera and mic are blocked entirely on
  plain `file://` pages. Use GitHub Pages, or a local server
  (`python3 -m http.server`).
- **Voice input needs Chrome.** `SpeechRecognition` has little to no support
  in Safari on iOS. Use Chrome on Android for the most reliable results.
- **Object detection only knows 80 categories** (COCO dataset). Common misses
  like "door," "wall," or "window" are outside that list — no code fix makes
  those detectable with this model. Full list is in `js/app.js`.

## If something isn't working: run diagnostics first

Open `diagnostics.html` on the same device before assuming the app is
broken. It tests, one at a time: secure context, camera permission,
microphone permission, speech recognition support, a live recognition
sample, text-to-speech playback, and both AI models loading — each with a
pass/fail and the exact error message. Copy the results with the button at
the bottom.

## Demo script

1. Tap Start → "Where do you want to go?"
2. Say "Find the chair" → object mode → "Chair spotted, ahead, close by."
3. Say "Find Pharmacy" (with a printed sign in view) → sign mode → "Pharmacy
   ahead."
4. Walk toward an obstacle → safety interrupt fires automatically,
   pre-empting any other narration.

## Tech stack

HTML, CSS, vanilla JavaScript, TensorFlow.js, COCO-SSD, Tesseract.js, Web
Speech API.
