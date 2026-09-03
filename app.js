'use strict';

const $ = id => document.getElementById(id);
const video = $('camera');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const ui = {
  status:$('status'), fps:$('fps'), backend:$('backend'), distance:$('distanceMain'), lead:$('leadState'),
  laneMain:$('laneMain'), trackCount:$('trackCount'), quality:$('qualityText'), track:$('trackText'), readout:$('centerReadout'), hint:$('hint'),
  start:$('startBtn'), videoBtn:$('videoBtn'), videoFile:$('videoFile'), cal:$('calBtn'), settings:$('settingsBtn'), panel:$('panel'), close:$('closePanelBtn'),
  save:$('saveCalBtn'), reset:$('resetCalBtn'), network:$('networkState'), gpsSpeed:$('gpsSpeed'), closingSpeed:$('closingSpeed'), leadSpeed:$('leadSpeed')
};
const inputs = {
  cameraHeight:$('cameraHeight'), cameraHeightRange:$('cameraHeightRange'), horizon:$('horizonRange'),
  laneCount:$('laneCountRange'), egoLane:$('egoLaneRange'), vanishX:$('vanishXRange'), laneCenter:$('laneCenterRange'), laneWidth:$('laneWidthRange'),
  score:$('scoreRange'), smooth:$('smoothRange'), aiHz:$('aiHzRange'), showAll:$('showAll'), gpsSpeedEnabled:$('gpsSpeedEnabled')
};
const labels = {
  cameraHeight:$('cameraHeightValue'), horizon:$('horizonValue'), laneCount:$('laneCountValue'), egoLane:$('egoLaneValue'), vanishX:$('vanishXValue'),
  laneCenter:$('laneCenterValue'), laneWidth:$('laneWidthValue'), score:$('scoreValue'), smooth:$('smoothValue'), aiHz:$('aiHzValue'), cal:$('calResult')
};

const VEHICLES = new Set(['car','truck','bus','motorcycle']);
const CFG_KEY = 'distanceadas_cfg_v11b6r3';
const APP_VERSION = 'v1.1 beta.6R3';
const RED_DISTANCE_M = 100;
const defaults = {
  cameraHeight:1.20, horizonPct:50.0, effectiveVFovDeg:42, calLocked:true, autoGeometry:true,
  calLines:{10:65.64,20:57.82,30:55.21,50:53.13,70:52.23,100:51.56},
  laneCount:4, egoLane:2, autoLane:true, vanishXPct:50, laneCenterBottomPct:50, laneWidthBottomPct:22,
  scoreThreshold:0.34, smoothingAlpha:0.28, aiHz:12, showAll:false, gpsSpeedEnabled:true
};

let cfg = loadCfg();
let stream=null, model=null, running=false, aiBusy=false, drawRAF=0, sourceMode='none', videoObjectUrl=null;
let yoloSession=null, yoloReady=false, yoloLoading=false, yoloDisabled=false, yoloLastRun=0;
let lastAIEnd=0, fpsSmooth=0, tracks=[], nextTrackId=1, lastPredictions=[], lockedLeadId=null;
let detectFrame=0, sceneLuma=1, detectMode='FULL';
const FAR_WATCH_WIDTH=0.30;
const YOLO_INPUT=640;
const YOLO_MODEL_URL='https://huggingface.co/MikeLud/ObjectDetectionYOLO11-ONNX/resolve/main/yolo11n-seg.onnx?download=true';
const ORT_URL='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js';
const YOLO_VEHICLE_CLASSES=new Map([[2,'car'],[3,'motorcycle'],[5,'bus'],[7,'truck']]);
let gpsWatchId=null, egoSpeedKmh=null, egoSpeedSmooth=null, lastGpsAt=0;

const roiCanvas=document.createElement('canvas');
const roiCtx=roiCanvas.getContext('2d',{willReadFrequently:false});
const fullCanvas=document.createElement('canvas');
const fullCtx=fullCanvas.getContext('2d',{willReadFrequently:false});
const yoloCanvas=document.createElement('canvas'); yoloCanvas.width=YOLO_INPUT; yoloCanvas.height=YOLO_INPUT;
const yoloCtx=yoloCanvas.getContext('2d',{willReadFrequently:true});
const lightCanvas=document.createElement('canvas'); lightCanvas.width=32; lightCanvas.height=18;
const lightCtx=lightCanvas.getContext('2d',{willReadFrequently:true});

const geoCanvas=document.createElement('canvas'); geoCanvas.width=192; geoCanvas.height=108;
const geoCtx=geoCanvas.getContext('2d',{willReadFrequently:true});
let geoState={mode:'IDLE',confidence:0,lastRun:0,samples:[],lockedAt:0,lastGood:null};
let laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};

function median(a){const b=[...a].sort((x,y)=>x-y),n=b.length;return n?b[Math.floor(n/2)]:null;}
function resetAutoGeometry(show=true){
  geoState={mode:'SEARCH',confidence:0,lastRun:0,samples:[],lockedAt:0,lastGood:null};
  if(show){ui.status.textContent='AUTO CAL • đang tìm mặt đường';ui.hint.textContent='AUTO CAL đang tìm điểm tụ/vạch đường. Giữ điện thoại cố định vài giây.';}
  updateQuality();
}
function lineEdgeScore(edge,w,h,vx,vy,bx){
  let sum=0,count=0; const y0=Math.max(vy+4,Math.floor(h*0.48));
  for(let y=y0;y<h-2;y+=2){
    const t=(y-vy)/Math.max(1,h-1-vy),x=vx+(bx-vx)*t,xi=Math.round(x);
    if(xi<2||xi>=w-2)continue;
    let best=0; for(let dx=-2;dx<=2;dx++)best=Math.max(best,edge[y*w+xi+dx]||0);
    sum+=best;count++;
  }
  return count?sum/count:0;
}
function analyzeLaneGeometry(){
  if(video.readyState<2||!video.videoWidth)return null;
  const w=geoCanvas.width,h=geoCanvas.height;geoCtx.drawImage(video,0,0,w,h);
  const img=geoCtx.getImageData(0,0,w,h).data,gray=new Float32Array(w*h),edge=new Float32Array(w*h);
  for(let i=0,j=0;i<img.length;i+=4,j++)gray[j]=0.2126*img[i]+0.7152*img[i+1]+0.0722*img[i+2];
  let eSum=0,eCnt=0;
  for(let y=Math.floor(h*0.32);y<h-1;y++)for(let x=1;x<w-1;x++){
    const gx=Math.abs(gray[y*w+x+1]-gray[y*w+x-1]);
    const gy=Math.abs(gray[(y+1)*w+x]-gray[(y-1)*w+x]);
    const e=Math.min(255,gx*1.15+gy*0.55);edge[y*w+x]=e;eSum+=e;eCnt++;
  }
  const base=eCnt?eSum/eCnt:1; let best=null,second=0;
  const centerBottom=w*cfg.laneCenterBottomPct/100,laneW=w*cfg.laneWidthBottomPct/100;
  const bottomXs=[]; for(let k=-2;k<=2;k++)bottomXs.push(centerBottom+(k+0.5)*laneW);
  for(let yp=36;yp<=60;yp+=2){for(let xp=36;xp<=64;xp+=2){
    const vx=w*xp/100,vy=h*yp/100; let score=0,used=0;
    for(const bx0 of bottomXs){if(bx0<3||bx0>w-4)continue; const s=lineEdgeScore(edge,w,h,vx,vy,bx0);score+=s;used++;}
    if(!used)continue; score/=used;
    if(!best||score>best.score){second=best?best.score:0;best={xp,yp,score};} else if(score>second) second=score;
  }}
  if(!best)return null;
  const contrast=Math.max(0,(best.score-base)/Math.max(8,base));
  const separation=Math.max(0,(best.score-second)/Math.max(8,best.score));
  const confidence=Math.max(0,Math.min(1,0.72*contrast+0.28*separation));
  return {...best,confidence,edgeBase:base};
}
function applyAutoGeometry(g,force=false){
  if(!g||g.confidence<0.18)return false;
  geoState.samples.push(g); if(geoState.samples.length>8)geoState.samples.shift();
  const good=geoState.samples.filter(x=>x.confidence>=0.18); if(good.length<3)return false;
  const hs=good.slice(-5).map(x=>x.yp),xs=good.slice(-5).map(x=>x.xp),hmed=median(hs),xmed=median(xs);
  const hspread=Math.max(...hs)-Math.min(...hs),xspread=Math.max(...xs)-Math.min(...xs);
  geoState.confidence=good.slice(-5).reduce((a,x)=>a+x.confidence,0)/Math.min(5,good.length);
  if(force||(good.length>=4&&hspread<=4&&xspread<=5)){
    cfg.horizonPct=hmed;cfg.vanishXPct=xmed;cfg.calLines=autoCalLines(cfg.cameraHeight,hmed,cfg.effectiveVFovDeg||42);cfg.calLocked=true;saveCfg();
    geoState.mode='LOCK';geoState.lockedAt=performance.now();geoState.lastGood={horizonPct:hmed,vanishXPct:xmed};
    ui.status.textContent='AUTO LOCK • hình học đã khóa';ui.hint.textContent='AUTO LOCK: khoảng cách đang dùng chiều cao camera + điểm tụ tự nhận. Nhấn AUTO LẠI nếu đổi vị trí điện thoại.';syncControls();updateQuality();
    return true;
  }
  return false;
}
function maybeAutoGeometry(now){
  if((sourceMode!=='camera'&&sourceMode!=='video')||!cfg.autoGeometry||calibrationMode||video.readyState<2)return;
  const interval=geoState.mode==='LOCK'?1600:550;if(now-geoState.lastRun<interval)return;geoState.lastRun=now;
  try{const g=analyzeLaneGeometry();if(!g)return;if(geoState.mode!=='LOCK')applyAutoGeometry(g);else{geoState.confidence=g.confidence;updateQuality();}}catch(e){console.warn('auto geometry',e);}
}

function loadCfg(){
  try { const raw=localStorage.getItem(CFG_KEY)||localStorage.getItem('distanceadas_cfg_v11b5')||'{}'; return {...defaults,...JSON.parse(raw)}; }
  catch { return {...defaults}; }
}
function saveCfg(){ localStorage.setItem(CFG_KEY,JSON.stringify(cfg)); }

function autoCalLines(height=1.20,horizonPct=50,vfovDeg=42){
  const fyNorm=0.5/Math.tan((vfovDeg*Math.PI/180)/2),k=height*fyNorm,lines={};
  for(const d of [10,20,30,50,70,100]) lines[d]=horizonPct+100*k/d;
  return lines;
}
function fitCalibration(lines){
  const pts=Object.entries(lines||{}).map(([d,y])=>({x:1/Number(d),y:Number(y)/100})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(pts.length<2)return null;const n=pts.length,sx=pts.reduce((a,p)=>a+p.x,0),sy=pts.reduce((a,p)=>a+p.y,0),sxx=pts.reduce((a,p)=>a+p.x*p.x,0),sxy=pts.reduce((a,p)=>a+p.x*p.y,0),den=n*sxx-sx*sx;
  if(Math.abs(den)<1e-9)return null;const k=(n*sxy-sx*sy)/den,yh=(sy-k*sx)/n;
  if(!Number.isFinite(k)||k<=0||yh<0.15||yh>0.8)return null;return {horizonPct:yh*100,kNorm:k,redPct:Number(lines[100])};
}
function currentCalibration(){ return fitCalibration(cfg.calLines); }
function tempCfg(){
  return {...cfg,cameraHeight:Number(inputs.cameraHeight.value),horizonPct:Number(inputs.horizon.value),autoGeometry:$('autoGeometry')?.checked??cfg.autoGeometry,autoLane:$('autoLane')?.checked??cfg.autoLane,laneCount:Number(inputs.laneCount.value),egoLane:Number(inputs.egoLane.value),vanishXPct:Number(inputs.vanishX.value),laneCenterBottomPct:Number(inputs.laneCenter.value),laneWidthBottomPct:Number(inputs.laneWidth.value),scoreThreshold:Number(inputs.score.value),smoothingAlpha:Number(inputs.smooth.value),aiHz:Number(inputs.aiHz.value),showAll:inputs.showAll.checked,gpsSpeedEnabled:inputs.gpsSpeedEnabled?.checked??cfg.gpsSpeedEnabled};
}
function syncControls(){
  inputs.cameraHeight.value=cfg.cameraHeight;inputs.cameraHeightRange.value=cfg.cameraHeight;inputs.horizon.value=cfg.horizonPct;if($('autoGeometry'))$('autoGeometry').checked=cfg.autoGeometry;if($('autoLane'))$('autoLane').checked=cfg.autoLane;
  inputs.laneCount.value=cfg.laneCount; inputs.egoLane.max=cfg.laneCount; inputs.egoLane.value=Math.min(cfg.egoLane,cfg.laneCount);
  inputs.vanishX.value=cfg.vanishXPct; inputs.laneCenter.value=cfg.laneCenterBottomPct; inputs.laneWidth.value=cfg.laneWidthBottomPct;
  inputs.score.value=cfg.scoreThreshold; inputs.smooth.value=cfg.smoothingAlpha; inputs.aiHz.value=cfg.aiHz; inputs.showAll.checked=cfg.showAll;if(inputs.gpsSpeedEnabled)inputs.gpsSpeedEnabled.checked=cfg.gpsSpeedEnabled;updateLabels();
}
function updateLabels(){
  const heightVal=Math.max(0.8,Math.min(2.2,Number(inputs.cameraHeight.value)||1.2)); inputs.cameraHeightRange.value=heightVal; labels.cameraHeight.textContent=`${heightVal.toFixed(2)} m`;
  const lc=Number(inputs.laneCount.value);inputs.egoLane.max=lc;if(Number(inputs.egoLane.value)>lc)inputs.egoLane.value=lc;
  labels.horizon.textContent=`${Number(inputs.horizon.value).toFixed(1)}%`;labels.laneCount.textContent=`${lc} làn`;labels.egoLane.textContent=`L${Number(inputs.egoLane.value)}`;
  labels.vanishX.textContent=`${Number(inputs.vanishX.value).toFixed(1)}%`;labels.laneCenter.textContent=`${Number(inputs.laneCenter.value).toFixed(1)}%`;labels.laneWidth.textContent=`${Number(inputs.laneWidth.value).toFixed(1)}%`;labels.score.textContent=Number(inputs.score.value).toFixed(2);labels.smooth.textContent=Number(inputs.smooth.value).toFixed(2);labels.aiHz.textContent=`${Number(inputs.aiHz.value).toFixed(0)} Hz`;
  const cal=currentCalibration();labels.cal.classList.toggle('bad',!cal);labels.cal.textContent=cal?`6 điểm • H ${cal.horizonPct.toFixed(1)}% • đỏ 100 m @ ${Number(cfg.calLines[100]).toFixed(1)}% • camera ${Number(inputs.cameraHeight.value).toFixed(2)} m`:'Hiệu chuẩn chưa hợp lệ.';
}
inputs.cameraHeightRange.addEventListener('input',()=>{inputs.cameraHeight.value=Number(inputs.cameraHeightRange.value).toFixed(2);updateLabels();});
inputs.cameraHeight.addEventListener('input',()=>{const v=Math.max(0.8,Math.min(2.2,Number(inputs.cameraHeight.value)||1.2));inputs.cameraHeightRange.value=v;updateLabels();});
Object.values(inputs).forEach(el=>{if(el?.tagName==='INPUT'&&el!==inputs.cameraHeightRange&&el!==inputs.cameraHeight)el.addEventListener('input',updateLabels);});
function openPanel(){syncControls();ui.panel.classList.remove('hidden');ui.panel.setAttribute('aria-hidden','false');}
function closePanel(){ui.panel.classList.add('hidden');ui.panel.setAttribute('aria-hidden','true');}
ui.settings.addEventListener('click',openPanel);ui.close.addEventListener('click',closePanel);
ui.reset.addEventListener('click',()=>{cfg={...defaults,calLines:{...defaults.calLines}};saveCfg();tracks=[];lockedLeadId=null;syncControls();updateQuality();});
ui.save.addEventListener('click',()=>{const next=tempCfg();next.egoLane=Math.min(next.egoLane,next.laneCount);cfg=next;saveCfg();tracks=[];lockedLeadId=null;laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};closePanel();if(sourceMode==='camera'){if(cfg.gpsSpeedEnabled)startGPS();else stopGPS();}if(cfg.autoGeometry&&sourceMode==='camera')resetAutoGeometry(true);else updateQuality();});

let calibrationMode=false,dragDistance=null;
function setCalibrationMode(on){calibrationMode=on;cfg.calLocked=!on;canvas.classList.toggle('cal-active',on);ui.cal.textContent=on?'CAL: ĐANG KÉO VẠCH':(cfg.autoGeometry?'AUTO LẠI':'CAL: TỰ ĐỘNG');ui.hint.textContent=on?'Chạm vạch gần nhất rồi kéo lên/xuống • thả tay để lưu':'AUTO LANE • khoảng cách gắn trực tiếp trên từng xe';saveCfg();render(lastPredictions);}
ui.cal.addEventListener('click',()=>{if(calibrationMode){setCalibrationMode(false);return;} resetAutoGeometry(true);});
$('autoCalBtn')?.addEventListener('click',()=>{const h=Number(inputs.cameraHeight.value)||1.2,yh=Number(inputs.horizon.value)||50;cfg.cameraHeight=h;cfg.horizonPct=yh;cfg.calLines=autoCalLines(h,yh,cfg.effectiveVFovDeg||42);saveCfg();syncControls();updateQuality();render(lastPredictions);});
$('touchCalBtn')?.addEventListener('click',()=>{closePanel();setCalibrationMode(true);});
$('lockCalBtn')?.addEventListener('click',()=>{setCalibrationMode(false);closePanel();});
function pointerY(e){const r=canvas.getBoundingClientRect();return Math.max(0,Math.min(r.height,e.clientY-r.top));}
function nearestCalDistance(y){const h=canvas.clientHeight;let best=null,bd=Infinity;for(const d of [10,20,30,50,70,100]){const dy=Math.abs(y-h*Number(cfg.calLines[d])/100);if(dy<bd){bd=dy;best=d;}}return bd<=32?best:null;}
canvas.addEventListener('pointerdown',e=>{if(!calibrationMode)return;dragDistance=nearestCalDistance(pointerY(e));if(dragDistance){canvas.setPointerCapture?.(e.pointerId);e.preventDefault();}});
canvas.addEventListener('pointermove',e=>{if(!calibrationMode||!dragDistance)return;cfg.calLines[dragDistance]=pointerY(e)/Math.max(1,canvas.clientHeight)*100;render(lastPredictions);e.preventDefault();});
function endDrag(e){if(!dragDistance)return;saveCfg();dragDistance=null;updateQuality();e.preventDefault();}
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);

function updateNetworkState(){if(ui.network)ui.network.textContent=navigator.onLine?'NET: ONLINE':'NET: OFFLINE';}
window.addEventListener('online',updateNetworkState);window.addEventListener('offline',updateNetworkState);
function updateSpeedUI(){
  if(ui.gpsSpeed)ui.gpsSpeed.textContent=sourceMode==='video'?'GPS: TEST VIDEO':(egoSpeedSmooth==null?'GPS: -- km/h':`GPS: ${Math.round(egoSpeedSmooth)} km/h`);
}
function stopGPS(){if(gpsWatchId!=null&&navigator.geolocation){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;}egoSpeedKmh=null;egoSpeedSmooth=null;lastGpsAt=0;updateSpeedUI();}
function startGPS(){
  stopGPS();if(sourceMode!=='camera'||!cfg.gpsSpeedEnabled||!navigator.geolocation)return;
  gpsWatchId=navigator.geolocation.watchPosition(pos=>{const sp=pos.coords.speed;if(Number.isFinite(sp)&&sp>=0){const kmh=sp*3.6;egoSpeedKmh=kmh;egoSpeedSmooth=egoSpeedSmooth==null?kmh:egoSpeedSmooth*.72+kmh*.28;lastGpsAt=performance.now();updateSpeedUI();}},err=>{console.warn('GPS',err);updateSpeedUI();},{enableHighAccuracy:true,maximumAge:800,timeout:10000});
}
function updateTrackMotion(tr,dNow,now){
  if(!Number.isFinite(dNow))return;
  if(!tr.motionSamples)tr.motionSamples=[];tr.motionSamples.push({t:now,d:dNow});
  tr.motionSamples=tr.motionSamples.filter(s=>now-s.t<=2200).slice(-12);
  if(tr.motionSamples.length<3)return;
  const a=tr.motionSamples[0],b=tr.motionSamples[tr.motionSamples.length-1],dt=(b.t-a.t)/1000;if(dt<0.45)return;
  const closing=(a.d-b.d)/dt*3.6;if(Number.isFinite(closing)&&Math.abs(closing)<220)tr.closingKmh=tr.closingKmh==null?closing:tr.closingKmh*.72+closing*.28;
}
function updateMotionReadout(lead,h){
  if(!lead){if(ui.closingSpeed)ui.closingSpeed.textContent='TIẾP CẬN: -- km/h';if(ui.leadSpeed)ui.leadSpeed.textContent='XE TRƯỚC: -- km/h';return;}
  const d=displayDistanceForTrack(lead,h);if(d.kind!=='number'||!Number.isFinite(lead.closingKmh)){ui.closingSpeed.textContent='TIẾP CẬN: -- km/h';ui.leadSpeed.textContent='XE TRƯỚC: -- km/h';return;}
  const c=lead.closingKmh;ui.closingSpeed.textContent=`TIẾP CẬN: ${c>=0?'+':''}${Math.round(c)} km/h`;
  if(sourceMode==='camera'&&egoSpeedSmooth!=null){const v=Math.max(0,egoSpeedSmooth-c);ui.leadSpeed.textContent=`XE TRƯỚC: ~${Math.round(v)} km/h`;}else ui.leadSpeed.textContent='XE TRƯỚC: -- km/h';
}
function resizeCanvas(){
  const dpr=Math.min(window.devicePixelRatio||1,2),rect=canvas.getBoundingClientRect(),w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',resizeCanvas); window.addEventListener('orientationchange',()=>setTimeout(resizeCanvas,250));

function effectiveLaneInfo(){
  if(cfg.autoLane && laneState.boundariesPct && laneState.count>=3){
    return {count:laneState.count,egoLane:laneState.egoLane||Math.min(cfg.egoLane,laneState.count),boundariesPct:laneState.boundariesPct,auto:true};
  }
  const n=cfg.laneCount,e=Math.min(cfg.egoLane,n),center=cfg.laneCenterBottomPct,width=cfg.laneWidthBottomPct,b=[];
  for(let j=0;j<=n;j++) b.push(center+(j-e+0.5)*width);
  return {count:n,egoLane:e,boundariesPct:b,auto:false};
}
function laneLineScore(edge,w,h,vx,vy,bxPct){
  return lineEdgeScore(edge,w,h,vx,vy,w*bxPct/100);
}
function analyzeAutoLanes(){
  if(video.readyState<2||!video.videoWidth)return null;
  const w=geoCanvas.width,h=geoCanvas.height;geoCtx.drawImage(video,0,0,w,h);
  const img=geoCtx.getImageData(0,0,w,h).data,gray=new Float32Array(w*h),edge=new Float32Array(w*h);
  for(let i=0,j=0;i<img.length;i+=4,j++)gray[j]=0.2126*img[i]+0.7152*img[i+1]+0.0722*img[i+2];
  let eSum=0,eCnt=0;
  for(let y=Math.floor(h*0.38);y<h-1;y++)for(let x=1;x<w-1;x++){
    const gx=Math.abs(gray[y*w+x+1]-gray[y*w+x-1]),gy=Math.abs(gray[(y+1)*w+x]-gray[(y-1)*w+x]);
    const e=Math.min(255,gx*1.22+gy*0.42);edge[y*w+x]=e;eSum+=e;eCnt++;
  }
  const base=eCnt?eSum/eCnt:1,vx=w*cfg.vanishXPct/100,vy=h*(currentCalibration()?.horizonPct/100||cfg.horizonPct/100);
  const endpoint=[];for(let p=-8;p<=108;p+=2)endpoint.push({p,s:laneLineScore(edge,w,h,vx,vy,p)});
  const scoreAt=p=>{let best=0;for(const q of endpoint)if(Math.abs(q.p-p)<=2)best=Math.max(best,q.s);return best;};
  let best=null;
  for(const n of [3,4]){
    const sMin=n===3?22:16,sMax=n===3?36:29;
    for(let sp=sMin;sp<=sMax;sp+=1){
      for(let b0=-8;b0<=32;b0+=2){
        const b=[];let sum=0,inside=0;
        for(let j=0;j<=n;j++){const p=b0+j*sp;b.push(p);sum+=scoreAt(p);if(p>=0&&p<=100)inside++;}
        const span=b[n]-b[0],center=(b[0]+b[n])/2;
        const coveragePenalty=Math.abs(span-88)*0.10+Math.abs(center-50)*0.07+(n+1-inside)*1.5;
        const norm=sum/(n+1)-coveragePenalty;
        if(!best||norm>best.score)best={count:n,boundariesPct:b,score:norm,raw:sum/(n+1)};
      }
    }
  }
  if(!best)return null;
  const conf=Math.max(0,Math.min(1,(best.raw-base*0.82)/Math.max(18,base*1.6)));
  const centerX=50;let ego=1;
  for(let i=0;i<best.count;i++)if(centerX>=best.boundariesPct[i]&&centerX<best.boundariesPct[i+1]){ego=i+1;break;}
  return {...best,confidence:conf,egoLane:ego};
}
function maybeAutoLane(now){
  if(!cfg.autoLane||calibrationMode||video.readyState<2)return;
  const interval=laneState.mode==='LOCK'?900:450;if(now-laneState.lastRun<interval)return;laneState.lastRun=now;
  try{
    const g=analyzeAutoLanes();if(!g||g.confidence<0.12)return;
    laneState.samples.push(g);if(laneState.samples.length>6)laneState.samples.shift();
    const recent=laneState.samples.slice(-4),same=recent.filter(x=>x.count===g.count);
    if(same.length<2)return;
    const count=g.count,avg=[];for(let j=0;j<=count;j++)avg.push(median(same.map(x=>x.boundariesPct[j])));
    const spread=Math.max(...same.map(x=>Math.abs(x.boundariesPct[0]-avg[0])+Math.abs(x.boundariesPct[count]-avg[count])));
    laneState.confidence=same.reduce((a,x)=>a+x.confidence,0)/same.length;
    if(same.length>=3&&spread<18){
      laneState.mode='LOCK';laneState.count=count;laneState.boundariesPct=avg;laneState.egoLane=g.egoLane;
    }else if(laneState.mode!=='LOCK')laneState.mode='SEARCH';
  }catch(e){console.warn('auto lane',e);}
}

function coverTransform(){
  const cw=canvas.clientWidth,ch=canvas.clientHeight,vw=video.videoWidth||1,vh=video.videoHeight||1;
  const scale=Math.max(cw/vw,ch/vh),drawW=vw*scale,drawH=vh*scale;
  return {cw,ch,vw,vh,scale,offsetX:(cw-drawW)/2,offsetY:(ch-drawH)/2};
}
function imageToScreenBox([x,y,w,h],t){return{x:t.offsetX+x*t.scale,y:t.offsetY+y*t.scale,w:w*t.scale,h:h*t.scale};}
function iou(a,b){
  if(!a||!b)return 0; const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);
  const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1),u=a.w*a.h+b.w*b.h-inter; return u>0?inter/u:0;
}
function redY(h){return h*Number(cfg.calLines[100])/100;}
function horizonY(h){const cal=currentCalibration();return h*(cal?cal.horizonPct/100:0.50);}
function rawDistanceFromY(y,h){
  const cal=currentCalibration();if(!cal)return null;const yn=y/h,yh=cal.horizonPct/100,denom=yn-yh;if(denom<=0.0005)return null;
  const d=cal.kNorm/denom;return Number.isFinite(d)&&d>=0.5&&d<=400?d:null;
}
function distanceState(y,h){
  const ry=redY(h),band=Math.max(3,h*0.006),raw=rawDistanceFromY(y,h);
  if(y<ry-band) return {kind:'over',text:'>100 m',numeric:raw&&raw>100?Math.min(raw,220):120};
  if(Math.abs(y-ry)<=band) return {kind:'around',text:'~100 m',numeric:100};
  const d=raw==null?99:Math.min(99.4,Math.max(1,raw));
  return {kind:'number',text:`${d<10?d.toFixed(1):Math.round(d)} m`,numeric:d};
}

function laneGeomAtY(y,w,h){
  const yh=horizonY(h),tt=Math.max(0,Math.min(1,(y-yh)/Math.max(1,h-yh))),p=Math.pow(tt,0.92),info=effectiveLaneInfo();
  let vanish=w*cfg.vanishXPct/100,bottomXs=info.boundariesPct.map(bp=>w*bp/100);
  if(info.auto&&video.videoWidth){const t=coverTransform();vanish=t.offsetX+(t.vw*cfg.vanishXPct/100)*t.scale;bottomXs=info.boundariesPct.map(bp=>t.offsetX+(t.vw*bp/100)*t.scale);}
  const boundaries=bottomXs.map(xb=>vanish+(xb-vanish)*p),widths=[];for(let i=0;i<info.count;i++)widths.push(boundaries[i+1]-boundaries[i]);
  return {boundaries,laneWidth:median(widths)||0,count:info.count,egoLane:info.egoLane,auto:info.auto};
}
function laneForX(x,y,w,h){
  const g=laneGeomAtY(y,w,h);if(g.laneWidth<3)return null;
  for(let i=0;i<g.count;i++)if(x>=g.boundaries[i]&&x<g.boundaries[i+1])return i+1;
  const margin=g.laneWidth*0.35;
  if(x>=g.boundaries[0]-margin&&x<g.boundaries[0])return 1;
  if(x>g.boundaries[g.count]&&x<=g.boundaries[g.count]+margin)return g.count;
  return null;
}

function classSizePrior(name){
  if(name==='truck')return {w:2.50,h:3.05};
  if(name==='bus')return {w:2.50,h:3.20};
  if(name==='motorcycle')return {w:0.72,h:1.40};
  return {w:1.82,h:1.50};
}
function egoFootprint(box,y,w,h){
  const g=laneGeomAtY(y,w,h),i=Math.max(0,Math.min(g.count-1,g.egoLane-1));
  const left=g.boundaries[i],right=g.boundaries[i+1],laneW=Math.max(1,right-left);
  const bx1=box.x+box.w*0.10,bx2=box.x+box.w*0.90;
  const overlap=Math.max(0,Math.min(bx2,right)-Math.max(bx1,left));
  const ratio=overlap/Math.max(1,Math.min(bx2-bx1,laneW));
  const cx=box.x+box.w/2,centerInside=cx>=left&&cx<=right;
  return {left,right,laneW,ratio,centerInside,eligible:centerInside||ratio>=0.30};
}
function candidatesFromPredictions(predictions,t){
  const baseThreshold=Math.max(0.18,cfg.scoreThreshold-(tracks.length?0.08:0.16)),out=[];
  for(const p of predictions||[]){
    const threshold=p.source==='FAR-WATCH'?0.115:baseThreshold;
    if(!VEHICLES.has(p.class)||p.score<threshold)continue;
    const b=imageToScreenBox(p.bbox,t); if(b.x+b.w<0||b.x>t.cw||b.y+b.h<0||b.y>t.ch||b.w<6||b.h<6)continue;
    const cx=b.x+b.w/2;
    const by=Number.isFinite(p.groundY)?Math.min(t.ch,t.offsetY+p.groundY*t.scale):Math.min(t.ch,b.y+b.h*0.985);
    const lane=laneForX(cx,by,t.cw,t.ch),ds=distanceState(by,t.ch),ego=egoFootprint(b,by,t.cw,t.ch);
    const maskPolygon=Array.isArray(p.maskPolygon)?p.maskPolygon.map(([x,y])=>[t.offsetX+x*t.scale,t.offsetY+y*t.scale]):null;
    out.push({p,b,cx,by,lane,ds,ego,maskPolygon});
  }
  return out;
}
function centerDist(a,b,t){return Math.hypot((a.cx-b.cx)/t.cw,(a.by-b.by)/t.ch);}
function sizeDistanceForTrack(tr,h){
  const cal=currentCalibration(); if(!cal||!tr?.box)return null;
  const fy=(cal.kNorm/Math.max(0.5,cfg.cameraHeight))*h,prior=classSizePrior(tr.className);
  const dw=tr.box.w>4?prior.w*fy/tr.box.w:null,dh=tr.box.h>4?prior.h*fy/tr.box.h:null;
  const vals=[dw,dh].filter(v=>Number.isFinite(v)&&v>=1&&v<=250);return vals.length?median(vals):null;
}
function fusedDistanceMeasurement(tr,h){
  const road=rawDistanceFromY(tr.by,h),size=sizeDistanceForTrack(tr,h);
  if(!Number.isFinite(road))return Number.isFinite(size)?size:null;
  if(!Number.isFinite(size))return road;
  const ratio=size/road;
  if(ratio<0.48||ratio>2.05)return road;
  const far=Math.max(0,Math.min(1,(road-35)/85));
  const ws=0.14+0.18*far,wr=1-ws;
  return road*wr+size*ws;
}
function updateDistanceFilter(tr,measurement,now){
  if(!Number.isFinite(measurement))return;
  if(!Number.isFinite(tr.dFilt)){tr.dFilt=measurement;tr.dVel=0;tr.dAt=now;tr.dHistory=[measurement];return;}
  const dt=Math.max(0.04,Math.min(0.7,(now-(tr.dAt||now))/1000)),pred=Math.max(0.5,tr.dFilt+(tr.dVel||0)*dt);
  tr.dHistory=(tr.dHistory||[]).concat(measurement).slice(-5);const robust=median(tr.dHistory),res=robust-pred;
  const alpha=robust>70?0.30:0.42,beta=robust>70?0.055:0.085;
  tr.dFilt=Math.max(0.5,Math.min(250,pred+alpha*res));
  tr.dVel=Math.max(-70,Math.min(70,(tr.dVel||0)+beta*res/dt));tr.dAt=now;
}
function updateTracks(cands,now,t){
  const used=new Set();
  for(const tr of tracks){
    let best=-1,bestScore=-1;
    const predCx=tr.cx+(tr.vx||0)*Math.min(0.45,(now-tr.lastSeen)/1000),predBy=tr.by+(tr.vy||0)*Math.min(0.45,(now-tr.lastSeen)/1000);
    for(let i=0;i<cands.length;i++){
      if(used.has(i))continue;const c=cands[i],ov=iou(tr.box,c.b),mv=Math.hypot((predCx-c.cx)/t.cw,(predBy-c.by)/t.ch);if(mv>0.20&&ov<0.005)continue;
      const sizeRatio=Math.min(tr.box.w/c.b.w,c.b.w/tr.box.w)*Math.min(tr.box.h/c.b.h,c.b.h/tr.box.h);
      const classBonus=tr.className===c.p.class?0.18:0,score=ov*2.7+Math.max(0,1-mv/0.20)*1.55+Math.max(0,sizeRatio)*0.30+classBonus;
      if(score>bestScore){bestScore=score;best=i;}
    }
    if(best>=0&&bestScore>0.32){
      const c=cands[best];used.add(best);const oldCx=tr.cx,oldBy=tr.by,dt=Math.max(0.04,(now-tr.lastSeen)/1000),a=cfg.smoothingAlpha;
      tr.box={x:tr.box.x*(1-a)+c.b.x*a,y:tr.box.y*(1-a)+c.b.y*a,w:tr.box.w*(1-a)+c.b.w*a,h:tr.box.h*(1-a)+c.b.h*a};
      tr.cx=tr.box.x+tr.box.w/2;tr.by=oldBy*(1-a)+c.by*a;tr.vx=(tr.cx-oldCx)/dt;tr.vy=(tr.by-oldBy)/dt;
      tr.className=c.p.class;tr.score=c.p.score;tr.lane=c.lane;tr.ego=egoFootprint(tr.box,tr.by,t.cw,t.ch);if(c.maskPolygon?.length)tr.maskPolygon=c.maskPolygon;
      const meas=fusedDistanceMeasurement(tr,t.ch);updateDistanceFilter(tr,meas,now);updateTrackMotion(tr,tr.dFilt,now);tr.lastSeen=now;tr.hits++;tr.stale=false;
    }else tr.stale=true;
  }
  for(let i=0;i<cands.length;i++) if(!used.has(i)){
    const c=cands[i],tr={id:nextTrackId++,box:{...c.b},cx:c.cx,by:c.by,vx:0,vy:0,className:c.p.class,score:c.p.score,lane:c.lane,ego:c.ego,maskPolygon:c.maskPolygon||null,dState:c.ds,dSmooth:c.ds.numeric,dFilt:null,dVel:0,dAt:now,dHistory:[],motionSamples:[],closingKmh:null,lastSeen:now,hits:1,stale:false};
    updateDistanceFilter(tr,fusedDistanceMeasurement(tr,t.ch)??c.ds.numeric,now);tr.motionSamples=[{t:now,d:tr.dFilt}];tracks.push(tr);
  }
  tracks=tracks.filter(tr=>now-tr.lastSeen<780).slice(-20);
  if(lockedLeadId!=null&&!tracks.some(t=>t.id===lockedLeadId))lockedLeadId=null;
}
function displayDistanceForTrack(tr,h){
  let d=Number.isFinite(tr.dFilt)?tr.dFilt:fusedDistanceMeasurement(tr,h);if(!Number.isFinite(d))return {kind:'unknown',text:'-- m',numeric:null,main:'--'};
  d=Math.max(1,Math.min(250,d));return {kind:'number',text:`${d<10?d.toFixed(1):Math.round(d)} m`,numeric:d,main:d<10?d.toFixed(1):String(Math.round(d))};
}
function chooseEgoLead(h){
  const live=tracks.filter(t=>!t.stale&&t.hits>=1&&t.ego?.eligible).map(t=>({t,d:displayDistanceForTrack(t,h).numeric??999,occ:t.ego?.ratio||0})).sort((a,b)=>a.d-b.d);
  if(!live.length){lockedLeadId=null;return null;}
  const current=live.find(x=>x.t.id===lockedLeadId),best=live[0];
  if(!current){lockedLeadId=best.t.id;return best.t;}
  if(best.t.id!==current.t.id){
    const clearCloser=best.d<current.d*0.94;
    const cutIn=best.occ>=0.34&&best.d<current.d*1.08&&Math.abs(best.t.vx||0)>10;
    if(clearCloser||cutIn)lockedLeadId=best.t.id;
  }
  return (live.find(x=>x.t.id===lockedLeadId)||best).t;
}

function updateReadout(lead,h){
  ui.readout.classList.remove('state-warning','state-danger','state-idle');
  const live=tracks.filter(t=>!t.stale);ui.trackCount.textContent=`${live.length} xe`;
  if(!lead){ui.distance.textContent='--.-';ui.lead.textContent='CHƯA CÓ XE TRONG LÀN MÌNH';ui.laneMain.textContent=`L${effectiveLaneInfo().egoLane}`;ui.track.textContent='TRACK: --';ui.readout.classList.add('state-idle');return;}
  const d=displayDistanceForTrack(lead,h);ui.distance.textContent=d.main;ui.lead.textContent='XE TRƯỚC';ui.laneMain.textContent='AUTO';ui.track.textContent='LOCK: XE TRƯỚC';
  if(d.kind==='number'&&d.numeric<15)ui.readout.classList.add('state-warning');
}
function updateQuality(){const cal=currentCalibration(),gs=cfg.autoGeometry?(geoState.mode==='LOCK'?`AUTO LOCK ${Math.round(geoState.confidence*100)}%`:'AUTO CAL'):'MANUAL',li=effectiveLaneInfo(),ls=cfg.autoLane?(laneState.mode==='LOCK'?`AUTO LANE ${li.count}L ${Math.round(laneState.confidence*100)}%`:'AUTO LANE…'):`${li.count} LÀN`;ui.quality.textContent=cal?`${gs} • ${ls} • ${cfg.cameraHeight.toFixed(2)}m • 100m`:'CAL: KHÔNG HỢP LỆ';}

function drawGuides(){
  if(!calibrationMode)return;
  const w=canvas.clientWidth,h=canvas.clientHeight,yh=horizonY(h);ctx.save();
  const bg=laneGeomAtY(h,w,h);ctx.strokeStyle='rgba(40,230,130,.72)';ctx.lineWidth=2;ctx.setLineDash([]);
  for(let j=0;j<=bg.count;j++){ctx.beginPath();ctx.moveTo(w*cfg.vanishXPct/100,yh);ctx.lineTo(bg.boundaries[j],h);ctx.stroke();}
  for(const d of [100,70,50,30,20,10]){const y=h*Number(cfg.calLines[d])/100,isRed=d===100,isDrag=dragDistance===d;ctx.strokeStyle=isRed?'rgba(255,55,55,.98)':(isDrag?'rgba(255,235,60,1)':'rgba(255,210,30,.72)');ctx.lineWidth=isRed?3:(isDrag?3:1.4);ctx.setLineDash(isRed?[14,8]:[7,7]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=ctx.strokeStyle;ctx.font=`${isRed?'800':'700'} 12px -apple-system,sans-serif`;ctx.fillText(`${d} m`,8,Math.max(16,y-5));ctx.beginPath();ctx.arc(w-18,y,7,0,Math.PI*2);ctx.fill();}
  ctx.restore();
}

function drawTrack(tr,h,w){
  const d=displayDistanceForTrack(tr,h);ctx.save();ctx.lineWidth=3.2;ctx.strokeStyle='rgba(255,35,35,.98)';
  if(tr.maskPolygon?.length>=6){ctx.beginPath();ctx.moveTo(tr.maskPolygon[0][0],tr.maskPolygon[0][1]);for(let i=1;i<tr.maskPolygon.length;i++)ctx.lineTo(tr.maskPolygon[i][0],tr.maskPolygon[i][1]);ctx.closePath();ctx.stroke();}
  else ctx.strokeRect(tr.box.x,tr.box.y,tr.box.w,tr.box.h);
  const label=`XE TRƯỚC • ${d.text}`;ctx.font='800 15px -apple-system,sans-serif';const tw=ctx.measureText(label).width;
  const tx=Math.max(4,Math.min(tr.box.x+tr.box.w/2-tw/2,w-tw-12)),ty=Math.max(28,tr.box.y-7);
  ctx.fillStyle='rgba(220,0,0,.92)';ctx.fillRect(tx-5,ty-19,tw+10,23);ctx.fillStyle='#fff';ctx.fillText(label,tx,ty-2);ctx.restore();
}
function render(predictions){
  resizeCanvas();const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);drawGuides();const t=coverTransform();
  const cands=candidatesFromPredictions(predictions,t);updateTracks(cands,performance.now(),t);const lead=chooseEgoLead(h);updateReadout(lead,h);updateMotionReadout(lead,h);
  if(lead)drawTrack(lead,h,w);
}

const AI_FILES={
  tfLocal:'./vendor/tf.min.js',tfRemote:'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  cocoLocal:'./vendor/coco-ssd.min.js',cocoRemote:'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3',
  modelLocal:'./models/coco-ssd/model.json',modelRemote:'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json'
};
function timeoutPromise(promise,ms,label='Tác vụ'){let timer;return Promise.race([promise.finally(()=>clearTimeout(timer)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} quá ${Math.round(ms/1000)} giây`)),ms);})]);}
function loadScript(src,timeout=15000){return timeoutPromise(new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.async=true;el.onload=()=>resolve(src);el.onerror=()=>reject(new Error(`Không tải được ${src}`));document.head.appendChild(el);}),timeout,`Tải ${src}`);}
async function loadScriptPreferLocal(localUrl,remoteUrl,globalName){if(window[globalName])return'đã có';try{ui.status.textContent='Đang nạp AI nội bộ…';await loadScript(localUrl,5000);if(!window[globalName])throw new Error(`${globalName} chưa tạo`);return'local';}catch(e){console.warn(e);ui.status.textContent='Thiếu AI nội bộ • thử Internet…';await loadScript(remoteUrl,20000);if(!window[globalName])throw new Error(`${globalName} không khởi tạo`);return'internet';}}
async function localModelExists(){try{const r=await timeoutPromise(fetch(AI_FILES.modelLocal,{cache:'no-store'}),4000,'Kiểm tra model');return r.ok;}catch{return false;}}
async function ensureAILibraries(){return{tfSource:await loadScriptPreferLocal(AI_FILES.tfLocal,AI_FILES.tfRemote,'tf'),cocoSource:await loadScriptPreferLocal(AI_FILES.cocoLocal,AI_FILES.cocoRemote,'cocoSsd')};}
async function chooseBackend(){for(const name of ['webgl','cpu']){try{const ok=await tf.setBackend(name);if(ok!==false){await tf.ready();return tf.getBackend();}}catch(e){console.warn(e);}}await tf.ready();return tf.getBackend();}
async function initModel(){
  if(model)return model;ui.status.textContent='Khởi tạo TensorFlow…';const libs=await ensureAILibraries(),backend=await chooseBackend();ui.backend.textContent=`TF ${backend}`;
  const hasLocal=await localModelExists(),attempts=hasLocal?[{url:AI_FILES.modelLocal,label:'LOCAL'},{url:AI_FILES.modelRemote,label:'NET'}]:[{url:AI_FILES.modelRemote,label:'NET'}];let lastErr;
  for(const a of attempts){try{ui.status.textContent=a.label==='LOCAL'?'Đang nạp model AI nội bộ…':'Đang tải model AI…';model=await timeoutPromise(cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:a.url}),45000,`Model ${a.label}`);ui.status.textContent=`AI sẵn sàng • ${a.label}`;ui.backend.textContent=`TF ${backend} • ${a.label}`;console.info('AI ready',{backend,source:a.label,libs});setTimeout(()=>initYoloSegBackground(),300);return model;}catch(e){lastErr=e;console.error(e);}}
  throw new Error(`Không nạp được model AI. ${lastErr?.message||''}`);
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){alert('Camera web cần HTTPS hoặc localhost.');return;}stopCamera(false);ui.status.textContent='Đang mở camera…';
  try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}}});video.srcObject=stream;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Camera không trả metadata')),10000);if(video.readyState>=1){clearTimeout(timer);resolve();return;}video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};});await video.play();resizeCanvas();}
  catch(err){console.error(err);ui.status.textContent='Lỗi camera';alert(`Không mở được camera: ${err.message||err}`);return;}
  sourceMode='camera';running=true;laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};startGPS();ui.start.textContent='DỪNG';ui.videoBtn.textContent='VIDEO THỬ';lastAIEnd=0;if(cfg.autoGeometry)resetAutoGeometry(true);
  try{await initModel();ui.status.textContent='Đang khóa xe trước • AUTO LANE';if(!drawRAF)drawRAF=requestAnimationFrame(loop);}catch(err){console.error(err);ui.status.textContent='AI chưa sẵn sàng';ui.fps.textContent='AI ERROR';alert(`AI chưa nạp được.\n\n${err.message||err}`);}
}
function stopCamera(updateUI=true){
  running=false;aiBusy=false;if(drawRAF){cancelAnimationFrame(drawRAF);drawRAF=0;}
  if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
  try{video.pause();}catch{}
  video.srcObject=null;video.removeAttribute('src');video.load();
  if(videoObjectUrl){URL.revokeObjectURL(videoObjectUrl);videoObjectUrl=null;}
  sourceMode='none';stopGPS();tracks=[];lockedLeadId=null;lastPredictions=[];
  if(updateUI){ui.start.textContent='BẬT CAMERA';ui.videoBtn.textContent='VIDEO THỬ';ui.status.textContent='Đã dừng';updateReadout(null,canvas.clientHeight);}
  resizeCanvas();ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);drawGuides();
}
ui.start.addEventListener('click',()=>running?stopCamera(true):startCamera());
ui.videoBtn.addEventListener('click',()=>{if(running&&sourceMode==='video'){stopCamera(true);return;}ui.videoFile.click();});
ui.videoFile.addEventListener('change',async()=>{
  const file=ui.videoFile.files?.[0];if(!file)return;stopCamera(false);ui.status.textContent='Đang mở video thử…';
  try{
    videoObjectUrl=URL.createObjectURL(file);video.srcObject=null;video.src=videoObjectUrl;video.loop=true;video.muted=true;video.playsInline=true;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Video không trả metadata')),10000);video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error('Không đọc được video'));};});
    await video.play();resizeCanvas();sourceMode='video';laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};stopGPS();running=true;ui.start.textContent='DỪNG';ui.videoBtn.textContent='DỪNG VIDEO';lastAIEnd=0;tracks=[];lockedLeadId=null;
    await initModel();ui.status.textContent='VIDEO THỬ • KHÓA XE TRƯỚC + KHOẢNG CÁCH';if(!drawRAF)drawRAF=requestAnimationFrame(loop);
  }catch(err){console.error(err);ui.status.textContent='Lỗi video thử';alert(`Không mở được video thử: ${err.message||err}`);stopCamera(true);}
  finally{ui.videoFile.value='';}
});


async function initYoloSegBackground(){
  if(yoloReady||yoloLoading||yoloDisabled)return;
  yoloLoading=true;
  try{
    if(!window.ort){await loadScript(ORT_URL,20000);}
    if(!window.ort)throw new Error('ONNX Runtime không khởi tạo');
    try{ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';}catch{}
    const providers=(navigator.gpu?['webgpu','wasm']:['wasm']);
    ui.status.textContent='AI beta.6 sẵn sàng • đang nạp YOLO SEG nền…';
    yoloSession=await timeoutPromise(ort.InferenceSession.create(YOLO_MODEL_URL,{executionProviders:providers,graphOptimizationLevel:'all'}),65000,'YOLO11n-seg');
    yoloReady=true;
    ui.backend.textContent=`${ui.backend.textContent} • YOLO SEG`;
    ui.status.textContent='AI sẵn sàng • FAR WATCH 30% + YOLO SEG';
  }catch(e){
    console.warn('YOLO SEG fallback:',e);yoloDisabled=true;
    ui.status.textContent='AI beta.6 + FAR WATCH • YOLO SEG fallback';
  }finally{yoloLoading=false;}
}
function sigmoid(x){return 1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));}
function nmsBoxes(items,iouThr=0.48,maxKeep=12){
  const sorted=[...items].sort((a,b)=>b.score-a.score),out=[];
  while(sorted.length&&out.length<maxKeep){const a=sorted.shift();out.push(a);for(let i=sorted.length-1;i>=0;i--){
    const b=sorted[i]; if(a.class!==b.class)continue;
    const ax2=a.x+a.w,ay2=a.y+a.h,bx2=b.x+b.w,by2=b.y+b.h;
    const iw=Math.max(0,Math.min(ax2,bx2)-Math.max(a.x,b.x)),ih=Math.max(0,Math.min(ay2,by2)-Math.max(a.y,b.y));
    const inter=iw*ih,uni=a.w*a.h+b.w*b.h-inter;if(uni>0&&inter/uni>iouThr)sorted.splice(i,1);
  }}return out;
}
function yoloLetterbox(){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,s=Math.min(YOLO_INPUT/vw,YOLO_INPUT/vh),dw=vw*s,dh=vh*s,ox=(YOLO_INPUT-dw)/2,oy=(YOLO_INPUT-dh)/2;
  yoloCtx.save();yoloCtx.fillStyle='#000';yoloCtx.fillRect(0,0,YOLO_INPUT,YOLO_INPUT);if('filter'in yoloCtx)yoloCtx.filter=sceneLuma<0.34?'brightness(1.24) contrast(1.14)':'none';yoloCtx.drawImage(video,0,0,vw,vh,ox,oy,dw,dh);yoloCtx.restore();
  return{vw,vh,s,ox,oy};
}
function yoloTensor(){
  const d=yoloCtx.getImageData(0,0,YOLO_INPUT,YOLO_INPUT).data,n=YOLO_INPUT*YOLO_INPUT,arr=new Float32Array(3*n);
  for(let i=0,j=0;i<d.length;i+=4,j++){arr[j]=d[i]/255;arr[n+j]=d[i+1]/255;arr[2*n+j]=d[i+2]/255;}
  return new ort.Tensor('float32',arr,[1,3,YOLO_INPUT,YOLO_INPUT]);
}
function parseYoloSeg(outputs,lb){
  const vals=Object.values(outputs),det=vals.find(x=>x.dims?.length===3),proto=vals.find(x=>x.dims?.length===4);if(!det)return[];
  const dd=det.dims,dat=det.data;let C,N,at;
  if(dd[1]<dd[2]){C=dd[1];N=dd[2];at=(c,n)=>dat[c*N+n];}else{N=dd[1];C=dd[2];at=(c,n)=>dat[n*C+c];}
  const maskDim=Math.max(0,C-84),raw=[];
  for(let n=0;n<N;n++){
    let best=-1,score=0;for(const ci of YOLO_VEHICLE_CLASSES.keys()){const sc=at(4+ci,n);if(sc>score){score=sc;best=ci;}}
    const minScore=0.26;if(best<0||score<minScore)continue;
    const cx=at(0,n),cy=at(1,n),w=at(2,n),h=at(3,n);if(w<5||h<5)continue;
    let x=(cx-w/2-lb.ox)/lb.s,y=(cy-h/2-lb.oy)/lb.s,bw=w/lb.s,bh=h/lb.s;
    x=Math.max(0,x);y=Math.max(0,y);bw=Math.min(lb.vw-x,bw);bh=Math.min(lb.vh-y,bh);if(bw<5||bh<5)continue;
    const coeff=maskDim?Array.from({length:maskDim},(_,k)=>at(84+k,n)):null;
    raw.push({x,y,w:bw,h:bh,score,class:YOLO_VEHICLE_CLASSES.get(best),coeff,cx640:cx,cy640:cy,w640:w,h640:h});
  }
  const keep=nmsBoxes(raw,0.46,10);
  if(!proto||!keep.length)return keep.map(q=>({class:q.class,score:q.score,bbox:[q.x,q.y,q.w,q.h],source:'YOLO-SEG'}));
  const pd=proto.dims,pdata=proto.data,mc=pd[1],ph=pd[2],pw=pd[3];
  for(const q of keep){
    if(!q.coeff||q.coeff.length!==mc)continue;
    const x1=Math.max(0,Math.floor((q.cx640-q.w640/2)/YOLO_INPUT*pw)),x2=Math.min(pw-1,Math.ceil((q.cx640+q.w640/2)/YOLO_INPUT*pw));
    const y1=Math.max(0,Math.floor((q.cy640-q.h640/2)/YOLO_INPUT*ph)),y2=Math.min(ph-1,Math.ceil((q.cy640+q.h640/2)/YOLO_INPUT*ph));
    let maxY=-1;const left=[],right=[];
    for(let yy=y1;yy<=y2;yy+=2){let mn=1e9,mx=-1;for(let xx=x1;xx<=x2;xx++){
      let z=0,idx=yy*pw+xx;for(let k=0;k<mc;k++)z+=q.coeff[k]*pdata[k*ph*pw+idx];if(sigmoid(z)>0.50){mn=Math.min(mn,xx);mx=Math.max(mx,xx);maxY=Math.max(maxY,yy);}
    }if(mx>=0){left.push([mn,yy]);right.push([mx,yy]);}}
    if(maxY>=0){const gy640=(maxY+0.5)/ph*YOLO_INPUT;q.groundY=(gy640-lb.oy)/lb.s;
      const pts=left.concat(right.reverse()).filter((_,i,a)=>i%Math.max(1,Math.floor(a.length/20))===0).map(([xx,yy])=>[(xx/pw*YOLO_INPUT-lb.ox)/lb.s,(yy/ph*YOLO_INPUT-lb.oy)/lb.s]);q.maskPolygon=pts;}
  }
  return keep.map(q=>({class:q.class,score:q.score,bbox:[q.x,q.y,q.w,q.h],groundY:q.groundY,maskPolygon:q.maskPolygon,source:'YOLO-SEG'}));
}
async function detectYoloSeg(){
  if(!yoloReady||!yoloSession)return null;const lb=yoloLetterbox(),tensor=yoloTensor(),name=yoloSession.inputNames?.[0]||'images';
  const outputs=await yoloSession.run({[name]:tensor});return parseYoloSeg(outputs,lb);
}
function farWatchCenterX(vw,vh){
  const cal=currentCalibration(),yh=(cal?cal.horizonPct/100:0.50)*vh,targetY=Math.min(vh*0.68,yh+vh*0.18),t=Math.max(0,Math.min(1,(targetY-yh)/Math.max(1,vh-yh)));
  let bottomPct=cfg.laneCenterBottomPct;
  if(cfg.autoLane&&laneState.boundariesPct&&laneState.egoLane){const i=Math.max(0,Math.min(laneState.boundariesPct.length-2,laneState.egoLane-1));bottomPct=(laneState.boundariesPct[i]+laneState.boundariesPct[i+1])/2;}
  const xp=cfg.vanishXPct+(bottomPct-cfg.vanishXPct)*t;return vw*xp/100;
}

function estimateSceneLuma(){
  try{if(video.readyState<2||!video.videoWidth)return sceneLuma;lightCtx.drawImage(video,0,0,32,18);const d=lightCtx.getImageData(0,0,32,18).data;let sum=0,n=0;for(let i=0;i<d.length;i+=16){sum+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];n++;}sceneLuma=sum/Math.max(1,n)/255;}catch{}return sceneLuma;
}
function buildFullInput(){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,rw=640,rh=Math.round(rw*vh/vw);if(fullCanvas.width!==rw||fullCanvas.height!==rh){fullCanvas.width=rw;fullCanvas.height=rh;}
  fullCtx.save();fullCtx.clearRect(0,0,rw,rh);const dark=sceneLuma<0.34;if('filter'in fullCtx)fullCtx.filter=dark?'brightness(1.35) contrast(1.20) saturate(1.04)':'none';fullCtx.drawImage(video,0,0,rw,rh);fullCtx.restore();return{rw,rh,dark};
}
function buildFarROI(){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,cal=currentCalibration(),yh=(cal?cal.horizonPct/100:0.50)*vh;
  const sy=Math.max(0,yh-0.055*vh),sh=Math.min(vh-sy,0.34*vh),sw=vw*FAR_WATCH_WIDTH,cx=farWatchCenterX(vw,vh),sx=Math.max(0,Math.min(vw-sw,cx-sw/2));
  const rw=640,rh=Math.max(420,Math.round(rw*sh/sw));if(roiCanvas.width!==rw||roiCanvas.height!==rh){roiCanvas.width=rw;roiCanvas.height=rh;}
  roiCtx.save();roiCtx.clearRect(0,0,rw,rh);const dark=sceneLuma<0.34;if('filter'in roiCtx)roiCtx.filter=dark?'brightness(1.46) contrast(1.28) saturate(1.02)':'contrast(1.10)';roiCtx.drawImage(video,sx,sy,sw,sh,0,0,rw,rh);roiCtx.restore();return{sx,sy,sw,sh,rw,rh,dark};
}
function mapPreds(preds,r){return(preds||[]).map(p=>{const[x,y,w,h]=p.bbox;return{...p,bbox:[r.sx+x*r.sw/r.rw,r.sy+y*r.sh/r.rh,w*r.sw/r.rw,h*r.sh/r.rh]};});}
async function detectAdaptive(){
  detectFrame++;if(detectFrame%4===1)estimateSceneLuma();const phase=detectFrame%3;
  if(phase!==1){const r=buildFarROI(),min=r.dark?0.105:0.125,preds=await model.detect(roiCanvas,16,min);detectMode=`FAR-WATCH 30%${r.dark?'+DARK':''}`;return mapPreds(preds,r).map(p=>({...p,source:'FAR-WATCH'}));}
  if(yoloReady&&performance.now()-yoloLastRun>650){try{yoloLastRun=performance.now();const yp=await detectYoloSeg();if(yp?.length){detectMode='YOLO11n-SEG';return yp;}}catch(e){console.warn('YOLO frame fallback',e);}}
  const f=buildFullInput(),min=f.dark?0.16:0.19,preds=await model.detect(fullCanvas,18,min);detectMode=yoloReady?'FULL FALLBACK':'FULL';const vw=video.videoWidth||1,vh=video.videoHeight||1;return(preds||[]).map(p=>{const[x,y,w,h]=p.bbox;return{...p,bbox:[x*vw/f.rw,y*vh/f.rh,w*vw/f.rw,h*vh/f.rh]};});
}
async function loop(ts){
  maybeAutoGeometry(ts);maybeAutoLane(ts);if(Math.round(ts)%900<20)updateQuality();
  drawRAF=0;if(!running)return;const interval=1000/Math.max(1,cfg.aiHz);
  if(!aiBusy&&model&&video.readyState>=2&&ts-lastAIEnd>=interval){aiBusy=true;const started=performance.now();try{const preds=await detectAdaptive();lastPredictions=preds;render(preds);const elapsed=performance.now()-started,instant=1000/Math.max(elapsed,1);fpsSmooth=fpsSmooth?fpsSmooth*.78+instant*.22:instant;ui.fps.textContent=`AI ${fpsSmooth.toFixed(1)} FPS • ${detectMode}`;}catch(err){console.error(err);ui.status.textContent='AI lỗi 1 frame';}finally{lastAIEnd=performance.now();aiBusy=false;}}
  if(running)drawRAF=requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stopCamera(true);});window.addEventListener('pagehide',()=>{if(running)stopCamera(false);});
syncControls();resizeCanvas();updateQuality();updateNetworkState();updateSpeedUI();drawGuides();if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
