# MySight

Voice-first indoor wayfinding for blind and low-vision users — built for
BuildForge Hackathon 2026.

## Project structure

```
index.html            Entry point — markup only
css/style.css         All styling
js/app.js             Application logic: state machine + manager modules
diagnostics.html       Standalone page to test each browser capability separately
README.md
```

No build step, no dependencies to install. It's a static site — open
`index.html` (served over HTTPS or localhost) and it runs.

## Architecture

`js/app.js` is organized as independent manager modules, each owning one
concern, coordinated through an explicit state machine
(`IDLE → STARTING → READY → LISTENING/THINKING/SPEAKING/SEARCHING_OBJECT/
SEARCHING_SIGN/SAFETY_ALERT/ERROR`):

- **SpeechManager** — single output queue. Safety messages clear the queue
  and pre-empt everything else. A watchdog timer guarantees `speaking` is
  never stuck `true` even if a browser fails to fire `onend`. Recognition is
  paused before speaking and resumed after, so the app never listens to
  itself.
- **RecognitionManager** — exactly one `SpeechRecognition` instance, guarded
  against double-starts, with error-specific handling (permission denied,
  no-speech, network) and automatic — not infinite — restart after each
  result or after speech output finishes.
- **VisionManager** — camera lifecycle (start/retry/stream-ended recovery),
  the continuous object-detection loop, hazard detection with hysteresis
  (requires two consecutive frames before announcing a hazard or an
  all-clear, to avoid flicker/spam), and on-demand scene description.
- **OCRManager** — sign search (throttled, busy-locked so overlapping OCR
  calls can't stack up) and on-demand "read this."
- **IntentParser / Commands** — turns natural phrases into one of: describe
  scene, find (object or sign), read this, which way, stop, repeat, help, or
  an honest "I don't understand that" — never a hardcoded single-phrase
  match.
- **Context** — `currentIntent`, `currentTarget`, `lastObservation`,
  `lastSpokenMessage`, `mode`, enabling follow-ups like "which way?" without
  repeating the destination.

## Problem

Blind and low-vision users can reach the right building but still struggle
with the last few metres: finding the correct room, counter, or facility
inside hospitals, government offices, and college campuses.

Because the target user cannot operate a touchscreen UI to type a
destination, **the entire interaction is voice-in, voice-out.** The only
touch input in the whole app is a single large button to start.

## How it works

1. Tap **Start**. This requests camera and microphone permission and runs
   a startup sequence: start camera → verify video frames are flowing →
   check speech synthesis → check speech recognition → load the object
   detection model → check OCR availability. Any failure is spoken clearly
   with what to do about it — nothing fails silently.
2. MySight asks out loud: *"Where do you want to go, or what are you looking
   for?"* — and now understands many phrasings, not one fixed sentence:
   "what do you see," "what's in front of me," "find X," "where is X," "read
   this," "read everything," "which way," "stop," "repeat that," "help."
3. Say a destination. Two paths, decided automatically:
   - If it matches one of the 80 object classes the vision model knows
     (chair, tv, laptop, cup, bottle, remote, book, clock, etc.) → MySight
     watches for that **object** and announces direction (left/center/right)
     and rough closeness when spotted.
   - Otherwise → MySight is honest that it can't visually recognize that as
     an object, and instead reads text in the frame with OCR, watching for
     that word, and reports its position from the OCR bounding box.
4. A safety loop runs continuously and independently of whatever else is
   happening, interrupting with "STOP, [object] directly ahead" or "[object]
   on your left/right" whenever something is close and in the lower-center
   of the frame — this always pre-empts normal narration, and says "The path
   appears clear" once it's gone.
5. It keeps listening quietly in the background afterward — no need to tap
   the mic again for a follow-up question. The mic button is a manual
   override, not a requirement.
6. If voice recognition isn't supported in the browser at all, on-screen
   fallback buttons ("What do you see," "Find a chair," "Read this," "Stop")
   appear automatically so the app degrades gracefully instead of going
   silent.

Guidance is deliberately imprecise by design: "move slightly left" or "on
your right," never a fabricated centimetre measurement or a made-up
confidence score.

Vibration feedback accompanies key events where the device supports it: a
short buzz on manual mic tap, a double buzz when a searched-for object or
sign is found, a long buzz on a new safety hazard.

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

## Honest limitations (stated directly, not hidden)

- **No depth sensing.** Positions are left/center/right and a rough
  "close by" vs. not, derived from bounding-box position and size — never a
  fabricated distance in metres.
- **No dedicated road-crossing logic.** The app does not attempt to judge
  whether it's safe to cross a road. A query like "is it safe to cross?"
  doesn't match any recognized intent and falls through to the generic "I
  can help you find objects, describe what's around you, or read text"
  response — it will never claim a crossing is safe, because that
  determination was never built, rather than because it was specifically
  blocked.
- **Hazard detection is a heuristic, not a certified safety system.** It
  flags COCO-recognized objects that are large-in-frame and in the lower
  part of the view as likely obstacles. It will miss real hazards outside
  its 80 known classes (steps, low branches, open manholes) and can be
  fooled by unusual framing. It is a prototype aid, not a mobility device.
- **OCR confidence is approximate.** Low-confidence text is reported as
  such ("I see some text, but I can't read it confidently") rather than
  guessed at, but the confidence score itself is Tesseract's own estimate,
  not independently validated.

## If something isn't working: run diagnostics first

Open `diagnostics.html` on the same device before assuming the app is
broken. It tests, one at a time: secure context, camera permission,
microphone permission, speech recognition support, a live recognition
sample, text-to-speech playback, and both AI models loading — each with a
pass/fail and the exact error message. Copy the results with the button at
the bottom.

For a live look at internal state while using the actual app (separate from
the blind-user experience — it's off by default), open it with `?debug=1`
appended to the URL, e.g. `index.html?debug=1`. It shows camera/model/OCR/mic
status, current app state, the last recognized command, live detections, the
last OCR result, and recent errors.

## Demo script

1. Tap Start → "MySight is ready. You can ask me what I see, find something,
   or ask me to read text."
2. "What do you see?" → a real, on-demand scene description from the object
   model, not a canned line.
3. "Find a chair" → object mode → "Chair is directly ahead, close by."
4. "Find Pharmacy" (with a printed sign in view) → sign mode via OCR →
   "Pharmacy sign is straight ahead."
5. "Which way?" → repeats the current target's position without needing to
   re-ask the full question.
6. Put a person or chair directly in the frame → safety interrupt fires
   automatically: "STOP. Person directly ahead," pre-empting whatever else
   was being said, then "The path appears clear" once it's gone.
7. "Read this" pointed at any text → real OCR output spoken back, summarized
   if long ("say read everything to hear all of it").
8. "Stop" → cancels the current search and returns to a neutral ready state.

## Tech stack

HTML, CSS, vanilla JavaScript, TensorFlow.js, COCO-SSD, Tesseract.js, Web
Speech API.
