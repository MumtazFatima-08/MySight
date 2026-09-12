(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const startScreen = $('startScreen');
  const startBtn = $('startBtn');
  const mainScreen = $('mainScreen');
  const video = $('video');
  const overlay = $('overlay');
  const ctx = overlay.getContext('2d');
  const cameraWrap = $('cameraWrap');
  const safetyPill = $('safetyPill');
  const listenPill = $('listenPill');
  const currentCaption = $('currentCaption');
  const speakBtn = $('speakBtn');
  const transcriptToggleBtn = $('transcriptToggleBtn');
  const closeTranscriptBtn = $('closeTranscriptBtn');
  const transcriptPanel = $('transcriptPanel');
  const logList = $('logList');
  const ariaLive = $('ariaLive');

  const HAZARD_CLASSES = new Set([
    'person', 'chair', 'couch', 'bench', 'dining table', 'suitcase', 'backpack',
    'bicycle', 'motorcycle', 'car', 'potted plant', 'umbrella', 'handbag',
    'skateboard', 'fire hydrant', 'stop sign'
  ]);

  const OBJECT_CLASSES = [
    'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
    'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
    'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
    'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
    'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
    'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
    'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
    'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
    'remote','keyboard','cell phone','microwave','oven','toaster','sink',
    'refrigerator','book','clock','vase','scissors','teddy bear','hair drier',
    'toothbrush'
  ];

  let model = null;
  let stream = null;
  let searchMode = null;
  let destination = '';
  let objectTarget = null;
  let obstacleLoopId = null;
  let signScanLoopId = null;
  let recognition = null;
  let recognitionActive = false;
  let speaking = false;
  let appStarted = false;
  let voicesReady = false;
  let signScanBusy = false;
  let lastSignText = '';
  let lastSignSpokenAt = 0;
  let lastSafetySpokenAt = 0;
  let lastObjectAnnounceAt = 0;
  let objectWasVisible = false;
  let backgroundRestartTimer = null;
  let speechWatchdog = null;

  const hasSpeechRecognition = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  const hasSpeechSynthesis = 'speechSynthesis' in window;

  // Speech is a priority system, not a collection of competing timers.
  // Safety can interrupt navigation; ordinary messages are dropped if a higher
  // priority message is already speaking.
  const SPEECH_PRIORITY = { system: 1, navigation: 2, sign: 3, safety: 4 };
  let activeSpeechPriority = 0;
  let activeUtterance = null;

  function log(text, kind) {
    currentCaption.textContent = text;
    currentCaption.className = 'current ' + (kind || 'system');
    ariaLive.textContent = text;

    const row = document.createElement('div');
    row.className = 'log-entry ' + (kind || 'system');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const txt = document.createElement('span');
    txt.className = 'text';
    txt.textContent = text;
    row.appendChild(time);
    row.appendChild(txt);
    logList.appendChild(row);
    logList.scrollTop = logList.scrollHeight;
  }

  function setListenState(state) {
    listenPill.className = 'pill' + (state === 'listening' ? ' listening' : '');
    listenPill.querySelector('span:last-child').textContent =
      state === 'listening' ? 'Listening…' : state === 'thinking' ? 'Thinking…' : 'Idle';
    speakBtn.classList.toggle('listening', state === 'listening');
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function primeSpeech() {
    if (!hasSpeechSynthesis) return;
    window.speechSynthesis.cancel();
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) voicesReady = true;
    window.speechSynthesis.onvoiceschanged = () => { voicesReady = true; };

    if (!speechWatchdog) {
      speechWatchdog = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 8000);
    }
  }

  function cancelSpeech() {
    if (hasSpeechSynthesis) window.speechSynthesis.cancel();
    speaking = false;
    activeSpeechPriority = 0;
    activeUtterance = null;
  }

  function speak(text, kind, onDone) {
    const priority = SPEECH_PRIORITY[kind] || 1;
    log(text, kind);

    if (!hasSpeechSynthesis) {
      if (onDone) onDone();
      return;
    }

    // Never let low-priority narration interrupt a safety warning.
    if (speaking && priority < activeSpeechPriority) return;

    if (speaking && priority >= activeSpeechPriority) {
      window.speechSynthesis.cancel();
      speaking = false;
      activeSpeechPriority = 0;
    }

    const start = () => {
      if (!appStarted) return;
      stopRecognition();
      speaking = true;
      activeSpeechPriority = priority;

      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      utter.volume = 1;
      activeUtterance = utter;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        speaking = false;
        activeSpeechPriority = 0;
        activeUtterance = null;
        if (onDone) onDone();
      };

      utter.onend = finish;
      utter.onerror = finish;
      setTimeout(finish, Math.max(2500, text.length * 95 + 2500));
      window.speechSynthesis.speak(utter);
    };

    if (!voicesReady) {
      setTimeout(() => {
        voicesReady = true;
        start();
      }, 200);
    } else {
      start();
    }
  }

  function setSafety(state, detail) {
    if (state === 'warning') {
      safetyPill.className = 'pill';
      safetyPill.querySelector('span:last-child').textContent = detail || 'Obstacle ahead';
      safetyPill.querySelector('.dot').style.background = 'var(--safety)';
      cameraWrap.classList.add('alert');
    } else if (state === 'blocked') {
      safetyPill.className = 'pill';
      safetyPill.querySelector('span:last-child').textContent = 'Path blocked';
      safetyPill.querySelector('.dot').style.background = 'var(--safety)';
      cameraWrap.classList.add('alert');
    } else {
      safetyPill.className = 'pill safe';
      safetyPill.querySelector('span:last-child').textContent = 'Path clear';
      safetyPill.querySelector('.dot').style.background = '';
      cameraWrap.classList.remove('alert');
    }
  }

  function resizeOverlay() {
    if (!video.videoWidth && !video.clientWidth) return;
    overlay.width = video.videoWidth || video.clientWidth;
    overlay.height = video.videoHeight || video.clientHeight;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera API is unavailable');
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
    window.addEventListener('resize', resizeOverlay);

    cocoSsd.load({ base: 'lite_mobilenet_v2' }).then((m) => {
      model = m;
      log('Obstacle and object detection ready.', 'system');
      startObstacleLoop();
    }).catch((e) => {
      log('Obstacle model failed to load: ' + e.message, 'system');
    });
  }

  function matchObjectClass(phrase) {
    const p = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
    let best = null;
    for (const cls of OBJECT_CLASSES) {
      if (p === cls || p === cls + 's' || p.includes(cls) || cls.includes(p)) {
        if (!best || cls.length > best.length) best = cls;
      }
    }
    return best;
  }

  function getHorizontalPosition(box, width) {
    const cx = box[0] + box[2] / 2;
    if (cx < width * 0.34) return 'left';
    if (cx > width * 0.66) return 'right';
    return 'center';
  }

  function detectPathState(predictions, w, h) {
    let centerHazard = null;
    let leftBlocked = false;
    let rightBlocked = false;

    for (const p of predictions) {
      if (!HAZARD_CLASSES.has(p.class) || p.score < 0.45) continue;
      const [x, y, bw, bh] = p.bbox;
      const areaRatio = (bw * bh) / (w * h);
      const bottomRatio = (y + bh) / h;
      const centerX = x + bw / 2;

      // This is a conservative camera-space heuristic, not a distance sensor.
      const relevant = bottomRatio > 0.58 && areaRatio > 0.025;
      if (!relevant) continue;

      if (centerX < w * 0.43) leftBlocked = true;
      if (centerX > w * 0.57) rightBlocked = true;

      if (centerX >= w * 0.32 && centerX <= w * 0.68) {
        if (!centerHazard || areaRatio > centerHazard.areaRatio) {
          centerHazard = { prediction: p, areaRatio };
        }
      }
    }

    return { centerHazard, leftBlocked, rightBlocked };
  }

  function chooseSafeDirection(leftBlocked, rightBlocked, hazard) {
    if (leftBlocked && rightBlocked) return null;
    if (!leftBlocked && rightBlocked) return 'left';
    if (leftBlocked && !rightBlocked) return 'right';

    // Both side regions look free. Prefer the side farther from the obstacle.
    const [x, , bw] = hazard.bbox;
    const cx = x + bw / 2;
    return cx < overlay.width / 2 ? 'right' : 'left';
  }

  function startObstacleLoop() {
    if (obstacleLoopId) return;

    obstacleLoopId = setInterval(async () => {
      if (!model || !video.videoWidth || !appStarted) return;

      let predictions;
      try {
        predictions = await model.detect(video, 12, 0.45);
      } catch (e) {
        return;
      }

      resizeOverlay();
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const w = overlay.width;
      const h = overlay.height;
      let targetHit = null;

      for (const p of predictions) {
        const [x, y, bw, bh] = p.bbox;
        const isHazard = HAZARD_CLASSES.has(p.class) && p.score >= 0.45;
        const isTarget = searchMode === 'object' && objectTarget === p.class && p.score >= 0.45;
        ctx.strokeStyle = isTarget ? '#ffb13d' : (isHazard ? '#ff5a5f' : '#4fd1c5');
        ctx.lineWidth = isTarget ? 3 : 2;
        ctx.strokeRect(x, y, bw, bh);

        if (isTarget && (!targetHit || bw * bh > targetHit.bbox[2] * targetHit.bbox[3])) {
          targetHit = p;
        }
      }

      const path = detectPathState(predictions, w, h);
      if (path.centerHazard) {
        const hazard = path.centerHazard.prediction;
        const direction = chooseSafeDirection(path.leftBlocked, path.rightBlocked, hazard);
        const now = Date.now();

        if (!direction) {
          setSafety('blocked');
          if (now - lastSafetySpokenAt > 3500) {
            speak('Stop. The path ahead appears blocked.', 'safety');
            lastSafetySpokenAt = now;
          }
        } else {
          setSafety('warning', 'Obstacle ahead');
          if (now - lastSafetySpokenAt > 3500) {
            speak('Obstacle ahead. Move slightly ' + direction + '.', 'safety');
            lastSafetySpokenAt = now;
          }
        }
      } else {
        setSafety('clear');
      }

      if (searchMode === 'object' && objectTarget) {
        if (targetHit) {
          const now = Date.now();
          const pos = getHorizontalPosition(targetHit.bbox, w);
          const areaRatio = (targetHit.bbox[2] * targetHit.bbox[3]) / (w * h);
          const closeness = areaRatio > 0.15 ? 'close by' : 'ahead';
          if (!objectWasVisible || now - lastObjectAnnounceAt > 5000) {
            speak(capitalize(objectTarget) + ' spotted, ' + (pos === 'center' ? 'straight ahead' : 'to your ' + pos) + ', ' + closeness + '.', 'sign');
            lastObjectAnnounceAt = now;
          }
          objectWasVisible = true;
        } else {
          objectWasVisible = false;
        }
      }
    }, 650);
  }

  function normalizeText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function destinationMatches(text) {
    const wanted = normalizeText(destination);
    const seen = normalizeText(text);
    if (!wanted || !seen) return false;
    if (seen.includes(wanted)) return true;

    // Allow a multi-word destination to survive small OCR errors such as
    // punctuation/newlines while avoiding substring-only false positives.
    const wantedWords = wanted.split(' ').filter(Boolean);
    const seenWords = new Set(seen.split(' '));
    const matches = wantedWords.filter(word => seenWords.has(word)).length;
    return wantedWords.length > 1 && matches / wantedWords.length >= 0.7;
  }

  async function scanForSign() {
    if (signScanBusy || !video.videoWidth || !destination || searchMode !== 'sign' || !appStarted) return;
    signScanBusy = true;

    const canvas = document.createElement('canvas');
    // Downscale OCR input for much faster mobile processing.
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const result = await Tesseract.recognize(canvas, 'eng', {
        logger: () => {}
      });
      const text = result?.data?.text || '';
      const normalized = normalizeText(text);

      if (destinationMatches(text)) {
        const words = Array.isArray(result?.data?.words) ? result.data.words : [];
        const wantedWords = normalizeText(destination).split(' ').filter(Boolean);
        const matchingWords = words.filter(w => {
          const word = normalizeText(w.text);
          return wantedWords.some(target => word === target || word.includes(target) || target.includes(word));
        });

        let position = 'center';
        if (matchingWords.length) {
          const minX = Math.min(...matchingWords.map(w => w.bbox.x0));
          const maxX = Math.max(...matchingWords.map(w => w.bbox.x1));
          position = getHorizontalPosition([minX, 0, maxX - minX, 1], canvas.width);
        }

        // Require repeated/changed evidence before announcing the same sign.
        const now = Date.now();
        const evidenceKey = normalized.slice(0, 180);
        const changedEvidence = evidenceKey !== lastSignText;
        if (changedEvidence || now - lastSignSpokenAt > 6500) {
          const phrase = position === 'center'
            ? capitalize(destination) + ' sign ahead.'
            : capitalize(destination) + ' sign is to your ' + position + '.';
          speak(phrase, 'sign');
          lastSignText = evidenceKey;
          lastSignSpokenAt = now;
        }
      }
    } catch (e) {
      log('Sign scan retry: ' + (e.message || 'OCR error'), 'system');
    } finally {
      signScanBusy = false;
    }
  }

  function startSignSearch(dest) {
    destination = dest;
    searchMode = 'sign';
    objectTarget = null;
    lastSignText = '';
    lastSignSpokenAt = 0;
    if (signScanLoopId) clearInterval(signScanLoopId);
    scanForSign();
    signScanLoopId = setInterval(scanForSign, 3500);
  }

  function startObjectSearch(cls) {
    objectTarget = cls;
    searchMode = 'object';
    objectWasVisible = false;
    lastObjectAnnounceAt = 0;
    destination = '';
    if (signScanLoopId) {
      clearInterval(signScanLoopId);
      signScanLoopId = null;
    }
  }

  function stopRecognition() {
    if (recognition && recognitionActive) {
      try { recognition.stop(); } catch (e) {}
    }
    recognitionActive = false;
    setListenState('idle');
  }

  function startRecognition(isManual) {
    if (!recognition || recognitionActive || speaking || !appStarted) return;
    try {
      recognition.start();
      recognitionActive = true;
      recognition._manual = !!isManual;
      setListenState('listening');
    } catch (e) {
      recognitionActive = false;
    }
  }

  function initRecognition() {
    if (!hasSpeechRecognition) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (e) => {
      const heard = (e.results?.[0]?.[0]?.transcript || '').trim();
      recognitionActive = false;
      setListenState('thinking');
      if (heard) {
        log('Heard: "' + heard + '"', 'system');
        handleVoiceInput(heard);
      } else {
        setListenState('idle');
      }
    };

    recognition.onerror = (e) => {
      const manual = !!recognition._manual;
      recognitionActive = false;
      setListenState('idle');
      if (manual && e.error === 'no-speech') {
        speak('I did not catch that. Please try again.', 'system');
      } else if (manual && e.error === 'not-allowed') {
        speak('Microphone access is blocked. Please allow it and try again.', 'system');
      }
    };

    recognition.onend = () => {
      recognitionActive = false;
      setListenState('idle');

      // Re-listen only after the browser finishes the current recognition
      // session. This is more reliable than calling start() from a timer while
      // Chrome is still closing the previous session.
      if (appStarted && !speaking) {
        clearTimeout(backgroundRestartTimer);
        backgroundRestartTimer = setTimeout(() => startRecognition(false), 700);
      }
    };
  }

  function extractQuery(phrase) {
    let p = normalizeText(phrase);
    p = p.replace(/^(find|go to|take me to|navigate to|where is|where s|i want to go to|i need to find|look for)\s+/, '');
    p = p.replace(/^(the|a|an)\s+/, '');
    return p.trim();
  }

  function handleVoiceInput(heard) {
    const q = extractQuery(heard);
    if (!q) {
      speak('Sorry, I did not catch a destination. Try again.', 'system');
      return;
    }

    const objClass = matchObjectClass(q);
    if (objClass) {
      startObjectSearch(objClass);
      speak('Looking for the ' + objClass + '. I will tell you where I see it.', 'navigation');
    } else {
      startSignSearch(q);
      speak('Looking for a sign that says ' + capitalize(q) + '.', 'navigation');
    }
  }

  function askForDestination() {
    speak('Where do you want to go, or what are you looking for?', 'system', () => {
      startRecognition(true);
    });
  }

  speakBtn.addEventListener('click', () => {
    if (recognitionActive) {
      stopRecognition();
      return;
    }
    if (speaking) cancelSpeech();
    startRecognition(true);
  });

  transcriptToggleBtn.addEventListener('click', () => transcriptPanel.classList.add('open'));
  closeTranscriptBtn.addEventListener('click', () => transcriptPanel.classList.remove('open'));

  startBtn.addEventListener('click', async () => {
    if (appStarted) return;
    appStarted = true;
    primeSpeech();
    startScreen.style.display = 'none';
    mainScreen.classList.add('active');

    try {
      await startCamera();
    } catch (e) {
      log('Camera access failed: ' + (e.message || 'permission denied'), 'system');
      speak('I could not access the camera. Please allow camera access and reload the page.', 'system');
      return;
    }

    initRecognition();
    if (!hasSpeechRecognition) {
      speak('Voice input is not supported in this browser. Please use Chrome on Android or desktop Chrome.', 'system');
      return;
    }
    askForDestination();
  });
})();
