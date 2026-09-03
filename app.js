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
const CFG_KEY = 'distanceadas_cfg_v11b6r2_fix1';
const APP_VERSION = 'v1.1 beta.6R2-FIX1';
const RED_DISTANCE_M = 100;
const defaults = {
  cameraHeight:1.20, horizonPct:50.0, effectiveVFovDeg:42, calLocked:true, autoGeometry:true,
  calLines:{10:65.64,20:57.82,30:55.21,50:53.13,70:52.23,100:51.56},
  laneCount:4, egoLane:2, autoLane:true, vanishXPct:50, laneCenterBottomPct:50, laneWidthBottomPct:22,
  scoreThreshold:0.34, smoothingAlpha:0.28, aiHz:12, showAll:false, gpsSpeedEnabled:true
};

let cfg = loadCfg();
let stream=null, model=null, running=false, aiBusy=false, drawRAF=0, sourceMode='none', videoObjectUrl=null;

let cameraProfile={wideId:null,teleId:null,current:'wide',devices:[],canZoom:false,zoomMin:1,zoomMax:1};
const teleVideo=document.createElement('video');
teleVideo.autoplay=true;teleVideo.muted=true;teleVideo.playsInline=true;
let teleStream=null;
let teleState={active:false,busy:false,failedUntil:0,wantSince:0,lastInfer:0,lastSeen:0,leadId:null,anchorK:null,distance:null,score:0};
const TELE_ON_M=85, TELE_OFF_M=65, TELE_HOLD_MS=900, TELE_INFER_MS=650, TELE_STALE_MS=1800;

// Depth Anything V2 Small — browser inference assist.
// Official Metric Outdoor Small is not currently published as browser-ready ONNX.
// This browser model provides a real AI depth signal on the locked vehicle ROI.
const DA_MODEL_ID='onnx-community/depth-anything-v2-small-ONNX';
const DA_INTERVAL_MS=1800;
let daPipe=null, daLoading=false, daBusy=false, daFailedUntil=0, daLastInfer=0;
let orientationResetBusy=false,lastViewportKey='';
let daState={ready:false,backend:'--',distance:null,lastSeen:0,leadId:null,scale:null};
async function ensureDepthAI(){
  if(daPipe||daLoading||performance.now()<daFailedUntil)return !!daPipe;
  daLoading=true;
  try{
    if(!globalThis.transformers?.pipeline) throw new Error('Transformers.js chưa nạp');
    const hasWebGPU=!!navigator.gpu;
    const opts=hasWebGPU?{device:'webgpu',dtype:'q4f16'}:{device:'wasm',dtype:'q8'};
    daPipe=await globalThis.transformers.pipeline('depth-estimation',DA_MODEL_ID,opts);
    daState.ready=true; daState.backend=hasWebGPU?'WEBGPU':'WASM';
    ui.status.textContent=`AI DEPTH ${daState.backend} • WIDE LOCK`;
    return true;
  }catch(e){console.warn('Depth AI unavailable',e);daFailedUntil=performance.now()+30000;return false;}
  finally{daLoading=false;}
}
function daMedian(vals){vals=vals.filter(Number.isFinite).sort((a,b)=>a-b);if(!vals.length)return NaN;const m=vals.length>>1;return vals.length%2?vals[m]:(vals[m-1]+vals[m])/2;}
async function updateDepthAI(lead,now){
  if(!lead||sourceMode==='none'||daBusy||aiBusy||teleState.busy||now-daLastInfer<DA_INTERVAL_MS)return;
  daBusy=true;daLastInfer=now;if(!(await ensureDepthAI())){daBusy=false;return;}
  try{
    const src=(teleState.active&&teleVideo.readyState>=2)?teleVideo:video;if(src.readyState<2)return;
    const sw=src.videoWidth||1280,sh=src.videoHeight||720,b=lead.box||{x:sw*.4,y:sh*.35,w:sw*.2,h:sh*.25};
    const sx=Math.max(0,b.x-b.w*.60),sy=Math.max(0,b.y-b.h*.50),ex=Math.min(sw,b.x+b.w*1.60),ey=Math.min(sh,b.y+b.h*1.30);
    const rw=Math.max(96,ex-sx),rh=Math.max(96,ey-sy);teleCanvas.width=224;teleCanvas.height=Math.max(144,Math.round(224*rh/rw));
    teleCtx.drawImage(src,sx,sy,rw,rh,0,0,teleCanvas.width,teleCanvas.height);
    const out=await daPipe(teleCanvas);
    const tensor=out?.predicted_depth; const raw=tensor?.data||out?.depth?.data||null;if(!raw||!raw.length)return;
    const dims=tensor?.dims||[]; const W=dims[dims.length-1]||teleCanvas.width,H=dims[dims.length-2]||teleCanvas.height,vals=[];
    for(let y=Math.floor(H*.46);y<Math.floor(H*.82);y+=Math.max(1,Math.floor(H/22)))for(let x=Math.floor(W*.28);x<Math.floor(W*.72);x+=Math.max(1,Math.floor(W/18))){const v=Number(raw[y*W+x]);if(Number.isFinite(v)&&v>0)vals.push(v);}
    const rel=daMedian(vals);if(!Number.isFinite(rel)||rel<=0)return;
    // Web-ready DAV2 Small is relative-depth. We use it to stabilize frame-to-frame motion,
    // anchored to the current metric estimate until a true Metric-Outdoor ONNX is available.
    const anchor=Number.isFinite(lead.dFilt)?lead.dFilt:null;
    if(daState.leadId!==lead.id||!Number.isFinite(daState.scale)){daState.leadId=lead.id;daState.scale=anchor&&anchor>2?anchor/rel:null;daState.distance=anchor;}
    else if(anchor&&anchor>2&&anchor<80){const sc=anchor/rel;daState.scale=daState.scale*.98+sc*.02;}
    if(Number.isFinite(daState.scale)){const d=Math.max(1,Math.min(100,rel*daState.scale));daState.distance=Number.isFinite(daState.distance)?daState.distance*.72+d*.28:d;daState.lastSeen=now;lead.aiDepthDistance=daState.distance;lead.aiDepthAt=now;}
  }catch(e){console.warn('Depth AI frame',e);}
  finally{daBusy=false;try{globalThis.tf?.disposeVariables?.();}catch{}}
}

const AI_METRIC_MAX_M=80;
const teleCanvas=document.createElement('canvas');
const teleCtx=teleCanvas.getContext('2d',{willReadFrequently:false});

function cameraLabelScore(label,kind){
  const s=(label||'').toLowerCase();
  if(!s)return 0;
  const back=/(back|rear|environment|sau)/.test(s)?4:0;
  if(kind==='tele'){
    let q=back;
    if(/tele|telephoto/.test(s))q+=15;
    if(/(^|\D)(2x|2\.5x|3x|4x|5x)(\D|$)/.test(s))q+=9;
    if(/ultra|0\.5x|0,5x/.test(s))q-=20;
    if(/wide/.test(s)&&!/tele/.test(s))q-=4;
    return q;
  }
  let q=back;
  if(/wide/.test(s))q+=8;
  if(/main|standard|1x/.test(s))q+=6;
  if(/ultra|0\.5x|0,5x|tele|telephoto/.test(s))q-=15;
  return q;
}

async function discoverRearCameras(){
  if(!navigator.mediaDevices?.enumerateDevices)return cameraProfile;
  try{
    const devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
    cameraProfile.devices=devs;
    let wide=null,tele=null,ws=-1,ts=-1;
    for(const d of devs){
      const a=cameraLabelScore(d.label,'wide'),b=cameraLabelScore(d.label,'tele');
      if(a>ws){ws=a;wide=d;}
      if(b>ts){ts=b;tele=d;}
    }
    cameraProfile.wideId=wide&&ws>0?wide.deviceId:null;
    cameraProfile.teleId=tele&&ts>=8&&tele.deviceId!==cameraProfile.wideId?tele.deviceId:null;
  }catch(e){console.warn('AUTO CAM discover',e);}
  return cameraProfile;
}

function currentVideoTrack(){return stream?.getVideoTracks?.()[0]||null;}
function refreshZoomCaps(){
  const tr=currentVideoTrack();
  cameraProfile.canZoom=false;cameraProfile.zoomMin=1;cameraProfile.zoomMax=1;
  try{
    const caps=tr?.getCapabilities?.()||{};
    if(caps.zoom){cameraProfile.canZoom=true;cameraProfile.zoomMin=Number(caps.zoom.min||1);cameraProfile.zoomMax=Number(caps.zoom.max||1);}
  }catch{}
}
async function applyTrackZoom(target){
  const tr=currentVideoTrack();if(!tr||!cameraProfile.canZoom)return false;
  const z=target==='tele'?Math.min(cameraProfile.zoomMax,Math.max(2,cameraProfile.zoomMin)):Math.max(cameraProfile.zoomMin,1);
  try{await tr.applyConstraints({advanced:[{zoom:z}]});cameraProfile.current=target;return true;}catch(e){console.warn('AUTO CAM zoom',e);return false;}
}
function cameraConstraint(deviceId){
  return {audio:false,video:{...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:{ideal:'environment'}}),width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}}};
}
async function attachStream(s){
  stream=s;video.srcObject=stream;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Camera không trả metadata')),10000);if(video.readyState>=1){clearTimeout(timer);resolve();return;}video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};});
  await video.play();resizeCanvas();refreshZoomCaps();
}
async function stopTeleAssist(){
  try{teleStream?.getTracks?.().forEach(t=>t.stop());}catch{}
  teleStream=null;teleVideo.srcObject=null;
  try{teleVideo.pause();}catch{}
  teleState.active=false;teleState.busy=false;teleState.wantSince=0;teleState.lastInfer=0;teleState.lastSeen=0;teleState.leadId=null;teleState.anchorK=null;teleState.distance=null;teleState.score=0;
}
async function startTeleAssist(){
  if(sourceMode!=='camera'||teleState.active||teleState.busy||performance.now()<teleState.failedUntil)return false;
  if(!cameraProfile.teleId||cameraProfile.teleId===cameraProfile.wideId)return false;
  teleState.busy=true;
  try{
    const s=await navigator.mediaDevices.getUserMedia(cameraConstraint(cameraProfile.teleId));
    teleStream=s;teleVideo.srcObject=s;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('TELE không trả metadata')),7000);if(teleVideo.readyState>=1){clearTimeout(timer);resolve();return;}teleVideo.onloadedmetadata=()=>{clearTimeout(timer);resolve();};});
    await teleVideo.play();teleState.active=true;teleState.lastSeen=performance.now();
    ui.status.textContent='WIDE LOCK • TELE DISTANCE';
    return true;
  }catch(e){
    console.warn('TELE assist unavailable',e);teleState.failedUntil=performance.now()+15000;await stopTeleAssist();
    ui.status.textContent='WIDE LOCK • TELE không khả dụng → WIDE DISTANCE';
    return false;
  }finally{teleState.busy=false;}
}
function maybeManageTele(lead,now){
  if(sourceMode!=='camera'||!lead||!Number.isFinite(lead.dFilt)){
    if(teleState.active&&now-teleState.lastSeen>3000)void stopTeleAssist();
    teleState.wantSince=0;return;
  }
  if(lead.dFilt>=TELE_ON_M){
    if(!teleState.wantSince)teleState.wantSince=now;
    if(!teleState.active&&now-teleState.wantSince>=TELE_HOLD_MS)void startTeleAssist();
  }else if(lead.dFilt<=TELE_OFF_M){teleState.wantSince=0;if(teleState.active)void stopTeleAssist();}
}
function teleCandidateScore(p,lead,tw,th){
  if(!VEHICLES.has(p.class))return -999;
  const [x,y,w,h]=p.bbox,cx=x+w/2,cy=y+h/2;
  const center=Math.hypot((cx-tw/2)/tw,(cy-th*0.56)/th);
  const classBonus=p.class===lead.className?0.45:0;
  const centralBonus=Math.max(0,1-center/0.48);
  const area=Math.max(0,Math.min(1,(w*h)/(tw*th)*18));
  return p.score*1.4+classBonus+centralBonus*1.1+area*0.20;
}
async function updateTeleDistance(lead,now){
  if(!teleState.active||teleState.busy||!lead||teleVideo.readyState<2||!model||now-teleState.lastInfer<TELE_INFER_MS)return;
  teleState.lastInfer=now;
  try{
    const vw=teleVideo.videoWidth||1280,vh=teleVideo.videoHeight||720,rw=416,rh=Math.max(234,Math.round(rw*vh/vw));
    if(teleCanvas.width!==rw||teleCanvas.height!==rh){teleCanvas.width=rw;teleCanvas.height=rh;}
    teleCtx.drawImage(teleVideo,0,0,rw,rh);
    const preds=await model.detect(teleCanvas,10,0.16);
    let best=null,bestS=-999;
    for(const p of preds||[]){const q=teleCandidateScore(p,lead,rw,rh);if(q>bestS){bestS=q;best=p;}}
    if(!best||bestS<0.65)return;
    const [x,y,w,h]=best.bbox;const size=Math.sqrt(Math.max(1,w*h));
    if(teleState.leadId!==lead.id||!Number.isFinite(teleState.anchorK)){
      const wideD=Number.isFinite(lead.dFilt)?lead.dFilt:null;if(!wideD)return;
      teleState.leadId=lead.id;teleState.anchorK=wideD*size;teleState.distance=wideD;
    }else{
      const d=teleState.anchorK/Math.max(1,size);
      if(Number.isFinite(d)&&d>=15&&d<=220){
        teleState.distance=Number.isFinite(teleState.distance)?teleState.distance*0.72+d*0.28:d;
      }
    }
    teleState.score=best.score;teleState.lastSeen=now;
    lead.teleDistance=teleState.distance;lead.teleAt=now;lead.teleScore=best.score;
  }catch(e){console.warn('TELE distance frame',e);}
}
let lastAIEnd=0, fpsSmooth=0, tracks=[], nextTrackId=1, lastPredictions=[], lockedLeadId=null;
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
function resetForOrientation(){
  if(orientationResetBusy)return;orientationResetBusy=true;
  const wasRunning=running;const oldHz=cfg.aiHz;
  ui.status.textContent='XOAY MÀN HÌNH • đang căn lại camera…';
  tracks=[];lockedLeadId=null;lastPredictions=[];detectFrame=0;lastAIEnd=performance.now()+350;
  laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};
  resetAutoGeometry(false);
  teleState.leadId=null;teleState.anchorK=null;teleState.distance=null;daState.leadId=null;daState.scale=null;daState.distance=null;
  setTimeout(()=>{resizeCanvas();lastViewportKey=`${video.videoWidth}x${video.videoHeight}:${innerWidth}x${innerHeight}`;orientationResetBusy=false;if(wasRunning)ui.status.textContent='LANDSCAPE READY • đang khóa lại xe trước';},420);
}
function viewportChanged(){const k=`${video.videoWidth}x${video.videoHeight}:${innerWidth}x${innerHeight}`;if(lastViewportKey&&k!==lastViewportKey)resetForOrientation();else lastViewportKey=k;resizeCanvas();}
window.addEventListener('resize',()=>setTimeout(viewportChanged,120));
window.addEventListener('orientationchange',()=>setTimeout(resetForOrientation,180));
if(screen.orientation?.addEventListener)screen.orientation.addEventListener('change',()=>setTimeout(resetForOrientation,180));

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
  const threshold=Math.max(0.18,cfg.scoreThreshold-(tracks.length?0.08:0.16)),out=[];
  for(const p of predictions||[]){
    if(!VEHICLES.has(p.class)||p.score<threshold)continue;
    const b=imageToScreenBox(p.bbox,t); if(b.x+b.w<0||b.x>t.cw||b.y+b.h<0||b.y>t.ch||b.w<6||b.h<6)continue;
    const cx=b.x+b.w/2,by=Math.min(t.ch,b.y+b.h*0.985),lane=laneForX(cx,by,t.cw,t.ch);
    const ds=distanceState(by,t.ch),ego=egoFootprint(b,by,t.cw,t.ch); out.push({p,b,cx,by,lane,ds,ego});
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
      tr.cx=tr.box.x+tr.box.w/2;tr.by=Math.min(t.ch,tr.box.y+tr.box.h*0.985);tr.vx=(tr.cx-oldCx)/dt;tr.vy=(tr.by-oldBy)/dt;
      tr.className=c.p.class;tr.score=c.p.score;tr.lane=c.lane;tr.ego=egoFootprint(tr.box,tr.by,t.cw,t.ch);
      const meas=fusedDistanceMeasurement(tr,t.ch);updateDistanceFilter(tr,meas,now);updateTrackMotion(tr,tr.dFilt,now);tr.lastSeen=now;tr.hits++;tr.stale=false;
    }else tr.stale=true;
  }
  for(let i=0;i<cands.length;i++) if(!used.has(i)){
    const c=cands[i],tr={id:nextTrackId++,box:{...c.b},cx:c.cx,by:c.by,vx:0,vy:0,className:c.p.class,score:c.p.score,lane:c.lane,ego:c.ego,dState:c.ds,dSmooth:c.ds.numeric,dFilt:null,dVel:0,dAt:now,dHistory:[],motionSamples:[],closingKmh:null,lastSeen:now,hits:1,stale:false};
    updateDistanceFilter(tr,fusedDistanceMeasurement(tr,t.ch)??c.ds.numeric,now);tr.motionSamples=[{t:now,d:tr.dFilt}];tracks.push(tr);
  }
  tracks=tracks.filter(tr=>now-tr.lastSeen<780).slice(-20);
  if(lockedLeadId!=null&&!tracks.some(t=>t.id===lockedLeadId))lockedLeadId=null;
}
function displayDistanceForTrack(tr,h){
  let wide=Number.isFinite(tr.dFilt)?tr.dFilt:fusedDistanceMeasurement(tr,h);
  if(!Number.isFinite(wide))return {kind:'unknown',text:'-- m',numeric:null,main:'--',source:'--'};
  let d=wide,source='WIDE';
  const teleFresh=Number.isFinite(tr.teleDistance)&&performance.now()-(tr.teleAt||0)<TELE_STALE_MS;
  if(teleFresh){
    const wt=wide>=70?0.65:(wide>=55?0.40:0.15);
    d=wide*(1-wt)+tr.teleDistance*wt;
    source='WIDE+TELE';
  }
  const aiFresh=Number.isFinite(tr.aiDepthDistance)&&performance.now()-(tr.aiDepthAt||0)<2800;
  if(aiFresh){
    const wt=d>=60?0.55:(d>=35?0.38:0.20);
    d=d*(1-wt)+tr.aiDepthDistance*wt;
    source=teleFresh?'WIDE+TELE+AI':'WIDE+AI';
  }
  // Product policy for the AI metric-depth branch: publish an exact number only up to 80 m.
  // Above that, preserve tracking but do not invent a metric value outside the model's intended outdoor range.
  if(d>AI_METRIC_MAX_M){
    return {kind:'over',text:`>${AI_METRIC_MAX_M} m`,numeric:d,main:`>${AI_METRIC_MAX_M}`,source:`${source} • >80 POLICY`};
  }
  const shown=Math.max(0,Math.round(d));
  return {kind:'number',text:`${shown} m`,numeric:d,main:String(shown),source};
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
  const d=displayDistanceForTrack(lead,h);ui.distance.textContent=d.main;ui.lead.textContent='XE TRƯỚC';ui.laneMain.textContent='AUTO';ui.track.textContent=`LOCK: XE TRƯỚC • ${d.source||'WIDE'}`;
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
  const d=displayDistanceForTrack(tr,h);ctx.save();
  ctx.lineWidth=3.2;ctx.strokeStyle='rgba(255,35,35,.98)';ctx.strokeRect(tr.box.x,tr.box.y,tr.box.w,tr.box.h);
  const label=`XE TRƯỚC • ${d.text}`;ctx.font='800 15px -apple-system,sans-serif';const tw=ctx.measureText(label).width;
  const tx=Math.max(4,Math.min(tr.box.x+tr.box.w/2-tw/2,w-tw-12)),ty=Math.max(28,tr.box.y-7);
  ctx.fillStyle='rgba(220,0,0,.92)';ctx.fillRect(tx-5,ty-19,tw+10,23);ctx.fillStyle='#fff';ctx.fillText(label,tx,ty-2);
  ctx.beginPath();ctx.moveTo(tr.box.x+tr.box.w/2,ty+4);ctx.lineTo(tr.box.x+tr.box.w/2,tr.box.y);ctx.stroke();ctx.restore();
}
function render(predictions){
  resizeCanvas();const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);drawGuides();const t=coverTransform();
  const now=performance.now();const cands=candidatesFromPredictions(predictions,t);updateTracks(cands,now,t);const lead=chooseEgoLead(h);maybeManageTele(lead,now);updateReadout(lead,h);updateMotionReadout(lead,h);
  if(lead)drawTrack(lead,h,w);return lead;
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
  try{await attachStream(await navigator.mediaDevices.getUserMedia(cameraConstraint(null)));await discoverRearCameras();const activeId=currentVideoTrack()?.getSettings?.().deviceId||null;if(cameraProfile.wideId&&cameraProfile.wideId!==activeId){try{const old=stream;const s=await navigator.mediaDevices.getUserMedia(cameraConstraint(cameraProfile.wideId));try{old?.getTracks().forEach(t=>t.stop());}catch{}await attachStream(s);}catch(e){console.warn('AUTO CAM wide fallback',e);}}cameraProfile.current='wide';ui.status.textContent=cameraProfile.teleId?'WIDE LOCK • TELE hỗ trợ đo • 0–80m số thực':'WIDE LOCK • WIDE fallback • >80m hiển thị >80';}
  catch(err){console.error(err);ui.status.textContent='Lỗi camera';alert(`Không mở được camera: ${err.message||err}`);return;}
  sourceMode='camera';running=true;laneState={mode:'SEARCH',confidence:0,lastRun:0,count:null,boundariesPct:null,egoLane:null,samples:[]};startGPS();ui.start.textContent='DỪNG';ui.videoBtn.textContent='VIDEO THỬ';lastAIEnd=0;if(cfg.autoGeometry)resetAutoGeometry(true);
  try{await initModel();ui.status.textContent='Đang khóa xe trước • AUTO LANE';if(!drawRAF)drawRAF=requestAnimationFrame(loop);}catch(err){console.error(err);ui.status.textContent='AI chưa sẵn sàng';ui.fps.textContent='AI ERROR';alert(`AI chưa nạp được.\n\n${err.message||err}`);}
}
function stopCamera(updateUI=true){
  running=false;aiBusy=false;if(drawRAF){cancelAnimationFrame(drawRAF);drawRAF=0;}
  if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;void stopTeleAssist();
  try{video.pause();}catch{}
  video.srcObject=null;video.removeAttribute('src');video.load();
  if(videoObjectUrl){URL.revokeObjectURL(videoObjectUrl);videoObjectUrl=null;}
  sourceMode='none';stopGPS();tracks=[];lockedLeadId=null;lastPredictions=[];cameraProfile.current='wide';teleState.failedUntil=0;
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
  maybeAutoGeometry(ts);maybeAutoLane(ts);if(Math.round(ts)%900<20)updateQuality();
  drawRAF=0;if(!running)return;const interval=1000/Math.max(1,cfg.aiHz);
  if(!orientationResetBusy&&!aiBusy&&!daBusy&&model&&video.readyState>=2&&ts-lastAIEnd>=interval){aiBusy=true;const started=performance.now();let lead=null;try{const preds=await detectAdaptive();lastPredictions=preds;lead=render(preds);if(lead&&teleState.active&&!daBusy)await updateTeleDistance(lead,performance.now());const elapsed=performance.now()-started,instant=1000/Math.max(elapsed,1);fpsSmooth=fpsSmooth?fpsSmooth*.78+instant*.22:instant;ui.fps.textContent=`AI ${fpsSmooth.toFixed(1)} FPS • ${detectMode}${teleState.active?' • TELE':''}`;}catch(err){console.error(err);ui.status.textContent='AI lỗi 1 frame';}finally{lastAIEnd=performance.now();aiBusy=false;}if(lead&&!teleState.busy&&performance.now()-daLastInfer>=DA_INTERVAL_MS)setTimeout(()=>{if(!aiBusy&&!orientationResetBusy)void updateDepthAI(lead,performance.now());},80);}
  if(running)drawRAF=requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stopCamera(true);});window.addEventListener('pagehide',()=>{if(running)stopCamera(false);});
syncControls();resizeCanvas();updateQuality();updateNetworkState();updateSpeedUI();drawGuides();if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
