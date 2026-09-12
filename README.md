# MySight

Voice-first indoor wayfinding for blind and low-vision users — built for BuildForge Hackathon 2026.

## What problem does it solve?

The difficult part is often the **last few metres**: reaching the correct room, counter, or facility inside a hospital, government office, or college campus.

MySight turns a phone camera into a lightweight, voice-guided wayfinding assistant. The user speaks a destination or object; MySight uses on-device vision and OCR to provide relative guidance and safety warnings.

## Core flow

1. Tap **Start** and grant camera/microphone permissions.
2. MySight asks: *"Where do you want to go, or what are you looking for?"*
3. Speak a target.
4. The target is routed automatically:
   - **Object mode:** targets that belong to the COCO-SSD 80-class vocabulary (for example chair, laptop, bottle, book, clock) are located with on-device object detection.
   - **Sign mode:** other destinations are searched for as printed text using Tesseract.js OCR.
5. A separate safety loop continuously checks the camera view for supported hazards. Safety messages have higher speech priority than normal navigation narration.
6. When the browser permits background speech recognition, the app attempts to restart listening after each completed recognition/speech cycle.

## Navigation logic

MySight intentionally reports **relative direction**, not fake centimetre-level distance.

- Object detections are classified as left, centre, or right from the camera frame.
- OCR matches the requested destination against detected text and uses the matched word bounding box to estimate left/centre/right position.
- Safety guidance checks the left and right camera regions before recommending a side. If both sides appear blocked, it tells the user to stop rather than blindly choosing an opposite direction.
- Repeated sign/object announcements are throttled so the same detection does not continuously talk over the user.

These are camera-space heuristics, not a replacement for a certified mobility aid, depth sensor, or professional navigation system.

## Implementation

- **Object + obstacle detection:** TensorFlow.js + COCO-SSD (`lite_mobilenet_v2`), running in the browser.
- **Sign reading:** Tesseract.js OCR on downscaled camera frames.
- **Voice input:** Web Speech API `SpeechRecognition`.
- **Voice output:** Web Speech API `SpeechSynthesisUtterance` with speech prioritisation and a start-tap warm-up.
- **Frontend:** HTML, CSS, vanilla JavaScript.
- **Backend:** none.
- **API keys:** none.

## Project structure

```text
index.html          Main application
css/style.css       UI styling
js/app.js           Camera, vision, OCR and voice logic
diagnostics.html    Browser capability diagnostics
README.md           Documentation
```

No build step is required. Serve the project over **HTTPS or localhost**.

## Browser constraints

- Camera and microphone require a secure context: **HTTPS or localhost**. `file://` is not sufficient.
- `SpeechRecognition` support varies by browser. Chrome is the recommended demo browser.
- COCO-SSD only knows its 80 trained categories. Things such as doors, walls, windows, rooms, and signs are not object classes; they are handled through the OCR path when they contain readable text.
- OCR accuracy depends on lighting, camera quality, text size, angle, and motion.
- Browser speech recognition can stop or behave differently across devices, so the app includes restart logic and a diagnostics page rather than assuming continuous recognition is guaranteed.

## Demo script

### Demo 1 — object target

Say **"Find the chair"**.

Expected behavior: MySight enters object mode and reports the chair's relative position, for example *"Chair spotted, to your left."*

### Demo 2 — sign target

Hold a clear printed **Pharmacy** sign in front of the camera and say **"Find Pharmacy"**.

Expected behavior: MySight enters sign mode, detects the requested word with OCR, and reports whether the sign is left, centre, or right in the camera view.

### Demo 3 — safety interrupt

Place a supported obstacle such as a chair in the lower camera path while navigation narration is active.

Expected behavior: the safety message takes priority and either recommends the clearer side or says the path appears blocked.

## Diagnostics

Open `diagnostics.html` if the main app does not behave as expected. It checks secure-context status, camera/microphone access, speech recognition, text-to-speech, and model loading separately.

## Safety note

MySight is a hackathon prototype intended to demonstrate accessible, voice-first indoor wayfinding. It should **not** be treated as a certified mobility aid or relied on as the sole system for safe travel.
