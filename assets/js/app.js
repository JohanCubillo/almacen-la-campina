(function () {
  "use strict";
  const C = window.APP_CONFIG, db = window.db, U = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LS_KEY = "lc_lista_v1";

  // Catálogo de muestra: solo se usa mientras Supabase no está configurado
  const DEMO = {
    categorias: [
      { id: 1, nombre: "Materiales de construcción", icono: "🧱" },
      { id: 2, nombre: "Ferretería", icono: "🔨" },
      { id: 3, nombre: "Mascotas", icono: "🐾" },
      { id: 4, nombre: "Pesca", icono: "🎣" },
      { id: 5, nombre: "Cuidado del auto", icono: "🚗" },
      { id: 6, nombre: "Agro y jardín", icono: "🌱" }
    ],
    productos: [
      { id: 1, nombre: "Cemento gris", descripcion: "Saco para construcción general.", unidad: "saco", categoria_id: 1, destacado: true },
      { id: 2, nombre: "Varilla corrugada", descripcion: "Acero para refuerzo de columnas y vigas.", unidad: "unidad", categoria_id: 1 },
      { id: 3, nombre: "Block de concreto", descripcion: "Para paredes, tapias y muros.", unidad: "unidad", categoria_id: 1 },
      { id: 4, nombre: "Juego de herramientas", descripcion: "Lo básico para reparaciones en la casa.", unidad: "juego", categoria_id: 2, destacado: true },
      { id: 5, nombre: "Alimento para perro", descripcion: "Alimento balanceado.", unidad: "saco", categoria_id: 3, destacado: true },
      { id: 6, nombre: "Carrete y caña", descripcion: "Equipo para pesca de río y mar.", unidad: "unidad", categoria_id: 4 },
      { id: 7, nombre: "Limpiador de focos", descripcion: "Devuelve la transparencia a los focos del carro.", unidad: "unidad", categoria_id: 5, destacado: true }
    ]
  };

  const S = {
    ajustes: {
      telefono: C.TELEFONO, whatsapp: C.WHATSAPP, telefono2: C.TELEFONO2, direccion: C.DIRECCION,
      horario: C.HORARIO, horario_semana: "", facebook: C.FACEBOOK, aviso: "", sinpe_numero: "", sinpe_titular: ""
    },
    categorias: [],
    productos: [],
    cat: "",          // categoría activa
    q: "",            // texto de búsqueda
    lista: [],        // [{k, id?, nombre, unidad?, cant}]
    num: ""
  };

  // ---------- utilidades ----------
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const waNum = () => U.soloDigitos(S.ajustes.whatsapp) || C.WHATSAPP;
  const waLink = (msg) => `https://wa.me/${waNum()}${msg ? "?text=" + encodeURIComponent(msg) : ""}`;
  const fmtTel = (n) => { const d = U.soloDigitos(n).replace(/^506(?=\d{8}$)/, ""); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4)}` : String(n || ""); };
  const esMovil = () => matchMedia("(max-width: 980px)").matches;

  function toast(txt) {
    const t = $("#toast");
    t.textContent = txt;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------- lista (persistencia local, validada) ----------
  function cargarLista() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (raw && Array.isArray(raw.items)) {
        S.lista = raw.items
          .filter((i) => i && typeof i.k === "string" && typeof i.nombre === "string")
          .slice(0, 60)
          .map((i) => ({ k: i.k.slice(0, 40), id: Number.isInteger(i.id) ? i.id : null, nombre: i.nombre.slice(0, 100), unidad: typeof i.unidad === "string" ? i.unidad.slice(0, 30) : "", cant: Math.min(999, Math.max(1, parseInt(i.cant, 10) || 1)) }));
        S.num = /^\d{4}$/.test(raw.num) ? raw.num : "";
      }
    } catch { /* almacenamiento no disponible: la lista vive solo en memoria */ }
    if (!S.num) S.num = String(Math.floor(1000 + Math.random() * 9000));
  }
  function guardarLista() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ items: S.lista, num: S.num })); } catch { /* sin almacenamiento */ }
  }
  const enLista = (id) => S.lista.find((i) => i.id === id);

  function agregar(p) {
    const it = enLista(p.id);
    if (it) it.cant = Math.min(999, it.cant + 1);
    else S.lista.push({ k: "p" + p.id, id: p.id, nombre: p.nombre, unidad: p.unidad || "", cant: 1 });
    cambioLista();
    if (esMovil()) toast(`Agregado: ${p.nombre}`);
  }
  function agregarLibre(txt) {
    const nombre = txt.trim().slice(0, 80);
    if (nombre.length < 2 || S.lista.length >= 60) return false;
    S.lista.push({ k: "l" + Date.now().toString(36), id: null, nombre, unidad: "", cant: 1 });
    cambioLista();
    return true;
  }
  function cambiarCant(k, delta) {
    const it = S.lista.find((i) => i.k === k);
    if (!it) return;
    it.cant += delta;
    if (it.cant < 1) S.lista = S.lista.filter((i) => i !== it);
    else it.cant = Math.min(999, it.cant);
    cambioLista();
  }
  function quitar(k) { S.lista = S.lista.filter((i) => i.k !== k); cambioLista(); }

  function cambioLista() {
    guardarLista();
    pintarProforma();
    pintarControles();
    const c = $("#contador");
    c.textContent = S.lista.reduce((a, i) => a + 1, 0);
    c.classList.remove("salta"); void c.offsetWidth; c.classList.add("salta");
  }

  // ---------- datos ----------
  async function cargarDatos() {
    if (!db) { S.categorias = DEMO.categorias; S.productos = DEMO.productos; return "demo"; }
    try {
      const [a, c, p] = await Promise.all([
        db.from("ajustes").select("clave,valor"),
        db.from("categorias").select("id,nombre,icono,orden").order("orden"),
        db.from("productos").select("id,nombre,descripcion,precio,unidad,categoria_id,imagen_url,destacado").eq("activo", true)
          .order("destacado", { ascending: false }).order("nombre")
      ]);
      if (a.error || c.error || p.error) throw a.error || c.error || p.error;
      a.data.forEach((r) => { if (r.clave in S.ajustes) S.ajustes[r.clave] = r.valor ?? ""; });
      S.categorias = c.data;
      S.productos = p.data;
      return "ok";
    } catch (e) {
      console.warn("No se pudo cargar el catálogo:", e?.message || e);
      return "error";
    }
  }

  // ---------- contacto / horario ----------
  function pintarContacto() {
    const a = S.ajustes;
    const tel = U.soloDigitos(a.telefono);
    $$("[data-tel]").forEach((el) => (el.href = tel ? `tel:+506${tel.slice(-8)}` : waLink()));
    $$("[data-tel-num]").forEach((el) => (el.textContent = fmtTel(a.telefono)));
    $$("[data-wa]").forEach((el) => (el.href = waLink(`¡Hola, ${C.NEGOCIO}! Quisiera hacer una consulta.`)));
    $$("[data-wa-num]").forEach((el) => (el.textContent = fmtTel(waNum())));
    $$("[data-dir]").forEach((el) => (el.textContent = a.direccion || C.DIRECCION));
    if (a.telefono2) $$("[data-tel2]").forEach((el) => (el.textContent = fmtTel(a.telefono2)));
    else $("#liTel2").hidden = true;
    $("#lnkFb").href = U.safeUrl(a.facebook || C.FACEBOOK);
    const sinpe = U.soloDigitos(a.sinpe_numero);
    if (sinpe.length === 8) {
      $$("[data-sinpe]").forEach((el) => (el.textContent = `${fmtTel(sinpe)}${a.sinpe_titular ? " a nombre de " + a.sinpe_titular : ""}`));
      $("#liSinpe").hidden = false;
    }
    const q = encodeURIComponent(C.MAPA_QUERY);
    $("#mapa").src = `https://www.google.com/maps?q=${q}&output=embed`;
    $("#btnLlegar").href = `https://www.google.com/maps/search/?api=1&query=${q}`;
    if (a.aviso) { $("#aviso").textContent = a.aviso; $("#aviso").hidden = false; }
    pintarHorario();
  }

  function pintarHorario() {
    const h = U.parseHorario(S.ajustes.horario_semana);
    const estado = $("#estado");
    if (!h) {
      $("#horarioTexto").textContent = S.ajustes.horario || C.HORARIO;
      estado.textContent = "";
      return;
    }
    const { dia, min } = U.ahoraCR();
    const aMin = (t) => { const [hh, mm] = t.split(":").map(Number); return hh * 60 + mm; };
    const orden = [1, 2, 3, 4, 5, 6, 0];
    const tb = $("#tablaHorario tbody");
    tb.replaceChildren(...orden.map((d) => {
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
    if (hoy && min >= aMin(hoy[0]) && min < aMin(hoy[1])) {
      estado.dataset.abierto = "si";
      estado.textContent = `Abierto ahora. Cierra a las ${U.hora12(hoy[1])}.`;
      return;
    }
    estado.dataset.abierto = "no";
    if (hoy && min < aMin(hoy[0])) { estado.textContent = `Cerrado. Abre hoy a las ${U.hora12(hoy[0])}.`; return; }
    for (let i = 1; i <= 7; i++) {
      const d = (dia + i) % 7;
      if (h[d]) {
        const cuando = i === 1 ? "mañana" : `el ${U.DIAS[d].toLowerCase()}`;
        estado.textContent = `Cerrado. Abre ${cuando} a las ${U.hora12(h[d][0])}.`;
        return;
      }
    }
    estado.textContent = "";
  }

  // ---------- catálogo ----------
  function pintarChips() {
    const cont = (id) => S.productos.filter((p) => p.categoria_id === id).length;
    const chips = [{ id: "", nombre: "Todo", icono: "", n: S.productos.length }]
      .concat(S.categorias.map((c) => ({ ...c, n: cont(c.id) })).filter((c) => c.n > 0));
    $("#chips").innerHTML = chips.map((c) =>
      `<button type="button" class="chip" data-cat="${U.esc(c.id)}" aria-pressed="${String(S.cat) === String(c.id)}">` +
      `${c.icono ? `<span aria-hidden="true">${U.esc(c.icono)}</span>` : ""}${U.esc(c.nombre)} <span class="chip__n">${c.n}</span></button>`
    ).join("");
  }

  function filtrados() {
    const q = norm(S.q);
    return S.productos.filter((p) =>
      (!S.cat || String(p.categoria_id) === String(S.cat)) &&
      (!q || norm(p.nombre + " " + (p.descripcion || "")).includes(q))
    );
  }

  function controlHTML(p) {
    const it = enLista(p.id);
    if (!it) return `<button type="button" class="btn-agregar" data-add="${p.id}" aria-label="Agregar ${U.esc(p.nombre)} a mi lista">Agregar</button>`;
    return `<span class="stepper" role="group" aria-label="Cantidad de ${U.esc(p.nombre)}">
      <button type="button" data-menos="${U.esc(it.k)}" aria-label="Quitar uno">−</button>
      <output aria-live="polite">${it.cant}</output>
      <button type="button" data-mas="${U.esc(it.k)}" aria-label="Agregar uno">+</button></span>`;
  }

  function pintarProductos() {
    const lista = filtrados();
    const catDe = (id) => S.categorias.find((c) => c.id === id) || {};
    const ul = $("#lista");
    ul.innerHTML = lista.map((p) => {
      const c = catDe(p.categoria_id);
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      const img = url
        ? `<button type="button" data-foto="${p.id}" aria-label="Ver foto de ${U.esc(p.nombre)}"><img src="${U.esc(url)}" alt="" loading="lazy" width="76" height="76" /></button>`
        : `<span aria-hidden="true">${U.esc(c.icono || "🧰")}</span>`;
      const precio = U.colones(p.precio);
      return `<li class="prod" data-id="${p.id}">
        <div class="prod__img">${img}</div>
        <div class="prod__info">
          <h3>${U.esc(p.nombre)}</h3>
          ${p.descripcion ? `<p>${U.esc(p.descripcion)}</p>` : ""}
          <div class="prod__meta"><span class="prod__cat">${U.esc(c.nombre || "")}</span>${p.destacado ? '<span class="prod__dest">Recomendado</span>' : ""}</div>
        </div>
        <div class="prod__lado">
          ${precio ? `<span class="precio">${precio}${p.unidad ? ` <small>por ${U.esc(p.unidad)}</small>` : ""}</span>` : `<span class="precio precio--consultar">Precio a consultar</span>`}
          <span class="ctl">${controlHTML(p)}</span>
        </div>
      </li>`;
    }).join("");
    ul.setAttribute("aria-busy", "false");
    $("#vacio").hidden = lista.length > 0;
    $("#btnAgregarLibre").textContent = S.q ? `Agregar “${S.q.slice(0, 40)}” a mi lista` : "Escribirlo en mi lista";
  }

  // Actualiza solo los controles (sin re-pintar todo, para no perder el foco)
  function pintarControles() {
    $$("#lista .prod").forEach((li) => {
      const p = S.productos.find((x) => x.id === Number(li.dataset.id));
      if (!p) return;
      const ctl = li.querySelector(".ctl");
      const antes = document.activeElement && ctl.contains(document.activeElement) ? document.activeElement : null;
      const tipo = antes ? (antes.dataset.add ? "add" : antes.dataset.mas ? "mas" : "menos") : null;
      ctl.innerHTML = controlHTML(p);
      if (tipo) {
        const destino = ctl.querySelector(tipo === "add" ? "[data-mas]" : `[data-${tipo}]`) || ctl.querySelector("[data-add]");
        destino?.focus();
      }
    });
  }

  // ---------- proforma ----------
  function pintarProforma() {
    $("#proformaNum").textContent = `Nº ${S.num}`;
    $("#listaVacia").hidden = S.lista.length > 0;
    $("#renglones").innerHTML = S.lista.map((i) => `
      <li class="renglon">
        <span class="renglon__cant">
          <button type="button" data-rmenos="${U.esc(i.k)}" aria-label="Quitar uno de ${U.esc(i.nombre)}">−</button>
          <output>${i.cant}</output>
          <button type="button" data-rmas="${U.esc(i.k)}" aria-label="Agregar uno de ${U.esc(i.nombre)}">+</button>
        </span>
        <span class="renglon__desc">${U.esc(i.nombre)}${i.unidad ? `<small>${U.esc(i.unidad)}</small>` : i.id ? "" : "<small>fuera del catálogo</small>"}</span>
        <button type="button" class="renglon__quitar" data-quitar="${U.esc(i.k)}" aria-label="Quitar ${U.esc(i.nombre)} de la lista">✕</button>
      </li>`).join("");
  }

  function abrirLista(abrir) {
    const p = $("#proforma");
    p.classList.toggle("abierta", abrir);
    $("#velo").hidden = !abrir;
    $("#btnAbrirLista").setAttribute("aria-expanded", String(abrir));
    document.documentElement.classList.toggle("bloqueo", abrir);
    if (abrir) { p.setAttribute("aria-modal", "true"); $("#proformaTitulo").setAttribute("tabindex", "-1"); $("#proformaTitulo").focus(); }
    else { p.setAttribute("aria-modal", "false"); }
  }

  function mensajeWhatsApp(d) {
    const lineas = S.lista.map((i) => `• ${i.cant}${i.unidad ? " " + i.unidad + (i.cant > 1 ? "(s)" : "") : ""} — ${i.nombre}${i.id ? "" : " (fuera del catálogo)"}`);
    return [
      `¡Hola, ${C.NEGOCIO}! Quisiera cotizar (lista Nº ${S.num}):`,
      ...lineas,
      d.detalle ? `Nota: ${d.detalle}` : "",
      `A nombre de ${d.nombre}, tel. ${d.telefono}`
    ].filter(Boolean).join("\n");
  }

  async function enviar(e) {
    e.preventDefault();
    const f = e.currentTarget, err = $("#enviarError");
    const d = {
      nombre: f.nombre.value.trim().slice(0, 80),
      telefono: f.telefono.value.trim().slice(0, 20),
      detalle: f.detalle.value.trim().slice(0, 500)
    };
    f.nombre.setAttribute("aria-invalid", String(d.nombre.length < 2));
    f.telefono.setAttribute("aria-invalid", String(U.soloDigitos(d.telefono).length < 8));
    if (!S.lista.length && d.detalle.length < 3) { err.textContent = "Agregue al menos un producto o escriba lo que necesita en la nota."; return; }
    if (d.nombre.length < 2) { err.textContent = "Escriba su nombre para saber a quién responderle."; f.nombre.focus(); return; }
    if (!/^[0-9 +()-]{8,20}$/.test(d.telefono) || U.soloDigitos(d.telefono).length < 8) { err.textContent = "Revise el teléfono: necesitamos 8 dígitos, por ejemplo 8888-8888."; f.telefono.focus(); return; }
    err.textContent = "";

    // Bots: si llenan el campo oculto, fingimos éxito y no guardamos nada
    if (f.empresa.value) { toast("Lista enviada."); return; }

    // WhatsApp se abre antes de cualquier espera para que el navegador no lo bloquee
    const url = waLink(mensajeWhatsApp(d));
    // (con "noopener" window.open siempre devuelve null, por eso se corta opener a mano)
    const win = window.open(url, "_blank");
    if (win) win.opener = null; else location.href = url;

    if (db) {
      const btn = $("#btnEnviar");
      btn.disabled = true;
      const items = S.lista.map((i) => ({ n: i.nombre, c: i.cant, u: i.unidad || null, id: i.id }));
      const { error } = await db.from("cotizaciones").insert({ ...d, detalle: d.detalle || null, items });
      btn.disabled = false;
      if (error) console.warn("Cotización no guardada:", error.message);
    }
    toast("Listo. Termine de enviarla en WhatsApp.");
    // Lista nueva para la próxima vez
    S.lista = [];
    S.num = String(Math.floor(1000 + Math.random() * 9000));
    f.detalle.value = "";
    cambioLista();
    if (esMovil()) abrirLista(false);
  }

  // ---------- foto ampliada ----------
  function verFoto(id) {
    const p = S.productos.find((x) => x.id === id);
    if (!p?.imagen_url) return;
    let dlg = $("#dlgFoto");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "dlgFoto"; dlg.className = "foto";
      const img = document.createElement("img"); img.alt = "";
      const cap = document.createElement("p");
      const cerrar = document.createElement("button");
      cerrar.type = "button"; cerrar.className = "btn btn--linea btn--sm"; cerrar.textContent = "Cerrar";
      cerrar.addEventListener("click", () => dlg.close());
      dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
      dlg.append(img, cap, cerrar);
      document.body.append(dlg);
    }
    dlg.querySelector("img").src = U.safeUrl(p.imagen_url, "");
    dlg.querySelector("img").alt = p.nombre;
    dlg.querySelector("p").textContent = p.nombre;
    dlg.showModal();
  }

  // ---------- eventos ----------
  function eventos() {
    $("#chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]");
      if (!b) return;
      S.cat = b.dataset.cat;
      $$(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      pintarProductos();
    });

    let t;
    $("#q").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => { S.q = e.target.value.trim(); pintarProductos(); }, 120);
    });

    $("#buscadorHero").addEventListener("submit", (e) => {
      e.preventDefault();
      S.q = $("#qHero").value.trim();
      S.cat = "";
      $("#q").value = S.q;
      pintarChips();
      pintarProductos();
      $("#catalogo").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });

    $("#lista").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.add) { const p = S.productos.find((x) => x.id === Number(b.dataset.add)); if (p) agregar(p); }
      else if (b.dataset.mas) cambiarCant(b.dataset.mas, +1);
      else if (b.dataset.menos) cambiarCant(b.dataset.menos, -1);
      else if (b.dataset.foto) verFoto(Number(b.dataset.foto));
    });

    $("#renglones").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.rmas) cambiarCant(b.dataset.rmas, +1);
      else if (b.dataset.rmenos) cambiarCant(b.dataset.rmenos, -1);
      else if (b.dataset.quitar) quitar(b.dataset.quitar);
    });

    $("#formLibre").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = $("#libreTxt");
      if (agregarLibre(inp.value)) inp.value = "";
      inp.focus();
    });

    $("#btnAgregarLibre").addEventListener("click", () => {
      if (S.q && agregarLibre(S.q)) { toast(`Agregado: ${S.q}`); return; }
      if (esMovil()) abrirLista(true);
      $("#libreTxt").focus();
    });

    $("#formEnviar").addEventListener("submit", enviar);
    $("#btnAbrirLista").addEventListener("click", () => abrirLista(true));
    $("#btnCerrarLista").addEventListener("click", () => abrirLista(false));
    $("#velo").addEventListener("click", () => abrirLista(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#proforma").classList.contains("abierta")) abrirLista(false); });
    matchMedia("(max-width: 980px)").addEventListener("change", (m) => { if (!m.matches) abrirLista(false); });
  }

  // ---------- inicio ----------
  document.addEventListener("DOMContentLoaded", async () => {
    $("#anio").textContent = new Date().getFullYear();
    cargarLista();
    eventos();
    pintarProforma();
    $("#contador").textContent = S.lista.length;
    pintarContacto();

    const r = await cargarDatos();
    pintarContacto();
    if (r === "error") {
      $("#lista").innerHTML = "";
      $("#lista").setAttribute("aria-busy", "false");
      const v = $("#vacio");
      v.querySelector("p").innerHTML = "<strong>El catálogo no cargó.</strong> Revise su conexión o escríbanos por WhatsApp; igual puede armar su lista a mano.";
      v.hidden = false;
      return;
    }
    pintarChips();
    pintarProductos();
  });
})();
