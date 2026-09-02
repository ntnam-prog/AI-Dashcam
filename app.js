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
const CFG_KEY = 'distanceadas_cfg_v11b5';
const APP_VERSION = 'v1.1 beta.5';
const RED_DISTANCE_M = 100;
const defaults = {
  cameraHeight:1.20, horizonPct:50.0, effectiveVFovDeg:42, calLocked:true, autoGeometry:true,
  calLines:{10:65.64,20:57.82,30:55.21,50:53.13,70:52.23,100:51.56},
  laneCount:4, egoLane:2, vanishXPct:50, laneCenterBottomPct:50, laneWidthBottomPct:22,
  scoreThreshold:0.34, smoothingAlpha:0.28, aiHz:12, showAll:true, gpsSpeedEnabled:true
};

let cfg = loadCfg();
let stream=null, model=null, running=false, aiBusy=false, drawRAF=0, sourceMode='none', videoObjectUrl=null;
let lastAIEnd=0, fpsSmooth=0, tracks=[], nextTrackId=1, lastPredictions=[];
let detectFrame=0, sceneLuma=1, detectMode='FULL';
let gpsWatchId=null, egoSpeedKmh=null, egoSpeedSmooth=null, lastGpsAt=0;

const roiCanvas=document.createElement('canvas');
const roiCtx=roiCanvas.getContext('2d',{willReadFrequently:false});
const fullCanvas=document.createElement('canvas');
const fullCtx=fullCanvas.getContext('2d',{willReadFrequently:false});
const lightCanvas=document.createElement('canvas'); lightCanvas.width=32; lightCanvas.height=18;
const lightCtx=lightCanvas.getContext('2d',{willReadFrequently:true});

const geoCanvas=document.createElement('canvas'); geoCanvas.width=192; geoCanvas.height=108;
const geoCtx=geoCanvas.getContext('2d',{willReadFrequently:true});
let geoState={mode:'IDLE',confidence:0,lastRun:0,samples:[],lockedAt:0,lastGood:null};

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
  if(sourceMode!=='camera'||!cfg.autoGeometry||calibrationMode||video.readyState<2)return;
  const interval=geoState.mode==='LOCK'?1600:550;if(now-geoState.lastRun<interval)return;geoState.lastRun=now;
  try{const g=analyzeLaneGeometry();if(!g)return;if(geoState.mode!=='LOCK')applyAutoGeometry(g);else{geoState.confidence=g.confidence;updateQuality();}}catch(e){console.warn('auto geometry',e);}
}

function loadCfg(){
  try { return {...defaults,...JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}; }
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
  return {...cfg,cameraHeight:Number(inputs.cameraHeight.value),horizonPct:Number(inputs.horizon.value),autoGeometry:$('autoGeometry')?.checked??cfg.autoGeometry,laneCount:Number(inputs.laneCount.value),egoLane:Number(inputs.egoLane.value),vanishXPct:Number(inputs.vanishX.value),laneCenterBottomPct:Number(inputs.laneCenter.value),laneWidthBottomPct:Number(inputs.laneWidth.value),scoreThreshold:Number(inputs.score.value),smoothingAlpha:Number(inputs.smooth.value),aiHz:Number(inputs.aiHz.value),showAll:inputs.showAll.checked,gpsSpeedEnabled:inputs.gpsSpeedEnabled?.checked??cfg.gpsSpeedEnabled};
}
function syncControls(){
  inputs.cameraHeight.value=cfg.cameraHeight;inputs.cameraHeightRange.value=cfg.cameraHeight;inputs.horizon.value=cfg.horizonPct;if($('autoGeometry'))$('autoGeometry').checked=cfg.autoGeometry;
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
ui.reset.addEventListener('click',()=>{cfg={...defaults,calLines:{...defaults.calLines}};saveCfg();tracks=[];syncControls();updateQuality();});
ui.save.addEventListener('click',()=>{const next=tempCfg();next.egoLane=Math.min(next.egoLane,next.laneCount);cfg=next;saveCfg();tracks=[];closePanel();if(sourceMode==='camera'){if(cfg.gpsSpeedEnabled)startGPS();else stopGPS();}if(cfg.autoGeometry&&sourceMode==='camera')resetAutoGeometry(true);else updateQuality();});

let calibrationMode=false,dragDistance=null;
function setCalibrationMode(on){calibrationMode=on;cfg.calLocked=!on;canvas.classList.toggle('cal-active',on);ui.cal.textContent=on?'CAL: ĐANG KÉO VẠCH':(cfg.autoGeometry?'AUTO LẠI':'CAL: TỰ ĐỘNG');ui.hint.textContent=on?'Chạm vạch gần nhất rồi kéo lên/xuống • thả tay để lưu':'Đường đỏ = 100 m. Xe phía trên hiển thị >100 m.';saveCfg();render(lastPredictions);}
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
  const yh=horizonY(h),tt=Math.max(0,Math.min(1,(y-yh)/Math.max(1,h-yh))),p=Math.pow(tt,0.92);
  const vanish=w*cfg.vanishXPct/100,egoBottom=w*cfg.laneCenterBottomPct/100;
  const egoCenter=vanish+(egoBottom-vanish)*p, laneWidth=w*cfg.laneWidthBottomPct/100*p;
  const n=cfg.laneCount,e=cfg.egoLane; const boundaries=[];
  for(let j=0;j<=n;j++) boundaries.push(egoCenter+(j-e+0.5)*laneWidth);
  return {egoCenter,laneWidth,boundaries};
}
function laneForX(x,y,w,h){
  const g=laneGeomAtY(y,w,h); if(g.laneWidth<3)return null;
  for(let i=0;i<cfg.laneCount;i++) if(x>=g.boundaries[i]&&x<g.boundaries[i+1]) return i+1;
  const margin=g.laneWidth*0.25;
  if(x>=g.boundaries[0]-margin&&x<g.boundaries[0])return 1;
  if(x>g.boundaries[cfg.laneCount]&&x<=g.boundaries[cfg.laneCount]+margin)return cfg.laneCount;
  return null;
}

function candidatesFromPredictions(predictions,t){
  const threshold=Math.max(0.18,cfg.scoreThreshold-(tracks.length?0.08:0.16)),out=[];
  for(const p of predictions||[]){
    if(!VEHICLES.has(p.class)||p.score<threshold)continue;
    const b=imageToScreenBox(p.bbox,t); if(b.x+b.w<0||b.x>t.cw||b.y+b.h<0||b.y>t.ch||b.w<6||b.h<6)continue;
    const cx=b.x+b.w/2,by=Math.min(t.ch,b.y+b.h),lane=laneForX(cx,by,t.cw,t.ch); if(!lane)continue;
    const ds=distanceState(by,t.ch); out.push({p,b,cx,by,lane,ds});
  }
  return out;
}
function centerDist(a,b,t){return Math.hypot((a.cx-b.cx)/t.cw,(a.by-b.by)/t.ch);}
function updateTracks(cands,now,t){
  const used=new Set();
  for(const tr of tracks){
    let best=-1,bestScore=-1;
    for(let i=0;i<cands.length;i++){
      if(used.has(i))continue;const c=cands[i],ov=iou(tr.box,c.b),mv=centerDist(tr,c,t);if(mv>0.24&&ov<0.01)continue;
      const classBonus=tr.className===c.p.class?0.25:0,score=ov*3.4+Math.max(0,1-mv/0.24)*1.25+classBonus+(tr.lane===c.lane?0.18:0);
      if(score>bestScore){bestScore=score;best=i;}
    }
    if(best>=0&&bestScore>0.35){
      const c=cands[best];used.add(best);const a=cfg.smoothingAlpha;
      tr.box={x:tr.box.x*(1-a)+c.b.x*a,y:tr.box.y*(1-a)+c.b.y*a,w:tr.box.w*(1-a)+c.b.w*a,h:tr.box.h*(1-a)+c.b.h*a};
      tr.cx=tr.box.x+tr.box.w/2;tr.by=tr.box.y+tr.box.h;tr.className=c.p.class;tr.score=c.p.score;tr.lane=c.lane;
      tr.dState=c.ds;tr.dSmooth=tr.dSmooth==null?c.ds.numeric:tr.dSmooth*(1-a)+c.ds.numeric*a;updateTrackMotion(tr,tr.dSmooth,now);tr.lastSeen=now;tr.hits++;tr.stale=false;
    }else tr.stale=true;
  }
  for(let i=0;i<cands.length;i++) if(!used.has(i)){
    const c=cands[i];tracks.push({id:nextTrackId++,box:{...c.b},cx:c.cx,by:c.by,className:c.p.class,score:c.p.score,lane:c.lane,dState:c.ds,dSmooth:c.ds.numeric,motionSamples:[{t:now,d:c.ds.numeric}],closingKmh:null,lastSeen:now,hits:1,stale:false});
  }
  tracks=tracks.filter(tr=>now-tr.lastSeen<1100).slice(-24);
}
function displayDistanceForTrack(tr,h){
  const ds=distanceState(tr.by,h);
  if(ds.kind==='number'){
    const d=Math.min(99.4,tr.dSmooth??ds.numeric);return {kind:'number',text:`${d<10?d.toFixed(1):Math.round(d)} m`,main:d<10?d.toFixed(1):String(Math.round(d))};
  }
  return {...ds,main:ds.kind==='over'?'>100':'~100'};
}
function chooseEgoLead(h){
  return tracks.filter(t=>!t.stale&&t.lane===cfg.egoLane).sort((a,b)=>(displayDistanceForTrack(a,h).numeric??999)-(displayDistanceForTrack(b,h).numeric??999))[0]||null;
}

function updateReadout(lead,h){
  ui.readout.classList.remove('state-warning','state-danger','state-idle');
  const live=tracks.filter(t=>!t.stale);ui.trackCount.textContent=`${live.length} xe`;
  if(!lead){ui.distance.textContent='--.-';ui.lead.textContent='CHƯA CÓ XE TRONG LÀN MÌNH';ui.laneMain.textContent=`L${cfg.egoLane}`;ui.track.textContent='TRACK: --';ui.readout.classList.add('state-idle');return;}
  const d=displayDistanceForTrack(lead,h);ui.distance.textContent=d.main;ui.lead.textContent=`XE DẪN • L${lead.lane}`;ui.laneMain.textContent=`L${lead.lane}`;ui.track.textContent=`TRACK: #${lead.id}`;
  if(d.kind==='number'&&d.numeric<15)ui.readout.classList.add('state-warning');
}
function updateQuality(){const cal=currentCalibration();const gs=cfg.autoGeometry?(geoState.mode==='LOCK'?`AUTO LOCK ${Math.round(geoState.confidence*100)}%`:'AUTO CAL'):'MANUAL';ui.quality.textContent=cal?`${gs} • H ${cal.horizonPct.toFixed(1)}% • ${cfg.cameraHeight.toFixed(2)}m • ĐỎ 100m • ${cfg.laneCount} LÀN`:'CAL: KHÔNG HỢP LỆ';}

function drawGuides(){
  const w=canvas.clientWidth,h=canvas.clientHeight,ry=redY(h),yh=horizonY(h);ctx.save();
  const bg=laneGeomAtY(h,w,h);ctx.strokeStyle='rgba(40,230,130,.70)';ctx.lineWidth=2;ctx.setLineDash([]);
  for(let j=0;j<=cfg.laneCount;j++){ctx.beginPath();ctx.moveTo(w*cfg.vanishXPct/100,yh);ctx.lineTo(bg.boundaries[j],h);ctx.stroke();}
  for(let i=1;i<=cfg.laneCount;i++){const x=(bg.boundaries[i-1]+bg.boundaries[i])/2;ctx.font='700 12px -apple-system,sans-serif';ctx.fillStyle=i===cfg.egoLane?'rgba(50,255,150,.95)':'rgba(255,255,255,.75)';ctx.fillText(`L${i}`,x-8,h-18);}
  for(const d of [100,70,50,30,20,10]){const y=h*Number(cfg.calLines[d])/100,isRed=d===100,isDrag=calibrationMode&&dragDistance===d;ctx.strokeStyle=isRed?'rgba(255,55,55,.98)':(isDrag?'rgba(255,235,60,1)':'rgba(255,210,30,.72)');ctx.lineWidth=isRed?3:(isDrag?3:1.4);ctx.setLineDash(isRed?[14,8]:[7,7]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=ctx.strokeStyle;ctx.font=`${isRed?'800':'700'} 12px -apple-system,sans-serif`;ctx.fillText(`${d} m`,8,Math.max(16,y-5));if(calibrationMode){ctx.beginPath();ctx.arc(w-18,y,7,0,Math.PI*2);ctx.fill();}}
  ctx.restore();
}
function drawTrack(tr,h,w){
  const d=displayDistanceForTrack(tr,h),isLead=tr.lane===cfg.egoLane&&!tr.stale;
  ctx.save();ctx.lineWidth=isLead?3.5:2;ctx.strokeStyle=tr.stale?'rgba(180,180,180,.45)':(isLead?'rgba(20,255,120,.98)':'rgba(80,190,255,.92)');ctx.strokeRect(tr.box.x,tr.box.y,tr.box.w,tr.box.h);
  ctx.fillStyle='rgba(255,210,30,.98)';ctx.beginPath();ctx.arc(tr.cx,tr.by,isLead?5:4,0,Math.PI*2);ctx.fill();
  const label=`L${tr.lane} • #${tr.id} • ${d.text}`;ctx.font=`${isLead?'800 15px':'700 12px'} -apple-system,sans-serif`;const tw=ctx.measureText(label).width;
  const tx=Math.max(4,Math.min(tr.box.x,w-tw-12)),ty=Math.max(24,tr.box.y-6);ctx.fillStyle='rgba(0,0,0,.76)';ctx.fillRect(tx-4,ty-18,tw+8,22);ctx.fillStyle='#fff';ctx.fillText(label,tx,ty-2);ctx.restore();
}
function render(predictions){
  resizeCanvas();const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);drawGuides();const t=coverTransform();
  const cands=candidatesFromPredictions(predictions,t);updateTracks(cands,performance.now(),t);const lead=chooseEgoLead(h);updateReadout(lead,h);updateMotionReadout(lead,h);
  if(cfg.showAll)for(const tr of tracks)drawTrack(tr,h,w);else if(lead)drawTrack(lead,h,w);
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
  for(const a of attempts){try{ui.status.textContent=a.label==='LOCAL'?'Đang nạp model AI nội bộ…':'Đang tải model AI…';model=await timeoutPromise(cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:a.url}),45000,`Model ${a.label}`);ui.status.textContent=`AI sẵn sàng • ${a.label}`;ui.backend.textContent=`TF ${backend} • ${a.label}`;console.info('AI ready',{backend,source:a.label,libs});return model;}catch(e){lastErr=e;console.error(e);}}
  throw new Error(`Không nạp được model AI. ${lastErr?.message||''}`);
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){alert('Camera web cần HTTPS hoặc localhost.');return;}stopCamera(false);ui.status.textContent='Đang mở camera…';
  try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}}});video.srcObject=stream;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Camera không trả metadata')),10000);if(video.readyState>=1){clearTimeout(timer);resolve();return;}video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};});await video.play();resizeCanvas();}
  catch(err){console.error(err);ui.status.textContent='Lỗi camera';alert(`Không mở được camera: ${err.message||err}`);return;}
  sourceMode='camera';running=true;startGPS();ui.start.textContent='DỪNG';ui.videoBtn.textContent='VIDEO THỬ';lastAIEnd=0;if(cfg.autoGeometry)resetAutoGeometry(true);
  try{await initModel();ui.status.textContent='Đang theo dõi 3–4 làn';if(!drawRAF)drawRAF=requestAnimationFrame(loop);}catch(err){console.error(err);ui.status.textContent='AI chưa sẵn sàng';ui.fps.textContent='AI ERROR';alert(`AI chưa nạp được.\n\n${err.message||err}`);}
}
function stopCamera(updateUI=true){
  running=false;aiBusy=false;if(drawRAF){cancelAnimationFrame(drawRAF);drawRAF=0;}
  if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
  try{video.pause();}catch{}
  video.srcObject=null;video.removeAttribute('src');video.load();
  if(videoObjectUrl){URL.revokeObjectURL(videoObjectUrl);videoObjectUrl=null;}
  sourceMode='none';stopGPS();tracks=[];lastPredictions=[];
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
    await video.play();resizeCanvas();sourceMode='video';stopGPS();running=true;ui.start.textContent='DỪNG';ui.videoBtn.textContent='DỪNG VIDEO';lastAIEnd=0;tracks=[];
    await initModel();ui.status.textContent='VIDEO THỬ • đang chạy cùng pipeline AI';if(!drawRAF)drawRAF=requestAnimationFrame(loop);
  }catch(err){console.error(err);ui.status.textContent='Lỗi video thử';alert(`Không mở được video thử: ${err.message||err}`);stopCamera(true);}
  finally{ui.videoFile.value='';}
});

function estimateSceneLuma(){
  try{if(video.readyState<2||!video.videoWidth)return sceneLuma;lightCtx.drawImage(video,0,0,32,18);const d=lightCtx.getImageData(0,0,32,18).data;let sum=0,n=0;for(let i=0;i<d.length;i+=16){sum+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];n++;}sceneLuma=sum/Math.max(1,n)/255;}catch{}return sceneLuma;
}
function buildFullInput(){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,rw=640,rh=Math.round(rw*vh/vw);if(fullCanvas.width!==rw||fullCanvas.height!==rh){fullCanvas.width=rw;fullCanvas.height=rh;}
  fullCtx.save();fullCtx.clearRect(0,0,rw,rh);const dark=sceneLuma<0.34;if('filter'in fullCtx)fullCtx.filter=dark?'brightness(1.35) contrast(1.20) saturate(1.04)':'none';fullCtx.drawImage(video,0,0,rw,rh);fullCtx.restore();return{rw,rh,dark};
}
function buildFarROI(side){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,cal=currentCalibration(),yh=(cal?cal.horizonPct/100:0.50)*vh;
  const sy=Math.max(0,yh-0.10*vh),sh=Math.min(vh-sy,0.40*vh),sw=vw*0.60,sx=side==='L'?0:vw-sw;
  const rw=640,rh=Math.max(300,Math.round(rw*sh/sw));if(roiCanvas.width!==rw||roiCanvas.height!==rh){roiCanvas.width=rw;roiCanvas.height=rh;}
  roiCtx.save();roiCtx.clearRect(0,0,rw,rh);const dark=sceneLuma<0.34;if('filter'in roiCtx)roiCtx.filter=dark?'brightness(1.42) contrast(1.24) saturate(1.03)':'contrast(1.08)';roiCtx.drawImage(video,sx,sy,sw,sh,0,0,rw,rh);roiCtx.restore();return{sx,sy,sw,sh,rw,rh,dark,side};
}
function mapPreds(preds,r){return(preds||[]).map(p=>{const[x,y,w,h]=p.bbox;return{...p,bbox:[r.sx+x*r.sw/r.rw,r.sy+y*r.sh/r.rh,w*r.sw/r.rw,h*r.sh/r.rh]};});}
async function detectAdaptive(){
  detectFrame++;if(detectFrame%4===1)estimateSceneLuma();const phase=detectFrame%3;
  if(phase===1){const f=buildFullInput(),min=f.dark?0.16:0.19,preds=await model.detect(fullCanvas,18,min);detectMode=f.dark?'FULL+DARK':'FULL';const vw=video.videoWidth||1,vh=video.videoHeight||1;return(preds||[]).map(p=>{const[x,y,w,h]=p.bbox;return{...p,bbox:[x*vw/f.rw,y*vh/f.rh,w*vw/f.rw,h*vh/f.rh]};});}
  const side=phase===2?'L':'R',r=buildFarROI(side),min=r.dark?0.14:0.17,preds=await model.detect(roiCanvas,14,min);detectMode=`ZOOM-${side}${r.dark?'+DARK':''}`;return mapPreds(preds,r);
}
async function loop(ts){
  maybeAutoGeometry(ts);
  drawRAF=0;if(!running)return;const interval=1000/Math.max(1,cfg.aiHz);
  if(!aiBusy&&model&&video.readyState>=2&&ts-lastAIEnd>=interval){aiBusy=true;const started=performance.now();try{const preds=await detectAdaptive();lastPredictions=preds;render(preds);const elapsed=performance.now()-started,instant=1000/Math.max(elapsed,1);fpsSmooth=fpsSmooth?fpsSmooth*.78+instant*.22:instant;ui.fps.textContent=`AI ${fpsSmooth.toFixed(1)} FPS • ${detectMode}`;}catch(err){console.error(err);ui.status.textContent='AI lỗi 1 frame';}finally{lastAIEnd=performance.now();aiBusy=false;}}
  if(running)drawRAF=requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stopCamera(true);});window.addEventListener('pagehide',()=>{if(running)stopCamera(false);});
syncControls();resizeCanvas();updateQuality();updateNetworkState();updateSpeedUI();drawGuides();if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
