
const $ = id => document.getElementById(id);
const video = $('camera');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const statusEl = $('status');
const fpsEl = $('fps');
const distanceMain = $('distanceMain');
const leadState = $('leadState');
const startBtn = $('startBtn');
const calBtn = $('calBtn');
const settingsBtn = $('settingsBtn');
const panel = $('panel');
const closePanelBtn = $('closePanelBtn');
const saveCalBtn = $('saveCalBtn');
const resetCalBtn = $('resetCalBtn');

const horizonRange = $('horizonRange');
const refRange = $('refRange');
const refDistance = $('refDistance');
const laneWidthRange = $('laneWidthRange');
const scoreRange = $('scoreRange');
const smoothRange = $('smoothRange');
const centerOnly = $('centerOnly');

const horizonValue = $('horizonValue');
const refValue = $('refValue');
const laneWidthValue = $('laneWidthValue');
const scoreValue = $('scoreValue');
const smoothValue = $('smoothValue');

let stream = null;
let model = null;
let running = false;
let aiBusy = false;
let lastAI = 0;
let fpsSmooth = 0;
let lastPredictions = [];
let leadTrack = null;
let drawRAF = null;

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle']);

const defaults = {
  horizonPct: 43,
  refPct: 72,
  refDistanceM: 10,
  laneWidthBottomPct: 62,
  scoreThreshold: 0.45,
  smoothingAlpha: 0.35,
  centerOnly: true
};

let cfg = loadCfg();

function loadCfg() {
  try {
    const stored = JSON.parse(localStorage.getItem('distanceadas_cfg_v02') || '{}');
    return { ...defaults, ...stored };
  } catch {
    return { ...defaults };
  }
}
function saveCfg() { localStorage.setItem('distanceadas_cfg_v02', JSON.stringify(cfg)); }

function syncControls() {
  horizonRange.value = cfg.horizonPct;
  refRange.value = cfg.refPct;
  refDistance.value = cfg.refDistanceM;
  laneWidthRange.value = cfg.laneWidthBottomPct;
  scoreRange.value = cfg.scoreThreshold;
  smoothRange.value = cfg.smoothingAlpha;
  centerOnly.checked = cfg.centerOnly;
  updateLabels();
}
function updateLabels() {
  horizonValue.textContent = `${Number(horizonRange.value).toFixed(1)}%`;
  refValue.textContent = `${Number(refRange.value).toFixed(1)}%`;
  laneWidthValue.textContent = `${Number(laneWidthRange.value).toFixed(0)}%`;
  scoreValue.textContent = Number(scoreRange.value).toFixed(2);
  smoothValue.textContent = Number(smoothRange.value).toFixed(2);
}
[horizonRange, refRange, laneWidthRange, scoreRange, smoothRange].forEach(el => el.addEventListener('input', updateLabels));

function openPanel() { syncControls(); panel.classList.remove('hidden'); panel.setAttribute('aria-hidden','false'); }
function closePanel() { panel.classList.add('hidden'); panel.setAttribute('aria-hidden','true'); }
calBtn.addEventListener('click', openPanel);
settingsBtn.addEventListener('click', openPanel);
closePanelBtn.addEventListener('click', closePanel);

resetCalBtn.addEventListener('click', () => {
  cfg = {...defaults};
  saveCfg();
  syncControls();
});

saveCalBtn.addEventListener('click', () => {
  const h = Number(horizonRange.value);
  const r = Number(refRange.value);
  const d = Number(refDistance.value);
  if (!(r > h + 2)) return alert('Vạch chuẩn phải nằm thấp hơn đường chân trời.');
  if (!(d > 0)) return alert('Khoảng cách chuẩn phải lớn hơn 0.');

  cfg = {
    horizonPct: h,
    refPct: r,
    refDistanceM: d,
    laneWidthBottomPct: Number(laneWidthRange.value),
    scoreThreshold: Number(scoreRange.value),
    smoothingAlpha: Number(smoothRange.value),
    centerOnly: centerOnly.checked
  };
  saveCfg();
  closePanel();
});

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 300));

function coverTransform() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const scale = Math.max(cw / vw, ch / vh);
  const drawW = vw * scale, drawH = vh * scale;
  return { cw, ch, vw, vh, scale, offsetX:(cw-drawW)/2, offsetY:(ch-drawH)/2 };
}
function imageToScreenBox(bbox, t) {
  const [x,y,w,h] = bbox;
  return { x:t.offsetX+x*t.scale, y:t.offsetY+y*t.scale, w:w*t.scale, h:h*t.scale };
}

function horizonY(h) { return h * cfg.horizonPct / 100; }

function distanceFromScreenY(yPx, screenHeight) {
  const yh = horizonY(screenHeight);
  const yr = (cfg.refPct / 100) * screenHeight;
  const denomRef = yr - yh;
  const denom = yPx - yh;
  if (denomRef <= 0 || denom <= 2) return null;
  const K = cfg.refDistanceM * denomRef;
  const d = K / denom;
  if (!Number.isFinite(d) || d < 0.5 || d > 250) return null;
  return d;
}

function laneHalfWidthAtY(y, w, h) {
  const yh = horizonY(h);
  const bottomHalf = w * (cfg.laneWidthBottomPct / 100) / 2;
  if (y <= yh) return 0;
  const t = Math.min(1, Math.max(0, (y-yh)/(h-yh)));
  // nonlinear perspective: narrow near horizon, wider near camera
  return bottomHalf * Math.pow(t, 0.92);
}

function laneBoundsAtY(y, w, h) {
  const half = laneHalfWidthAtY(y,w,h);
  return { left:w/2-half, right:w/2+half };
}

function leadScore(item, t) {
  const { b, p, d } = item;
  const bottomY = b.y + b.h;
  const cx = b.x + b.w/2;
  const lane = laneBoundsAtY(bottomY, t.cw, t.ch);
  const inLane = cx >= lane.left && cx <= lane.right;

  if (cfg.centerOnly && !inLane) return -999;

  const laneCenter = (lane.left + lane.right)/2;
  const laneHalf = Math.max(1,(lane.right-lane.left)/2);
  const centerPenalty = Math.min(2, Math.abs(cx-laneCenter)/laneHalf);

  // Xe gần hơn được ưu tiên, nhưng tránh chọn xe cực sát mép ảnh.
  const proximity = 1 / Math.max(d, 1);
  const bottomNorm = Math.min(1, bottomY/t.ch);
  const areaNorm = Math.min(1, (b.w*b.h)/(t.cw*t.ch)*8);

  return p.score*3 + proximity*12 + bottomNorm*1.2 + areaNorm*0.6 - centerPenalty*1.5 + (inLane ? 1.2 : 0);
}

function updateLeadTracking(primary, now) {
  if (!primary) {
    if (leadTrack && now - leadTrack.lastSeen < 700) return leadTrack;
    leadTrack = null;
    return null;
  }

  const cx = primary.b.x + primary.b.w/2;
  const by = primary.b.y + primary.b.h;
  const d = primary.d;

  if (!leadTrack) {
    leadTrack = { cx, by, dRaw:d, dSmooth:d, lastSeen:now, stale:false };
    return leadTrack;
  }

  const diag = Math.hypot(canvas.clientWidth, canvas.clientHeight);
  const jump = Math.hypot(cx-leadTrack.cx, by-leadTrack.by) / Math.max(1,diag);
  const distanceJump = Math.abs(d-leadTrack.dSmooth) / Math.max(1, leadTrack.dSmooth);

  // Nếu candidate nhảy quá xa, đừng đổi lead ngay lập tức.
  if (jump > 0.22 && distanceJump > 0.45 && now - leadTrack.lastSeen < 450) {
    leadTrack.stale = true;
    return leadTrack;
  }

  const a = cfg.smoothingAlpha;
  leadTrack = {
    cx, by,
    dRaw:d,
    dSmooth: leadTrack.dSmooth*(1-a) + d*a,
    lastSeen:now,
    stale:false
  };
  return leadTrack;
}

function drawGuides() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const yh = horizonY(h), yr = h*cfg.refPct/100;

  ctx.save();

  // road corridor fill
  const bottom = laneBoundsAtY(h,w,h);
  ctx.beginPath();
  ctx.moveTo(w/2, yh);
  ctx.lineTo(bottom.right, h);
  ctx.lineTo(bottom.left, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(20,240,120,.07)';
  ctx.fill();

  // lane guides
  ctx.strokeStyle = 'rgba(20,240,120,.80)';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(w/2, yh);
  ctx.lineTo(bottom.left, h);
  ctx.moveTo(w/2, yh);
  ctx.lineTo(bottom.right, h);
  ctx.stroke();

  // horizon
  ctx.strokeStyle = 'rgba(255,70,70,.95)';
  ctx.lineWidth = 2;
  ctx.setLineDash([12,8]);
  ctx.beginPath();
  ctx.moveTo(0,yh); ctx.lineTo(w,yh); ctx.stroke();

  // reference
  ctx.strokeStyle = 'rgba(255,210,30,.95)';
  ctx.setLineDash([10,8]);
  ctx.beginPath();
  ctx.moveTo(0,yr); ctx.lineTo(w,yr); ctx.stroke();

  ctx.restore();
}

function drawPredictions(predictions) {
  resizeCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0,0,w,h);
  drawGuides();

  const t = coverTransform();
  const accepted = [];

  for (const p of predictions || []) {
    if (!VEHICLES.has(p.class) || p.score < cfg.scoreThreshold) continue;
    const b = imageToScreenBox(p.bbox,t);

    // Clip candidates that are mostly offscreen
    if (b.x+b.w < 0 || b.x > t.cw || b.y+b.h < 0 || b.y > t.ch) continue;

    const bottomY = Math.min(t.ch, b.y+b.h);
    const d = distanceFromScreenY(bottomY,t.ch);
    if (!d) continue;

    accepted.push({p,b,d});
  }

  for (const item of accepted) item.rank = leadScore(item,t);
  accepted.sort((a,b)=>b.rank-a.rank);
  const primary = accepted.length && accepted[0].rank > -900 ? accepted[0] : null;
  const track = updateLeadTracking(primary, performance.now());

  if (track) {
    distanceMain.textContent = track.dSmooth.toFixed(track.dSmooth < 10 ? 1 : 0);
    leadState.textContent = track.stale ? 'ĐANG GIỮ XE DẪN' : 'XE DẪN TRONG LÀN';
  } else {
    distanceMain.textContent = '--.-';
    leadState.textContent = 'CHƯA CÓ XE DẪN';
  }

  for (const item of accepted) {
    const {p,b,d} = item;
    const isPrimary = primary === item;
    const bottomY = b.y+b.h;
    const cx = b.x+b.w/2;
    const lane = laneBoundsAtY(bottomY,t.cw,t.ch);
    const inLane = cx >= lane.left && cx <= lane.right;

    ctx.save();
    ctx.lineWidth = isPrimary ? 4 : 2;
    ctx.strokeStyle = isPrimary ? 'rgba(20,255,120,.98)' : (inLane ? 'rgba(80,190,255,.92)' : 'rgba(170,170,170,.65)');
    ctx.strokeRect(b.x,b.y,b.w,b.h);

    ctx.fillStyle = 'rgba(255,210,30,.98)';
    ctx.beginPath(); ctx.arc(cx,bottomY,isPrimary?6:4,0,Math.PI*2); ctx.fill();

    const tag = isPrimary ? 'LEAD' : (inLane ? 'LANE' : 'SIDE');
    const label = `${tag} • ${p.class} ${(p.score*100).toFixed(0)}% • ${d.toFixed(d<10?1:0)} m`;
    ctx.font = `${isPrimary?'700 17px':'600 13px'} -apple-system,sans-serif`;
    const tw = ctx.measureText(label).width;
    const tx = Math.max(4,Math.min(b.x,t.cw-tw-12));
    const ty = Math.max(24,b.y-8);
    ctx.fillStyle = 'rgba(0,0,0,.70)';
    ctx.fillRect(tx-4,ty-19,tw+8,23);
    ctx.fillStyle = '#fff';
    ctx.fillText(label,tx,ty-2);
    ctx.restore();
  }
}

async function initModel() {
  if (model) return;
  statusEl.textContent = 'Đang tải AI…';
  try {
    await tf.ready();

    // Safari/iPhone thường ổn định với WebGL. Nếu backend lỗi thì tfjs tự fallback.
    try {
      if (tf.getBackend() !== 'webgl') await tf.setBackend('webgl');
      await tf.ready();
    } catch {}

    model = await cocoSsd.load({base:'lite_mobilenet_v2'});
    statusEl.textContent = 'AI sẵn sàng';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Không tải được AI';
    alert('Không tải được mô hình AI. Kiểm tra Internet rồi tải lại trang.');
    throw err;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Safari cần trang HTTPS để dùng camera.');
    return;
  }

  stopCamera(false);
  statusEl.textContent = 'Đang mở camera…';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{
        facingMode:{ideal:'environment'},
        width:{ideal:1280},
        height:{ideal:720},
        frameRate:{ideal:30,max:30}
      }
    });

    video.srcObject = stream;

    await new Promise(resolve => {
      if (video.readyState >= 1) return resolve();
      video.onloadedmetadata = () => resolve();
    });

    await video.play();
    resizeCanvas();
    await initModel();

    running = true;
    startBtn.textContent = 'DỪNG';
    statusEl.textContent = 'Đang nhận diện';
    lastAI = 0;
    if (!drawRAF) drawRAF = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Lỗi camera';
    alert('Không mở được camera. Hãy cấp quyền Camera cho Safari và mở trang qua HTTPS.');
  }
}

function stopCamera(updateUI=true) {
  running = false;
  aiBusy = false;
  if (stream) stream.getTracks().forEach(t=>t.stop());
  stream = null;
  video.srcObject = null;
  leadTrack = null;
  lastPredictions = [];
  if (updateUI) {
    startBtn.textContent = 'BẬT CAMERA';
    statusEl.textContent = 'Đã dừng';
    distanceMain.textContent = '--.-';
    leadState.textContent = 'CHƯA CÓ XE DẪN';
  }
  resizeCanvas();
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  drawGuides();
}

startBtn.addEventListener('click', ()=> running ? stopCamera(true) : startCamera());

async function loop(ts) {
  drawRAF = null;
  if (!running) return;

  // Camera 30fps, inference mục tiêu khoảng 8–10fps để A13 đỡ nóng.
  if (!aiBusy && model && video.readyState >= 2 && ts-lastAI >= 110) {
    aiBusy = true;
    const started = performance.now();
    try {
      const preds = await model.detect(video, 16);
      lastPredictions = preds;
      drawPredictions(preds);

      const elapsed = performance.now()-started;
      const instant = 1000/Math.max(elapsed,1);
      fpsSmooth = fpsSmooth ? fpsSmooth*0.75 + instant*0.25 : instant;
      fpsEl.textContent = `AI ${fpsSmooth.toFixed(1)} FPS`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'AI lỗi 1 frame';
    } finally {
      lastAI = ts;
      aiBusy = false;
    }
  }

  if (running) drawRAF = requestAnimationFrame(loop);
}

syncControls();
resizeCanvas();
drawGuides();

if ('serviceWorker' in navigator) {
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  });
}
