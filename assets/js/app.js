(function () {
  "use strict";
  const C = window.APP_CONFIG, db = window.db, U = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LS_CARRITO = "lc_lista_v1", LS_CLIENTE = "lc_cliente_v1", LS_CATALOGO = "lc_catalogo_v1", LS_PEND = "lc_pedidos_pend_v1";

  // Catálogo de muestra: solo se usa mientras Supabase no está configurado
  const DEMO = {
    categorias: [
      { id: 1, nombre: "Materiales de construcción" }, { id: 2, nombre: "Ferretería" }, { id: 3, nombre: "Mascotas" },
      { id: 4, nombre: "Pesca" }, { id: 5, nombre: "Cuidado del auto" }, { id: 6, nombre: "Agro y jardín" }
    ],
    productos: [
      { id: 1, nombre: "Cemento gris", descripcion: "Saco para construcción general.", unidad: "saco", categoria_id: 1, destacado: true, precio: 6500 },
      { id: 2, nombre: "Varilla corrugada", descripcion: "Acero para refuerzo de columnas y vigas.", unidad: "unidad", categoria_id: 1 },
      { id: 3, nombre: "Block de concreto", descripcion: "Para paredes, tapias y muros.", unidad: "unidad", categoria_id: 1 },
      { id: 4, nombre: "Juego de herramientas", descripcion: "Lo básico para reparaciones en la casa.", unidad: "juego", categoria_id: 2, destacado: true },
      { id: 5, nombre: "Alimento para perro", descripcion: "Alimento balanceado.", unidad: "saco", categoria_id: 3, destacado: true },
      { id: 6, nombre: "Carrete y caña", descripcion: "Equipo para pesca de río y mar.", unidad: "unidad", categoria_id: 4 },
      { id: 7, nombre: "Limpiador de focos", descripcion: "Devuelve la transparencia a los focos del carro.", unidad: "unidad", categoria_id: 5, destacado: true }
    ]
  };

  const SIN_FOTO = `<svg class="sin-foto" viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="11" width="34" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="21" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 35l10-9 7 6 5-4 9 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

  const S = {
    ajustes: {
      telefono: C.TELEFONO, whatsapp: C.WHATSAPP, telefono2: C.TELEFONO2, direccion: C.DIRECCION,
      horario: C.HORARIO, horario_semana: "", facebook: C.FACEBOOK, aviso: "", sinpe_numero: "", sinpe_titular: "",
      envio_activo: "no", envio_zonas: "", envio_nota: ""
    },
    v4: false,          // la base ya tiene las mejoras v4 (agotado, ofertas, envío, factura)
    categorias: [], productos: [],
    cat: "", q: "", rango: "", orden: "rel", vista: "cuadros",
    lista: [],          // [{k, id, nombre, unidad, precio, cant}]
    ultimo: null,       // pedido recién enviado {codigo, tel, nombre, archivo}
    fichaId: null       // producto abierto en la ficha
  };
  const LS_VISTA = "lc_vista_v1";

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const waNum = () => U.soloDigitos(S.ajustes.whatsapp) || C.WHATSAPP;
  const sinpeNum = () => { const d = U.soloDigitos(S.ajustes.sinpe_numero); return d.length === 8 ? d : ""; };

  // Fecha de hoy en Costa Rica (AAAA-MM-DD) para saber si una oferta sigue vigente
  const hoyCR = () => new Intl.DateTimeFormat("en-CA", { timeZone: C.ZONA_HORARIA || "America/Costa_Rica" }).format(new Date());
  const ofertaVigente = (p) => p.precio_oferta != null && p.precio_oferta > 0 && !!p.oferta_hasta && String(p.oferta_hasta) >= hoyCR();
  const precioDe = (p) => (ofertaVigente(p) ? Number(p.precio_oferta) : p.precio != null ? Number(p.precio) : null);
  const fechaCorta = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("es-CR", { day: "numeric", month: "short" }); };
  const zonasEnvio = () => String(S.ajustes.envio_zonas || "").split("\n")
    .map((l) => /^\s*([^=|:]{2,60}?)\s*[=|:]\s*₡?\s*([0-9][0-9 .,]{0,9})\s*$/.exec(l)).filter(Boolean)
    .map((m) => ({ nombre: m[1].trim(), precio: Number(m[2].replace(/[^0-9]/g, "")) || 0 }));
  const envioActivo = () => S.v4 && S.ajustes.envio_activo === "si" && zonasEnvio().length > 0;

  function toast(txt) {
    const t = $("#toast");
    t.textContent = txt; t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- carrito (se guarda en el aparato) ----------
  function cargarCarrito() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CARRITO) || "null");
      if (raw && Array.isArray(raw.items)) {
        S.lista = raw.items
          .filter((i) => i && typeof i.k === "string" && typeof i.nombre === "string")
          .slice(0, 60)
          .map((i) => ({
            k: i.k.slice(0, 40), id: Number.isInteger(i.id) ? i.id : null, nombre: i.nombre.slice(0, 100),
            unidad: typeof i.unidad === "string" ? i.unidad.slice(0, 30) : "",
            precio: typeof i.precio === "number" && i.precio >= 0 ? i.precio : null,
            cant: Math.min(999, Math.max(1, parseInt(i.cant, 10) || 1))
          }));
      }
    } catch { /* sin almacenamiento */ }
  }
  function guardarCarrito() { try { localStorage.setItem(LS_CARRITO, JSON.stringify({ items: S.lista })); } catch { /* */ } }
  const enLista = (id) => S.lista.find((i) => i.id === id);

  function agregar(p) {
    const it = enLista(p.id);
    if (it) it.cant = Math.min(999, it.cant + 1);
    else S.lista.push({ k: "p" + p.id, id: p.id, nombre: p.nombre, unidad: p.unidad || "", precio: precioDe(p), cant: 1 });
    cambioCarrito();
    toast(`Agregado al carrito: ${p.nombre}`);
  }
  // Pone una cantidad exacta (la usa la calculadora)
  function ponerEnCarrito(p, n) {
    const it = enLista(p.id), cant = Math.min(999, Math.max(1, n));
    if (it) it.cant = cant;
    else S.lista.push({ k: "p" + p.id, id: p.id, nombre: p.nombre, unidad: p.unidad || "", precio: precioDe(p), cant });
  }
  function libreEnCarrito(txt, n) {
    const nombre = txt.trim().replace(/\s+/g, " ").slice(0, 80);
    if (nombre.length < 2) return;
    const it = S.lista.find((i) => !i.id && i.nombre.toLowerCase() === nombre.toLowerCase());
    if (it) { it.cant = Math.min(999, Math.max(1, n)); return; }
    if (S.lista.length < 60) S.lista.push({ k: "l" + Date.now().toString(36) + S.lista.length, id: null, nombre, unidad: "", precio: null, cant: Math.min(999, Math.max(1, n)) });
  }
  function agregarLibre(txt) {
    const nombre = txt.trim().replace(/\s+/g, " ").slice(0, 80);
    if (nombre.length < 2 || S.lista.length >= 60) return false;
    S.lista.push({ k: "l" + Date.now().toString(36), id: null, nombre, unidad: "", precio: null, cant: 1 });
    cambioCarrito();
    return true;
  }
  function cambiarCant(k, delta) {
    const it = S.lista.find((i) => i.k === k);
    if (!it) return;
    it.cant += delta;
    if (it.cant < 1) S.lista = S.lista.filter((i) => i !== it);
    else it.cant = Math.min(999, it.cant);
    cambioCarrito();
  }
  function cambioCarrito() {
    // refresca precios con el catálogo actual
    S.lista.forEach((i) => { if (i.id) { const p = S.productos.find((x) => x.id === i.id); if (p) { i.precio = precioDe(p); i.agotado = !!p.agotado; } } });
    guardarCarrito();
    pintarCarrito();
    pintarControles();
    $$("[data-contador]").forEach((c) => {
      c.textContent = S.lista.length;
      c.classList.remove("salta"); void c.offsetWidth; c.classList.add("salta");
    });
  }

  // ---------- datos ----------
  async function cargarDatos() {
    if (!db) { S.categorias = DEMO.categorias; S.productos = DEMO.productos; return "demo"; }
    try {
      const BASE = "id,nombre,descripcion,precio,unidad,categoria_id,imagen_url,destacado";
      const prods = (cols) => db.from("productos").select(cols).eq("activo", true)
        .order("destacado", { ascending: false }).order("nombre");
      let [a, c, p] = await Promise.all([
        db.from("ajustes").select("clave,valor"),
        db.from("categorias").select("id,nombre,orden").order("orden"),
        prods(BASE + ",agotado,precio_oferta,oferta_hasta")
      ]);
      S.v4 = !p.error;
      if (p.error) p = await prods(BASE);     // base sin la migración v4
      if (a.error || c.error || p.error) throw a.error || c.error || p.error;
      a.data.forEach((r) => { if (r.clave in S.ajustes) S.ajustes[r.clave] = r.valor ?? ""; });
      S.categorias = c.data;
      S.productos = p.data;
      // copia para ver el catálogo sin internet (solo datos públicos)
      try { localStorage.setItem(LS_CATALOGO, JSON.stringify({ t: Date.now(), v4: S.v4, ajustes: a.data, categorias: c.data, productos: p.data })); } catch { /* sin espacio */ }
      return "ok";
    } catch (e) {
      console.warn("No se pudo cargar el catálogo:", e?.message || e);
      try {
        const k = JSON.parse(localStorage.getItem(LS_CATALOGO) || "null");
        if (k && Array.isArray(k.productos) && k.productos.length) {
          S.v4 = !!k.v4;
          (k.ajustes || []).forEach((r) => { if (r.clave in S.ajustes) S.ajustes[r.clave] = r.valor ?? ""; });
          S.categorias = k.categorias || [];
          S.productos = k.productos;
          return "copia";
        }
      } catch { /* copia dañada */ }
      return "error";
    }
  }

  // ---------- contacto / horario ----------
  function pintarContacto() {
    const a = S.ajustes, tel = U.soloDigitos(a.telefono);
    $$("[data-tel]").forEach((el) => (el.href = tel ? `tel:+506${tel.slice(-8)}` : U.waLink(waNum())));
    $$("[data-tel-num]").forEach((el) => (el.textContent = U.fmtTel(a.telefono)));
    $$("[data-wa]").forEach((el) => (el.href = U.waLink(waNum(), `¡Hola, ${C.NEGOCIO}! Quisiera hacer una consulta.`)));
    $$("[data-wa-num]").forEach((el) => (el.textContent = U.fmtTel(waNum())));
    $$("[data-dir]").forEach((el) => (el.textContent = a.direccion || C.DIRECCION));
    const tel2 = U.soloDigitos(a.telefono2);
    if (tel2.length >= 8) {
      $$("[data-tel2]").forEach((el) => (el.textContent = U.fmtTel(a.telefono2)));
      $$("[data-tel2-link]").forEach((el) => (el.href = `tel:+506${tel2.slice(-8)}`));
      $("#liTel2").hidden = false;
    } else $("#liTel2").hidden = true;
    $("#lnkFb").href = U.safeUrl(a.facebook || C.FACEBOOK);
    const sn = sinpeNum();
    const sinpeTxt = sn ? `${U.fmtTel(sn)}${a.sinpe_titular ? " a nombre de " + a.sinpe_titular : ""}` : "";
    if (sn) { $$("[data-sinpe]").forEach((el) => (el.textContent = sinpeTxt)); $("#liSinpe").hidden = false; }
    $("#sinpeInfo").textContent = sn
      ? `SINPE Móvil: ${sinpeTxt}. En el detalle del SINPE escriba su nombre.`
      : "Si necesita el número SINPE, pídalo por WhatsApp.";
    const q = encodeURIComponent(C.MAPA_QUERY);
    $("#mapa").src = `https://www.google.com/maps?q=${q}&output=embed`;
    $("#btnLlegar").href = `https://www.google.com/maps/search/?api=1&query=${q}`;
    if (a.aviso) { $("#aviso").textContent = a.aviso; $("#aviso").hidden = false; }
    pintarHorario();
  }

  function pintarHorario() {
    const h = U.parseHorario(S.ajustes.horario_semana), estado = $("#estado");
    if (!h) { $("#horarioTexto").textContent = S.ajustes.horario || C.HORARIO; estado.textContent = ""; return; }
    const { dia, min } = U.ahoraCR();
    const aMin = (t) => { const [hh, mm] = t.split(":").map(Number); return hh * 60 + mm; };
    $("#tablaHorario tbody").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((d) => {
      const tr = document.createElement("tr");
      if (d === dia) tr.className = "hoy";
      const th = document.createElement("th"); th.scope = "row"; th.textContent = U.DIAS[d];
      const td = document.createElement("td");
      td.textContent = h[d] ? `${U.hora12(h[d][0])} a ${U.hora12(h[d][1])}` : "Cerrado";
      tr.append(th, td);
      return tr;
    }));
    $("#tablaHorario").hidden = false;
    $("#horarioTexto").textContent = S.ajustes.horario && !/consulte/i.test(S.ajustes.horario) ? S.ajustes.horario : "";
    const hoy = h[dia];
    if (hoy && min >= aMin(hoy[0]) && min < aMin(hoy[1])) { estado.dataset.abierto = "si"; estado.textContent = `Abierto ahora. Cierra a las ${U.hora12(hoy[1])}.`; return; }
    estado.dataset.abierto = "no";
    if (hoy && min < aMin(hoy[0])) { estado.textContent = `Cerrado. Abre hoy a las ${U.hora12(hoy[0])}.`; return; }
    for (let i = 1; i <= 7; i++) {
      const d = (dia + i) % 7;
      if (h[d]) { estado.textContent = `Cerrado. Abre ${i === 1 ? "mañana" : "el " + U.DIAS[d].toLowerCase()} a las ${U.hora12(h[d][0])}.`; return; }
    }
    estado.textContent = "";
  }

  // ---------- catálogo ----------
  const ICONOS = {
    ladrillos: '<rect class="rel" x="23.5" y="22" width="17" height="10" rx="1"/><rect x="23.5" y="22" width="17" height="10" rx="1"/><rect x="14.5" y="32" width="17" height="10" rx="1"/><rect x="32.5" y="32" width="17" height="10" rx="1"/><rect x="6" y="42" width="17" height="10" rx="1"/><rect x="23.5" y="42" width="17" height="10" rx="1"/><rect x="41" y="42" width="17" height="10" rx="1"/>',
    taladro: '<rect class="rel" x="10" y="48" width="20" height="8" rx="2"/><rect x="10" y="48" width="20" height="8" rx="2"/><path d="M10 18h30a6 6 0 0 1 6 6v2a6 6 0 0 1-6 6H10a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4z"/><path d="M46 21h5v8h-5M51 25h8M18 32l-3 16h11l3-16M30 32v5"/>',
    tornillo: '<path class="rel" d="M24 8h16l6 8-6 8H24l-6-8z"/><path d="M24 8h16l6 8-6 8H24l-6-8z"/><path d="M27 24v30l5 5 5-5V24M27 31l10-3M27 38l10-3M27 45l10-3"/>',
    rodillo: '<rect class="rel" x="8" y="10" width="38" height="12" rx="3"/><rect x="8" y="10" width="38" height="12" rx="3"/><path d="M46 16h6v14H30v8"/><rect x="26" y="38" width="8" height="18" rx="2"/>',
    planta: '<path class="rel" d="M32 34c0-12-8-18-20-18 0 12 8 18 20 18z"/><path d="M32 34c0-12-8-18-20-18 0 12 8 18 20 18zM32 28c0-10 7-16 18-16 0 10-7 16-18 16zM32 54V26M16 54h32"/>',
    huella: '<path class="rel" d="M32 34c-7 0-13 8-13 13 0 4 3 6 6 6s4-2 7-2 4 2 7 2 6-2 6-6c0-5-6-13-13-13z"/><path d="M32 34c-7 0-13 8-13 13 0 4 3 6 6 6s4-2 7-2 4 2 7 2 6-2 6-6c0-5-6-13-13-13z"/><ellipse cx="16" cy="29" rx="4.5" ry="6"/><ellipse cx="25" cy="18" rx="4.5" ry="6"/><ellipse cx="39" cy="18" rx="4.5" ry="6"/><ellipse cx="48" cy="29" rx="4.5" ry="6"/>',
    pez: '<path class="rel" d="M46 32l12-9v18z"/><path d="M46 32l12-9v18zM6 32c8-11 26-14 40 0-14 14-32 11-40 0zM26 24c3 5 3 11 0 16"/><circle cx="16" cy="30" r="2"/>',
    carro: '<path d="M6 41v-8l6-13h40l6 13v8a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM14 33l4-9h28l4 9z"/><rect class="rel" x="9" y="35" width="7" height="4" rx="1"/><circle cx="18" cy="45" r="6" fill="#fff"/><circle cx="46" cy="45" r="6" fill="#fff"/>',
    caja: '<path class="rel" d="M8 20l24-10 24 10-24 10z"/><path d="M8 20l24-10 24 10v24L32 54 8 44zM8 20l24 10 24-10M32 30v24"/>'
  };
  function iconoCat(nombre) {
    const n = norm(nombre);
    const k = /construc|cement|block|varilla/.test(n) ? "ladrillos"
      : /electric|herramienta/.test(n) ? "taladro"
      : /ferreter|tornill/.test(n) ? "tornillo"
      : /acabad|pared|pintur/.test(n) ? "rodillo"
      : /agro|jardin|finca/.test(n) ? "planta"
      : /mascota|perro|gato/.test(n) ? "huella"
      : /pesca/.test(n) ? "pez"
      : /auto|carro|vehic|moto/.test(n) ? "carro" : "caja";
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${ICONOS[k]}</svg>`;
  }
  const FLECHA = '<svg class="ico" aria-hidden="true"><use href="#i-flecha"/></svg>';
  const cuenta = (id) => S.productos.filter((p) => p.categoria_id === id).length;
  const catsConProductos = () => S.categorias.filter((c) => cuenta(c.id) > 0);
  const catDe = (id) => S.categorias.find((c) => c.id === id) || {};
  const fotoDe = (p) => (p.imagen_url ? U.safeUrl(p.imagen_url, "") : "");

  function pintarCategorias() {
    $("#cats").innerHTML = catsConProductos().map((c) =>
      `<li><button type="button" class="cat-btn" data-cat="${U.esc(c.id)}" aria-pressed="${String(S.cat) === String(c.id)}">
        ${iconoCat(c.nombre)}<span class="cat-btn__pie"><span>${U.esc(c.nombre)}</span>${FLECHA}</span></button></li>`).join("");
    const ops = [{ id: "", nombre: "Todas", n: S.productos.length }].concat(catsConProductos().map((c) => ({ ...c, n: cuenta(c.id) })));
    $("#filtroOfertas").hidden = !S.productos.some(ofertaVigente);
    $("#filtroCat").innerHTML = ops.map((c) =>
      `<button type="button" role="radio" data-cat="${U.esc(c.id)}" aria-checked="${String(S.cat) === String(c.id)}">${U.esc(c.nombre)}<span class="n">${c.n}</span></button>`).join("");
  }

  // Dos tarjetas grandes arriba, armadas con lo que hay en el catálogo
  function pintarPromos() {
    const cats = catsConProductos();
    const elegir = (re, usadas) => cats.find((c) => !usadas.includes(c.id) && re.test(norm(c.nombre))) || cats.find((c) => !usadas.includes(c.id));
    const usadas = [];
    const ofertas = S.productos.filter(ofertaVigente).sort((a, b) => (b.precio - b.precio_oferta) / (b.precio || 1) - (a.precio - a.precio_oferta) / (a.precio || 1));
    let tarjetaOferta = "";
    if (ofertas.length) {
      const o = ofertas[0], conFoto = ofertas.find((x) => x.imagen_url);
      const fin = ofertas.map((x) => String(x.oferta_hasta)).sort()[0];
      tarjetaOferta = `<article class="promo promo--oscura">
        <div class="promo__txt">
          <h3>${ofertas.length === 1 ? "Oferta" : "Ofertas"} de la semana</h3>
          <p class="promo__sub">${U.esc(o.nombre.split(/[(,]/)[0].trim())}${ofertas.length > 1 ? ` y ${ofertas.length - 1} más` : ""}. Hasta el ${U.esc(fechaCorta(fin))}.</p>
          <p class="promo__precio">${o.precio ? `Antes ${U.esc(U.colones(o.precio))}, ahora ` : "Ahora "}<b>${U.esc(U.colones(o.precio_oferta))}</b></p>
          <button type="button" class="btn btn--sm" data-rango-promo="o">Ver ${ofertas.length === 1 ? "la oferta" : "las " + ofertas.length + " ofertas"}</button>
        </div>
        <div class="promo__foto">${conFoto ? `<img src="${U.esc(fotoDe(conFoto))}" alt="" />` : ""}</div>
      </article>`;
    }
    const regexs = ofertas.length ? [/construc/] : [/construc/, /herramienta|electric/];
    const html = tarjetaOferta + regexs.map((re, j) => {
      const i = ofertas.length ? 1 : j;
      const c = elegir(re, usadas);
      if (!c) return "";
      usadas.push(c.id);
      const prods = S.productos.filter((p) => p.categoria_id === c.id);
      const conFoto = prods.filter((p) => p.imagen_url).sort((a, b) => (b.destacado === true) - (a.destacado === true));
      const conPrecio = prods.filter((p) => precioDe(p) > 0).sort((a, b) => precioDe(a) - precioDe(b));
      const min = conPrecio[0];
      const nombres = prods.slice(0, 3).map((p) => p.nombre.split(/[(,]/)[0].trim());
      return `<article class="promo${i === 0 ? " promo--oscura" : ""}">
        <div class="promo__txt">
          <h3>${U.esc(c.nombre)}</h3>
          <p class="promo__sub">${U.esc(nombres.join(", "))}${prods.length > 3 ? " y más." : "."}</p>
          ${min ? `<p class="promo__precio">Desde <b>${U.esc(U.colones(precioDe(min)))}</b>${min.unidad ? ` por ${U.esc(min.unidad)}` : ""}</p>` : ""}
          <button type="button" class="btn btn--sm${i === 0 ? "" : " btn--negro"}" data-cat="${U.esc(c.id)}">Ver ${prods.length} ${prods.length === 1 ? "producto" : "productos"}</button>
        </div>
        <div class="promo__foto">${conFoto[0] ? `<img src="${U.esc(fotoDe(conFoto[0]))}" alt="" />` : ""}</div>
      </article>`;
    }).join("");
    $("#promos").innerHTML = html;
    $("#promos").hidden = !html.trim();
  }

  const RANGOS = {
    o: (p) => ofertaVigente(p),
    a: (p) => precioDe(p) > 0 && precioDe(p) <= 10000,
    b: (p) => precioDe(p) > 10000 && precioDe(p) <= 50000,
    c: (p) => precioDe(p) > 50000,
    x: (p) => !(precioDe(p) > 0)
  };
  const filtrados = () => {
    const q = norm(S.q);
    const l = S.productos.filter((p) =>
      (!S.cat || String(p.categoria_id) === String(S.cat)) &&
      (!S.rango || RANGOS[S.rango](p)) &&
      (!q || norm(p.nombre + " " + (p.descripcion || "") + " " + (catDe(p.categoria_id).nombre || "")).includes(q)));
    const pr = (p, alto) => (precioDe(p) > 0 ? precioDe(p) : alto);
    if (S.orden === "pmen") l.sort((a, b) => pr(a, Infinity) - pr(b, Infinity));
    else if (S.orden === "pmay") l.sort((a, b) => pr(b, -1) - pr(a, -1));
    else if (S.orden === "nom") l.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    // lo agotado siempre al final
    return l.sort((a, b) => (a.agotado === true) - (b.agotado === true));
  };

  function controlHTML(p) {
    if (p.agotado) return `<button type="button" class="btn-agregar" disabled>Agotado por ahora</button>`;
    const it = enLista(p.id);
    if (!it) return `<button type="button" class="btn-agregar" data-add="${p.id}" aria-label="Agregar ${U.esc(p.nombre)} al carrito">Agregar al carrito</button>`;
    return `<span class="stepper" role="group" aria-label="Cantidad de ${U.esc(p.nombre)} en el carrito">
      <button type="button" data-menos="${U.esc(it.k)}" aria-label="Quitar uno">−</button>
      <output aria-live="polite">${it.cant}<span class="sr"> en el carrito</span></output>
      <button type="button" data-mas="${U.esc(it.k)}" aria-label="Agregar uno">+</button></span>`;
  }
  const precioHTML = (p) => {
    const precio = U.colones(precioDe(p));
    if (!precio) return `<p class="precio precio--consultar">Precio a consultar</p>`;
    const oferta = ofertaVigente(p);
    return `<p class="precio">${precio}${oferta && p.precio ? ` <s>${U.esc(U.colones(p.precio))}</s>` : ""} <small>aprox.${p.unidad ? ` por ${U.esc(p.unidad)}` : ""}</small>${oferta ? `<span class="precio__hasta">Oferta hasta el ${U.esc(fechaCorta(p.oferta_hasta))}</span>` : ""}</p>`;
  };

  function pintarProductos() {
    const lista = filtrados();
    const ul = $("#lista");
    ul.classList.toggle("es-lista", S.vista === "lista");
    ul.innerHTML = lista.map((p) => {
      const url = fotoDe(p);
      const etiqueta = ofertaVigente(p) ? '<span class="tarjeta-prod__rec tarjeta-prod__rec--oferta">Oferta</span>'
        : p.destacado ? '<span class="tarjeta-prod__rec">Recomendado</span>' : "";
      return `<li class="tarjeta-prod${p.agotado ? " es-agotado" : ""}" data-id="${p.id}">
        <div class="tarjeta-prod__foto">
          <button type="button" data-ficha="${p.id}" tabindex="-1" aria-hidden="true">${url ? `<img src="${U.esc(url)}" alt="" loading="lazy" />` : SIN_FOTO}</button>
          ${etiqueta}${p.agotado ? '<span class="tarjeta-prod__agotado">Agotado</span>' : ""}
        </div>
        <div class="tarjeta-prod__cuerpo">
          <p class="tarjeta-prod__cat">${U.esc(catDe(p.categoria_id).nombre || "")}</p>
          <h3><button type="button" class="tarjeta-prod__nombre" data-ficha="${p.id}">${U.esc(p.nombre)}</button></h3>
          ${p.descripcion ? `<p class="tarjeta-prod__desc">${U.esc(p.descripcion)}</p>` : ""}
          <div class="tarjeta-prod__pie">
            ${precioHTML(p)}
            <span class="ctl">${controlHTML(p)}</span>
          </div>
        </div>
      </li>`;
    }).join("");
    ul.setAttribute("aria-busy", "false");

    const cat = S.cat ? catDe(Number(S.cat)).nombre : "";
    $("#catTitulo").textContent = S.q ? `Resultados para “${S.q.slice(0, 40)}”` : cat || "Catálogo";
    $("#conteo").textContent = `${lista.length} ${lista.length === 1 ? "producto" : "productos"}`;
    const bq = $("#busqueda");
    bq.hidden = !S.q;
    if (S.q) bq.innerHTML = `“${U.esc(S.q.slice(0, 40))}” <button type="button" id="btnLimpiarQ" aria-label="Quitar la búsqueda"><svg class="ico" aria-hidden="true"><use href="#i-cerrar"/></svg></button>`;
    $("#vacio").hidden = lista.length > 0;
    $("#btnAgregarLibre").textContent = S.q ? `Agregar “${S.q.slice(0, 40)}” al carrito` : "Escribirlo en el carrito";
    $$("#cats [data-cat]").forEach((b) => b.setAttribute("aria-pressed", String(String(S.cat) === b.dataset.cat)));
    $$("#filtroCat [data-cat]").forEach((b) => b.setAttribute("aria-checked", String(String(S.cat) === b.dataset.cat)));
    $$("#filtroPrecio [data-rango]").forEach((b) => b.setAttribute("aria-checked", String(S.rango === b.dataset.rango)));
    $$("[data-vista]").forEach((b) => b.setAttribute("aria-pressed", String(S.vista === b.dataset.vista)));
  }

  function pintarControles() {
    $$("#lista .tarjeta-prod").forEach((li) => {
      const p = S.productos.find((x) => x.id === Number(li.dataset.id));
      if (!p) return;
      refrescarControl(li.querySelector(".ctl"), p);
    });
    if (S.fichaId != null) { const p = S.productos.find((x) => x.id === S.fichaId); if (p) refrescarControl($("#fichaAcc"), p); }
  }
  function refrescarControl(ctl, p) {
    const antes = document.activeElement && ctl.contains(document.activeElement) ? document.activeElement : null;
    const tipo = antes ? (antes.dataset.add ? "add" : antes.dataset.mas ? "mas" : "menos") : null;
    ctl.innerHTML = controlHTML(p);
    if (tipo) (ctl.querySelector(tipo === "add" ? "[data-mas]" : `[data-${tipo}]`) || ctl.querySelector("[data-add]"))?.focus();
  }

  function irAlCatalogo() {
    const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("#catalogo").scrollIntoView({ behavior: suave ? "smooth" : "auto", block: "start" });
  }
  function ponerCategoria(id, ir) {
    S.cat = id == null ? "" : String(id);
    if (S.cat && S.q) { S.q = ""; $("#q").value = ""; }
    pintarProductos();
    if (ir) irAlCatalogo();
  }

  // ---------- ficha de producto ----------
  function abrirFicha(id) {
    const p = S.productos.find((x) => x.id === id);
    if (!p) return;
    S.fichaId = id;
    const url = fotoDe(p);
    $("#fichaFoto").innerHTML = url ? `<img src="${U.esc(url)}" alt="${U.esc(p.nombre)}" />` : SIN_FOTO;
    $("#fichaCat").textContent = catDe(p.categoria_id).nombre || "";
    $("#fichaNombre").textContent = p.nombre;
    $("#fichaMeta").innerHTML = p.unidad ? `Se vende por: <b>${U.esc(p.unidad)}</b>` : "";
    const precio = U.colones(precioDe(p)), oferta = ofertaVigente(p);
    $("#fichaPrecio").innerHTML = precio
      ? `${precio}${oferta && p.precio ? ` <s>${U.esc(U.colones(p.precio))}</s>` : ""} <small>aprox.</small>`
      : "Precio a consultar";
    $("#fichaNota").textContent = p.agotado
      ? "Agotado por ahora. Pregúntenos por WhatsApp cuándo vuelve a llegar."
      : (oferta ? `Precio de oferta hasta el ${fechaCorta(p.oferta_hasta)}. ` : "") + (precio
        ? "Precio aproximado: se lo confirmamos al revisar su pedido."
        : "Agréguelo al carrito y le enviamos el precio con el total de su pedido.");
    $("#fichaDesc").textContent = p.descripcion || "";
    $("#fichaDesc").hidden = !p.descripcion;
    $("#fichaAcc").innerHTML = controlHTML(p);
    $("#fichaWa").href = U.waLink(waNum(), `¡Hola, ${C.NEGOCIO}! Quisiera consultar por: ${p.nombre}`);
    const dlg = $("#ficha");
    if (!dlg.open) dlg.showModal();
    try { history.replaceState(null, "", `${location.pathname}${location.search}#p${id}`); } catch { /* */ }
  }
  function cerradaFicha() {
    S.fichaId = null;
    try { if (/^#p\d+$/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search); } catch { /* */ }
  }

  // ---------- calculadora de materiales ----------
  const esTecho = (p) => /l[aá]mina/i.test(p.nombre) && !/pvc/i.test(p.nombre) && /(techo|ondulad|zinc|aluminizad|teja|rectangular)/i.test(p.nombre);
  const esPvc = (p) => /pvc/i.test(p.nombre);
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };
  const dec = (n) => n.toLocaleString("es-CR", { maximumFractionDigits: 2 });
  const calcRes = { techo: null, pvc: null };

  function opcionesCalc(sel, filtro, otra) {
    const antes = sel.dataset.listo ? sel.value : null;     // respetar lo que el cliente ya escogió
    sel.dataset.listo = "1";
    sel.innerHTML = S.productos.filter(filtro).map((p) => {
      const pr = precioDe(p);
      return `<option value="${p.id}"${p.agotado ? " disabled" : ""}>${U.esc(p.nombre)}${p.agotado ? " (agotado)" : pr ? " · " + U.esc(U.colones(pr)) : ""}</option>`;
    }).join("") + `<option value="">${U.esc(otra)}</option>`;
    const ops = [...sel.options].filter((o) => !o.disabled);
    sel.value = ops.some((o) => o.value === antes) ? antes : (ops[0]?.value ?? "");
  }
  function abrirCalc(tab) {
    opcionesCalc($("#panTecho").producto, esTecho, "Otra lámina (se la cotizamos)");
    opcionesCalc($("#panPvc").producto, esPvc, "Otro diseño (se lo cotizamos)");
    tabCalc(tab);
    calcTecho(); calcPvc();
    const d = $("#calc");
    if (!d.open) d.showModal();
    (tab === "pvc" ? $("#panPvc").ancho : $("#tLargo")).focus();
  }
  function tabCalc(tab) {
    $$("#calc [role=tab]").forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    $("#panTecho").hidden = tab !== "techo";
    $("#panPvc").hidden = tab !== "pvc";
  }
  function listoCalc(btn, res, html, datos, clave, etiqueta) {
    res.innerHTML = html;
    calcRes[clave] = datos;
    btn.disabled = !datos;
    btn.textContent = datos ? etiqueta : "Agregar al carrito";
  }

  function calcTecho() {
    const f = $("#panTecho"), res = $("#resTecho"), btn = f.querySelector("[type=submit]");
    const aguas = Number(f.aguas.value) === 1 ? 1 : 2;
    const largo = num(f.largo.value), caida = num(f.caida.value), L = num(f.largoLam.value);
    const ancho = num(f.ancho.value), tras = num(f.traslape.value), desp = Math.max(0, Math.min(30, num(f.desp.value) || 0));
    if (!(largo > 0 && caida > 0)) return listoCalc(btn, res, '<p class="calc__det">Escriba el largo y la caída del techo en metros.</p>', null, "techo");
    if (largo > 200 || caida > 30) return listoCalc(btn, res, '<p class="calc__det">Revise las medidas: parecen muy grandes. Para obras grandes, escríbanos por WhatsApp.</p>', null, "techo");
    if (!(ancho >= 0.3 && ancho <= 1.5 && tras >= 0 && L - tras >= 0.3)) return listoCalc(btn, res, '<p class="calc__det">Revise el ancho útil y el traslape.</p>', null, "techo");
    const cols = Math.ceil(largo / ancho - 1e-9);
    const filas = caida <= L ? 1 : 1 + Math.ceil((caida - L) / (L - tras) - 1e-9);
    const base = cols * filas * aguas;
    const total = Math.min(999, Math.ceil(base * (1 + desp / 100) - 1e-9));
    const p = S.productos.find((x) => x.id === Number(f.producto.value));
    const pr = p ? precioDe(p) : null;
    let aviso = "";
    if (filas > 1) {
      const entera = [...f.largoLam.options].map((o) => num(o.value)).find((v) => v >= caida);
      aviso = `Cada caída lleva ${filas} láminas traslapadas.` + (entera ? ` Con láminas de ${dec(entera)} m irían enteras.` : "");
    }
    const html = `<p class="calc__total">Necesita unas <b>${total}</b> láminas de ${dec(L)} m</p>
      <p class="calc__det">${cols} a lo largo × ${filas} por caída × ${aguas} ${aguas === 1 ? "caída" : "caídas"} = ${base}${desp ? `, más ${dec(desp)} % de desperdicio` : ""}. Techo de unos ${dec(largo * caida * aguas)} m².</p>
      ${pr ? `<p class="calc__det">Costo aproximado de las láminas: <b>${U.esc(U.colones(pr * total))}</b></p>` : ""}
      ${aviso ? `<p class="calc__aviso">${U.esc(aviso)}</p>` : ""}`;
    listoCalc(btn, res, html, { total, p, L, largo, aguas }, "techo", `Agregar ${total} láminas al carrito`);
  }

  function calcPvc() {
    const f = $("#panPvc"), res = $("#resPvc"), btn = f.querySelector("[type=submit]");
    const cielo = f.tipo.value === "cielo";
    $("#lblAlto").textContent = cielo ? "Largo (m)" : "Alto (m)";
    $("#lblCant").textContent = cielo ? "Cuartos iguales" : "Paredes iguales";
    const a = num(f.ancho.value), h = num(f.alto.value);
    const cant = Math.max(1, Math.min(20, Math.round(num(f.cant.value)) || 1));
    const restar = Math.max(0, num(f.restar.value) || 0);
    const la = num(f.lamA.value), ll = num(f.lamL.value), desp = Math.max(0, Math.min(30, num(f.desp.value) || 0));
    if (!(a > 0 && h > 0)) return listoCalc(btn, res, `<p class="calc__det">Escriba el ancho y el ${cielo ? "largo" : "alto"} en metros.</p>`, null, "pvc");
    if (a > 100 || h > 100) return listoCalc(btn, res, '<p class="calc__det">Revise las medidas: parecen muy grandes.</p>', null, "pvc");
    if (!(la >= 0.3 && ll >= 0.3)) return listoCalc(btn, res, '<p class="calc__det">Revise la medida de la lámina.</p>', null, "pvc");
    const area = Math.max(0, a * h * cant - restar);
    if (area <= 0) return listoCalc(btn, res, '<p class="calc__det">Lo que resta de puertas y ventanas es más que el área.</p>', null, "pvc");
    const total = Math.min(999, Math.ceil(area * (1 + desp / 100) / (la * ll) - 1e-9));
    const p = S.productos.find((x) => x.id === Number(f.producto.value));
    const pr = p ? precioDe(p) : null;
    const html = `<p class="calc__total">Necesita unas <b>${total}</b> láminas de ${dec(la)} × ${dec(ll)} m</p>
      <p class="calc__det">${dec(area)} m² ${cielo ? "de cielo" : "de pared"}${restar ? " (ya sin puertas ni ventanas)" : ""}${desp ? `, más ${dec(desp)} % de desperdicio por cortes` : ""}. Cada lámina cubre ${dec(la * ll)} m².</p>
      ${pr ? `<p class="calc__det">Costo aproximado de las láminas: <b>${U.esc(U.colones(pr * total))}</b></p>` : ""}`;
    listoCalc(btn, res, html, { total, p, area, la, ll }, "pvc", `Agregar ${total} láminas al carrito`);
  }

  function calcAlCarrito(clave) {
    const r = calcRes[clave];
    if (!r) return;
    const extras = (clave === "techo" ? $("#panTecho") : $("#panPvc")).extras.checked;
    if (clave === "techo") {
      if (r.p) ponerEnCarrito(r.p, r.total);
      else libreEnCarrito(`Lámina ondulada de ${dec(r.L)} m (a cotizar)`, r.total);
      if (extras) {
        if (r.aguas === 2) libreEnCarrito(`Cumbrera para techo de ${dec(r.largo)} m de largo`, 1);
        libreEnCarrito(`Tornillos para techo (para ${r.total} láminas)`, 1);
      }
    } else {
      if (r.p) ponerEnCarrito(r.p, r.total);
      else libreEnCarrito(`Lámina PVC de ${dec(r.la)} × ${dec(r.ll)} m (a cotizar)`, r.total);
      if (extras) {
        libreEnCarrito(`Molduras para PVC (para ${dec(r.area)} m²)`, 1);
        libreEnCarrito(`Pegamento para lámina PVC (para ${r.total} láminas)`, 1);
      }
    }
    cambioCarrito();
    $("#calc").close();
    toast(`Agregado al carrito: ${r.total} láminas${extras ? " y accesorios" : ""}`);
    abrirCarrito(true);
  }

  // ---------- entrega ----------
  function pintarEntrega() {
    const ok = envioActivo(), f = $("#formEnviar");
    $("#entrega").hidden = !ok;
    $("#facturaBox").hidden = !S.v4;
    if (!ok) return;
    const antes = f.zona.value;
    const orden = zonasEnvio().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    f.zona.innerHTML = `<option value="">Escoja su barrio o zona…</option>` + orden.map((z) =>
      `<option value="${U.esc(z.nombre)}">${U.esc(z.nombre)} · ${z.precio ? U.esc(U.colones(z.precio)) : "gratis"}</option>`).join("");
    if (zonasEnvio().some((z) => z.nombre === antes)) f.zona.value = antes;
    $("#envioNota").textContent = S.ajustes.envio_nota || "";
    $("#envioDatos").hidden = f.entrega.value !== "envio";
  }

  // ---------- filtros en celular ----------
  function abrirFiltros(abrir) {
    $("#filtros").classList.toggle("abierta", abrir);
    $("#btnFiltros").setAttribute("aria-expanded", String(abrir));
    $("#velo").hidden = !abrir;
    document.documentElement.classList.toggle("bloqueo", abrir);
    if (abrir) $("#btnCerrarFiltros").focus();
  }

  // ---------- carrito (proforma) ----------
  function envioElegido() {
    if (!envioActivo() || $("#entrega").hidden) return null;
    const f = $("#formEnviar");
    if (f.entrega.value !== "envio") return null;
    return zonasEnvio().find((z) => z.nombre === f.zona.value) || null;
  }
  function totalEstimado() {
    let t = 0, sinPrecio = 0;
    S.lista.forEach((i) => { if (i.precio != null && i.precio > 0) t += i.precio * i.cant; else sinPrecio++; });
    const z = envioElegido();
    if (z) t += z.precio;
    return { t, sinPrecio, envio: z };
  }

  function pintarCarrito() {
    $("#listaVacia").hidden = S.lista.length > 0;
    $("#renglones").innerHTML = S.lista.map((i) => {
      const sub = i.precio != null && i.precio > 0 ? U.colones(i.precio * i.cant) : "";
      return `<li class="renglon">
        <span class="renglon__cant">
          <button type="button" data-rmenos="${U.esc(i.k)}" aria-label="Quitar uno de ${U.esc(i.nombre)}">−</button>
          <output>${i.cant}</output>
          <button type="button" data-rmas="${U.esc(i.k)}" aria-label="Agregar uno de ${U.esc(i.nombre)}">+</button>
        </span>
        <span class="renglon__desc">${U.esc(i.nombre)}<small>${i.agotado ? "agotado: quítelo del carrito" : i.id ? (sub ? U.esc(sub) : "precio a confirmar") : "fuera del catálogo"}</small></span>
        <button type="button" class="renglon__quitar" data-quitar="${U.esc(i.k)}" aria-label="Quitar ${U.esc(i.nombre)} del carrito">✕</button>
      </li>`;
    }).join("");
    const { t, sinPrecio, envio } = totalEstimado();
    $("#filaEnvio").hidden = !envio;
    if (envio) { $("#lblEnvio").textContent = `Envío a ${envio.nombre}`; $("#totalEnvio").textContent = envio.precio ? U.colones(envio.precio) : "Gratis"; }
    $("#totales").hidden = !S.lista.length;
    $("#totalEstimado").textContent = t > 0 ? U.colones(t) : "A confirmar";
    $("#totalNota").textContent = sinPrecio
      ? `${sinPrecio === 1 ? "1 producto" : sinPrecio + " productos"} con precio a confirmar. Los demás precios son aproximados: le enviamos el total final.`
      : "Precios aproximados. Le confirmamos el total y la disponibilidad antes de cobrar.";
  }

  function abrirCarrito(abrir) {
    const p = $("#proforma");
    if (abrir && $("#ficha").open) $("#ficha").close();
    if (abrir) abrirFiltros(false);
    p.classList.toggle("abierta", abrir);
    $("#velo").hidden = !abrir;
    ["#btnAbrirLista", "#btnCarrito"].forEach((s2) => $(s2).setAttribute("aria-expanded", String(abrir)));
    document.documentElement.classList.toggle("bloqueo", abrir);
    p.setAttribute("aria-modal", String(abrir));
    if (abrir) $("#proformaTitulo").focus();
  }

  // ---------- enviar pedido ----------
  function textoWhatsApp(d, codigo, conComprobante) {
    const lineas = S.lista.map((i) => `• ${i.cant}${i.unidad ? " " + i.unidad : ""} — ${i.nombre}`);
    return [
      `¡Hola, ${C.NEGOCIO}! Hice un pedido${codigo ? " en la página, código " + codigo : ""}:`,
      ...lineas,
      d.detalle ? `Nota: ${d.detalle}` : null,
      d.envio ? `Envío a ${d.envio.zona}: ${d.envio.direccion}` : "Lo recojo en el almacén.",
      d.factura ? "Necesito factura electrónica." : null,
      `A nombre de ${d.nombre}, tel. ${d.telefono}`,
      conComprobante ? "Ya subí el comprobante del SINPE." : null
    ].filter((l) => l !== null).join("\n");
  }

  async function enviar(e) {
    e.preventDefault();
    const f = e.currentTarget, err = $("#enviarError"), btn = $("#btnEnviar");
    const d = {
      nombre: f.nombre.value.trim().slice(0, 80),
      telefono: f.telefono.value.trim().slice(0, 20),
      detalle: f.detalle.value.trim().slice(0, 500)
    };
    const archivo = f.comprobante.files[0] || null;
    f.nombre.setAttribute("aria-invalid", String(d.nombre.length < 2));
    f.telefono.setAttribute("aria-invalid", String(U.soloDigitos(d.telefono).length < 8));
    if (!S.lista.length) { err.textContent = "El carrito está vacío: agregue al menos un producto."; return; }
    if (d.nombre.length < 2) { err.textContent = "Escriba su nombre para saber a quién preparar el pedido."; f.nombre.focus(); return; }
    if (!/^[0-9 +()-]{8,20}$/.test(d.telefono) || U.soloDigitos(d.telefono).length < 8) { err.textContent = "Revise el teléfono: necesitamos 8 dígitos, por ejemplo 8888-8888."; f.telefono.focus(); return; }
    if (archivo && !/^image\/|^application\/pdf$/.test(archivo.type)) { err.textContent = "El comprobante debe ser una foto o un PDF."; return; }
    const agotado = S.lista.find((i) => i.agotado);
    if (agotado) { err.textContent = `"${agotado.nombre}" está agotado. Quítelo del carrito para enviar el pedido.`; return; }
    if (envioActivo() && f.entrega.value === "envio") {
      const z = zonasEnvio().find((x) => x.nombre === f.zona.value);
      const dir = f.direccion.value.trim().replace(/\s+/g, " ").slice(0, 300);
      if (!z) { err.textContent = "Escoja su barrio o zona para el envío."; f.zona.focus(); return; }
      if (dir.length < 10) { err.textContent = "Escriba la dirección con señas para el envío."; f.direccion.focus(); return; }
      d.envio = { zona: z.nombre, direccion: dir };
    }
    if (S.v4 && $("#facturaBox").open && (f.f_id.value.trim() || f.f_nombre.value.trim() || f.f_correo.value.trim())) {
      const fid = U.soloDigitos(f.f_id.value), tipo = f.f_tipo.value;
      const RE = { fisica: /^[1-9][0-9]{8}$/, juridica: /^[0-9]{10}$/, dimex: /^[0-9]{11,12}$/, nite: /^[0-9]{10}$/ };
      if (!RE[tipo] || !RE[tipo].test(fid)) { err.textContent = "Factura: revise el número (cédula física 9 dígitos, jurídica 10, DIMEX 11 o 12)."; f.f_id.focus(); return; }
      if (f.f_nombre.value.trim().length < 2) { err.textContent = "Factura: escriba el nombre o la razón social."; f.f_nombre.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.f_correo.value.trim())) { err.textContent = "Factura: revise el correo electrónico."; f.f_correo.focus(); return; }
      d.factura = { t: tipo, id: fid, n: f.f_nombre.value.trim().slice(0, 100), e: f.f_correo.value.trim().slice(0, 120) };
    }
    err.textContent = "";
    if (f.empresa.value) { toast("Pedido enviado."); return; }    // bot

    try { localStorage.setItem(LS_CLIENTE, JSON.stringify({ nombre: d.nombre, tel: d.telefono })); } catch { /* */ }

    // Sin base de datos (modo demo): se manda por WhatsApp como antes
    if (!db) { U.abrir(U.waLink(waNum(), textoWhatsApp(d, null, false))); return; }

    btn.disabled = true;
    btn.textContent = "Enviando pedido…";
    try {
      const items = S.lista.map((i) => (i.id ? { id: i.id, c: i.cant } : { n: i.nombre, c: i.cant }));
      const base = { p_nombre: d.nombre, p_telefono: d.telefono, p_nota: d.detalle || null, p_items: items };
      const args = S.v4
        ? { ...base, p_entrega: d.envio ? { tipo: "envio", ...d.envio } : { tipo: "retiro" }, p_factura: d.factura || null }
        : base;
      let r;
      try { r = await mandarPedido(args, !d.envio && !d.factura); } catch (eRed) { r = { error: eRed }; }
      if (r.error && U.esErrorRed(r.error)) {
        guardarPendiente(args, d);
        mostrarGuardado(d, !!archivo);
        limpiarTrasEnviar(f);
        return;
      }
      if (r.error) throw new Error(textoError(r.error));
      const ped = r.data;
      U.guardarPedidoLocal(ped.codigo, d.telefono);

      let archivoCompartir = null, errorComp = "";
      if (archivo) {
        btn.textContent = "Subiendo comprobante…";
        try {
          archivoCompartir = await U.subirComprobanteCliente(ped.codigo, d.telefono, archivo, {
            monto: f.monto.value, referencia: f.referencia.value.trim(), nota: null
          });
        } catch (e2) { errorComp = e2.message; }
      }
      S.ultimo = { ...d, codigo: ped.codigo, total: Number(ped.total), pendientes: !!ped.precios_pendientes, archivo: archivoCompartir, errorComp, resumen: textoWhatsApp(d, ped.codigo, !!archivoCompartir) };
      mostrarListo();
      limpiarTrasEnviar(f);
    } catch (e3) {
      err.textContent = e3.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  }

  function limpiarTrasEnviar(f) {
    S.lista = [];
    f.detalle.value = ""; f.comprobante.value = ""; f.referencia.value = ""; f.monto.value = "";
    f.f_id.value = ""; f.f_nombre.value = ""; f.f_correo.value = ""; f.direccion.value = "";
    $("#pagoYa").open = false; $("#facturaBox").open = false;
    cambioCarrito();
  }

  const textoError = (e) => e && e.message && /[áéíóúñ]|\./.test(e.message) ? e.message : "No se pudo enviar el pedido. Intente de nuevo.";

  async function mandarPedido(args, sinExtras) {
    let r = await db.rpc("crear_pedido_web", args);
    // si la base todavía no tiene la versión nueva de la función, se envía sin entrega ni factura
    if (r.error && r.error.code === "PGRST202" && sinExtras && args.p_entrega !== undefined) {
      const { p_entrega, p_factura, ...base } = args;
      r = await db.rpc("crear_pedido_web", base);
    }
    return r;
  }

  // ---------- pedidos guardados sin internet ----------
  const leerPendientes = () => { try { const l = JSON.parse(localStorage.getItem(LS_PEND) || "[]"); return Array.isArray(l) ? l : []; } catch { return []; } };
  const escribirPendientes = (l) => { try { localStorage.setItem(LS_PEND, JSON.stringify(l.slice(-5))); } catch { /* sin espacio */ } };

  function guardarPendiente(args, d) {
    const l = leerPendientes();
    l.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), args, tel: d.telefono, sinExtras: !d.envio && !d.factura, lista: S.lista.map((i) => ({ ...i })) });
    escribirPendientes(l);
  }

  function mostrarGuardado(d, conArchivo) {
    $("#pasoCarrito").hidden = true;
    $("#pasoListo").hidden = false;
    $("#listoTitulo").textContent = "Pedido guardado";
    $("#listoLbl").hidden = $("#listoCodigo").hidden = $("#btnCopiar").hidden = true;
    $("#btnAvisarWa").hidden = $("#lnkMiPedido").hidden = $("#btnCompartir").hidden = true;
    $("#listoTexto").textContent = "No hay internet en este momento. Su pedido quedó guardado en este teléfono y se enviará solo apenas vuelva la conexión (con esta página abierta o la próxima vez que la abra). Ahí le aparecerá su código."
      + (conArchivo ? " El comprobante no se guardó: súbalo después en “Ver mi pedido”." : "");
    $("#proformaTitulo").textContent = "Guardado";
    $("#proformaTitulo").focus();
  }

  let enviando = false;
  async function enviarPendientes() {
    if (!db || enviando || !navigator.onLine) return;
    let l = leerPendientes();
    if (!l.length) return;
    enviando = true;
    try {
      for (const p of [...l]) {
        let r;
        try { r = await mandarPedido(p.args, p.sinExtras); } catch (e) { r = { error: e }; }
        if (r.error && U.esErrorRed(r.error)) break;          // sigue sin internet: se intenta después
        l = leerPendientes().filter((x) => x.id !== p.id);
        escribirPendientes(l);
        if (r.error) {
          if (!S.lista.length && Array.isArray(p.lista)) { S.lista = p.lista; cambioCarrito(); }
          U.banda(`Su pedido guardado no se pudo enviar: ${textoError(r.error)}`, "sin", { texto: "Revisar carrito", accion: () => { U.banda(""); abrirCarrito(true); } });
          continue;
        }
        const cod = r.data.codigo;
        U.guardarPedidoLocal(cod, p.tel);
        U.banda(`Su pedido se envió. Código: ${cod}`, "ok", { texto: "Ver mi pedido", accion: () => { location.href = `pedido.html?c=${encodeURIComponent(cod)}`; } });
        if (!$("#pasoListo").hidden && $("#listoCodigo").hidden) {
          S.ultimo = { codigo: cod, total: Number(r.data.total), pendientes: !!r.data.precios_pendientes, envio: p.args.p_entrega?.tipo === "envio" ? p.args.p_entrega : null, resumen: `¡Hola, ${C.NEGOCIO}! Hice el pedido ${cod} en la página.` };
          mostrarListo();
        }
      }
    } finally { enviando = false; }
  }

  function estadoRed() {
    if (navigator.onLine) {
      const b = $("#bandaRed");
      if (b && b.dataset.tipo === "sin" && !b.querySelector("button")) U.banda("");
      enviarPendientes();
    } else {
      U.banda(leerPendientes().length
        ? "Sin internet. Su pedido está guardado y se enviará cuando vuelva la conexión."
        : "Sin internet. Puede ver el catálogo y armar su pedido; se enviará cuando vuelva la conexión.");
    }
  }

  function mostrarListo() {
    const u = S.ultimo, sn = sinpeNum();
    $("#listoTitulo").textContent = "Pedido recibido";
    $("#listoLbl").hidden = $("#listoCodigo").hidden = $("#btnCopiar").hidden = false;
    $("#btnAvisarWa").hidden = $("#lnkMiPedido").hidden = false;
    $("#pasoCarrito").hidden = true;
    $("#pasoListo").hidden = false;
    $("#listoCodigo").textContent = u.codigo;
    $("#lnkMiPedido").href = `pedido.html?c=${encodeURIComponent(u.codigo)}`;
    let txt;
    if (u.archivo) txt = "Recibimos su comprobante. Lo revisamos en el banco y le confirmamos por WhatsApp.";
    else if (u.errorComp) txt = `El pedido quedó guardado, pero el comprobante no se pudo subir (${u.errorComp}). Súbalo de nuevo en “Ver mi pedido”.`;
    else if (u.envio) txt = `Le confirmamos el total y coordinamos el envío a ${u.envio.zona} por WhatsApp. Cuando pague por SINPE, suba el comprobante en “Ver mi pedido”.`;
    else if (!u.pendientes && u.total > 0 && sn) txt = `Total aproximado: ${U.colones(u.total)}. Le confirmamos el total por WhatsApp; después pague por SINPE Móvil al ${U.fmtTel(sn)}${S.ajustes.sinpe_titular ? " a nombre de " + S.ajustes.sinpe_titular : ""}, escriba ${u.codigo} en el detalle y suba el comprobante en “Ver mi pedido”.`;
    else txt = "Le confirmamos el total por WhatsApp. Cuando pague por SINPE, suba el comprobante en “Ver mi pedido” con este código.";
    $("#listoTexto").textContent = txt + " Guarde el código: con él y su teléfono puede ver su pedido.";
    $("#btnCompartir").hidden = !(u.archivo && U.puedeCompartirArchivo(u.archivo));
    $("#proformaTitulo").textContent = "¡Listo!";
    $("#proformaTitulo").focus();
  }

  function nuevoPedido() {
    $("#pasoListo").hidden = true;
    $("#pasoCarrito").hidden = false;
    $("#proformaTitulo").textContent = "Carrito";
    S.ultimo = null;
  }

  // ---------- eventos ----------
  function eventos() {
    // búsqueda en el encabezado
    let t;
    // al buscar se busca en todo el catálogo, sin el filtro de categoría
    const buscar = (txt) => { S.q = txt.trim().slice(0, 60); if (S.q) { S.cat = ""; S.rango = ""; } pintarProductos(); };
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => buscar(e.target.value), 150); });
    $("#buscador").addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(t);
      buscar($("#q").value);
      $("#q").blur();
      irAlCatalogo();
    });
    $("#busqueda").addEventListener("click", (e) => {
      if (!e.target.closest("#btnLimpiarQ")) return;
      S.q = ""; $("#q").value = ""; pintarProductos(); $("#catTitulo").focus();
    });

    // categorías y promos
    $("#cats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) ponerCategoria(String(S.cat) === b.dataset.cat ? "" : b.dataset.cat, true); });
    $("#promos").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.rangoPromo) { S.rango = b.dataset.rangoPromo; S.cat = ""; S.q = ""; $("#q").value = ""; pintarProductos(); irAlCatalogo(); }
      else if (b.dataset.cat) ponerCategoria(b.dataset.cat, true);
    });

    // calculadora
    $$("[data-calc]").forEach((b) => b.addEventListener("click", () => abrirCalc(b.dataset.calc)));
    const calc = $("#calc");
    $("#btnCerrarCalc").addEventListener("click", () => calc.close());
    calc.addEventListener("click", (e) => { if (e.target === calc) calc.close(); });
    $$("#calc [role=tab]").forEach((b) => {
      b.addEventListener("click", () => tabCalc(b.dataset.tab));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const otro = b.dataset.tab === "techo" ? "pvc" : "techo";
        tabCalc(otro); $(`#calc [data-tab=${otro}]`).focus();
      });
    });
    ["input", "change"].forEach((ev) => {
      $("#panTecho").addEventListener(ev, calcTecho);
      $("#panPvc").addEventListener(ev, calcPvc);
    });
    $("#panTecho").addEventListener("submit", (e) => { e.preventDefault(); calcAlCarrito("techo"); });
    $("#panPvc").addEventListener("submit", (e) => { e.preventDefault(); calcAlCarrito("pvc"); });

    // entrega
    $("#entrega").addEventListener("change", () => { $("#envioDatos").hidden = $("#formEnviar").entrega.value !== "envio"; pintarCarrito(); });
    $("#filtroCat").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) ponerCategoria(b.dataset.cat, false); });
    $("#filtroPrecio").addEventListener("click", (e) => { const b = e.target.closest("[data-rango]"); if (b) { S.rango = b.dataset.rango; pintarProductos(); } });
    $("#orden").addEventListener("change", (e) => { S.orden = e.target.value; pintarProductos(); });
    $$("[data-vista]").forEach((b) => b.addEventListener("click", () => {
      S.vista = b.dataset.vista;
      try { localStorage.setItem(LS_VISTA, S.vista); } catch { /* */ }
      pintarProductos();
    }));
    $("#btnFiltros").addEventListener("click", () => abrirFiltros(true));
    $("#btnCerrarFiltros").addEventListener("click", () => { abrirFiltros(false); $("#btnFiltros").focus(); });
    $("#btnVerResultados").addEventListener("click", () => { abrirFiltros(false); $("#catTitulo").focus(); });

    // tarjetas
    $("#lista").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.add) { const p = S.productos.find((x) => x.id === Number(b.dataset.add)); if (p) agregar(p); }
      else if (b.dataset.mas) cambiarCant(b.dataset.mas, +1);
      else if (b.dataset.menos) cambiarCant(b.dataset.menos, -1);
      else if (b.dataset.ficha) abrirFicha(Number(b.dataset.ficha));
    });

    // ficha
    const ficha = $("#ficha");
    $("#fichaAcc").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.add) { const p = S.productos.find((x) => x.id === Number(b.dataset.add)); if (p) agregar(p); }
      else if (b.dataset.mas) cambiarCant(b.dataset.mas, +1);
      else if (b.dataset.menos) cambiarCant(b.dataset.menos, -1);
    });
    $("#btnCerrarFicha").addEventListener("click", () => ficha.close());
    ficha.addEventListener("click", (e) => { if (e.target === ficha) ficha.close(); });
    ficha.addEventListener("close", cerradaFicha);

    // carrito
    $("#renglones").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.rmas) cambiarCant(b.dataset.rmas, +1);
      else if (b.dataset.rmenos) cambiarCant(b.dataset.rmenos, -1);
      else if (b.dataset.quitar) { S.lista = S.lista.filter((i) => i.k !== b.dataset.quitar); cambioCarrito(); }
    });
    $("#formLibre").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = $("#libreTxt");
      if (agregarLibre(inp.value)) inp.value = "";
      inp.focus();
    });
    $("#btnAgregarLibre").addEventListener("click", () => {
      if (S.q && agregarLibre(S.q)) { toast(`Agregado al carrito: ${S.q}`); return; }
      abrirCarrito(true);
      $("#libreTxt").focus();
    });
    $("#formEnviar").addEventListener("submit", enviar);

    $("#btnCopiar").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(S.ultimo.codigo); toast("Código copiado"); } catch { toast(S.ultimo.codigo); }
    });
    $("#btnAvisarWa").addEventListener("click", () => U.abrir(U.waLink(waNum(), S.ultimo.resumen)));
    $("#btnCompartir").addEventListener("click", async () => {
      const r = await U.compartir(S.ultimo.archivo, `Comprobante del pedido ${S.ultimo.codigo} — ${S.ultimo.nombre}`);
      if (r === null) toast("Su teléfono no permite compartir el archivo. El comprobante ya quedó guardado en su pedido.");
    });
    $("#btnOtro").addEventListener("click", nuevoPedido);

    $("#btnAbrirLista").addEventListener("click", () => abrirCarrito(true));
    $("#btnCarrito").addEventListener("click", () => abrirCarrito(true));
    $("#btnCerrarLista").addEventListener("click", () => abrirCarrito(false));
    $("#velo").addEventListener("click", () => { abrirCarrito(false); abrirFiltros(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("#proforma").classList.contains("abierta")) abrirCarrito(false);
      if ($("#filtros").classList.contains("abierta")) abrirFiltros(false);
    });
    matchMedia("(max-width: 900px)").addEventListener("change", (m) => { if (!m.matches) abrirFiltros(false); });
  }

  // ---------- inicio ----------
  document.addEventListener("DOMContentLoaded", async () => {
    $("#anio").textContent = new Date().getFullYear();
    cargarCarrito();
    try { if (localStorage.getItem(LS_VISTA) === "lista") S.vista = "lista"; } catch { /* */ }
    const qUrl = new URLSearchParams(location.search).get("q");
    if (qUrl) { S.q = qUrl.trim().slice(0, 60); $("#q").value = S.q; }
    try {
      const cli = JSON.parse(localStorage.getItem(LS_CLIENTE) || "null");
      if (cli) { $("#formEnviar").nombre.value = String(cli.nombre || "").slice(0, 80); $("#formEnviar").telefono.value = String(cli.tel || "").slice(0, 20); }
    } catch { /* */ }
    eventos();
    pintarContacto();
    U.registrarCopia();
    const r = await cargarDatos();
    pintarContacto();
    addEventListener("online", estadoRed);
    addEventListener("offline", estadoRed);
    estadoRed();
    if (r === "error") {
      $("#lista").innerHTML = "";
      $("#lista").setAttribute("aria-busy", "false");
      const v = $("#vacio");
      v.querySelector("p").innerHTML = "<strong>El catálogo no cargó.</strong> Revise su conexión o escríbanos por WhatsApp; igual puede armar su pedido a mano.";
      v.hidden = false;
    } else {
      pintarCategorias();
      pintarPromos();
      pintarProductos();
    }
    pintarEntrega();
    cambioCarrito();
    $$("[data-contador]").forEach((c) => c.classList.remove("salta"));
    const m = /^#p(\d+)$/.exec(location.hash);
    if (m && r !== "error") abrirFicha(Number(m[1]));
    else if (location.hash === "#carrito") abrirCarrito(true);
    else if (S.q) irAlCatalogo();
  });
})();
