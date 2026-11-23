(function () {
  "use strict";

  // Anti-clickjacking: el panel no funciona dentro de un iframe
  if (window.top !== window.self) {
    try { window.top.location = window.self.location; } catch { /* bloqueado */ }
    document.documentElement.replaceChildren();
    return;
  }
  document.documentElement.classList.add("panel-ok");

  const C = window.APP_CONFIG, db = window.db, U = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const INACTIVIDAD_MIN = 30;

  let categorias = [], productos = [], ajustesCache = {};
  let V4 = false;          // la base ya tiene las mejoras v4
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const SIN_FOTO = `<svg viewBox="0 0 48 48" width="28" height="28" aria-hidden="true"><rect x="7" y="11" width="34" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="21" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 35l10-9 7 6 5-4 9 7" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  let factorPendiente = null;

  const VISTAS = ["vLogin", "vEnrolar", "vDesafio", "vSinPermiso", "vSinConfig", "vPanel"];
  function vista(id) { VISTAS.forEach((v) => ($("#" + v).hidden = v !== id)); const f = $("#" + id + " input:not([type=hidden])"); if (f) f.focus(); }

  function toast(txt, error = false) {
    const t = $("#toast");
    t.textContent = txt;
    t.classList.toggle("aviso-toast--error", error);
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 3500);
  }
  const errTxt = (e) => U.esErrorRed(e) ? "Sin internet: esto se puede hacer cuando vuelva la conexión." : (e && e.message) || "Algo falló. Intente de nuevo.";

  // =========================================================
  //  SIN INTERNET: copia de datos, permiso y ventas por enviar
  // =========================================================
  const LS_COLA = "lc_ventas_sin_red_v1", LS_COPIA = "lc_copia_panel_v1", LS_PERMISO = "lc_panel_sin_red_v1", LS_NUM = "lc_sin_red_num_v1";
  const HORAS_SIN_RED = 12;
  let SIN_RED = false;     // panel abierto sin conexión (con la copia de la última vez)
  let V9 = false;          // la base tiene código y existencia en productos (v9_inventario.sql)
  let V10 = false;         // la base tiene facturación electrónica (v10_facturacion.sql)
  let FE = null;           // datos del emisor (fe_emisor)
  let V11 = false;         // la base tiene historial de precios (v11_precios.sql)
  let V12 = false;         // la base lleva inventario (v12_inventario.sql)
  const MAX_LISTA_PROD = 150;
  let V5 = true;           // la base tiene registrar_venta_sin_internet

  const leerLS = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? def; } catch { return def; } };
  const ponerLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  const copia = {
    leer: () => leerLS(LS_COPIA, {}),
    poner(k, v) { const c = copia.leer(); c[k] = v; ponerLS(LS_COPIA, c); },
    detalle(id, d) {
      const c = copia.leer(), det = c.detalles || {};
      det[id] = { ...d, t: Date.now() };
      const ids = Object.keys(det).sort((a, b) => det[b].t - det[a].t);
      ids.slice(60).forEach((x) => delete det[x]);          // solo las últimas 60 ventas abiertas
      c.detalles = det; ponerLS(LS_COPIA, c);
    },
    borrar() { try { localStorage.removeItem(LS_COPIA); localStorage.removeItem(LS_PERMISO); } catch { /* */ } }
  };

  const cola = {
    leer: () => { const l = leerLS(LS_COLA, []); return Array.isArray(l) ? l : []; },
    escribir: (l) => ponerLS(LS_COLA, l),
    buscar: (id) => cola.leer().find((r) => r.id === id),
    guardar(rec) { const l = cola.leer(), i = l.findIndex((r) => r.id === rec.id); if (i >= 0) l[i] = rec; else l.push(rec); return cola.escribir(l); },
    quitar(id) { cola.escribir(cola.leer().filter((r) => r.id !== id)); }
  };
  const numTemporal = () => { const n = (Number(leerLS(LS_NUM, 0)) || 0) + 1; ponerLS(LS_NUM, n); return "SIN-" + String(n).padStart(4, "0"); };

  // consulta con respaldo: si no hay internet, devuelve la copia guardada
  async function consulta(clave, q) {
    if (SIN_RED) { const d = copia.leer()[clave]; return d !== undefined ? { data: d, error: null, deCopia: true } : { data: null, error: { message: "Failed to fetch" } }; }
    let r;
    try { r = await q; } catch (e) { r = { data: null, error: e }; }
    if (!r.error) { copia.poner(clave, r.data); return r; }
    if (U.esErrorRed(r.error)) { const d = copia.leer()[clave]; if (d !== undefined) return { data: d, error: null, deCopia: true }; }
    return r;
  }

  function conTiempo(p, ms) {
    return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej({ message: "timeout" }), ms))]);
  }

  function estadoRedPanel() {
    const n = cola.leer().filter((r) => !r.error).length;
    if (!navigator.onLine) {
      U.banda(`Sin internet. Puede hacer ventas nuevas e imprimirlas: se guardan en esta compu y se envían solas cuando vuelva la conexión.${n ? ` Por enviar: ${n}.` : ""}`);
    } else if (SIN_RED) {
      U.banda(`Volvió el internet.${n ? ` Entre de nuevo para enviar ${n === 1 ? "la venta guardada" : `las ${n} ventas guardadas`}.` : ""}`, "ok", { texto: "Entrar", accion: () => location.reload() });
    } else {
      const b = $("#bandaRed");
      if (b && !b.hidden && !b.dataset.fija) U.banda("");
      enviarCola();
    }
  }

  // =========================================================
  //  ACCESO: contraseña → (registrar MFA) → código → panel
  // =========================================================
  async function siguientePaso() {
    let session = null;
    try { ({ data: { session } } = await db.auth.getSession()); } catch { /* sin conexión */ }
    if (!navigator.onLine) return entrarSinRed();
    if (!session) return vista("vLogin");

    let reg;
    try { reg = await conTiempo(db.rpc("soy_admin_registrado"), 12000); } catch (e) { reg = { error: e }; }
    if (reg.error && U.esErrorRed(reg.error)) return entrarSinRed();
    if (reg.error || reg.data !== true) return vista("vSinPermiso");

    const { data: aal, error: aErr } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aErr) return vista("vLogin");
    if (aal.currentLevel === "aal2") return abrirPanel(session.user);

    const { data: f, error: fErr } = await db.auth.mfa.listFactors();
    if (fErr) { toast(errTxt(fErr), true); return vista("vLogin"); }
    const verificado = (f.totp || []).find((x) => x.status === "verified");
    if (verificado) { factorPendiente = verificado.id; return vista("vDesafio"); }
    return prepararEnrolamiento(f.all || []);
  }

  async function prepararEnrolamiento(todos) {
    // Limpia intentos anteriores sin terminar
    for (const x of todos.filter((x) => x.status === "unverified")) {
      await db.auth.mfa.unenroll({ factorId: x.id });
    }
    const { data, error } = await db.auth.mfa.enroll({ factorType: "totp", friendlyName: "La Campiña " + new Date().toISOString().slice(0, 10) });
    if (error) { toast(errTxt(error), true); return vista("vLogin"); }
    factorPendiente = data.id;
    // Supabase entrega el QR como SVG (a veces en data-URL "utf-8," sin codificar): se normaliza a blob
    const qr = String(data.totp.qr_code || "");
    let svg = qr;
    if (qr.startsWith("data:")) {
      const i = qr.indexOf(","), meta = qr.slice(0, i);
      svg = qr.slice(i + 1);
      if (/;base64/i.test(meta)) svg = atob(svg);
      else { try { svg = decodeURIComponent(svg); } catch { /* ya venía sin codificar */ } }
    }
    $("#qrMfa").src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    $("#secretoMfa").textContent = data.totp.secret;
    vista("vEnrolar");
  }

  async function verificarCodigo(form, msgEl) {
    const code = form.code.value.replace(/\D/g, "");
    if (code.length !== 6) { msgEl.textContent = "El código tiene 6 dígitos."; return; }
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true; msgEl.textContent = "";
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId: factorPendiente, code });
    btn.disabled = false;
    if (error) { msgEl.textContent = "Código incorrecto o vencido. Use el que aparece ahora en la app."; form.code.value = ""; form.code.focus(); return; }
    form.reset();
    siguientePaso();
  }

  // Sin internet solo entra si en este aparato ya se entró con internet (contraseña + código) en las últimas horas
  function entrarSinRed() {
    const p = leerLS(LS_PERMISO, null), c = copia.leer();
    if (p && p.hasta > Date.now() && Array.isArray(c.ventas)) return abrirPanel({ email: p.email }, true);
    vista("vLogin");
    $("#loginMsg").textContent = "No hay internet. Para poder usar el panel sin internet, primero entre una vez con internet en esta compu.";
  }

  async function salir(motivo) {
    if (!motivo) {
      const n = cola.leer().length;
      if (n && !confirm(`Hay ${n} venta(s) hechas sin internet que todavía no se han enviado. Quedan guardadas en esta compu y se envían la próxima vez que entre. ¿Salir?`)) return;
      copia.borrar();      // al salir a propósito se borra la copia de ventas y clientes de esta compu
    }
    try { await db.auth.signOut(); } catch { /* ya no hay sesión */ }
    location.replace(location.pathname + (motivo ? "?" + motivo : ""));
  }

  function initAcceso() {
    if (!db) return vista("vSinConfig");

    if (new URLSearchParams(location.search).has("inactivo")) {
      $("#loginMsg").textContent = "Se cerró la sesión por inactividad.";
    }

    $("#formLogin").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget, btn = f.querySelector("button");
      btn.disabled = true; $("#loginMsg").textContent = "";
      const { error } = await db.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      btn.disabled = false;
      f.password.value = "";
      if (error) { $("#loginMsg").textContent = "Correo o contraseña incorrectos."; return; }
      siguientePaso();
    });
    $("#formEnrolar").addEventListener("submit", (e) => { e.preventDefault(); verificarCodigo(e.currentTarget, $("#enrolarMsg")); });
    $("#formDesafio").addEventListener("submit", (e) => { e.preventDefault(); verificarCodigo(e.currentTarget, $("#desafioMsg")); });
    $$("[data-salir]").forEach((b) => b.addEventListener("click", () => salir()));

    db.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") vista("vLogin"); });
    siguientePaso();
  }

  // Cierre de sesión por inactividad
  function vigilarInactividad() {
    let t;
    const reiniciar = () => { clearTimeout(t); t = setTimeout(() => salir("inactivo"), INACTIVIDAD_MIN * 60 * 1000); };
    ["click", "keydown", "pointermove", "touchstart", "scroll"].forEach((ev) => addEventListener(ev, reiniciar, { passive: true }));
    reiniciar();
  }

  // =========================================================
  //  PANEL
  // =========================================================
  let panelListo = false;
  async function abrirPanel(user, sinRed = false) {
    SIN_RED = sinRed;
    vista("vPanel");
    $("#userEmail").textContent = user.email || "";
    if (!sinRed) ponerLS(LS_PERMISO, { email: user.email, hasta: Date.now() + HORAS_SIN_RED * 3600 * 1000 });
    if (panelListo) return;
    panelListo = true;
    vigilarInactividad();
    pintarDiasHorario();
    if (sinRed) { V4 = !!copia.leer().v4; V9 = !!copia.leer().v9; }
    else {
      let r;
      try { r = await db.from("avisos").select("id").limit(1); } catch (e) { r = { error: e }; }
      V4 = r.error && U.esErrorRed(r.error) ? !!copia.leer().v4 : !r.error;
      if (!r.error || !U.esErrorRed(r.error)) copia.poner("v4", V4);
      let r9;
      try { r9 = await db.from("productos").select("codigo").limit(1); } catch (e) { r9 = { error: e }; }
      V9 = r9.error && U.esErrorRed(r9.error) ? !!copia.leer().v9 : !r9.error;
      if (!r9.error || !U.esErrorRed(r9.error)) copia.poner("v9", V9);
      let r10;
      try { r10 = await db.from("fe_emisor").select("*").eq("id", 1).maybeSingle(); } catch (e) { r10 = { error: e }; }
      V10 = !r10.error; FE = r10.data || null;
      let r11;
      try { r11 = await db.from("precios_movimientos").select("id").limit(1); } catch (e) { r11 = { error: e }; }
      V11 = !r11.error;
      let r12;
      try { r12 = await db.from("entradas").select("id").limit(1); } catch (e) { r12 = { error: e }; }
      V12 = !r12.error;
    }
    document.documentElement.classList.toggle("sin-v11", !V11);
    document.documentElement.classList.toggle("sin-v12", !V12);
    $("#tabInv").hidden = !V12;
    $("#tabComp").hidden = !V10;
    document.documentElement.classList.toggle("sin-v10", !V10);
    if (V10) pintarConfFE();
    document.documentElement.classList.toggle("sin-v4", !V4);
    document.documentElement.classList.toggle("sin-v9", !V9);
    $("#avisoV4").hidden = V4;
    await cargarCategorias();
    await Promise.all([cargarProductos(), cargarAjustes(), contarPorVerificar(), V4 && !sinRed ? cargarAvisos() : null]);
    await cargarVentas();
    cargarPreguntas();
    addEventListener("online", estadoRedPanel);
    addEventListener("offline", estadoRedPanel);
    estadoRedPanel();
    irA(new URLSearchParams(location.search).get("ir"));
    setInterval(() => {
      if (document.hidden) return;
      enviarCola();
      if (!SIN_RED && navigator.onLine && !$("#dlgVenta").open) { cargarVentas(); contarPorVerificar(); cargarPreguntas(); }
    }, 60000);
  }

  // ---------- como programa (app instalada) ----------
  // los accesos directos del ícono abren admin.html?ir=venta|productos|caja
  function irA(destino) {
    if (!destino) return;
    history.replaceState(null, "", location.pathname);
    const tab = { venta: "#tabVen", productos: "#tabProd", caja: "#tabCaja" }[destino];
    if (tab) $(tab).click();
    if (destino === "venta" && !$("#dlgVenta").open) $("#btnNuevaVenta").click();
  }
  // si el panel ya está abierto y se toca un acceso directo, llega aquí (launch_handler: focus-existing)
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer((p) => {
      if (!panelListo || !p.targetURL) return;
      irA(new URL(p.targetURL).searchParams.get("ir"));
    });
  }
  let pedirInstalar = null;
  const yaInstalado = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    pedirInstalar = e;
    $("#btnInstalar").hidden = yaInstalado();
  });
  addEventListener("appinstalled", () => {
    pedirInstalar = null;
    $("#btnInstalar").hidden = true;
    toast("Listo: el panel quedó instalado. Ábralo desde el ícono del escritorio o del menú Inicio.");
  });
  $("#btnInstalar").addEventListener("click", async () => {
    if (!pedirInstalar) return;
    pedirInstalar.prompt();
    const r = await pedirInstalar.userChoice.catch(() => null);
    if (r && r.outcome === "accepted") $("#btnInstalar").hidden = true;
    pedirInstalar = null;
  });

  // ---------- pestañas ----------
  $$(".pestana").forEach((tab) => tab.addEventListener("click", () => {
    $$(".pestana").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $$("[role=tabpanel]").forEach((p) => (p.hidden = p.id !== tab.getAttribute("aria-controls")));
    if (tab.id === "tabAj") { cargarAuditoria(); cargarEspacio(); pintarUltimoRespaldo(); }
    if (tab.id === "tabVen") cargarVentas();
    if (tab.id === "tabCaja") cargarCaja();
    if (tab.id === "tabPreg") cargarPreguntas();
    if (tab.id === "tabRep") cargarReportes();
    if (tab.id === "tabComp") cargarComprobantes();
    if (tab.id === "tabInv") cargarInventario();
  }));
  $(".pestanas").addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    const tabs = $$(".pestana"), i = tabs.indexOf(document.activeElement);
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); n.click();
  });

  // ---------- CATEGORÍAS ----------
  async function cargarCategorias() {
    const { data, error } = await consulta("categorias", db.from("categorias").select("*").order("orden"));
    if (error) return toast(errTxt(error), true);
    categorias = data;
    $("#listaCat").innerHTML = categorias.map((c) => `
      <li class="fila">
        <div class="fila__txt"><b>${U.esc(c.nombre)}</b><small>Orden ${Number(c.orden) || 0} · ${productos.filter((p) => p.categoria_id === c.id).length} productos</small></div>
        <div class="fila__acc">
          <button type="button" class="btn btn--sm btn--linea" data-edit-cat="${c.id}">Editar</button>
          <button type="button" class="enlace enlace--peligro" data-del-cat="${c.id}">Borrar</button>
        </div>
      </li>`).join("") || `<li class="vacio-adm">Aún no hay categorías.</li>`;
    $("#formProd [name=categoria_id]").innerHTML = `<option value="">Sin categoría</option>` +
      categorias.map((c) => `<option value="${c.id}">${U.esc(c.nombre)}</option>`).join("");
  }

  function modoCat(c) {
    const f = $("#formCat");
    f.id.value = c?.id || "";
    f.nombre.value = c?.nombre || "";
    f.orden.value = c?.orden ?? 0;
    $("#btnGuardarCat").textContent = c ? "Guardar cambios" : "Agregar categoría";
    $("#btnCancelarCat").hidden = !c;
    if (c) f.nombre.focus();
  }

  $("#formCat").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const d = { nombre: f.nombre.value.trim(), orden: Math.max(0, parseInt(f.orden.value, 10) || 0) };
    const { error } = f.id.value ? await db.from("categorias").update(d).eq("id", f.id.value) : await db.from("categorias").insert(d);
    if (error) return toast(errTxt(error), true);
    toast(f.id.value ? "Categoría actualizada" : "Categoría agregada");
    modoCat(null);
    await cargarCategorias();
    pintarProductos();
  });
  $("#formCat").addEventListener("reset", (e) => { e.preventDefault(); modoCat(null); });

  $("#listaCat").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.editCat) modoCat(categorias.find((x) => x.id == b.dataset.editCat));
    if (b.dataset.delCat) {
      const c = categorias.find((x) => x.id == b.dataset.delCat);
      if (!confirm(`¿Borrar la categoría “${c.nombre}”? Sus productos quedan sin categoría.`)) return;
      const { error } = await db.from("categorias").delete().eq("id", c.id);
      if (error) return toast(errTxt(error), true);
      toast("Categoría borrada");
      await cargarCategorias();
      await cargarProductos();
    }
  });

  // ---------- PRODUCTOS ----------
  // copia liviana para usar sin internet (con miles de productos no cabe todo)
  const productoCorto = (p) => ({ id: p.id, nombre: p.nombre, codigo: p.codigo, precio: p.precio, unidad: p.unidad, categoria_id: p.categoria_id,
    activo: p.activo, agotado: p.agotado, destacado: p.destacado, existencia: p.existencia });
  async function cargarProductos() {
    let data = null, error = null;
    if (SIN_RED) data = copia.leer().productos || null;
    else {
      try { data = await leerTabla("productos", "nombre"); } catch (e) { error = e; }
      if (error && U.esErrorRed(error)) { data = copia.leer().productos || null; error = data ? null : error; }
      else if (!error) copia.poner("productos", data.map(productoCorto));
    }
    if (error || !data) return toast(errTxt(error || { message: "Failed to fetch" }), true);
    productos = data;
    V9 = V9 || productos.some((p) => "codigo" in p) || !!copia.leer().v9;
    document.documentElement.classList.toggle("sin-v9", !V9);
    if (!SIN_RED && !error) copia.poner("v9", V9);
    pintarProductos();
  }

  const hoyCRp = () => new Intl.DateTimeFormat("en-CA", { timeZone: C.ZONA_HORARIA }).format(new Date());
  const ofertaVigente = (p) => p.precio_oferta != null && !!p.oferta_hasta && String(p.oferta_hasta) >= hoyCRp();
  let filtroProd = "todos";
  const PASA_PROD = { todos: () => true, agotados: (p) => p.agotado, ofertas: ofertaVigente, sinprecio: (p) => p.precio == null, ocultos: (p) => !p.activo };
  function pintarProductos() {
    const q = norm($("#aBuscar").value);
    const todos = productos.filter((p) => PASA_PROD[filtroProd](p) && (!q || norm(p.nombre).includes(q) || (p.codigo && String(p.codigo).toLowerCase().includes(q))));
    const lista = todos.slice(0, MAX_LISTA_PROD);
    const cat = (id) => categorias.find((c) => c.id === id);
    $("#listaProd").innerHTML = lista.map((p) => {
      const c = cat(p.categoria_id);
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      return `<li class="fila ${p.activo ? "" : "fila--oculta"}">
        <span class="fila__img">${url ? `<img src="${U.esc(url)}" alt="" loading="lazy" />` : SIN_FOTO}</span>
        <div class="fila__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${p.codigo ? `Cód. ${U.esc(p.codigo)} · ` : ""}${U.esc(c?.nombre || "Sin categoría")} · ${U.colones(p.precio) ? U.esc(U.colones(p.precio)) + (p.unidad ? " por " + U.esc(p.unidad) : "") : "Precio a consultar"}${p.existencia != null ? ` · Existencia: ${Number(p.existencia).toLocaleString("es-CR")}` : ""}</small>
          <span class="etiquetas">${p.destacado ? '<span class="etq etq--rec">Recomendado</span>' : ""}${p.activo ? "" : '<span class="etq">Oculto</span>'}${p.agotado ? '<span class="etq etq--sin_pago">Agotado</span>' : ""}${ofertaVigente(p) ? `<span class="etq etq--por_verificar">Oferta ${U.esc(U.colones(p.precio_oferta))} hasta ${U.esc(String(p.oferta_hasta).split("-").reverse().join("/"))}</span>` : p.oferta_hasta ? '<span class="etq">Oferta vencida</span>' : ""}</span>
        </div>
        <div class="fila__acc">
          ${V4 ? `<button type="button" class="btn btn--sm ${p.agotado ? "btn--negro" : "btn--linea"}" data-agotado="${p.id}">${p.agotado ? "Ya hay" : "Agotado"}</button>` : ""}
          <button type="button" class="btn btn--sm btn--linea" data-edit="${p.id}">Editar</button>
          <button type="button" class="enlace enlace--peligro" data-del="${p.id}">Borrar</button>
        </div>
      </li>`;
    }).join("") + (todos.length > lista.length ? `<li class="vacio-adm">Se muestran ${lista.length} de ${todos.length.toLocaleString("es-CR")} productos. Escriba en el buscador (nombre o código) para encontrar los demás.</li>` : "")
      || `<li class="vacio-adm">${q || filtroProd !== "todos" ? "Ningún producto en este grupo." : "Agregue el primer producto con el botón Nuevo producto."}</li>`;
  }
  $("#aBuscar").addEventListener("input", pintarProductos);
  $("#filtroProd").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fp]");
    if (!b) return;
    filtroProd = b.dataset.fp;
    $$("#filtroProd [data-fp]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarProductos();
  });

  const dlg = $("#dlgProd"), fp = $("#formProd");
  function abrirProducto(p) {
    fp.reset();
    $("#prodMsg").textContent = "";
    $("#dlgTitulo").textContent = p ? "Editar producto" : "Nuevo producto";
    $("#btnGuardarProd").textContent = p ? "Guardar cambios" : "Guardar producto";
    fp.id.value = p?.id || "";
    fp.nombre.value = p?.nombre || "";
    fp.descripcion.value = p?.descripcion || "";
    fp.precio.value = p?.precio ?? "";
    fp.unidad.value = p?.unidad || "";
    fp.categoria_id.value = p?.categoria_id || "";
    fp.destacado.checked = !!p?.destacado;
    fp.activo.checked = p ? !!p.activo : true;
    fp.agotado.checked = !!p?.agotado;
    fp.codigo.value = p?.codigo || "";
    fp.iva_codigo.value = p?.iva_codigo || "08";
    fp.existencia.value = p?.existencia ?? "";
    fp.precio_oferta.value = p?.precio_oferta ?? "";
    fp.oferta_hasta.value = p?.oferta_hasta || "";
    fp.oferta_hasta.min = hoyCRp();
    const prev = $("#prevFoto"), url = p?.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
    prev.hidden = !url; prev.src = url;
    dlg.showModal();
    fp.nombre.focus();
  }
  $("#btnNuevoProd").addEventListener("click", () => abrirProducto(null));
  $("#btnCancelarProd").addEventListener("click", () => dlg.close());
  fp.foto.addEventListener("change", () => {
    const f = fp.foto.files[0], prev = $("#prevFoto");
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { $("#prodMsg").textContent = "Use una foto JPG, PNG o WebP."; fp.foto.value = ""; return; }
    if (f.size > 15 * 1024 * 1024) { $("#prodMsg").textContent = "La foto es muy pesada (más de 15 MB)."; fp.foto.value = ""; return; }
    $("#prodMsg").textContent = "";
    prev.src = URL.createObjectURL(f); prev.hidden = false;
  });

  $("#listaProd").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.edit) abrirProducto(productos.find((p) => p.id == b.dataset.edit));
    if (b.dataset.agotado) {
      const p = productos.find((x) => x.id == b.dataset.agotado);
      b.disabled = true;
      const { error } = await db.from("productos").update({ agotado: !p.agotado }).eq("id", p.id);
      if (error) { b.disabled = false; return toast(errTxt(error), true); }
      p.agotado = !p.agotado;
      toast(p.agotado ? `${p.nombre}: marcado agotado` : `${p.nombre}: disponible de nuevo`);
      pintarProductos();
    }
    if (b.dataset.del) {
      const p = productos.find((x) => x.id == b.dataset.del);
      if (!confirm(`¿Borrar “${p.nombre}”? Si solo quiere esconderlo, use Editar y quite “Mostrar en el sitio”.`)) return;
      const { error } = await db.from("productos").delete().eq("id", p.id);
      if (error) return toast(errTxt(error), true);
      await borrarFoto(p.imagen_url);
      toast("Producto borrado");
      cargarProductos();
    }
  });

  // Reescala a máx. 1200 px y re-codifica (también elimina datos EXIF/GPS de la foto)
  function comprimir(file, max = 1200) {
    return new Promise((res, rej) => {
      const img = new Image(), src = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(src);
        cv.toBlob((b) => {
          if (b && b.type === "image/webp") return res(b);
          cv.toBlob((j) => (j ? res(j) : rej(new Error("No se pudo procesar la foto."))), "image/jpeg", 0.85);
        }, "image/webp", 0.82);
      };
      img.onerror = () => rej(new Error("El archivo no es una imagen válida."));
      img.src = src;
    });
  }

  async function subirFoto(file) {
    const blob = await comprimir(file);
    if (blob.size > 2 * 1024 * 1024) throw new Error("La foto sigue pesando más de 2 MB.");
    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    const ruta = `${crypto.randomUUID()}.${ext}`;
    const { error } = await db.storage.from(C.BUCKET).upload(ruta, blob, { contentType: blob.type, upsert: false, cacheControl: "31536000" });
    if (error) throw error;
    return db.storage.from(C.BUCKET).getPublicUrl(ruta).data.publicUrl;
  }

  async function borrarFoto(url) {
    if (!url) return;
    const marca = `/object/public/${C.BUCKET}/`, i = url.indexOf(marca);
    if (i === -1) return;
    await db.storage.from(C.BUCKET).remove([decodeURIComponent(url.slice(i + marca.length))]);
  }

  fp.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#btnGuardarProd");
    btn.disabled = true;
    $("#prodMsg").textContent = "";
    let nuevaFoto = null;
    try {
      const id = fp.id.value;
      const anterior = id ? productos.find((p) => p.id == id) : null;
      const d = {
        nombre: fp.nombre.value.trim(),
        descripcion: fp.descripcion.value.trim() || null,
        precio: fp.precio.value === "" ? null : Math.max(0, Number(fp.precio.value)),
        unidad: fp.unidad.value.trim() || null,
        categoria_id: fp.categoria_id.value ? Number(fp.categoria_id.value) : null,
        destacado: fp.destacado.checked,
        activo: fp.activo.checked
      };
      if (d.nombre.length < 2) throw new Error("Escriba el nombre del producto.");
      if (V4) {
        d.agotado = fp.agotado.checked;
        const po = fp.precio_oferta.value === "" ? null : Number(fp.precio_oferta.value), hasta = fp.oferta_hasta.value || null;
        if ((po == null) !== (hasta == null)) throw new Error("Para la oferta ponga el precio de oferta y la fecha hasta cuándo vale (o deje los dos vacíos).");
        if (po != null && !(po > 0)) throw new Error("El precio de oferta debe ser mayor que 0.");
        if (po != null && d.precio != null && po >= d.precio) throw new Error("El precio de oferta debe ser menor que el precio normal.");
        d.precio_oferta = po; d.oferta_hasta = hasta;
      }
      if (V10) d.iva_codigo = fp.iva_codigo.value;
      if (V9) {
        const cod = fp.codigo.value.replace(/[\s'"]/g, "");
        if (cod.length > 40) throw new Error("El código es muy largo (máximo 40 caracteres).");
        d.codigo = cod || null;
        d.existencia = fp.existencia.value === "" ? null : Math.round(Number(fp.existencia.value) * 100) / 100;
        if (d.existencia != null && !Number.isFinite(d.existencia)) throw new Error("La existencia debe ser un número.");
        // si viene de Moriah sin existencia, se marca agotado (lo mismo que hace la importación)
        if (d.existencia != null && d.existencia <= 0 && String(anterior?.existencia ?? "") !== String(d.existencia)) d.agotado = true;
        if (d.codigo) {
          const otro = productos.find((x) => x.codigo && String(x.codigo) === d.codigo && x.id != id);
          if (otro) throw new Error(`Ese código ya lo tiene “${otro.nombre}”. Si es el mismo producto, borre uno de los dos (o quítele el código) y vuelva a intentar.`);
        }
      }
      if (fp.foto.files[0]) { btn.textContent = "Subiendo foto…"; nuevaFoto = await subirFoto(fp.foto.files[0]); d.imagen_url = nuevaFoto; }
      const { error } = id ? await db.from("productos").update(d).eq("id", id) : await db.from("productos").insert(d);
      if (error) throw error.code === "23505" ? new Error("Ese código ya lo tiene otro producto.") : error;
      if (nuevaFoto && anterior?.imagen_url) await borrarFoto(anterior.imagen_url);
      dlg.close();
      toast(id ? "Producto actualizado" : "Producto guardado");
      cargarProductos();
    } catch (err) {
      if (nuevaFoto) await borrarFoto(nuevaFoto);   // no dejar fotos huérfanas
      $("#prodMsg").textContent = errTxt(err);
    } finally {
      btn.disabled = false;
      btn.textContent = fp.id.value ? "Guardar cambios" : "Guardar producto";
    }
  });

  // ---------- AJUSTES ----------
  const ORDEN_DIAS = [1, 2, 3, 4, 5, 6, 0];
  function pintarDiasHorario() {
    $("#horarioDias").innerHTML = ORDEN_DIAS.map((d) => `
      <div class="dia" data-dia="${d}">
        <label class="check"><input type="checkbox" data-abre /> ${U.DIAS[d]}</label>
        <input type="time" data-de value="07:00" aria-label="${U.DIAS[d]}: abre a las" />
        <span aria-hidden="true">a</span>
        <input type="time" data-a value="17:00" aria-label="${U.DIAS[d]}: cierra a las" />
      </div>`).join("");
    $$("#horarioDias [data-abre]").forEach((c) => c.addEventListener("change", sincDias));
    sincDias();
  }
  function sincDias() {
    $$("#horarioDias .dia").forEach((row) => {
      const on = row.querySelector("[data-abre]").checked;
      row.querySelectorAll("input[type=time]").forEach((i) => (i.disabled = !on));
      row.classList.toggle("dia--cerrado", !on);
    });
  }

  async function cargarAjustes() {
    const { data, error } = await consulta("ajustes", db.from("ajustes").select("*"));
    if (error) return toast(errTxt(error), true);
    const f = $("#formAjustes");
    ajustesCache = Object.fromEntries(data.map((r) => [r.clave, r.valor || ""]));
    data.forEach((r) => { if (f.elements[r.clave] && !["horario_semana", "envio_activo"].includes(r.clave)) f.elements[r.clave].value = r.valor || ""; });
    f.envio_activo.checked = ajustesCache.envio_activo === "si";
    const h = U.parseHorario((data.find((r) => r.clave === "horario_semana") || {}).valor);
    if (h) {
      $$("#horarioDias .dia").forEach((row) => {
        const d = Number(row.dataset.dia), v = h[d];
        row.querySelector("[data-abre]").checked = !!v;
        if (v) { row.querySelector("[data-de]").value = v[0]; row.querySelector("[data-a]").value = v[1]; }
      });
      sincDias();
    }
  }

  $("#formAjustes").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#ajMsg");
    if (!f.reportValidity()) return;
    const horario = {};
    for (const row of $$("#horarioDias .dia")) {
      const d = row.dataset.dia;
      if (!row.querySelector("[data-abre]").checked) { horario[d] = null; continue; }
      const de = row.querySelector("[data-de]").value, a = row.querySelector("[data-a]").value;
      if (!de || !a || de >= a) { msg.textContent = `Revise el horario del ${U.DIAS[d].toLowerCase()}: la hora de cierre debe ser después de la de apertura.`; msg.className = "msg msg--error"; return; }
      horario[d] = [de, a];
    }
    const filas = ["telefono", "telefono2", "whatsapp", "direccion", "facebook", "horario", "aviso", "sinpe_numero", "sinpe_titular"]
      .map((k) => ({ clave: k, valor: String(f.elements[k].value).trim() }));
    filas.push({ clave: "horario_semana", valor: Object.values(horario).some(Boolean) ? JSON.stringify(horario) : "" });
    if (V4) {
      const lineas = String(f.envio_zonas.value).split("\n").map((l) => l.trim()).filter(Boolean);
      const RE_Z = /^\s*([^=|:]{2,60}?)\s*[=|:]\s*₡?\s*([0-9][0-9 .,]{0,9})\s*$/;
      const malas = lineas.filter((l) => !RE_Z.test(l));
      if (malas.length) { msg.textContent = `Estas zonas no se entienden: “${malas.slice(0, 3).join("”, “")}”. Use el formato: Nombre = precio.`; msg.className = "msg msg--error"; return; }
      if (f.envio_activo.checked && !lineas.length) { msg.textContent = "Para ofrecer envío escriba al menos una zona con su precio."; msg.className = "msg msg--error"; return; }
      filas.push({ clave: "envio_activo", valor: f.envio_activo.checked ? "si" : "no" },
        { clave: "envio_zonas", valor: lineas.join("\n") }, { clave: "envio_nota", valor: f.envio_nota.value.trim() });
    }
    const { error } = await db.from("ajustes").upsert(filas);
    if (!error) filas.forEach((r) => (ajustesCache[r.clave] = r.valor));
    msg.className = "msg" + (error ? " msg--error" : "");
    msg.textContent = error ? errTxt(error) : "Datos guardados. Ya se ven en el sitio.";
  });

  async function cargarAuditoria() {
    const { data, error } = await db.from("auditoria").select("tabla,accion,registro,creado").order("creado", { ascending: false }).limit(25);
    if (error) return;
    const acc = { INSERT: "agregó", UPDATE: "cambió", DELETE: "borró" };
    $("#listaAuditoria").innerHTML = data.map((a) =>
      `<li><time>${new Date(a.creado).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" })}</time> ${acc[a.accion] || U.esc(a.accion)} en ${U.esc(a.tabla)} <small>#${U.esc(a.registro)}</small></li>`
    ).join("") || "<li>Sin movimientos todavía.</li>";
  }

  // ---------- avisos por Telegram ----------
  async function cargarAvisos() {
    const { data, error } = await db.from("avisos").select("*").eq("id", 1).maybeSingle();
    if (error || !data) return;
    const f = $("#formAvisos");
    f.telegram_token.value = data.telegram_token || "";
    f.telegram_chat.value = data.telegram_chat || "";
    f.activo.checked = !!data.activo;
  }
  function msgAviso(txt, error) { const m = $("#avisoMsg"); m.textContent = txt; m.className = "msg" + (error ? " msg--error" : ""); }
  async function guardarAvisos() {
    const f = $("#formAvisos");
    const d = { telegram_token: f.telegram_token.value.trim() || null, telegram_chat: f.telegram_chat.value.trim() || null, activo: f.activo.checked };
    if (d.telegram_token && !/^[0-9]{5,15}:[A-Za-z0-9_-]{30,60}$/.test(d.telegram_token)) { msgAviso("El token no tiene la forma correcta: son números, dos puntos y letras (lo da @BotFather).", true); return false; }
    if (d.telegram_chat && !/^-?[0-9]{4,20}$/.test(d.telegram_chat)) { msgAviso("El chat (Id) son solo números.", true); return false; }
    if (d.activo && (!d.telegram_token || !d.telegram_chat)) { msgAviso("Para encender los avisos ponga el token y el chat.", true); return false; }
    const { error } = await db.from("avisos").update(d).eq("id", 1);
    if (error) { msgAviso(errTxt(error), true); return false; }
    msgAviso(d.activo ? "Avisos guardados y encendidos." : "Guardado. Los avisos están apagados.");
    return true;
  }
  $("#formAvisos").addEventListener("submit", (e) => { e.preventDefault(); guardarAvisos(); });
  $("#btnProbarAviso").addEventListener("click", async () => {
    const b = $("#btnProbarAviso");
    if (!(await guardarAvisos())) return;
    b.disabled = true;
    msgAviso("Enviando prueba…");
    const r = await db.rpc("probar_aviso");
    if (r.error || !r.data?.ok) { b.disabled = false; return msgAviso(r.data?.error || errTxt(r.error), true); }
    setTimeout(async () => {
      const u = await db.rpc("ultimo_aviso");
      b.disabled = false;
      const est = u.data?.estado;
      if (est === 200) msgAviso("Telegram recibió el mensaje. Revise su celular.");
      else if (est === 401 || est === 404) msgAviso("Telegram dice que el token no sirve. Cópielo de nuevo desde @BotFather.", true);
      else if (est === 400 || est === 403) msgAviso("Telegram no pudo escribir a ese chat. Revise el Id y que haya tocado Iniciar en su bot.", true);
      else if (est) msgAviso(`Telegram respondió con el código ${est}. Intente de nuevo en un rato.`, true);
      else msgAviso(u.data?.detalle === "pg_net no está activo" ? "Falta activar la extensión pg_net en Supabase (Database → Extensions)." : "La prueba salió. Si no le llega en un minuto, revise el token y el chat.");
    }, 3500);
  });

  // =========================================================
  //  VENTAS Y PAGOS SINPE
  // =========================================================
  const TZ = C.ZONA_HORARIA;
  const ETQ_PAGO = { sin_pago: "Sin pago", parcial: "Pago parcial", por_verificar: "Por verificar", pagado: "Pagada", sobrepago: "Pagó de más" };
  const ETQ_METODO = { sinpe: "SINPE Móvil", efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta" };
  const fmt = (n) => "₡" + Number(n || 0).toLocaleString("es-CR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const hoyCR = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const fechaCR = (iso, opt = { dateStyle: "medium", timeStyle: "short" }) => new Date(iso).toLocaleString("es-CR", { timeZone: TZ, ...opt });
  function ahoraLocalCR() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  const localCRaISO = (v) => new Date(v + ":00-06:00").toISOString();   // Costa Rica no usa horario de verano
  const rangoDia = (d) => [new Date(d + "T00:00:00-06:00").toISOString(), new Date(new Date(d + "T00:00:00-06:00").getTime() + 864e5).toISOString()];

  let ventas = [], filtroVenta = "nuevos", compNuevos = new Set();
  let V = null;   // venta abierta: { pedido|null, items:[], pagos:[], comps:[], dirty }

  // ---------- lista de ventas ----------
  async function cargarVentas() {
    const { data, error, deCopia } = await consulta("ventas", db.from("pedidos")
      .select("id,codigo,origen,revisado,cliente_nombre,cliente_telefono,estado,estado_pago,total,pagado_registrado,pagado_verificado,created_at")
      .order("created_at", { ascending: false }).limit(500));
    if (error) { pintarVentas(); return toast(errTxt(error), true); }
    ventas = data;
    if (!deCopia) {
      let cn;
      try { cn = await db.from("comprobantes_cliente").select("pedido_id").eq("estado", "nuevo"); } catch { cn = {}; }
      compNuevos = new Set((cn.data || []).map((r) => r.pedido_id));
    }
    const nuevos = ventas.filter(esNuevo).length;
    $("#badgeVen").hidden = $("#badgeNuevos").hidden = !nuevos;
    $("#badgeVen").textContent = $("#badgeNuevos").textContent = nuevos || "";
    pintarCifras();
    pintarVentas();
  }

  const esNuevo = (v) => v.estado !== "anulada" && (!v.revisado || compNuevos.has(v.id));

  function pintarCifras() {
    const mes = hoyCR().slice(0, 7);
    const delMes = ventas.filter((v) => v.estado !== "anulada" && new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(v.created_at)).startsWith(mes));
    const activas = ventas.filter((v) => v.estado !== "anulada");
    const suma = (arr, f) => arr.reduce((a, v) => a + Number(f(v) || 0), 0);
    const cifras = [
      ["Vendido este mes", fmt(suma(delMes, (v) => v.total)), `${delMes.length} ventas`],
      ["Cobrado y verificado (mes)", fmt(suma(delMes, (v) => v.pagado_verificado)), ""],
      ["Por verificar en el banco", fmt(suma(activas, (v) => v.pagado_registrado - v.pagado_verificado)), ""],
      ["Por cobrar", fmt(suma(activas.filter((v) => v.estado === "abierta"), (v) => Math.max(0, v.total - v.pagado_registrado))), ""]
    ];
    $("#cifrasVentas").innerHTML = cifras.map(([t, n, s]) => `<div><dt>${t}</dt><dd>${n}${s ? `<small>${s}</small>` : ""}</dd></div>`).join("");
  }

  function pintarVentas() {
    const q = $("#vBuscar").value.trim().toLowerCase();
    const pasa = {
      nuevos: esNuevo,
      cobrar: (v) => v.estado === "abierta" && ["sin_pago", "parcial"].includes(v.estado_pago),
      por_verificar: (v) => v.estado !== "anulada" && Number(v.pagado_registrado) > Number(v.pagado_verificado),
      entregar: (v) => v.estado === "abierta" && ["pagado", "sobrepago"].includes(v.estado_pago),
      todas: () => true
    }[filtroVenta];
    const lista = ventas.filter((v) => pasa(v) && (!q || v.codigo.toLowerCase().includes(q) || v.cliente_nombre.toLowerCase().includes(q)));
    const locales = cola.leer().filter((r) => !q || r.temp.toLowerCase().includes(q) || String(r.venta.cliente_nombre).toLowerCase().includes(q));
    $("#listaVentas").innerHTML = locales.map((r) => {
      const t = totalesLocal(r.venta);
      return `<li class="fila fila--venta fila--local">
        <span class="codigo">${U.esc(r.temp)}</span>
        <div class="fila__txt">
          <b>${U.esc(r.venta.cliente_nombre)}</b>
          <small>${fechaCR(r.venta.fecha)}${r.venta.cliente_telefono ? " · " + U.esc(r.venta.cliente_telefono) : ""}</small>
          <span class="etiquetas">
            ${r.error ? `<span class="etq etq--error">No se pudo enviar: ${U.esc(r.error)}</span>` : '<span class="etq etq--por_verificar">Por enviar</span>'}
            <span class="etq">Hecha sin internet</span>
          </span>
        </div>
        <div class="fila__monto"><b>${fmt(t.total)}</b>${t.total - t.registrado > 0 ? `<small>Falta ${fmt(t.total - t.registrado)}</small>` : ""}</div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-ver-local="${U.esc(r.id)}">Abrir</button></div>
      </li>`;
    }).join("") + (lista.map((v) => {
      const saldo = Math.max(0, v.total - v.pagado_verificado);
      return `<li class="fila fila--venta ${v.estado === "anulada" ? "fila--oculta" : ""}">
        <span class="codigo">${U.esc(v.codigo)}</span>
        <div class="fila__txt">
          <b>${U.esc(v.cliente_nombre)}</b>
          <small>${fechaCR(v.created_at)}${v.cliente_telefono ? " · " + U.esc(v.cliente_telefono) : ""}</small>
          <span class="etiquetas">
            ${v.origen === "web" ? '<span class="etq etq--web">Pedido web</span>' : ""}
            ${!v.revisado && v.estado !== "anulada" ? '<span class="etq etq--rec">Nuevo</span>' : ""}
            ${compNuevos.has(v.id) ? '<span class="etq etq--por_verificar">Comprobante nuevo</span>' : ""}
            ${v.estado === "anulada" ? '<span class="etq">Anulada</span>' : `<span class="etq etq--${v.estado_pago}">${ETQ_PAGO[v.estado_pago]}</span>`}
            ${v.estado === "entregada" ? '<span class="etq etq--ok">Entregada</span>' : ""}
          </span>
        </div>
        <div class="fila__monto"><b>${fmt(v.total)}</b>${v.estado !== "anulada" && saldo > 0 ? `<small>Falta ${fmt(saldo)}</small>` : ""}</div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-ver-venta="${v.id}">Abrir</button></div>
      </li>`;
    }).join("") || (locales.length ? "" : `<li class="vacio-adm">${filtroVenta === "nuevos" ? "No hay pedidos nuevos. Los pedidos que hagan los clientes en la página aparecen aquí." : filtroVenta === "todas" ? "Todavía no hay ventas." : "No hay ventas en este grupo."}</li>`));
  }

  $("#filtroVentas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    filtroVenta = b.dataset.f;
    $$("#filtroVentas [data-f]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarVentas();
  });
  $("#vBuscar").addEventListener("input", pintarVentas);
  $("#listaVentas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ver-venta]"); if (b) return abrirVenta(Number(b.dataset.verVenta));
    const l = e.target.closest("[data-ver-local]"); if (l) abrirLocal(l.dataset.verLocal);
  });
  $("#btnNuevaVenta").addEventListener("click", () => abrirBorrador({ cliente_nombre: "", cliente_telefono: "", items: [] }));

  // ---------- abrir / borrador ----------
  function abrirBorrador(b) {
    V = { pedido: null, items: b.items, pagos: [], comps: [], dirty: true, uuid: crypto.randomUUID() };
    const f = $("#formVenta");
    f.cliente_nombre.value = b.cliente_nombre || "";
    f.cliente_telefono.value = b.cliente_telefono || "";
    f.nota.value = (b.nota || "").slice(0, 500);
    pintarVenta();
    $("#dlgVenta").showModal();
    f.cliente_nombre.focus();
  }

  function abrirDeCopia(id) {
    const det = (copia.leer().detalles || {})[id];
    if (!det) { toast("Sin internet: esta venta no se ha abierto antes en esta compu. Se podrá ver cuando vuelva la conexión.", true); return; }
    V = { pedido: det.pedido, items: det.items.map((i) => ({ ...i })), pagos: det.pagos, comps: [], factura: det.factura || null, dirty: false, soloLectura: true };
    const f = $("#formVenta");
    f.cliente_nombre.value = det.pedido.cliente_nombre;
    f.cliente_telefono.value = det.pedido.cliente_telefono || "";
    f.nota.value = det.pedido.nota || "";
    pintarVenta();
    if (!$("#dlgVenta").open) $("#dlgVenta").showModal();
  }

  async function abrirVenta(id) {
    if (SIN_RED) return abrirDeCopia(id);
    let p, it, pg, cc;
    try {
      [p, it, pg, cc] = await Promise.all([
        db.from("pedidos").select("*").eq("id", id).single(),
        db.from("pedido_items").select("*").eq("pedido_id", id).order("id"),
        db.from("pagos").select("*").eq("pedido_id", id).order("fecha"),
        db.from("comprobantes_cliente").select("*").eq("pedido_id", id).order("id")
      ]);
    } catch (e) { p = { error: e }; }
    const fallo = p.error || it?.error || pg?.error || cc?.error;
    if (fallo && U.esErrorRed(fallo)) return abrirDeCopia(id);
    if (fallo) return toast(errTxt(fallo), true);
    let fac = { data: null };
    if (V4) { try { fac = await db.from("facturas").select("*").eq("pedido_id", id).maybeSingle(); } catch { fac = { data: null }; } }
    let fe = { data: [] };
    if (V10 && FE?.activo) { try { fe = await db.from("v_fe_documentos").select("*").eq("pedido_id", id).order("id"); } catch { fe = { data: [] }; } }
    V = { pedido: p.data, items: it.data.map((i) => ({ ...i })), pagos: pg.data, comps: cc.data, factura: fac.data || null, fe: fe.data || [], dirty: false };
    copia.detalle(id, { pedido: p.data, items: it.data, pagos: pg.data, factura: fac.data || null });
    if (!p.data.revisado) {
      db.from("pedidos").update({ revisado: true }).eq("id", id).then(({ error }) => { if (!error) { const v = ventas.find((x) => x.id === id); if (v) v.revisado = true; } });
    }
    const f = $("#formVenta");
    f.cliente_nombre.value = p.data.cliente_nombre;
    f.cliente_telefono.value = p.data.cliente_telefono || "";
    f.nota.value = p.data.nota || "";
    pintarVenta();
    if (!$("#dlgVenta").open) $("#dlgVenta").showModal();
  }

  const itemsEditables = () => !V.soloLectura && (!V.pedido || !!V.local || (V.pedido.estado === "abierta" && Number(V.pedido.pagado_verificado) === 0));

  // ---------- ventas hechas sin internet (guardadas en esta compu) ----------
  function totalesLocal(v) {
    const total = (v.items || []).reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
    const registrado = (v.pagos || []).reduce((a, g) => a + Number(g.monto || 0), 0);
    const verificado = (v.pagos || []).filter((g) => g.verificado).reduce((a, g) => a + Number(g.monto || 0), 0);
    return { total, registrado, verificado };
  }
  function pedidoLocal(rec) {
    const t = totalesLocal(rec.venta);
    const estado_pago = t.registrado <= 0 ? "sin_pago" : t.registrado < t.total ? "parcial"
      : t.verificado < t.registrado ? "por_verificar" : t.registrado > t.total ? "sobrepago" : "pagado";
    return { id: null, codigo: rec.temp, estado: "abierta", estado_pago, total: t.total, pagado_registrado: t.registrado, pagado_verificado: t.verificado,
      cliente_nombre: rec.venta.cliente_nombre, cliente_telefono: rec.venta.cliente_telefono, nota: rec.venta.nota, created_at: rec.venta.fecha, local: true };
  }
  function abrirLocal(id) {
    const rec = cola.buscar(id);
    if (!rec) { toast("Esa venta ya se envió."); cargarVentas(); return; }
    V = { local: rec.id, pedido: pedidoLocal(rec), items: rec.venta.items.map((i) => ({ ...i })), pagos: rec.venta.pagos || [], comps: [], factura: null, dirty: false };
    const f = $("#formVenta");
    f.cliente_nombre.value = rec.venta.cliente_nombre;
    f.cliente_telefono.value = rec.venta.cliente_telefono || "";
    f.nota.value = rec.venta.nota || "";
    pintarVenta();
    if (!$("#dlgVenta").open) $("#dlgVenta").showModal();
  }
  function guardarLocal(d, items) {
    const viejo = V.local ? cola.buscar(V.local) : null;
    const rec = viejo
      ? { ...viejo, error: null, venta: { ...viejo.venta, ...d, items } }
      : { id: V.uuid || crypto.randomUUID(), temp: numTemporal(), venta: { ...d, fecha: new Date().toISOString(), items, pagos: [] } };
    if (!cola.guardar(rec)) { $("#ventaMsg").textContent = "No hay espacio en esta compu para guardar la venta."; return false; }
    toast(navigator.onLine && !SIN_RED ? "Venta guardada en esta compu. Se enviará en un momento." : "Sin internet: venta guardada en esta compu. Se enviará sola cuando vuelva la conexión.");
    abrirLocal(rec.id);
    pintarVentas();
    estadoRedPanel();
    return true;
  }

  let enviandoCola = false;
  async function enviarCola() {
    if (SIN_RED || enviandoCola || !navigator.onLine || !V5) return;
    const l = cola.leer().filter((r) => !r.error);
    if (!l.length) return;
    enviandoCola = true;
    let ok = 0, malas = 0;
    try {
      for (const rec of l) {
        if (V && V.local === rec.id && V.dirty) continue;          // la está editando: se manda después
        let r;
        try { r = await conTiempo(db.rpc("registrar_venta_sin_internet", { p_id: rec.id, p_venta: rec.venta }), 20000); } catch (e) { r = { error: e }; }
        if (r.error && U.esErrorRed(r.error)) break;
        if (r.error && r.error.code === "PGRST202") {
          V5 = false;
          U.banda("Hay ventas hechas sin internet, pero falta correr supabase/v5_sin_internet.sql en Supabase para poder enviarlas.");
          $("#bandaRed").dataset.fija = "1";
          break;
        }
        if (r.error) { cola.guardar({ ...rec, error: errTxt(r.error) }); malas++; continue; }
        cola.quitar(rec.id); ok++;
        if (V && V.local === rec.id && $("#dlgVenta").open) await abrirVenta(r.data.id);
      }
    } finally { enviandoCola = false; }
    if (ok) { toast(ok === 1 ? "Se envió 1 venta hecha sin internet." : `Se enviaron ${ok} ventas hechas sin internet.`); await cargarVentas(); }
    if (malas) toast(`${malas === 1 ? "Una venta" : malas + " ventas"} sin internet no se pudo enviar. Ábrala en la lista para corregirla.`, true);
    if (ok || malas) pintarVentas();
  }

  function pintarVenta() {
    const p = V.pedido, edit = itemsEditables();
    $("#ventaTitulo").textContent = p ? p.cliente_nombre : "Nueva venta";
    $("#ventaCodigo").textContent = p ? p.codigo : "";
    $("#ventaEstado").innerHTML = V.local
      ? `<span class="etq etq--por_verificar">Por enviar</span> <span class="etq">Hecha sin internet</span>${cola.buscar(V.local)?.error ? ` <span class="etq etq--error">${U.esc(cola.buscar(V.local).error)}</span>` : ""}`
      : V.soloLectura ? `<span class="etq">Sin internet: copia de la última conexión, solo para ver</span>`
      : p
      ? (p.estado === "anulada" ? `<span class="etq">Anulada</span> ${U.esc(p.motivo_anulacion || "")}`
        : `<span class="etq etq--${p.estado_pago}">${ETQ_PAGO[p.estado_pago]}</span>${p.estado === "entregada" ? ` <span class="etq etq--ok">Entregada ${fechaCR(p.entregada_at, { dateStyle: "short" })}</span>` : ""}`)
      : "Sin guardar";

    $("#itemsVenta").innerHTML = V.items.map((i, n) => `
      <tr data-n="${n}">
        <td><input data-k="descripcion" value="${U.esc(i.descripcion)}" maxlength="120" aria-label="Descripción" ${edit ? "" : "disabled"} /></td>
        <td class="num"><input data-k="cantidad" type="number" min="0.01" step="0.01" value="${U.esc(i.cantidad)}" aria-label="Cantidad" ${edit ? "" : "disabled"} /></td>
        <td class="num"><input data-k="precio_unit" type="number" min="0" step="0.01" value="${U.esc(i.precio_unit)}" aria-label="Precio unitario" ${edit ? "" : "disabled"} /></td>
        <td class="num" data-sub>${fmt(i.cantidad * i.precio_unit)}</td>
        <td>${edit ? `<button type="button" class="cerrar-x" data-quitar-item="${n}" aria-label="Quitar renglón">✕</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="vacio-adm">Agregue productos a la venta.</td></tr>`;
    actualizarTotal();
    $("#itemsAcc").hidden = !edit;
    $("#itemsBloqueo").hidden = edit;

    const cerrada = p && p.estado !== "abierta";
    $("#btnGuardarVenta").hidden = !!(p && p.estado === "anulada") || !!V.soloLectura;
    $("#btnCobrarWa").hidden = !p || !!V.local || !!V.soloLectura || p.estado === "anulada" || (Number(p.total) > 0 && Number(p.pagado_registrado) >= Number(p.total));
    $("#ventaMsg").textContent = "";

    // comprobantes enviados por el cliente
    const etqComp = { nuevo: '<span class="etq etq--por_verificar">Nuevo</span>', registrado: '<span class="etq etq--pagado">Registrado como pago</span>', rechazado: '<span class="etq">Rechazado</span>' };
    $("#boxCompCliente").hidden = !(V.comps && V.comps.length);
    $("#compCliente").innerHTML = (V.comps || []).map((c) => `<li class="pago pago--foto">
      ${/\.pdf$/i.test(c.ruta) ? `<button type="button" class="comp-mini comp-mini--pdf" data-comp="${U.esc(c.ruta)}">PDF</button>`
        : `<button type="button" class="comp-mini" data-comp="${U.esc(c.ruta)}" aria-label="Ver comprobante en grande"><img alt="Foto del comprobante" data-mini="${U.esc(c.ruta)}" /></button>`}
      <div class="pago__monto">${c.monto_reportado ? fmt(c.monto_reportado) : "Sin monto"}<small>${c.monto_reportado ? "saldo del pedido al enviarlo" : "sin total confirmado"}</small></div>
      <div class="pago__datos">
        ${c.referencia_reportada ? `<span>Comprobante <b>${U.esc(c.referencia_reportada)}</b></span>` : ""}
        <span>${fechaCR(c.created_at)}</span>
        <span>${etqComp[c.estado] || ""}${c.estado === "rechazado" && c.motivo_rechazo ? " " + U.esc(c.motivo_rechazo) : ""}</span>
        ${c.nota ? `<span>Nota: ${U.esc(c.nota)}</span>` : ""}
      </div>
      <div class="pago__acc">
        <button type="button" class="btn btn--sm btn--linea" data-comp="${U.esc(c.ruta)}">Ver comprobante</button>
        ${c.estado === "nuevo" && p && p.estado !== "anulada" ? `<button type="button" class="btn btn--sm btn--negro" data-registrar-comp="${c.id}">Registrar como pago</button>
        <button type="button" class="enlace enlace--peligro" data-rechazar-comp="${c.id}">Rechazar</button>` : ""}
      </div>
    </li>`).join("");

    if (!V.soloLectura) cargarMiniaturas();

    // pagos
    $("#ventaSaldo").textContent = p ? `· Total ${fmt(p.total)} · Registrado ${fmt(p.pagado_registrado)} · Verificado ${fmt(p.pagado_verificado)}` : "";
    $("#pagosVenta").innerHTML = p ? (V.pagos.map(V.local ? pagoLocalHTML : pagoHTML).join("") || `<li class="vacio-adm">Sin pagos registrados.</li>`) : `<li class="vacio-adm">Guarde la venta para registrar pagos.</li>`;
    $("#dlgVenta").classList.toggle("solo-ver", !!V.soloLectura);
    $$("#formVenta input").forEach((i) => (i.disabled = !!V.soloLectura));
    $("#boxPago").hidden = !p || p.estado === "anulada" || !!V.soloLectura;
    $("#boxPago").open = false;
    const saldoReg = p ? Math.max(0, p.total - p.pagado_registrado) : 0;
    const fp = $("#formPago");
    fp.reset();
    fp.monto.value = saldoReg ? saldoReg : "";
    fp.fecha.value = ahoraLocalCR();
    fp.fecha.max = ahoraLocalCR();
    fp.nombre_origen.value = "";
    delete fp.dataset.compId; delete fp.dataset.ruta;
    $("#avisoComp").hidden = true;
    fp.comprobante.disabled = false;
    $("#pagoMsg").textContent = "";

    $("#btnEntregar").hidden = !p || cerrada || !!V.local || !!V.soloLectura;
    $("#formPago").comprobante.disabled = !!V.local;

    // entrega, listo y factura
    const ent = $("#ventaEntrega");
    ent.hidden = !p || !V4;
    if (V.local || V.soloLectura) ent.hidden = true;
    else if (p && V4) {
      ent.innerHTML = (p.entrega === "envio"
        ? `<b>Envío a ${U.esc(p.zona || "domicilio")}</b>${p.direccion ? ": " + U.esc(p.direccion) : ""}`
        : "<b>Retira en el almacén</b>") +
        (p.listo_at ? ` <span class="etq etq--ok">Listo desde ${fechaCR(p.listo_at, { dateStyle: "short", timeStyle: "short" })}</span>` : "");
    }
    $("#btnListo").hidden = !p || p.estado !== "abierta" || !V4 || !!V.local || !!V.soloLectura;
    $("#btnListo").textContent = p?.listo_at ? "Avisar otra vez que está listo" : "Avisar que está listo";
    $("#boxFactura").hidden = !p || !V4 || !!V.local || !!V.soloLectura;
    if (p && V4 && !V.local && !V.soloLectura) pintarFactura();
    $("#boxFE").hidden = !p || !V10 || !FE?.activo || !!V.local || !!V.soloLectura;
    if (!$("#boxFE").hidden) pintarFEVenta();
    $("#btnAnularVenta").hidden = !p || p.estado === "anulada" || !!V.local || !!V.soloLectura;
    $(".imprimir").hidden = !p;
    $("#btnBorrarVenta").hidden = V.local ? false : (!p || p.estado !== "abierta" || V.pagos.length > 0 || !!V.soloLectura);
  }

  function pagoLocalHTML(g, n) {
    return `<li class="pago">
      <div class="pago__monto">${fmt(g.monto)}<small>${ETQ_METODO[g.metodo] || U.esc(g.metodo)}</small></div>
      <div class="pago__datos">
        ${g.referencia ? `<span>Comprobante <b>${U.esc(g.referencia)}</b></span>` : ""}
        ${g.nombre_origen || g.telefono_origen ? `<span>De ${U.esc(g.nombre_origen || "")} ${U.esc(g.telefono_origen || "")}</span>` : ""}
        <span>${fechaCR(g.fecha)}</span>
        <span>${g.verificado ? '<span class="etq etq--pagado">Recibido</span>' : '<span class="etq etq--por_verificar">Por verificar</span>'} <small>se envía con la venta</small></span>
      </div>
      <div class="pago__acc"><button type="button" class="enlace enlace--peligro" data-quitar-pago-local="${n}">Quitar</button></div>
    </li>`;
  }
  $("#pagosVenta").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quitar-pago-local]");
    if (!b || !V.local) return;
    e.stopImmediatePropagation();
    if (!confirm("¿Quitar este pago? La venta todavía no se ha enviado.")) return;
    const rec = cola.buscar(V.local); if (!rec) return;
    rec.venta.pagos.splice(Number(b.dataset.quitarPagoLocal), 1);
    rec.error = null;
    cola.guardar(rec); abrirLocal(rec.id); pintarVentas();
  });

  function pagoHTML(g) {
    const estado = g.anulado
      ? `<span class="etq">Anulado</span> <small>${U.esc(g.motivo_anulacion || "")}</small>`
      : g.verificado
        ? `<span class="etq etq--pagado">Verificado en banco</span> <small>${fechaCR(g.verificado_at, { dateStyle: "short", timeStyle: "short" })}</small>`
        : `<span class="etq etq--por_verificar">Por verificar</span>`;
    return `<li class="pago ${g.anulado ? "pago--anulado" : ""}">
      <div class="pago__monto">${fmt(g.monto)}<small>${ETQ_METODO[g.metodo] || U.esc(g.metodo)}</small></div>
      <div class="pago__datos">
        ${g.referencia ? `<span>Comprobante <b>${U.esc(g.referencia)}</b></span>` : ""}
        ${g.nombre_origen || g.telefono_origen ? `<span>De ${U.esc(g.nombre_origen || "")} ${U.esc(g.telefono_origen || "")}</span>` : ""}
        <span>${fechaCR(g.fecha)}</span>
        <span>${estado}</span>
      </div>
      <div class="pago__acc">
        ${g.comprobante_path ? `<button type="button" class="btn btn--sm btn--linea" data-comp="${U.esc(g.comprobante_path)}">Ver comprobante</button>` : ""}
        ${!g.anulado && !g.verificado ? `<button type="button" class="btn btn--sm btn--negro" data-verificar="${g.id}" data-monto="${g.monto}" data-ref="${U.esc(g.referencia || "")}">Ya lo vi en el banco</button>` : ""}
        ${!g.anulado ? `<button type="button" class="enlace enlace--peligro" data-anular-pago="${g.id}">Anular</button>` : ""}
      </div>
    </li>`;
  }

  function actualizarTotal() {
    const t = V.items.reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
    $("#ventaTotal").textContent = fmt(t);
    return t;
  }

  // edición de renglones
  $("#itemsVenta").addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-n]"), k = e.target.dataset.k;
    if (!tr || !k) return;
    const it = V.items[Number(tr.dataset.n)];
    it[k] = k === "descripcion" ? e.target.value : Number(e.target.value);
    tr.querySelector("[data-sub]").textContent = fmt((Number(it.cantidad) || 0) * (Number(it.precio_unit) || 0));
    V.dirty = true;
    actualizarTotal();
  });
  $("#itemsVenta").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quitar-item]");
    if (!b) return;
    V.items.splice(Number(b.dataset.quitarItem), 1);
    V.dirty = true;
    pintarVenta();
  });
  // ---------- buscador de productos (ventas y ajuste de precios) ----------
  // con miles de productos una lista desplegable no sirve: se escribe parte del nombre o el código
  // (el lector de código de barras escribe el código y da Enter)
  function buscadorProductos(input, res, alElegir, opciones = {}) {
    const caja = input.closest(".buscar-item");
    function buscar() {
      const q = norm(input.value);
      if (q.length < 2) { res.hidden = true; res.innerHTML = ""; return; }
      const exactos = [], hallados = [];
      for (const x of productos) {
        if (!opciones.ocultos && !x.activo) continue;
        const cod = x.codigo ? String(x.codigo).toLowerCase() : "";
        if (cod && cod === q) exactos.push(x);
        else if (norm(x.nombre).includes(q) || (cod && q.length >= 3 && cod.startsWith(q))) hallados.push(x);
        if (exactos.length + hallados.length >= 40) break;
      }
      const lista = exactos.concat(hallados).slice(0, 12);
      res.innerHTML = lista.map((x) => `<li><button type="button" data-item-id="${x.id}">
          <span>${U.esc(x.nombre)}${x.codigo ? ` <small>· ${U.esc(x.codigo)}</small>` : ""}</span>
          <span class="buscar-item__det">${x.precio != null ? fmt(x.precio) : "sin precio"}${x.existencia != null ? ` · hay ${Number(x.existencia).toLocaleString("es-CR")}` : ""}${x.agotado ? " · agotado" : ""}</span>
        </button></li>`).join("") || `<li class="buscar-item__nada">${U.esc(opciones.nada || "No se encontró.")}</li>`;
      res.hidden = false;
    }
    input.addEventListener("input", buscar);
    input.addEventListener("focus", () => { if (input.value.trim().length >= 2) buscar(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const b = res.querySelector("button"); if (b) b.click(); }
      if (e.key === "Escape" && !res.hidden) { e.preventDefault(); e.stopPropagation(); res.hidden = true; }
      if (e.key === "ArrowDown") { const b = res.querySelector("button"); if (b) { e.preventDefault(); b.focus(); } }
    });
    res.addEventListener("keydown", (e) => {
      const bs = [...res.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i < bs.length - 1) { e.preventDefault(); bs[i + 1].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); (i > 0 ? bs[i - 1] : input).focus(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); res.hidden = true; input.focus(); }
    });
    // si el foco sale del buscador, se cierra la lista (que no tape los botones de abajo)
    caja.addEventListener("focusout", (e) => {
      if (!e.relatedTarget || !caja.contains(e.relatedTarget)) setTimeout(() => { if (!caja.contains(document.activeElement)) res.hidden = true; }, 150);
    });
    res.addEventListener("click", (e) => {
      const b = e.target.closest("[data-item-id]"); if (!b) return;
      const p = productos.find((x) => x.id == b.dataset.itemId);
      if (!p) return;
      input.value = ""; res.hidden = true;
      input.focus();          // alElegir puede mover el foco (p. ej. al precio nuevo)
      alElegir(p);
    });
  }
  buscadorProductos($("#agregarItemQ"), $("#agregarItemRes"), (p) => {
    const ya = V.items.find((i) => i.producto_id === p.id);
    if (V12 && p.existencia != null && Number(p.existencia) - (ya ? Number(ya.cantidad) : 0) <= 0)
      toast(`Ojo: según el inventario no hay ${p.nombre} (hay ${Number(p.existencia).toLocaleString("es-CR")}).`, true);
    if (ya) ya.cantidad = Number(ya.cantidad) + 1;
    else V.items.push({ producto_id: p.id, descripcion: p.nombre + (p.unidad ? ` (${p.unidad})` : ""), cantidad: 1, precio_unit: p.precio != null ? Number(p.precio) : 0 });
    V.dirty = true;
    pintarVenta();
  }, { nada: "No se encontró. Use “Agregar renglón libre”." });
  $("#btnItemLibre").addEventListener("click", () => {
    V.items.push({ producto_id: null, descripcion: "", cantidad: 1, precio_unit: 0 });
    V.dirty = true;
    pintarVenta();
    $$("#itemsVenta [data-k=descripcion]").pop()?.focus();
  });
  $("#formVenta").addEventListener("input", () => (V.dirty = true));

  async function guardarVenta() {
    const f = $("#formVenta"), msg = $("#ventaMsg");
    const d = { cliente_nombre: f.cliente_nombre.value.trim(), cliente_telefono: f.cliente_telefono.value.trim() || null, nota: f.nota.value.trim() || null };
    if (d.cliente_nombre.length < 2) { msg.textContent = "Escriba el nombre del cliente."; f.cliente_nombre.focus(); return false; }
    if (d.cliente_telefono && !/^[0-9 +()-]{8,20}$/.test(d.cliente_telefono)) { msg.textContent = "Revise el teléfono del cliente."; return false; }
    const items = V.items.map((i) => ({ producto_id: i.producto_id || null, descripcion: String(i.descripcion || "").trim(), cantidad: Number(i.cantidad), precio_unit: Number(i.precio_unit) || 0 }));
    if (items.some((i) => !i.descripcion || !(i.cantidad > 0) || i.precio_unit < 0)) { msg.textContent = "Cada renglón necesita descripción, cantidad mayor que 0 y precio."; return false; }
    if (!items.length) { msg.textContent = "Agregue al menos un producto."; return false; }
    if (items.some((i) => i.precio_unit === 0) && !confirm("Hay renglones con precio ₡0. ¿Guardar así?")) return false;

    if (V.soloLectura) return false;
    // venta hecha sin internet que todavía no se envía: se actualiza en la compu
    if (V.local) return guardarLocal(d, items);
    // venta nueva sin conexión: se guarda en la compu
    if (!V.pedido && (SIN_RED || !navigator.onLine)) return guardarLocal(d, items);

    const btn = $("#btnGuardarVenta");
    btn.disabled = true; msg.textContent = "";
    try {
      // venta nueva: se manda de una sola vez con su identificador; si el internet se cae
      // a medio camino queda en la compu y al reenviarla no se duplica
      if (!V.pedido && V5) {
        const venta = { ...d, fecha: new Date().toISOString(), items, pagos: [] };
        let r;
        try { r = await conTiempo(db.rpc("registrar_venta_sin_internet", { p_id: V.uuid, p_venta: venta }), 15000); } catch (e) { r = { error: e }; }
        if (r.error && U.esErrorRed(r.error)) return guardarLocal(d, items);
        if (r.error && r.error.code === "PGRST202") V5 = false;        // base sin v5: se guarda como antes
        else if (r.error) throw r.error;
        else { toast("Venta guardada"); await abrirVenta(r.data.id); cargarVentas(); return true; }
      }
      let id = V.pedido?.id;
      if (!id) {
        const r = await db.from("pedidos").insert(d).select("id").single();
        if (r.error) throw r.error;
        id = r.data.id;
      } else {
        const r = await db.from("pedidos").update(d).eq("id", id);
        if (r.error) throw r.error;
      }
      if (itemsEditables() && V.dirty) {
        if (V.pedido) { const del = await db.from("pedido_items").delete().eq("pedido_id", id); if (del.error) throw del.error; }
        const ins = await db.from("pedido_items").insert(items.map((i) => ({ ...i, pedido_id: id })));
        if (ins.error) throw ins.error;
      }
      toast("Venta guardada");
      refrescarExistencias(V.items.map((i) => i.producto_id));
      await abrirVenta(id);
      cargarVentas();
      return true;
    } catch (err) {
      msg.textContent = errTxt(err);
      return false;
    } finally { btn.disabled = false; }
  }
  $("#btnGuardarVenta").addEventListener("click", guardarVenta);

  $("#btnCerrarVenta").addEventListener("click", () => {
    if (V && V.dirty && itemsEditables() && !confirm("Hay cambios sin guardar. ¿Cerrar igual?")) return;
    $("#dlgVenta").close();
  });

  // ---------- cobro por WhatsApp ----------
  $("#btnCobrarWa").addEventListener("click", async () => {
    if (V.dirty && !(await guardarVenta())) return;
    const p = V.pedido, num = U.soloDigitos(ajustesCache.sinpe_numero);
    if (num.length !== 8) { toast("Primero ponga el número SINPE en Datos del negocio.", true); return; }
    const tel = U.soloDigitos(p.cliente_telefono);
    if (tel.length < 8) { toast("La venta no tiene teléfono del cliente.", true); return; }
    const saldo = Math.max(0, p.total - p.pagado_registrado);
    const msg = [
      `¡Hola, ${p.cliente_nombre}! Este es su pedido en ${C.NEGOCIO}:`,
      ...V.items.map((i) => `• ${Number(i.cantidad)} × ${i.descripcion} — ${fmt(i.subtotal ?? i.cantidad * i.precio_unit)}`),
      `Total: ${fmt(p.total)}`,
      p.pagado_registrado > 0 ? `Ya recibimos: ${fmt(p.pagado_registrado)}. Falta: ${fmt(saldo)}` : null,
      "",
      "Para pagar por SINPE Móvil:",
      `Número: ${num.slice(0, 4)}-${num.slice(4)}`,
      ajustesCache.sinpe_titular ? `A nombre de: ${ajustesCache.sinpe_titular}` : null,
      `En el detalle escriba: ${p.codigo}`,
      "",
      "Cuando pague, envíenos el comprobante por aquí. ¡Gracias!"
    ].filter((l) => l !== null).join("\n");
    const url = `https://wa.me/${tel.length === 8 ? "506" + tel : tel}?text=${encodeURIComponent(msg)}`;
    const w = window.open(url, "_blank");
    if (w) w.opener = null;
  });

  // ---------- avisar que está listo ----------
  $("#btnListo").addEventListener("click", async () => {
    const p = V.pedido;
    if (V.dirty) { toast("Primero guarde los cambios de la venta.", true); return; }
    const tel = U.soloDigitos(p.cliente_telefono);
    if (tel.length < 8) { toast("La venta no tiene teléfono del cliente.", true); return; }
    const saldo = Math.max(0, p.total - p.pagado_verificado), num = U.soloDigitos(ajustesCache.sinpe_numero);
    const msg = [
      `¡Hola, ${p.cliente_nombre}! Su pedido ${p.codigo} de ${C.NEGOCIO} ya está listo${p.entrega === "envio" ? " para el envío. Le escribimos para coordinar la hora de entrega." : " para recoger."}`,
      saldo > 0 ? `Total: ${fmt(p.total)}. Falta pagar ${fmt(saldo)}.` : "Ya está pagado. ¡Gracias!",
      saldo > 0 && num.length === 8 ? `SINPE Móvil: ${num.slice(0, 4)}-${num.slice(4)}${ajustesCache.sinpe_titular ? " a nombre de " + ajustesCache.sinpe_titular : ""}. En el detalle escriba ${p.codigo}.` : null,
      p.entrega !== "envio" && ajustesCache.direccion ? `Lo esperamos en: ${ajustesCache.direccion}` : null
    ].filter(Boolean).join("\n");
    const w = window.open(`https://wa.me/${tel.length === 8 ? "506" + tel : tel}?text=${encodeURIComponent(msg)}`, "_blank");
    if (w) w.opener = null;
    if (!p.listo_at) {
      const { error } = await db.from("pedidos").update({ listo_at: new Date().toISOString() }).eq("id", p.id);
      if (error) return toast(errTxt(error), true);
      toast("Marcado como listo. El cliente lo ve en “Mi pedido”.");
      await abrirVenta(p.id); cargarVentas();
    }
  });

  // ---------- factura electrónica ----------
  const ETQ_FAC = { pendiente: "Pendiente de emitir", enviada: "Enviada a Hacienda", aceptada: "Aceptada por Hacienda", rechazada: "Rechazada por Hacienda", error: "Con error", anulada: "Anulada" };
  function pintarFactura(nueva) {
    const fac = V.factura, f = $("#formFactura");
    $("#facturaInfo").textContent = fac
      ? `${ETQ_FAC[fac.estado] || fac.estado}. La pidió ${fac.solicitada_por === "cliente" ? "el cliente en la página" : "el almacén"}. ${V10 && FE?.activo ? "Emítala con el botón “Emitir factura” de abajo." : "Emítala en su sistema de facturación y anote aquí el resultado."}`
      : "Esta venta no tiene factura electrónica.";
    $("#btnNuevaFactura").hidden = !!fac || !!nueva;
    f.hidden = !fac && !nueva;
    $("#facturaMsg").textContent = "";
    f.reset();
    if (fac) ["tipo_id", "identificacion", "nombre", "correo", "estado", "consecutivo", "clave", "mensaje"].forEach((k) => (f.elements[k].value = fac[k] ?? ""));
    else { f.nombre.value = V.pedido.cliente_nombre || ""; f.estado.value = "pendiente"; }
  }
  $("#btnNuevaFactura").addEventListener("click", () => { pintarFactura(true); $("#formFactura").identificacion.focus(); });
  $("#formFactura").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#facturaMsg");
    const d = {
      tipo_id: f.tipo_id.value, identificacion: U.soloDigitos(f.identificacion.value), nombre: f.nombre.value.trim(),
      correo: f.correo.value.trim().toLowerCase(), estado: f.estado.value,
      consecutivo: U.soloDigitos(f.consecutivo.value) || null, clave: U.soloDigitos(f.clave.value) || null, mensaje: f.mensaje.value.trim() || null
    };
    const RE = { fisica: /^[1-9][0-9]{8}$/, juridica: /^[0-9]{10}$/, dimex: /^[0-9]{11,12}$/, nite: /^[0-9]{10}$/ };
    if (!RE[d.tipo_id].test(d.identificacion)) { msg.textContent = "Revise la identificación: física 9 dígitos, jurídica 10, DIMEX 11 o 12, NITE 10."; return; }
    if (d.nombre.length < 2) { msg.textContent = "Escriba el nombre o la razón social."; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.correo)) { msg.textContent = "Revise el correo."; return; }
    if (d.consecutivo && !/^[0-9]{20}$/.test(d.consecutivo)) { msg.textContent = "El consecutivo tiene 20 dígitos."; return; }
    if (d.clave && !/^[0-9]{50}$/.test(d.clave)) { msg.textContent = "La clave numérica tiene 50 dígitos."; return; }
    const r = V.factura
      ? await db.from("facturas").update(d).eq("id", V.factura.id)
      : await db.from("facturas").insert({ ...d, pedido_id: V.pedido.id, solicitada_por: "panel" });
    if (r.error) { msg.textContent = errTxt(r.error); return; }
    toast("Factura guardada");
    await abrirVenta(V.pedido.id);
  });

  // ---------- facturación electrónica (función "facturar") ----------
  const FE_TIPO = { "01": "Factura electrónica", "03": "Nota de crédito", "04": "Tiquete electrónico" };
  const FE_ESTADO = {
    firmado: ["Sin enviar", "etq--error"], enviado: ["Enviado a Hacienda", "etq--por_verificar"], procesando: ["Hacienda lo está revisando", "etq--por_verificar"],
    aceptado: ["Aceptado por Hacienda", "etq--pagado"], rechazado: ["Rechazado por Hacienda", "etq--error"], error: ["Con error", "etq--error"]
  };
  async function llamarFE(cuerpo) {
    const { data, error } = await db.functions.invoke("facturar", { body: cuerpo });
    if (error) {
      let m = "";
      try { m = (await error.context.json()).error; } catch { /* sin detalle */ }
      if (!m && U.esErrorRed(error)) m = "Sin internet: no se pudo hablar con Hacienda.";
      throw new Error(m || "No se pudo usar la facturación. ¿Está publicada la función “facturar” en Supabase?");
    }
    if (!data?.ok) throw new Error(data?.error || "No se pudo completar.");
    return data;
  }
  function feVigente() {
    return (V.fe || []).find((d) => ["01", "04"].includes(d.tipo) && d.estado !== "rechazado" && !d.anulado && d.ambiente === FE?.ambiente);
  }
  function pintarFEVenta() {
    const docs = (V.fe || []).filter((d) => d.ambiente === FE?.ambiente);
    $("#feDocs").innerHTML = docs.map((d) => {
      const [txt, cls] = FE_ESTADO[d.estado] || [d.estado, ""];
      const acc = [];
      if (["firmado", "error"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--negro" data-fe="enviar" data-id="${d.id}">Enviar de nuevo</button>`);
      if (["enviado", "procesando"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-fe="consultar" data-id="${d.id}">Consultar</button>`);
      if (d.estado === "aceptado" && d.tipo !== "03" && !d.anulado) acc.push(`<button type="button" class="enlace enlace--peligro" data-fe="anular" data-id="${d.id}">Anular con nota de crédito</button>`);
      acc.push(`<button type="button" class="enlace" data-fe="xml" data-id="${d.id}">XML</button>`);
      return `<li class="pago fe-doc ${d.anulado ? "pago--anulado" : ""}">
        <div class="pago__monto">${fmt(d.total)}<small>${FE_TIPO[d.tipo] || d.tipo}</small></div>
        <div class="pago__datos">
          <span>N.º <b>${U.esc(d.consecutivo.slice(-10).replace(/^0+/, ""))}</b> · ${fechaCR(d.fecha_emision, { dateStyle: "short", timeStyle: "short" })}</span>
          <span><span class="etq ${cls}">${txt}</span>${d.anulado ? ' <span class="etq">Anulado</span>' : ""}${d.ambiente === "pruebas" ? ' <span class="etq">Pruebas</span>' : ""}</span>
          ${d.detalle ? `<span>${U.esc(d.detalle)}</span>` : ""}
          <span class="fe-doc__clave">Clave ${U.esc(d.clave)}</span>
        </div>
        <div class="pago__acc">${acc.join("")}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">Esta venta todavía no tiene comprobante electrónico.</li>`;
    const vig = feVigente(), anulada = V.pedido?.estado === "anulada";
    $("#feEmitir").hidden = !!vig || anulada;
    $("#btnFEFactura").disabled = !V.factura;
    $("#btnFEFactura").title = V.factura ? "" : "Primero anote los datos del cliente en “El cliente pide factura”.";
  }
  async function accionFE(cuerpo, espera) {
    if (V.dirty) { $("#feMsg").className = "msg msg--error"; $("#feMsg").textContent = "Primero guarde los cambios de la venta."; return; }
    V.fe = V.fe || [];
    const msg = $("#feMsg"), botones = $$("#boxFE button");
    botones.forEach((b) => (b.disabled = true));
    msg.className = "msg"; msg.textContent = espera;
    try {
      const r = await llamarFE(cuerpo);
      const d = r.documento;
      const i = V.fe.findIndex((x) => x.id === d.id);
      if (i >= 0) V.fe[i] = d; else V.fe.push(d);
      if (d.referencia_id && d.estado === "aceptado") { const o = V.fe.find((x) => x.id === d.referencia_id); if (o) o.anulado = true; }
      const art = { "01": "la factura", "03": "la nota de crédito", "04": "el tiquete" }[d.tipo] || "el comprobante";
      msg.textContent = d.estado === "aceptado" ? `Hacienda aceptó ${art}.`
        : d.estado === "rechazado" ? `Hacienda rechazó ${art}: ${d.detalle || "vea el XML de respuesta."}`
        : ["enviado", "procesando"].includes(d.estado) ? "Enviado. Hacienda todavía lo está revisando: toque “Consultar” en un rato."
        : d.detalle || "Guardado, pero no llegó a Hacienda. Toque “Enviar de nuevo”.";
      if (d.estado === "rechazado" || d.estado === "firmado" || d.estado === "error") msg.className = "msg msg--error";
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    } finally {
      botones.forEach((b) => (b.disabled = false));
      pintarFEVenta();
    }
  }
  $("#btnFETiquete").addEventListener("click", () => accionFE({ accion: "emitir", pedido_id: V.pedido.id, tipo: "04" }, "Firmando y enviando el tiquete a Hacienda…"));
  $("#btnFEFactura").addEventListener("click", () => accionFE({ accion: "emitir", pedido_id: V.pedido.id, tipo: "01" }, "Firmando y enviando la factura a Hacienda…"));
  $("#feDocs").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fe]"); if (!b) return;
    const id = Number(b.dataset.id), acc = b.dataset.fe;
    if (acc === "consultar") return accionFE({ accion: "consultar", documento_id: id }, "Consultando a Hacienda…");
    if (acc === "enviar") return accionFE({ accion: "enviar", documento_id: id }, "Enviando a Hacienda…");
    if (acc === "anular") {
      const motivo = prompt("Motivo de la nota de crédito (lo ve Hacienda):", "Devolución de la mercadería");
      if (motivo === null) return;
      if (motivo.trim().length < 3) return toast("Escriba el motivo.", true);
      if (!confirm("Se emite una nota de crédito por el total y el comprobante queda anulado ante Hacienda. ¿Seguir?")) return;
      return accionFE({ accion: "anular", documento_id: id, motivo: motivo.trim() }, "Emitiendo la nota de crédito…");
    }
    if (acc === "xml") return descargarXmlFE(id);
  });
  async function descargarXmlFE(id) {
    const { data, error } = await db.from("fe_documentos").select("clave,xml_firmado,respuesta_xml").eq("id", id).single();
    if (error) return toast(errTxt(error), true);
    descargar(new Blob([data.xml_firmado], { type: "application/xml" }), `${data.clave}.xml`);
    if (data.respuesta_xml) setTimeout(() => descargar(new Blob([data.respuesta_xml], { type: "application/xml" }), `${data.clave}-respuesta-hacienda.xml`), 400);
  }

  // ---------- comprobantes emitidos (como "Facturas emitidas" de Moriah) ----------
  let compDocs = [], compTipo = "todos";
  const PROBLEMA_FE = ["firmado", "error", "rechazado", "enviado", "procesando"];
  async function cargarComprobantes() {
    if (!V10 || !FE) {
      $("#compCifras").innerHTML = "";
      $("#listaComp").innerHTML = `<li class="vacio-adm">La facturación electrónica no está configurada. Vea Datos del negocio → Facturación electrónica.</li>`;
      return;
    }
    const hoy = hoyCR();
    if (!$("#compHasta").value) $("#compHasta").value = hoy;
    if (!$("#compDesde").value) $("#compDesde").value = hoy.slice(0, 8) + "01";
    $("#compDesde").max = $("#compHasta").max = hoy;
    let desde = $("#compDesde").value, hasta = $("#compHasta").value;
    if (desde > hasta) { [desde, hasta] = [hasta, desde]; $("#compDesde").value = desde; $("#compHasta").value = hasta; }
    $("#listaComp").innerHTML = `<li class="vacio-adm">Cargando…</li>`;
    const { data, error } = await db.from("fe_documentos")
      .select("id,pedido_id,tipo,ambiente,clave,consecutivo,fecha_emision,receptor,total,impuesto,estado,detalle,referencia_id,anulado,pedidos(codigo,cliente_nombre)")
      .eq("ambiente", FE.ambiente).gte("fecha_emision", rangoDia(desde)[0]).lt("fecha_emision", rangoDia(hasta)[1])
      .order("fecha_emision", { ascending: false }).limit(3000);
    if (error) { $("#listaComp").innerHTML = ""; return toast(errTxt(error), true); }
    compDocs = data || [];
    pintarComprobantes();
  }
  const clienteFE = (d) => d.receptor?.nombre || d.pedidos?.cliente_nombre || "Cliente de contado";
  const numeroFE = (d) => String(d.consecutivo).slice(-10).replace(/^0+/, "") || "0";
  function pintarComprobantes() {
    const q = norm($("#compBuscar").value);
    const pasa = (d) => compTipo === "todos" || (compTipo === "problemas" ? PROBLEMA_FE.includes(d.estado) : d.tipo === compTipo);
    const lista = compDocs.filter(pasa).filter((d) => !q || norm([numeroFE(d), d.consecutivo, d.clave, clienteFE(d), d.pedidos?.codigo].join(" ")).includes(q));
    const ok = compDocs.filter((d) => d.estado === "aceptado");
    const suma = (a, k) => a.reduce((t, d) => t + Number(d[k] || 0), 0);
    const ventas = ok.filter((d) => d.tipo !== "03"), notas = ok.filter((d) => d.tipo === "03");
    const problemas = compDocs.filter((d) => PROBLEMA_FE.includes(d.estado)).length;
    $("#compCifras").innerHTML = `
      <div><dt>Total facturado</dt><dd>${fmt(suma(ventas, "total") - suma(notas, "total"))}<small>${ventas.length} ${ventas.length === 1 ? "comprobante" : "comprobantes"}${notas.length ? ` − ${notas.length} ${notas.length === 1 ? "nota" : "notas"} de crédito` : ""}</small></dd></div>
      <div><dt>IVA</dt><dd>${fmt(suma(ventas, "impuesto") - suma(notas, "impuesto"))}</dd></div>
      <div><dt>Con problemas</dt><dd>${problemas}<small>sin enviar, rechazados o en revisión</small></dd></div>
      ${FE.ambiente === "pruebas" ? `<div><dt>Ambiente</dt><dd>Pruebas<small>no cuentan para Hacienda</small></dd></div>` : ""}`;
    $("#listaComp").innerHTML = lista.map((d) => {
      const [txt, cls] = FE_ESTADO[d.estado] || [d.estado, ""];
      const acc = [];
      if (["firmado", "error"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--negro" data-comp="enviar" data-id="${d.id}">Enviar de nuevo</button>`);
      if (["enviado", "procesando"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-comp="consultar" data-id="${d.id}">Consultar</button>`);
      acc.push(`<button type="button" class="btn btn--sm btn--linea" data-comp="venta" data-id="${d.pedido_id}">Ver venta</button>`);
      acc.push(`<button type="button" class="enlace" data-comp="xml" data-id="${d.id}">XML</button>`);
      return `<li class="fila fila--pago ${d.anulado ? "fila--oculta" : ""}">
        <div class="fila__monto"><b>${d.tipo === "03" ? "−" : ""}${fmt(d.total)}</b><small class="comp-tipo">${FE_TIPO[d.tipo] || d.tipo}</small></div>
        <div class="fila__txt">
          <b>N.º ${U.esc(numeroFE(d))} · ${U.esc(clienteFE(d))}</b>
          <small>${fechaCR(d.fecha_emision)}${d.pedidos?.codigo ? ` · Venta ${U.esc(d.pedidos.codigo)}` : ""}${d.detalle ? ` · ${U.esc(d.detalle)}` : ""}</small>
          <span class="etiquetas"><span class="etq ${cls}">${txt}</span>${d.anulado ? '<span class="etq">Anulado</span>' : ""}</span>
        </div>
        <div class="fila__acc">${acc.join("")}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">${compDocs.length ? "Ningún comprobante con ese filtro." : "No hay comprobantes en esas fechas."}</li>`;
  }
  $("#compDesde").addEventListener("change", cargarComprobantes);
  $("#compHasta").addEventListener("change", cargarComprobantes);
  $("#compBuscar").addEventListener("input", pintarComprobantes);
  $("#compTipo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ct]"); if (!b) return;
    compTipo = b.dataset.ct;
    $$("#compTipo [data-ct]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarComprobantes();
  });
  $("#listaComp").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-comp]"); if (!b) return;
    const id = Number(b.dataset.id), acc = b.dataset.comp;
    if (acc === "xml") return descargarXmlFE(id);
    if (acc === "venta") return abrirVenta(id);
    b.disabled = true;
    try {
      const r = await llamarFE({ accion: acc, documento_id: id });
      const i = compDocs.findIndex((x) => x.id === id);
      if (i >= 0) compDocs[i] = { ...compDocs[i], ...r.documento };
      toast(r.documento.estado === "aceptado" ? "Aceptado por Hacienda" : r.documento.estado === "rechazado" ? "Rechazado: " + (r.documento.detalle || "") : "Hacienda todavía lo está revisando");
    } catch (err) { toast(errTxt(err), true); }
    pintarComprobantes();
  });
  $("#btnCompExcel").addEventListener("click", () => {
    if (!compDocs.length) return toast("No hay comprobantes en esas fechas.", true);
    const signo = (d) => (d.tipo === "03" ? -1 : 1);
    const filas = [["Fecha", "Tipo", "N.º", "Consecutivo", "Clave", "Cliente", "Identificación", "Venta", "Subtotal", "IVA", "Total", "Estado", "Detalle"]]
      .concat([...compDocs].reverse().map((d) => [
        fechaCR(d.fecha_emision, { dateStyle: "short", timeStyle: "short" }), FE_TIPO[d.tipo] || d.tipo, Number(numeroFE(d)), d.consecutivo, d.clave,
        clienteFE(d), d.receptor?.identificacion || "", d.pedidos?.codigo || "",
        signo(d) * Math.round((Number(d.total) - Number(d.impuesto)) * 100) / 100, signo(d) * Math.round(Number(d.impuesto) * 100) / 100,
        signo(d) * Math.round(Number(d.total) * 100) / 100, (FE_ESTADO[d.estado] || [d.estado])[0] + (d.anulado ? " (anulado)" : ""), d.detalle || ""]));
    descargar(XlsxMini.escribir(filas, { hoja: "Comprobantes", anchos: [16, 20, 10, 24, 54, 30, 14, 12, 14, 12, 14, 24, 40] }),
      `comprobantes-${$("#compDesde").value}-a-${$("#compHasta").value}.xlsx`);
  });

  // ---------- inventario: entradas de mercadería y movimientos ----------
  async function refrescarExistencias(ids) {
    ids = [...new Set((ids || []).filter(Boolean))];
    if (!V12 || !ids.length) return;
    const { data } = await db.from("productos").select("id,existencia,agotado").in("id", ids);
    for (const r of data || []) { const p = productos.find((x) => x.id === r.id); if (p) { p.existencia = r.existencia; p.agotado = r.agotado; } }
  }
  const ORIGEN_INV = {
    venta: "Venta", venta_cambio: "Cambio en una venta", venta_borrada: "Venta borrada", anulacion: "Venta anulada",
    entrada: "Entrada de mercadería", entrada_anulada: "Entrada anulada", producto: "Editado en Productos", importacion: "Importación"
  };
  let invVista = "entradas", invProd = null;
  const cant = (n) => Number(n).toLocaleString("es-CR", { maximumFractionDigits: 2 });
  function cargarInventario() {
    $("#invEntradas").hidden = invVista !== "entradas";
    $("#invMovs").hidden = invVista !== "movs";
    $$("#invVista [data-iv]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.iv === invVista)));
    return invVista === "entradas" ? cargarEntradas() : cargarMovsInv();
  }
  $("#invVista").addEventListener("click", (e) => {
    const b = e.target.closest("[data-iv]"); if (!b) return;
    invVista = b.dataset.iv; cargarInventario();
  });

  async function cargarEntradas() {
    $("#listaEntradas").innerHTML = `<li class="vacio-adm">Cargando…</li>`;
    const { data, error } = await db.from("entradas").select("*").order("fecha", { ascending: false }).order("id", { ascending: false }).limit(300);
    if (error) { $("#listaEntradas").innerHTML = ""; return toast(errTxt(error), true); }
    $("#listaEntradas").innerHTML = data.map((en) => `<li class="fila fila--pago ${en.estado === "anulada" ? "fila--oculta" : ""}">
        <div class="fila__monto"><b>${en.total_costo > 0 ? fmt(en.total_costo) : `${en.productos} prod.`}</b><small>${new Date(en.fecha + "T12:00:00-06:00").toLocaleDateString("es-CR", { dateStyle: "medium", timeZone: TZ })}</small></div>
        <div class="fila__txt">
          <b>Entrada ${en.id}${en.proveedor ? " · " + U.esc(en.proveedor) : ""}</b>
          <small>${en.documento ? "Factura " + U.esc(en.documento) + " · " : ""}${en.productos} ${en.productos === 1 ? "producto" : "productos"}${en.nota ? " · " + U.esc(en.nota) : ""}${en.estado === "anulada" ? " · Anulada: " + U.esc(en.motivo_anulacion || "") : ""}</small>
          <details data-entrada="${en.id}"><summary>Ver productos</summary><ul class="entrada__items"><li>Cargando…</li></ul></details>
        </div>
        <div class="fila__acc">${en.estado === "aplicada" ? `<button type="button" class="enlace enlace--peligro" data-anular-entrada="${en.id}">Anular</button>` : '<span class="etq">Anulada</span>'}</div>
      </li>`).join("") || `<li class="vacio-adm">Todavía no hay entradas. Cuando llegue mercadería del proveedor, toque <b>Entrada de mercadería</b>.</li>`;
  }
  $("#listaEntradas").addEventListener("toggle", async (e) => {
    const d = e.target.closest("details[data-entrada]"); if (!d || !d.open || d.dataset.cargado) return;
    const { data, error } = await db.from("entrada_items").select("cantidad,costo_unit,precio_nuevo,productos(nombre,codigo)").eq("entrada_id", d.dataset.entrada).order("id");
    d.querySelector("ul").innerHTML = error ? `<li>${U.esc(errTxt(error))}</li>` : data.map((i) =>
      `<li><b>${cant(i.cantidad)}</b> × ${U.esc(i.productos?.nombre || "(borrado)")}${i.costo_unit != null ? ` · costo ${fmt(i.costo_unit)}` : ""}${i.precio_nuevo != null ? ` · precio nuevo ${fmt(i.precio_nuevo)}` : ""}</li>`).join("");
    d.dataset.cargado = "1";
  }, true);
  $("#listaEntradas").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-anular-entrada]"); if (!b) return;
    const motivo = prompt("¿Por qué se anula esta entrada? (se resta lo que había sumado)", "Se registró por error");
    if (motivo === null) return;
    if (motivo.trim().length < 3) return toast("Escriba el motivo.", true);
    const { error } = await db.rpc("anular_entrada", { p_id: Number(b.dataset.anularEntrada), p_motivo: motivo.trim() });
    if (error) return toast(errTxt(error), true);
    toast("Entrada anulada: se restó del inventario");
    cargarEntradas(); cargarProductos();
  });

  // kardex
  async function cargarMovsInv() {
    const hoy = hoyCR();
    if (!$("#invHasta").value) $("#invHasta").value = hoy;
    if (!$("#invDesde").value) $("#invDesde").value = hoy.slice(0, 8) + "01";
    $("#invDesde").max = $("#invHasta").max = hoy;
    let desde = $("#invDesde").value, hasta = $("#invHasta").value;
    if (desde > hasta) { [desde, hasta] = [hasta, desde]; $("#invDesde").value = desde; $("#invHasta").value = hasta; }
    $("#invProdSel").hidden = !invProd;
    if (invProd) $("#invProdSel").innerHTML = `<span>Solo <b>${U.esc(invProd.nombre)}</b>${invProd.existencia != null ? ` · hay ${cant(invProd.existencia)}` : " · no lleva existencia"}</span> <button type="button" class="enlace" id="btnInvTodos">Ver todos los productos</button>`;
    $("#invMovFilas").innerHTML = `<tr><td colspan="6" class="vacio-adm">Cargando…</td></tr>`;
    let q = db.from("inventario_movimientos")
      .select("id,producto_id,cantidad,existencia_antes,existencia_despues,origen,pedido_id,entrada_id,nota,created_at,productos(nombre,codigo)")
      .gte("created_at", rangoDia(desde)[0]).lt("created_at", rangoDia(hasta)[1]);
    if (invProd) q = q.eq("producto_id", invProd.id);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1500);
    if (error) { $("#invMovFilas").innerHTML = ""; return toast(errTxt(error), true); }
    // editar una venta borra y vuelve a poner sus renglones: se junta en un solo movimiento (y si no cambió nada, no se muestra)
    const grupos = [], abiertos = new Map();
    for (const m of data) {
      const esVenta = ["venta", "venta_cambio"].includes(m.origen) && m.pedido_id;
      const k = esVenta ? `${m.producto_id}|${m.pedido_id}` : null, g = k && abiertos.get(k);
      if (g && Math.abs(new Date(g.desde) - new Date(m.created_at)) < 180000) {
        g.cantidad = Math.round((g.cantidad + Number(m.cantidad)) * 100) / 100; g.existencia_antes = m.existencia_antes; g.desde = m.created_at;
        continue;
      }
      const n = { ...m, cantidad: Number(m.cantidad), desde: m.created_at };
      grupos.push(n); if (k) abiertos.set(k, n);
    }
    const lista = grupos.filter((g) => g.cantidad !== 0);
    const codigos = {};
    const ids = [...new Set(lista.map((g) => g.pedido_id).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ps } = await db.from("pedidos").select("id,codigo").in("id", ids.slice(i, i + 200));
      for (const p of ps || []) codigos[p.id] = p.codigo;
    }
    $("#invMovFilas").innerHTML = lista.map((g) => {
      const origen = g.origen === "venta_cambio" && g.cantidad < 0 ? "venta" : g.origen === "venta" && g.cantidad > 0 ? "venta_cambio" : g.origen;
      const ref = g.pedido_id ? `<button type="button" class="enlace" data-inv-venta="${g.pedido_id}">Venta ${U.esc(codigos[g.pedido_id] || "#" + g.pedido_id)}</button>`
        : g.entrada_id ? `Entrada ${g.entrada_id}` : "";
      return `<tr>
        <td>${fechaCR(g.created_at, { dateStyle: "short", timeStyle: "short" })}</td>
        <td>${U.esc(g.productos?.nombre || "(borrado)")}${g.productos?.codigo ? `<small class="imp__cod">${U.esc(g.productos.codigo)}</small>` : ""}</td>
        <td>${ORIGEN_INV[origen] || U.esc(origen)}</td>
        <td class="num ${g.cantidad > 0 ? "inv-mas" : "inv-menos"}">${g.cantidad > 0 ? "+" : "−"}${cant(Math.abs(g.cantidad))}</td>
        <td class="num">${g.existencia_despues != null ? cant(g.existencia_despues) : "—"}</td>
        <td>${ref}${g.nota ? `${ref ? " · " : ""}${U.esc(g.nota)}` : ""}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="vacio-adm">No hay movimientos en esas fechas${invProd ? " para este producto" : ""}.</td></tr>`;
  }
  $("#invDesde").addEventListener("change", cargarMovsInv);
  $("#invHasta").addEventListener("change", cargarMovsInv);
  buscadorProductos($("#invProdQ"), $("#invProdRes"), (p) => { invProd = p; cargarMovsInv(); }, { ocultos: true, nada: "No se encontró ese producto." });
  $("#invProdSel").addEventListener("click", (e) => { if (e.target.closest("#btnInvTodos")) { invProd = null; cargarMovsInv(); } });
  $("#invMovFilas").addEventListener("click", (e) => { const b = e.target.closest("[data-inv-venta]"); if (b) abrirVenta(Number(b.dataset.invVenta)); });
  $("#btnProdKardex").addEventListener("click", () => {
    const p = productos.find((x) => x.id == $("#formProd").id.value);
    if (!p) return toast("Primero guarde el producto.", true);
    $("#dlgProd").close();
    invProd = p; invVista = "movs";
    $("#invDesde").value = ""; $("#invHasta").value = "";
    const hoy = hoyCR(); $("#invHasta").value = hoy;
    $("#invDesde").value = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    $("#tabInv").click();
  });

  // nueva entrada de mercadería
  const ENT = new Map();      // id → { p, cant, costo, precio }
  const numOk = (v) => v === "" || /^[0-9]{1,10}(\.[0-9]{1,2})?$/.test(String(v).trim());
  function totalesEntrada() {
    const filas = [...ENT.values()];
    const total = filas.reduce((t, f) => t + (Number(f.cant) || 0) * (Number(f.costo) || 0), 0);
    $("#entCant").textContent = filas.length ? `${filas.length} ${filas.length === 1 ? "producto" : "productos"}` : "";
    $("#entTotal").textContent = total ? fmt(total) : "";
    $("#btnGuardarEntrada").disabled = !filas.length;
  }
  function pintarEntrada() {
    $("#entFilas").innerHTML = [...ENT.values()].map((f) => `<tr>
        <td>${U.esc(f.p.nombre)}${f.p.codigo ? `<small class="imp__cod">${U.esc(f.p.codigo)}</small>` : ""}</td>
        <td class="num">${f.p.existencia != null ? cant(f.p.existencia) : "—"}</td>
        <td class="num"><input type="number" min="0.01" step="0.01" inputmode="decimal" value="${U.esc(String(f.cant))}" data-ent="cant" data-id="${f.p.id}" aria-label="Cantidad que entra de ${U.esc(f.p.nombre)}" /></td>
        <td class="num"><input type="number" min="0" step="0.01" inputmode="decimal" value="${U.esc(String(f.costo))}" data-ent="costo" data-id="${f.p.id}" aria-label="Costo unitario" /></td>
        <td class="num"><input type="number" min="1" step="0.01" inputmode="decimal" value="${U.esc(String(f.precio))}" placeholder="${f.p.precio != null ? Number(f.p.precio) : ""}" data-ent="precio" data-id="${f.p.id}" aria-label="Precio de venta nuevo (vacío = no cambia)" /></td>
        <td><button type="button" class="enlace enlace--peligro" data-ent-quitar="${f.p.id}">Quitar</button></td>
      </tr>`).join("") || `<tr><td colspan="6" class="vacio-adm">Busque arriba los productos que llegaron (o páselos por el lector).</td></tr>`;
    totalesEntrada();
  }
  buscadorProductos($("#entBuscar"), $("#entRes"), (p) => {
    const f = ENT.get(p.id);
    if (f) f.cant = Math.round(((Number(f.cant) || 0) + 1) * 100) / 100;
    else ENT.set(p.id, { p, cant: 1, costo: p.costo != null ? Number(p.costo) : "", precio: "" });
    pintarEntrada();
    const inp = $(`#entFilas [data-ent="cant"][data-id="${p.id}"]`);
    if (inp) { inp.focus(); inp.select(); }
  }, { ocultos: true, nada: "No se encontró. Si es un producto nuevo, créelo primero en Productos." });
  $("#entFilas").addEventListener("input", (e) => {
    const i = e.target.closest("[data-ent]"); if (!i) return;
    const f = ENT.get(Number(i.dataset.id)); if (!f) return;
    f[i.dataset.ent] = i.value.trim();
    totalesEntrada();
  });
  $("#entFilas").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.closest("[data-ent]")) { e.preventDefault(); $("#entBuscar").focus(); }
  });
  $("#entFilas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ent-quitar]"); if (!b) return;
    ENT.delete(Number(b.dataset.entQuitar)); pintarEntrada();
  });
  $("#btnNuevaEntrada").addEventListener("click", () => {
    ENT.clear(); $("#formEntrada").reset();
    $("#formEntrada").fecha.value = hoyCR(); $("#formEntrada").fecha.max = hoyCR();
    $("#entMsg").textContent = ""; $("#entMsg").className = "msg";
    pintarEntrada();
    $("#dlgEntrada").showModal();
    $("#formEntrada").proveedor.focus();
  });
  $("#btnCerrarEntrada").addEventListener("click", () => {
    if (ENT.size && !confirm("La entrada no se ha guardado. ¿Cerrar de todos modos?")) return;
    $("#dlgEntrada").close();
  });
  $("#formEntrada").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#entMsg"), filas = [...ENT.values()];
    if (!filas.length) return;
    for (const x of filas) {
      if (!(Number(x.cant) > 0) || !numOk(x.cant)) { msg.className = "msg msg--error"; msg.textContent = `Revise la cantidad de ${x.p.nombre}.`; return; }
      if (!numOk(x.costo)) { msg.className = "msg msg--error"; msg.textContent = `Revise el costo de ${x.p.nombre}.`; return; }
      if (!numOk(x.precio) || (x.precio !== "" && !(Number(x.precio) > 0))) { msg.className = "msg msg--error"; msg.textContent = `Revise el precio de venta de ${x.p.nombre}.`; return; }
    }
    const precios = filas.filter((x) => x.precio !== "").length;
    if (!confirm(`¿Guardar la entrada? Se suman ${filas.length} ${filas.length === 1 ? "producto" : "productos"} al inventario${precios ? ` y cambian ${precios} ${precios === 1 ? "precio" : "precios"} de venta` : ""}.`)) return;
    const b = $("#btnGuardarEntrada"); b.disabled = true; msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.rpc("registrar_entrada", { p: {
      proveedor: f.proveedor.value.trim(), documento: f.documento.value.trim(), fecha: f.fecha.value, nota: f.nota.value.trim(),
      items: filas.map((x) => ({ producto_id: x.p.id, cantidad: String(Number(x.cant)), costo: x.costo === "" ? "" : String(Number(x.costo)), precio: x.precio === "" ? "" : String(Number(x.precio)) }))
    } });
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); b.disabled = false; return; }
    ENT.clear();
    $("#dlgEntrada").close();
    toast(`Entrada ${data.id} guardada: ${data.productos} ${data.productos === 1 ? "producto" : "productos"} sumados al inventario`);
    invVista = "entradas";
    cargarInventario(); cargarProductos();
  });

  // ---------- ajuste de precios (como "Ajuste de Precios" de Moriah) ----------
  const AJ = new Map();     // id → { p, nuevo }
  const cambiaAJ = ({ p, nuevo }) => nuevo !== "" && Number(nuevo) >= 0 && Number(nuevo) !== (p.precio == null ? -1 : Number(p.precio));
  const difAJ = ({ p, nuevo }) => {
    if (nuevo === "" || p.precio == null || !cambiaAJ({ p, nuevo })) return "";
    const d = Math.round((Number(nuevo) - Number(p.precio)) * 100) / 100;
    return `<small class="${d > 0 ? "aj-sube" : "aj-baja"}">${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}</small>`;
  };
  function botonAjuste() {
    const n = [...AJ.values()].filter(cambiaAJ).length;
    $("#btnGuardarAjuste").disabled = !n;
    $("#btnGuardarAjuste").textContent = n ? `Actualizar ${n} ${n === 1 ? "precio" : "precios"}` : "Actualizar precios";
  }
  function pintarAjuste() {
    $("#ajFilas").innerHTML = [...AJ.values()].map((f) => `<tr>
        <td>${U.esc(f.p.codigo || "")}</td>
        <td>${U.esc(f.p.nombre)}</td>
        <td class="num">${f.p.precio != null ? fmt(f.p.precio) : "a consultar"}</td>
        <td class="num"><input type="number" min="0" step="0.01" inputmode="decimal" value="${U.esc(String(f.nuevo))}" data-aj-precio="${f.p.id}" aria-label="Precio nuevo de ${U.esc(f.p.nombre)}" /> <span data-aj-dif="${f.p.id}">${difAJ(f)}</span></td>
        <td><button type="button" class="enlace enlace--peligro" data-aj-quitar="${f.p.id}">Quitar</button></td>
      </tr>`).join("") || `<tr><td colspan="5" class="vacio-adm">Busque arriba los productos que quiere cambiar (nombre, código o lector de barras).</td></tr>`;
    botonAjuste();
  }
  buscadorProductos($("#ajBuscar"), $("#ajRes"), (p) => {
    if (!AJ.has(p.id)) AJ.set(p.id, { p, nuevo: p.precio != null ? Number(p.precio) : "" });
    pintarAjuste();
    const inp = $(`[data-aj-precio="${p.id}"]`);
    if (inp) { inp.focus(); inp.select(); }
  }, { ocultos: true, nada: "No se encontró ese producto." });
  $("#ajFilas").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-aj-precio]"); if (!inp) return;
    const f = AJ.get(Number(inp.dataset.ajPrecio)); if (!f) return;
    f.nuevo = inp.value.trim();
    $(`[data-aj-dif="${f.p.id}"]`).innerHTML = difAJ(f);
    botonAjuste();
  });
  $("#ajFilas").addEventListener("keydown", (e) => {
    // Enter en el precio vuelve al buscador para seguir agregando (como en Moriah)
    if (e.key === "Enter" && e.target.closest("[data-aj-precio]")) { e.preventDefault(); $("#ajBuscar").focus(); }
  });
  $("#ajFilas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-aj-quitar]"); if (!b) return;
    AJ.delete(Number(b.dataset.ajQuitar)); pintarAjuste();
  });
  $("#btnAjPct").addEventListener("click", () => {
    const pct = Number($("#ajPct").value);
    if (!pct || pct <= -90 || pct > 500) return toast("Escriba el porcentaje (por ejemplo 5 para subir 5 %, -10 para bajar 10 %).", true);
    let n = 0;
    for (const f of AJ.values()) {
      if (f.p.precio == null) continue;
      f.nuevo = Math.max(5, Math.round(Number(f.p.precio) * (1 + pct / 100) / 5) * 5); n++;
    }
    if (!n) return toast("Primero agregue productos que tengan precio.", true);
    pintarAjuste();
  });
  $("#btnAjustePrecios").addEventListener("click", () => {
    AJ.clear(); pintarAjuste();
    $("#ajPct").value = ""; $("#ajDoc").value = ""; $("#ajNota").value = "";
    $("#ajMsg").textContent = ""; $("#ajMsg").className = "msg";
    $("#ajEditar").hidden = false; $("#ajMovs").hidden = true; $("#btnAjMovs").hidden = false;
    $("#dlgAjuste").showModal();
    $("#ajBuscar").focus();
  });
  $("#dlgAjuste").addEventListener("click", (e) => {
    if (!e.target.closest("[data-cerrar-ajuste]")) return;
    if ([...AJ.values()].some(cambiaAJ) && !confirm("Hay precios sin guardar. ¿Cerrar de todos modos?")) return;
    $("#dlgAjuste").close();
  });
  $("#btnGuardarAjuste").addEventListener("click", async () => {
    const cambios = [...AJ.values()].filter(cambiaAJ);
    for (const f of cambios) {
      if (!/^[0-9]{1,10}(\.[0-9]{1,2})?$/.test(String(Number(f.nuevo)))) return toast(`Revise el precio de ${f.p.nombre}.`, true);
    }
    const sube = cambios.filter((f) => f.p.precio != null && Number(f.nuevo) > Number(f.p.precio)).length;
    if (!confirm(`¿Cambiar ${cambios.length} ${cambios.length === 1 ? "precio" : "precios"}${sube ? ` (${sube} suben)` : ""}? Queda anotado en Movimientos.`)) return;
    const b = $("#btnGuardarAjuste"), msg = $("#ajMsg");
    b.disabled = true; msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.rpc("ajustar_precios", {
      p_cambios: cambios.map((f) => ({ id: f.p.id, precio: String(Number(f.nuevo)) })),
      p_documento: $("#ajDoc").value.trim() || null, p_nota: $("#ajNota").value.trim() || null
    });
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); b.disabled = false; return; }
    msg.textContent = `Listo: ${data} ${data === 1 ? "precio actualizado" : "precios actualizados"}.`;
    AJ.clear(); $("#ajDoc").value = ""; $("#ajNota").value = ""; $("#ajPct").value = "";
    await cargarProductos();
    pintarAjuste();
    toast("Precios actualizados");
  });
  // historial de cambios de precio
  let movs = [];
  const ORIGEN_MOV = { ajuste: "Ajuste de precios", producto: "Editar producto", importacion: "Importación" };
  function pintarMovs() {
    const q = norm($("#ajMovBuscar").value);
    const lista = movs.filter((m) => !q || norm([m.productos?.nombre, m.productos?.codigo, m.documento, m.nota].join(" ")).includes(q));
    $("#ajMovFilas").innerHTML = lista.map((m) => `<tr>
        <td>${fechaCR(m.created_at, { dateStyle: "short", timeStyle: "short" })}</td>
        <td>${U.esc(m.productos?.nombre || "(borrado)")}${m.productos?.codigo ? `<small class="imp__cod">${U.esc(m.productos.codigo)}</small>` : ""}</td>
        <td class="num">${m.precio_antes != null ? fmt(m.precio_antes) : "—"}</td>
        <td class="num">${m.precio_nuevo != null ? fmt(m.precio_nuevo) : "a consultar"}</td>
        <td>${ORIGEN_MOV[m.origen] || U.esc(m.origen)}</td>
        <td>${U.esc([m.documento, m.nota].filter(Boolean).join(" · "))}</td>
      </tr>`).join("") || `<tr><td colspan="6" class="vacio-adm">${movs.length ? "Nada con ese filtro." : "Todavía no hay cambios de precio anotados."}</td></tr>`;
  }
  $("#btnAjMovs").addEventListener("click", async () => {
    $("#ajEditar").hidden = true; $("#ajMovs").hidden = false; $("#btnAjMovs").hidden = true;
    $("#ajMovFilas").innerHTML = `<tr><td colspan="6" class="vacio-adm">Cargando…</td></tr>`;
    const { data, error } = await db.from("precios_movimientos")
      .select("id,producto_id,precio_antes,precio_nuevo,origen,documento,nota,created_at,productos(nombre,codigo)")
      .order("created_at", { ascending: false }).limit(500);
    if (error) { $("#ajMovFilas").innerHTML = ""; return toast(errTxt(error), true); }
    movs = data || []; pintarMovs();
    $("#ajMovBuscar").focus();
  });
  $("#ajMovBuscar").addEventListener("input", pintarMovs);
  $("#btnAjVolver").addEventListener("click", () => {
    $("#ajEditar").hidden = false; $("#ajMovs").hidden = true; $("#btnAjMovs").hidden = false; $("#ajBuscar").focus();
  });

  // datos del emisor (Datos del negocio)
  const CAMPOS_FE = ["tipo_id", "identificacion", "nombre", "nombre_comercial", "actividad", "provincia", "canton", "distrito",
    "otras_senas", "telefono", "correo", "sucursal", "terminal", "proveedor_sistemas", "cabys_envio", "ambiente"];
  function pintarConfFE() {
    const f = $("#formFE"); if (!FE) return;
    CAMPOS_FE.forEach((k) => (f.elements[k].value = FE[k] ?? ""));
    f.activo.checked = !!FE.activo;
  }
  $("#formFE").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#feConfMsg");
    const d = { activo: f.activo.checked };
    CAMPOS_FE.forEach((k) => { const v = String(f.elements[k].value || "").trim(); d[k] = v === "" ? null : v; });
    ["identificacion", "actividad", "canton", "distrito", "telefono", "sucursal", "terminal", "cabys_envio"].forEach((k) => { if (d[k]) d[k] = U.soloDigitos(d[k]); });
    if (d.canton) d.canton = d.canton.padStart(2, "0");
    if (d.distrito) d.distrito = d.distrito.padStart(2, "0");
    d.sucursal = (d.sucursal || "001").padStart(3, "0"); d.terminal = (d.terminal || "00002").padStart(5, "0");
    if (d.ambiente === "produccion" && FE?.ambiente !== "produccion" &&
        !confirm("En producción cada tiquete y factura es real ante Hacienda. ¿Pasar a producción?")) return;
    msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.from("fe_emisor").update(d).eq("id", 1).select("*").single();
    if (error) {
      msg.className = "msg msg--error";
      msg.textContent = /check constraint/i.test(error.message || "") ? "Revise los datos: algún campo no tiene el formato correcto (cédula, actividad de 6 dígitos, cantón y distrito de 2, teléfono de 8, CABYS de 13)." : errTxt(error);
      return;
    }
    FE = data; pintarConfFE();
    msg.textContent = FE.activo ? `Guardado. Facturación encendida en ${FE.ambiente === "produccion" ? "PRODUCCIÓN" : "pruebas"}.` : "Guardado. La facturación está apagada.";
  });
  $("#btnProbarFE").addEventListener("click", async () => {
    const msg = $("#feConfMsg"), b = $("#btnProbarFE");
    b.disabled = true; msg.className = "msg"; msg.textContent = "Probando la llave y el usuario de Hacienda…";
    try { const r = await llamarFE({ accion: "probar" }); msg.textContent = r.mensaje; }
    catch (e) { msg.className = "msg msg--error"; msg.textContent = errTxt(e); }
    finally { b.disabled = false; }
  });

  // ---------- registrar pago ----------
  function leerMensajeBanco(txt) {
    const t = String(txt || "").replace(/\s+/g, " ");
    const out = {};
    const num = (s) => {
      s = s.replace(/[^\d.,]/g, "");
      const ult = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
      if (ult > -1 && s.length - ult - 1 === 2) return Number(s.slice(0, ult).replace(/[.,]/g, "") + "." + s.slice(ult + 1));
      return Number(s.replace(/[.,]/g, ""));
    };
    const m = t.match(/(?:₡|CRC|¢)\s*([\d][\d.,]*)/i) || t.match(/([\d][\d.,]*)\s*(?:colones|CRC)/i) || t.match(/monto(?: de)?:?\s*([\d][\d.,]*)/i);
    if (m) out.monto = num(m[1]);
    const r = t.match(/(?:ref(?:erencia)?|comprobante|documento|transacci[oó]n|n[uú]mero de (?:referencia|comprobante))\.?\s*(?:n[oº°]\.?\s*)?:?\s*#?\s*([0-9A-Za-z-]{6,40})/i);
    if (r) out.referencia = r[1];
    else { const largos = (t.match(/\d{10,30}/g) || []).sort((a, b) => b.length - a.length); if (largos[0]) out.referencia = largos[0]; }
    const tel = t.match(/(?:tel(?:[eé]fono)?|del n[uú]mero|celular)\.?:?\s*(?:\+?506[\s-]?)?([5-8]\d{3}[\s-]?\d{4})\b/i);
    if (tel) out.telefono_origen = tel[1];
    const n = t.match(/\bde\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ]+){1,4})/);
    if (n) out.nombre_origen = n[1];
    return out;
  }

  $("#btnLeerBanco").addEventListener("click", () => {
    const d = leerMensajeBanco($("#txtBanco").value), f = $("#formPago");
    const leidos = Object.keys(d);
    leidos.forEach((k) => { if (f.elements[k] && d[k]) f.elements[k].value = d[k]; });
    $("#pagoMsg").className = "msg";
    $("#pagoMsg").textContent = leidos.length ? "Datos leídos del mensaje. Revíselos antes de registrar." : "No se encontraron datos en el mensaje. Llene los campos a mano.";
  });

  async function subirComprobante(file) {
    let blob = file;
    if (U.tipoArchivo(file) !== "application/pdf") blob = await U.achicarComprobante(file);
    if (blob.size > 5 * 1024 * 1024) throw new Error("El comprobante pesa más de 5 MB.");
    const ext = blob.type === "application/pdf" ? "pdf" : blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
    const ruta = `${crypto.randomUUID()}.${ext}`;
    const { error } = await db.storage.from("comprobantes").upload(ruta, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    return ruta;
  }

  $("#formPago").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#pagoMsg"), p = V.pedido;
    msg.className = "msg msg--error";
    const d = {
      pedido_id: p.id,
      metodo: f.metodo.value,
      monto: Number(f.monto.value),
      referencia: f.referencia.value.trim().replace(/\s+/g, "") || null,
      telefono_origen: f.telefono_origen.value.trim() || null,
      nombre_origen: f.nombre_origen.value.trim() || null,
      fecha: f.fecha.value ? localCRaISO(f.fecha.value) : null,
      verificado: f.verificado.checked
    };
    if (!(d.monto > 0)) { msg.textContent = "Escriba el monto del pago."; return; }
    if (["sinpe", "transferencia"].includes(d.metodo) && !d.referencia) { msg.textContent = "Para SINPE o transferencia, el número de comprobante es obligatorio: así se evita usar el mismo comprobante dos veces."; f.referencia.focus(); return; }
    if (d.referencia && !/^[0-9A-Za-z-]{4,40}$/.test(d.referencia)) { msg.textContent = "El comprobante solo lleva números, letras o guiones."; return; }
    if (d.telefono_origen && !/^[0-9 +()-]{8,20}$/.test(d.telefono_origen)) { msg.textContent = "Revise el teléfono que pagó."; return; }
    if (!d.fecha) { msg.textContent = "Indique la fecha del pago."; return; }
    const saldo = p.total - p.pagado_registrado;
    if (d.monto > saldo + 0.001 && !confirm(`El monto (${fmt(d.monto)}) es mayor que lo que falta (${fmt(Math.max(0, saldo))}). ¿Registrar igual?`)) return;
    if (V.local) {
      const rec = cola.buscar(V.local);
      if (!rec) return;
      if (V.dirty) { msg.textContent = "Primero guarde los cambios de la venta."; return; }
      const usada = d.referencia && cola.leer().some((r) => (r.venta.pagos || []).some((g) => g.metodo === d.metodo && String(g.referencia || "").toUpperCase() === d.referencia.toUpperCase()));
      if (usada) { msg.textContent = "¡Alerta! Ese comprobante ya está en otra venta guardada sin internet."; return; }
      const { pedido_id, ...pago } = d;
      rec.venta.pagos = [...(rec.venta.pagos || []), pago];
      rec.error = null;
      cola.guardar(rec);
      f.reset();
      toast("Pago anotado. Se envía con la venta cuando haya internet.");
      abrirLocal(rec.id); pintarVentas();
      return;
    }
    if (d.verificado && !confirm(`¿Confirma que ve ${fmt(d.monto)} con el comprobante ${d.referencia || "(sin número)"} en la app del banco?`)) return;

    const btn = $("#btnGuardarPago");
    btn.disabled = true; msg.textContent = "";
    try {
      if (f.dataset.ruta) d.comprobante_path = f.dataset.ruta;
      const r = await db.from("pagos").insert(d).select("id").single();
      if (r.error) {
        if (r.error.code === "23505") {
          const dup = await db.from("pagos").select("pedidos(codigo,cliente_nombre)").ilike("referencia", d.referencia).eq("anulado", false).limit(1).maybeSingle();
          const ped = dup.data?.pedidos;
          throw new Error(`¡Alerta! Ese comprobante ya está registrado${ped ? ` en la venta ${ped.codigo} (${ped.cliente_nombre})` : ""}. No se puede usar dos veces.`);
        }
        throw r.error;
      }
      if (f.dataset.compId) {
        const u = await db.from("comprobantes_cliente").update({ estado: "registrado", pago_id: r.data.id }).eq("id", f.dataset.compId);
        if (u.error) toast("El pago quedó registrado, pero no se pudo marcar el comprobante del cliente: " + errTxt(u.error), true);
      }
      const archivo = f.dataset.ruta ? null : f.comprobante.files[0];
      if (archivo) {
        try {
          const ruta = await subirComprobante(archivo);
          const u = await db.from("pagos").update({ comprobante_path: ruta }).eq("id", r.data.id);
          if (u.error) throw u.error;
        } catch (err2) { toast("Pago registrado, pero la foto no se subió: " + errTxt(err2), true); }
      }
      $("#txtBanco").value = "";
      toast(d.verificado ? "Pago registrado y verificado" : "Pago registrado. Queda por verificar en el banco.");
      await abrirVenta(p.id);
      cargarVentas(); contarPorVerificar();
    } catch (err) {
      msg.textContent = errTxt(err);
    } finally { btn.disabled = false; }
  });

  async function verificarPago(id, monto, ref) {
    if (!confirm(`¿Confirma que ve ${fmt(monto)}${ref ? ` con el comprobante ${ref}` : ""} en la app del banco?`)) return false;
    const { error } = await db.from("pagos").update({ verificado: true }).eq("id", id);
    if (error) { toast(errTxt(error), true); return false; }
    toast("Pago verificado");
    contarPorVerificar();
    return true;
  }

  // ---------- preguntas de clientes ----------
  const ASUNTO = { producto: "Producto", precio: "Precio o cotización", envio: "Envíos", pedido: "Su pedido", otro: "Otra cosa" };
  let preguntas = [], filtroPreg = "nueva";

  async function cargarPreguntas() {
    if (SIN_RED || !navigator.onLine) {
      if ($("#tabPreg").getAttribute("aria-selected") === "true") $("#listaPreg").innerHTML = `<li class="vacio-adm">Sin internet: las preguntas se ven cuando vuelva la conexión.</li>`;
      return;
    }
    let r;
    try { r = await db.from("consultas").select("*, productos(nombre)").order("created_at", { ascending: false }).limit(300); } catch (e) { r = { error: e }; }
    if (r.error) {
      if (!U.esErrorRed(r.error)) $("#tabPreg").hidden = true;      // base sin v8
      return;
    }
    $("#tabPreg").hidden = false;
    preguntas = r.data;
    const n = preguntas.filter((p) => p.estado === "nueva").length;
    $("#badgePreg").hidden = !n; $("#badgePreg").textContent = n || "";
    pintarPreguntas();
  }

  function pintarPreguntas() {
    const lista = preguntas.filter((p) => p.estado === filtroPreg);
    $("#listaPreg").innerHTML = lista.map((p) => `<li class="fila fila--preg">
      <div class="fila__txt">
        <b>${U.esc(p.nombre)}</b>
        <small>${fechaCR(p.created_at)} · ${U.esc(U.fmtTel(p.telefono))}${p.correo ? " · " + U.esc(p.correo) : ""}</small>
        <span class="etiquetas"><span class="etq">${U.esc(ASUNTO[p.asunto] || p.asunto)}</span>${p.productos?.nombre ? `<span class="etq etq--web">${U.esc(p.productos.nombre)}</span>` : ""}${p.estado === "respondida" && p.respondida_at ? `<span class="etq etq--ok">Respondida ${fechaCR(p.respondida_at, { dateStyle: "short" })}</span>` : ""}</span>
        <p class="preg__msj">${U.esc(p.mensaje)}</p>
      </div>
      <div class="fila__acc preg__acc">
        <button type="button" class="btn btn--sm btn--wa" data-preg-wa="${p.id}">Responder por WhatsApp</button>
        ${p.estado === "nueva" ? `<button type="button" class="btn btn--sm btn--linea" data-preg-estado="respondida" data-id="${p.id}">Ya la respondí</button>` : ""}
        ${p.estado !== "archivada" ? `<button type="button" class="enlace" data-preg-estado="archivada" data-id="${p.id}">Archivar</button>` : `<button type="button" class="enlace" data-preg-estado="nueva" data-id="${p.id}">Volver a sin responder</button>`}
      </div>
    </li>`).join("") || `<li class="vacio-adm">${filtroPreg === "nueva" ? "No hay preguntas sin responder. Las que hagan los clientes en la página aparecen aquí." : "No hay preguntas en este grupo."}</li>`;
  }

  async function estadoPregunta(id, estado) {
    const { error } = await db.from("consultas").update({ estado, respondida_at: estado === "respondida" ? new Date().toISOString() : null }).eq("id", id);
    if (error) { toast(errTxt(error), true); return false; }
    await cargarPreguntas();
    return true;
  }

  $("#filtroPreg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    filtroPreg = b.dataset.f;
    $$("#filtroPreg [data-f]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarPreguntas();
  });
  $("#listaPreg").addEventListener("click", async (e) => {
    const wa = e.target.closest("[data-preg-wa]");
    if (wa) {
      const p = preguntas.find((x) => x.id == wa.dataset.pregWa); if (!p) return;
      const tel = U.soloDigitos(p.telefono);
      const corta = p.mensaje.length > 120 ? p.mensaje.slice(0, 117) + "…" : p.mensaje;
      const txt = `¡Hola, ${p.nombre}! Le escribimos de ${C.NEGOCIO} por su pregunta en la página: "${corta}"\n\n`;
      const w = window.open(`https://wa.me/${tel.length === 8 ? "506" + tel : tel}?text=${encodeURIComponent(txt)}`, "_blank");
      if (w) w.opener = null;
      if (p.estado === "nueva") estadoPregunta(p.id, "respondida");
      return;
    }
    const b = e.target.closest("[data-preg-estado]");
    if (b) { if (await estadoPregunta(Number(b.dataset.id), b.dataset.pregEstado)) toast(b.dataset.pregEstado === "archivada" ? "Pregunta archivada" : b.dataset.pregEstado === "respondida" ? "Marcada como respondida" : "Pregunta sin responder otra vez"); }
  });

  // ---------- respaldo en la compu ----------
  const LS_RESPALDO = "lc_ultimo_respaldo_v1";
  const TABLAS_RESPALDO = [
    ["categorias", "id"], ["productos", "id"], ["ajustes", "clave"], ["pedidos", "id"], ["pedido_items", "id"],
    ["pagos", "id"], ["comprobantes_cliente", "id"], ["facturas", "id"], ["consultas", "id"], ["archivos_borrados", "ruta"], ["auditoria", "id"],
    ["fe_emisor", "id"], ["fe_consecutivos", "ambiente"], ["fe_documentos", "id"], ["precios_movimientos", "id"],
    ["entradas", "id"], ["entrada_items", "id"], ["inventario_movimientos", "id"]
  ];

  function pintarUltimoRespaldo() {
    const t = leerLS(LS_RESPALDO, null), el = $("#respaldoUltimo");
    if (!t) { el.textContent = "Todavía no se ha hecho un respaldo en esta compu."; el.classList.add("msg--error"); return; }
    const dias = Math.floor((Date.now() - t) / 864e5);
    el.textContent = `Último respaldo en esta compu: ${fechaCR(new Date(t).toISOString(), { dateStyle: "long", timeStyle: "short" })}${dias ? ` (hace ${dias} ${dias === 1 ? "día" : "días"})` : " (hoy)"}.${dias >= 30 ? " Ya toca hacer otro." : ""}`;
    el.classList.toggle("msg--error", dias >= 30);
  }

  async function leerTabla(tabla, orden) {
    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await db.from(tabla).select("*").order(orden).range(desde, desde + 999);
      if (error) throw error;
      filas.push(...data);
      if (data.length < 1000) return filas;
    }
  }

  // el registro de actividad puede traer el token de Telegram: nunca va al respaldo
  const sinSecretos = (v) => Array.isArray(v) ? v.map(sinSecretos)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/token|secret|password|clave_api/i.test(k)).map(([k, x]) => [k, sinSecretos(x)]))
    : v;

  const aCsv = (filas) => {
    if (!filas.length) return "\ufeff";
    const cols = [...new Set(filas.flatMap((f) => Object.keys(f)))];
    return "\ufeff" + [cols, ...filas.map((f) => cols.map((c) => (f[c] !== null && typeof f[c] === "object" ? JSON.stringify(f[c]) : f[c])))]
      .map((r) => r.map(csvCelda).join(",")).join("\r\n");
  };

  $("#btnRespaldo").addEventListener("click", async () => {
    if (SIN_RED || !navigator.onLine) return toast("Sin internet: el respaldo se hace cuando vuelva la conexión.", true);
    const msg = $("#respaldoMsg"), btn = $("#btnRespaldo"), conFotos = $("#respaldoFotos").checked;
    btn.disabled = true; msg.className = "msg";
    try {
      const fecha = new Date(), dia = hoyCR();
      const tablas = {}, omitidas = [], archivos = [];
      for (const [t, orden] of TABLAS_RESPALDO) {
        msg.textContent = `Copiando ${t.replace(/_/g, " ")}…`;
        try { tablas[t] = sinSecretos(await leerTabla(t, orden)); }
        catch (e) { if (U.esErrorRed(e)) throw e; omitidas.push(t); }
      }
      for (const [t, filas] of Object.entries(tablas)) {
        // los XML de Hacienda van como archivos aparte; en el CSV solo los datos
        const csv = t === "fe_documentos" ? filas.map(({ xml_firmado, respuesta_xml, datos, ...r }) => r) : filas;
        archivos.push({ nombre: `tablas/${t}.csv`, datos: aCsv(csv) });
      }
      for (const d of tablas.fe_documentos || []) {
        const carpeta = `comprobantes-electronicos/${d.ambiente}/${String(d.fecha_emision).slice(0, 7)}`;
        archivos.push({ nombre: `${carpeta}/${d.clave}.xml`, datos: d.xml_firmado });
        if (d.respuesta_xml) archivos.push({ nombre: `${carpeta}/${d.clave}-respuesta.xml`, datos: d.respuesta_xml });
      }
      archivos.push({ nombre: "respaldo.json", datos: JSON.stringify({ sistema: "Almacén La Campiña", formato: 1, fecha: fecha.toISOString(), tablas }, null, 1) });

      let fotosOk = 0, fotosMal = 0;
      if (conFotos) {
        const rutas = [...new Set([...(tablas.pagos || []).map((g) => g.comprobante_path), ...(tablas.comprobantes_cliente || []).map((c) => c.ruta)].filter(Boolean))]
          .filter((r) => !(tablas.archivos_borrados || []).some((b) => b.ruta === r));
        for (let i = 0; i < rutas.length; i += 100) {
          const parte = rutas.slice(i, i + 100);
          const { data: urls } = await db.storage.from("comprobantes").createSignedUrls(parte, 600);
          for (let k = 0; k < parte.length; k++) {
            msg.textContent = `Copiando fotos de comprobantes… ${i + k + 1} de ${rutas.length}`;
            try {
              const u = urls && urls[k] && urls[k].signedUrl; if (!u) { fotosMal++; continue; }
              const r = await fetch(u); if (!r.ok) { fotosMal++; continue; }
              archivos.push({ nombre: `fotos/comprobantes/${parte[k]}`, datos: new Uint8Array(await r.arrayBuffer()) }); fotosOk++;
            } catch { fotosMal++; }
          }
        }
        const fotosProd = (tablas.productos || []).map((p) => p.imagen_url).filter((u) => u && /\/storage\/v1\/object\/public\/productos\//.test(u));
        for (const u of fotosProd) {
          msg.textContent = "Copiando fotos de productos…";
          try { const r = await fetch(u); if (r.ok) { archivos.push({ nombre: `fotos/productos/${u.split("/").pop()}`, datos: new Uint8Array(await r.arrayBuffer()) }); fotosOk++; } else fotosMal++; } catch { fotosMal++; }
        }
      }

      const resumen = Object.entries(tablas).map(([t, f]) => `  ${t}: ${f.length} filas`).join("\r\n");
      archivos.unshift({ nombre: "LEEME.txt", datos: [
        `RESPALDO DE ALMACÉN LA CAMPIÑA`, `Fecha: ${fechaCR(fecha.toISOString(), { dateStyle: "full", timeStyle: "short" })}`, ``,
        `Contenido:`, resumen, conFotos ? `  fotos: ${fotosOk}${fotosMal ? ` (${fotosMal} no se pudieron copiar)` : ""}` : `  fotos: no incluidas`,
        omitidas.length ? `  no copiadas (no existen en esta base): ${omitidas.join(", ")}` : ``, ``,
        `- La carpeta "tablas" tiene cada tabla en CSV (se abre con Excel).`,
        `- respaldo.json tiene todo junto: es el archivo para volver a cargar los datos si algún día hace falta.`,
        `- Este archivo tiene nombres, teléfonos y pagos de clientes: guárdelo en un lugar seguro y no lo comparta.`,
        `- No incluye contraseñas ni el token de Telegram.`
      ].join("\r\n") });

      msg.textContent = "Armando el archivo…";
      const zip = window.XlsxMini.zip(archivos, "application/zip");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(zip);
      a.download = `respaldo-la-campina-${dia}.zip`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      ponerLS(LS_RESPALDO, Date.now());
      pintarUltimoRespaldo();
      msg.textContent = `Respaldo descargado (${MB(zip.size)}): ${(tablas.pedidos || []).length} ventas, ${(tablas.productos || []).length} productos${conFotos ? `, ${fotosOk} fotos` : ""}. Guárdelo en la compu y, mejor aún, también en una memoria USB o en Drive.`;
      if (fotosMal) msg.textContent += ` ${fotosMal} fotos no se pudieron copiar.`;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    } finally { btn.disabled = false; }
  });

  // ---------- espacio de fotos y limpieza de comprobantes viejos ----------
  const LIMITE_FOTOS = 1024 ** 3, LIMITE_BASE = 500 * 1024 ** 2;
  const MB = (b) => (Number(b || 0) / 1048576).toLocaleString("es-CR", { maximumFractionDigits: b < 10 * 1048576 ? 1 : 0 }) + " MB";
  let viejos = null, enZip = [];

  async function cargarEspacio() {
    const txt = $("#espacioTxt");
    if (SIN_RED || !navigator.onLine) { txt.textContent = "Sin internet: el espacio se puede ver cuando vuelva la conexión."; return; }
    let r;
    try { r = await db.rpc("espacio_archivos"); } catch (e) { r = { error: e }; }
    if (r.error) {
      const falta = r.error.code === "PGRST202";
      txt.textContent = falta ? "Para ver el espacio y limpiar fotos viejas, corra supabase/v6_espacio.sql en Supabase." : errTxt(r.error);
      $("#boxLimpiar").hidden = falta;
      return;
    }
    $("#boxLimpiar").hidden = false;
    const b = r.data.buckets || {}, comp = b.comprobantes || {}, prod = b.productos || {};
    const fotos = Number(comp.bytes || 0) + Number(prod.bytes || 0);
    const pct = Math.min(100, (fotos / LIMITE_FOTOS) * 100);
    txt.textContent = `Fotos: ${MB(fotos)} de 1 GB (${pct.toLocaleString("es-CR", { maximumFractionDigits: pct < 10 ? 1 : 0 })} %).${pct >= 80 ? " Ya casi se llena: limpie comprobantes viejos." : ""}`;
    const m = $("#medidor");
    m.setAttribute("aria-valuenow", String(Math.round(pct)));
    m.classList.toggle("medidor--alto", pct >= 80);
    $("#medidorBarra").style.width = Math.max(pct, fotos > 0 ? 1 : 0) + "%";
    $("#espacioLista").innerHTML = `
      <li><b>Comprobantes</b> ${Number(comp.archivos || 0)} fotos · ${MB(comp.bytes)}</li>
      <li><b>Productos</b> ${Number(prod.archivos || 0)} fotos · ${MB(prod.bytes)}</li>
      <li><b>Base de datos</b> ${MB(r.data.base_bytes)} de 500 MB</li>`;
  }

  $("#btnBuscarViejos").addEventListener("click", async () => {
    const msg = $("#limpiarMsg"), meses = Number($("#limpiarMeses").value);
    msg.className = "msg"; msg.textContent = "Buscando…";
    $("#limpiarAcc").hidden = true; viejos = null; enZip = [];
    const { data, error } = await db.rpc("comprobantes_para_limpiar", { p_meses: meses });
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); return; }
    if (!data.total) { msg.textContent = `No hay fotos para limpiar de ventas cerradas de hace más de ${$("#limpiarMeses").selectedOptions[0].textContent}.`; return; }
    viejos = data;
    const n = data.fotos.length;
    msg.textContent = `Hay ${data.total} fotos (${MB(data.bytes)}) de ventas cerradas de hace más de ${$("#limpiarMeses").selectedOptions[0].textContent}.`
      + (data.total > n ? ` Se procesan de ${n} en ${n}: al terminar, busque otra vez para seguir.` : "")
      + " Primero descargue el ZIP.";
    $("#btnBorrarViejos").disabled = true;
    $("#limpiarAcc").hidden = false;
  });

  $("#btnZipViejos").addEventListener("click", async () => {
    if (!viejos) return;
    const msg = $("#limpiarMsg"), btn = $("#btnZipViejos");
    btn.disabled = true; msg.className = "msg";
    try {
      const fotos = viejos.fotos;
      const { data: urls, error } = await db.storage.from("comprobantes").createSignedUrls(fotos.map((f) => f.ruta), 600);
      if (error) throw error;
      const archivos = []; enZip = [];
      for (let i = 0; i < fotos.length; i++) {
        msg.textContent = `Descargando fotos… ${i + 1} de ${fotos.length}`;
        const u = urls[i] && urls[i].signedUrl;
        if (!u) continue;
        try {
          const res = await fetch(u);
          if (!res.ok) continue;
          const f = fotos[i], dia = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(f.fecha));
          const limpio = String(f.cliente || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30);
          archivos.push({ nombre: `${dia}_${f.codigo}_${limpio}_${f.ruta.split("/").pop()}`, datos: new Uint8Array(await res.arrayBuffer()) });
          enZip.push(f.ruta);
        } catch { /* esa foto se intenta en la próxima vuelta */ }
      }
      if (!archivos.length) throw new Error("No se pudo descargar ninguna foto. Revise la conexión.");
      const zip = window.XlsxMini.zip(archivos, "application/zip");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(zip);
      a.download = `comprobantes-viejos-${hoyCR()}.zip`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      msg.textContent = `ZIP descargado con ${archivos.length} fotos (${MB(zip.size)}). Ábralo y guárdelo en la compu o en Drive; después toque "Borrar del sistema".`;
      $("#btnBorrarViejos").disabled = false;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    } finally { btn.disabled = false; }
  });

  $("#btnBorrarViejos").addEventListener("click", async () => {
    if (!enZip.length) return;
    if (!confirm(`¿Borrar del sistema ${enZip.length} fotos de comprobantes? Los pagos quedan registrados; solo se borran las imágenes. Asegúrese de haber guardado el ZIP.`)) return;
    const msg = $("#limpiarMsg"), btn = $("#btnBorrarViejos");
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Borrando…";
    let borradas = 0;
    try {
      for (let i = 0; i < enZip.length; i += 100) {
        const parte = enZip.slice(i, i + 100);
        const { error } = await db.storage.from("comprobantes").remove(parte);
        if (error) throw error;
        const r = await db.rpc("marcar_fotos_borradas", { p_rutas: parte });
        if (r.error) throw r.error;
        borradas += Number(r.data) || 0;
      }
      msg.textContent = `Listo: se borraron ${borradas} fotos.${borradas < enZip.length ? " Algunas no se pudieron borrar; busque otra vez." : ""}`;
      $("#limpiarAcc").hidden = true; viejos = null; enZip = [];
      cargarEspacio();
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e); btn.disabled = false;
    }
  });

  // miniaturas de las fotos de comprobantes (enlaces privados que vencen en 10 minutos)
  async function cargarMiniaturas() {
    const imgs = $$("#compCliente img[data-mini]");
    if (!imgs.length || !navigator.onLine) return;
    const rutas = imgs.map((i) => i.dataset.mini);
    let r;
    try { r = await db.storage.from("comprobantes").createSignedUrls(rutas, 600); } catch { return; }
    (r.data || []).forEach((x, n) => { if (x && x.signedUrl && imgs[n].isConnected) imgs[n].src = x.signedUrl; });
  }

  async function verComprobante(path) {
    const { data, error } = await db.storage.from("comprobantes").createSignedUrl(path, 120);
    if (error) {
      const borrada = !U.esErrorRed(error) && /not.?found|no existe|404/i.test(String(error.message) + (error.statusCode || ""));
      return toast(borrada ? "Esa foto ya no está en el sistema: se borró al limpiar comprobantes viejos. Búsquela en el ZIP que se descargó." : errTxt(error), true);
    }
    const w = window.open(data.signedUrl, "_blank");
    if (w) w.opener = null;
  }

  $("#pagosVenta").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.comp) return verComprobante(b.dataset.comp);
    if (b.dataset.verificar) { if (await verificarPago(b.dataset.verificar, b.dataset.monto, b.dataset.ref)) { await abrirVenta(V.pedido.id); cargarVentas(); } }
    if (b.dataset.anularPago) {
      const motivo = prompt("Motivo de la anulación del pago (queda registrado):");
      if (motivo === null) return;
      const { error } = await db.from("pagos").update({ anulado: true, motivo_anulacion: motivo.trim().slice(0, 300) }).eq("id", b.dataset.anularPago);
      if (error) return toast(errTxt(error), true);
      toast("Pago anulado");
      await abrirVenta(V.pedido.id); cargarVentas(); contarPorVerificar();
    }
  });

  $("#compCliente").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.comp) return verComprobante(b.dataset.comp);
    const c = (V.comps || []).find((x) => x.id == (b.dataset.registrarComp || b.dataset.rechazarComp));
    if (!c) return;
    if (b.dataset.registrarComp) {
      const fp = $("#formPago");
      $("#boxPago").open = true;
      fp.metodo.value = "sinpe";
      if (c.monto_reportado) fp.monto.value = c.monto_reportado;
      fp.referencia.value = c.referencia_reportada || "";
      fp.telefono_origen.value = V.pedido.cliente_telefono || "";
      fp.nombre_origen.value = V.pedido.cliente_nombre || "";
      fp.fecha.value = ahoraLocalCR();
      fp.dataset.compId = c.id; fp.dataset.ruta = c.ruta;
      fp.comprobante.value = ""; fp.comprobante.disabled = true;
      $("#avisoComp").hidden = false;
      $("#pagoMsg").className = "msg";
      $("#pagoMsg").textContent = "Abra el comprobante, copie el número de referencia y revise el monto antes de registrar.";
      fp.referencia.focus();
      verComprobante(c.ruta);
    }
    if (b.dataset.rechazarComp) {
      const motivo = prompt("¿Por qué se rechaza este comprobante? El cliente verá el motivo en “Mi pedido”.");
      if (motivo === null) return;
      if (motivo.trim().length < 5) return toast("Escriba un motivo más claro (mínimo 5 letras).", true);
      const { error } = await db.from("comprobantes_cliente").update({ estado: "rechazado", motivo_rechazo: motivo.trim().slice(0, 300) }).eq("id", c.id);
      if (error) return toast(errTxt(error), true);
      toast("Comprobante rechazado");
      await abrirVenta(V.pedido.id); cargarVentas();
    }
  });

  $("#btnEntregar").addEventListener("click", async () => {
    const p = V.pedido;
    if (p.pagado_verificado < p.total && !confirm(`Esta venta no está pagada y verificada por completo (falta ${fmt(p.total - p.pagado_verificado)}). ¿Marcarla entregada igual?`)) return;
    const { error } = await db.from("pedidos").update({ estado: "entregada" }).eq("id", p.id);
    if (error) return toast(errTxt(error), true);
    toast("Venta entregada");
    await abrirVenta(p.id); cargarVentas();
  });

  $("#btnAnularVenta").addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula esta venta? (queda registrado)");
    if (motivo === null) return;
    const { error } = await db.from("pedidos").update({ estado: "anulada", motivo_anulacion: motivo.trim().slice(0, 300) }).eq("id", V.pedido.id);
    if (error) return toast(errTxt(error), true);
    toast("Venta anulada");
    refrescarExistencias(V.items.map((i) => i.producto_id));
    await abrirVenta(V.pedido.id); cargarVentas();
  });

  $("#btnBorrarVenta").addEventListener("click", async () => {
    if (V.local) {
      if (!confirm("¿Borrar esta venta hecha sin internet? Todavía no se ha enviado, así que se pierde.")) return;
      cola.quitar(V.local);
      $("#dlgVenta").close();
      toast("Venta borrada");
      pintarVentas(); estadoRedPanel();
      return;
    }
    if (!confirm("¿Borrar esta venta? No tiene pagos.")) return;
    const { error } = await db.from("pedidos").delete().eq("id", V.pedido.id);
    if (error) return toast(errTxt(error), true);
    $("#dlgVenta").close();
    toast("Venta borrada");
    refrescarExistencias(V.items.map((i) => i.producto_id));
    cargarVentas();
  });

  // ---------- caja SINPE ----------
  async function contarPorVerificar() {
    if (SIN_RED || !navigator.onLine) return;
    let count = 0;
    try { ({ count } = await db.from("pagos").select("id", { count: "exact", head: true }).eq("verificado", false).eq("anulado", false)); } catch { return; }
    $("#badgeCaja").hidden = !count;
    $("#badgeCaja").textContent = count || "";
  }

  async function cargarCaja() {
    const dia = $("#cajaDia").value || hoyCR();
    $("#cajaDia").value = dia;
    $("#cajaDia").max = hoyCR();
    const [ini, fin] = rangoDia(dia);
    const [delDia, pend] = await Promise.all([
      db.from("pagos").select("*, pedidos(id,codigo,cliente_nombre)").gte("fecha", ini).lt("fecha", fin).order("fecha"),
      db.from("pagos").select("*, pedidos(id,codigo,cliente_nombre)").eq("verificado", false).eq("anulado", false).order("fecha")
    ]);
    if (delDia.error || pend.error) return toast(errTxt(delDia.error || pend.error), true);

    const activos = delDia.data.filter((g) => !g.anulado);
    const sinpe = activos.filter((g) => g.metodo === "sinpe");
    const suma = (a) => a.reduce((s, g) => s + Number(g.monto), 0);
    const otros = activos.filter((g) => g.metodo !== "sinpe");
    const fechaTxt = new Date(dia + "T12:00:00-06:00").toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
    $("#resumenCaja").innerHTML = `
      <p class="conciliar__dia">${U.esc(fechaTxt)}</p>
      <dl class="cifras cifras--caja">
        <div><dt>SINPE recibidos</dt><dd>${fmt(suma(sinpe))}<small>${sinpe.length} pagos</small></dd></div>
        <div><dt>Ya verificados</dt><dd>${fmt(suma(sinpe.filter((g) => g.verificado)))}</dd></div>
        <div><dt>Falta verificar</dt><dd>${fmt(suma(sinpe.filter((g) => !g.verificado)))}</dd></div>
        <div><dt>Otros medios</dt><dd>${fmt(suma(otros))}<small>${otros.length} pagos</small></dd></div>
      </dl>
      <p class="ayuda">Para cuadrar: abra la app del banco, vea los SINPE recibidos de este día y compare con <b>${fmt(suma(sinpe))}</b>. Verifique uno por uno los que aparezcan allá; si alguno no aparece en el banco, <b>no lo verifique</b> y no entregue esa mercadería.</p>`;

    const fila = (g) => `<li class="fila fila--pago ${g.anulado ? "fila--oculta" : ""}">
      <div class="fila__monto"><b>${fmt(g.monto)}</b><small>${ETQ_METODO[g.metodo]}</small></div>
      <div class="fila__txt">
        <b>${g.referencia ? "Comp. " + U.esc(g.referencia) : "Sin comprobante"}</b>
        <small>${fechaCR(g.fecha)} · ${U.esc(g.nombre_origen || "")} ${U.esc(g.telefono_origen || "")}</small>
        <span class="etiquetas"><span class="codigo codigo--sm">${U.esc(g.pedidos?.codigo || "")}</span> ${U.esc(g.pedidos?.cliente_nombre || "")}
          ${g.anulado ? '<span class="etq">Anulado</span>' : g.verificado ? '<span class="etq etq--pagado">Verificado</span>' : '<span class="etq etq--por_verificar">Por verificar</span>'}</span>
      </div>
      <div class="fila__acc">
        ${g.comprobante_path ? `<button type="button" class="btn btn--sm btn--linea" data-comp="${U.esc(g.comprobante_path)}">Comprobante</button>` : ""}
        ${!g.anulado && !g.verificado ? `<button type="button" class="btn btn--sm btn--negro" data-verificar="${g.id}" data-monto="${g.monto}" data-ref="${U.esc(g.referencia || "")}">Ya lo vi en el banco</button>` : ""}
        <button type="button" class="enlace" data-ver-venta="${g.pedidos?.id}">Ver venta</button>
      </div>
    </li>`;
    $("#listaPorVerificar").innerHTML = pend.data.map(fila).join("") || `<li class="vacio-adm">Todo verificado. 👍</li>`;
    $("#tituloPorVerificar").textContent = `Pagos por verificar en el banco (${pend.data.length})`;
    $("#listaPagosDia").innerHTML = delDia.data.map(fila).join("") || `<li class="vacio-adm">No hay pagos registrados este día.</li>`;
    contarPorVerificar();
  }
  $("#cajaDia").addEventListener("change", cargarCaja);
  ["#listaPorVerificar", "#listaPagosDia"].forEach((sel) => $(sel).addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.comp) return verComprobante(b.dataset.comp);
    if (b.dataset.verificar) { if (await verificarPago(b.dataset.verificar, b.dataset.monto, b.dataset.ref)) cargarCaja(); }
    if (b.dataset.verVenta) abrirVenta(Number(b.dataset.verVenta));
  }));
  $("#dlgVenta").addEventListener("close", () => { if (!$("#tCaja").hidden) cargarCaja(); $("#recibo").replaceChildren(); });

  // ---------- imprimir recibo ----------
  const PAPELES = { "80": "assets/css/papel-80.css", "58": "assets/css/papel-58.css", carta: "assets/css/papel-carta.css" };
  const TIPO_ID = { fisica: "Cédula física", juridica: "Cédula jurídica", dimex: "DIMEX", nite: "NITE" };
  (function () {
    let guardado = null;
    try { guardado = localStorage.getItem("lc_papel"); } catch { /* sin almacenamiento */ }
    $("#papel").value = PAPELES[guardado] ? guardado : "80";
  })();
  $("#papel").addEventListener("change", (e) => { try { localStorage.setItem("lc_papel", e.target.value); } catch { /* sin almacenamiento */ } });

  function reciboHTML() {
    const p = V.pedido, aj = ajustesCache, fac = V.factura;
    const fila = (a, b) => `<div class="r-fila"><span>${a}</span><span>${b}</span></div>`;
    const tels = [aj.telefono || C.TELEFONO, aj.telefono2 || C.TELEFONO2].filter(Boolean).map(U.esc).join(" / ");
    const items = V.items.map((i) => `<div class="r-item">
        <div class="r-item__desc">${U.esc(i.descripcion)}</div>
        ${fila(`${Number(i.cantidad).toLocaleString("es-CR")} × ${fmt(i.precio_unit)}`, fmt(i.cantidad * i.precio_unit))}
      </div>`).join("");
    const pagos = V.pagos.filter((g) => !g.anulado);
    const saldo = Math.max(0, Number(p.total) - Number(p.pagado_registrado));
    let entrega = "";
    if (V4 && p.entrega === "envio") entrega = fila("Entrega", `Envío a ${U.esc(p.zona || "domicilio")}`) + (p.direccion ? `<div class="r-peq">${U.esc(p.direccion)}</div>` : "");
    else if (V4) entrega = fila("Entrega", "Retira en el almacén");
    let factura = "";
    if (fac) {
      factura = `<div class="r-lin"></div><div class="r-tit">Datos para factura electrónica</div>
        <div>${U.esc(fac.nombre)}</div>
        <div>${U.esc(TIPO_ID[fac.tipo_id] || fac.tipo_id)} ${U.esc(fac.identificacion)}</div>
        ${fac.correo ? `<div class="r-peq">${U.esc(fac.correo)}</div>` : ""}
        ${fac.consecutivo ? fila("Consecutivo", U.esc(fac.consecutivo)) : ""}
        ${fac.clave ? `<div class="r-peq">Clave</div><div class="r-clave">${U.esc(fac.clave)}</div>` : ""}
        <div class="r-peq">Estado: ${U.esc(ETQ_FAC[fac.estado] || fac.estado)}</div>`;
    }
    const valeFactura = fac && fac.estado === "aceptada";
    return `
      <div class="r-cab">
        <img class="r-logo" src="assets/img/marca.png" alt="" />
        <b class="r-neg">${U.esc(C.NEGOCIO)}</b>
        <span class="r-peq">${U.esc(aj.direccion || C.DIRECCION)}</span>
        ${tels ? `<span class="r-peq">Tel. ${tels}</span>` : ""}
      </div>
      <div class="r-lin"></div>
      ${p.estado === "anulada" ? `<div class="r-anulada">ANULADA</div>` : ""}
      ${p.local ? `<div class="r-centro r-peq">Venta hecha sin internet. Número temporal: el código final se asigna al enviarla.</div>` : ""}
      ${fila("Pedido", `<b>${U.esc(p.codigo)}</b>`)}
      ${fila("Fecha", fechaCR(p.created_at, { dateStyle: "short", timeStyle: "short" }))}
      ${fila("Cliente", U.esc(p.cliente_nombre))}
      ${p.cliente_telefono ? fila("Teléfono", U.esc(U.fmtTel(p.cliente_telefono))) : ""}
      ${entrega}
      <div class="r-lin"></div>
      ${items || "<div>Sin productos</div>"}
      <div class="r-lin"></div>
      <div class="r-fila r-total"><span>Total</span><span>${fmt(p.total)}</span></div>
      ${pagos.length ? fila("Pagado", fmt(p.pagado_registrado)) : ""}
      ${p.estado !== "anulada" ? fila(saldo > 0 ? "<b>Saldo pendiente</b>" : "Saldo", saldo > 0 ? `<b>${fmt(saldo)}</b>` : "Cancelado") : ""}
      ${pagos.length ? `<div class="r-lin"></div><div class="r-tit">Pagos</div>` + pagos.map((g) =>
        fila(`${U.esc(ETQ_METODO[g.metodo] || g.metodo)} ${fechaCR(g.fecha, { dateStyle: "short" })}${g.referencia ? `<br><span class="r-peq">Comp. ${U.esc(g.referencia)}</span>` : ""}`, fmt(g.monto))).join("") : ""}
      ${p.nota ? `<div class="r-lin"></div><div class="r-peq">Nota: ${U.esc(p.nota)}</div>` : ""}
      ${factura}
      <div class="r-lin"></div>
      ${valeFactura ? "" : `<div class="r-centro r-peq">Comprobante de venta. No es factura electrónica.</div>`}
      <div class="r-centro"><b>¡Gracias por su compra!</b></div>
      <div class="r-centro r-peq">Impreso ${fechaCR(new Date().toISOString(), { dateStyle: "short", timeStyle: "short" })}</div>`;
  }

  // espera a que cargue el estilo del papel y el logo antes de mandar a imprimir
  const esperar = (el, ok) => new Promise((res) => { if (ok) return res(); const t = setTimeout(res, 2500); el.addEventListener("load", () => { clearTimeout(t); res(); }, { once: true }); el.addEventListener("error", () => { clearTimeout(t); res(); }, { once: true }); });

  $("#btnImprimir").addEventListener("click", async () => {
    if (!V || !V.pedido) return;
    if (V.dirty) { toast("Primero guarde los cambios de la venta.", true); return; }
    const papel = PAPELES[$("#papel").value] ? $("#papel").value : "80";
    const css = $("#papelCss"), cambia = css.getAttribute("href") !== PAPELES[papel];
    const listoCss = esperar(css, !cambia);
    if (cambia) css.setAttribute("href", PAPELES[papel]);
    const r = $("#recibo");
    r.innerHTML = reciboHTML();
    const img = r.querySelector("img");
    await Promise.all([listoCss, esperar(img, img.complete)]);
    window.print();
  });

  // CSV (con protección contra fórmulas maliciosas al abrir en Excel)
  function csvCelda(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  async function descargarCsv(desde, hasta, nombre) {
    const { data, error } = await db.from("pagos").select("*, pedidos(codigo,cliente_nombre,total)").gte("fecha", desde).lt("fecha", hasta).order("fecha");
    if (error) return toast(errTxt(error), true);
    const cab = ["Fecha", "Venta", "Cliente", "Método", "Monto", "Comprobante", "Teléfono que pagó", "Nombre que pagó", "Verificado", "Verificado el", "Anulado", "Motivo anulación"];
    const filas = data.map((g) => [fechaCR(g.fecha, { dateStyle: "short", timeStyle: "short" }), g.pedidos?.codigo, g.pedidos?.cliente_nombre, ETQ_METODO[g.metodo], Number(g.monto).toFixed(2), g.referencia, g.telefono_origen, g.nombre_origen, g.verificado ? "Sí" : "No", g.verificado_at ? fechaCR(g.verificado_at, { dateStyle: "short", timeStyle: "short" }) : "", g.anulado ? "Sí" : "No", g.motivo_anulacion]);
    const csv = "﻿" + [cab, ...filas].map((r) => r.map(csvCelda).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = nombre;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $("#btnCsvDia").addEventListener("click", () => { const d = $("#cajaDia").value || hoyCR(); const [i, f] = rangoDia(d); descargarCsv(i, f, `caja-${d}.csv`); });
  $("#btnCsvMes").addEventListener("click", () => {
    const d = ($("#cajaDia").value || hoyCR()).slice(0, 7);
    const [y, m] = d.split("-").map(Number);
    const sig = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    descargarCsv(new Date(`${d}-01T00:00:00-06:00`).toISOString(), new Date(`${sig}-01T00:00:00-06:00`).toISOString(), `caja-${d}.csv`);
  });

  // =========================================================
  //  REPORTES
  // =========================================================
  let repPeriodo = "mes", repModo = "monto", repDatos = null;
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const compacto = (n) => n >= 1e6 ? "₡" + (n / 1e6).toLocaleString("es-CR", { maximumFractionDigits: 1 }) + " M"
    : n >= 1e4 ? "₡" + Math.round(n / 1e3).toLocaleString("es-CR") + " mil" : fmt(n);
  function rangoPeriodo(per) {
    const hoy = hoyCR(), [y, m] = hoy.split("-").map(Number);
    const ymd = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (per === "pasado") { const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; return [ymd(py, pm, 1), ymd(py, pm, new Date(Date.UTC(py, pm, 0)).getUTCDate())]; }
    if (per === "3m") { const d = new Date(Date.UTC(y, m - 3, 1)); return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), hoy]; }
    if (per === "anio") return [ymd(y, 1, 1), hoy];
    return [ymd(y, m, 1), hoy];
  }
  async function cargarReportes() {
    if (!V4) return;
    const [d, h] = rangoPeriodo(repPeriodo);
    $("#repRango").textContent = "Cargando…";
    const { data, error } = await db.rpc("reporte_ventas", { p_desde: d, p_hasta: h });
    if (error) { $("#repRango").textContent = ""; return toast(errTxt(error), true); }
    repDatos = data;
    pintarReportes();
  }
  const fechaLarga = (s) => new Date(s + "T12:00:00-06:00").toLocaleDateString("es-CR", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
  function pintarReportes() {
    const r = repDatos;
    if (!r) return;
    $("#repRango").textContent = `Del ${fechaLarga(r.desde)} al ${fechaLarga(r.hasta)}`;
    const n = Number(r.ventas) || 0, tot = Number(r.total) || 0;
    $("#repCifras").innerHTML = [
      ["Vendido", fmt(tot), `${n} ${n === 1 ? "venta" : "ventas"}`],
      ["Cobrado y verificado", fmt(r.cobrado), `Falta cobrar ${fmt(r.por_cobrar)}`],
      ["Venta promedio", fmt(n ? Math.round(tot / n) : 0), ""],
      ["Pedidos por la página", fmt(r.web?.total), `${r.web?.ventas || 0} de ${n} ventas${r.envios ? ` · ${r.envios} con envío` : ""}`]
    ].map(([t, v, sm]) => `<div><dt>${t}</dt><dd>${v}${sm ? `<small>${U.esc(sm)}</small>` : ""}</dd></div>`).join("");

    // ventas por mes: los 12 meses aunque alguno no tenga ventas
    const hoy = hoyCR(), [yy, mm] = hoy.split("-").map(Number);
    const porMes = Object.fromEntries((r.meses || []).map((x) => [x.mes, x]));
    const meses = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(yy, mm - 12 + i, 1));
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      return { k, y: d.getUTCFullYear(), m: d.getUTCMonth(), total: Number(porMes[k]?.total) || 0, ventas: Number(porMes[k]?.ventas) || 0, cobrado: Number(porMes[k]?.cobrado) || 0 };
    });
    const max = Math.max(...meses.map((x) => x.total), 1);
    const paso = [1, 2, 2.5, 5, 10].map((f) => f * 10 ** Math.floor(Math.log10(max / 4))).find((s) => max / s <= 4) || max / 4;
    const tope = Math.ceil(max / paso) * paso;
    const ticks = Array.from({ length: Math.round(tope / paso) + 1 }, (_, i) => i * paso);
    const iMax = meses.reduce((b, x, i) => (x.total > meses[b].total ? i : b), 0);
    $("#grafMeses").innerHTML = `<div class="columnas" role="list">
      <div class="columnas__ejes" aria-hidden="true">${ticks.map((t) => `<span style-top="${100 - (t / tope) * 100}"><i>${compacto(t)}</i></span>`).join("")}</div>
      ${meses.map((x, i) => {
        const curso = i === 11, nom = `${MESES[x.m]}${x.m === 0 || i === 0 ? " " + String(x.y).slice(2) : ""}`;
        const tip = `${MESES[x.m]} ${x.y}${curso ? " (en curso)" : ""}: ${fmt(x.total)} en ${x.ventas} ${x.ventas === 1 ? "venta" : "ventas"}`;
        return `<button type="button" class="columna${curso ? " columna--curso" : ""}" role="listitem" data-tip="${U.esc(tip)}" aria-label="${U.esc(tip)}">
          <span class="columna__barra" style-h="${(x.total / tope) * 100}">${i === iMax && x.total > 0 ? `<em>${compacto(x.total)}</em>` : ""}</span>
          <span class="columna__mes">${nom}</span></button>`;
      }).join("")}
    </div>`;
    // posiciones sin estilos en línea (la CSP los bloquea): se aplican con CSSOM
    $$("#grafMeses [style-h]").forEach((el) => { el.style.height = el.getAttribute("style-h") + "%"; el.removeAttribute("style-h"); });
    $$("#grafMeses [style-top]").forEach((el) => { el.style.top = el.getAttribute("style-top") + "%"; el.removeAttribute("style-top"); });
    $("#tablaMeses").innerHTML = `<table class="items"><thead><tr><th>Mes</th><th class="num">Ventas</th><th class="num">Vendido</th><th class="num">Cobrado</th></tr></thead><tbody>${meses.map((x) =>
      `<tr><td>${MESES[x.m]} ${x.y}</td><td class="num">${x.ventas}</td><td class="num">${fmt(x.total)}</td><td class="num">${fmt(x.cobrado)}</td></tr>`).join("")}</tbody></table>`;

    pintarTop();
    const met = r.metodos || [], maxM = Math.max(...met.map((x) => Number(x.total)), 1);
    $("#repMetodos").innerHTML = met.length ? barrasH(met.map((x) => ({ nombre: ETQ_METODO[x.metodo] || x.metodo, valor: Number(x.total), txt: fmt(x.total), tip: `${ETQ_METODO[x.metodo] || x.metodo}: ${fmt(x.total)} recibidos` })), maxM)
      : '<p class="ayuda">No hay pagos registrados en este periodo.</p>';
    aplicarAnchos($("#repMetodos"));
  }
  function barrasH(filas, max) {
    return `<ul class="barras">${filas.map((f) => `<li>
      <button type="button" class="barra-h" data-tip="${U.esc(f.tip)}" aria-label="${U.esc(f.tip)}">
        <span class="barra-h__nom">${U.esc(f.nombre)}</span>
        <span class="barra-h__fila"><span class="barra-h__barra" style-w="${Math.max(1, (f.valor / max) * 100)}"></span><b>${U.esc(f.txt)}</b></span>
      </button></li>`).join("")}</ul>`;
  }
  const aplicarAnchos = (raiz) => $$("[style-w]", raiz).forEach((el) => { el.style.width = el.getAttribute("style-w") + "%"; el.removeAttribute("style-w"); });
  function pintarTop() {
    const l = (repModo === "monto" ? repDatos.top_monto : repDatos.top_cantidad) || [];
    const val = (x) => Number(repModo === "monto" ? x.monto : x.cantidad);
    const max = Math.max(...l.map(val), 1);
    const nf = (n) => Number(n).toLocaleString("es-CR", { maximumFractionDigits: 2 });
    $("#grafTop").innerHTML = l.length ? barrasH(l.map((x) => ({
      nombre: x.nombre, valor: val(x), txt: repModo === "monto" ? compacto(Number(x.monto)) : nf(x.cantidad),
      tip: `${x.nombre}: ${nf(x.cantidad)} vendidos por ${fmt(x.monto)}`
    })), max) : '<p class="ayuda">Todavía no hay ventas en este periodo.</p>';
    aplicarAnchos($("#grafTop"));
  }
  $("#repPeriodo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    repPeriodo = b.dataset.p;
    $$("#repPeriodo [data-p]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    cargarReportes();
  });
  $("#repTopModo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b || !repDatos) return;
    repModo = b.dataset.m;
    $$("#repTopModo [data-m]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarTop();
  });
  // Globo con el dato al pasar el mouse o con el teclado
  function mostrarTip(el) {
    const t = $("#tipGraf");
    t.textContent = el.dataset.tip;
    t.hidden = false;
    const r = el.getBoundingClientRect(), w = t.offsetWidth;
    t.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    t.style.top = Math.max(8, r.top - t.offsetHeight - 8) + "px";
  }
  ["mouseover", "focusin"].forEach((ev) => $("#tRep").addEventListener(ev, (e) => { const el = e.target.closest("[data-tip]"); if (el) mostrarTip(el); }));
  ["mouseout", "focusout"].forEach((ev) => $("#tRep").addEventListener(ev, (e) => { if (e.target.closest("[data-tip]")) $("#tipGraf").hidden = true; }));
  addEventListener("scroll", () => ($("#tipGraf").hidden = true), { passive: true });

  // =========================================================
  //  IMPORTAR / EXPORTAR PRODUCTOS (Excel)
  // =========================================================
  const COLS = [
    ["nombre", "Nombre", /^(nombre|producto|articulo|descripcion del producto)$/],
    ["codigo", "Código", /^(codigo|cod|codigo interno|sku|codigo de barras)$/],
    ["categoria", "Categoría", /^categoria/],
    ["precio", "Precio", /^precio( normal| colones| ₡)?$/],
    ["existencia", "Existencia", /^(existencia|exist ?1?|stock|inventario|cantidad)$/],
    ["unidad", "Se vende por", /^(se vende por|unidad|presentacion|medida)/],
    ["descripcion", "Descripción", /^descripcion/],
    ["activo", "Mostrar", /^(mostrar|visible|activo|en el sitio)/],
    ["destacado", "Recomendado", /^(recomendado|destacado)/],
    ["agotado", "Agotado", /^agotado/],
    ["imagen_url", "Foto (enlace)", /^(foto|imagen)/],
    ["cabys", "CABYS", /^(codigo )?cabys$/]
  ];
  const ANCHOS = [44, 16, 26, 12, 11, 16, 50, 10, 13, 10, 50, 16];
  const COLS_V4 = ["agotado"], COLS_V9 = ["codigo", "existencia", "cabys"];
  const colUsable = (k) => (V4 || !COLS_V4.includes(k)) && (V9 || !COLS_V9.includes(k));
  function descargar(blob, nombre) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const colsHoja = () => COLS.map((c, i) => [...c, ANCHOS[i]]).filter((c) => colUsable(c[0]));
  $("#btnPlantilla").addEventListener("click", () => descargar(XlsxMini.escribir([colsHoja().map((c) => c[1])], { hoja: "Productos", anchos: colsHoja().map((c) => c[3]) }), "plantilla-productos.xlsx"));
  $("#btnExportar").addEventListener("click", () => {
    const sn = (b) => (b ? "Sí" : "No"), cat = (id) => categorias.find((c) => c.id === id)?.nombre || "";
    const valor = {
      nombre: (p) => p.nombre, codigo: (p) => p.codigo || "", categoria: (p) => cat(p.categoria_id),
      precio: (p) => (p.precio == null ? "" : Number(p.precio)), existencia: (p) => (p.existencia == null ? "" : Number(p.existencia)),
      unidad: (p) => p.unidad || "", descripcion: (p) => p.descripcion || "", activo: (p) => sn(p.activo), destacado: (p) => sn(p.destacado),
      agotado: (p) => sn(p.agotado), imagen_url: (p) => p.imagen_url || "", cabys: (p) => p.cabys || ""
    };
    const cols = colsHoja();
    const filas = [cols.map((c) => c[1])].concat(productos.map((p) => cols.map((c) => valor[c[0]](p))));
    descargar(XlsxMini.escribir(filas, { hoja: "Productos", anchos: cols.map((c) => c[3]) }), `productos-la-campina-${hoyCR()}.xlsx`);
  });

  // Unidades que en Moriah significan "por unidad" (no hace falta mostrarlas)
  const unidadLimpia = (u) => {
    const s = String(u ?? "").trim();
    if (/^(unid|unidad|und|un|u|c\/u|pza|pieza)\.?$/i.test(s)) return "";
    return { m: "metro", mts: "metro", kg: "kg", lt: "litro", ltr: "litro", gl: "galón" }[s.toLowerCase()] || s;
  };
  const leerCantidad = (v) => {
    const s = String(v ?? "").trim().replace(/\s/g, "");
    if (!s) return { v: "" };
    const n = Number(s.replace(/,(?=\d{1,4}$)/, ".").replace(/,/g, ""));
    if (!Number.isFinite(n) || Math.abs(n) > 9999999999) return { error: `Existencia no válida: ${v}` };
    return { v: String(Math.round(n * 100) / 100) };
  };

  function leerPrecio(v) {
    let s = String(v ?? "").trim().replace(/₡|¢|CRC|colones|\s/gi, "");
    if (!s) return { v: "" };
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");      // 5.450 o 1.250.000 = miles, como se escribe en Costa Rica
    if (!/^\d+(\.\d+)?$/.test(s)) {
      if (!/^[\d.,]+$/.test(s)) return { error: `Precio no válido: ${v}` };
      const ult = Math.max(s.lastIndexOf("."), s.lastIndexOf(",")), dec = s.length - ult - 1;
      s = (s.includes(".") && s.includes(",")) || dec === 1 || dec === 2
        ? s.slice(0, ult).replace(/[.,]/g, "") + "." + s.slice(ult + 1)
        : s.replace(/[.,]/g, "");
    }
    const n = Math.round(Number(s) * 100) / 100;
    if (!Number.isFinite(n) || n < 0 || n > 9999999999) return { error: `Precio no válido: ${v}` };
    return { v: String(n) };
  }
  function leerSiNo(v) {
    const s = norm(v);
    if (!s) return undefined;
    if (/^(si|s|x|1|true|verdadero|yes)$/.test(s)) return true;
    if (/^(no|n|0|false|falso)$/.test(s)) return false;
    return null;
  }
  let importacion = [];
  $("#btnImportar").addEventListener("click", () => {
    importacion = [];
    $("#impArchivo").value = ""; $("#impVista").hidden = true; $("#btnHacerImport").disabled = true;
    $("#impMsg").textContent = ""; $("#impMsg").className = "msg";
    $("#dlgImport").showModal();
  });
  $("#btnCerrarImport").addEventListener("click", () => $("#dlgImport").close());
  $("#impArchivo").addEventListener("change", async () => {
    const msg = $("#impMsg"), file = $("#impArchivo").files[0];
    importacion = []; $("#impVista").hidden = true; $("#btnHacerImport").disabled = true;
    msg.className = "msg"; msg.textContent = "Leyendo archivo…";
    try {
      const filas = await XlsxMini.leer(file);
      // ¿Es el inventario exportado de Moriah? (trae "Tip-Cod" y "Codigo Cabys"; el nombre va en la columna sin título que sigue)
      const iMoriah = filas.slice(0, 6).findIndex((f) => f.celdas.some((c) => norm(c) === "tip-cod") && f.celdas.some((c) => norm(c) === "codigo cabys"));
      const iCab = iMoriah >= 0 ? iMoriah : filas.slice(0, 6).findIndex((f) => f.celdas.some((c) => COLS[0][2].test(norm(c))));
      if (iCab < 0) throw new Error("No se encontró la columna “Nombre”. Use la plantilla o ponga los títulos en la primera fila.");
      if (iMoriah >= 0 && !V9) throw new Error("Para importar el inventario de Moriah, primero corra supabase/v9_inventario.sql en Supabase.");
      const cab = filas[iCab].celdas.map((c) => norm(c));
      let mapa;
      if (iMoriah >= 0) {
        const col = (t) => cab.indexOf(t);
        mapa = [["codigo", col("codigo")], ["cabys", col("codigo cabys")], ["nombre", col("codigo cabys") + 1],
                ["unidad", col("unidad")], ["precio", col("precio")], ["existencia", col("exist 1")]].filter(([k, i]) => i >= 0 && colUsable(k));
      } else {
        mapa = COLS.map(([k, , re]) => [k, cab.findIndex((h) => re.test(h))]).filter(([k, i]) => i >= 0 && colUsable(k));
      }
      const porCodigo = new Set(productos.filter((p) => p.codigo).map((p) => String(p.codigo)));
      const porNombre = new Set(productos.filter((p) => !p.codigo).map((p) => norm(p.nombre)));
      const vistos = new Set();
      for (const f of filas.slice(iCab + 1)) {
        if (mapa.every(([, i]) => String(f.celdas[i] ?? "").trim() === "")) continue;     // fila vacía
        const fila = { fila: f.r };
        let error = "";
        for (const [k, i] of mapa) {
          const v = f.celdas[i] ?? "";
          if (k === "precio") { const p = leerPrecio(v); if (p.error) error = p.error; else fila.precio = p.v === "0" ? "" : p.v; }
          else if (k === "existencia") { const c = leerCantidad(v); if (c.error) error = c.error; else if (c.v !== "") fila.existencia = c.v; }
          else if (["activo", "destacado", "agotado"].includes(k)) { const b = leerSiNo(v); if (b === null) error = `No se entiende “${v}” (use Sí o No)`; else if (b !== undefined) fila[k] = b; }
          else if (k === "imagen_url") { const u = String(v).trim(); if (u && !/^https:\/\/\S+$/.test(u)) error = "La foto debe ser un enlace que empiece con https://"; else if (u) fila.imagen_url = u; }
          else if (k === "codigo") { const c = String(v).replace(/[\s'"\ufeff]/g, ""); if (c.length > 40) error = "Código muy largo"; else if (c) fila.codigo = c; }
          else if (k === "cabys") { const c = String(v).replace(/\D/g, ""); if (/^\d{13}$/.test(c)) fila.cabys = c; }
          else if (k === "unidad") { const u = unidadLimpia(v); if (u) fila.unidad = u; }
          else if (k === "categoria") { const c = String(v).trim(); if (c && !/^(sin categoria|general)$/.test(norm(c))) fila.categoria = c; }
          else fila[k] = String(v).trim();
        }
        // Moriah pega "Detalle:" al final del nombre
        fila.nombre = String(fila.nombre || "").split(/\n\s*detalle\s*:/i)[0].replace(/\s+/g, " ").trim().slice(0, 100);
        const llave = fila.codigo ? "c:" + fila.codigo : "n:" + norm(fila.nombre);
        if (fila.nombre.length < 2) error = error || "Falta el nombre";
        else if (/\(prueba\)/i.test(fila.nombre)) error = error || "Producto de prueba";
        else if (vistos.has(llave)) error = error || (fila.codigo ? "Código repetido en el archivo" : "Nombre repetido en el archivo");
        vistos.add(llave);
        const nuevo = fila.codigo ? !porCodigo.has(fila.codigo) && !porNombre.has(norm(fila.nombre)) : !porNombre.has(norm(fila.nombre));
        // productos nuevos sin categoría: se les busca una por el nombre
        if (nuevo && !fila.categoria && window.Clasificar) { fila.categoria = window.Clasificar.clasificar(fila.nombre); fila._auto = true; }
        importacion.push({ fila, error, nuevo });
      }
      const ok = importacion.filter((x) => !x.error), malas = importacion.length - ok.length;
      if (!importacion.length) throw new Error("El archivo no trae productos debajo de los títulos.");
      $("#impFilas").innerHTML = importacion.slice(0, 300).map((x) => `<tr class="${x.error ? "imp--error" : ""}">
        <td>${x.fila.fila}</td><td>${U.esc(x.fila.nombre)}${x.fila.codigo ? `<small class="imp__cod">${U.esc(x.fila.codigo)}</small>` : ""}</td><td>${U.esc(x.fila.categoria || "")}${x.fila._auto ? ' <small class="imp__cod">automática</small>' : ""}</td>
        <td class="num">${x.fila.precio === undefined ? "" : x.fila.precio === "" ? "a consultar" : U.esc(fmt(x.fila.precio))}</td>
        <td>${x.error ? `<b>No se importa:</b> ${U.esc(x.error)}` : x.nuevo ? "Producto nuevo" : "Actualiza el existente"}</td></tr>`).join("") +
        (importacion.length > 300 ? `<tr><td colspan="5" class="vacio-adm">… y ${importacion.length - 300} filas más</td></tr>` : "");
      $("#impVista").hidden = false;
      const nuevos = ok.filter((x) => x.nuevo).length, sinExist = ok.filter((x) => x.fila.existencia !== undefined && Number(x.fila.existencia) <= 0).length;
      msg.textContent = `${iMoriah >= 0 ? "Inventario de Moriah. " : ""}${ok.length} listos: ${nuevos} nuevos y ${ok.length - nuevos} para actualizar.`
        + (sinExist ? ` ${sinExist} sin existencia quedan como agotados.` : "")
        + (ok.some((x) => x.fila._auto) ? " A los nuevos sin categoría se les puso una según el nombre (se puede cambiar después)." : "")
        + `${malas ? ` ${malas} con errores no se importan.` : ""} Columnas: ${mapa.map(([k]) => COLS.find((c) => c[0] === k)[1]).join(", ")}.`;
      $("#btnHacerImport").disabled = !ok.length;
      $("#btnHacerImport").textContent = `Importar ${ok.length} ${ok.length === 1 ? "producto" : "productos"}`;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    }
  });
  $("#btnHacerImport").addEventListener("click", async () => {
    const b = $("#btnHacerImport"), msg = $("#impMsg");
    const conExist = !$("#impExistencias") || $("#impExistencias").checked;
    const filas = importacion.filter((x) => !x.error).map(({ fila: { _auto, ...f } }) => { if (!conExist) delete f.existencia; return f; });
    if (!filas.length) return;
    if (!confirm(`¿Importar ${filas.length} productos? Los que ya existen se actualizan con los datos del archivo.`)) return;
    b.disabled = true;
    const tot = { insertados: 0, actualizados: 0, categorias_nuevas: 0, errores: [] };
    try {
      for (let i = 0; i < filas.length; i += 1000) {
        msg.className = "msg"; msg.textContent = `Importando… ${Math.min(i + 1000, filas.length)} de ${filas.length}`;
        const { data, error } = await db.rpc("importar_productos", { p_filas: filas.slice(i, i + 1000) });
        if (error) throw error;
        tot.insertados += data.insertados; tot.actualizados += data.actualizados; tot.categorias_nuevas += data.categorias_nuevas;
        tot.errores.push(...(data.errores || []));
      }
      msg.className = tot.errores.length ? "msg msg--error" : "msg";
      msg.textContent = `Listo: ${tot.insertados} nuevos, ${tot.actualizados} actualizados${tot.categorias_nuevas ? `, ${tot.categorias_nuevas} categorías nuevas` : ""}.` +
        (tot.errores.length ? ` No se pudieron importar: ${tot.errores.slice(0, 5).map((x) => `fila ${x.fila} (${x.error})`).join("; ")}${tot.errores.length > 5 ? "…" : ""}` : "");
      await cargarCategorias();
      await cargarProductos();
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
      b.disabled = false;
    }
  });

  U.registrarCopia();
  initAcceso();
})();
