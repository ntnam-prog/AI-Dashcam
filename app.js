'use strict';

const $ = id => document.getElementById(id);
const video = $('camera');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const ui = {
  status: $('status'), fps: $('fps'), backend: $('backend'), distance: $('distanceMain'), lead: $('leadState'),
  closing: $('closingMain'), ttc: $('ttcMain'), quality: $('qualityText'), track: $('trackText'), readout: $('centerReadout'),
  start: $('startBtn'), cal: $('calBtn'), settings: $('settingsBtn'), panel: $('panel'), close: $('closePanelBtn'),
  save: $('saveCalBtn'), reset: $('resetCalBtn')
};

const inputs = {
  nearPct: $('nearRange'), nearM: $('nearDistance'), farPct: $('farRange'), farM: $('farDistance'),
  vanishX: $('vanishXRange'), laneCenter: $('laneCenterRange'), laneWidth: $('laneWidthRange'),
  score: $('scoreRange'), smooth: $('smoothRange'), aiHz: $('aiHzRange'), centerOnly: $('centerOnly'), showAll: $('showAll')
};
const labels = {
  nearPct: $('nearValue'), farPct: $('farValue'), vanishX: $('vanishXValue'), laneCenter: $('laneCenterValue'),
  laneWidth: $('laneWidthValue'), score: $('scoreValue'), smooth: $('smoothValue'), aiHz: $('aiHzValue'), cal: $('calResult')
};

const VEHICLES = new Set(['car','truck','bus','motorcycle']);
const CFG_KEY = 'distanceadas_cfg_v10b';
const defaults = {
  nearPct: 82, nearM: 5,
  farPct: 58, farM: 20,
  vanishXPct: 50, laneCenterBottomPct: 50, laneWidthBottomPct: 62,
  scoreThreshold: 0.45, smoothingAlpha: 0.30, aiHz: 9,
  centerOnly: true, showAll: true
};

let cfg = loadCfg();
let stream = null, model = null, running = false, aiBusy = false, drawRAF = 0;
let lastAIEnd = 0, fpsSmooth = 0, lastPredictions = [], leadTrack = null, nextTrackId = 1;

function loadCfg() {
  try { return {...defaults, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}')}; }
  catch { return {...defaults}; }
}
function saveCfg(){ localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

function calibrationFrom(c) {
  const y1 = c.nearPct / 100; // near point, lower in image
  const y2 = c.farPct / 100;
  const d1 = Number(c.nearM), d2 = Number(c.farM);
  if (!(d1 > 0 && d2 > d1 && y1 > y2 + 0.01)) return null;
  const yh = (d1*y1 - d2*y2) / (d1-d2);
  const k = d1 * (y1-yh);
  if (!Number.isFinite(yh) || !Number.isFinite(k) || k <= 0 || yh < 0.05 || yh > 0.80 || yh >= y2) return null;
  return {horizonPct:yh*100, kNorm:k};
}
function currentCalibration(){ return calibrationFrom(cfg); }

function tempCfgFromControls(){
  return {
    nearPct:Number(inputs.nearPct.value), nearM:Number(inputs.nearM.value), farPct:Number(inputs.farPct.value), farM:Number(inputs.farM.value),
    vanishXPct:Number(inputs.vanishX.value), laneCenterBottomPct:Number(inputs.laneCenter.value), laneWidthBottomPct:Number(inputs.laneWidth.value),
    scoreThreshold:Number(inputs.score.value), smoothingAlpha:Number(inputs.smooth.value), aiHz:Number(inputs.aiHz.value),
    centerOnly:inputs.centerOnly.checked, showAll:inputs.showAll.checked
  };
}
function syncControls(){
  inputs.nearPct.value=cfg.nearPct; inputs.nearM.value=cfg.nearM; inputs.farPct.value=cfg.farPct; inputs.farM.value=cfg.farM;
  inputs.vanishX.value=cfg.vanishXPct; inputs.laneCenter.value=cfg.laneCenterBottomPct; inputs.laneWidth.value=cfg.laneWidthBottomPct;
  inputs.score.value=cfg.scoreThreshold; inputs.smooth.value=cfg.smoothingAlpha; inputs.aiHz.value=cfg.aiHz;
  inputs.centerOnly.checked=cfg.centerOnly; inputs.showAll.checked=cfg.showAll; updateLabels();
}
function updateLabels(){
  labels.nearPct.textContent=`${Number(inputs.nearPct.value).toFixed(1)}%`;
  labels.farPct.textContent=`${Number(inputs.farPct.value).toFixed(1)}%`;
  labels.vanishX.textContent=`${Number(inputs.vanishX.value).toFixed(1)}%`;
  labels.laneCenter.textContent=`${Number(inputs.laneCenter.value).toFixed(1)}%`;
  labels.laneWidth.textContent=`${Number(inputs.laneWidth.value).toFixed(0)}%`;
  labels.score.textContent=Number(inputs.score.value).toFixed(2);
  labels.smooth.textContent=Number(inputs.smooth.value).toFixed(2);
  labels.aiHz.textContent=`${Number(inputs.aiHz.value).toFixed(0)} Hz`;
  const cal=calibrationFrom(tempCfgFromControls());
  labels.cal.classList.toggle('bad',!cal);
  labels.cal.textContent=cal ? `Horizon tính toán: ${cal.horizonPct.toFixed(1)}% • K: ${cal.kNorm.toFixed(3)} ảnh·m` : 'Hiệu chuẩn chưa hợp lệ: điểm GẦN phải thấp hơn và có khoảng cách nhỏ hơn điểm XA.';
}
Object.values(inputs).forEach(el=>{ if(el?.tagName==='INPUT') el.addEventListener('input',updateLabels); });
function openPanel(){ syncControls(); ui.panel.classList.remove('hidden'); ui.panel.setAttribute('aria-hidden','false'); }
function closePanel(){ ui.panel.classList.add('hidden'); ui.panel.setAttribute('aria-hidden','true'); }
ui.cal.addEventListener('click',openPanel); ui.settings.addEventListener('click',openPanel); ui.close.addEventListener('click',closePanel);
ui.reset.addEventListener('click',()=>{ cfg={...defaults}; saveCfg(); syncControls(); leadTrack=null; });
ui.save.addEventListener('click',()=>{
  const next=tempCfgFromControls();
  if(!calibrationFrom(next)) return alert('Hiệu chuẩn 2 điểm chưa hợp lệ. Hãy kiểm tra vị trí và khoảng cách GẦN/XA.');
  cfg=next; saveCfg(); leadTrack=null; closePanel(); updateQuality();
});

function resizeCanvas(){
  const dpr=Math.min(window.devicePixelRatio||1,2), rect=canvas.getBoundingClientRect();
  const w=Math.round(rect.width*dpr), h=Math.round(rect.height*dpr);
  if(canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',resizeCanvas);
window.addEventListener('orientationchange',()=>setTimeout(resizeCanvas,250));

function coverTransform(){
  const cw=canvas.clientWidth,ch=canvas.clientHeight,vw=video.videoWidth||1,vh=video.videoHeight||1;
  const scale=Math.max(cw/vw,ch/vh), drawW=vw*scale, drawH=vh*scale;
  return {cw,ch,vw,vh,scale,offsetX:(cw-drawW)/2,offsetY:(ch-drawH)/2};
}
function imageToScreenBox([x,y,w,h],t){ return {x:t.offsetX+x*t.scale,y:t.offsetY+y*t.scale,w:w*t.scale,h:h*t.scale}; }
function iou(a,b){
  if(!a||!b) return 0;
  const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);
  const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1), union=a.w*a.h+b.w*b.h-inter;
  return union>0?inter/union:0;
}

function distanceFromScreenY(yPx,h){
  const cal=currentCalibration(); if(!cal) return null;
  const yn=yPx/h, yh=cal.horizonPct/100, denom=yn-yh;
  if(denom<=0.003) return null;
  const d=cal.kNorm/denom;
  return Number.isFinite(d)&&d>=0.5&&d<=250?d:null;
}
function horizonY(h){ const cal=currentCalibration(); return h*(cal?cal.horizonPct/100:0.43); }
function laneCenterAtY(y,w,h){
  const yh=horizonY(h), t=Math.max(0,Math.min(1,(y-yh)/Math.max(1,h-yh)));
  const vanish=w*cfg.vanishXPct/100, bottom=w*cfg.laneCenterBottomPct/100;
  return vanish+(bottom-vanish)*Math.pow(t,0.92);
}
function laneHalfWidthAtY(y,w,h){
  const yh=horizonY(h); if(y<=yh) return 0;
  const t=Math.max(0,Math.min(1,(y-yh)/(h-yh)));
  return w*cfg.laneWidthBottomPct/200*Math.pow(t,0.92);
}
function laneBoundsAtY(y,w,h){ const c=laneCenterAtY(y,w,h),half=laneHalfWidthAtY(y,w,h); return {left:c-half,right:c+half,center:c,half}; }

function makeCandidates(predictions,t){
  const out=[];
  for(const p of predictions||[]){
    if(!VEHICLES.has(p.class)||p.score<cfg.scoreThreshold) continue;
    const b=imageToScreenBox(p.bbox,t);
    if(b.x+b.w<0||b.x>t.cw||b.y+b.h<0||b.y>t.ch||b.w<8||b.h<8) continue;
    const cx=b.x+b.w/2, bottomY=Math.min(t.ch,b.y+b.h);
    const d=distanceFromScreenY(bottomY,t.ch); if(!d) continue;
    const lane=laneBoundsAtY(bottomY,t.cw,t.ch), inLane=cx>=lane.left&&cx<=lane.right;
    if(cfg.centerOnly&&!inLane) continue;
    const centerPenalty=Math.abs(cx-lane.center)/Math.max(1,lane.half);
    const proximity=1/Math.max(1,d), bottomNorm=Math.min(1,bottomY/t.ch), areaNorm=Math.min(1,(b.w*b.h)/(t.cw*t.ch)*8);
    let rank=p.score*3+proximity*12+bottomNorm*1.1+areaNorm*.65-centerPenalty*1.35+(inLane?1.35:0);
    if(leadTrack){
      const overlap=iou(b,leadTrack.box), diag=Math.hypot(t.cw,t.ch);
      const move=Math.hypot(cx-leadTrack.cx,bottomY-leadTrack.by)/Math.max(1,diag);
      const classBonus=p.class===leadTrack.className?.replace('motorcycle','motorcycle') ? .25 : 0;
      rank+=overlap*2.8+Math.max(0,1-move/.22)*.9+classBonus;
    }
    out.push({p,b,cx,bottomY,d,inLane,rank});
  }
  out.sort((a,b)=>b.rank-a.rank); return out;
}

function robustSlope(history){
  if(!history||history.length<4) return null;
  const pairs=[];
  for(let i=0;i<history.length;i++) for(let j=i+1;j<history.length;j++){
    const dt=(history[j].t-history[i].t)/1000; if(dt>=0.18) pairs.push((history[j].d-history[i].d)/dt);
  }
  if(!pairs.length) return null;
  pairs.sort((a,b)=>a-b); const m=Math.floor(pairs.length/2);
  return pairs.length%2?pairs[m]:(pairs[m-1]+pairs[m])/2;
}
function pushHistory(track,now,d){
  const h=(track.history||[]).filter(s=>now-s.t<=2200); h.push({t:now,d});
  if(h.length>18) h.splice(0,h.length-18); return h;
}
function updateLeadTracking(primary,now,t){
  if(!primary){
    if(leadTrack&&now-leadTrack.lastSeen<650){ leadTrack.stale=true; return leadTrack; }
    leadTrack=null; return null;
  }
  if(!leadTrack){
    leadTrack={id:nextTrackId++,cx:primary.cx,by:primary.bottomY,box:primary.b,className:primary.p.class,dRaw:primary.d,dSmooth:primary.d,lastSeen:now,stale:false,history:[{t:now,d:primary.d}],closing:null,ttc:null,score:primary.p.score,inLane:primary.inLane};
    return leadTrack;
  }
  const diag=Math.hypot(t.cw,t.ch), move=Math.hypot(primary.cx-leadTrack.cx,primary.bottomY-leadTrack.by)/Math.max(1,diag), overlap=iou(primary.b,leadTrack.box);
  const dJump=Math.abs(primary.d-leadTrack.dSmooth)/Math.max(1,leadTrack.dSmooth);
  if(overlap<.03&&move>.20&&dJump>.38&&now-leadTrack.lastSeen<450){ leadTrack.stale=true; return leadTrack; }
  const a=cfg.smoothingAlpha, ds=leadTrack.dSmooth*(1-a)+primary.d*a;
  const history=pushHistory(leadTrack,now,ds), slope=robustSlope(history), closing=slope==null?null:-slope;
  const safeClosing=closing!=null&&closing>0.25&&closing<35?closing:null;
  const ttc=safeClosing?ds/safeClosing:null;
  leadTrack={...leadTrack,cx:primary.cx,by:primary.bottomY,box:primary.b,className:primary.p.class,dRaw:primary.d,dSmooth:ds,lastSeen:now,stale:false,history,closing:safeClosing,ttc:ttc&&ttc<99?ttc:null,score:primary.p.score,inLane:primary.inLane};
  return leadTrack;
}

function updateQuality(){
  const cal=currentCalibration();
  ui.quality.textContent=cal?`CAL: 2 điểm • H ${cal.horizonPct.toFixed(1)}%`:'CAL: KHÔNG HỢP LỆ';
}
function updateReadout(track){
  ui.readout.classList.remove('state-warning','state-danger','state-idle');
  if(!track){ ui.distance.textContent='--.-'; ui.lead.textContent='CHƯA CÓ XE DẪN'; ui.closing.textContent='Δv --.- m/s'; ui.ttc.textContent='TTC --.- s'; ui.track.textContent='TRACK: --'; ui.readout.classList.add('state-idle'); return; }
  ui.distance.textContent=track.dSmooth.toFixed(track.dSmooth<10?1:0);
  ui.lead.textContent=track.stale?'ĐANG GIỮ XE DẪN':'XE DẪN TRONG LÀN';
  ui.closing.textContent=track.closing?`Đóng ${track.closing.toFixed(1)} m/s`:'Δv ổn định';
  ui.ttc.textContent=track.ttc?`TTC ${track.ttc.toFixed(1)} s`:'TTC --.- s';
  ui.track.textContent=`TRACK: #${track.id}${track.stale?' HOLD':''}`;
  if(track.ttc&&track.ttc<2.2) ui.readout.classList.add('state-danger');
  else if((track.ttc&&track.ttc<4)||track.dSmooth<8) ui.readout.classList.add('state-warning');
}

function drawGuides(){
  const w=canvas.clientWidth,h=canvas.clientHeight,yh=horizonY(h), yNear=h*cfg.nearPct/100, yFar=h*cfg.farPct/100;
  const bottom=laneBoundsAtY(h,w,h), vanishX=w*cfg.vanishXPct/100;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(vanishX,yh); ctx.lineTo(bottom.right,h); ctx.lineTo(bottom.left,h); ctx.closePath(); ctx.fillStyle='rgba(20,240,120,.065)'; ctx.fill();
  ctx.strokeStyle='rgba(20,240,120,.82)'; ctx.lineWidth=3; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(vanishX,yh);ctx.lineTo(bottom.left,h);ctx.moveTo(vanishX,yh);ctx.lineTo(bottom.right,h);ctx.stroke();
  ctx.strokeStyle='rgba(255,70,70,.90)';ctx.lineWidth=2;ctx.setLineDash([12,8]);ctx.beginPath();ctx.moveTo(0,yh);ctx.lineTo(w,yh);ctx.stroke();
  ctx.strokeStyle='rgba(255,210,30,.92)';ctx.setLineDash([8,7]);ctx.beginPath();ctx.moveTo(0,yNear);ctx.lineTo(w,yNear);ctx.stroke();
  ctx.strokeStyle='rgba(70,180,255,.92)';ctx.beginPath();ctx.moveTo(0,yFar);ctx.lineTo(w,yFar);ctx.stroke();
  ctx.restore();
}
function drawBox(item,isPrimary,track,t){
  const {p,b,d,inLane}=item; const labelD=isPrimary&&track?track.dSmooth:d;
  ctx.save(); ctx.lineWidth=isPrimary?4:2; ctx.strokeStyle=isPrimary?'rgba(20,255,120,.98)':(inLane?'rgba(80,190,255,.88)':'rgba(170,170,170,.60)'); ctx.strokeRect(b.x,b.y,b.w,b.h);
  ctx.fillStyle='rgba(255,210,30,.98)';ctx.beginPath();ctx.arc(item.cx,item.bottomY,isPrimary?6:4,0,Math.PI*2);ctx.fill();
  const tag=isPrimary?'LEAD':(inLane?'LANE':'SIDE'), label=`${tag} • ${p.class} ${(p.score*100).toFixed(0)}% • ${labelD.toFixed(labelD<10?1:0)} m`;
  ctx.font=`${isPrimary?'700 16px':'600 12px'} -apple-system,sans-serif`; const tw=ctx.measureText(label).width;
  const tx=Math.max(4,Math.min(b.x,t.cw-tw-12)),ty=Math.max(24,b.y-7);ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(tx-4,ty-19,tw+8,23);ctx.fillStyle='#fff';ctx.fillText(label,tx,ty-2);ctx.restore();
}
function drawPredictions(predictions){
  resizeCanvas(); const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);drawGuides();
  const t=coverTransform(), candidates=makeCandidates(predictions,t), primary=candidates[0]||null, track=updateLeadTracking(primary,performance.now(),t); updateReadout(track);
  for(const item of candidates){ if(!cfg.showAll&&item!==primary) continue; drawBox(item,item===primary,track,t); }
}

const AI_FILES = {
  tfLocal: './vendor/tf.min.js',
  tfRemote: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  cocoLocal: './vendor/coco-ssd.min.js',
  cocoRemote: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3',
  modelLocal: './models/coco-ssd/model.json',
  modelRemote: 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json'
};

function timeoutPromise(promise, ms, label='Tác vụ'){
  let timer;
  return Promise.race([
    promise.finally(()=>clearTimeout(timer)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} quá ${Math.round(ms/1000)} giây`)),ms);})
  ]);
}
function loadScript(src, timeout=15000){
  return timeoutPromise(new Promise((resolve,reject)=>{
    const el=document.createElement('script');
    el.src=src; el.async=true;
    el.onload=()=>resolve(src);
    el.onerror=()=>reject(new Error(`Không tải được ${src}`));
    document.head.appendChild(el);
  }),timeout,`Tải ${src}`);
}
async function loadScriptPreferLocal(localUrl, remoteUrl, globalName){
  if(window[globalName]) return 'đã có';
  try{
    ui.status.textContent=`Đang nạp thư viện AI nội bộ…`;
    await loadScript(localUrl,5000);
    if(!window[globalName]) throw new Error(`${globalName} chưa được tạo`);
    return 'local';
  }catch(localErr){
    console.warn('Local AI library unavailable:',localErr);
    ui.status.textContent='Thiếu thư viện AI nội bộ • thử Internet…';
    await loadScript(remoteUrl,20000);
    if(!window[globalName]) throw new Error(`${globalName} không khởi tạo từ CDN`);
    return 'internet';
  }
}
async function localModelExists(){
  try{
    const r=await timeoutPromise(fetch(AI_FILES.modelLocal,{cache:'no-store'}),4000,'Kiểm tra model local');
    return r.ok;
  }catch{return false;}
}
async function ensureAILibraries(){
  const tfSource=await loadScriptPreferLocal(AI_FILES.tfLocal,AI_FILES.tfRemote,'tf');
  const cocoSource=await loadScriptPreferLocal(AI_FILES.cocoLocal,AI_FILES.cocoRemote,'cocoSsd');
  return {tfSource,cocoSource};
}
async function chooseBackend(){
  const attempts=['webgl','cpu'];
  for(const name of attempts){
    try{
      const ok=await tf.setBackend(name);
      if(ok!==false){await tf.ready(); return tf.getBackend();}
    }catch(err){console.warn(`Backend ${name} lỗi`,err);}
  }
  await tf.ready(); return tf.getBackend();
}
async function initModel(){
  if(model)return model;
  ui.status.textContent='Khởi tạo TensorFlow…';
  const libs=await ensureAILibraries();
  const backendName=await chooseBackend();
  ui.backend.textContent=`TF ${backendName}`;

  const hasLocal=await localModelExists();
  const attempts=hasLocal
    ? [{url:AI_FILES.modelLocal,label:'LOCAL',timeout:45000},{url:AI_FILES.modelRemote,label:'NET',timeout:45000}]
    : [{url:AI_FILES.modelRemote,label:'NET',timeout:45000}];
  let lastErr=null;
  for(const a of attempts){
    try{
      ui.status.textContent=a.label==='LOCAL'?'Đang nạp model AI nội bộ…':'Đang tải model AI từ Internet…';
      model=await timeoutPromise(cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:a.url}),a.timeout,`Model ${a.label}`);
      ui.status.textContent=`AI sẵn sàng • ${a.label}`;
      ui.backend.textContent=`TF ${backendName} • ${a.label}`;
      console.info('AI ready',{backendName,modelSource:a.label,libs});
      return model;
    }catch(err){lastErr=err;console.error(`Model ${a.label} failed`,err);}
  }
  throw new Error(`Không nạp được model AI. ${lastErr?.message||''}`.trim());
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){ alert('Camera web cần HTTPS hoặc localhost.'); return; }
  stopCamera(false); ui.status.textContent='Đang mở camera…';
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}});
    video.srcObject=stream;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Camera không trả metadata')),10000);
      if(video.readyState>=1){clearTimeout(timer);resolve();return;}
      video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};
    });
    await video.play(); resizeCanvas();
  }catch(err){
    console.error('Camera error',err); ui.status.textContent='Lỗi camera';
    alert(`Không mở được camera: ${err.message||err}. Hãy cấp quyền Camera và dùng HTTPS/localhost.`); return;
  }

  running=true; ui.start.textContent='DỪNG'; lastAIEnd=0;
  try{
    await initModel();
    ui.status.textContent='Đang đo khoảng cách';
    if(!drawRAF) drawRAF=requestAnimationFrame(loop);
  }catch(err){
    console.error('AI init error',err);
    ui.status.textContent='AI chưa sẵn sàng';
    ui.fps.textContent='AI ERROR';
    alert(`AI chưa nạp được. Camera vẫn hoạt động.\n\n${err.message||err}\n\nHãy chạy SETUP_LOCAL_AI.bat trong thư mục ứng dụng rồi tải lại trang.`);
  }
}
function stopCamera(updateUI=true){
  running=false; aiBusy=false; if(drawRAF){cancelAnimationFrame(drawRAF);drawRAF=0;} if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;leadTrack=null;lastPredictions=[];
  if(updateUI){ui.start.textContent='BẬT CAMERA';ui.status.textContent='Đã dừng';updateReadout(null);} resizeCanvas();ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);drawGuides();
}
ui.start.addEventListener('click',()=>running?stopCamera(true):startCamera());

async function loop(ts){
  drawRAF=0;if(!running)return;const interval=1000/Math.max(1,cfg.aiHz);
  if(!aiBusy&&model&&video.readyState>=2&&ts-lastAIEnd>=interval){
    aiBusy=true;const started=performance.now();
    try{const preds=await model.detect(video,18);lastPredictions=preds;drawPredictions(preds);const elapsed=performance.now()-started,instant=1000/Math.max(elapsed,1);fpsSmooth=fpsSmooth?fpsSmooth*.78+instant*.22:instant;ui.fps.textContent=`AI ${fpsSmooth.toFixed(1)} FPS`;}
    catch(err){console.error(err);ui.status.textContent='AI lỗi 1 frame';}
    finally{lastAIEnd=performance.now();aiBusy=false;}
  }
  if(running)drawRAF=requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange',()=>{ if(document.hidden&&running) stopCamera(true); });
window.addEventListener('pagehide',()=>{ if(running) stopCamera(false); });

syncControls();resizeCanvas();updateQuality();drawGuides();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
