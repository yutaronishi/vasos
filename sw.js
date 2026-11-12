// Service worker: deixa o app funcionar offline depois do 1º acesso.
// Ao publicar uma versão nova do app, troque o número abaixo.
const VERSAO = 'vasos-v1';
const BASE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSAO);
    await c.addAll(BASE);
    try { await c.add('./catalogo.json'); } catch (_) { /* catálogo opcional */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Apps Script (envio de registros) nunca passa pelo cache
  if (url.hostname.includes('script.google') || url.hostname.includes('googleusercontent')) return;

  if (url.origin === self.location.origin) {
    // Arquivos do app: tenta a rede (pega atualizações), cai no cache se estiver offline
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(VERSAO)).put(req, r.clone());
        return r;
      } catch (_) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html'));
      }
    })());
  } else {
    // Bibliotecas (TF.js) e pesos do modelo: cache primeiro — baixa uma vez só
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) (await caches.open(VERSAO)).put(req, r.clone());
      return r;
    })());
  }
});
