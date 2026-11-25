/* Almacén La Campiña · copia de la página para abrirla sin internet
 *
 * - Páginas, estilos y código: primero internet (siempre la versión nueva);
 *   si no hay conexión, la última copia guardada.
 * - Letras e íconos: de la copia, se actualizan en segundo plano.
 * - Fotos de productos (Supabase Storage, públicas): de la copia, hasta 200.
 * - NUNCA guarda datos de la base ni de la sesión (/rest, /auth, /rpc):
 *   esos los guarda la propia página solo en el aparato del dueño.
 */
const VERSION = "lc-v24-1";
const CASA = "casa-" + VERSION;
const FOTOS = "fotos-v1";
const MAX_FOTOS = 200;
const ESPERA_RED_MS = 4000;

const BASICOS = [
  "./", "index.html", "pedido.html", "admin.html",
  "assets/css/styles.css", "assets/css/pedido.css", "assets/css/admin.css",
  "assets/css/recibo.css", "assets/css/papel-80.css", "assets/css/papel-58.css", "assets/css/papel-carta.css",
  "assets/js/config.js", "assets/js/app.js", "assets/js/pedido.js", "assets/js/admin.js", "assets/js/xlsx-mini.js",
  "assets/vendor/supabase-2.119.2.js",
  "assets/fonts/barlow-latin-400-normal.woff2", "assets/fonts/barlow-latin-500-normal.woff2",
  "assets/fonts/barlow-latin-600-normal.woff2", "assets/fonts/barlow-latin-700-normal.woff2",
  "assets/fonts/barlow-condensed-latin-600-normal.woff2", "assets/fonts/barlow-condensed-latin-700-normal.woff2",
  "assets/fonts/barlow-condensed-latin-800-normal.woff2",
  "assets/img/marca.png", "assets/img/logo-nav.png", "assets/img/logo-pie.png",
  "assets/img/cat-ladrillos.png", "assets/img/cat-taladro.png", "assets/img/cat-tornillo.png", "assets/img/cat-rodillo.png", "assets/img/cat-planta.png",
  "assets/img/cat-bombillo.svg", "assets/img/cat-tubo.svg", "assets/img/cat-martillo.svg", "assets/img/cat-balde.svg",
  "assets/img/cat-huella.svg", "assets/img/cat-pez.svg", "assets/img/cat-carro.svg", "assets/img/cat-casco.svg",
  "assets/js/clasificar.js",
  "assets/img/icono-192.png", "assets/img/icono-512.png", "assets/img/icono-maskable-512.png", "assets/img/apple-touch-icon.png",
  "panel.webmanifest"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CASA);
    // uno por uno: si un archivo falla, los demás igual quedan guardados
    await Promise.all(BASICOS.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres.filter((n) => n.startsWith("casa-") && n !== CASA).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const esFoto = (url) => /\.supabase\.co$/.test(url.hostname) && url.pathname.includes("/storage/v1/object/public/productos/");
const estable = (url) => /\/assets\/(fonts|img|vendor)\//.test(url.pathname);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (esFoto(url)) { e.respondWith(foto(req)); return; }
  if (url.origin !== self.location.origin) return;        // la base de datos nunca pasa por aquí
  if (req.mode === "navigate") { e.respondWith(pagina(req)); return; }
  e.respondWith(estable(url) ? copiaPrimero(req, e) : redPrimero(req));
});

async function guardar(req, res) {
  if (res && res.ok && res.type === "basic") {
    const c = await caches.open(CASA);
    await c.put(req, res.clone());
  }
  return res;
}

function conTiempo(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("lento")), ms))]);
}

// con internet siempre se pregunta al servidor si hay versión nueva (sin usar la copia vieja del navegador)
const fresco = (req) => fetch(req, { cache: "no-cache" });

async function pagina(req) {
  try {
    return await guardar(req, await conTiempo(fresco(req), ESPERA_RED_MS));
  } catch {
    const c = await caches.open(CASA);
    return (await c.match(req, { ignoreSearch: true }))
      || (await c.match(new URL(req.url).pathname.endsWith("/") ? "index.html" : req, { ignoreSearch: true }))
      || (await c.match("index.html"))
      || new Response("Sin internet", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function redPrimero(req) {
  try {
    return await guardar(req, await conTiempo(fresco(req), ESPERA_RED_MS));
  } catch {
    const r = await caches.match(req, { ignoreSearch: true });
    return r || new Response("", { status: 504 });
  }
}

async function copiaPrimero(req, e) {
  const r = await caches.match(req, { ignoreSearch: true });
  const nuevo = fetch(req).then((res) => guardar(req, res)).catch(() => null);
  if (r) { e.waitUntil(nuevo); return r; }
  return (await nuevo) || new Response("", { status: 504 });
}

async function foto(req) {
  const c = await caches.open(FOTOS);
  const r = await c.match(req);
  if (r) return r;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      await c.put(req, res.clone());
      const claves = await c.keys();
      for (const k of claves.slice(0, Math.max(0, claves.length - MAX_FOTOS))) await c.delete(k);
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}
