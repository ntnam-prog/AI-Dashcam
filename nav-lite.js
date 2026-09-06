'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  const mapBtn=$('mapBtn'), panel=$('navLitePanel'), closeBtn=$('navLiteCloseBtn');
  const destination=$('navDestination'), openMapsBtn=$('openGoogleMapsBtn'), navHudBtn=$('navHudBtn');
  const setup=$('navLiteSetup'), keyInput=$('gmapKeyInput'), keySave=$('gmapKeySaveBtn');
  const picker=$('routePicker'), choices=$('routeChoices'), routeStart=$('routeStartBtn'), statusEl=$('navLiteStatus');
  const navBanner=$('navBanner'), navArrow=$('navArrow'), navDistance=$('navDistance'), navInstruction=$('navInstruction'), navNext=$('navNext');
  const coords=$('gpsCoords'), settingsBottom=$('settingsBtnBottom'), settingsTop=$('settingsBtn');
  const KEY_STORE='aidascam_gmaps_key_v1', ROUTE_STORE='aidascam_nav_route_v1';
  let currentPos=null, navRoute=null, navStepIndex=0, navWatch=null;
  let routeResult=null, selectedRoute=0, directionsService=null, geocoder=null;
  let lastNavSpeakKey='', lastAdasSpeakAt=0, lastAdasBucket=null, mapsPromise=null;

  settingsBottom?.addEventListener('click',()=>settingsTop?.click());
  setInterval(()=>{const d=new Date(),c=$('clock');if(c)c.textContent=d.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'});},1000);

  function setStatus(t){if(statusEl)statusEl.textContent=t;}
  function showPanel(){panel?.classList.remove('hidden');panel?.setAttribute('aria-hidden','false');destination?.focus();}
  function hidePanel(){panel?.classList.add('hidden');panel?.setAttribute('aria-hidden','true');}
  mapBtn?.addEventListener('click',showPanel); closeBtn?.addEventListener('click',hidePanel);

  function openGoogleMaps(){
    const q=(destination?.value||'').trim();
    // Universal Google Maps URL: opens app when iOS can hand it off, otherwise web.
    const u=q?`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`:'https://www.google.com/maps/';
    window.location.href=u;
  }
  openMapsBtn?.addEventListener('click',openGoogleMaps);

  function hav(a,b){const R=6371000,p=Math.PI/180,dlat=(b.lat-a.lat)*p,dlon=(b.lng-a.lng)*p;const s=Math.sin(dlat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(s));}
  function stripHtml(s=''){const d=document.createElement('div');d.innerHTML=s;return (d.textContent||'').replace(/\s+/g,' ').trim();}
  function maneuverIcon(m=''){m=String(m).toLowerCase();if(m.includes('left'))return '↰';if(m.includes('right'))return '↱';if(m.includes('uturn'))return '↶';if(m.includes('merge'))return '↗';if(m.includes('roundabout'))return '↻';return '↑';}
  function fmtM(m){if(!Number.isFinite(m))return '-- m';return m>=1000?`${(m/1000).toFixed(m>=10000?0:1)} km`:`${Math.max(0,Math.round(m/10)*10)} m`;}
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
  function startNavWatch(){if(navWatch!==null||!navigator.geolocation)return;navWatch=navigator.geolocation.watchPosition(pos=>{currentPos={lat:pos.coords.latitude,lng:pos.coords.longitude};if(coords)coords.textContent=`${currentPos.lat.toFixed(5)}, ${currentPos.lng.toFixed(5)}`;updateNav(currentPos);},()=>{}, {enableHighAccuracy:true,maximumAge:1000,timeout:10000});}
  startNavWatch();
  function ensurePos(){return new Promise((resolve,reject)=>{if(currentPos)return resolve(currentPos);if(!navigator.geolocation)return reject(new Error('Thiết bị không có GPS'));navigator.geolocation.getCurrentPosition(p=>{currentPos={lat:p.coords.latitude,lng:p.coords.longitude};resolve(currentPos);},reject,{enableHighAccuracy:true,timeout:10000,maximumAge:1000});});}

  function loadMapsLite(){
    if(window.google?.maps){directionsService??=new google.maps.DirectionsService();geocoder??=new google.maps.Geocoder();return Promise.resolve(true);}
    if(mapsPromise)return mapsPromise;
    const key=localStorage.getItem(KEY_STORE)||'';
    if(!key){setup?.classList.remove('hidden');keyInput.value='';return Promise.resolve(false);}
    mapsPromise=new Promise((resolve,reject)=>{
      const cb='__aidascamNavLiteReady';
      window.gm_authFailure=()=>{setStatus('Google Maps API key/billing chưa hợp lệ');setup?.classList.remove('hidden');};
      window[cb]=()=>{delete window[cb];directionsService=new google.maps.DirectionsService();geocoder=new google.maps.Geocoder();resolve(true);};
      const s=document.createElement('script');
      // No map tiles, no Places library: only lightweight routing/geocoding services.
      s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=vi&region=VN&callback=${cb}`;
      s.async=true;s.defer=true;s.onerror=()=>{mapsPromise=null;setStatus('Không nạp được dịch vụ tuyến Google');reject(new Error('Không nạp được Google Maps routing'));};
      document.head.appendChild(s);
    });
    return mapsPromise;
  }

  keySave?.addEventListener('click',()=>{const k=keyInput.value.trim();if(!k){setStatus('Chưa nhập API key');return;}localStorage.setItem(KEY_STORE,k);setup.classList.add('hidden');mapsPromise=null;setStatus('Đã lưu key • bấm LẤY TUYẾN CHO HUD');});

  async function geocodeText(text){return new Promise((resolve,reject)=>geocoder.geocode({address:text,region:'VN'},(res,status)=>status==='OK'&&res?.[0]?resolve(res[0].geometry.location):reject(new Error(`Không tìm được điểm đến: ${status}`))));}
  async function computeRoutes(){
    const q=(destination?.value||'').trim(); if(!q){setStatus('Nhập điểm đến trước');return;}
    setStatus('Đang lấy tuyến…');
    const ok=await loadMapsLite().catch(e=>{setStatus(e.message);return false;}); if(!ok)return;
    try{
      const origin=await ensurePos(); const dest=await geocodeText(q);
      directionsService.route({origin,destination:dest,travelMode:google.maps.TravelMode.DRIVING,provideRouteAlternatives:true,drivingOptions:{departureTime:new Date(),trafficModel:'bestguess'}},(result,status)=>{
        if(status!==google.maps.DirectionsStatus.OK||!result?.routes?.length){setStatus(`Không tính được tuyến: ${status}`);return;}
        routeResult=result;selectedRoute=0;renderRouteChoices();setStatus(`Có ${result.routes.length} tuyến • chọn rồi BẮT ĐẦU`);
      });
    }catch(e){setStatus(e.message||'Không lấy được tuyến');}
  }
  navHudBtn?.addEventListener('click',computeRoutes);

  function renderRouteChoices(){
    choices.innerHTML='';
    (routeResult?.routes||[]).forEach((r,i)=>{const leg=r.legs?.[0],b=document.createElement('button');b.className='route-choice'+(i===selectedRoute?' active':'');const dur=leg?.duration_in_traffic?.text||leg?.duration?.text||'',dist=leg?.distance?.text||'';b.innerHTML=`<b>Tuyến ${i+1} · ${dur}</b><span>${dist}${r.summary?` · ${r.summary}`:''}</span>`;b.onclick=()=>{selectedRoute=i;renderRouteChoices();routeStart.disabled=false;};choices.appendChild(b);});
    picker.classList.remove('hidden'); routeStart.disabled=false;
  }
  function serializeSelectedRoute(){const r=routeResult?.routes?.[selectedRoute];if(!r)return null;const steps=[];for(const leg of r.legs||[])for(const s of leg.steps||[])steps.push({instructions:stripHtml(s.instructions),maneuver:s.maneuver||'straight',distanceMeters:s.distance?.value||0,start:{lat:s.start_location.lat(),lng:s.start_location.lng()},end:{lat:s.end_location.lat(),lng:s.end_location.lng()}});return {createdAt:Date.now(),summary:r.summary||'',steps};}
  routeStart?.addEventListener('click',()=>{const r=serializeSelectedRoute();if(!r)return;navRoute=r;navStepIndex=0;localStorage.setItem(ROUTE_STORE,JSON.stringify(r));hidePanel();navBanner?.classList.remove('hidden');if(currentPos)updateNav(currentPos);say('Bắt đầu điều hướng',1);});

  try{const saved=JSON.parse(localStorage.getItem(ROUTE_STORE)||'null');if(saved?.steps?.length){navRoute=saved;navStepIndex=0;setStatus('Đã nạp tuyến trước');if(currentPos)updateNav(currentPos);}}catch{}
})();
