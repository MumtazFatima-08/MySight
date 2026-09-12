(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
  const startScreen = $('startScreen'), mainScreen = $('mainScreen'), startBtn = $('startBtn');
  const micBtn = $('speakBtn'), caption = $('currentCaption'), live = $('ariaLive');
  const status = $('safetyPill'), listen = $('listenPill'), transcript = $('transcriptPanel'), logs = $('logList');

  const COCO = new Set(['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush']);
  const HAZARDS = new Set(['person','bicycle','motorcycle','car','bus','truck','train','suitcase','backpack','chair','bench','couch','dining table','potted plant','stop sign']);
  const ALIAS = { phone:'cell phone', mobile:'cell phone', cellphone:'cell phone', bike:'bicycle', motorbike:'motorcycle', people:'person', human:'person' };
  const hasSR = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  const hasTTS = 'speechSynthesis' in window;

  let stream = null, model = null, rec = null;
  let running = false, listening = false, speaking = false, detecting = false, ocrBusy = false;
  let mode = 'look', target = '', targetClass = '';
  let lastSay = '', lastSayAt = 0, lastSafetyAt = 0, lastDetections = [];
  let detectTimer = null, ocrTimer = null, speechToken = 0;

  function normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
  function nice(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function sayLog(text, kind='system') {
    caption.textContent = text; caption.className = 'current ' + kind; live.textContent = text;
    if (!logs) return;
    const row = document.createElement('div'); row.className = 'log-entry ' + kind;
    row.innerHTML = `<span class="time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><span class="text"></span>`;
    row.querySelector('.text').textContent = text; logs.appendChild(row); logs.scrollTop = logs.scrollHeight;
  }
  function setListening(on, thinking=false) {
    listening = on; micBtn.classList.toggle('listening', on); listen.className = 'pill' + (on ? ' listening' : '');
    listen.querySelector('span:last-child').textContent = on ? 'Listening' : (thinking ? 'Thinking' : 'Ready');
  }
  function setSafety(text, danger=false) {
    status.className = 'pill ' + (danger ? 'warn' : 'safe');
    status.querySelector('span:last-child').textContent = text;
    $('cameraWrap').classList.toggle('alert', danger);
  }

  function stopRecognition() {
    if (rec && listening) { try { rec.stop(); } catch (_) {} }
    listening = false; setListening(false);
  }

  function speak(text, kind='system', force=false, done) {
    sayLog(text, kind);
    if (!hasTTS) { done?.(); return; }
    if (speaking && !force) return;
    const token = ++speechToken;
    window.speechSynthesis.cancel(); speaking = false; stopRecognition();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN'; u.rate = 0.94; u.pitch = 1; u.volume = 1;
    const finish = () => { if (token !== speechToken) return; speaking = false; done?.(); };
    u.onend = finish; u.onerror = finish;
    speaking = true; window.speechSynthesis.speak(u);
    setTimeout(finish, Math.max(3500, text.length * 105));
  }

  function horizontal(box, width) {
    const cx = box[0] + box[2] / 2;
    if (cx < width * .36) return 'left';
    if (cx > width * .64) return 'right';
    return 'ahead';
  }
  function distanceWord(box, w, h) {
    const area = (box[2] * box[3]) / (w * h);
    if (area > .30) return 'very close';
    if (area > .14) return 'close';
    if (area > .055) return 'nearby';
    return 'ahead';
  }
  function isRelevant(p) { return p && p.score >= .32 && COCO.has(p.class); }

  function obstacleState(predictions, w, h) {
    let center = null, left = false, right = false;
    for (const p of predictions) {
      if (!HAZARDS.has(p.class) || p.score < .35) continue;
      const [x,y,bw,bh] = p.bbox, cx = x + bw/2;
      const area = bw*bh/(w*h), bottom = (y+bh)/h;
      if (area < .012 || bottom < .48) continue;
      if (cx < w*.45) left = true;
      if (cx > w*.55) right = true;
      if (cx >= w*.30 && cx <= w*.70 && (!center || area > center.area)) center = {p,area};
    }
    return {center,left,right};
  }

  function safeSide(s) {
    if (s.left && s.right) return null;
    if (s.left) return 'right';
    if (s.right) return 'left';
    return s.center ? (s.center.p.bbox[0] + s.center.p.bbox[2]/2 < canvas.width/2 ? 'right' : 'left') : null;
  }

  function draw(predictions) {
    canvas.width = video.videoWidth || canvas.clientWidth;
    canvas.height = video.videoHeight || canvas.clientHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (const p of predictions) {
      if (!isRelevant(p)) continue;
      const [x,y,w,h] = p.bbox;
      ctx.strokeStyle = (targetClass && p.class === targetClass) ? '#ffb13d' : '#4fd1c5';
      ctx.lineWidth = (targetClass && p.class === targetClass) ? 5 : 2;
      ctx.strokeRect(x,y,w,h);
    }
  }

  function announceObject(p, requested=false) {
    const pos = horizontal(p.bbox, canvas.width);
    const dist = distanceWord(p.bbox, canvas.width, canvas.height);
    const text = requested
      ? `${nice(p.class)} is ${pos === 'ahead' ? 'straight ahead' : 'to your ' + pos}${dist === 'very close' || dist === 'close' ? ', ' + dist : ''}.`
      : `${nice(p.class)} ${pos === 'ahead' ? 'ahead' : 'on your ' + pos}.`;
    const now = Date.now();
    if (requested || text !== lastSay || now-lastSayAt > 5000) { lastSay=text; lastSayAt=now; speak(text,'sign'); }
  }

  async function detect() {
    if (!running || !model || detecting || !video.videoWidth) return;
    detecting = true;
    try {
      const predictions = await model.detect(video, 20, .30);
      lastDetections = predictions.filter(isRelevant);
      draw(predictions);
      const s = obstacleState(predictions, canvas.width, canvas.height);
      const now = Date.now();

      if (s.center) {
        const cls = s.center.p.class;
        const side = safeSide(s);
        setSafety(side ? 'Obstacle ahead' : 'STOP', true);
        if (now-lastSafetyAt > 2800) {
          if (!side) speak('STOP. There are obstacles ahead on both sides. Wait.', 'safety', true);
          else speak(`Stop. ${cls} ahead. Move slightly ${side} if the path is clear.`, 'safety', true);
          lastSafetyAt = now;
        }
      } else {
        setSafety('Path clear', false);
      }

      if (mode === 'find-object' && targetClass) {
        const hit = lastDetections.filter(p => p.class === targetClass).sort((a,b)=>(b.bbox[2]*b.bbox[3])-(a.bbox[2]*a.bbox[3]))[0];
        if (hit) announceObject(hit, now-lastSayAt > 3000 || lastSay === '');
      }

      if (mode === 'look' && now-lastSayAt > 8000 && lastDetections.length) {
        const useful = lastDetections.slice().sort((a,b)=>(b.bbox[2]*b.bbox[3])-(a.bbox[2]*a.bbox[3])).slice(0,2);
        const parts = useful.map(p => `${p.class} ${horizontal(p.bbox,canvas.width)==='ahead'?'ahead':'on your '+horizontal(p.bbox,canvas.width)}`);
        speak(`I can see ${parts.join(' and ')}.`,'system');
      }
    } catch (e) {
      console.error(e);
    } finally { detecting=false; }
  }

  function matches(text, wanted) {
    const a=normalize(text), b=normalize(wanted);
    if (!a || !b) return false;
    if (a.includes(b)) return true;
    const bw=b.split(' ').filter(Boolean);
    const aw=new Set(a.split(' '));
    return bw.length>1 && bw.filter(x=>aw.has(x)).length/bw.length >= .6;
  }

  async function scanText() {
    if (ocrBusy || !running || !window.Tesseract || !video.videoWidth || mode !== 'find-sign' || !target) return;
    ocrBusy=true;
    const c=document.createElement('canvas');
    const scale=Math.min(1, 1400/video.videoWidth); c.width=Math.round(video.videoWidth*scale); c.height=Math.round(video.videoHeight*scale);
    c.getContext('2d').drawImage(video,0,0,c.width,c.height);
    try {
      const r=await Tesseract.recognize(c,'eng',{logger:()=>{},tessedit_pageseg_mode:11});
      const text=r?.data?.text || '';
      if (!matches(text,target)) return;
      const words=Array.isArray(r?.data?.words) ? r.data.words : [];
      const wanted=normalize(target).split(' ');
      const hit=words.filter(w=>wanted.some(q=>{const x=normalize(w.text); return x===q || x.includes(q) || q.includes(x);}));
      let pos='ahead';
      if(hit.length){const x0=Math.min(...hit.map(w=>w.bbox.x0)),x1=Math.max(...hit.map(w=>w.bbox.x1));pos=horizontal([x0,0,Math.max(1,x1-x0),1],c.width);}
      const now=Date.now();
      const msg=pos==='ahead' ? `${nice(target)} sign is straight ahead.` : `${nice(target)} sign is to your ${pos}.`;
      if(now-lastSayAt>3500 || msg!==lastSay){lastSay=msg;lastSayAt=now;speak(msg,'sign');}
    } catch(e){ console.debug('OCR',e); }
    finally{ocrBusy=false;}
  }

  function stopSearch(){ mode='look'; target=''; targetClass=''; clearInterval(ocrTimer); ocrTimer=null; }
  function startObject(cls){ stopSearch(); mode='find-object'; targetClass=cls; speak(`Looking for ${cls}. Point the camera around.`, 'navigation'); }
  function startSign(q){ stopSearch(); mode='find-sign'; target=q; speak(`Looking for ${nice(q)}. Scan the area slowly. I will tell you left, right, or ahead.`, 'navigation'); ocrTimer=setInterval(scanText,3000); setTimeout(scanText,500); }

  function sceneSummary() {
    if (!lastDetections.length) return speak('I cannot identify a clear object yet. Move the camera slowly and ask again.','system');
    const list=lastDetections.slice().sort((a,b)=>(b.bbox[2]*b.bbox[3])-(a.bbox[2]*a.bbox[3])).slice(0,4);
    const parts=list.map(p=>{const pos=horizontal(p.bbox,canvas.width);return `${p.class} ${pos==='ahead'?'ahead':'to your '+pos}`;});
    speak(`I can see ${parts.join(', ')}.`,'system');
  }

  function roadQuestion() {
    const cars=lastDetections.filter(p=>['car','bus','truck','motorcycle','bicycle'].includes(p.class));
    const light=lastDetections.some(p=>p.class==='traffic light');
    if(cars.length) speak('I detect traffic nearby. Do not cross based on my camera alone. Wait and verify the road is clear or use a trusted crossing signal.','safety',true);
    else if(light) speak('I can see a traffic light, but I cannot confirm that it is safe for you to cross. Follow the crossing signal.','safety',true);
    else speak('I cannot confirm that it is safe to cross the road. Please use a crossing signal or trusted assistance.','safety',true);
  }

  function parseCommand(raw){
    const q=normalize(raw);
    if(/\b(stop|cancel|enough|go back)\b/.test(q)){stopSearch();speak('Stopped. I am back to looking around.','system');return;}
    if(/\b(what do you see|what can you see|describe|look around|tell me what is around)\b/.test(q)){sceneSummary();return;}
    if(/\b(cross|cross the road|cross road|road)\b/.test(q) && /\b(can|should|safe|cross)\b/.test(q)){roadQuestion();return;}
    if(/\b(read|read this|what does this say|what is written|read that)\b/.test(q)){startSign(''); mode='read'; speak('Reading. Hold the camera steady.','navigation'); ocrTimer=setInterval(async()=>{if(ocrBusy||!running||!video.videoWidth)return;ocrBusy=true;try{const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);const r=await Tesseract.recognize(c,'eng',{logger:()=>{},tessedit_pageseg_mode:11});const t=(r?.data?.text||'').replace(/\s+/g,' ').trim();if(t&&t!==lastSay){lastSay=t;lastSayAt=Date.now();speak(t,'sign');}}finally{ocrBusy=false;}},2500);return;}

    let cleaned=q.replace(/^(please |can you |could you )/,'').trim();
    cleaned=cleaned.replace(/^(find|look for|locate|where is|where s|take me to|go to|navigate to|show me)\s+/,'').replace(/^(the|a|an)\s+/,'').trim();
    if(!cleaned){speak('Tell me what you want me to find.','system');return;}
    const aliases=Object.keys(ALIAS).sort((a,b)=>b.length-a.length);
    let cls=null;
    for(const k of aliases){if(cleaned===k || cleaned.includes(k)){cls=ALIAS[k];break;}}
    if(!cls){for(const c of COCO){if(cleaned===c || cleaned===c+'s' || cleaned.includes(c)){cls=c;break;}}}
    if(cls){startObject(cls);return;}
    startSign(cleaned);
  }

  function initRecognition(){
    if(!hasSR) return;
    const C=window.SpeechRecognition||window.webkitSpeechRecognition;
    rec=new C(); rec.lang='en-IN'; rec.continuous=false; rec.interimResults=false; rec.maxAlternatives=3;
    rec.onstart=()=>setListening(true);
    rec.onresult=e=>{setListening(false,true);const t=e.results?.[0]?.[0]?.transcript||'';if(t)parseCommand(t);else setListening(false);};
    rec.onerror=e=>{setListening(false); if(e.error==='not-allowed'||e.error==='service-not-allowed') speak('Microphone permission is blocked. Allow the microphone and tap the microphone again.','system',true); else if(e.error==='no-speech') speak('I did not hear you. Tap the microphone and speak clearly.','system',true);};
    rec.onend=()=>setListening(false);
  }
  function listenNow(){
    if(!hasSR){speak('Voice input is not supported in this browser. Use Chrome.','system',true);return;}
    if(speaking){window.speechSynthesis.cancel();speaking=false;}
    try{rec?.start();}catch(_){setTimeout(()=>{try{rec?.start();}catch(__){}},250);}
  }

  async function camera(){
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is unavailable. Use HTTPS or localhost.');
    try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});}
    catch(_){stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});}
    video.srcObject=stream; await video.play();
  }
  async function ai(){
    if(!window.tf||!window.cocoSsd) throw new Error('AI libraries failed to load. Check internet connection.');
    try{await tf.setBackend('webgl');}catch(_){try{await tf.setBackend('cpu');}catch(__){}}
    await tf.ready(); model=await cocoSsd.load({base:'lite_mobilenet_v2'});
  }

  async function start(){
    startBtn.disabled=true; startBtn.textContent='Starting…';
    try{
      await camera();
      mainScreen.classList.add('active'); startScreen.style.display='none'; running=true;
      sayLog('MySight is ready. I am looking around.','system');
      speak('MySight is ready. Ask me what you see, say find pharmacy, or say read this.','system',true);
      initRecognition();
      ai().then(()=>{sayLog('Vision is ready.','system');detectTimer=setInterval(detect,450);}).catch(e=>sayLog('Vision model could not load. Check internet and reload.','safety'));
    }catch(e){startBtn.disabled=false;startBtn.textContent='Start';alert(e.message||'Could not start MySight.');}
  }

  startBtn.addEventListener('click',start);
  micBtn.addEventListener('click',listenNow);
  $('transcriptToggleBtn')?.addEventListener('click',()=>transcript.classList.add('open'));
  $('closeTranscriptBtn')?.addEventListener('click',()=>transcript.classList.remove('open'));

  window.addEventListener('beforeunload',()=>{clearInterval(detectTimer);clearInterval(ocrTimer);stream?.getTracks().forEach(t=>t.stop());});
})();