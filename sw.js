const CACHE='distanceadas-v1.1-beta.6r3-farwatch-yoloseg';
const ASSETS=['./','./index.html','./style.css?v=116r3','./app.js?v=116r3','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return; e.respondWith(fetch(e.request).then(r=>{const copy=r.clone(); if(new URL(e.request.url).origin===location.origin)caches.open(CACHE).then(c=>c.put(e.request,copy)); return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));});
