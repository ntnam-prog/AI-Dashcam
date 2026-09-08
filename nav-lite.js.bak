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

  async function fetchJson(url,timeout=12000,label='dịch vụ'){
    let lastErr=null;
    for(let attempt=0;attempt<2;attempt++){
      const ctl=new AbortController(),tid=setTimeout(()=>ctl.abort(),timeout);
      try{
        const r=await fetch(url,{signal:ctl.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(!r.ok)throw new Error(`${label}: HTTP ${r.status}`);
        return await r.json();
      }catch(e){
        lastErr=e;
        if(attempt===0)await new Promise(res=>setTimeout(res,350));
      }finally{clearTimeout(tid);}
    }
    if(lastErr?.name==='AbortError')throw new Error(`${label} phản hồi quá lâu`);
    throw new Error(`${label} tạm thời không kết nối được`);
  }

  function jsonp(url,timeout=12000){
    return new Promise((resolve,reject)=>{
      const cb='__adasJsonp_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      const sep=url.includes('?')?'&':'?';
      const script=document.createElement('script');
      let done=false;
      const finish=(err,data)=>{if(done)return;done=true;clearTimeout(tid);try{delete window[cb]}catch{};script.remove();err?reject(err):resolve(data)};
      window[cb]=data=>finish(null,data);
      script.onerror=()=>finish(new Error('JSONP không phản hồi'));
      script.src=url+sep+'json_callback='+encodeURIComponent(cb);
      document.head.appendChild(script);
      const tid=setTimeout(()=>finish(new Error('JSONP phản hồi quá lâu')),timeout);
    });
  }

  function queryVariants(text){
    const raw=String(text||'').trim();
    const clean=raw.replace(/^(ubnd|uỷ ban nhân dân|ủy ban nhân dân)\s+/i,'').trim();
    const out=[raw,clean];
    if(clean && !/\b(phường|xã|thị trấn|quận|huyện|thành phố|tp\.?)\b/i.test(clean)) out.push(`phường ${clean}`);
    for(const q of [...out]) if(q && !/việt nam/i.test(q)) out.push(`${q}, Việt Nam`);
    return [...new Set(out.filter(Boolean))];
  }

  async function geocodeDestination(text,origin){
    const raw=String(text||'').trim();
    const queries=queryVariants(raw);
    // Photon first. Do not force the GPS bias on the first query because the
    // destination may be in another province/city.
    for(const query of queries){
      const q=encodeURIComponent(query);
      const urls=[
        `https://photon.komoot.io/api/?q=${q}&limit=6&lang=vi`,
        origin?`https://photon.komoot.io/api/?q=${q}&limit=6&lang=vi&lat=${origin.lat}&lon=${origin.lng}`:null
      ].filter(Boolean);
      for(const url of urls){
        try{
          const data=await fetchJson(url,10000,'Tìm địa điểm');
          const fs=data?.features||[];
          const f=fs.find(x=>x?.geometry?.coordinates?.length>=2);
          if(f){
            const [lng,lat]=f.geometry.coordinates;
            const p=f.properties||{};
            return {lat,lng,label:[p.name,p.street,p.city,p.county,p.state].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(', ')||raw};
          }
        }catch{}
      }
    }
    // Nominatim fallback. First normal fetch, then JSONP so Safari can still
    // geocode when a cross-origin fetch is blocked by WebKit/network policy.
    for(const query of queries){
      const q=encodeURIComponent(query);
      const base=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=vn&accept-language=vi&addressdetails=1&q=${q}`;
      try{
        const data=await fetchJson(base,11000,'Tìm địa điểm dự phòng');
        const f=data?.[0];
        if(f)return {lat:Number(f.lat),lng:Number(f.lon),label:f.display_name||raw};
      }catch{}
      try{
        const data=await jsonp(base,12000);
        const f=data?.[0];
        if(f)return {lat:Number(f.lat),lng:Number(f.lon),label:f.display_name||raw};
      }catch{}
    }
    throw new Error('Không tìm được điểm đến • thử ghi rõ phường/quận hoặc tỉnh, thành phố');
  }

  async function fetchOsrmRoutes(origin,dest){
    const coords=`${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const qs='?alternatives=true&steps=true&overview=false&geometries=geojson';
    const providers=[
      ['OSRM',`https://router.project-osrm.org/route/v1/driving/${coords}${qs}`],
      ['OSM Routing',`https://routing.openstreetmap.de/routed-car/route/v1/driving/${coords}${qs}`]
    ];
    let last='';
    for(const [name,url] of providers){
      try{
        const data=await fetchJson(url,15000,name);
        if(data?.code==='Ok'&&data?.routes?.length)return data.routes.slice(0,3);
        last=data?.message||data?.code||'';
      }catch(e){last=e?.message||String(e);}
    }
    // Third provider: Valhalla public demo, requested in OSRM-compatible output.
    // This preserves the rest of NAV-LITE's parser and keeps the ADAS core isolated.
    try{
      const req={locations:[{lat:origin.lat,lon:origin.lng},{lat:dest.lat,lon:dest.lng}],costing:'auto',directions_options:{units:'kilometers',language:'vi-VN'},format:'osrm'};
      const url='https://valhalla1.openstreetmap.de/route?json='+encodeURIComponent(JSON.stringify(req));
      const data=await fetchJson(url,18000,'Valhalla');
      if(data?.code==='Ok'&&data?.routes?.length)return data.routes.slice(0,3);
      last=data?.message||data?.code||last;
    }catch(e){last=e?.message||String(e);}
    throw new Error(last?`Không lấy được tuyến • ${last}`:'Không lấy được tuyến lúc này');
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
      routeResult=await fetchOsrmRoutes(origin,destinationPoint);selectedRoute=0;renderRouteChoices();
      setStatus(`Có ${routeResult.length} tuyến • chọn tuyến rồi BẮT ĐẦU`);
    }catch(e){const m=String(e?.message||'');setStatus((!m||m==='Load failed'||m.includes('Failed to fetch'))?'Nguồn tuyến tạm thời không phản hồi • bấm LẤY TUYẾN để thử lại':m);}
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
