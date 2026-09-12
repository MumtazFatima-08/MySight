(function(){

  const startScreen = document.getElementById('startScreen');
  const startBtn = document.getElementById('startBtn');
  const mainScreen = document.getElementById('mainScreen');
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const cameraWrap = document.getElementById('cameraWrap');
  const safetyPill = document.getElementById('safetyPill');
  const listenPill = document.getElementById('listenPill');
  const currentCaption = document.getElementById('currentCaption');
  const speakBtn = document.getElementById('speakBtn');
  const transcriptToggleBtn = document.getElementById('transcriptToggleBtn');
  const closeTranscriptBtn = document.getElementById('closeTranscriptBtn');
  const transcriptPanel = document.getElementById('transcriptPanel');
  const logList = document.getElementById('logList');
  const ariaLive = document.getElementById('ariaLive');

  const HAZARD_CLASSES = new Set([
    'person','chair','couch','bench','dining table','suitcase','backpack',
    'bicycle','motorcycle','car','potted plant','umbrella','handbag',
    'skateboard','fire hydrant','stop sign'
  ]);

  let model = null;
  let stream = null;
  let destination = '';
  let obstacleLoopId = null;
  let signScanLoopId = null;
  let lastSafetySpokenAt = 0;
  let recognition = null;
  let recognitionActive = false;
  let awaitingDestination = false;
  let speaking = false;

  const hasSpeechRecognition = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  const hasSpeechSynthesis = 'speechSynthesis' in window;

  function log(text, kind){
    currentCaption.textContent = text;
    currentCaption.className = 'current ' + (kind || '');
    ariaLive.textContent = text;

    const row = document.createElement('div');
    row.className = 'log-entry ' + (kind || 'system');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const txt = document.createElement('span');
    txt.className = 'text';
    txt.textContent = text;
    row.appendChild(time); row.appendChild(txt);
    logList.appendChild(row);
    logList.scrollTop = logList.scrollHeight;
  }

  function setListenState(state){
    // state: 'idle' | 'listening' | 'thinking'
    listenPill.className = 'pill' + (state === 'listening' ? ' listening' : '');
    listenPill.querySelector('span:last-child').textContent =
      state === 'listening' ? 'Listening…' : state === 'thinking' ? 'Thinking…' : 'Idle';
    speakBtn.classList.toggle('listening', state === 'listening');
  }

  let voicesReady = false;
  function primeSpeech(){
    // Must run synchronously inside the click handler to unlock speechSynthesis
    // on Android Chrome, and to force voice list loading before first real speak.
    if (!hasSpeechSynthesis) return;
    window.speechSynthesis.cancel();
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
    if (window.speechSynthesis.getVoices().length) {
      voicesReady = true;
    } else {
      window.speechSynthesis.onvoiceschanged = () => { voicesReady = true; };
      setTimeout(() => { voicesReady = true; }, 1200);
    }
    // Chrome/Android sometimes silently halts speech after ~15s; nudge it awake periodically.
    setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 8000);
  }

  function speak(text, kind, onDone, attempt){
    log(text, kind);
    if (!hasSpeechSynthesis) { if (onDone) onDone(); return; }
    if (!voicesReady && (attempt || 0) < 10) {
      setTimeout(() => speak(text, kind, onDone, (attempt || 0) + 1), 150);
      return;
    }
    // pause recognition while speaking so the app doesn't hear itself
    stopRecognition();
    speaking = true;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.volume = 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      speaking = false;
      if (onDone) onDone();
    };
    utter.onend = finish;
    utter.onerror = finish;
    // Safety net: Android Chrome occasionally never fires onend/onerror.
    const estMs = Math.max(1500, text.length * 90);
    setTimeout(finish, estMs + 2000);
    window.speechSynthesis.speak(utter);
  }

  function setSafety(isWarning){
    if (isWarning) {
      safetyPill.className = 'pill';
      safetyPill.querySelector('span:last-child').textContent = 'Obstacle ahead';
      safetyPill.querySelector('.dot').style.background = 'var(--safety)';
      cameraWrap.classList.add('alert');
    } else {
      safetyPill.className = 'pill safe';
      safetyPill.querySelector('span:last-child').textContent = 'Path clear';
      cameraWrap.classList.remove('alert');
    }
  }

  // The 80 classes the object-detection model actually knows. Anything not in
  // this list (e.g. "door") cannot be found by sight and falls back to
  // looking for it as printed text on a sign instead.
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

  function matchObjectClass(phrase){
    const p = phrase.toLowerCase().replace(/s$/, ''); // crude singularize
    let best = null;
    OBJECT_CLASSES.forEach(cls => {
      const clsSingular = cls.replace(/s$/, '');
      if (p === cls || p === clsSingular || p.includes(cls) || cls.includes(p)) {
        if (!best || cls.length > best.length) best = cls;
      }
    });
    return best;
  }

  let searchMode = null;      // 'object' | 'sign'
  let objectTarget = null;
  let lastObjectAnnounceAt = 0;
  let objectWasVisible = false;

  // ---------- Camera + detection ----------
  async function startCamera(){
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
    window.addEventListener('resize', resizeOverlay);

    // Load the obstacle model in the background so voice prompts aren't
    // blocked on a multi-second download over a phone network.
    cocoSsd.load({ base: 'lite_mobilenet_v2' }).then(m => {
      model = m;
      startObstacleLoop();
    }).catch(e => {
      log('Obstacle model failed to load: ' + e.message, 'system');
    });
  }

  function resizeOverlay(){
    overlay.width = video.videoWidth || video.clientWidth;
    overlay.height = video.videoHeight || video.clientHeight;
  }

  function startObstacleLoop(){
    if (obstacleLoopId) return;
    obstacleLoopId = setInterval(async () => {
      if (!model || !video.videoWidth || speaking) return;
      let predictions = [];
      try { predictions = await model.detect(video); } catch (e) { return; }

      ctx.clearRect(0,0,overlay.width, overlay.height);
      const w = overlay.width, h = overlay.height;
      let hazard = null;
      let targetHit = null;

      predictions.forEach(p => {
        const [x,y,bw,bh] = p.bbox;
        const isHazard = HAZARD_CLASSES.has(p.class);
        const isTarget = searchMode === 'object' && objectTarget && p.class === objectTarget;
        ctx.strokeStyle = isTarget ? '#ffb13d' : (isHazard ? '#ff5a5f' : '#4fd1c5');
        ctx.lineWidth = isTarget ? 3 : 2;
        ctx.strokeRect(x,y,bw,bh);
        if (isHazard) {
          const cy = y + bh/2;
          const inLowerPath = cy > h * 0.35;
          const closeEnough = (bw*bh) > (w*h*0.05);
          if (inLowerPath && closeEnough) {
            if (!hazard || (bw*bh) > (hazard.bbox[2]*hazard.bbox[3])) hazard = p;
          }
        }
        if (isTarget) {
          if (!targetHit || (bw*bh) > (targetHit.bbox[2]*targetHit.bbox[3])) targetHit = p;
        }
      });

      if (hazard) {
        const [x,,bw] = hazard.bbox;
        const cx = x + bw/2;
        const direction = cx < w/2 ? 'right' : 'left';
        setSafety(true);
        const now = Date.now();
        if (now - lastSafetySpokenAt > 3000) {
          speak('Obstacle ahead. Move slightly ' + direction + '.', 'safety');
          lastSafetySpokenAt = now;
        }
      } else {
        setSafety(false);
      }

      if (searchMode === 'object' && objectTarget) {
        if (targetHit) {
          const [x,,bw,bh] = targetHit.bbox;
          const cx = x + bw/2;
          const third = w / 3;
          const pos = cx < third ? 'to your left' : cx > third*2 ? 'to your right' : 'straight ahead';
          const closeness = (bw*bh) > (w*h*0.15) ? 'close by' : 'ahead';
          const now = Date.now();
          if (!objectWasVisible || now - lastObjectAnnounceAt > 4500) {
            speak(capitalize(objectTarget) + ' spotted, ' + pos + ', ' + closeness + '.', 'sign');
            lastObjectAnnounceAt = now;
          }
          objectWasVisible = true;
        } else {
          objectWasVisible = false;
        }
      }
    }, 700);
  }

  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  async function scanForSign(){
    if (!video.videoWidth || !destination || speaking) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const result = await Tesseract.recognize(canvas, 'eng');
      const text = (result?.data?.text || '').toLowerCase();
      if (text.includes(destination.toLowerCase())) {
        speak(destination + ' ahead.', 'sign');
      }
    } catch (e) { /* ignore, try again next cycle */ }
  }

  function startSignSearch(dest){
    destination = dest;
    searchMode = 'sign';
    objectTarget = null;
    if (signScanLoopId) clearInterval(signScanLoopId);
    scanForSign();
    signScanLoopId = setInterval(scanForSign, 4000);
  }

  function startObjectSearch(cls){
    objectTarget = cls;
    searchMode = 'object';
    objectWasVisible = false;
    lastObjectAnnounceAt = 0;
    if (signScanLoopId) { clearInterval(signScanLoopId); signScanLoopId = null; }
    destination = '';
  }

  // ---------- Voice input ----------
  let manualListenRequested = false;
  let backgroundListenTimer = null;

  function initRecognition(){
    if (!hasSpeechRecognition) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (e) => {
      const heard = e.results[0][0].transcript.trim();
      log('Heard: "' + heard + '"', 'system');
      handleVoiceInput(heard);
    };
    recognition.onerror = (e) => {
      recognitionActive = false;
      setListenState('idle');
      // Only complain out loud if the user explicitly tapped the mic —
      // silent background listening attempts should fail quietly.
      if (e.error === 'no-speech' && manualListenRequested) {
        speak('I didn\'t catch that. Try again, or just wait \u2014 I\'ll keep listening.', 'system');
      }
      manualListenRequested = false;
    };
    recognition.onend = () => {
      recognitionActive = false;
      setListenState('idle');
    };

    // Keep trying to listen in the background every few seconds so the
    // user never has to tap the mic for a normal follow-up question.
    backgroundListenTimer = setInterval(() => {
      if (!recognitionActive && !speaking) startRecognition(false);
    }, 3500);
  }

  function startRecognition(isManual){
    if (!recognition || recognitionActive || speaking) return;
    manualListenRequested = !!isManual;
    try {
      recognition.start();
      recognitionActive = true;
      setListenState('listening');
    } catch (e) { /* already started */ }
  }

  function stopRecognition(){
    if (recognition && recognitionActive) {
      try { recognition.stop(); } catch(e){}
    }
    recognitionActive = false;
  }

  function extractQuery(phrase){
    let p = phrase.toLowerCase();
    p = p.replace(/^(find|go to|take me to|navigate to|where is|where's|i want to go to|i need to find)\s+/i, '');
    p = p.replace(/^(the|a|an)\s+/i, '');
    return p.trim().replace(/[.?!]+$/, '');
  }

  function handleVoiceInput(heard){
    const q = extractQuery(heard);
    if (!q) {
      speak('Sorry, I didn\'t catch a destination. Try again.', 'system');
      return;
    }
    const objClass = matchObjectClass(q);
    if (objClass) {
      startObjectSearch(objClass);
      speak('Looking for the ' + objClass + '. I\'ll tell you when I spot it and which way it is.', 'system');
    } else {
      const cap = capitalize(q);
      startSignSearch(cap);
      speak('I can\'t visually recognize "' + q + '" as an object, but I\'ll watch for a sign that says ' + cap + '.', 'system');
    }
  }

  function askForDestination(){
    speak('Where do you want to go, or what are you looking for?', 'system', () => {
      startRecognition(true);
    });
  }

  // ---------- Wiring ----------
  speakBtn.addEventListener('click', () => {
    if (recognitionActive) { stopRecognition(); return; }
    if (speaking) { window.speechSynthesis.cancel(); speaking = false; }
    startRecognition(true);
  });

  transcriptToggleBtn.addEventListener('click', () => transcriptPanel.classList.add('open'));
  closeTranscriptBtn.addEventListener('click', () => transcriptPanel.classList.remove('open'));

  startBtn.addEventListener('click', async () => {
    primeSpeech(); // must be the very first thing, still inside the tap gesture
    startScreen.style.display = 'none';
    mainScreen.classList.add('active');
    try {
      await startCamera();
    } catch (e) {
      speak('I could not access the camera. Please allow camera access and reload the page.', 'system');
      return;
    }
    initRecognition();
    if (!hasSpeechRecognition) {
      speak('Voice input is not supported in this browser. Please use Chrome on Android, or a desktop Chrome browser.', 'system');
      return;
    }
    askForDestination();
  });

})();
