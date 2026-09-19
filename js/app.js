(function(){
'use strict';

/* ================= Constants ================= */
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
const HAZARD_CLASSES = new Set([
  'person','car','bicycle','motorcycle','bus','truck','chair','couch','bench',
  'dining table','suitcase','backpack','handbag','potted plant'
]);

const STATE = Object.freeze({
  IDLE:'IDLE', STARTING:'STARTING', READY:'READY', LISTENING:'LISTENING',
  THINKING:'THINKING', SPEAKING:'SPEAKING', SEARCHING_OBJECT:'SEARCHING_OBJECT',
  SEARCHING_SIGN:'SEARCHING_SIGN', SAFETY_ALERT:'SAFETY_ALERT', ERROR:'ERROR'
});

function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function positionLabel(cx, w){
  const third = w / 3;
  if (cx < third) return 'on your left';
  if (cx > third * 2) return 'on your right';
  return 'directly ahead';
}
function matchObjectClass(phrase){
  const p = phrase.toLowerCase().replace(/s$/, '');
  let best = null;
  OBJECT_CLASSES.forEach(cls => {
    const singular = cls.replace(/s$/, '');
    if (p === cls || p === singular || p.includes(cls) || cls.includes(p)) {
      if (!best || cls.length > best.length) best = cls;
    }
  });
  return best;
}

/* ================= DOM ================= */
const dom = {
  startScreen: document.getElementById('startScreen'),
  startBtn: document.getElementById('startBtn'),
  startStatus: document.getElementById('startStatus'),
  mainScreen: document.getElementById('mainScreen'),
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  cameraWrap: document.getElementById('cameraWrap'),
  statePill: document.getElementById('statePill'),
  statePillText: document.getElementById('statePillText'),
  currentCaption: document.getElementById('currentCaption'),
  micBtn: document.getElementById('micBtn'),
  fallbackControls: document.getElementById('fallbackControls'),
  fbDescribe: document.getElementById('fbDescribe'),
  fbFindChair: document.getElementById('fbFindChair'),
  fbRead: document.getElementById('fbRead'),
  fbStop: document.getElementById('fbStop'),
  debugPanel: document.getElementById('debugPanel'),
  debugContent: document.getElementById('debugContent'),
  ariaLive: document.getElementById('ariaLive'),
};
const ctx2d = dom.overlay.getContext('2d');
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
if (DEBUG) dom.debugPanel.hidden = false;

/* ================= App state / context / debug ================= */
let appState = STATE.IDLE;
const Context = { currentIntent:null, currentTarget:null, lastObservation:null, lastSpokenMessage:'', mode:'idle' };
const Debug = { camera:'—', model:'—', ocr:'—', mic:'—', speech:'—', state:'—', lastCommand:'—', detections:'—', ocrResult:'—', errors:[] };

function humanState(s){
  switch(s){
    case STATE.LISTENING: return 'Listening…';
    case STATE.THINKING: return 'Thinking…';
    case STATE.SPEAKING: return 'Speaking…';
    case STATE.SEARCHING_OBJECT: return 'Searching for ' + (Context.currentTarget||'object') + '…';
    case STATE.SEARCHING_SIGN: return 'Reading signs…';
    case STATE.SAFETY_ALERT: return 'Safety alert';
    case STATE.ERROR: return 'Error';
    case STATE.READY: return 'Ready';
    default: return s;
  }
}
function setState(s){
  appState = s;
  Debug.state = s;
  dom.statePillText.textContent = humanState(s);
  dom.statePill.classList.remove('safe','warn','listening');
  if (s === STATE.SAFETY_ALERT) dom.statePill.classList.add('warn');
  else if (s === STATE.LISTENING) dom.statePill.classList.add('listening');
  else dom.statePill.classList.add('safe');
  renderDebug();
}
function renderDebug(){
  if (!DEBUG) return;
  dom.debugContent.textContent =
    'State: ' + Debug.state + '\n' +
    'Camera: ' + Debug.camera + '\n' +
    'Object model: ' + Debug.model + '\n' +
    'OCR: ' + Debug.ocr + '\n' +
    'Mic permission: ' + Debug.mic + '\n' +
    'Speech: ' + Debug.speech + '\n' +
    'Current intent/target: ' + Context.currentIntent + ' / ' + Context.currentTarget + '\n' +
    'Last command: ' + Debug.lastCommand + '\n' +
    'Detections: ' + Debug.detections + '\n' +
    'OCR result: ' + Debug.ocrResult + '\n' +
    'Errors: ' + Debug.errors.slice(-6).join(' | ');
}
function logError(where, e){
  const msg = where + ': ' + (e && e.message ? e.message : e);
  Debug.errors.push(msg);
  renderDebug();
  console.error(msg);
}
function setCaption(text){
  dom.currentCaption.textContent = text;
  dom.ariaLive.textContent = text;
}
function vibrate(pattern){
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch(e){} }
}

/* ================= Speech Manager ================= */
const SpeechManager = (function(){
  const hasTTS = 'speechSynthesis' in window;
  let queue = [];
  let speaking = false;
  let voicesReady = false;
  let lastMessage = '';
  let lastMessageAt = 0;
  let watchdog = null;

  function primeSpeech(){
    if (!hasTTS) return;
    try {
      window.speechSynthesis.cancel();
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
    } catch(e){ logError('primeSpeech', e); }
    if (window.speechSynthesis.getVoices().length) {
      voicesReady = true;
    } else {
      window.speechSynthesis.onvoiceschanged = () => { voicesReady = true; };
      setTimeout(() => { voicesReady = true; }, 1200);
    }
    setInterval(() => {
      if (hasTTS && window.speechSynthesis.speaking) {
        try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch(e){}
      }
    }, 8000);
  }

  function speak(text, priority, onDone){
    priority = priority || 'normal';
    if (!text) { if (onDone) onDone(); return; }
    const now = Date.now();
    if (text === lastMessage && now - lastMessageAt < 1800 && priority !== 'safety') {
      if (onDone) onDone();
      return;
    }
    if (priority === 'safety') {
      queue = queue.filter(q => q.priority === 'safety');
      cancelCurrent();
    }
    queue.push({ text, priority, onDone });
    Context.lastSpokenMessage = text;
    processQueue();
  }

  function processQueue(attempt){
    if (!voicesReady && (attempt||0) < 15) {
      setTimeout(() => processQueue((attempt||0)+1), 150);
      return;
    }
    if (speaking || queue.length === 0) return;
    const item = queue.shift();
    if (!hasTTS) {
      setCaption(item.text);
      if (item.onDone) item.onDone();
      processQueue();
      return;
    }
    speaking = true;
    Debug.speech = 'speaking';
    setState(STATE.SPEAKING);
    RecognitionManager.pause();
    setCaption(item.text);
    lastMessage = item.text; lastMessageAt = Date.now();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      speaking = false;
      Debug.speech = 'idle';
      if (item.onDone) item.onDone();
      RecognitionManager.resumeIfDesired();
      processQueue();
    };
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(item.text);
      utter.rate = 1.0;
      utter.onend = finish;
      utter.onerror = finish;
      watchdog = setTimeout(finish, Math.max(2500, item.text.length * 110));
      window.speechSynthesis.speak(utter);
    } catch(e){
      logError('speak', e);
      finish();
    }
  }

  function cancelCurrent(){
    try { if (hasTTS) window.speechSynthesis.cancel(); } catch(e){}
    speaking = false;
    clearTimeout(watchdog);
  }

  return {
    primeSpeech, speak, cancelCurrent,
    isSpeaking: () => speaking,
    hasSupport: () => hasTTS
  };
})();

/* ================= Recognition Manager ================= */
const RecognitionManager = (function(){
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!Ctor;
  let recognition = null;
  let active = false;
  let desired = false;
  let restartTimer = null;
  let consecutiveErrors = 0;

  function init(){
    if (!supported) { Debug.mic = 'no SpeechRecognition API in this browser'; return; }
    recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      active = true;
      consecutiveErrors = 0;
      setState(STATE.LISTENING);
    };
    recognition.onresult = (e) => {
      const heard = e.results[0][0].transcript.trim();
      Debug.lastCommand = heard;
      renderDebug();
      IntentParser.handle(heard);
    };
    recognition.onerror = (e) => {
      active = false;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        Debug.mic = 'permission denied';
        desired = false;
        SpeechManager.speak('I can\'t hear you. Microphone permission was denied. Please allow microphone access and reload the page.', 'normal');
        return;
      }
      if (e.error === 'no-speech' || e.error === 'aborted') {
        consecutiveErrors = 0;
        scheduleRestart(desired ? 900 : null);
        return;
      }
      consecutiveErrors++;
      logError('recognition', e.error);
      if (consecutiveErrors >= 3) {
        SpeechManager.speak('Voice recognition is having trouble right now. You can still use the on-screen buttons.', 'normal');
        consecutiveErrors = 0;
      }
      scheduleRestart(1500);
    };
    recognition.onend = () => {
      active = false;
      if (appState === STATE.LISTENING) setState(STATE.READY);
      if (desired) scheduleRestart(700);
    };
    Debug.mic = Debug.mic === '—' ? 'ready' : Debug.mic;

    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' }).then(status => {
        Debug.mic = status.state;
        renderDebug();
        status.onchange = () => { Debug.mic = status.state; renderDebug(); };
      }).catch(() => {});
    }
  }

  function attemptStart(){
    if (!supported || !recognition) return;
    if (active || SpeechManager.isSpeaking()) return;
    try {
      recognition.start();
      active = true; // optimistic; onerror/onend correct this if the call actually failed
    } catch(e) {
      active = false;
    }
  }
  function scheduleRestart(delay){
    clearTimeout(restartTimer);
    if (delay == null) return;
    restartTimer = setTimeout(attemptStart, delay);
  }

  return {
    init,
    start: () => { desired = true; attemptStart(); },
    pause: () => { if (active) { try { recognition.stop(); } catch(e){} } clearTimeout(restartTimer); },
    resumeIfDesired: () => { if (desired) scheduleRestart(500); },
    stopListening: () => { desired = false; RecognitionManager.pause(); },
    hasSupport: () => supported
  };
})();

/* ================= Vision Manager ================= */
const VisionManager = (function(){
  let stream = null;
  let model = null;
  let loopId = null;
  let searching = false;
  let searchTarget = null;
  let lastFoundAt = 0;
  let lastNotFoundAnnounceAt = 0;
  let searchStartedAt = 0;
  let objectVisible = false;

  let hazardStreak = 0;
  let clearStreak = 0;
  let hazardActive = false;
  let lastHazardSpokenAt = 0;

  function waitForVideoReady(){
    return new Promise((resolve) => {
      if (dom.video.videoWidth > 0) return resolve();
      const check = () => dom.video.videoWidth > 0 ? resolve() : setTimeout(check, 100);
      check();
    });
  }
  function resize(){
    dom.overlay.width = dom.video.videoWidth || dom.video.clientWidth;
    dom.overlay.height = dom.video.videoHeight || dom.video.clientHeight;
  }
  function onStreamEnded(){
    Debug.camera = 'stream ended';
    renderDebug();
    SpeechManager.speak('MySight\'s camera stopped. Tap retry to restart it.', 'normal');
    showRetryScreen();
  }

  async function startCamera(){
    Debug.camera = 'requesting…'; renderDebug();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    dom.video.srcObject = stream;
    await dom.video.play();
    await waitForVideoReady();
    resize();
    window.addEventListener('resize', resize);
    dom.video.addEventListener('ended', onStreamEnded);
    stream.getVideoTracks()[0].addEventListener('ended', onStreamEnded);
    Debug.camera = 'active (' + dom.video.videoWidth + 'x' + dom.video.videoHeight + ')';
  }

  async function loadModel(){
    Debug.model = 'loading…'; renderDebug();
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    Debug.model = 'loaded';
  }

  function startLoop(){
    if (loopId) return;
    loopId = setInterval(runDetectionCycle, 700);
  }

  async function runDetectionCycle(){
    if (!model || !dom.video.videoWidth || SpeechManager.isSpeaking()) return;
    let predictions = [];
    try { predictions = await model.detect(dom.video); }
    catch(e) { logError('detect', e); return; }

    Debug.detections = predictions.map(p => p.class + ' ' + Math.round(p.score*100) + '%').join(', ') || 'none';

    const w = dom.overlay.width, h = dom.overlay.height;
    ctx2d.clearRect(0,0,w,h);

    let hazard = null;
    let targetHit = null;

    predictions.forEach(p => {
      const [x,y,bw,bh] = p.bbox;
      const isHazard = HAZARD_CLASSES.has(p.class) && p.score > 0.5;
      const isTarget = searching && p.class === searchTarget && p.score > 0.5;
      ctx2d.strokeStyle = isTarget ? '#ffb13d' : (isHazard ? '#ff5a5f' : '#4fd1c5');
      ctx2d.lineWidth = isTarget ? 3 : 2;
      ctx2d.strokeRect(x,y,bw,bh);
      if (isHazard) {
        const cy = y + bh/2;
        const inLowerPath = cy > h * 0.3;
        const bigEnough = (bw*bh) > (w*h*0.045);
        if (inLowerPath && bigEnough) {
          if (!hazard || (bw*bh) > (hazard.bbox[2]*hazard.bbox[3])) hazard = p;
        }
      }
      if (isTarget) {
        if (!targetHit || (bw*bh) > (targetHit.bbox[2]*targetHit.bbox[3])) targetHit = p;
      }
    });

    handleHazard(hazard, w, h);
    if (searching) handleSearchResult(targetHit, w, h);
  }

  function handleHazard(hazard, w, h){
    if (hazard) { hazardStreak++; clearStreak = 0; }
    else { clearStreak++; hazardStreak = 0; }

    if (hazard && hazardStreak >= 2) {
      const [x,y,bw,bh] = hazard.bbox;
      const cx = x + bw/2;
      const pos = positionLabel(cx, w);
      const veryClose = (bw*bh) > (w*h*0.14) && pos === 'directly ahead';
      const now = Date.now();
      if (!hazardActive || now - lastHazardSpokenAt > 3500) {
        const label = capitalize(hazard.class);
        const msg = veryClose ? ('STOP. ' + label + ' directly ahead.') : (label + ' ' + pos + '.');
        SpeechManager.speak(msg, 'safety');
        lastHazardSpokenAt = now;
      }
      if (!hazardActive) vibrate(300); // long vibration = safety warning, only on new hazard
      hazardActive = true;
      setState(STATE.SAFETY_ALERT);
      dom.cameraWrap.classList.add('alert');
    } else if (!hazard && clearStreak >= 2 && hazardActive) {
      hazardActive = false;
      dom.cameraWrap.classList.remove('alert');
      SpeechManager.speak('The path appears clear.', 'normal', () => {
        setState(searching ? STATE.SEARCHING_OBJECT : STATE.READY);
      });
    }
  }

  function handleSearchResult(targetHit, w, h){
    const now = Date.now();
    if (targetHit) {
      const [x,,bw,bh] = targetHit.bbox;
      const cx = x + bw/2;
      const pos = positionLabel(cx, w);
      const closeness = (bw*bh) > (w*h*0.15) ? ', close by' : '';
      if ((!objectVisible || now - lastFoundAt > 4500) && !SpeechManager.isSpeaking() && appState !== STATE.SAFETY_ALERT) {
        SpeechManager.speak(capitalize(searchTarget) + ' is ' + pos + closeness + '.', 'normal');
        lastFoundAt = now;
      }
      if (!objectVisible) vibrate([50,50,50]); // double vibration = target found
      objectVisible = true;
    } else {
      objectVisible = false;
      if (now - searchStartedAt > 8000 && now - lastNotFoundAnnounceAt > 9000 && !SpeechManager.isSpeaking() && appState !== STATE.SAFETY_ALERT) {
        SpeechManager.speak('I haven\'t found a ' + searchTarget + ' yet. Slowly scan left and right.', 'normal');
        lastNotFoundAnnounceAt = now;
      }
    }
  }

  function announceCurrentTargetPosition(){
    if (!searching) return;
    if (objectVisible) lastFoundAt = 0; // force fresh announce next cycle
    else SpeechManager.speak('I don\'t currently see the ' + searchTarget + '. Slowly scan left and right.', 'normal');
  }

  function startSearch(cls){
    searching = true;
    searchTarget = cls;
    objectVisible = false;
    searchStartedAt = Date.now();
    lastFoundAt = 0;
    lastNotFoundAnnounceAt = 0;
  }
  function stopSearch(){ searching = false; searchTarget = null; }

  function describeScene(callback){
    if (!model || !dom.video.videoWidth) {
      callback('I can\'t analyze the scene right now. The camera or object model isn\'t ready.');
      return;
    }
    model.detect(dom.video).then(predictions => {
      const w = dom.overlay.width || dom.video.videoWidth;
      const relevant = predictions.filter(p => p.score > 0.55);
      if (!relevant.length) {
        callback('I don\'t see anything I recognize clearly right now. Try moving the camera slowly.');
        return;
      }
      relevant.sort((a,b) => {
        const aHaz = HAZARD_CLASSES.has(a.class) ? 0 : 1;
        const bHaz = HAZARD_CLASSES.has(b.class) ? 0 : 1;
        if (aHaz !== bHaz) return aHaz - bHaz;
        return (b.bbox[2]*b.bbox[3]) - (a.bbox[2]*a.bbox[3]);
      });
      const sentences = relevant.slice(0,3).map(p => {
        const cx = p.bbox[0] + p.bbox[2]/2;
        return capitalize(p.class) + ' ' + positionLabel(cx, w) + '.';
      });
      callback(sentences.join(' '));
    }).catch(e => {
      logError('describeScene', e);
      callback('I had trouble analyzing the scene just now. Please try again.');
    });
  }

  function showRetryScreen(){
    dom.startScreen.style.display = 'flex';
    dom.mainScreen.classList.remove('active');
    dom.startBtn.textContent = 'Retry';
  }

  return { startCamera, loadModel, startLoop, startSearch, stopSearch, announceCurrentTargetPosition, describeScene, showRetryScreen };
})();

/* ================= OCR Manager ================= */
const OCRManager = (function(){
  let searching = false;
  let target = null;
  let loopId = null;
  let busy = false;
  let searchStartedAt = 0;
  let lastNotFoundAnnounceAt = 0;
  let lastUncertainAnnounceAt = 0;
  let wasFound = false;

  function captureFrame(){
    const c = document.createElement('canvas');
    c.width = dom.video.videoWidth;
    c.height = dom.video.videoHeight;
    c.getContext('2d').drawImage(dom.video, 0, 0, c.width, c.height);
    return c;
  }

  async function scanCycle(){
    if (busy || !searching || !dom.video.videoWidth || SpeechManager.isSpeaking()) return;
    busy = true;
    try {
      const canvas = captureFrame();
      const result = await Tesseract.recognize(canvas, 'eng');
      Debug.ocrResult = (result.data.text || '').trim().slice(0,120);
      const words = result.data.words || [];
      const targetClean = target.toLowerCase().replace(/[^a-z0-9]/g,'');
      const match = words.find(w => w.text && w.text.toLowerCase().replace(/[^a-z0-9]/g,'') === targetClean);
      const now = Date.now();
      if (match) {
        const cx = match.bbox.x0 + (match.bbox.x1 - match.bbox.x0)/2;
        const pos = positionLabel(cx, canvas.width);
        if (!SpeechManager.isSpeaking() && appState !== STATE.SAFETY_ALERT) {
          SpeechManager.speak(target + ' sign is ' + pos.replace('directly ahead','straight ahead') + '.', 'normal');
        }
        if (!wasFound) vibrate([50,50,50]);
        wasFound = true;
      } else {
        wasFound = false;
        const text = (result.data.text || '').trim();
        const avgConf = result.data.confidence || 0;
        if (text.length > 4 && avgConf < 45 && now - lastUncertainAnnounceAt > 9000 && now - searchStartedAt > 4000) {
          SpeechManager.speak('I see some text, but I can\'t read it confidently. Try moving closer.', 'normal');
          lastUncertainAnnounceAt = now;
        } else if (now - searchStartedAt > 8000 && now - lastNotFoundAnnounceAt > 9000) {
          SpeechManager.speak('I haven\'t found the ' + target + ' sign yet. Slowly scan the area.', 'normal');
          lastNotFoundAnnounceAt = now;
        }
      }
    } catch(e) {
      logError('OCR scan', e);
    } finally {
      busy = false;
    }
  }

  function startSearch(dest){
    searching = true;
    target = dest;
    searchStartedAt = Date.now();
    lastNotFoundAnnounceAt = 0;
    lastUncertainAnnounceAt = 0;
    wasFound = false;
    if (loopId) clearInterval(loopId);
    loopId = setInterval(scanCycle, 3500);
    scanCycle();
  }
  function stopSearch(){
    searching = false; target = null;
    if (loopId) { clearInterval(loopId); loopId = null; }
  }
  function announceCurrentTargetPosition(){ if (searching) scanCycle(); }

  async function readOnce(full){
    if (busy) { SpeechManager.speak('Please wait, I\'m still reading.', 'normal'); return; }
    if (!dom.video.videoWidth) { SpeechManager.speak('The camera isn\'t ready yet.', 'normal'); return; }
    busy = true;
    setState(STATE.THINKING);
    setCaption('Reading…');
    try {
      const canvas = captureFrame();
      const result = await Tesseract.recognize(canvas, 'eng');
      const text = (result.data.text || '').trim().replace(/\s+/g, ' ');
      Debug.ocrResult = text.slice(0,120);
      if (!text || (result.data.confidence || 0) < 35) {
        SpeechManager.speak('I can\'t read that clearly. Try moving closer or improving the light.', 'normal', () => setState(STATE.READY));
        return;
      }
      const words = text.split(' ');
      const toSpeak = (!full && words.length > 14)
        ? words.slice(0,14).join(' ') + '. Say read everything to hear all of it.'
        : text;
      SpeechManager.speak(toSpeak, 'normal', () => setState(STATE.READY));
    } catch(e) {
      logError('readOnce', e);
      SpeechManager.speak('I had trouble reading that. Please try again.', 'normal', () => setState(STATE.READY));
    } finally {
      busy = false;
    }
  }

  return { startSearch, stopSearch, announceCurrentTargetPosition, readOnce };
})();

/* ================= Commands ================= */
const Commands = (function(){
  function stop(){
    VisionManager.stopSearch();
    OCRManager.stopSearch();
    Context.currentIntent = null;
    Context.currentTarget = null;
    Context.mode = 'idle';
    setState(STATE.READY);
    SpeechManager.speak('Stopped.', 'normal');
  }
  function help(){
    SpeechManager.speak('You can ask what do you see, say find and an object or place, say read this to read text, say which way for the current target, or say stop.', 'normal');
  }
  function repeat(){
    SpeechManager.speak(Context.lastSpokenMessage || 'I haven\'t said anything yet.', 'normal');
  }
  function readThis(full){ OCRManager.readOnce(full); }
  function whichWay(){
    if (!Context.currentTarget) { SpeechManager.speak('You haven\'t asked me to find anything yet.', 'normal'); return; }
    if (Context.mode === 'object') VisionManager.announceCurrentTargetPosition();
    else if (Context.mode === 'sign') OCRManager.announceCurrentTargetPosition();
  }
  function describeScene(){
    setState(STATE.THINKING);
    VisionManager.describeScene(desc => SpeechManager.speak(desc, 'normal', () => setState(STATE.READY)));
  }
  function find(targetRaw){
    const objClass = matchObjectClass(targetRaw);
    Context.currentIntent = 'find';
    vibrate(20);
    if (objClass) {
      Context.currentTarget = objClass; Context.mode = 'object';
      OCRManager.stopSearch();
      VisionManager.startSearch(objClass);
      setState(STATE.SEARCHING_OBJECT);
      SpeechManager.speak('Looking for a ' + objClass + '. Slowly move your phone around.', 'normal');
    } else {
      const cap = capitalize(targetRaw);
      Context.currentTarget = cap; Context.mode = 'sign';
      VisionManager.stopSearch();
      OCRManager.startSearch(cap);
      setState(STATE.SEARCHING_SIGN);
      SpeechManager.speak('I can\'t visually recognize "' + targetRaw + '" as an object, so I\'ll watch for a sign that says ' + cap + '. Slowly scan the area.', 'normal');
    }
  }
  function unknown(){
    SpeechManager.speak('I can help you find objects or places, describe what\'s around you, or read text. Say help to hear more.', 'normal');
  }
  return { stop, help, repeat, readThis, whichWay, describeScene, find, unknown };
})();

/* ================= Intent Parser ================= */
const IntentParser = (function(){
  function normalize(s){ return s.toLowerCase().replace(/[.?!]+$/, '').trim(); }
  function handle(raw){
    const text = normalize(raw);
    if (!text) return;
    if (/^(stop|cancel|never ?mind)\b/.test(text)) return Commands.stop();
    if (/^help\b|what can you do/.test(text)) return Commands.help();
    if (/\brepeat\b/.test(text)) return Commands.repeat();
    if (/read (everything|it all|the whole)/.test(text)) return Commands.readThis(true);
    if (/^read\b/.test(text)) return Commands.readThis(false);
    if (/^(which way|where)\??$/.test(text)) return Commands.whichWay();
    if (/what.?s|what is|what do you see|(front|ahead|around)|anyone ahead|anyone in front/.test(text) &&
        /(see|front|ahead|around|anyone)/.test(text)) {
      return Commands.describeScene();
    }
    const findMatch = text.match(/^(find|go to|take me to|navigate to|where is|where's|locate|is there)\s+(a |an |the )?(.+)/);
    if (findMatch && findMatch[3]) return Commands.find(findMatch[3].trim());
    Commands.unknown();
  }
  return { handle };
})();

/* ================= Startup ================= */
async function runStartup(){
  setState(STATE.STARTING);
  setCaption('Starting MySight…');
  try {
    await VisionManager.startCamera();
  } catch(e) {
    logError('camera', e);
    Debug.camera = 'failed: ' + e.message;
    SpeechManager.speak('I couldn\'t start the camera. Please check camera permission and try again.', 'normal');
    VisionManager.showRetryScreen();
    return;
  }

  Debug.speech = SpeechManager.hasSupport() ? 'available' : 'unavailable';
  RecognitionManager.init();
  if (!RecognitionManager.hasSupport()) dom.fallbackControls.hidden = false;

  Debug.ocr = (typeof Tesseract !== 'undefined') ? 'available' : 'unavailable';

  VisionManager.loadModel().catch(e => {
    logError('model load', e);
    SpeechManager.speak('Object search isn\'t available right now, but I can still read signs and text.', 'normal');
  }).finally(() => VisionManager.startLoop());

  setState(STATE.READY);
  const capNote = RecognitionManager.hasSupport()
    ? ''
    : ' Voice commands aren\'t supported in this browser, so use the on-screen buttons instead.';
  SpeechManager.speak(
    'MySight is ready. You can ask me what I see, find something, or ask me to read text.' + capNote,
    'normal',
    () => { if (RecognitionManager.hasSupport()) RecognitionManager.start(); }
  );
}

/* ================= Wiring ================= */
dom.startBtn.addEventListener('click', () => {
  SpeechManager.primeSpeech();
  vibrate(40);
  dom.startScreen.style.display = 'none';
  dom.mainScreen.classList.add('active');
  runStartup();
});
dom.micBtn.addEventListener('click', () => {
  vibrate(30);
  if (SpeechManager.isSpeaking()) SpeechManager.cancelCurrent();
  RecognitionManager.start();
});
dom.fbDescribe.addEventListener('click', () => Commands.describeScene());
dom.fbFindChair.addEventListener('click', () => Commands.find('chair'));
dom.fbRead.addEventListener('click', () => Commands.readThis(false));
dom.fbStop.addEventListener('click', () => Commands.stop());

window.addEventListener('load', () => {
  setCaption('Welcome to MySight. Tap once to start.');
  // Best-effort: some browsers allow this without a gesture, most don't.
  // The Start button's own label is what a screen reader will read regardless.
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('Welcome to MySight. Tap once to start.')); }
    catch(e) { /* expected to silently fail on some browsers without a gesture */ }
  }
});

window.addEventListener('error', (e) => logError('window', e.message));
window.addEventListener('unhandledrejection', (e) => logError('promise', e.reason));

})();
