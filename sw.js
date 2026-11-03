/* Caderno da Fazenda: guarda o app no aparelho para abrir sem internet.
   Página e cotações: tenta a rede primeiro (pega sempre a versão nova) e cai no guardado.
   Bibliotecas e fontes: usa o guardado e atualiza por trás. Chamadas ao Supabase passam direto. */
const CACHE='caderno-v1';
const BASE=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js'];
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>Promise.all(BASE.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting())); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
const redePrimeiro=async req=>{ const c=await caches.open(CACHE);
  try{ const r=await fetch(req); if(r.ok) c.put(req,r.clone()); return r; }
  catch(e){ return (await c.match(req,{ignoreSearch:true}))||(req.mode==='navigate'?await c.match('./index.html'):Response.error()); } };
const guardadoPrimeiro=async req=>{ const c=await caches.open(CACHE), g=await c.match(req);
  const novo=fetch(req).then(r=>{ if(r.ok||r.type==='opaque') c.put(req,r.clone()); return r; }).catch(()=>g);
  return g||novo; };
self.addEventListener('fetch',e=>{ const req=e.request; if(req.method!=='GET') return; const u=new URL(req.url);
  if(u.hostname.endsWith('supabase.co')) return;
  if(u.origin===self.location.origin||u.hostname==='raw.githubusercontent.com') return e.respondWith(redePrimeiro(req));
  if(/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) return e.respondWith(guardadoPrimeiro(req)); });
