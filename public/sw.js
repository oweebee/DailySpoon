// Service worker minimal : DailySpoon est une app entièrement dynamique
// (Prisma/DB à chaque requête), donc pas question de mettre en cache les
// pages HTML ou les appels API — ce service worker sert uniquement à rendre
// l'app installable en PWA (critère requis par les navigateurs), pas à
// fonctionner hors-ligne. Seuls le manifeste et les icônes (assets
// statiques, jamais périmés) sont mis en cache, en secours si le réseau est
// coupé au moment de charger l'écran d'accueil de l'app installée.
const CACHE_NAME = "dailyspoon-shell-v1";
const SHELL_ASSETS = [
  "/manifest.json",
  "/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Réseau d'abord toujours (contenu à jour), secours au cache uniquement
  // si la requête échoue (hors-ligne) — et seulement pour les quelques
  // assets statiques mis en cache ci-dessus.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
