(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const startScreen = $('startScreen'), startBtn = $('startBtn'), mainScreen = $('mainScreen');
  const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
  const cameraWrap = $('cameraWrap'), safetyPill = $('safetyPill'), listenPill = $('listenPill');
  const currentCaption = $('currentCaption'), speakBtn = $('speakBtn');
  const transcriptToggleBtn = $('transcriptToggleBtn'), closeTranscriptBtn = $('closeTranscriptBtn');
  const transcriptPanel = $('transcriptPanel'), logList = $('logList'), ariaLive = $('ariaLive');

  // COCO-SSD can only recognise its trained classes. Do not pretend it can see
  // arbitrary things such as doors or corridors. Signs/destinations are handled by OCR.
  const HAZARDS = new Set(['person','chair','couch','bench','dining table','suitcase','backpack','bicycle','motorcycle','car','potted plant','umbrella','handbag','skateboard','fire hydrant','stop sign']);
  const OBJECTS = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'];
  const ALIASES = { phone:'cell phone', mobile:'cell phone', cellphone:'cell phone', bike:'bicycle', motorbike:'motorcycle', backpack:'backpack' };
  const PRIORITY = { system:1, navigation:2, sign:3, safety:4 };
  const hasRecognition = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  const hasSynthesis = 'speechSynthesis' in window;

  let stream=null, model=null, recognition=null;
  let recognitionActive=false, appStarted=false, speaking=false, voicesReady=false;
  let searchMode=null, destination='', objectTarget=null, objectVisible=false;
  let lastObjectAnnouncement=0, lastSafetyAnnouncement=0, lastSignEvidence='', lastSignAnnouncement=0;
  let signBusy=false, backgroundTimer=null, detectionBusy=false, detectionTimer=null, ocrTimer=null;
  let speechGeneration=0, activePriority=0;

  function log(text, kind='system') {
    currentCaption.textContent=text; currentCaption.className='current '+kind; ariaLive.textContent=text;
    const row=document.createElement('div'); row.className='log-entry '+kind;
    const time=document.createElement('span'); time.className='time';
    time.textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const txt=document.createElement('span'); txt.className='text'; txt.textContent=text;
    row.append(time,txt); logList.appendChild(row); logList.scrollTop=logList.scrollHeight;
  }

  function setListen(state) {
    listenPill.className='pill'+(state==='listening'?' listening':'');
    listenPill.querySelector('span:last-child').textContent=state==='listening'?'Listening…':state==='thinking'?'Thinking…':'Idle';
    speakBtn.classList.toggle('listening',state==='listening');
  }
  function normalize(text) { return String(text||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
  function capitalize(text) { return text ? text.charAt(0).toUpperCase()+text.slice(1) : text; }

  function prepareSpeech() {
    if(!hasSynthesis) return;
    window.speechSynthesis.cancel();
    voicesReady=window.speechSynthesis.getVoices().length>0;
    window.speechSynthesis.onvoiceschanged=()=>{voicesReady=true;};
  }
  function scheduleBackgroundListening(delay=600) {
    clearTimeout(backgroundTimer);
    if(!appStarted || !hasRecognition || speaking) return;
    backgroundTimer=setTimeout(()=>{ if(appStarted&&!speaking&&!recognitionActive) startRecognition(false); },delay);
  }
  function cancelSpeech() {
    speechGeneration++; if(hasSynthesis) window.speechSynthesis.cancel();
    speaking=false; activePriority=0; scheduleBackgroundListening(300);
  }
  function speak(text,kind='system',done) {
    log(text,kind);
    if(!hasSynthesis){ if(done)done(); scheduleBackgroundListening(300); return; }
    const priority=PRIORITY[kind]||1;
    if(speaking && priority<activePriority) return;
    speechGeneration++; const generation=speechGeneration;
    window.speechSynthesis.cancel(); speaking=false; activePriority=0;
    const start=()=>{
      if(!appStarted || generation!==speechGeneration) return;
      stopRecognition();
      const u=new SpeechSynthesisUtterance(text); u.rate=0.98; u.volume=1;
      speaking=true; activePriority=priority; let finished=false;
      const finish=()=>{ if(finished||generation!==speechGeneration)return; finished=true; speaking=false; activePriority=0; if(done)done(); scheduleBackgroundListening(500); };
      u.onend=finish; u.onerror=finish; window.speechSynthesis.speak(u);
      setTimeout(finish,Math.max(4000,text.length*120+2000));
    };
    if(voicesReady) start(); else setTimeout(()=>{voicesReady=true;start();},250);
  }

  function setSafety(state,text) {
    const dot=safetyPill.querySelector('.dot');
    if(state==='clear'){ safetyPill.className='pill safe'; safetyPill.querySelector('span:last-child').textContent='Path clear'; dot.style.background=''; cameraWrap.classList.remove('alert'); }
    else { safetyPill.className='pill'; safetyPill.querySelector('span:last-child').textContent=text||'Obstacle ahead'; dot.style.background='var(--safety)'; cameraWrap.classList.add('alert'); }
  }
  function resizeOverlay(){ if(video.videoWidth){overlay.width=video.videoWidth;overlay.height=video.videoHeight;} }

  async function openCamera(){
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable. Use HTTPS or localhost.');
    try { stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false}); }
    catch { stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); }
    video.srcObject=stream; await video.play(); resizeOverlay(); video.addEventListener('loadedmetadata',resizeOverlay,{once:true}); window.addEventListener('resize',resizeOverlay);
  }

  async function loadModel(){
    if(!window.tf || !window.cocoSsd) throw new Error('AI libraries did not load. Check internet/CDN access.');
    try { await tf.setBackend('webgl'); } catch { try { await tf.setBackend('cpu'); } catch {} }
    await tf.ready();
    log('AI backend: '+tf.getBackend(),'system');
    model=await cocoSsd.load({base:'lite_mobilenet_v2'});
    log('Object detection is ready. Point the camera at a person, chair, bottle, car, etc.','system');
  }

  function matchObject(phrase){
    const p=normalize(phrase);
    if(ALIASES[p]) return ALIASES[p];
    let best=null;
    for(const cls of OBJECTS){ if(p===cls||p===cls+'s'||p.includes(cls)){if(!best||cls.length>best.length)best=cls;} }
    return best;
  }
  function horizontal(box,width){ const cx=box[0]+box[2]/2; return cx<width*.34?'left':cx>width*.66?'right':'center'; }

  function pathState(predictions,w,h){
    let center=null,left=false,right=false;
    for(const p of predictions){
      if(!HAZARDS.has(p.class)||p.score<.45)continue;
      const [x,y,bw,bh]=p.bbox, area=bw*bh/(w*h), bottom=(y+bh)/h, cx=x+bw/2;
      if(area<.018||bottom<.55)continue;
      if(cx<w*.43)left=true; if(cx>w*.57)right=true;
      if(cx>=w*.28&&cx<=w*.72&&(!center||area>center.area))center={p,area};
    }
    return {center,left,right};
  }
  function safeDirection(s,w){
    if(s.left&&s.right)return null; if(s.left)return'right'; if(s.right)return'left';
    const [x,,bw]=s.center.p.bbox; return x+bw/2<w/2?'right':'left';
  }

  async function detect(){
    if(detectionBusy||!model||!appStarted||!video.videoWidth)return;
    detectionBusy=true;
    try{
      const predictions=await model.detect(video,15,.40); resizeOverlay();
      const w=overlay.width,h=overlay.height; ctx.clearRect(0,0,w,h);
      let target=null;
      for(const p of predictions){
        const [x,y,bw,bh]=p.bbox; const hazard=HAZARDS.has(p.class)&&p.score>=.40; const isTarget=searchMode==='object'&&p.class===objectTarget&&p.score>=.40;
        ctx.strokeStyle=isTarget?'#ffb13d':hazard?'#ff5a5f':'#4fd1c5'; ctx.lineWidth=isTarget?4:2; ctx.strokeRect(x,y,bw,bh);
        if(isTarget&&(!target||bw*bh>target.bbox[2]*target.bbox[3]))target=p;
      }
      const state=pathState(predictions,w,h),now=Date.now();
      if(state.center){
        const dir=safeDirection(state,w);
        if(!dir){setSafety('blocked','Path blocked');if(now-lastSafetyAnnouncement>3500){speak('Stop. The path ahead appears blocked.','safety');lastSafetyAnnouncement=now;}}
        else{setSafety('warning','Obstacle ahead');if(now-lastSafetyAnnouncement>3500){speak('Obstacle ahead. Move slightly '+dir+'.','safety');lastSafetyAnnouncement=now;}}
      }else setSafety('clear');

      if(searchMode==='object'&&objectTarget){
        if(target){ const pos=horizontal(target.bbox,w); if(!objectVisible||now-lastObjectAnnouncement>4500){speak(capitalize(objectTarget)+' spotted, '+(pos==='center'?'straight ahead':'to your '+pos)+'.','sign');lastObjectAnnouncement=now;} objectVisible=true; }
        else objectVisible=false;
      }
      // Useful on-screen proof during judging/debugging.
      if(predictions.length){ currentCaption.dataset.detections=predictions.filter(p=>p.score>=.4).map(p=>p.class).join(', '); }
    } finally { detectionBusy=false; }
  }

  function destinationMatches(text){
    const wanted=normalize(destination),seen=normalize(text); if(!wanted||!seen)return false;
    if(seen.includes(wanted))return true;
    const wantedWords=wanted.split(' ').filter(Boolean),seenWords=new Set(seen.split(' '));
    return wantedWords.length>1&&wantedWords.filter(w=>seenWords.has(w)).length/wantedWords.length>=.6;
  }

  async function scanSign(){
    if(signBusy||searchMode!=='sign'||!destination||!appStarted||!video.videoWidth||!window.Tesseract)return;
    signBusy=true;
    const canvas=document.createElement('canvas'),scale=Math.min(1,1280/video.videoWidth);
    canvas.width=Math.max(1,Math.round(video.videoWidth*scale)); canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
    const c=canvas.getContext('2d',{willReadFrequently:true}); c.drawImage(video,0,0,canvas.width,canvas.height);
    try{
      // Sparse-sign mode is much better for signs placed around a scene.
      const result=await Tesseract.recognize(canvas,'eng',{logger:()=>{},tessedit_pageseg_mode:11});
      const text=result?.data?.text||''; if(!destinationMatches(text))return;
      const words=Array.isArray(result?.data?.words)?result.data.words:[], wanted=normalize(destination).split(' ');
      const matched=words.filter(w=>wanted.some(t=>{const a=normalize(w.text);return a===t||a.includes(t)||t.includes(a);}));
      let pos='center';
      if(matched.length){const minX=Math.min(...matched.map(w=>w.bbox.x0)),maxX=Math.max(...matched.map(w=>w.bbox.x1));pos=horizontal([minX,0,Math.max(1,maxX-minX),1],canvas.width);}
      const evidence=normalize(text).slice(0,220),now=Date.now();
      if(evidence!==lastSignEvidence||now-lastSignAnnouncement>6000){
        speak(pos==='center'?capitalize(destination)+' sign ahead.':capitalize(destination)+' sign is to your '+pos+'.','sign');
        lastSignEvidence=evidence;lastSignAnnouncement=now;
      }
    }catch(e){log('OCR retry: '+(e.message||'OCR error'),'system');}finally{signBusy=false;}
  }
  function startSignSearch(dest){destination=dest;searchMode='sign';objectTarget=null;objectVisible=false;lastSignEvidence='';lastSignAnnouncement=0;clearInterval(ocrTimer);scanSign();ocrTimer=setInterval(scanSign,3500);}
  function startObjectSearch(cls){objectTarget=cls;searchMode='object';destination='';objectVisible=false;lastObjectAnnouncement=0;clearInterval(ocrTimer);ocrTimer=null;}

  function stopRecognition(){if(recognition&&recognitionActive){try{recognition.stop();}catch{}}recognitionActive=false;setListen('idle');}
  function startRecognition(manual=false){if(!recognition||recognitionActive||speaking||!appStarted)return;recognition._manual=manual;try{recognition.start();recognitionActive=true;setListen('listening');}catch{}}

  function initRecognition(){
    if(!hasRecognition)return;
    const Ctor=window.SpeechRecognition||window.webkitSpeechRecognition; recognition=new Ctor();
    recognition.lang='en-IN'; recognition.continuous=false; recognition.interimResults=false; recognition.maxAlternatives=3;
    recognition.onresult=(event)=>{recognitionActive=false;setListen('thinking');const heard=(event.results?.[0]?.[0]?.transcript||'').trim();if(heard){log('Heard: "'+heard+'"','system');handleVoice(heard);}else scheduleBackgroundListening(300);};
    recognition.onerror=(event)=>{const manual=!!recognition._manual;recognitionActive=false;setListen('idle');if(manual&&(event.error==='not-allowed'||event.error==='service-not-allowed'))speak('Microphone access is blocked. Allow microphone access and try again.','system');else if(manual&&event.error==='no-speech')speak('I did not hear you. Please try again.','system');else scheduleBackgroundListening(800);};
    recognition.onend=()=>{recognitionActive=false;setListen('idle');scheduleBackgroundListening(700);};
  }

  function extractQuery(heard){let q=normalize(heard);q=q.replace(/^(find|go to|take me to|navigate to|where is|where s|i want to go to|i need to find|look for|show me|locate)\s+/,'');q=q.replace(/^(the|a|an)\s+/,'');return q.trim();}
  function handleVoice(heard){const q=extractQuery(heard);if(!q){speak('I did not catch a destination. Please try again.','system');return;}const obj=matchObject(q);if(obj){startObjectSearch(obj);speak('Looking for the '+obj+'.','navigation');}else{startSignSearch(q);speak('Looking for '+capitalize(q)+'. I will scan signs and tell you left, right, or ahead.','navigation');}}
  function askDestination(){speak('Where do you want to go, or what are you looking for?','system',()=>startRecognition(true));}

  function createTextFallback(){
    if($('destinationFallback'))return;
    const box=document.createElement('div');box.id='destinationFallback';box.style.cssText='position:absolute;left:16px;right:16px;bottom:82px;z-index:20;display:flex;gap:8px;max-width:560px;margin:auto;';
    box.innerHTML='<input id="destinationInput" aria-label="Destination" placeholder="Type destination" style="flex:1;padding:14px 16px;border-radius:14px;border:1px solid #555;background:#111;color:#fff;font-size:16px"><button id="destinationGo" style="padding:14px 18px;border:0;border-radius:14px;font-weight:700;cursor:pointer">Go</button>';
    cameraWrap.appendChild(box);$('destinationGo').onclick=()=>{const q=normalize($('destinationInput').value);if(!q)return;const obj=matchObject(q);if(obj){startObjectSearch(obj);speak('Looking for the '+obj+'.','navigation');}else{startSignSearch(q);speak('Looking for '+capitalize(q)+'.','navigation');}};
  }

  speakBtn.addEventListener('click',()=>{if(!hasRecognition)return;if(recognitionActive){stopRecognition();return;}if(speaking)cancelSpeech();startRecognition(true);});
  transcriptToggleBtn.addEventListener('click',()=>transcriptPanel.classList.add('open')); closeTranscriptBtn.addEventListener('click',()=>transcriptPanel.classList.remove('open'));

  startBtn.addEventListener('click',async()=>{
    if(appStarted)return; startBtn.disabled=true;startBtn.textContent='Starting…';
    try{
      await openCamera(); appStarted=true;prepareSpeech();startScreen.style.display='none';mainScreen.classList.add('active');
      log('Camera ready. Starting AI…','system');
      try{await loadModel(); detectionTimer=setInterval(detect,500); await detect();}catch(e){log('AI detection unavailable: '+e.message,'system');}
      if(hasRecognition){initRecognition();askDestination();}else{createTextFallback();speak('Voice input is not supported here. Type a destination below.','system');}
    }catch(e){startBtn.disabled=false;startBtn.textContent='Start';log('Startup failed: '+(e.message||'permission denied'),'system');alert('MySight could not start. Use Chrome on HTTPS or localhost and allow camera access.');}
  });
})();