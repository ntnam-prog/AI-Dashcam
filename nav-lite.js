'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  const mapBtn=$('mapBtn'), panel=$('navLitePanel'), closeBtn=$('navLiteCloseBtn');
  const destination=$('navDestination'), navHudBtn=$('navHudBtn');
  const picker=$('routePicker'), choices=$('routeChoices'), routeStart=$('routeStartBtn'), statusEl=$('navLiteStatus');
  const navBanner=$('navBanner'), navArrow=$('navArrow'), navDistance=$('navDistance'), navInstruction=$('navInstruction'), navNext=$('navNext');
  const coords=$('gpsCoords'), settingsBottom=$('settingsBtnBottom'), settingsTop=$('settingsBtn');
  const ROUTE_STORE='aidascam_nav_route_v2';
  let currentPos=null, navRoute=null, navStepIndex=0, navWatch=null;
  let routeResult=null, selectedRoute=0, destinationPoint=null;
  let lastNavSpeakKey='', lastAdasSpeakAt=0, lastAdasBucket=null;

  settingsBottom?.addEventListener('click',()=>settingsTop?.click());
  setInterval(()=>{const d=new Date(),c=$('clock');if(c)c.textContent=d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});},1000);

  function setStatus(t){if(statusEl)statusEl.textContent=t;}
  function showPanel(){panel?.classList.remove('hidden');panel?.setAttribute('aria-hidden','false');document.activeElement?.blur?.();}
  function hidePanel(){panel?.classList.add('hidden');panel?.setAttribute('aria-hidden','true');}
  mapBtn?.addEventListener('click',showPanel); closeBtn?.addEventListener('click',hidePanel);

  function hav(a,b){const R=6371000,p=Math.PI/180,dlat=(b.lat-a.lat)*p,dlon=(b.lng-a.lng)*p;const s=Math.sin(dlat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(s));}
  function maneuverIcon(m=''){m=String(m).toLowerCase();if(m.includes('left'))return '↰';if(m.includes('right'))return '↱';if(m.includes('uturn')||m.includes('u-turn'))return '↶';if(m.includes('merge'))return '↗';if(m.includes('roundabout')||m.includes('rotary'))return '↻';return '↑';}
  function fmtM(m){if(!Number.isFinite(m))return '-- m';return m>=1000?`${(m/1000).toFixed(m>=10000?0:1)} km`:`${Math.max(0,Math.round(m/10)*10)} m`;}
  function fmtDuration(sec){if(!Number.isFinite(sec))return '';const min=Math.max(1,Math.round(sec/60));if(min<60)return `${min} phút`;return `${Math.floor(min/60)} giờ ${min%60?`${min%60} phút`:''}`.trim();}
  function say(text,priority=1){if(!text||!('speechSynthesis'in window))return;const u=new SpeechSynthesisUtterance(text);u.lang='vi-VN';u.rate=1.02;if(priority>=3)window.speechSynthesis.cancel();window.speechSynthesis.speak(u);}
  function navSpeak(step,dist){for(const m of [300,100,30]){if(dist<=m+12&&dist>=m-35){const k=`${navStepIndex}:${m}`;if(k!==lastNavSpeakKey){lastNavSpeakKey=k;say(`${m===30?'Chuẩn bị. ':''}${step.instructions}`,2);}break;}}}
  function adasVoiceTick(){const el=$('distanceMain');if(!el)return;const d=parseFloat(el.textContent);if(!Number.isFinite(d))return;const now=Date.now();let b=null;if(d<=10)b=10;else if(d<=15)b=15;else if(d<=20)b=20;else if(d<=30)b=30;else if(d<=50)b=50;if(b===null)return;if(b!==lastAdasBucket||now-lastAdasSpeakAt>18000){lastAdasBucket=b;lastAdasSpeakAt=now;say(`Khoảng cách xe phía trước ${Math.round(d)} mét`,b<=15?3:1);}}
  setInterval(adasVoiceTick,1200);

  function updateNav(p){
    if(!navRoute?.steps?.length||!p)return;
    let step=navRoute.steps[Math.min(navStepIndex,navRoute.steps.length-1)];
    let dist=hav(p,step.end);
    if(dist<24&&navStepIndex<navRoute.steps.length-1){navStepIndex++;lastNavSpeakKey='';step=navRoute.steps[navStepIndex];dist=hav(p,step.end);}
    navBanner?.classList.remove('hidden');
    if(navArrow)navArrow.textContent=maneuverIcon(step.maneuver);
    if(navDistance)navDistance.textContent=fmtM(dist);
    if(navInstruction)navInstruction.textContent=step.instructions||'Đi thẳng';
    const nxt=navRoute.steps[navStepIndex+1];
    if(navNext)navNext.textContent=nxt?`Sau đó ${maneuverIcon(nxt.maneuver)} ${nxt.instructions}`:'';
    navSpeak(step,dist);
  }

  function gpsErrorMessage(err){
    if(err?.code===1)return 'Chưa được phép dùng vị trí • bật Location cho Safari/AI-Dashcam rồi thử lại';
    if(err?.code===2)return 'Chưa lấy được vị trí GPS';
    if(err?.code===3)return 'GPS phản hồi quá lâu • thử lại';
    return 'Không lấy được vị trí hiện tại';
  }
  function startNavWatch(){
    if(navWatch!==null||!navigator.geolocation)return;
    navWatch=navigator.geolocation.watchPosition(pos=>{
      currentPos={lat:pos.coords.latitude,lng:pos.coords.longitude};
      if(coords)coords.textContent=`${currentPos.lat.toFixed(5)}, ${currentPos.lng.toFixed(5)}`;
      updateNav(currentPos);
    },err=>{if(!currentPos&&coords)coords.textContent='Đang chờ vị trí'; if(err?.code===1)setStatus(gpsErrorMessage(err));},{enableHighAccuracy:true,maximumAge:1000,timeout:10000});
  }
  startNavWatch();
  function ensurePos(){return new Promise((resolve,reject)=>{if(currentPos)return resolve(currentPos);if(!navigator.geolocation)return reject(new Error('Thiết bị không có GPS'));navigator.geolocation.getCurrentPosition(p=>{currentPos={lat:p.coords.latitude,lng:p.coords.longitude};resolve(currentPos);},e=>reject(new Error(gpsErrorMessage(e))),{enableHighAccuracy:true,timeout:12000,maximumAge:1000});});}

  async function fetchJson(url,timeout=12000){
    const ctl=new AbortController(),tid=setTimeout(()=>ctl.abort(),timeout);
    try{const r=await fetch(url,{signal:ctl.signal,headers:{'Accept':'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}
    finally{clearTimeout(tid);}
  }

  async function geocodeDestination(text,origin){
    const q=encodeURIComponent(`${text}, Việt Nam`);
    // Photon is lightweight and keyless. Bias results toward current GPS when available.
    const bias=origin?`&lat=${origin.lat}&lon=${origin.lng}`:'';
    try{
      const data=await fetchJson(`https://photon.komoot.io/api/?q=${q}&limit=5&lang=vi${bias}`);
      const f=data?.features?.[0];
      if(f?.geometry?.coordinates?.length>=2){
        const [lng,lat]=f.geometry.coordinates;
        const p=f.properties||{};
        return {lat,lng,label:[p.name,p.street,p.city,p.state].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(', ')||text};
      }
    }catch{}
    // Fallback geocoder, also no API key.
    const data=await fetchJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=vn&accept-language=vi&q=${q}`);
    const f=data?.[0];
    if(f)return {lat:Number(f.lat),lng:Number(f.lon),label:f.display_name||text};
    throw new Error('Không tìm được điểm đến');
  }

  function viInstruction(step){
    const man=step?.maneuver||{},type=String(man.type||'').toLowerCase(),mod=String(man.modifier||'').toLowerCase();
    const road=(step?.name||'').trim();
    const onto=road?` vào ${road}`:'';
    if(type==='depart')return road?`Đi theo ${road}`:'Bắt đầu đi thẳng';
    if(type==='arrive')return 'Đã đến điểm đến';
    if(type.includes('roundabout')||type==='rotary')return road?`Vào vòng xuyến, ra theo ${road}`:'Đi vào vòng xuyến';
    if(type==='merge')return `Nhập làn${onto}`;
    if(type==='fork'){
      if(mod.includes('left'))return `Đi nhánh trái${onto}`;
      if(mod.includes('right'))return `Đi nhánh phải${onto}`;
    }
    if(type==='on ramp'||type==='off ramp'){
      if(mod.includes('left'))return `Theo lối bên trái${onto}`;
      if(mod.includes('right'))return `Theo lối bên phải${onto}`;
    }
    if(mod.includes('uturn'))return `Quay đầu${onto}`;
    if(mod.includes('slight left'))return `Chếch trái${onto}`;
    if(mod.includes('sharp left'))return `Rẽ gấp trái${onto}`;
    if(mod.includes('left'))return `Rẽ trái${onto}`;
    if(mod.includes('slight right'))return `Chếch phải${onto}`;
    if(mod.includes('sharp right'))return `Rẽ gấp phải${onto}`;
    if(mod.includes('right'))return `Rẽ phải${onto}`;
    if(type==='continue'||type==='new name'||type==='notification')return road?`Tiếp tục theo ${road}`:'Tiếp tục đi thẳng';
    return road?`Đi thẳng theo ${road}`:'Đi thẳng';
  }
  function maneuverCode(step){
    const man=step?.maneuver||{},type=String(man.type||'').toLowerCase(),mod=String(man.modifier||'').toLowerCase();
    if(type.includes('roundabout')||type==='rotary')return 'roundabout';
    if(type==='merge')return mod.includes('left')?'merge-left':'merge-right';
    if(mod.includes('uturn'))return 'uturn';
    if(mod.includes('left'))return 'left';
    if(mod.includes('right'))return 'right';
    return 'straight';
  }

  async function computeRoutes(){
    const q=(destination?.value||'').trim();
    if(!q){setStatus('Nhập điểm đến trước');destination?.focus();return;}
    setStatus('Đang lấy GPS…');
    try{
      const origin=await ensurePos();
      setStatus('Đang tìm điểm đến…');
      destinationPoint=await geocodeDestination(q,origin);
      setStatus('Đang tính tuyến…');
      const url=`https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destinationPoint.lng},${destinationPoint.lat}?alternatives=true&steps=true&overview=false&geometries=geojson`;
      const data=await fetchJson(url,15000);
      if(data?.code!=='Ok'||!data?.routes?.length)throw new Error('Không tính được tuyến');
      routeResult=data.routes.slice(0,3);selectedRoute=0;renderRouteChoices();
      setStatus(`Có ${routeResult.length} tuyến • chọn tuyến rồi BẮT ĐẦU`);
    }catch(e){setStatus(e?.message||'Không lấy được tuyến');}
  }
  navHudBtn?.addEventListener('click',computeRoutes);
  destination?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();destination.blur();computeRoutes();}});

  function renderRouteChoices(){
    choices.innerHTML='';
    (routeResult||[]).forEach((r,i)=>{
      const b=document.createElement('button');b.className='route-choice'+(i===selectedRoute?' active':'');
      const label=i===0?'Tuyến đề xuất':`Tuyến ${i+1}`;
      b.innerHTML=`<b>${label} · ${fmtDuration(r.duration)}</b><span>${fmtM(r.distance)}</span>`;
      b.onclick=()=>{selectedRoute=i;renderRouteChoices();routeStart.disabled=false;};choices.appendChild(b);
    });
    picker.classList.remove('hidden');routeStart.disabled=false;
  }

  function serializeSelectedRoute(){
    const r=routeResult?.[selectedRoute];if(!r)return null;
    const raw=[];for(const leg of r.legs||[])for(const s of leg.steps||[])raw.push(s);
    const steps=raw.map((s,i)=>{
      const loc=s?.maneuver?.location||[];
      const next=raw[i+1]?.maneuver?.location||null;
      const endLoc=next||[destinationPoint.lng,destinationPoint.lat];
      return {
        instructions:viInstruction(s),maneuver:maneuverCode(s),distanceMeters:s.distance||0,
        start:{lat:Number(loc[1]),lng:Number(loc[0])},end:{lat:Number(endLoc[1]),lng:Number(endLoc[0])}
      };
    }).filter(s=>Number.isFinite(s.end.lat)&&Number.isFinite(s.end.lng));
    return {createdAt:Date.now(),summary:destinationPoint?.label||'',steps};
  }
  routeStart?.addEventListener('click',()=>{
    const r=serializeSelectedRoute();if(!r?.steps?.length)return;
    navRoute=r;navStepIndex=0;localStorage.setItem(ROUTE_STORE,JSON.stringify(r));hidePanel();
    navBanner?.classList.remove('hidden');if(currentPos)updateNav(currentPos);say('Bắt đầu điều hướng',1);
  });

  try{const saved=JSON.parse(localStorage.getItem(ROUTE_STORE)||'null');if(saved?.steps?.length){navRoute=saved;navStepIndex=0;setStatus('Đã nạp tuyến trước');if(currentPos)updateNav(currentPos);}}catch{}
})();
