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
  // preguntas y avisos con el estilo del panel (en vez de las ventanitas grises del navegador)
  let colaPreg = Promise.resolve();
  function ventana({ texto, titulo = "", si = "Sí, seguir", no = "Cancelar", peligro = false, cobrar = false, campo = null }) {
    const abrir = () => new Promise((res) => {
      const dl = $("#dlgPregunta"), inp = $("#preguntaCampo"), bSi = $("#preguntaSi"), bNo = $("#preguntaNo");
      $("#preguntaTit").textContent = titulo;
      $("#preguntaTxt").textContent = texto;
      bSi.textContent = si;
      bSi.className = `btn ${peligro ? "btn--peligro" : cobrar ? "btn--cobrar" : "btn--negro"}`;
      bNo.textContent = no || ""; bNo.hidden = !no;
      $("#preguntaCampoLbl").hidden = campo === null;
      inp.value = campo ?? "";
      dl.returnValue = "";
      dl.addEventListener("close", () => {
        const ok = dl.returnValue === "si";
        res(campo === null ? ok : ok ? inp.value : null);
      }, { once: true });
      dl.showModal();
      if (campo !== null) { inp.focus(); inp.select(); } else bSi.focus();
    });
    const p = colaPreg.then(abrir);
    colaPreg = p.catch(() => {});
    return p;
  }
  const preguntar = (texto, o = {}) => ventana({ texto, peligro: /^¿?(Borrar|Anular|Quitar|Eliminar|Rechazar)/i.test(texto), ...o });
  const pedirTexto = (texto, inicial = "", o = {}) => ventana({ texto, campo: inicial ?? "", si: "Aceptar", ...o });
  const avisar = (texto, o = {}) => ventana({ texto, si: "Entendido", no: null, ...o });
  const errTxt = (e) => U.esErrorRed(e) ? "Sin internet: esto se puede hacer cuando vuelva la conexión." : (e && e.message) || "Algo falló. Intente de nuevo.";

  // =========================================================
  //  SIN INTERNET: copia de datos, permiso y ventas por enviar
  // =========================================================
  const LS_COLA = "lc_ventas_sin_red_v1", LS_COPIA = "lc_copia_panel_v1", LS_PERMISO = "lc_panel_sin_red_v1", LS_NUM = "lc_sin_red_num_v1";
  // lo demás que se hace sin internet (pagos, entregas, anulaciones, abonos, caja, comprobantes) y se manda después, en orden
  const LS_ACC = "lc_acciones_sin_red_v1", LS_ENVIADAS = "lc_ventas_enviadas_v1";
  // comprobantes electrónicos sin internet: identificador de esta compu y sus números reservados (no se borran al salir)
  const LS_DISP = "lc_dispositivo_v1", LS_FE_RED = "lc_fe_sin_red_v1";
  const HORAS_SIN_RED = 72;  // sin internet se puede volver a entrar hasta 3 días después de la última vez con internet
  let SIN_RED = false;     // panel abierto sin conexión (con la copia de la última vez)
  let V19 = false;         // la base acepta crédito, caja y comprobantes sin internet (v19_sin_internet.sql)
  let V9 = false;          // la base tiene código y existencia en productos (v9_inventario.sql)
  let V10 = false;         // la base tiene facturación electrónica (v10_facturacion.sql)
  let FE = null;           // datos del emisor (fe_emisor)
  let V11 = false;         // la base tiene historial de precios (v11_precios.sql)
  let V12 = false;         // la base lleva inventario (v12_inventario.sql)
  let V13 = false;         // la base tiene crédito a clientes (v13_credito.sql)
  let V14 = false;         // la base tiene cierre de caja (v14_caja.sql)
  let V15 = false;         // la base anota lo más vendido (v15_mas_vendidos.sql)
  let V16 = false;         // bitácora con nombres y roles (v16_bitacora.sql)
  let YO = null, USUARIOS = [];   // usuario conectado y usuarios del panel (v16)
  // Qué puede la persona que entró (v17). null = base sin v17: todo como administrador.
  let ACCESO = null, V17 = false;   // V17: la base tiene empleados con permisos (v17_permisos.sql)
  let V18 = false;         // cheque, saldos de Moriah y apartados (v18_cheque_saldos_apartados.sql)
  let V21 = false;         // salidas/conteos, compras y proveedores, facturas recibidas (v21_compras_ajustes.sql)
  let V22 = false;
  let V23 = false;
  let V24 = false;
  let V25 = false;         // factura electrónica de compra (v25_factura_compra.sql)         // precio 2 y descuento por cliente (v24_precios_cliente.sql)         // devoluciones parciales (v23_devoluciones.sql)         // exoneración de IVA en ventas (v22_exoneracion.sql)
  // pestañas y pantallas: sin v17 todos los del panel las ven, como antes
  const soyAdministrador = () => !ACCESO || ACCESO.rol === "administrador";
  // borrar ventas y cambiar roles: sin v17 se usa el rol de v16
  const esAdministradorReal = () => (ACCESO ? ACCESO.rol === "administrador" : !V16 || YO?.rol === "administrador");
  const puede = (p) => !ACCESO || ACCESO.rol === "administrador" || (ACCESO.permisos || []).includes(p);
  const PERMISOS = [
    ["ventas", "Ventas y cobros"], ["anular", "Anular ventas"], ["caja", "Caja"], ["credito", "Crédito y abonos"],
    ["inventario", "Inventario (entradas)"], ["productos", "Productos y fotos"], ["precios", "Cambiar precios"],
    ["reportes", "Reportes"], ["preguntas", "Preguntas de clientes"], ["compras", "Compras y proveedores"]
  ];
  const PLANTILLAS = { caja: ["ventas", "caja", "credito"], inventario: ["inventario", "productos"], contador: ["reportes"] };
  let clientes = [];       // clientes de crédito con su saldo (v_clientes_credito)
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
      ids.slice(150).forEach((x) => delete det[x]);         // solo las últimas 150 ventas
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

  // ¿se puede hablar con la base ahora? (el panel abierto sin internet espera a que se vuelva a entrar)
  // CAIDA: la compu dice que tiene red (el router está prendido) pero no llega a internet: se cayó el proveedor
  let CAIDA = false, REDOK = false;
  const enLinea = () => !SIN_RED && navigator.onLine && !CAIDA;
  function sinSenal(e) {
    if (e && U.esErrorRed(e) && navigator.onLine && !SIN_RED && !CAIDA) { CAIDA = true; pintarBandaRed(); }
  }
  // cada rato (y al volver la red) se prueba si de verdad hay internet
  async function probarRed() {
    if (!navigator.onLine) return;
    let ok = false;
    try { const r = await conTiempo(db.from("ajustes").select("clave").limit(1), 8000); ok = !r.error || !U.esErrorRed(r.error); } catch { ok = false; }
    if (SIN_RED) { if (ok !== REDOK) { REDOK = ok; pintarBandaRed(); } return; }
    if (ok) { CAIDA = false; pintarBandaRed(); enviarCola(); }
    else if (!CAIDA) { CAIDA = true; pintarBandaRed(); }
  }
  // Acciones hechas sin internet: { id, tipo, venta?: {id} | {uuid, temp}, datos, cuando, desc, error?, espera? }
  const acciones = {
    leer: () => { const l = leerLS(LS_ACC, []); return Array.isArray(l) ? l : []; },
    escribir: (l) => ponerLS(LS_ACC, l),
    agregar(tipo, datos, extra = {}) {
      const a = { tipo, datos, cuando: new Date().toISOString(), ...extra, id: extra.id || crypto.randomUUID() };
      const l = acciones.leer(); l.push(a);
      return acciones.escribir(l) ? a : null;
    },
    guardar(a) { const l = acciones.leer(), i = l.findIndex((x) => x.id === a.id); if (i >= 0) { l[i] = a; acciones.escribir(l); } },
    quitar(id) { acciones.escribir(acciones.leer().filter((x) => x.id !== id)); },
    deVenta(ref) { const env = leerLS(LS_ENVIADAS, {}); return acciones.leer().filter((a) => a.venta && mismaVenta(a.venta, ref, env)); }
  };
  const mismaVenta = (a, b, env) => !!a && !!b && ((a.id && b.id && Number(a.id) === Number(b.id)) || (a.uuid && b.uuid && a.uuid === b.uuid)
    || (a.uuid && b.id && Number((env || leerLS(LS_ENVIADAS, {}))[a.uuid]?.id) === Number(b.id)));
  // ventas hechas sin internet que ya llegaron: número temporal → venta de verdad
  function anotarEnviada(uuid, d) {
    const m = leerLS(LS_ENVIADAS, {});
    m[uuid] = { id: d.id, codigo: d.codigo, t: Date.now() };
    const ks = Object.keys(m).sort((a, b) => m[b].t - m[a].t);
    ks.slice(300).forEach((k) => delete m[k]);
    ponerLS(LS_ENVIADAS, m);
  }
  const porEnviar = () => cola.leer().length + acciones.leer().length;

  // consulta con respaldo: si no hay internet, devuelve la copia guardada
  async function consulta(clave, q) {
    if (SIN_RED) { const d = copia.leer()[clave]; return d !== undefined ? { data: d, error: null, deCopia: true } : { data: null, error: { message: "Failed to fetch" } }; }
    let r;
    try { r = await q; } catch (e) { r = { data: null, error: e }; }
    if (!r.error) { copia.poner(clave, r.data); return r; }
    if (U.esErrorRed(r.error)) { sinSenal(r.error); const d = copia.leer()[clave]; if (d !== undefined) return { data: d, error: null, deCopia: true }; }
    return r;
  }

  function conTiempo(p, ms) {
    return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej({ message: "timeout" }), ms))]);
  }

  // un comprobante hecho sin internet tiene que llegar a Hacienda a más tardar 2 días hábiles después (reglamento, art. 21)
  function limiteHacienda(iso) {
    let f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso)), n = 0;
    while (n < 2) {
      f = new Date(new Date(f + "T12:00:00-06:00").getTime() + 864e5).toISOString().slice(0, 10);
      const dia = new Date(f + "T12:00:00-06:00").getUTCDay();
      if (dia !== 0 && dia !== 6) n++;
    }
    return f;
  }
  function avisoHacienda() {
    const fe = acciones.leer().filter((a) => a.tipo === "fe");
    if (!fe.length) return "";
    const lim = fe.map((a) => limiteHacienda(a.cuando)).sort()[0];
    const txt = new Date(lim + "T12:00:00-06:00").toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
    return ` ${fe.length === 1 ? "Hay 1 comprobante electrónico sin enviar: tiene" : `Hay ${fe.length} comprobantes electrónicos sin enviar: tienen`} que llegar a Hacienda a más tardar el ${txt}.`;
  }
  function pintarBandaRed() {
    const n = porEnviar(), malas = cola.leer().filter((r) => r.error).length + acciones.leer().filter((a) => a.error).length;
    const ver = n ? { texto: "Ver pendientes", accion: abrirPendientes } : null;
    const b = $("#bandaRed");
    if (!navigator.onLine || CAIDA || (SIN_RED && !REDOK)) {
      U.banda(`Sin internet. Puede seguir vendiendo, cobrando, entregando y usar la caja: todo queda en esta compu y se envía solo cuando vuelva la conexión.${n ? ` Por enviar: ${n}.` : ""}${avisoHacienda()}`, "sin", ver);
    } else if (SIN_RED) {
      U.banda(`Volvió el internet.${n ? ` Entre de nuevo para enviar lo pendiente (${n}).` : ""}`, "ok", { texto: "Entrar", accion: () => location.reload() });
    } else if (malas) {
      U.banda(`${malas === 1 ? "Una cosa hecha" : `${malas} cosas hechas`} sin internet no se ${malas === 1 ? "pudo" : "pudieron"} enviar.${avisoHacienda()}`, "error", ver);
    } else if (n) {
      U.banda(`Enviando lo que se hizo sin internet (${n}).${avisoHacienda()}`, "sin", ver);
    } else if (b && !b.hidden && !b.dataset.fija) U.banda("");
  }
  function estadoRedPanel(e) {
    if (e?.type === "offline") CAIDA = false;          // sin red del todo: lo dice navigator.onLine
    pintarBandaRed();
    if (e?.type === "online") { probarRed(); return; }
    if (enLinea()) enviarCola();
  }

  // =========================================================
  //  ACCESO: contraseña → (registrar MFA) → código → panel
  // =========================================================
  async function siguientePaso() {
    let session = null, sErr = null;
    try { ({ data: { session }, error: sErr } = await db.auth.getSession()); } catch (e) { sErr = e; }
    if (!navigator.onLine) return entrarSinRed();
    // la sesión venció y no se pudo renovar porque no hay internet (aunque la compu tenga red)
    if (!session && sErr && (U.esErrorRed(sErr) || sErr.name === "AuthRetryableFetchError")) return entrarSinRed();
    if (!session) return vista("vLogin");

    // ¿quién es y qué puede? (v17). Sin v17: todos son administradores con autenticador.
    let acc;
    try { acc = await conTiempo(db.rpc("mi_acceso"), 12000); } catch (e) { acc = { error: e }; }
    if (acc.error && U.esErrorRed(acc.error)) return entrarSinRed();
    let pideCodigo = true;
    V17 = !acc.error;
    if (acc.error) {
      ACCESO = null;
      let reg;
      try { reg = await conTiempo(db.rpc("soy_admin_registrado"), 12000); } catch (e) { reg = { error: e }; }
      if (reg.error && U.esErrorRed(reg.error)) return entrarSinRed();
      if (reg.error || reg.data !== true) return vista("vSinPermiso");
    } else {
      if (!acc.data || acc.data.activo === false) return vista("vSinPermiso");
      ACCESO = acc.data;
      pideCodigo = !!acc.data.pide_codigo;
    }

    const { data: aal, error: aErr } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aErr) return vista("vLogin");
    if (aal.currentLevel === "aal2" || !pideCodigo) return abrirPanel(session.user);

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
    if (p && p.hasta > Date.now() && Array.isArray(c.ventas)) { ACCESO = p.acceso || null; V17 = !!ACCESO; return abrirPanel({ email: p.email }, true); }
    vista("vLogin");
    $("#loginMsg").textContent = "No hay internet. Para poder usar el panel sin internet, primero entre una vez con internet en esta compu.";
  }

  async function salir(motivo) {
    if (!motivo) {
      const n = porEnviar();
      if (n && !await preguntar(`Hay ${n} ${n === 1 ? "cosa hecha" : "cosas hechas"} sin internet que todavía no se han enviado. Quedan guardadas en esta compu y se envían la próxima vez que entre. ¿Salir?`)) return;
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
      // "marvin" → marvin@usuarios.lacampina.local; un correo completo entra tal cual
      const id = f.email.value.trim().toLowerCase();
      const email = id.includes("@") ? id : `${id}@${C.DOMINIO_PERSONAL || "usuarios.lacampina.local"}`;
      const { error } = await db.auth.signInWithPassword({ email, password: f.password.value });
      btn.disabled = false;
      f.password.value = "";
      if (error) { $("#loginMsg").textContent = "Usuario o contraseña incorrectos."; return; }
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
  // pantalla de carga: cada paso avanza la barra (los productos según cuántos van llegando)
  const PESO = { base: 0.3, productos: 0.45, ventas: 0.25 }, AVANCE = { base: 0, productos: 0, ventas: 0 };
  function empezarCarga() { $("#cargaPanel").hidden = false; $("#cargaBarra").style.width = "6%"; $$("#cargaPasos li").forEach((li) => li.classList.add("va")); }
  function carga(paso, frac, txt) {
    AVANCE[paso] = Math.max(AVANCE[paso], Math.min(1, frac));
    const li = $(`#cargaPasos [data-paso="${paso}"]`);
    if (li) { li.classList.toggle("hecho", AVANCE[paso] >= 1); li.classList.toggle("va", AVANCE[paso] < 1); if (txt) li.dataset.det = txt; }
    const tot = Object.keys(PESO).reduce((a, k) => a + PESO[k] * AVANCE[k], 0);
    $("#cargaBarra").style.width = `${Math.max(6, Math.round(tot * 100))}%`;
  }
  function terminarCarga() {
    Object.keys(PESO).forEach((k) => carga(k, 1));
    setTimeout(() => { $("#cargaPanel").classList.add("fuera"); setTimeout(() => ($("#cargaPanel").hidden = true), 300); }, 250);
  }
  async function abrirPanel(user, sinRed = false) {
    SIN_RED = sinRed;
    // las pestañas no se muestran hasta saber cuáles le tocan (si no, se ven un momento las de otros)
    if (!panelListo) {
      document.documentElement.classList.add("panel-cargando");
      setTimeout(() => document.documentElement.classList.remove("panel-cargando"), 10000);
    }
    if (!panelListo) empezarCarga();
    vista("vPanel");
    $("#userEmail").textContent = ACCESO?.nombre || ACCESO?.usuario || user.email || "";
    if (!sinRed) ponerLS(LS_PERMISO, { email: user.email, acceso: ACCESO, hasta: Date.now() + HORAS_SIN_RED * 3600 * 1000 });
    if (panelListo) return;
    panelListo = true;
    idbProd.usuario(user.email || user.id);
    vigilarInactividad();
    pintarDiasHorario();
    if (sinRed) {
      const c = copia.leer(), vs = c.versiones || {};
      V4 = !!c.v4; V9 = !!c.v9;
      V10 = !!vs.V10; V12 = !!vs.V12; V13 = !!vs.V13; V14 = !!vs.V14; V18 = !!vs.V18; V19 = !!vs.V19;
      FE = c.fe || null;
      if (V13) cargarClientes();
    } else {
      // todas las preguntas a la base salen juntas (antes iban una por una y sumaban segundos)
      const probar = (q) => Promise.resolve(q).then((x) => x, (e) => ({ error: e }));
      const [r, r9, r10, r11, r12, r13, r14, r15, r16, r18, r19, r21, r22, r23, r24, r25] = await Promise.all([
        probar(db.from("avisos").select("id").limit(1)),
        probar(db.from("productos").select("codigo").limit(1)),
        probar(db.from("fe_emisor").select("*").eq("id", 1).maybeSingle()),
        probar(db.from("precios_movimientos").select("id").limit(1)),
        probar(db.from("entradas").select("id").limit(1)),
        probar(db.from("clientes").select("id").limit(1)),
        probar(db.from("caja_turnos").select("id").limit(1)),
        probar(db.from("productos").select("vendido").limit(1)),
        probar(db.from("auditoria").select("quien").limit(1)),
        probar(db.from("pedidos").select("apartado").limit(1)),
        probar(db.from("fe_dispositivos").select("id").limit(1)),
        probar(db.from("proveedores").select("id").limit(1)),
        probar(db.from("pedidos").select("exoneracion").limit(1)),
        probar(db.from("devoluciones").select("id").limit(1)),
        probar(db.from("productos").select("precio2").limit(1)),
        probar(db.from("fe_documentos").select("entrada_id").limit(1)),
        cargarCategorias()
      ]);
      V4 = r.error && U.esErrorRed(r.error) ? !!copia.leer().v4 : !r.error;
      if (!r.error || !U.esErrorRed(r.error)) copia.poner("v4", V4);
      V9 = r9.error && U.esErrorRed(r9.error) ? !!copia.leer().v9 : !r9.error;
      if (!r9.error || !U.esErrorRed(r9.error)) copia.poner("v9", V9);
      V10 = !r10.error; FE = r10.data || null;
      V11 = !r11.error; V12 = !r12.error; V13 = !r13.error;
      if (V13) cargarClientes();
      V14 = !r14.error; V15 = !r15.error; V16 = !r16.error; V18 = !r18.error; V19 = !r19.error; V21 = !r21.error; V22 = !r22.error; V23 = !r23.error; V24 = !r24.error; V25 = !r25.error;
      // para poder abrir el panel sin internet con lo mismo que tiene la base
      if (!r16.error || !U.esErrorRed(r16.error)) {
        copia.poner("versiones", { V10, V12, V13, V14, V18, V19 });
        copia.poner("fe", FE ? { activo: FE.activo, ambiente: FE.ambiente, identificacion: FE.identificacion, sucursal: FE.sucursal,
          terminal: FE.terminal, cabys_envio: FE.cabys_envio, tipo_id: FE.tipo_id, nombre: FE.nombre } : null);
      }
    }
    document.documentElement.classList.toggle("sin-v14", !V14);
    document.documentElement.classList.toggle("sin-v16", !V16);
    document.documentElement.classList.toggle("sin-v17", !V17);
    document.documentElement.classList.toggle("sin-v18", !V18);
    document.documentElement.classList.toggle("sin-v21", !V21);
    document.documentElement.classList.toggle("sin-v24", !V24);
    document.documentElement.classList.toggle("sin-v25", !(V25 && V10 && !!FE?.activo));
    $("#tabCom").hidden = !V21;
    // formas de pago de v18: sin la base nueva no se ofrecen; lo abonado en Moriah solo lo anota el administrador
    $$("option[data-v18]").forEach((o) => { if (!V18 || (o.hasAttribute("data-solo-admin") && !esAdministradorReal())) o.remove(); });
    $("#btnSaldosMoriah").hidden = !V18 || !esAdministradorReal();
    $("#tabBit").hidden = !V16;
    if (V16 && soyAdministrador()) cargarUsuarios();
    document.documentElement.classList.toggle("sin-v13", !V13);
    $("#tabCred").hidden = !V13;
    document.documentElement.classList.toggle("sin-v11", !V11);
    document.documentElement.classList.toggle("sin-v12", !V12);
    $("#tabInv").hidden = !V12;
    $("#tabComp").hidden = !V10;
    document.documentElement.classList.toggle("sin-v10", !V10);
    if (V10) pintarConfFE();
    document.documentElement.classList.toggle("sin-v4", !V4);
    document.documentElement.classList.toggle("sin-v9", !V9);
    $("#avisoV4").hidden = V4;
    aplicarPermisos();
    carga("base", 1);
    if (sinRed) await cargarCategorias();
    const conVentas = puede("ventas") || puede("caja") || puede("credito") || puede("reportes");
    await Promise.all([
      cargarProductos().then(() => carga("productos", 1)),
      cargarAjustes(), puede("ventas") || puede("caja") ? contarPorVerificar() : null,
      V4 && !sinRed && soyAdministrador() ? cargarAvisos() : null,
      conVentas ? cargarVentas().then(() => carga("ventas", 1)) : carga("ventas", 1)
    ]);
    pintarCategorias();
    terminarCarga();
    if (puede("preguntas")) cargarPreguntas();
    if (V21 && puede("compras")) contarRecibidos();
    addEventListener("online", estadoRedPanel);
    addEventListener("offline", estadoRedPanel);
    vigilarProductos();
    estadoRedPanel();
    prepararFESinRed();
    irA(new URLSearchParams(location.search).get("ir"));
    pintarEspera();
    setInterval(() => {
      if (document.hidden) return;
      if (navigator.onLine && (CAIDA || SIN_RED)) probarRed();
      enviarCola();
      if (enLinea()) prepararFESinRed();          // sin red de nuevo: solo revisa lo que le queda a esta compu
      if (enLinea() && !$("#dlgVenta").open) {
        if (puede("ventas") || puede("caja")) { cargarVentas(); contarPorVerificar(); }
        if (puede("preguntas")) cargarPreguntas();
      }
    }, 60000);
  }

  // Cada empleado ve solo las pestañas y botones de lo que puede hacer (la base también lo revisa)
  function aplicarPermisos() {
    const admin = soyAdministrador();
    document.documentElement.classList.toggle("es-empleado", !admin);
    const ocultar = {
      tabVen: !puede("ventas"), tabPreg: !puede("preguntas"), tabCaja: !puede("caja"), tabCred: !puede("credito"),
      tabComp: !(puede("ventas") || puede("reportes")), tabRep: !puede("reportes"), tabBit: !admin,
      tabProd: !(puede("productos") || puede("precios")), tabInv: !(puede("inventario") || puede("productos")),
      tabCat: !puede("productos"), tabAj: !admin, tabCom: !(puede("compras") || puede("inventario"))
    };
    for (const [id, no] of Object.entries(ocultar)) if (no) $("#" + id).hidden = true;
    ajustarGruposMenu();
    // botones de Productos e Inventario
    $("#btnNuevoProd").hidden = !puede("productos");
    $("#btnFotos").hidden = !puede("productos");
    $("#btnCabys").hidden = !puede("productos");
    $("#btnImportar").classList.toggle("sin-permiso", !(puede("productos") && puede("precios")));
    $("#btnAjustePrecios").classList.toggle("sin-permiso", !puede("precios"));
    $("#btnNuevaEntrada").classList.toggle("sin-permiso", !puede("inventario"));
    $("#btnNuevoAjusteInv").classList.toggle("sin-permiso", !puede("inventario"));
    $("#btnSubirXml").classList.toggle("sin-permiso", !puede("compras"));
    // si la pestaña abierta no le toca, se abre la primera que sí
    const abierta = $(".pestana[aria-selected=true]");
    if (!abierta || abierta.hidden) {
      const primera = $$(".pestana").find((t) => !t.hidden);
      if (primera) primera.click();
      else $("#tVen").innerHTML = `<p class="msg msg--error">Su usuario todavía no tiene permisos. Pídale al administrador que se los dé.</p>`;
    }
    document.documentElement.classList.remove("panel-cargando");
  }

  // ---------- como programa (app instalada) ----------
  // los accesos directos del ícono abren admin.html?ir=venta|productos|caja
  function irA(destino) {
    if (!destino) return;
    history.replaceState(null, "", location.pathname);
    const tab = { venta: "#tabVen", productos: "#tabProd", caja: "#tabCaja" }[destino];
    if (!tab || $(tab).hidden) return;
    $(tab).click();
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
  // el título de un grupo del menú se esconde si ninguna de sus pestañas se ve
  function ajustarGruposMenu() {
    let titulo = null, alguna = false;
    const cerrar = () => { if (titulo) titulo.hidden = !alguna; };
    for (const el of $(".pestanas").children) {
      if (el.classList.contains("pestanas__grupo")) { cerrar(); titulo = el; alguna = false; }
      else if (!el.hidden) alguna = true;
    }
    cerrar();
  }
  $$(".pestana").forEach((tab) => tab.addEventListener("click", () => {
    $$(".pestana").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $$("[role=tabpanel]").forEach((p) => (p.hidden = p.id !== tab.getAttribute("aria-controls")));
    if (tab.id === "tabAj") { cargarAuditoria(); cargarEspacio(); pintarUltimoRespaldo(); }
    if (tab.id === "tabVen") cargarVentas();
    if (tab.id === "tabCaja") cargarCaja();
    if (tab.id === "tabPreg") cargarPreguntas();
    if (tab.id === "tabRep") cargarReportes();
    if (tab.id === "tabBit") cargarBitacora();
    if (tab.id === "tabComp") cargarComprobantes();
    if (tab.id === "tabInv") cargarInventario();
    if (tab.id === "tabCom") cargarCompras();
    if (tab.id === "tabCred") cargarClientes().then(pintarClientes);
  }));
  $(".pestanas").addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const tabs = $$(".pestana").filter((t) => !t.hidden), i = tabs.indexOf(document.activeElement);
    const n = tabs[(i + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); n.click();
  });

  // ---------- CATEGORÍAS ----------
  async function cargarCategorias() {
    const { data, error } = await consulta("categorias", db.from("categorias").select("*").order("orden"));
    if (error) return toast(errTxt(error), true);
    categorias = data;
    pintarCategorias();
  }
  function pintarCategorias() {
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
      if (!await preguntar(`¿Borrar la categoría “${c.nombre}”? Sus productos quedan sin categoría.`)) return;
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
    activo: p.activo, agotado: p.agotado, destacado: p.destacado, existencia: p.existencia,
    cabys: p.cabys, iva_codigo: p.iva_codigo, precio_oferta: p.precio_oferta, oferta_hasta: p.oferta_hasta, precio2: p.precio2 });
  // Copia completa de los productos en esta compu (IndexedDB, sirve en el navegador y en la app instalada).
  // Al entrar se usa la copia de una vez y después se traen solo los productos que cambiaron
  // (todo cambio en productos actualiza updated_at). Una vez al día, o si no cuadra la cantidad, se baja todo.
  const VER_CACHE_PROD = 1, DIA_MS = 24 * 3600 * 1000;
  const idbProd = (() => {
    let usr = "anon", abierto = null;
    const abrir = () => abierto ||= new Promise((res) => {
      try {
        const r = indexedDB.open(`lc_productos_${usr}`, 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("p", { keyPath: "id" }); d.createObjectStore("meta"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch { res(null); }
    });
    return {
      usuario(u) {
        const n = String(u || "anon").toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
        if (n !== usr) { usr = n; abierto = null; }
      },
      async leer() {
        const d = await abrir(); if (!d) return null;
        return new Promise((res) => {
          try {
            const t = d.transaction(["p", "meta"]); let rows = null, meta = null;
            t.objectStore("p").getAll().onsuccess = (e) => { rows = e.target.result; };
            t.objectStore("meta").get("m").onsuccess = (e) => { meta = e.target.result; };
            t.oncomplete = () => res(rows && meta ? { rows, meta } : null);
            t.onerror = () => res(null); t.onabort = () => res(null);
          } catch { res(null); }
        });
      },
      async guardar(rows, meta, completo) {
        const d = await abrir(); if (!d) return false;
        return new Promise((res) => {
          try {
            const t = d.transaction(["p", "meta"], "readwrite"), st = t.objectStore("p");
            if (completo) st.clear();
            for (const r of rows) st.put(r);
            t.objectStore("meta").put(meta, "m");
            t.oncomplete = () => res(true); t.onerror = () => res(false); t.onabort = () => res(false);
          } catch { res(false); }
        });
      }
    };
  })();
  let prodMeta = null, prodSyncAt = 0, prodCola = Promise.resolve();
  const colsProd = (r) => (r ? Object.keys(r).sort().join(",") : "");
  const maxActualizado = (rows, prev = "") => rows.reduce((m, r) => (r.updated_at && r.updated_at > m ? r.updated_at : m), prev || "");
  const ordenarProd = (l) => l.sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" }));
  function usarProductos(data) {
    productos = data;
    V9 = V9 || productos.some((p) => "codigo" in p) || !!copia.leer().v9;
    document.documentElement.classList.toggle("sin-v9", !V9);
    pintarProductos();
  }
  // cargarProductos() se llama al entrar y después de cada cambio; las llamadas van en fila para no pisarse
  async function cargarProductos(o = {}) {
    if (!SIN_RED && !productos.length && !prodMeta) {
      const c = await idbProd.leer();
      if (c?.rows?.length && c.meta?.v === VER_CACHE_PROD) {
        prodMeta = c.meta;
        usarProductos(ordenarProd(c.rows));
        carga("productos", 1, `${c.rows.length.toLocaleString("es-CR")} guardados en esta compu`);
        encolarProductos({});            // lo que cambió se trae por detrás
        return;
      }
    }
    return encolarProductos(o);
  }
  function encolarProductos(o) {
    const p = prodCola.then(() => syncProductos(o));
    prodCola = p.catch(() => {});
    return p;
  }
  async function syncProductos(o = {}) {
    if (SIN_RED) {
      const c = await idbProd.leer();
      const data = c?.rows?.length ? ordenarProd(c.rows) : copia.leer().productos || null;
      if (!data) return toast(errTxt({ message: "Failed to fetch" }), true);
      return usarProductos(data);
    }
    const completo = o.completo || !prodMeta || !productos.length || Date.now() - (prodMeta.completo || 0) > DIA_MS;
    let error = null;
    try {
      if (completo) {
        const primera = !productos.length;
        const data = await leerTabla("productos", "nombre", primera
          ? (n, total) => carga("productos", total ? n / total : 0.5, `${n.toLocaleString("es-CR")} de ${total.toLocaleString("es-CR")}`) : null);
        prodMeta = { v: VER_CACHE_PROD, completo: Date.now(), sync: maxActualizado(data), cols: colsProd(data[0]) };
        if (!await idbProd.guardar(data, prodMeta, true)) copia.poner("productos", data.map(productoCorto));
        usarProductos(data);
      } else {
        // 5 minutos de traslape por si algo se guardó mientras tanto
        const ult = Date.parse(prodMeta.sync || "");
        const desde = new Date(Math.max(0, (Number.isNaN(ult) ? 0 : ult) - 5 * 60 * 1000)).toISOString();
        const [cambios, cuenta] = await Promise.all([
          leerTabla("productos", "id", null, (q) => q.gte("updated_at", desde)),
          db.from("productos").select("id", { count: "exact", head: true })
        ]);
        if (cuenta.error) throw cuenta.error;
        // columnas nuevas en la base: la copia vieja no las tiene
        if (cambios.length && colsProd(cambios[0]) !== prodMeta.cols) return syncProductos({ completo: true });
        const mapa = new Map(productos.map((p) => [p.id, p]));
        for (const r of cambios) mapa.set(r.id, r);
        // borraron productos (aquí o en otra compu): se baja todo
        if (cuenta.count != null && cuenta.count !== mapa.size) return syncProductos({ completo: true });
        prodMeta = { ...prodMeta, sync: maxActualizado(cambios, prodMeta.sync) };
        await idbProd.guardar(cambios, prodMeta, false);
        if (cambios.length) usarProductos(ordenarProd([...mapa.values()]));
      }
      prodSyncAt = Date.now();
    } catch (e) { error = e; }
    if (!error) return;
    if (U.esErrorRed(error)) {
      sinSenal(error);
      if (productos.length) return;                    // se sigue con la copia
      const data = copia.leer().productos;
      if (data) return usarProductos(data);
    }
    toast(errTxt(error), true);
  }
  // si el panel quedó abierto, al volver a la ventana (o cada 5 minutos) se traen los cambios de las otras compus
  function vigilarProductos() {
    const tocar = () => { if (!SIN_RED && enLinea() && document.visibilityState === "visible" && Date.now() - prodSyncAt > 60 * 1000) cargarProductos(); };
    document.addEventListener("visibilitychange", tocar);
    setInterval(tocar, 5 * 60 * 1000);
  }

  const hoyCRp = () => new Intl.DateTimeFormat("en-CA", { timeZone: C.ZONA_HORARIA }).format(new Date());
  const ofertaVigente = (p) => p.precio_oferta != null && !!p.oferta_hasta && String(p.oferta_hasta) >= hoyCRp();
  let filtroProd = "todos";
  const PASA_PROD = { todos: () => true, agotados: (p) => p.agotado, ofertas: ofertaVigente, sinprecio: (p) => p.precio == null, sinfoto: (p) => !p.imagen_url, ocultos: (p) => !p.activo, sincabys: (p) => p.activo && !p.cabys };
  function pintarProductos() {
    const q = norm($("#aBuscar").value);
    const todos = productos.filter((p) => PASA_PROD[filtroProd](p) && (!q || norm(p.nombre).includes(q) || (p.codigo && String(p.codigo).toLowerCase().includes(q))));
    const lista = todos.slice(0, MAX_LISTA_PROD);
    const cat = (id) => categorias.find((c) => c.id === id);
    $("#listaProd").innerHTML = lista.map((p) => {
      const c = cat(p.categoria_id);
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      return `<li class="fila ${p.activo ? "" : "fila--oculta"}">
        <span class="fila__img">${url ? `<img ${U.srcMini(url)} alt="" loading="lazy" />` : SIN_FOTO}</span>
        <div class="fila__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${p.codigo ? `Cód. ${U.esc(p.codigo)} · ` : ""}${U.esc(c?.nombre || "Sin categoría")} · ${U.colones(p.precio) ? U.esc(U.colones(p.precio)) + (p.unidad ? " por " + U.esc(p.unidad) : "") : "Precio a consultar"}${p.existencia != null ? ` · Existencia: ${Number(p.existencia).toLocaleString("es-CR")}` : ""}</small>
          <span class="etiquetas">${p.destacado ? '<span class="etq etq--rec">Recomendado</span>' : ""}${p.activo ? "" : '<span class="etq">Oculto</span>'}${p.agotado ? '<span class="etq etq--sin_pago">Agotado</span>' : ""}${ofertaVigente(p) ? `<span class="etq etq--por_verificar">Oferta ${U.esc(U.colones(p.precio_oferta))} hasta ${U.esc(String(p.oferta_hasta).split("-").reverse().join("/"))}</span>` : p.oferta_hasta ? '<span class="etq">Oferta vencida</span>' : ""}</span>
        </div>
        <div class="fila__acc">
          ${V4 && puede("productos") ? `<button type="button" class="btn btn--sm ${p.agotado ? "btn--negro" : "btn--linea"}" data-agotado="${p.id}">${p.agotado ? "Ya hay" : "Agotado"}</button>` : ""}
          ${puede("productos") ? `<button type="button" class="btn btn--sm btn--linea" data-edit="${p.id}">Editar</button>
          <button type="button" class="enlace enlace--peligro" data-del="${p.id}">Borrar</button>` : ""}
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
    fp.precio2.value = p?.precio2 ?? "";
    // sin permiso de precios: se ven pero no se cambian (la base tampoco deja)
    ["precio", "precio2", "precio_oferta", "oferta_hasta"].forEach((k) => { if (fp[k]) fp[k].disabled = !puede("precios"); });
    $("#prodSinPrecio").hidden = puede("precios");
    fp.unidad.value = p?.unidad || "";
    fp.categoria_id.value = p?.categoria_id || "";
    fp.destacado.checked = !!p?.destacado;
    fp.activo.checked = p ? !!p.activo : true;
    fp.agotado.checked = !!p?.agotado;
    fp.codigo.value = p?.codigo || "";
    fp.cabys.value = p?.cabys || "";
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
      if (!await preguntar(`¿Borrar “${p.nombre}”? Si solo quiere esconderlo, use Editar y quite “Mostrar en el sitio”.`)) return;
      const { error } = await db.from("productos").delete().eq("id", p.id);
      if (error) return toast(errTxt(error), true);
      await borrarFoto(p.imagen_url);
      toast("Producto borrado");
      cargarProductos();
    }
  });

  // Foto de producto en dos tamaños: 800 px para la ficha y 400 px para las listas.
  // Se re-codifica en WebP (JPG si el navegador no sabe), lo que también borra los datos EXIF/GPS.
  const FOTO_GRANDE = 800, FOTO_MINI = 400;
  function abrirImagen(file) {
    return new Promise((res, rej) => {
      const img = new Image(), src = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(src); res(img); };
      img.onerror = () => { URL.revokeObjectURL(src); rej(new Error("El archivo no es una imagen válida.")); };
      img.src = src;
    });
  }
  function reescalar(fuente, ancho, alto, max, fondo) {
    const k = Math.min(1, max / Math.max(ancho, alto));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(ancho * k)); cv.height = Math.max(1, Math.round(alto * k));
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    if (fondo) { ctx.fillStyle = fondo; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.drawImage(fuente, 0, 0, cv.width, cv.height);
    return cv;
  }
  const comoBlob = (cv, tipo, calidad) => new Promise((res) => cv.toBlob(res, tipo, calidad));
  async function codificar(cv, calidad) {
    const w = await comoBlob(cv, "image/webp", calidad);
    if (w && w.type === "image/webp") return w;
    // JPG no tiene transparencia: fondo blanco para que un PNG recortado no quede negro
    const j = await comoBlob(reescalar(cv, cv.width, cv.height, Infinity, "#fff"), "image/jpeg", calidad + 0.05);
    if (!j) throw new Error("No se pudo procesar la foto.");
    return j;
  }
  // Si la foto es de catálogo (fondo blanco), devuelve el recuadro donde está el producto;
  // si no (foto tomada en el almacén, por ejemplo), null y se deja como viene.
  function recuadroSobreBlanco(img) {
    const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 200 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    ctx.canvas.width = cw; ctx.canvas.height = ch;
    ctx.drawImage(img, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    const blanco = (x, y) => { const i = (y * cw + x) * 4; return d[i + 3] < 24 || (d[i] > 236 && d[i + 1] > 236 && d[i + 2] > 236); };
    const lado = Math.max(1, Math.round(Math.min(cw, ch) * 0.04));
    for (const [x0, y0] of [[0, 0], [cw - lado, 0], [0, ch - lado], [cw - lado, ch - lado]]) {
      for (let y = y0; y < y0 + lado; y++) for (let x = x0; x < x0 + lado; x++) if (!blanco(x, y)) return null;
    }
    let x1 = cw, y1 = ch, x2 = -1, y2 = -1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (blanco(x, y)) continue;
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
    if (x2 < 0) return null;
    return { x: x1 / k, y: y1 / k, w: Math.min(w, (x2 - x1 + 1) / k), h: Math.min(h, (y2 - y1 + 1) / k) };
  }
  // foto de catálogo: el producto centrado en un cuadro blanco, sin bordes de más
  function cuadrarSobreBlanco(img, r, lado) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = lado;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, lado, lado);
    const k = Math.min((lado * 0.9) / r.w, (lado * 0.9) / r.h, 2);   // a lo sumo el doble, para que no quede borrosa
    const w = r.w * k, h = r.h * k;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, (lado - w) / 2, (lado - h) / 2, w, h);
    return cv;
  }
  async function fotoEnDosTamanos(file, info = {}) {
    const img = await abrirImagen(file);
    info.ancho = img.naturalWidth; info.alto = img.naturalHeight;
    const r = recuadroSobreBlanco(img);
    const grande = r ? cuadrarSobreBlanco(img, r, FOTO_GRANDE) : reescalar(img, img.naturalWidth, img.naturalHeight, FOTO_GRANDE);
    const mini = reescalar(grande, grande.width, grande.height, FOTO_MINI);
    return [await codificar(grande, 0.8), await codificar(mini, 0.74)];
  }

  // info (opcional) recibe el tamaño original de la foto
  async function subirFoto(file, info) {
    const [grande, mini] = await fotoEnDosTamanos(file, info);
    if (grande.size > 2 * 1024 * 1024) throw new Error("La foto sigue pesando más de 2 MB.");
    const ext = grande.type === "image/webp" ? "webp" : "jpg", base = crypto.randomUUID();
    const rutas = [`${base}__${FOTO_GRANDE}.${ext}`, `${base}__${FOTO_MINI}.${ext}`];
    const sto = db.storage.from(C.BUCKET), op = { upsert: false, cacheControl: "31536000" };
    const r = await Promise.all([
      sto.upload(rutas[0], grande, { ...op, contentType: grande.type }),
      sto.upload(rutas[1], mini, { ...op, contentType: mini.type })
    ]);
    const fallo = r.find((x) => x.error);
    if (fallo) { try { await sto.remove(rutas); } catch { /* no quedó nada que borrar */ } throw fallo.error; }
    return sto.getPublicUrl(rutas[0]).data.publicUrl;
  }

  // borra la foto y, si la tiene, su versión chica
  async function borrarFoto(url) {
    if (!url) return;
    const marca = `/object/public/${C.BUCKET}/`, i = url.indexOf(marca);
    if (i === -1) return;
    const ruta = decodeURIComponent(url.slice(i + marca.length).split(/[?#]/)[0]);
    const mini = U.fotoMini(ruta);
    await db.storage.from(C.BUCKET).remove(mini === ruta ? [ruta] : [ruta, mini]);
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
        ...(V24 && puede("precios") ? { precio2: fp.precio2.value === "" ? null : Math.max(1, Number(fp.precio2.value)) } : {}),
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
        const cab = U.soloDigitos(fp.cabys.value);
        if (cab && cab.length !== 13) throw new Error("El CABYS tiene 13 números.");
        d.cabys = cab || null;
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
    if (V16) {
      const { data, error } = await db.from("auditoria").select(COLS_BIT).order("id", { ascending: false }).limit(10);
      if (error) return;
      $("#listaAuditoria").innerHTML = data.map((a) => `<li><time>${fechaCR(a.creado, { dateStyle: "short", timeStyle: "short" })}</time> ${frase(a)}</li>`).join("")
        || "<li>Sin movimientos todavía.</li>";
      return;
    }
    const { data, error } = await db.from("auditoria").select("tabla,accion,registro,creado").order("creado", { ascending: false }).limit(25);
    if (error) return;
    const acc = { INSERT: "agregó", UPDATE: "cambió", DELETE: "borró" };
    $("#listaAuditoria").innerHTML = data.map((a) =>
      `<li><time>${new Date(a.creado).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" })}</time> ${acc[a.accion] || U.esc(a.accion)} en ${U.esc(a.tabla)} <small>#${U.esc(a.registro)}</small></li>`
    ).join("") || "<li>Sin movimientos todavía.</li>";
  }
  $("#btnVerBitacora").addEventListener("click", () => $("#tabBit").click());

  // ---------- usuarios del panel (v16 nombres y roles; v17 empleados con permisos) ----------
  async function cargarUsuarios() {
    const { data, error } = await db.rpc("usuarios_panel");
    if (error) return;
    USUARIOS = data || [];
    YO = USUARIOS.find((u) => u.soy_yo) || null;
    pintarUsuarios();
    const sel = $("#bitQuien"), antes = sel.value;
    sel.innerHTML = `<option value="">Todos</option>` + USUARIOS.map((u) => `<option value="${U.esc(u.user_id)}">${U.esc(u.nombre || u.usuario || u.correo || "Sin nombre")}</option>`).join("");
    sel.value = antes;
    if (V && $("#dlgVenta").open) $("#btnBorrarVenta").hidden = !puedeBorrarVenta();
  }
  const casillasPermisos = (marcados = [], pide = false) => `
    <legend>Puede usar</legend>
    <div class="permisos__rapidos">
      <button type="button" class="btn btn--sm btn--linea" data-plantilla="caja">Caja</button>
      <button type="button" class="btn btn--sm btn--linea" data-plantilla="inventario">Inventario</button>
      <button type="button" class="btn btn--sm btn--linea" data-plantilla="contador">Contador</button>
      <button type="button" class="btn btn--sm btn--linea" data-plantilla="nada">Nada</button>
    </div>
    <div class="permisos__lista">${PERMISOS.map(([k, t]) => `<label class="check"><input type="checkbox" name="permiso" value="${k}"${marcados.includes(k) ? " checked" : ""} /> ${t}</label>`).join("")}</div>
    <label class="check"><input type="checkbox" name="pide_codigo"${pide ? " checked" : ""} /> Pide el código del autenticador (más seguro)</label>`;
  function pintarUsuarios() {
    const admin = esAdministradorReal(), v17 = !!ACCESO;
    $("#listaUsuarios").innerHTML = USUARIOS.map((u) => {
      const esEmp = u.rol === "usuario", sintetico = String(u.correo || "").endsWith("@" + (C.DOMINIO_PERSONAL || "usuarios.lacampina.local"));
      const entra = sintetico ? `usuario <b>${U.esc(u.usuario || u.correo.split("@")[0])}</b>` : U.esc(u.correo || "");
      return `<li class="usu-fila${u.activo === false ? " usu-fila--inactivo" : ""}" data-uid="${U.esc(u.user_id)}">
        <label>Nombre<input name="nombre" value="${U.esc(u.nombre || "")}" maxlength="60" placeholder="${u.soy_yo ? "Escriba su nombre" : "Nombre"}" autocomplete="off" /></label>
        <label>Rol<select name="rol"${admin && !u.soy_yo ? "" : " disabled"}>
          <option value="administrador"${u.rol === "administrador" ? " selected" : ""}>Administrador (todo)</option>
          <option value="usuario"${esEmp ? " selected" : ""}>Empleado</option></select></label>
        <button type="button" class="btn btn--sm btn--negro" data-guardar-usuario>Guardar</button>
        <small class="usu-fila__info">Entra con ${entra}${u.soy_yo ? " (usted)" : ""} · ${u.ultimo_ingreso ? `último ingreso ${fechaCR(u.ultimo_ingreso, { dateStyle: "short", timeStyle: "short" })}` : "todavía no ha entrado"}${u.activo === false ? " · <b>desactivado</b>" : ""}${esEmp ? "" : " · usa el autenticador"}</small>
        ${v17 && esEmp ? `<fieldset class="permisos usu-fila__permisos" data-permisos>${casillasPermisos(u.permisos || [], !!u.pide_codigo)}</fieldset>` : ""}
        ${v17 && (esEmp || (admin && !u.soy_yo)) ? `<div class="usu-fila__acc">
          ${admin && !u.soy_yo ? `<button type="button" class="enlace" data-clave-usuario>Cambiar contraseña</button>` : ""}
          ${esEmp && sintetico ? `<button type="button" class="enlace" data-renombrar-usuario>Cambiar usuario</button>` : ""}
          ${admin && !u.soy_yo && (!esEmp || u.pide_codigo) ? `<button type="button" class="enlace" data-reiniciar-codigo>Reiniciar autenticador</button>` : ""}
          ${esEmp ? `<label class="check"><input type="checkbox" name="activo"${u.activo !== false ? " checked" : ""} /> Activo (puede entrar)</label>` : ""}
        </div>` : ""}
      </li>`;
    }).join("");
    const m = $("#usuMsg");
    if (YO && !YO.nombre) { m.className = "msg msg--error"; m.textContent = "Póngale su nombre: es el que sale en la bitácora (mientras tanto sale su correo)."; }
    else if (m.classList.contains("msg--error") && /Póngale/.test(m.textContent)) { m.className = "msg"; m.textContent = ""; }
    $("#formNuevoUsuario [data-permisos]").innerHTML = casillasPermisos(PLANTILLAS.caja, false);
  }
  const permisosDe = (caja) => $$("[name=permiso]", caja).filter((x) => x.checked).map((x) => x.value);
  // botones rápidos: Caja / Inventario / Nada
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-plantilla]");
    if (!b) return;
    const caja = b.closest("[data-permisos]"), lista = PLANTILLAS[b.dataset.plantilla] || [];
    $$("[name=permiso]", caja).forEach((x) => (x.checked = lista.includes(x.value)));
  });
  async function llamarUsuarios(cuerpo) {
    const { data, error } = await db.functions.invoke("usuarios", { body: cuerpo });
    if (error) {
      let m = "";
      try { m = (await error.context.json()).error; } catch { /* sin detalle */ }
      if (!m && U.esErrorRed(error)) m = "Sin internet.";
      throw new Error(m || "No se pudo. ¿Está publicada la función “usuarios” en Supabase? (vea el README)");
    }
    if (!data?.ok) throw new Error(data?.error || "No se pudo completar.");
    return data;
  }
  function msgUsu(t, error = false) { const m = $("#usuMsg"); m.className = error ? "msg msg--error" : "msg"; m.textContent = t; }
  $("#listaUsuarios").addEventListener("click", async (e) => {
    const li = e.target.closest("[data-uid]");
    if (!li) return;
    const u = USUARIOS.find((x) => x.user_id === li.dataset.uid);
    const quien = u.nombre || u.usuario || "esta persona";
    if (e.target.closest("[data-clave-usuario]")) {
      const clave = await pedirTexto(`Nueva contraseña para ${quien} (8 o más, con letras y números):`, claveNueva());
      if (clave === null) return;
      try { await llamarUsuarios({ accion: "clave", user_id: u.user_id, clave }); msgUsu(`Contraseña de ${quien} cambiada. Désela en persona.`); }
      catch (err) { msgUsu(err.message, true); }
      return cargarUsuarios();
    }
    if (e.target.closest("[data-reiniciar-codigo]")) {
      if (!await preguntar(`Se le borra el autenticador a ${quien}. La próxima vez que entre, el panel le muestra un código QR nuevo para escanear con el celular.\n\nÚselo si perdió o cambió el celular.`, { titulo: "¿Reiniciar el autenticador?", si: "Reiniciar", peligro: true })) return;
      try { await llamarUsuarios({ accion: "reiniciar_codigo", user_id: u.user_id }); msgUsu(`Listo: ${quien} va a escanear un código QR nuevo la próxima vez que entre.`); }
      catch (err) { msgUsu(err.message, true); }
      return cargarUsuarios();
    }
    if (e.target.closest("[data-renombrar-usuario]")) {
      const nuevo = await pedirTexto(`Nuevo usuario para entrar (${quien}). Minúsculas, sin espacios:`, u.usuario || "");
      if (nuevo === null || nuevo.trim().toLowerCase() === u.usuario) return;
      try { const r = await llamarUsuarios({ accion: "renombrar", user_id: u.user_id, usuario: nuevo }); msgUsu(`Ahora ${quien} entra con el usuario «${r.usuario}».`); }
      catch (err) { msgUsu(err.message, true); }
      return cargarUsuarios();
    }
    const b = e.target.closest("[data-guardar-usuario]");
    if (!b) return;
    const nombre = li.querySelector("[name=nombre]").value.trim().replace(/\s+/g, " "), rol = li.querySelector("[name=rol]").value;
    if (nombre.length < 2) return msgUsu("El nombre debe tener al menos 2 letras.", true);
    b.disabled = true;
    try {
      if (nombre !== (u.nombre || "")) {
        const { error } = await db.rpc("poner_nombre_usuario", { p_user: u.user_id, p_nombre: nombre });
        if (error) throw error;
      }
      if (rol !== u.rol) {
        if (rol === "administrador" && !await preguntar(`${quien} va a poder hacer TODO (borrar ventas, cambiar precios, usuarios…) y va a tener que usar el autenticador del celular. ¿Seguir?`)) throw new Error("No se cambió el rol.");
        const { error } = await db.rpc("poner_rol_usuario", { p_user: u.user_id, p_rol: rol });
        if (error) throw error;
      }
      const caja = li.querySelector("[data-permisos]");
      if (caja && rol === "usuario") {
        const permisos = permisosDe(caja), pide = caja.querySelector("[name=pide_codigo]").checked;
        if (permisos.join() !== (u.permisos || []).join() || pide !== !!u.pide_codigo) {
          const { error } = await db.rpc("poner_permisos", { p_user: u.user_id, p_permisos: permisos, p_pide_codigo: pide });
          if (error) throw error;
        }
        const activo = li.querySelector("[name=activo]").checked;
        if (activo !== (u.activo !== false)) {
          const { error } = await db.rpc("poner_activo", { p_user: u.user_id, p_activo: activo });
          if (error) throw error;
        }
      }
      msgUsu(`Guardado: ${nombre}.`);
    } catch (err) {
      msgUsu(errTxt(err), true);
    } finally {
      b.disabled = false;
      await cargarUsuarios();
    }
  });
  // contraseña fácil de dictar: palabra + números (el empleado la puede cambiar con el administrador)
  function claveNueva() {
    const pal = ["cemento", "martillo", "tornillo", "lamina", "pintura", "varilla", "block", "clavo", "tubo", "cable"];
    const n = crypto.getRandomValues(new Uint32Array(2));
    return pal[n[0] % pal.length] + String(1000 + (n[1] % 9000));
  }
  $("#btnGenerarClave").addEventListener("click", () => { $("#formNuevoUsuario").clave.value = claveNueva(); });
  $("#formNuevoUsuario").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, btn = f.querySelector("[type=submit]");
    const cuerpo = {
      accion: "crear", nombre: f.nombre.value.trim(), usuario: f.usuario.value.trim().toLowerCase(), clave: f.clave.value,
      permisos: permisosDe(f), pide_codigo: f.pide_codigo.checked
    };
    if (cuerpo.nombre.length < 2) return msgUsu("Escriba el nombre.", true);
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(cuerpo.usuario)) return msgUsu("El usuario va en minúscula, de 3 a 30 letras o números, sin espacios (por ejemplo: marvin).", true);
    if (cuerpo.clave.length < 8 || !/[a-z]/i.test(cuerpo.clave) || !/\d/.test(cuerpo.clave)) return msgUsu("La contraseña: 8 o más, con letras y números.", true);
    btn.disabled = true;
    try {
      await llamarUsuarios(cuerpo);
      msgUsu(`Listo: ${cuerpo.nombre} entra con el usuario «${cuerpo.usuario}» y la contraseña «${cuerpo.clave}». Anótela y désela en persona.`);
      f.reset(); $("#boxNuevoUsuario").open = false;
      await cargarUsuarios();
    } catch (err) {
      msgUsu(err.message, true);
    } finally { btn.disabled = false; }
  });

  // ---------- bitácora (v16) ----------
  const COLS_BIT = "id,user_id,quien,tabla,accion,registro,etiqueta,cambios,origen,motivo,creado";
  const GRUPOS_BIT = {
    ventas: ["pedidos", "pedido_items", "pagos", "comprobantes_cliente", "facturas"],
    productos: ["productos", "categorias"],
    credito: ["clientes", "abonos"],
    caja: ["caja_turnos", "caja_movimientos", "entradas", "ajustes_inventario", "proveedores", "pagos_proveedor", "fe_recibidos"],
    ajustes: ["ajustes", "admins", "avisos", "fe_emisor", "consultas"]
  };
  const QUE_BIT = {
    productos: "el producto", categorias: "la categoría", ajustes: "un dato del negocio", admins: "el usuario",
    pedidos: "la venta", pedido_items: "un producto de la venta", pagos: "un pago de la venta", comprobantes_cliente: "un comprobante de pago",
    facturas: "los datos de factura", avisos: "los avisos de Telegram", consultas: "una pregunta", fe_emisor: "los datos de facturación electrónica",
    clientes: "el cliente", abonos: "un abono de", entradas: "una entrada de mercadería", caja_turnos: "la caja", caja_movimientos: "un movimiento de caja",
    ajustes_inventario: "una salida o conteo de inventario", proveedores: "el proveedor", pagos_proveedor: "un pago a proveedor", fe_recibidos: "una factura de proveedor"
  };
  const CAMPO_BIT = {
    precio: "Precio", precio_oferta: "Precio de oferta", oferta_hasta: "Oferta hasta", nombre: "Nombre", descripcion: "Descripción",
    activo: "Se ve en la tienda", agotado: "Agotado", destacado: "Recomendado", imagen_url: "Foto", categoria_id: "Categoría",
    codigo: "Código", unidad: "Se vende por", cabys: "CABYS", iva_codigo: "IVA", costo: "Costo", estado: "Estado",
    motivo_anulacion: "Motivo de anulación", cliente_nombre: "Cliente", cliente_telefono: "Teléfono", telefono: "Teléfono",
    total: "Total", monto: "Monto", metodo: "Medio de pago", medio: "Medio de pago", verificado: "Verificado", anulado: "Anulado",
    referencia: "Referencia", cantidad: "Cantidad", precio_unit: "Precio unitario", subtotal: "Subtotal", limite: "Límite de crédito",
    plazo_dias: "Plazo (días)", rol: "Rol", valor: "Valor", envio: "Envío", costo_envio: "Envío", nota: "Nota", credito: "A crédito",
    vence: "Vence", entrega: "Entrega", direccion: "Dirección", identificacion: "Identificación", correo: "Correo",
    telegram_token: "Token de Telegram", telegram_chat: "Chat de Telegram", motivo: "Motivo", proveedor: "Proveedor", documento: "Documento"
  };
  const DINERO_BIT = /^(precio|precio_oferta|precio_unit|monto|total|costo|costo_envio|envio|limite|saldo|fondo|subtotal|contado|esperado|diferencia|total_costo)$/;
  const OCULTOS_BIT = new Set(["id", "created_by", "hecho_por", "verificado_por", "abierta_por", "cerrada_por", "user_id", "pedido_id", "cliente_id", "producto_id", "updated_at"]);
  const campoBit = (k) => CAMPO_BIT[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "));
  function valorBit(k, v) {
    if (v === null || v === undefined || v === "") return "(vacío)";
    if (v === "(oculto)") return "(oculto)";
    if (typeof v === "boolean") return v ? "Sí" : "No";
    if (k === "imagen_url") return "una foto";
    if (k === "categoria_id") return U.esc(categorias.find((c) => c.id === Number(v))?.nombre || `#${v}`);
    if (DINERO_BIT.test(k) && Number.isFinite(Number(v))) return fmt(Number(v));
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fechaCR(v, { dateStyle: "short", timeStyle: "short" });
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
    const t = typeof v === "object" ? JSON.stringify(v) : String(v);
    return U.esc(t.length > 140 ? t.slice(0, 140) + "…" : t);
  }
  // la oración de cada movimiento: "Johan cambió el producto «Cemento Holcim 50K»"
  function frase(a) {
    const quien = `<b>${U.esc(a.quien || "Alguien")}</b>`, et = a.etiqueta ? ` «${U.esc(a.etiqueta)}»` : "";
    const c = a.cambios || {};
    if (a.tabla === "pedidos" && a.origen === "venta borrada") return `${quien} <b class="bit-alerta">borró la venta</b>${et}`;
    if (a.tabla === "pedidos" && a.origen === "venta anulada") return `${quien} <b class="bit-alerta">anuló la venta</b>${et}`;
    if (a.tabla === "pedidos" && a.accion === "INSERT") return `${quien} hizo la venta${et}`;
    if (a.tabla === "pedido_items" && a.accion !== "UPDATE") {
      const det = c.cantidad != null ? ` (${Number(c.cantidad).toLocaleString("es-CR")} × ${valorBit("precio_unit", c.precio_unit)})` : "";
      return `${quien} ${a.accion === "INSERT" ? "agregó" : "quitó"}${et}${det}${a.origen === "venta borrada" ? " al borrar la venta" : ""}`;
    }
    if (a.tabla === "pagos" && a.accion === "INSERT") return `${quien} registró un pago de ${valorBit("monto", c.monto)} en la venta${et}`;
    if (a.tabla === "abonos" && a.accion === "INSERT") return `${quien} registró un abono de ${valorBit("monto", c.monto)}${a.etiqueta ? ` de «${U.esc(a.etiqueta)}»` : ""}`;
    if (a.tabla === "caja_turnos" && a.accion === "INSERT") return `${quien} abrió la caja`;
    const verbo = { INSERT: "agregó", UPDATE: "cambió", DELETE: "borró" }[a.accion] || U.esc(a.accion);
    return `${quien} ${verbo} ${QUE_BIT[a.tabla] || U.esc(a.tabla)}${et}`;
  }
  function detalleBit(a) {
    const c = a.cambios || {};
    let html = "";
    if (a.motivo) html += `<p class="bit-motivo">Motivo: ${U.esc(a.motivo)}</p>`;
    if (a.origen && !["venta borrada", "venta anulada"].includes(a.origen)) html += `<p class="bit-origen">Desde: ${U.esc(a.origen)}</p>`;
    if (a.accion === "UPDATE") {
      const filas = Object.entries(c).filter(([k]) => !OCULTOS_BIT.has(k))
        .map(([k, [antes, despues]]) => k === "imagen_url"
          ? `<li><span>Foto:</span> <b>${antes ? (despues ? "se cambió" : "se quitó") : "se puso"}</b></li>`
          : `<li><span>${campoBit(k)}:</span> ${valorBit(k, antes)} → <b>${valorBit(k, despues)}</b></li>`);
      if (filas.length) html += `<ul class="bit-cambios">${filas.join("")}</ul>`;
    } else if (a.tabla !== "pedido_items") {
      const filas = Object.entries(c).filter(([k]) => !OCULTOS_BIT.has(k))
        .map(([k, v]) => `<li><span>${campoBit(k)}:</span> ${valorBit(k, v)}</li>`);
      if (filas.length) html += `<details class="bit-datos"><summary>${a.accion === "DELETE" ? "Lo que tenía" : "Datos"}</summary><ul class="bit-cambios">${filas.join("")}</ul></details>`;
    }
    return html;
  }
  const BIT = { que: "", filas: [], fin: false, cargando: false };
  async function cargarBitacora(mas = false) {
    if (!V16 || BIT.cargando) return;
    BIT.cargando = true;
    const msg = $("#bitMsg");
    try {
      let q = db.from("auditoria").select(COLS_BIT).order("id", { ascending: false }).limit(50);
      if (mas && BIT.filas.length) q = q.lt("id", BIT.filas[BIT.filas.length - 1].id);
      const quien = $("#bitQuien").value;
      if (quien) q = q.eq("user_id", quien);
      if (BIT.que === "borradas") q = q.eq("tabla", "pedidos").in("origen", ["venta borrada", "venta anulada"]);
      else if (GRUPOS_BIT[BIT.que]) q = q.in("tabla", GRUPOS_BIT[BIT.que]);
      let desde = $("#bitDesde").value, hasta = $("#bitHasta").value;
      if (desde && hasta && desde > hasta) { [desde, hasta] = [hasta, desde]; $("#bitDesde").value = desde; $("#bitHasta").value = hasta; }
      if (desde) q = q.gte("creado", rangoDia(desde)[0]);
      if (hasta) q = q.lt("creado", rangoDia(hasta)[1]);
      const t = $("#bitBuscar").value.replace(/[,()*%\\"]/g, " ").replace(/\s+/g, " ").trim();
      if (t) q = q.or(`etiqueta.ilike."*${t}*",motivo.ilike."*${t}*",quien.ilike."*${t}*"`);
      const { data, error } = await q;
      if (error) throw error;
      BIT.filas = mas ? BIT.filas.concat(data) : data;
      BIT.fin = data.length < 50;
      msg.className = "msg"; msg.textContent = BIT.filas.length ? "" : "No hay movimientos con esos filtros.";
      pintarBitacora();
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    } finally { BIT.cargando = false; }
  }
  function pintarBitacora() {
    let dia = "";
    $("#listaBit").innerHTML = BIT.filas.map((a) => {
      const d = fechaCR(a.creado, { dateStyle: "full" });
      const cab = d !== dia ? `<li class="bit-dia">${U.esc(d)}</li>` : "";
      dia = d;
      return `${cab}<li class="bit-item${a.origen === "venta borrada" || a.origen === "venta anulada" ? " bit-item--alerta" : ""}">
        <time>${fechaCR(a.creado, { timeStyle: "short" })}</time>
        <div><p>${frase(a)}</p>${detalleBit(a)}</div></li>`;
    }).join("");
    $("#btnMasBit").hidden = BIT.fin;
  }
  $("#bitQue").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bq]");
    if (!b) return;
    BIT.que = b.dataset.bq;
    $$("#bitQue [data-bq]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    cargarBitacora();
  });
  ["#bitQuien", "#bitDesde", "#bitHasta"].forEach((id) => $(id).addEventListener("change", () => cargarBitacora()));
  let bitTimer;
  $("#bitBuscar").addEventListener("input", () => { clearTimeout(bitTimer); bitTimer = setTimeout(() => cargarBitacora(), 350); });
  $("#btnMasBit").addEventListener("click", () => cargarBitacora(true));

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
  const ETQ_METODO = { sinpe: "SINPE Móvil", efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", cheque: "Cheque", anterior: "Abonado en Moriah" };
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
    let qv = db.from("pedidos")
      .select("id,codigo,origen,revisado,cliente_nombre,cliente_telefono,estado,estado_pago,total,pagado_registrado,pagado_verificado,created_at" + (V13 ? ",credito,vence" : "") + (V18 ? ",apartado,apartado_vence" : ""));
    if (V18) qv = qv.eq("saldo_inicial", false);       // lo que se debía en Moriah está en Crédito, no es venta
    const { data, error, deCopia } = await consulta("ventas", qv.order("created_at", { ascending: false }).limit(500));
    if (error) { pintarVentas(); return toast(errTxt(error), true); }
    const accs = acciones.leer().filter((a) => a.venta), env = accs.length ? leerLS(LS_ENVIADAS, {}) : {};
    ventas = !accs.length ? data || [] : (data || []).map((v) => {
      const mias = accs.filter((a) => mismaVenta(a.venta, { id: v.id }, env));
      return mias.length ? conPendientes(v, null, mias) : v;
    });
    if (!deCopia) copiarAbiertas();
    if (!deCopia) {
      let cn;
      try { cn = await db.from("comprobantes_cliente").select("pedido_id").eq("estado", "nuevo"); } catch { cn = {}; }
      compNuevos = new Set((cn.data || []).map((r) => r.pedido_id));
    }
    const nuevos = ventas.filter(esNuevo).length;
    $("#badgeVen").hidden = $("#badgeNuevos").hidden = !nuevos;
    $("#badgeVen").textContent = $("#badgeNuevos").textContent = nuevos || "";
    const apVencidos = ventas.filter(apartadoVencido).length;
    $("#badgeApartados").hidden = !apVencidos; $("#badgeApartados").textContent = apVencidos || "";
    pintarCifras();
    pintarVentas();
  }

  const esNuevo = (v) => v.estado !== "anulada" && (!v.revisado || compNuevos.has(v.id));

  // ---------- cómo queda una venta con lo que se hizo sin internet y todavía no se envía ----------
  const estadoPagoDe = (total, reg, ver) => (reg <= 0 ? "sin_pago" : reg < total ? "parcial" : ver < reg ? "por_verificar" : reg > total ? "sobrepago" : "pagado");
  const refVenta = () => (V.local ? { uuid: V.local, temp: V.pedido?.codigo } : V.pedido?.id ? { id: V.pedido.id } : null);
  function conPendientes(v, ref, accs = ref ? acciones.deVenta(ref) : []) {
    if (!accs.length) return v;
    const x = { ...v, pendiente: accs.map((a) => a.tipo) };
    for (const a of accs) {
      if (a.tipo === "pago") {
        x.pagado_registrado = Number(x.pagado_registrado) + Number(a.datos.monto);
        if (a.datos.verificado) x.pagado_verificado = Number(x.pagado_verificado) + Number(a.datos.monto);
      }
      if (a.tipo === "verificar") x.pagado_verificado = Number(x.pagado_verificado) + Number(a.datos.monto || 0);
      if (a.tipo === "entregar" && x.estado === "abierta") { x.estado = "entregada"; x.entregada_at = a.cuando; }
      if (a.tipo === "anular") { x.estado = "anulada"; x.motivo_anulacion = a.datos.motivo; }
    }
    x.estado_pago = estadoPagoDe(Number(x.total), Number(x.pagado_registrado), Number(x.pagado_verificado));
    return x;
  }
  // pagos de la venta + los anotados sin internet (todavía en la compu)
  function pagosConPendientes(pagos, ref) {
    const accs = ref ? acciones.deVenta(ref) : [];
    const ver = new Set(accs.filter((a) => a.tipo === "verificar").map((a) => String(a.datos.pago_id)));
    return (pagos || []).map((g) => (ver.has(String(g.id)) ? { ...g, verificado: true, pendiente: true } : g))
      .concat(accs.filter((a) => a.tipo === "pago").map((a) => ({ ...a.datos, id: "acc:" + a.id, pendiente: true, error: a.error })));
  }
  // vuelve a armar la venta abierta con lo pendiente (después de anotar algo sin internet)
  function aplicarPendientesVenta() {
    if (!V?.base) return;
    const ref = refVenta();
    V.pedido = conPendientes(V.base.pedido, ref);
    V.pagos = V.local ? V.base.pagos : pagosConPendientes(V.base.pagos, ref);
  }
  // comprobantes hechos sin internet que todavía no llegan a la base
  const fePendientes = () => { const ref = V && refVenta(); return ref ? acciones.deVenta(ref).filter((a) => a.tipo === "fe") : []; };
  const docSinRed = (a) => ({ id: "acc:" + a.id, tipo: a.datos.tipo, ambiente: FE?.ambiente, clave: a.datos.clave, consecutivo: a.datos.consecutivo,
    fecha_emision: a.datos.fecha, total: a.datos.total, impuesto: null, estado: "sin_internet", receptor: a.datos.receptor || null,
    detalle: a.error ? "No se pudo enviar: " + a.error : null, anulado: false, sinRed: true });

  // Con internet se guarda una copia de las ventas abiertas (productos, pagos y comprobantes),
  // para poder cobrarlas, entregarlas o anularlas si se va la señal.
  let copiaAbiertasT = 0;
  async function copiarAbiertas() {
    if (!enLinea() || Date.now() - copiaAbiertasT < 10 * 60e3) return;
    copiaAbiertasT = Date.now();
    const ids = ventas.filter((v) => v.estado === "abierta").slice(0, 120).map((v) => v.id);
    if (!ids.length) return;
    try {
      const [pe, it, pg, fe, fa] = await Promise.all([
        db.from("pedidos").select("*").in("id", ids),
        db.from("pedido_items").select("*").in("pedido_id", ids).order("id"),
        db.from("pagos").select("*").in("pedido_id", ids).order("fecha"),
        V10 && FE?.activo ? db.from("v_fe_documentos").select("*").in("pedido_id", ids).order("id") : Promise.resolve({ data: [] }),
        V4 ? db.from("facturas").select("*").in("pedido_id", ids) : Promise.resolve({ data: [] })
      ]);
      if (pe.error || it.error || pg.error) return;
      const c = copia.leer(), det = c.detalles || {};
      for (const p of pe.data) {
        if (det[p.id] && det[p.id].t > copiaAbiertasT - 60e3) continue;           // se acaba de abrir: esa copia es más nueva
        det[p.id] = { pedido: p, items: it.data.filter((i) => i.pedido_id === p.id), pagos: pg.data.filter((g) => g.pedido_id === p.id),
          fe: (fe.data || []).filter((d) => d.pedido_id === p.id), factura: (fa.data || []).find((f) => f.pedido_id === p.id) || null, t: copiaAbiertasT - 120e3 };
      }
      Object.keys(det).sort((a, b) => det[b].t - det[a].t).slice(150).forEach((k) => delete det[k]);
      c.detalles = det; ponerLS(LS_COPIA, c);
    } catch { /* se intenta en la próxima vuelta */ }
  }
  const esApartado = (v) => !!v.apartado && v.estado === "abierta";
  const apartadoVencido = (v) => esApartado(v) && v.apartado_vence < hoyCR() && v.total - v.pagado_registrado > 0;

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
    const aps = ventas.filter(esApartado);
    if (aps.length) cifras.push(["Apartados: falta cobrar", fmt(suma(aps, (v) => Math.max(0, v.total - v.pagado_registrado))),
      `${aps.length} ${aps.length === 1 ? "apartado" : "apartados"} · ya abonaron ${fmt(suma(aps, (v) => v.pagado_registrado))}`]);
    $("#cifrasVentas").innerHTML = cifras.map(([t, n, s]) => `<div><dt>${t}</dt><dd>${n}${s ? `<small>${s}</small>` : ""}</dd></div>`).join("");
  }

  // etiquetas de lo hecho sin internet en una venta (por enviar o con problema)
  function etqPendientes(accs) {
    const n = { fe: "Comprobante sin internet", entregar: "Entrega por enviar", anular: "Anulación por enviar", pago: "Pago por enviar", verificar: "Verificación por enviar" };
    return [...new Set(accs.map((a) => a.tipo))].filter((t) => n[t])
      .map((t) => `<span class="etq ${accs.some((a) => a.tipo === t && a.error) ? "etq--error" : "etq--por_verificar"}">${n[t]}</span>`).join(" ");
  }
  const GLOBO = '<svg class="globo" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>';
  function pintarVentas() {
    const q = $("#vBuscar").value.trim().toLowerCase();
    const pasa = {
      nuevos: esNuevo,
      cobrar: (v) => v.estado === "abierta" && ["sin_pago", "parcial"].includes(v.estado_pago),
      por_verificar: (v) => v.estado !== "anulada" && Number(v.pagado_registrado) > Number(v.pagado_verificado),
      entregar: (v) => (v.origen === "web" || !!v.apartado) && v.estado === "abierta" && ["pagado", "sobrepago"].includes(v.estado_pago),
      apartados: esApartado,
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
            ${r.venta.credito ? `<span class="etq">Crédito · ${U.esc(r.venta.credito.nombre || "")}</span>` : ""}
            ${r.venta.apartado_vence ? `<span class="etq">Apartado · hasta ${U.esc(fechaCorta(r.venta.apartado_vence))}</span>` : ""}
            ${etqPendientes(acciones.deVenta({ uuid: r.id }))}
          </span>
        </div>
        <div class="fila__monto"><b>${fmt(t.total)}</b>${t.total - t.registrado > 0 ? `<small>Falta ${fmt(t.total - t.registrado)}</small>` : ""}</div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-ver-local="${U.esc(r.id)}">Abrir</button></div>
      </li>`;
    }).join("") + (lista.map((v) => {
      const saldo = Math.max(0, v.total - v.pagado_verificado);
      return `<li class="fila fila--venta${v.origen === "web" ? " fila--web" : ""} ${v.estado === "anulada" ? "fila--oculta" : ""}">
        <span class="codigo">${U.esc(v.codigo)}</span>
        <div class="fila__txt">
          <b>${U.esc(v.cliente_nombre)}</b>
          <small>${fechaCR(v.created_at)}${v.cliente_telefono ? " · " + U.esc(v.cliente_telefono) : ""}</small>
          <span class="etiquetas">
            ${v.origen === "web" ? `<span class="etq etq--web">${GLOBO}Pedido de la página</span>` : ""}
            ${!v.revisado && v.estado !== "anulada" ? '<span class="etq etq--rec">Nuevo</span>' : ""}
            ${compNuevos.has(v.id) ? '<span class="etq etq--por_verificar">Comprobante nuevo</span>' : ""}
            ${v.estado === "anulada" ? '<span class="etq">Anulada</span>' : `<span class="etq etq--${v.estado_pago}">${ETQ_PAGO[v.estado_pago]}</span>`}
            ${v.estado === "entregada" ? '<span class="etq etq--ok">Entregada</span>' : ""}
            ${v.credito ? `<span class="etq">Crédito${v.vence ? " · vence " + U.esc(fechaCorta(v.vence)) : ""}</span>` : ""}
            ${v.credito && v.estado !== "anulada" && v.total - v.pagado_registrado > 0 && v.vence < hoyCR() ? '<span class="etq etq--error">Vencida</span>' : ""}
            ${esApartado(v) ? `<span class="etq">Apartado${v.apartado_vence ? " · hasta " + U.esc(fechaCorta(v.apartado_vence)) : ""}</span>` : ""}
            ${apartadoVencido(v) ? '<span class="etq etq--error">Se pasó la fecha</span>' : ""}
            ${v.pendiente ? etqPendientes(acciones.deVenta({ id: v.id })) : ""}
          </span>
        </div>
        <div class="fila__monto"><b>${fmt(v.total)}</b>${v.estado !== "anulada" && saldo > 0 ? `<small>Falta ${fmt(saldo)}</small>` : ""}</div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-ver-venta="${v.id}">Abrir</button></div>
      </li>`;
    }).join("") || (locales.length ? "" : `<li class="vacio-adm">${filtroVenta === "nuevos" ? "No hay pedidos nuevos. Los pedidos que hagan los clientes en la página aparecen aquí." : filtroVenta === "todas" ? "Todavía no hay ventas." : filtroVenta === "apartados" ? "No hay apartados pendientes. Para apartar, abra una venta y escoja <b>Apartado</b>." : "No hay ventas en este grupo."}</li>`));
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

  // ---------- ventas en espera (en esta compu, para atender a otro cliente mientras tanto) ----------
  const LS_ESPERA = "lc_ventas_espera_v1", MAX_ESPERA = 6;
  const esperas = () => { const l = leerLS(LS_ESPERA, []); return Array.isArray(l) ? l : []; };
  function pintarEspera() {
    const l = esperas(), box = $("#ventasEspera");
    box.hidden = !l.length;
    box.innerHTML = l.length ? `<span class="espera__tit">En espera</span>` + l.map((e, n) => {
      const total = e.items.reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
      return `<button type="button" class="espera__ficha" data-espera="${U.esc(e.uuid)}"><span><b>${n + 1}</b> ${U.esc(e.cliente_nombre || CLIENTE_CONTADO)} · ${fmt(total)}</span><small>${e.items.length} ${e.items.length === 1 ? "producto" : "productos"} · ${new Date(e.en).toLocaleTimeString("es-CR", { hour: "numeric", minute: "2-digit", timeZone: TZ })}</small></button>`;
    }).join("") : "";
  }
  $("#btnEspera").addEventListener("click", () => {
    if (!V || V.pedido || !V.items.length) return;
    const l = esperas();
    if (l.length >= MAX_ESPERA && !l.some((e) => e.uuid === V.uuid)) return toast(`Ya hay ${MAX_ESPERA} ventas en espera. Termine alguna primero.`, true);
    const f = $("#formVenta");
    const e = { uuid: V.uuid, en: Date.now(), cliente_nombre: f.cliente_nombre.value.trim(), cliente_telefono: f.cliente_telefono.value.trim(), nota: f.nota.value.trim(),
      items: V.items.map((i) => ({ producto_id: i.producto_id || null, descripcion: i.descripcion, cantidad: i.cantidad, precio_unit: i.precio_unit })),
      cond: V.cond, credCliId: V.credCli?.id || null, apVence: V.apVence || null, exo: V.exo || null };
    if (!ponerLS(LS_ESPERA, l.filter((x) => x.uuid !== e.uuid).concat(e))) return toast("No hay espacio en esta compu para guardarla.", true);
    V.dirty = false;
    $("#dlgVenta").close();
    pintarEspera();
    toast(`Venta en espera (${e.cliente_nombre || CLIENTE_CONTADO}). Atienda al siguiente cliente.`);
    abrirBorrador({ cliente_nombre: "", cliente_telefono: "", items: [] });
  });
  $("#ventasEspera").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-espera]"); if (!b) return;
    if ($("#dlgVenta").open) {
      if (V && V.dirty && V.items.length && !await preguntar("La venta abierta tiene productos sin guardar. ¿Ponerla en espera y abrir la otra?", { si: "Sí, cambiar" })) return;
      if (V && V.dirty && V.items.length && !V.pedido) $("#btnEspera").click();
    }
    const l = esperas(), e = l.find((x) => x.uuid === b.dataset.espera); if (!e) return pintarEspera();
    ponerLS(LS_ESPERA, l.filter((x) => x.uuid !== e.uuid));
    pintarEspera();
    if ($("#dlgVenta").open) $("#dlgVenta").close();
    abrirBorrador(e);
  });

  // ---------- abrir / borrador ----------
  const CLIENTE_CONTADO = "Cliente contado";
  // al entrar al nombre se selecciona todo: si es otro cliente, se escribe encima
  $("#formVenta").cliente_nombre.addEventListener("focus", (e) => { if (e.target.value === CLIENTE_CONTADO) e.target.select(); });
  function abrirBorrador(b) {
    V = { pedido: null, items: b.items, pagos: [], comps: [], dirty: true, uuid: b.uuid || crypto.randomUUID(), cond: b.cond || "contado",
      credCli: b.credCliId ? clientes.find((c) => c.id === b.credCliId) || null : null, apVence: b.apVence || null, exo: b.exo || null, exoCambio: !!b.exo };
    if (V.cond === "credito" && !V.credCli) V.cond = "contado";
    const f = $("#formVenta");
    f.cliente_nombre.value = b.cliente_nombre || CLIENTE_CONTADO;
    f.cliente_telefono.value = b.cliente_telefono || "";
    f.nota.value = (b.nota || "").slice(0, 500);
    pintarVenta();
    $("#dlgVenta").showModal();
    $("#agregarItemQ").focus();
  }

  function abrirDeCopia(id) {
    const det = (copia.leer().detalles || {})[id];
    if (!det) { toast("Sin internet: esta venta no está en la copia de esta compu. Se podrá abrir cuando vuelva la conexión.", true); return; }
    V = { pedido: det.pedido, items: det.items.map((i) => ({ ...i })), pagos: det.pagos, comps: [], factura: det.factura || null, fe: det.fe || [],
      dirty: false, copia: true, base: { pedido: det.pedido, pagos: det.pagos } };
    V.cond = det.pedido.apartado ? "apartado" : det.pedido.credito ? "credito" : "contado";
    V.apVence = det.pedido.apartado_vence || null;
    V.credCli = det.pedido.cliente_id ? clientes.find((c) => c.id === det.pedido.cliente_id) || null : null;
    aplicarPendientesVenta();
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
    let dev = { data: [] };
    if (V23) { try { dev = await db.from("devoluciones").select("*,devolucion_items(*)").eq("pedido_id", id).order("id"); } catch { dev = { data: [] }; } }
    V = { devs: dev.data || [], pedido: p.data, items: it.data.map((i) => ({ ...i })), pagos: pg.data, comps: cc.data, factura: fac.data || null, fe: fe.data || [], dirty: false,
      base: { pedido: p.data, pagos: pg.data } };
    aplicarPendientesVenta();
    V.cond = p.data.apartado ? "apartado" : p.data.credito ? "credito" : "contado";
    V.apVence = p.data.apartado_vence || null;
    V.credCli = null;
    if (V13 && p.data.cliente_id) { await cargarClientes(); V.credCli = clientes.find((c) => c.id === p.data.cliente_id) || null; }
    // lo que esta venta ya descontó del inventario (cuenta como disponible al editarla)
    V.orig = new Map();
    if (p.data.estado !== "anulada") for (const i of it.data) if (i.producto_id) V.orig.set(i.producto_id, (V.orig.get(i.producto_id) || 0) + Number(i.cantidad));
    await refrescarExistencias(it.data.map((i) => i.producto_id));
    copia.detalle(id, { pedido: p.data, items: it.data, pagos: pg.data, factura: fac.data || null, fe: fe.data || [] });
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

  const itemsEditables = () => !V.copia && (!V.pedido || (!!V.local && V.pedido.estado === "abierta") || (V.pedido.estado === "abierta" && Number(V.pedido.pagado_verificado) === 0));

  // ---------- ventas hechas sin internet (guardadas en esta compu) ----------
  function totalesLocal(v) {
    const total = (v.items || []).reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
    const registrado = (v.pagos || []).reduce((a, g) => a + Number(g.monto || 0), 0);
    const verificado = (v.pagos || []).filter((g) => g.verificado).reduce((a, g) => a + Number(g.monto || 0), 0);
    return { total, registrado, verificado };
  }
  function pedidoLocal(rec) {
    const t = totalesLocal(rec.venta), cr = rec.venta.credito;
    const p = { id: null, codigo: rec.temp, estado: "abierta", estado_pago: estadoPagoDe(t.total, t.registrado, t.verificado), total: t.total,
      pagado_registrado: t.registrado, pagado_verificado: t.verificado,
      cliente_nombre: rec.venta.cliente_nombre, cliente_telefono: rec.venta.cliente_telefono, nota: rec.venta.nota, created_at: rec.venta.fecha, local: true,
      credito: !!cr, cliente_id: cr?.cliente_id || null, vence: cr?.vence || null,
      apartado: !!rec.venta.apartado_vence, apartado_vence: rec.venta.apartado_vence || null };
    return conPendientes(p, { uuid: rec.id });
  }
  // a crédito o apartado sin internet (la base lo recibe junto con la venta, v19)
  function condLocal() {
    if (!V19) return {};
    if (V.cond === "credito" && V.credCli) return { credito: { cliente_id: V.credCli.id, nombre: V.credCli.nombre, vence: sumarDias(hoyCR(), Number(V.credCli.plazo_dias) || 30) } };
    if (V.cond === "apartado" && V.apVence) return { apartado_vence: V.apVence };
    return {};
  }
  function abrirLocal(id) {
    const rec = cola.buscar(id);
    if (!rec) { toast("Esa venta ya se envió."); cargarVentas(); return; }
    V = { local: rec.id, pedido: pedidoLocal(rec), items: rec.venta.items.map((i) => ({ ...i })), pagos: rec.venta.pagos || [], comps: [], factura: rec.venta.factura || null, dirty: false };
    V.base = { pedido: V.pedido, pagos: V.pagos };
    V.cond = rec.venta.credito ? "credito" : rec.venta.apartado_vence ? "apartado" : "contado";
    V.apVence = rec.venta.apartado_vence || null;
    V.credCli = rec.venta.credito ? clientes.find((c) => c.id === rec.venta.credito.cliente_id) || { id: rec.venta.credito.cliente_id, nombre: rec.venta.credito.nombre, saldo: 0, plazo_dias: 30, activo: true } : null;
    const f = $("#formVenta");
    f.cliente_nombre.value = rec.venta.cliente_nombre;
    f.cliente_telefono.value = rec.venta.cliente_telefono || "";
    f.nota.value = rec.venta.nota || "";
    pintarVenta();
    if (!$("#dlgVenta").open) $("#dlgVenta").showModal();
  }
  function guardarLocal(d, items) {
    const viejo = V.local ? cola.buscar(V.local) : null;
    const { credito, apartado_vence, ...resto } = viejo?.venta || {};
    const rec = viejo
      ? { ...viejo, error: null, venta: { ...resto, ...d, items, ...condLocal() } }
      : { id: V.uuid || crypto.randomUUID(), temp: numTemporal(), venta: { ...d, fecha: new Date().toISOString(), items, pagos: [], ...condLocal() } };
    if (!cola.guardar(rec)) { $("#ventaMsg").textContent = "No hay espacio en esta compu para guardar la venta."; return false; }
    toast(enLinea() ? "Venta guardada en esta compu. Se enviará en un momento." : "Sin internet: venta guardada en esta compu. Se enviará sola cuando vuelva la conexión.");
    abrirLocal(rec.id);
    pintarVentas();
    estadoRedPanel();
    return true;
  }

  let enviandoCola = false;
  async function enviarCola() {
    if (!enLinea() || enviandoCola || !V5) return;
    const l = cola.leer().filter((r) => !r.error);
    if (!l.length) return enviarAcciones();
    enviandoCola = true;
    let ok = 0, malas = 0;
    try {
      for (const rec of l) {
        if (V && V.local === rec.id && V.dirty) continue;          // la está editando: se manda después
        let r;
        try { r = await conTiempo(db.rpc("registrar_venta_sin_internet", { p_id: rec.id, p_venta: rec.venta }), 20000); } catch (e) { r = { error: e }; }
        if (r.error && U.esErrorRed(r.error)) { sinSenal(r.error); break; }
        if (r.error && r.error.code === "PGRST202") {
          V5 = false;
          U.banda("Hay ventas hechas sin internet, pero falta correr supabase/v5_sin_internet.sql en Supabase para poder enviarlas.");
          $("#bandaRed").dataset.fija = "1";
          break;
        }
        if (r.error) { cola.guardar({ ...rec, error: errTxt(r.error) }); malas++; continue; }
        anotarEnviada(rec.id, r.data);
        cola.quitar(rec.id); ok++;
        (r.data.avisos || []).forEach((m) => toast(`${r.data.codigo}: ${m}`, true));
        if (V && V.local === rec.id && $("#dlgVenta").open) await abrirVenta(r.data.id);
      }
    } finally { enviandoCola = false; }
    if (ok) { toast(ok === 1 ? "Se envió 1 venta hecha sin internet." : `Se enviaron ${ok} ventas hechas sin internet.`); await cargarVentas(); if (V13) cargarClientes(); }
    if (malas) toast(`${malas === 1 ? "Una venta" : malas + " ventas"} sin internet no se pudo enviar. Ábrala en la lista para corregirla.`, true);
    if (ok || malas) { pintarVentas(); pintarBandaRed(); }
    await enviarAcciones();
  }

  // ---------- lo demás hecho sin internet: se manda en orden cuando vuelve la conexión ----------
  async function idVenta(ref) {
    if (ref.id) return { id: Number(ref.id) };
    const e = leerLS(LS_ENVIADAS, {})[ref.uuid];
    if (e) return { id: e.id };
    if (cola.buscar(ref.uuid)) return { espera: "Espera a que se envíe la venta." };
    const { data, error } = await db.from("pedidos").select("id,codigo").eq("offline_id", ref.uuid).maybeSingle();
    if (error) return { error };
    if (!data) return { error: { message: "La venta ya no existe (se borró antes de enviarse)." } };
    anotarEnviada(ref.uuid, data);
    return { id: data.id };
  }
  // la función "facturar" avisa la falta de internet con su propio mensaje
  async function fe(cuerpo) {
    try { return { d: (await llamarFE(cuerpo)).documento }; }
    catch (e) { return { error: /^Sin internet/.test(e.message) ? { message: "Failed to fetch" } : e }; }
  }
  const quedaEnHacienda = (d) => (d.estado === "rechazado" ? { listo: true } : d.estado === "aceptado" ? { listo: true, aceptado: true } : { listo: false });
  const ENVIAR = {
    async pago(a, id) {
      const r = await db.from("pagos").insert({ ...a.datos, pedido_id: id, offline_id: a.id }).select("id").single();
      if (r.error?.code === "23505") return /offline/.test(r.error.message) ? {} : { error: { message: `El comprobante ${a.datos.referencia || ""} ya está registrado en otra venta.` } };
      return r.error ? { error: r.error } : {};
    },
    async verificar(a) {
      const r = await db.from("pagos").update({ verificado: true }).eq("id", a.datos.pago_id);
      return r.error ? { error: r.error } : {};
    },
    async entregar(a, id) {
      const { data: p, error } = await db.from("pedidos").select("estado").eq("id", id).single();
      if (error) return { error };
      if (p.estado === "entregada") return {};
      if (p.estado === "anulada") return { error: { message: "La venta está anulada: no se marcó entregada." } };
      const r = await db.from("pedidos").update({ estado: "entregada" }).eq("id", id);
      return r.error ? { error: r.error } : {};
    },
    // si tiene tiquete o factura electrónica, primero la nota de crédito (cuando Hacienda acepte el comprobante)
    async anular(a, id) {
      const { data: p, error } = await db.from("pedidos").select("estado").eq("id", id).single();
      if (error) return { error };
      if (p.estado === "anulada") return {};
      if (V10) {
        const { data: docs, error: e2 } = await db.from("v_fe_documentos").select("*").eq("pedido_id", id).order("id");
        if (e2) return { error: e2 };
        const vivo = (docs || []).find((d) => ["01", "04"].includes(d.tipo) && d.estado !== "rechazado" && !d.anulado);
        if (vivo) {
          const nc = (docs || []).find((d) => d.tipo === "03" && d.referencia_id === vivo.id && d.estado !== "rechazado");
          const revisar = (d) => fe({ accion: ["firmado", "error"].includes(d.estado) ? "enviar" : "consultar", documento_id: d.id });
          if (!nc && vivo.estado !== "aceptado") {
            const r = await revisar(vivo);
            if (r.error) return { error: r.error };
            if (!quedaEnHacienda(r.d).listo) return { espera: "Esperando que Hacienda acepte el comprobante para hacerle la nota de crédito." };
            if (quedaEnHacienda(r.d).aceptado) return { espera: "Hacienda ya aceptó el comprobante: la nota de crédito sale en el próximo envío." };
          } else if (!nc) {
            const r = await fe({ accion: "anular", documento_id: vivo.id, motivo: String(a.datos.motivo).slice(0, 180) });
            if (r.error) return { error: r.error };
            if (r.d.estado === "rechazado") return { error: { message: "Hacienda rechazó la nota de crédito: " + (r.d.detalle || "vea el XML.") } };
            if (r.d.estado !== "aceptado") return { espera: "Esperando que Hacienda acepte la nota de crédito." };
          } else if (nc.estado !== "aceptado") {
            const r = await revisar(nc);
            if (r.error) return { error: r.error };
            if (r.d.estado === "rechazado") return { error: { message: "Hacienda rechazó la nota de crédito: " + (r.d.detalle || "vea el XML.") } };
            if (r.d.estado !== "aceptado") return { espera: "Esperando que Hacienda acepte la nota de crédito." };
          }
        }
      }
      const r = await db.from("pedidos").update({ estado: "anulada", motivo_anulacion: String(a.datos.motivo).slice(0, 300) }).eq("id", id);
      return r.error ? { error: r.error } : {};
    },
    async fe(a, id) {
      const { tipo, clave, fecha, credito_dias } = a.datos;
      const r = await fe({ accion: "emitir_sin_internet", pedido_id: id, tipo, clave, fecha, ...(credito_dias ? { credito_dias } : {}) });
      return r.error ? { error: r.error } : {};
    },
    async abono(a) {
      const { error } = await db.rpc("registrar_abono", { p: { ...a.datos, offline_id: a.id } });
      return error ? { error } : {};
    },
    async verificar_abono(a) {
      const { error } = await db.rpc("verificar_abono", { p_id: a.datos.abono_id });
      return error ? { error } : {};
    },
    async caja_abrir(a) {
      const { error } = await db.rpc("abrir_caja", { p_fondo: a.datos.fondo, p_cuando: a.cuando, p_id: a.id });
      return error ? { error } : {};
    },
    async caja_mover(a) {
      const { error } = await db.rpc("mover_caja", { p_tipo: a.datos.tipo, p_monto: a.datos.monto, p_motivo: a.datos.motivo, p_cuando: a.cuando, p_id: a.id });
      return error ? { error } : {};
    },
    async caja_cerrar(a) {
      const d = a.datos;
      const { error } = await db.rpc("cerrar_caja", { p_turno: d.turno || null, p_contado: d.contado, p_conteo: d.conteo || null, p_nota: d.nota || null, p_cuando: a.cuando, p_id: a.id });
      return error ? { error } : {};
    }
  };
  // lo que va en orden: lo de una misma venta, la caja y los abonos de un mismo cliente
  const filaDe = (a) => (a.venta ? (a.venta.uuid || "v" + a.venta.id) : a.tipo.startsWith("caja_") ? "caja" : a.tipo === "abono" ? "cli" + a.datos.cliente_id : null);
  let enviandoAcc = false;
  async function enviarAcciones() {
    if (!enLinea() || enviandoAcc || !acciones.leer().length) return;
    enviandoAcc = true;
    let hechas = 0, malas = 0, caja = false, cred = false;
    const trabadas = new Set();
    try {
      for (const a of acciones.leer()) {
        const fila = filaDe(a);
        if (fila && trabadas.has(fila)) continue;
        if (a.error) { if (fila) trabadas.add(fila); continue; }
        let res = null, id = null;
        try {
          if (a.venta) { const v = await idVenta(a.venta); if (v.error || v.espera) res = v; else id = v.id; }
          if (!res) res = (await ENVIAR[a.tipo](a, id)) || {};
        } catch (e) { res = { error: e }; }
        if (res.error && U.esErrorRed(res.error)) { sinSenal(res.error); break; }   // se fue otra vez: sigue después
        if (res.espera) { if (a.espera !== res.espera) acciones.guardar({ ...a, espera: res.espera }); if (fila) trabadas.add(fila); continue; }
        if (res.error) { acciones.guardar({ ...a, error: errTxt(res.error), espera: null }); malas++; if (fila) trabadas.add(fila); continue; }
        acciones.quitar(a.id); hechas++;
        if (a.tipo.startsWith("caja_")) caja = true;
        if (a.tipo === "abono" || a.tipo === "verificar_abono") cred = true;
      }
    } finally { enviandoAcc = false; }
    if (hechas) {
      toast(hechas === 1 ? "Se envió 1 cosa hecha sin internet." : `Se enviaron ${hechas} cosas hechas sin internet.`);
      cargarVentas(); contarPorVerificar();
      if (caja) cargarTurno();
      if (cred && V13) cargarClientes().then(pintarClientes);
      if ($("#dlgVenta").open && V?.pedido?.id && !V.dirty) abrirVenta(V.pedido.id);
    }
    if (malas) toast(`${malas === 1 ? "Una cosa hecha" : malas + " cosas hechas"} sin internet no se ${malas === 1 ? "pudo" : "pudieron"} enviar: vea “Pendientes”.`, true);
    pintarBandaRed();
    if ($("#dlgPendientes").open) pintarPendientes();
  }

  function abrirPendientes() { pintarPendientes(); if (!$("#dlgPendientes").open) $("#dlgPendientes").showModal(); }
  function pintarPendientes() {
    const hora = (iso) => fechaCR(iso, { dateStyle: "short", timeStyle: "short" });
    const estado = (x) => (x.error ? `No se pudo enviar: ${U.esc(x.error)}` : x.espera ? U.esc(x.espera) : "Por enviar");
    const filas = [
      ...cola.leer().map((r) => ({ cuando: r.venta.fecha, html: `<li class="pend ${r.error ? "pend--mal" : ""}">
        <div class="pend__txt"><b>Venta ${U.esc(r.temp)} · ${U.esc(r.venta.cliente_nombre)} · ${fmt(totalesLocal(r.venta).total)}</b>
          <small>${hora(r.venta.fecha)} · ${estado(r)}</small></div>
        <div class="pend__acc">${r.error ? `<button type="button" class="btn btn--sm btn--negro" data-pend-otra-venta="${U.esc(r.id)}">Intentar otra vez</button>` : ""}
          <button type="button" class="btn btn--sm btn--linea" data-pend-venta="${U.esc(r.id)}">Abrir</button></div></li>` })),
      ...acciones.leer().map((a) => ({ cuando: a.cuando, html: `<li class="pend ${a.error ? "pend--mal" : ""}">
        <div class="pend__txt"><b>${U.esc(a.desc || a.tipo)}</b>
          <small>${hora(a.cuando)} · ${estado(a)}${a.tipo === "fe" ? ` · tiene que llegar a Hacienda a más tardar el ${U.esc(fechaCorta(limiteHacienda(a.cuando)))}` : ""}</small></div>
        <div class="pend__acc">${a.error ? `<button type="button" class="btn btn--sm btn--negro" data-pend-otra="${a.id}">Intentar otra vez</button>` : ""}
          <button type="button" class="enlace enlace--peligro" data-pend-quitar="${a.id}">Descartar</button></div></li>` }))
    ].sort((x, y) => new Date(x.cuando) - new Date(y.cuando));
    $("#listaPendientes").innerHTML = filas.map((f) => f.html).join("") || `<li class="vacio-adm">No hay nada pendiente: todo se envió.</li>`;
    const b = $("#btnEnviarPendientes");
    b.hidden = !filas.length;
    b.disabled = !navigator.onLine;
    b.textContent = !navigator.onLine ? "Sin internet" : SIN_RED ? "Entrar para enviar" : "Enviar ahora";
  }
  $("#btnCerrarPendientes").addEventListener("click", () => $("#dlgPendientes").close());
  $("#btnEnviarPendientes").addEventListener("click", async () => {
    if (SIN_RED) return location.reload();
    $("#btnEnviarPendientes").disabled = true;
    await enviarCola();
    pintarPendientes();
  });
  $("#listaPendientes").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.pendVenta) { $("#dlgPendientes").close(); return abrirLocal(b.dataset.pendVenta); }
    if (b.dataset.pendOtraVenta) {
      const r = cola.buscar(b.dataset.pendOtraVenta); if (r) cola.guardar({ ...r, error: null });
      pintarPendientes(); pintarBandaRed(); enviarCola();
    }
    if (b.dataset.pendOtra) {
      const a = acciones.leer().find((x) => x.id === b.dataset.pendOtra); if (a) acciones.guardar({ ...a, error: null, espera: null });
      pintarPendientes(); pintarBandaRed(); enviarCola();
    }
    if (b.dataset.pendQuitar) {
      const a = acciones.leer().find((x) => x.id === b.dataset.pendQuitar); if (!a) return;
      const txt = a.tipo === "fe"
        ? "OJO: el cliente ya tiene el recibo con la clave de este comprobante. Si lo descarta, nunca llega a Hacienda. ¿Descartarlo de todos modos?"
        : `¿Descartar “${a.desc || a.tipo}”? No se va a enviar.`;
      if (!await preguntar(txt)) return;
      acciones.quitar(a.id);
      pintarPendientes(); pintarBandaRed(); cargarVentas();
      if (a.tipo.startsWith("caja_")) cargarTurno();
    }
  });

  // ---------- existencia dentro de la venta ----------
  // precio más bajo con que se puede vender un producto sin permiso de precios (el normal o la oferta vigente)
  function precioCatalogo(id) {
    const p = productos.find((x) => x.id === id);
    if (!p || p.precio == null) return null;
    return ofertaVigente(p) ? Math.min(Number(p.precio), Number(p.precio_oferta)) : Number(p.precio);
  }
  const STOCK_BAJO = 10;                       // menos de esto: "ya casi no quedan"
  const cantTxt = (n) => Number(n).toLocaleString("es-CR", { maximumFractionDigits: 2 });
  const quedaTxt = (n) => (Number(n) === 1 ? "queda 1" : `quedan ${cantTxt(n)}`);
  const prodDe = (id) => (id ? productos.find((x) => x.id === id) : null);
  const nombreItem = (it) => prodDe(it.producto_id)?.nombre || it.descripcion;
  // cuánto se puede vender en esta venta: la existencia + lo que esta misma venta ya había descontado
  function disponible(id) {
    const p = prodDe(id);
    if (!V12 || !p || p.existencia == null || V.copia) return Infinity;
    return Number(p.existencia) + (V.local ? 0 : (V.orig?.get(id) || 0));
  }
  const usadoEnVenta = (id, salvo) => V.items.reduce((t, i) => t + (i.producto_id === id && i !== salvo ? Number(i.cantidad) || 0 : 0), 0);
  function notaStock(it) {
    const disp = disponible(it.producto_id);
    if (!isFinite(disp)) return "";
    const quedan = disp - usadoEnVenta(it.producto_id);
    if (quedan < 0) return `<span class="stock-sin">Solo hay ${cantTxt(Math.max(0, disp))}: baje la cantidad</span>`;
    if (quedan === 0) return `<span class="stock-bajo">Es lo último que hay</span>`;
    if (quedan < STOCK_BAJO) return `<span class="stock-bajo">Ya casi no quedan: después de esta venta ${quedaTxt(quedan)}</span>`;
    return "";
  }
  function pintarNotasStock() {
    $$("#itemsVenta [data-stock]").forEach((el) => { const it = V.items[Number(el.dataset.stock)]; if (it) el.innerHTML = notaStock(it); });
  }

  function pintarVenta() {
    const p = V.pedido, edit = itemsEditables();
    $("#ventaTitulo").textContent = p ? p.cliente_nombre : "Nueva venta";
    $("#ventaCodigo").textContent = p ? p.codigo : "";
    const pend = p?.pendiente || [];
    const etqPend = (pend.includes("anular") ? ' <span class="etq etq--por_verificar">Anulación por enviar</span>' : "")
      + (pend.includes("entregar") ? ' <span class="etq etq--por_verificar">Entrega por enviar</span>' : "")
      + (pend.includes("pago") || pend.includes("verificar") ? ' <span class="etq etq--por_verificar">Pagos por enviar</span>' : "");
    const etqVenta = (x) => (x.estado === "anulada" ? `<span class="etq">Anulada</span> ${U.esc(x.motivo_anulacion || "")}`
      : `<span class="etq etq--${x.estado_pago}">${ETQ_PAGO[x.estado_pago]}</span>${x.estado === "entregada" ? ` <span class="etq etq--ok">Entregada ${fechaCR(x.entregada_at, { dateStyle: "short" })}</span>` : ""}`
        + (x.saldo_inicial ? ' <span class="etq">Saldo anterior de Moriah</span>' : esApartado(x) ? ' <span class="etq">Apartado</span>' : x.credito && x.local ? ' <span class="etq">A crédito</span>' : ""));
    $("#ventaEstado").innerHTML = V.local
      ? `<span class="etq etq--por_verificar">Por enviar</span> <span class="etq">Hecha sin internet</span>${cola.buscar(V.local)?.error ? ` <span class="etq etq--error">${U.esc(cola.buscar(V.local).error)}</span>` : ""} ${etqVenta(p)}${etqPend}`
      : p ? (p.origen === "web" ? `<span class="etq etq--web">${GLOBO}Pedido de la página</span> ` : "") + (V.copia ? `<span class="etq">Sin internet: copia de la última conexión</span> ` : "") + etqVenta(p) + etqPend
      : "Sin guardar";

    $("#itemsVenta").innerHTML = V.items.map((i, n) => `
      <tr data-n="${n}">
        <td><input data-k="descripcion" value="${U.esc(i.descripcion)}" maxlength="120" aria-label="Descripción" ${edit ? "" : "disabled"} />${edit ? `<small class="stock-nota" data-stock="${n}">${notaStock(i)}</small>` : ""}</td>
        <td class="num"><input data-k="cantidad" type="number" min="0.01" step="0.01" value="${U.esc(i.cantidad)}" ${edit && isFinite(disponible(i.producto_id)) ? `max="${disponible(i.producto_id)}"` : ""} aria-label="Cantidad" ${edit ? "" : "disabled"} /></td>
        <td class="num"><input data-k="precio_unit" type="number" min="0" step="0.01" value="${U.esc(i.precio_unit)}" aria-label="Precio unitario" ${edit && (puede("precios") || !i.producto_id || !precioCatalogo(i.producto_id)) ? "" : "disabled"} /></td>
        <td class="num" data-sub>${fmt(i.cantidad * i.precio_unit)}</td>
        <td>${edit ? `<button type="button" class="cerrar-x" data-quitar-item="${n}" aria-label="Quitar renglón">✕</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="vacio-adm">Agregue productos a la venta.</td></tr>`;
    actualizarTotal();
    $("#itemsAcc").hidden = !edit;
    $("#itemsBloqueo").hidden = edit;
    pintarCondicion();
    pintarExo();
    $("#btnEspera").hidden = !!p || !V.items.length || !!V.copia;

    const cerrada = p && p.estado !== "abierta";
    const web = p?.origen === "web";
    $("#dlgVenta").classList.toggle("venta--web", web);
    $("#btnCobrarWa").hidden = !web || !p || !!V.local || !!V.copia || p.estado === "anulada" || (Number(p.total) > 0 && Number(p.pagado_registrado) >= Number(p.total));
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

    if (!V.copia && enLinea()) cargarMiniaturas();

    // pagos
    $("#ventaSaldo").textContent = p ? `· Total ${fmt(p.total)} · Registrado ${fmt(p.pagado_registrado)} · Verificado ${fmt(p.pagado_verificado)}` : "";
    $("#pagosVenta").innerHTML = p ? (V.pagos.map(V.local ? pagoLocalHTML : pagoHTML).join("") || `<li class="vacio-adm">Sin pagos registrados.</li>`) : `<li class="vacio-adm">Guarde la venta para registrar pagos.</li>`;
    $$("#formVenta input").forEach((i) => (i.disabled = !!V.copia || p?.estado === "anulada"));
    $("#boxPagosVenta").hidden = !V.pagos.length;
    const fp = $("#formPago");
    fp.reset();
    fp.dataset.montoAuto = "1";
    fp.fecha.value = ahoraLocalCR();
    fp.fecha.max = ahoraLocalCR();
    fp.nombre_origen.value = "";
    $("#cobroPaga").value = "";
    fp.querySelector(".cobro__mas").open = false;
    delete fp.dataset.compId; delete fp.dataset.ruta;
    $("#avisoComp").hidden = true;
    fp.comprobante.disabled = false;
    $("#pagoMsg").textContent = "";
    pintarFormaPago();
    refrescarCobro();

    // entregar es para pedidos de la página (y apartados): en el mostrador se lo lleva de una vez
    $("#btnEntregar").hidden = !p || cerrada || !(web || p.apartado);
    $("#formPago").comprobante.disabled = !!V.local;

    // entrega, listo y factura
    const ent = $("#ventaEntrega");
    ent.hidden = !p || !V4 || !web;
    if (V.local) ent.hidden = true;
    else if (p && V4) {
      ent.innerHTML = (p.entrega === "envio"
        ? `<b>Envío a ${U.esc(p.zona || "domicilio")}</b>${p.direccion ? ": " + U.esc(p.direccion) : ""}`
        : "<b>Retira en el almacén</b>") +
        (p.listo_at ? ` <span class="etq etq--ok">Listo desde ${fechaCR(p.listo_at, { dateStyle: "short", timeStyle: "short" })}</span>` : "");
    }
    $("#btnListo").hidden = !web || !p || p.estado !== "abierta" || !V4 || !!V.local || !!V.copia || !enLinea();
    $("#btnListo").textContent = p?.listo_at ? "Avisar otra vez que está listo" : "Avisar que está listo";
    // un saldo que viene de Moriah ya se facturó allá
    // sin internet: los datos para factura de una venta hecha en la compu se guardan con ella
    // el registro a mano de una factura hecha en otro sistema solo se ve si la venta ya tiene uno
    $("#boxFactura").hidden = !p || !V4 || (V10 && !!FE?.activo) || !V.factura || !!V.copia || (!!V.local && !V19) || !!p.saldo_inicial;
    if (!$("#boxFactura").hidden) pintarFactura();
    $("#boxFE").hidden = !p || !V10 || !FE?.activo || !!p.saldo_inicial;
    if (!$("#boxFE").hidden) pintarFEVenta();
    $("#btnAnularVenta").hidden = !p || p.estado === "anulada" || !puede("anular");
    pintarDevoluciones();
    $(".imprimir").hidden = !p;
    $("#btnBorrarVenta").hidden = !puedeBorrarVenta();
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
      <div class="pago__acc">${g.verificado ? "" : `<button type="button" class="btn btn--sm btn--negro" data-verificar="${n}" data-monto="${g.monto}" data-ref="${U.esc(g.referencia || "")}">Ya lo vi en el banco</button>`}
        <button type="button" class="enlace enlace--peligro" data-quitar-pago-local="${n}">Quitar</button></div>
    </li>`;
  }
  $("#pagosVenta").addEventListener("click", async (e) => {
    const q = e.target.closest("[data-quitar-pago-pend]");
    if (q) {
      e.stopImmediatePropagation();
      if (!await preguntar("¿Quitar este pago? Todavía no se ha enviado.")) return;
      acciones.quitar(q.dataset.quitarPagoPend);
      aplicarPendientesVenta(); pintarVenta(); cargarVentas(); pintarBandaRed();
      return;
    }
    const b = e.target.closest("[data-quitar-pago-local]");
    if (!b || !V.local) return;
    e.stopImmediatePropagation();
    if (!await preguntar("¿Quitar este pago? La venta todavía no se ha enviado.")) return;
    const rec = cola.buscar(V.local); if (!rec) return;
    rec.venta.pagos.splice(Number(b.dataset.quitarPagoLocal), 1);
    rec.error = null;
    cola.guardar(rec); abrirLocal(rec.id); pintarVentas();
  });

  function pagoHTML(g) {
    const red = enLinea();
    const estado = g.anulado
      ? `<span class="etq">Anulado</span> <small>${U.esc(g.motivo_anulacion || "")}</small>`
      : g.pendiente
        ? `<span class="etq ${g.verificado ? "etq--pagado" : "etq--por_verificar"}">${g.verificado ? "Recibido" : "Por verificar"}</span> <span class="etq etq--por_verificar">Por enviar</span>${g.error ? ` <span class="etq etq--error">${U.esc(g.error)}</span>` : ""}`
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
        ${g.comprobante_path && red ? `<button type="button" class="btn btn--sm btn--linea" data-comp="${U.esc(g.comprobante_path)}">Ver comprobante</button>` : ""}
        ${!g.anulado && !g.verificado ? `<button type="button" class="btn btn--sm btn--negro" data-verificar="${g.id}" data-monto="${g.monto}" data-ref="${U.esc(g.referencia || "")}">Ya lo vi en el banco</button>` : ""}
        ${!g.anulado && !g.pendiente && red ? `<button type="button" class="enlace enlace--peligro" data-anular-pago="${g.id}">Anular</button>` : ""}
        ${g.pendiente && !V.local ? `<button type="button" class="enlace enlace--peligro" data-quitar-pago-pend="${U.esc(String(g.id).slice(4))}">Quitar</button>` : ""}
      </div>
    </li>`;
  }

  // lo que ya se devolvió de esta venta (las devoluciones bajan el total, no los renglones)
  const devueltoVenta = () => (V?.devs || []).reduce((a, d) => a + (Number(d.total) || 0), 0);
  function actualizarTotal() {
    const t = V.items.reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
    const dev = devueltoVenta();
    $("#ventaTotal").innerHTML = dev > 0
      ? `${fmt(t - dev)}<small class="total-dev">${fmt(t)} − ${fmt(dev)} devuelto</small>` : fmt(t);
    refrescarCobro(t);
    return t;
  }

  // edición de renglones
  $("#itemsVenta").addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-n]"), k = e.target.dataset.k;
    if (!tr || !k) return;
    const it = V.items[Number(tr.dataset.n)];
    it[k] = k === "descripcion" ? e.target.value : Number(e.target.value);
    if (k === "cantidad" && it.producto_id) {
      const max = disponible(it.producto_id) - usadoEnVenta(it.producto_id, it);
      if (it.cantidad > max) {
        it.cantidad = Math.max(0, max);
        e.target.value = it.cantidad;
        toast(max > 0 ? `Solo hay ${cantTxt(max)} de ${nombreItem(it)}. No se puede vender más de lo que hay.` : `No hay ${nombreItem(it)} en el inventario.`, true);
      }
      pintarNotasStock();
    }
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
      if (e.key === "Enter") {
        e.preventDefault();
        buscar();          // el lector escribe muy rápido: se busca con lo último que llegó
        // un código de barras (solo números) que no existe no agrega "lo más parecido"
        const q = input.value.trim();
        if (/^[0-9]{6,}$/.test(q) && !productos.some((x) => x.codigo && String(x.codigo).toLowerCase() === q.toLowerCase() && (opciones.ocultos || x.activo))) {
          res.innerHTML = `<li class="buscar-item__nada">No hay ningún producto con el código ${U.esc(q)}. Póngaselo en Productos → Editar → Código.</li>`;
          res.hidden = false; input.select();
          return;
        }
        const b = res.querySelector("button"); if (b) b.click();
      }
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
  const POCOS = 2;                             // con 2 o menos se pregunta a la base antes de agregarlo (otra compu pudo venderlo)
  let colaAgregar = Promise.resolve();        // si escanean el mismo producto dos veces seguidas, se agrega uno detrás del otro
  buscadorProductos($("#agregarItemQ"), $("#agregarItemRes"), (p) => { colaAgregar = colaAgregar.then(() => agregarProducto(p)).catch(() => {}); },
    { nada: "No se encontró. Use “Agregar renglón libre”." });
  async function agregarProducto(p) {
    if (!V || !$("#dlgVenta").open) return;
    if (enLinea() && disponible(p.id) - usadoEnVenta(p.id) <= POCOS) {
      try { await conTiempo(refrescarExistencias([p.id]), 4000); } catch { /* sin respuesta: se sigue con lo que hay */ }
      if (!V) return;
    }
    const ya = V.items.find((i) => i.producto_id === p.id);
    const quedan = disponible(p.id) - usadoEnVenta(p.id);
    if (quedan <= 0) {
      return toast(disponible(p.id) > 0 ? `Ya agregó todo lo que hay de ${p.nombre} (${cantTxt(disponible(p.id))}).` : `No hay ${p.nombre} en el inventario.`, true);
    }
    const suma = Math.min(1, quedan);          // si queda menos de 1 (p. ej. 0,5 m), se agrega lo que queda
    const despues = Math.round((quedan - suma) * 100) / 100;
    if (despues === 0) toast(`Es lo último que hay de ${p.nombre}.`);
    else if (despues < STOCK_BAJO) toast(`Ya casi no quedan: después de esta venta ${quedaTxt(despues)} de ${p.nombre}.`);
    if (ya) ya.cantidad = Math.round((Number(ya.cantidad) + suma) * 100) / 100;
    else V.items.push({ producto_id: p.id, descripcion: p.nombre + (p.unidad ? ` (${p.unidad})` : ""), cantidad: suma, precio_unit: p.precio != null ? precioVenta(p, precioCatalogo(p.id) ?? Number(p.precio)) : 0 });
    V.dirty = true;
    pintarVenta();
  }
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
    if (items.some((i) => i.precio_unit === 0) && !await preguntar("Hay renglones con precio ₡0. ¿Guardar así?")) return false;

    if (V.copia) return false;
    const errCredito = revisarCredito(items) || revisarApartado();
    if (errCredito) { msg.textContent = errCredito; return false; }
    if (V12 && enLinea()) await refrescarExistencias(items.map((i) => i.producto_id));
    const pasados = [...new Set(items.filter((i) => i.producto_id).map((i) => i.producto_id))]
      .filter((id) => usadoEnVenta(id) > disponible(id));
    if (pasados.length) {
      pintarNotasStock();
      msg.textContent = "No hay suficiente: " + pasados.map((id) => `${prodDe(id).nombre} (hay ${cantTxt(Math.max(0, disponible(id)))})`).join(", ") + ". Baje la cantidad o registre la entrada de mercadería.";
      return false;
    }
    // venta hecha sin internet que todavía no se envía: se actualiza en la compu
    if (V.local) return guardarLocal(d, items);
    // venta nueva sin conexión: se guarda en la compu
    if (!V.pedido && !enLinea()) return guardarLocal(d, items);

    const btn = $("#btnGuardarVenta");
    btn.disabled = true; msg.textContent = "";
    try {
      // venta nueva: se manda de una sola vez con su identificador; si el internet se cae
      // a medio camino queda en la compu y al reenviarla no se duplica
      if (!V.pedido && V5) {
        const venta = { ...d, fecha: new Date().toISOString(), items, pagos: [] };
        // v24: el cliente y la exoneración van con la venta (de ellos depende el precio permitido)
        if (V24 && V.cond === "credito" && V.credCli) venta.cliente_precio = V.credCli.id;
        if (V24 && V.exo) venta.exoneracion = V.exo;
        let r;
        try { r = await conTiempo(db.rpc("registrar_venta_sin_internet", { p_id: V.uuid, p_venta: venta }), 15000); } catch (e) { r = { error: e }; }
        if (r.error && U.esErrorRed(r.error)) { sinSenal(r.error); return guardarLocal(d, items); }
        if (r.error && r.error.code === "PGRST202") V5 = false;        // base sin v5: se guarda como antes
        else if (r.error) throw r.error;
        else { await despuesDeGuardar(r.data.id, null); return true; }
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
        // antes de cambiar los renglones: el cliente y la exoneración nuevos (el precio permitido depende de ellos)
        if (V24 && V.pedido) {
          if (V.exoCambio) {
            const { error } = await db.rpc("poner_exoneracion", { p_pedido: id, p_ex: V.exo || null });
            if (error) throw error;
            V.exoCambio = false;
          }
          const quiere = V.cond === "credito" && V.credCli ? V.credCli.id : null;
          if (quiere && quiere !== V.pedido.cliente_id) {
            const { error } = await db.rpc("poner_credito", { p_pedido: id, p_cliente: quiere });
            if (error) throw error;
          }
        }
        if (V.pedido) { const del = await db.from("pedido_items").delete().eq("pedido_id", id); if (del.error) throw del.error; }
        const ins = await db.from("pedido_items").insert(items.map((i) => ({ ...i, pedido_id: id })));
        if (ins.error) throw ins.error;
      }
      await despuesDeGuardar(id, V.pedido);
      return true;
    } catch (err) {
      msg.textContent = errTxt(err);
      return false;
    } finally { btn.disabled = false; }
  }
  $("#btnGuardarVenta").addEventListener("click", async () => {
    const paraDespues = !V.pedido && V.cond === "contado";
    if (!(await guardarVenta())) return;
    if (paraDespues) { $("#dlgVenta").close(); toast("Guardada para después. La encuentra en Ventas › Por cobrar."); }
  });
  // clic afuera de una ventana = tocar su botón de cerrar (así cada una hace su propia pregunta si hay algo sin guardar)
  $$("dialog.dlg").forEach((dl) => {
    let abajo = null;
    dl.addEventListener("pointerdown", (e) => { abajo = e.target; });
    dl.addEventListener("click", (e) => {
      if (e.target !== dl || abajo !== dl) return;
      const r = dl.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
      const btn = dl.querySelector("#btnCerrarVenta, header .cerrar-x, .dlg__cab .cerrar-x, [data-cerrar-dlg], [data-cerrar-ajuste], [data-cerrar-cliente], [data-cerrar-fotos], [id^=btnCancelar], [id^=btnCerrar]")
        || [...dl.querySelectorAll("button")].find((b) => /^(cerrar|cancelar)$/i.test(b.textContent.trim()));
      if (btn && !btn.hidden) btn.click();
    });
  });
  // Esc pasa por la misma pregunta que la ✕
  $("#dlgVenta").addEventListener("cancel", (e) => { e.preventDefault(); $("#btnCerrarVenta").click(); });

  $("#btnCerrarVenta").addEventListener("click", async () => {
    // una venta nueva sin productos se cierra sin preguntar
    if (V && V.dirty && itemsEditables() && (V.pedido || V.items.length) && !await preguntar(V.pedido ? "Hay cambios sin guardar. ¿Cerrar igual?"
      : "Esta venta no se ha guardado y se pierde. Si va a atender a otro cliente, use “Poner en espera”.", { titulo: V.pedido ? "" : "¿Cerrar sin guardar?", si: "Cerrar", peligro: true })) return;
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
    if (V.local) {
      const rec = cola.buscar(V.local); if (!rec) return;
      if (fePendientes().length) { msg.textContent = "Ya se hizo el comprobante de esta venta: los datos ya no se pueden cambiar."; return; }
      rec.venta.factura = { tipo_id: d.tipo_id, identificacion: d.identificacion, nombre: d.nombre, correo: d.correo, estado: "pendiente", solicitada_por: "panel" };
      rec.error = null; cola.guardar(rec);
      toast("Datos para la factura guardados con la venta.");
      abrirLocal(rec.id);
      return;
    }
    const r = V.factura
      ? await db.from("facturas").update(d).eq("id", V.factura.id)
      : await db.from("facturas").insert({ ...d, pedido_id: V.pedido.id, solicitada_por: "panel" });
    if (r.error) { msg.textContent = errTxt(r.error); return; }
    toast("Factura guardada");
    await abrirVenta(V.pedido.id);
  });

  // ---------- crédito dentro de la venta ----------
  const fechaCorta = (d) => new Date(String(d).slice(0, 10) + "T12:00:00-06:00").toLocaleDateString("es-CR", { day: "numeric", month: "short", timeZone: TZ });
  const diasEntre = (a, b) => Math.round((new Date(b + "T12:00:00-06:00") - new Date(a + "T12:00:00-06:00")) / 864e5);
  const sumarDias = (d, n) => new Date(new Date(d + "T12:00:00-06:00").getTime() + n * 864e5).toISOString().slice(0, 10);
  // lo que el cliente debe sin contar esta venta
  function deudaSinEsta(c) {
    const p = V.pedido;
    const propia = p && !p.local && p.credito && p.cliente_id === c.id && p.estado !== "anulada" ? Math.max(0, p.total - p.pagado_registrado) : 0;
    return Math.max(0, Number(c.saldo_base ?? c.saldo) - propia + deudaSinEnviar(c.id, V.local));
  }
  // lo que el cliente debe por ventas a crédito hechas sin internet (menos sus abonos sin enviar)
  function deudaSinEnviar(cliId, salvo) {
    const enCompu = cola.leer().filter((r) => r.id !== salvo && Number(r.venta.credito?.cliente_id) === Number(cliId))
      .reduce((t, r) => { const x = totalesLocal(r.venta); return t + Math.max(0, x.total - x.registrado); }, 0);
    const abonos = acciones.leer().filter((a) => a.tipo === "abono" && Number(a.datos.cliente_id) === Number(cliId)).reduce((t, a) => t + Number(a.datos.monto), 0);
    return enCompu - abonos;
  }
  const totalPendienteVenta = () => Math.max(0, actualizarTotal() - devueltoVenta() - (V.pedido ? Number(V.pedido.pagado_registrado) : 0));
  // sin internet: solo una venta nueva (que se guarda en la compu) se puede poner a crédito o como apartado
  function revisarSinRed(que) {
    if (enLinea() && !V.local) return "";
    if (V.pedido && !V.local) return `Sin internet no se puede pasar una venta ya enviada a ${que}.`;
    if (!V19) return `Para ${que === "crédito" ? "vender a crédito" : "apartar"} sin internet falta correr supabase/v19_sin_internet.sql en Supabase.`;
    return "";
  }
  function revisarCredito() {
    if (!V13 || V.cond !== "credito") return "";
    const sr = revisarSinRed("crédito"); if (sr) return sr;
    const c = V.credCli;
    if (!c) return "Escoja el cliente de crédito (o cambie a Contado).";
    if (!c.activo) return `El crédito de ${c.nombre} está desactivado.`;
    if (c.limite != null && deudaSinEsta(c) + totalPendienteVenta() > Number(c.limite))
      return `Pasa el límite de crédito de ${c.nombre}: ya debe ${fmt(deudaSinEsta(c))}, esta venta es de ${fmt(totalPendienteVenta())} y el límite es ${fmt(c.limite)}.`;
    return "";
  }
  // apartado: se guarda la mercadería y el cliente la va pagando; necesita su teléfono y una fecha límite
  function revisarApartado() {
    if (!V18 || V.cond !== "apartado") return "";
    const sr = revisarSinRed("apartado"); if (sr) return sr;
    if (U.soloDigitos($("#formVenta").cliente_telefono.value).length < 8) return "Para apartar, ponga el teléfono del cliente (para avisarle).";
    if (!V.apVence) return "Ponga hasta qué fecha se le guarda el apartado.";
    if (V.apVence !== V.pedido?.apartado_vence) {
      if (V.apVence < hoyCR()) return "La fecha del apartado ya pasó: ponga una de hoy en adelante.";
      if (V.apVence > sumarDias(hoyCR(), 365)) return "Un apartado es de un año como máximo.";
    }
    return "";
  }
  async function ponerApartado(id, si, vence) {
    const { error } = await db.rpc("poner_apartado", { p_pedido: id, p_apartado: si, p_vence: si ? vence : null });
    return error ? `La venta se guardó, pero ${si ? "no quedó como apartado" : "sigue como apartado"}: ${errTxt(error)}` : "";
  }
  async function despuesDeGuardar(id, antes) {
    let aviso = "";
    if (V13) {
      const quiere = V.cond === "credito" && V.credCli ? V.credCli.id : null;
      const tenia = antes?.credito ? antes.cliente_id : null;
      const apQuiere = V18 && V.cond === "apartado", apTenia = !!antes?.apartado;
      // primero se quita lo que ya no va (apartado o crédito) y después se pone lo nuevo
      if (apTenia && !apQuiere) aviso = await ponerApartado(id, false);
      if (!aviso && (quiere || tenia)) {
        const { error } = await db.rpc("poner_credito", { p_pedido: id, p_cliente: quiere });
        if (error) aviso = `La venta se guardó, pero ${quiere ? "no quedó a crédito" : "sigue a crédito"}: ${errTxt(error)}`;
        await cargarClientes();
      }
      if (!aviso && apQuiere && (!apTenia || antes.apartado_vence !== V.apVence)) aviso = await ponerApartado(id, true, V.apVence);
    }
    if (!aviso && V.exoCambio && V22) {
      const { error } = await db.rpc("poner_exoneracion", { p_pedido: id, p_ex: V.exo || null });
      if (error) aviso = `La venta se guardó, pero la exoneración no: ${errTxt(error)}`;
      else V.exoCambio = false;
    }
    toast(aviso || "Venta guardada", !!aviso);
    refrescarExistencias(V.items.map((i) => i.producto_id));
    await abrirVenta(id);
    if (aviso) $("#ventaMsg").textContent = aviso;
    cargarVentas();
  }
  function pintarCondicion() {
    const p = V.pedido, nueva = !p || !!V.local;
    // con internet, o sin internet en una venta nueva si la base ya tiene v19
    const online = (enLinea() && !V.local) || (nueva && V19);
    const edit = itemsEditables() && (!V.local || V19);
    const puedeCred = puede("credito") || !!p?.credito;
    // apartar (o quitarlo) se puede mientras la venta esté abierta, aunque ya tenga abonos
    const puedeAp = V18 && (!p || !!V.local || (p.estado === "abierta" && !p.saldo_inicial));
    const ver = V13 && !V.copia && (p ? p.estado !== "anulada" || p.credito : true) && (online || p?.credito || p?.apartado)
      && (puedeCred || puedeAp || !!p?.apartado);
    $("#boxCondicion").hidden = !ver;
    if (!ver) return;
    const cred = V.cond === "credito", ap = V.cond === "apartado";
    const habil = {
      contado: cred ? edit : ap ? puedeAp : true,
      credito: edit && (!ap || puedeAp),
      apartado: puedeAp && (!cred || edit)
    };
    $$("#ventaCondicion [data-cond]").forEach((b) => {
      const c = b.dataset.cond;
      b.setAttribute("aria-checked", String(c === V.cond));
      if (c === "credito") b.hidden = !puedeCred;
      if (c === "apartado") b.hidden = !V18 || !(puedeAp || p?.apartado);
      b.disabled = !online || !habil[c];
    });
    $("#boxCliCredito").hidden = !cred || !edit || !online;
    pintarApartado(puedeAp && online);
    const info = $("#cliCreditoInfo");
    info.hidden = !cred;
    if (!cred) return;
    const c = V.credCli;
    if (!c) { info.innerHTML = "Escoja el cliente de crédito."; return; }
    const debe = deudaSinEsta(c), esta = totalPendienteVenta();
    const desde = p ? String(p.created_at).slice(0, 10) : hoyCR();
    const vence = p?.credito && p.vence ? p.vence : sumarDias(desde, c.plazo_dias);
    const partes = [`<b>${U.esc(c.nombre)}</b>`, `debe ${fmt(debe)} sin esta venta`];
    if (c.limite != null) partes.push(`límite ${fmt(c.limite)}`);
    const pagada = p && !V.local && p.estado !== "anulada" && Number(p.total) > 0 && Number(p.pagado_registrado) >= Number(p.total);
    partes.push(pagada ? "esta venta ya está pagada" : `esta venta vence el ${U.esc(fechaCorta(vence))} (${c.plazo_dias} días)`);
    let alerta = "";
    if (!c.activo) alerta = "El crédito de este cliente está desactivado.";
    else if (c.limite != null && debe + esta > Number(c.limite)) alerta = `Con esta venta pasa el límite por ${fmt(debe + esta - c.limite)}.`;
    if (Number(c.vencido) > 0) alerta += `${alerta ? " " : ""}Tiene ${fmt(c.vencido)} vencido.`;
    info.innerHTML = partes.join(" · ") + (alerta ? ` <span class="cred-alerta">${U.esc(alerta)}</span>` : "");
  }
  function pintarApartado(editable) {
    const box = $("#boxApartado");
    box.hidden = V.cond !== "apartado";
    if (box.hidden) return;
    const p = V.pedido, inp = $("#apartadoVence");
    inp.min = hoyCR(); inp.max = sumarDias(hoyCR(), 365);
    inp.value = V.apVence || "";
    inp.disabled = !editable;
    const total = actualizarTotal(), abonado = p ? Number(p.pagado_registrado) : 0, falta = Math.max(0, total - abonado);
    let txt = `${abonado > 0 ? `Ha abonado <b>${fmt(abonado)}</b>` : "Todavía no ha abonado"} · falta <b>${fmt(falta)}</b>. La mercadería se le guarda y se entrega cuando termine de pagar.`;
    let alerta = "";
    if (U.soloDigitos($("#formVenta").cliente_telefono.value).length < 8) alerta = "Ponga el teléfono del cliente.";
    else if (V.apVence && V.apVence < hoyCR() && falta > 0) alerta = "Ya pasó la fecha: llame al cliente para que termine de pagar, o dele más tiempo.";
    $("#apartadoInfo").innerHTML = txt + (alerta ? ` <span class="cred-alerta">${U.esc(alerta)}</span>` : "");
  }
  $("#ventaCondicion").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cond]"); if (!b || b.disabled) return;
    if (V.cond === b.dataset.cond) return;
    V.cond = b.dataset.cond; V.dirty = true;
    if (V.cond === "apartado" && !V.apVence) V.apVence = sumarDias(hoyCR(), 30);    // un mes, se puede cambiar
    $("#ventaMsg").textContent = "";
    repreciarPorCliente();
    pintarCondicion();
    refrescarCobro();
    if (V.cond === "credito" && !V.credCli) $("#cliCreditoQ").focus();
  });
  $("#apartadoVence").addEventListener("change", (e) => { V.apVence = e.target.value || null; V.dirty = true; pintarCondicion(); });
  // al cambiar cantidades o productos, el aviso de límite (o lo que falta del apartado) se actualiza
  $("#itemsVenta").addEventListener("input", () => { if (V?.cond === "credito" || V?.cond === "apartado") pintarCondicion(); });
  $("#formVenta").cliente_telefono.addEventListener("input", () => { if (V?.cond === "apartado") pintarCondicion(); });

  // buscador de clientes de crédito
  function buscadorClientes(input, res, alElegir, nada = "No hay un cliente de crédito con ese nombre. Créelo en la pestaña Crédito.") {
    const caja = input.closest(".buscar-item");
    function buscar() {
      const q = norm(input.value), qd = U.soloDigitos(input.value);
      if (q.length < 2) { res.hidden = true; res.innerHTML = ""; return; }
      const lista = clientes.filter((c) => norm(c.nombre).includes(q) || (qd.length >= 4 && (U.soloDigitos(c.identificacion).includes(qd) || U.soloDigitos(c.telefono).includes(qd)))).slice(0, 10);
      res.innerHTML = lista.map((c) => `<li><button type="button" data-cli-id="${c.id}">
          <span>${U.esc(c.nombre)}${c.activo ? "" : " <small>· desactivado</small>"}</span>
          <span class="buscar-item__det">debe ${fmt(c.saldo)}${Number(c.vencido) > 0 ? ` · vencido ${fmt(c.vencido)}` : ""}</span>
        </button></li>`).join("") || `<li class="buscar-item__nada">${U.esc(nada)}</li>`;
      res.hidden = false;
    }
    input.addEventListener("input", buscar);
    input.addEventListener("focus", () => { if (input.value.trim().length >= 2) buscar(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const b = res.querySelector("button"); if (b) b.click(); }
      if (e.key === "Escape" && !res.hidden) { e.preventDefault(); e.stopPropagation(); res.hidden = true; }
    });
    caja.addEventListener("focusout", (e) => {
      if (!e.relatedTarget || !caja.contains(e.relatedTarget)) setTimeout(() => { if (!caja.contains(document.activeElement)) res.hidden = true; }, 150);
    });
    res.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cli-id]"); if (!b) return;
      const c = clientes.find((x) => x.id == b.dataset.cliId); if (!c) return;
      input.value = ""; res.hidden = true;
      alElegir(c);
    });
  }
  buscadorClientes($("#cliCreditoQ"), $("#cliCreditoRes"), (c) => {
    V.credCli = c; V.dirty = true;
    $("#ventaMsg").textContent = "";
    const f = $("#formVenta");
    f.cliente_nombre.value = c.nombre.slice(0, 80);
    if (c.telefono) f.cliente_telefono.value = c.telefono;
    repreciarPorCliente();
    pintarCondicion();
  });
  // al cambiar de cliente (o de contado a crédito) los productos toman el precio que le toca
  function repreciarPorCliente() {
    if (!V24 || !itemsEditables()) return;
    const antes = V.items.map((i) => i.precio_unit).join();
    aplicarExoPrecios();
    if (V.items.map((i) => i.precio_unit).join() !== antes) {
      const c = V.cond === "credito" ? V.credCli : null;
      toast(c && (Number(c.tipo_precio) === 2 || Number(c.descuento) > 0)
        ? `Precios de ${c.nombre}: ${[Number(c.tipo_precio) === 2 ? "precio 2" : "", Number(c.descuento) > 0 ? `${c.descuento} % de descuento` : ""].filter(Boolean).join(" y ")}.`
        : "Los productos volvieron al precio normal.");
      pintarVenta();
    }
  }

  // ---------- pestaña Crédito: clientes, estado de cuenta y abonos ----------
  let credFiltro = "saldo", CLI = null;
  async function cargarClientes() {
    if (!V13) return clientes;
    let r;
    try { r = await consulta("clientes", conTiempo(db.from("v_clientes_credito").select("*").order("nombre"), 15000)); } catch (e) { r = { error: e }; }
    if (r.error) {
      if (U.esErrorRed(r.error)) { const c = copia.leer().clientes; if (c) { clientes = c.map((x) => ({ ...x })); ajustarSaldos(); } }
      else toast(errTxt(r.error), true);
      return clientes;
    }
    clientes = (r.data || []).map((x) => ({ ...x }));
    ajustarSaldos();
    const vencidos = clientes.filter((c) => Number(c.vencido) > 0).length;
    $("#badgeCred").hidden = !vencidos; $("#badgeCred").textContent = vencidos;
    return clientes;
  }
  // lo que cada cliente debe, con lo hecho sin internet que todavía no se envía
  function ajustarSaldos() {
    for (const c of clientes) {
      if (c.saldo_base === undefined) c.saldo_base = Number(c.saldo);
      c.saldo = Math.max(0, c.saldo_base + deudaSinEnviar(c.id, null));
      if (c.limite != null) c.disponible = Math.max(0, Number(c.limite) - c.saldo);
    }
  }
  function pintarClientes() {
    ajustarSaldos();
    const q = norm($("#credBuscar").value), qd = U.soloDigitos($("#credBuscar").value);
    const pasa = { saldo: (c) => c.activo && Number(c.saldo) > 0, vencidos: (c) => Number(c.vencido) > 0, todos: (c) => c.activo, inactivos: (c) => !c.activo }[credFiltro];
    const lista = clientes.filter(pasa).filter((c) => !q || norm(c.nombre).includes(q) || (qd.length >= 4 && (U.soloDigitos(c.identificacion).includes(qd) || U.soloDigitos(c.telefono).includes(qd))))
      .sort((a, b) => Number(b.vencido) - Number(a.vencido) || Number(b.saldo) - Number(a.saldo) || a.nombre.localeCompare(b.nombre, "es"));
    const suma = (k) => clientes.reduce((t, c) => t + Number(c[k] || 0), 0);
    const conSaldo = clientes.filter((c) => Number(c.saldo) > 0).length, vencidos = clientes.filter((c) => Number(c.vencido) > 0).length;
    $("#credCifras").innerHTML = `
      <div><dt>Por cobrar</dt><dd>${fmt(suma("saldo"))}<small>${conSaldo} ${conSaldo === 1 ? "cliente" : "clientes"} con saldo</small></dd></div>
      <div><dt>Vencido</dt><dd>${fmt(suma("vencido"))}<small>${vencidos} ${vencidos === 1 ? "cliente" : "clientes"}</small></dd></div>
      <div><dt>Clientes de crédito</dt><dd>${clientes.filter((c) => c.activo).length}<small>activos</small></dd></div>`;
    $("#listaClientes").innerHTML = lista.map((c) => `<li class="fila fila--pago ${c.activo ? "" : "fila--oculta"}">
        <div class="fila__monto"><b>${fmt(c.saldo)}</b><small>${Number(c.vencido) > 0 ? `<span class="vence-tarde">${fmt(c.vencido)} vencido</span>` : c.abiertas ? `${c.abiertas} ${c.abiertas === 1 ? "venta" : "ventas"}` : "al día"}</small></div>
        <div class="fila__txt">
          <b>${U.esc(c.nombre)}</b>
          <small>${[c.telefono, c.identificacion, c.limite != null ? `límite ${fmt(c.limite)} · disponible ${fmt(c.disponible)}` : "sin límite", `${c.plazo_dias} días`].filter(Boolean).map(U.esc).join(" · ")}</small>
          ${c.vence_primero && Number(c.saldo) > 0 ? `<span class="etiquetas"><span class="etq ${c.vence_primero < hoyCR() ? "etq--error" : ""}">${c.vence_primero < hoyCR() ? `Vencida desde ${U.esc(fechaCorta(c.vence_primero))}` : `Próximo vencimiento ${U.esc(fechaCorta(c.vence_primero))}`}</span></span>` : ""}
        </div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-ver-cliente="${c.id}">Abrir</button></div>
      </li>`).join("") || `<li class="vacio-adm">${clientes.length ? "Ningún cliente en este grupo." : "Todavía no hay clientes de crédito. Toque <b>Nuevo cliente</b>."}</li>`;
  }
  $("#credBuscar").addEventListener("input", pintarClientes);
  $("#credFiltro").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cf]"); if (!b) return;
    credFiltro = b.dataset.cf;
    $$("#credFiltro [data-cf]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarClientes();
  });
  $("#listaClientes").addEventListener("click", (e) => { const b = e.target.closest("[data-ver-cliente]"); if (b) abrirCliente(Number(b.dataset.verCliente)); });
  $("#btnNuevoCliente").addEventListener("click", () => abrirCliente(null));
  $$("[data-cerrar-cliente]").forEach((b) => b.addEventListener("click", () => $("#dlgCliente").close()));

  let cliVentas = [], cliAbonos = [];
  async function abrirCliente(id) {
    CLI = id ? clientes.find((c) => c.id === id) : null;
    const f = $("#formCliente");
    f.reset(); $("#cliMsg").textContent = ""; $("#cliMsg").className = "msg";
    f.id.value = CLI?.id || "";
    ["nombre", "tipo_id", "identificacion", "telefono", "correo", "limite", "nota"].forEach((k) => (f.elements[k].value = CLI?.[k] ?? ""));
    f.plazo_dias.value = CLI?.plazo_dias ?? 30;
    f.tipo_precio.value = String(CLI?.tipo_precio || 1);
    f.descuento.value = Number(CLI?.descuento) > 0 ? CLI.descuento : "";
    f.activo.checked = CLI ? !!CLI.activo : true;
    $("#cliTitulo").textContent = CLI ? CLI.nombre : "Nuevo cliente de crédito";
    $("#boxCliDatos").open = !CLI;
    $("#boxCliCuenta").hidden = !CLI;
    $("#cliCifras").hidden = !CLI;
    $("#boxAbono").open = false;
    if (!$("#dlgCliente").open) $("#dlgCliente").showModal();
    if (!CLI) { f.nombre.focus(); return; }
    pintarCifrasCliente();
    await cargarCuentaCliente();
  }
  function pintarCifrasCliente() {
    const c = CLI;
    $("#cliCifras").innerHTML = `
      <div><dt>Debe</dt><dd>${fmt(c.saldo)}<small>${c.abiertas} ${c.abiertas === 1 ? "venta pendiente" : "ventas pendientes"}</small></dd></div>
      <div><dt>Vencido</dt><dd class="${Number(c.vencido) > 0 ? "vence-tarde" : ""}">${fmt(c.vencido)}</dd></div>
      <div><dt>Disponible</dt><dd>${c.limite != null ? fmt(c.disponible) : "Sin límite"}<small>${c.limite != null ? `de ${fmt(c.limite)}` : ""}</small></dd></div>
      <div><dt>Plazo</dt><dd>${c.plazo_dias} días<small>${c.activo ? "crédito activo" : "crédito desactivado"}</small></dd></div>`;
  }
  async function cargarCuentaCliente() {
    const id = CLI.id;
    let v, a;
    if (enLinea()) {
      try {
        [v, a] = await conTiempo(Promise.all([
          db.from("pedidos").select("id,codigo,created_at,total,pagado_registrado,vence,estado" + (V18 ? ",saldo_inicial,ref_anterior" : "")).eq("cliente_id", id).eq("credito", true).neq("estado", "anulada").order("created_at", { ascending: false }).limit(300),
          db.from("abonos").select("*").eq("cliente_id", id).order("fecha", { ascending: false }).limit(100)
        ]), 15000);
      } catch (e) { v = { error: e }; }
    } else v = { error: { message: "Failed to fetch" } };
    const err = v.error || a?.error;
    if (err && !U.esErrorRed(err)) return toast(errTxt(err), true);
    if (err) {
      // sin internet: la copia de la última vez que se abrió esta cuenta
      const c = (copia.leer().cuentas || {})[id];
      cliVentas = c?.ventas || []; cliAbonos = c?.abonos || [];
      $("#cliSinRed").hidden = false;
      $("#cliSinRed").textContent = c ? `Sin internet: estado de cuenta del ${fechaCR(new Date(c.t).toISOString(), { dateStyle: "short", timeStyle: "short" })}. Los abonos que registre se envían al volver la conexión.`
        : "Sin internet: el detalle de esta cuenta se ve con conexión. Igual puede registrar abonos: se envían al volver la conexión.";
      return pintarCuentaCliente();
    }
    $("#cliSinRed").hidden = true;
    cliVentas = v.data; cliAbonos = a.data;
    let partes = [];
    if (cliAbonos.length) {
      const r = await db.from("pagos").select("abono_id,monto,verificado,anulado,pedidos(codigo)").in("abono_id", cliAbonos.map((x) => x.id));
      partes = r.data || [];
    }
    for (const ab of cliAbonos) ab.partes = partes.filter((x) => x.abono_id === ab.id);
    const c = copia.leer(), cu = c.cuentas || {};
    cu[id] = { ventas: cliVentas, abonos: cliAbonos, t: Date.now() };
    Object.keys(cu).sort((x, y) => cu[y].t - cu[x].t).slice(60).forEach((k) => delete cu[k]);
    c.cuentas = cu; ponerLS(LS_COPIA, c);
    pintarCuentaCliente();
  }
  function pintarCuentaCliente() {
    const hoy = hoyCR(), solo = $("#cliSoloSaldo").checked;
    // ventas a crédito hechas sin internet en esta compu (todavía no están en la base)
    const locales = cola.leer().filter((r) => Number(r.venta.credito?.cliente_id) === Number(CLI.id)).map((r) => {
      const t = totalesLocal(r.venta);
      return { id: null, local: r.id, codigo: r.temp, created_at: r.venta.fecha, total: t.total, pagado_registrado: t.registrado, vence: r.venta.credito.vence };
    });
    const filas = locales.concat(cliVentas).filter((p) => !solo || p.total - p.pagado_registrado > 0);
    $("#cliVentas").innerHTML = filas.map((p) => {
      const saldo = Math.max(0, p.total - p.pagado_registrado), dias = p.vence ? diasEntre(hoy, p.vence) : null;
      const vence = !p.vence ? "" : saldo <= 0 ? U.esc(fechaCorta(p.vence))
        : dias < 0 ? `<span class="vence-tarde">${U.esc(fechaCorta(p.vence))} · hace ${-dias} ${dias === -1 ? "día" : "días"}</span>`
        : dias <= 5 ? `<span class="vence-pronto">${U.esc(fechaCorta(p.vence))} · ${dias === 0 ? "hoy" : `en ${dias} ${dias === 1 ? "día" : "días"}`}</span>`
        : U.esc(fechaCorta(p.vence));
      return `<tr class="${saldo <= 0 ? "pagada" : ""}">
        <td>${fechaCR(p.created_at, { dateStyle: "short" })}</td>
        <td>${p.local ? `<button type="button" class="enlace" data-cli-local="${U.esc(p.local)}">${U.esc(p.codigo)}</button><span class="saldo-cli">Hecha sin internet: por enviar</span>`
          : `<button type="button" class="enlace" data-cli-venta="${p.id}">${U.esc(p.codigo)}</button>`}${p.saldo_inicial ? `<span class="saldo-cli">Saldo de Moriah${docMoriah(p) ? ` · doc. ${U.esc(docMoriah(p))}` : ""}</span>` : ""}</td>
        <td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.pagado_registrado)}</td><td class="num"><b>${fmt(saldo)}</b></td>
        <td>${saldo <= 0 ? "Pagada" : vence}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="vacio-adm">${cliVentas.length ? "No debe nada." : "Todavía no tiene ventas a crédito."}</td></tr>`;
    const abPend = acciones.leer().filter((a) => a.tipo === "abono" && Number(a.datos.cliente_id) === Number(CLI.id));
    const verPend = new Set(acciones.leer().filter((a) => a.tipo === "verificar_abono").map((a) => Number(a.datos.abono_id)));
    $("#cliAbonos").innerHTML = abPend.map((a) => `<li class="pago">
        <div class="pago__monto">${fmt(a.datos.monto)}<small>${ETQ_METODO[a.datos.metodo] || U.esc(a.datos.metodo)}</small></div>
        <div class="pago__datos">
          <span>${fechaCR(a.datos.fecha || a.cuando)}</span>
          ${a.datos.referencia ? `<span>Comprobante <b>${U.esc(a.datos.referencia)}</b></span>` : ""}
          <span><span class="etq etq--por_verificar">Por enviar</span> ${a.datos.verificado ? '<span class="etq etq--pagado">Recibido</span>' : '<span class="etq etq--por_verificar">Por verificar</span>'}${a.error ? ` <span class="etq etq--error">${U.esc(a.error)}</span>` : ""}</span>
        </div>
        <div class="pago__acc">${a.datos.verificado ? "" : `<button type="button" class="btn btn--sm btn--negro" data-verificar-abono="acc:${a.id}">Ya lo vi en el banco</button>`}
          <button type="button" class="enlace enlace--peligro" data-quitar-abono-pend="${a.id}">Quitar</button></div>
      </li>`).join("") + cliAbonos.map((ab) => {
      const sinVer = (ab.partes || []).some((x) => !x.verificado && !x.anulado) && !verPend.has(Number(ab.id));
      return `<li class="pago ${ab.anulado ? "pago--anulado" : ""}">
        <div class="pago__monto">${fmt(ab.monto)}<small>${ETQ_METODO[ab.metodo] || U.esc(ab.metodo)}</small></div>
        <div class="pago__datos">
          <span>${fechaCR(ab.fecha)}</span>
          ${ab.referencia ? `<span>Comprobante <b>${U.esc(ab.referencia)}</b></span>` : ""}
          <span>Abono ${ab.id}: ${(ab.partes || []).map((x) => `${U.esc(x.pedidos?.codigo || "")} ${fmt(x.monto)}`).join(" · ")}</span>
          ${ab.anulado ? `<span><span class="etq">Anulado</span> ${U.esc(ab.motivo_anulacion || "")}</span>` : sinVer ? '<span class="etq etq--por_verificar">Por verificar</span>' : `<span class="etq etq--pagado">Recibido</span>${verPend.has(Number(ab.id)) ? ' <span class="etq etq--por_verificar">Por enviar</span>' : ""}`}
          ${ab.nota ? `<span>${U.esc(ab.nota)}</span>` : ""}
        </div>
        <div class="pago__acc">${ab.anulado ? "" : `${sinVer ? `<button type="button" class="btn btn--sm btn--negro" data-verificar-abono="${ab.id}">Ya lo vi en el banco</button>` : ""}${enLinea() ? `<button type="button" class="enlace enlace--peligro" data-anular-abono="${ab.id}">Anular</button>` : ""}`}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">Todavía no hay abonos.</li>`;
    const fa = $("#formAbono");
    fa.monto.max = CLI.saldo || "";
    $("#btnAbonoTodo").textContent = `Todo lo que debe (${fmt(CLI.saldo)})`;
    $("#btnAbonoTodo").disabled = !(Number(CLI.saldo) > 0);
    $("#boxAbono").hidden = !(Number(CLI.saldo) > 0);
  }
  $("#cliSoloSaldo").addEventListener("change", pintarCuentaCliente);
  $("#cliVentas").addEventListener("click", (e) => {
    const l = e.target.closest("[data-cli-local]");
    if (l) { $("#dlgCliente").close(); return abrirLocal(l.dataset.cliLocal); }
    const b = e.target.closest("[data-cli-venta]"); if (!b) return;
    $("#dlgCliente").close(); abrirVenta(Number(b.dataset.cliVenta));
  });
  async function recargarCliente() {
    await cargarClientes();
    CLI = clientes.find((c) => c.id === CLI?.id) || CLI;
    if (CLI) { $("#cliTitulo").textContent = CLI.nombre; pintarCifrasCliente(); await cargarCuentaCliente(); }
    pintarClientes();
  }
  $("#formCliente").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#cliMsg");
    const d = {
      nombre: f.nombre.value.trim(), tipo_id: f.tipo_id.value || null, identificacion: U.soloDigitos(f.identificacion.value) || null,
      telefono: f.telefono.value.trim() || null, correo: f.correo.value.trim().toLowerCase() || null,
      limite: f.limite.value === "" ? null : Math.max(0, Number(f.limite.value)), plazo_dias: Math.round(Number(f.plazo_dias.value) || 30),
      activo: f.activo.checked, nota: f.nota.value.trim() || null,
      ...(V24 ? { tipo_precio: Number(f.tipo_precio.value) === 2 ? 2 : 1, descuento: Math.min(50, Math.max(0, Number(f.descuento.value) || 0)) } : {})
    };
    msg.className = "msg msg--error";
    if (d.nombre.length < 2) { msg.textContent = "Escriba el nombre."; return; }
    if (!!d.tipo_id !== !!d.identificacion) { msg.textContent = "Ponga el tipo de identificación y el número (o deje los dos vacíos)."; return; }
    const RE = { fisica: /^[1-9][0-9]{8}$/, juridica: /^[0-9]{10}$/, dimex: /^[0-9]{11,12}$/, nite: /^[0-9]{10}$/ };
    if (d.tipo_id && !RE[d.tipo_id].test(d.identificacion)) { msg.textContent = "Revise la identificación: física 9 dígitos, jurídica 10, DIMEX 11 o 12, NITE 10."; return; }
    if (d.telefono && !/^[0-9 +()-]{8,20}$/.test(d.telefono)) { msg.textContent = "Revise el teléfono."; return; }
    if (d.correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.correo)) { msg.textContent = "Revise el correo."; return; }
    if (!(d.plazo_dias >= 1 && d.plazo_dias <= 365)) { msg.textContent = "El plazo es de 1 a 365 días."; return; }
    msg.className = "msg"; msg.textContent = "Guardando…";
    const id = f.id.value;
    const r = id ? await db.from("clientes").update(d).eq("id", id).select("id").single() : await db.from("clientes").insert(d).select("id").single();
    if (r.error) { msg.className = "msg msg--error"; msg.textContent = r.error.code === "23505" ? "Ya hay un cliente con esa cédula." : errTxt(r.error); return; }
    msg.textContent = "Guardado.";
    toast(id ? "Cliente actualizado" : "Cliente creado");
    await cargarClientes(); pintarClientes();
    abrirCliente(r.data.id);
  });
  $("#btnAbonoTodo").addEventListener("click", () => { $("#formAbono").monto.value = CLI.saldo; $("#formAbono").monto.focus(); });
  $("#formAbono").metodo.addEventListener("change", (e) => {
    // el efectivo está en la caja; un SINPE hay que verlo en el banco; un cheque, esperar a que el banco lo pague
    $("#formAbono").verificado.checked = e.target.value === "efectivo" || e.target.value === "tarjeta";
    $("#abonoRefTxt").textContent = e.target.value === "cheque" ? "N.º del cheque" : "N.º de comprobante";
  });
  $("#boxAbono").addEventListener("toggle", () => {
    if (!$("#boxAbono").open) return;
    const fa = $("#formAbono"); fa.reset(); $("#abonoMsg").textContent = ""; $("#abonoRefTxt").textContent = "N.º de comprobante";
    fa.fecha.value = ahoraLocalCR(); fa.fecha.max = ahoraLocalCR();
    fa.monto.focus();
  });
  $("#formAbono").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#abonoMsg");
    const monto = Number(f.monto.value), ref = f.referencia.value.trim();
    msg.className = "msg msg--error";
    if (!(monto > 0)) { msg.textContent = "Escriba el monto."; return; }
    if (monto > Number(CLI.saldo) + 0.001) { msg.textContent = `Debe ${fmt(CLI.saldo)}: el abono no puede ser mayor.`; return; }
    if (["sinpe", "transferencia", "cheque"].includes(f.metodo.value) && !ref) { msg.textContent = f.metodo.value === "cheque" ? "Ponga el número del cheque." : "Ponga el número de comprobante."; return; }
    const fecha = f.fecha.value ? new Date(f.fecha.value + ":00-06:00").toISOString() : null;
    // con su número de envío: si el internet se cae a medio camino y se manda otra vez, no se repite
    const datos = { cliente_id: CLI.id, monto: String(Math.round(monto * 100) / 100), metodo: f.metodo.value, referencia: ref, fecha, nota: f.nota.value.trim(), verificado: f.verificado.checked,
      ...(V19 ? { offline_id: crypto.randomUUID() } : {}) };
    const abonoSinRed = () => {
      if (!V19) { msg.className = "msg msg--error"; msg.textContent = "Para registrar abonos sin internet falta correr supabase/v19_sin_internet.sql."; return; }
      const { offline_id, ...resto } = datos;
      const a = acciones.agregar("abono", { ...resto, fecha: datos.fecha || new Date().toISOString() }, { id: offline_id, desc: `Abono de ${fmt(monto)} (${ETQ_METODO[datos.metodo] || datos.metodo}) · ${CLI.nombre}` });
      if (!a) { msg.className = "msg msg--error"; msg.textContent = "No hay espacio en esta compu para guardarlo."; return; }
      msg.textContent = ""; $("#boxAbono").open = false; f.reset();
      toast("Sin internet: abono anotado en esta compu. Se aplica a sus ventas cuando vuelva la conexión.");
      ajustarSaldos(); pintarCifrasCliente(); pintarCuentaCliente(); pintarClientes(); pintarBandaRed();
    };
    if (!enLinea()) return abonoSinRed();
    msg.className = "msg"; msg.textContent = "Registrando…";
    let data, error;
    try { ({ data, error } = await conTiempo(db.rpc("registrar_abono", { p: datos }), 15000)); } catch (e) { error = e; }
    if (error && U.esErrorRed(error) && V19) { sinSenal(error); return abonoSinRed(); }
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); return; }
    $("#boxAbono").open = false;
    toast(`Abono registrado. Se aplicó a ${data.aplicado.map((x) => `${x.codigo} (${fmt(x.monto)})`).join(", ")}. Ahora debe ${fmt(data.saldo_despues)}.`);
    await recargarCliente();
    cargarVentas();
  });
  $("#cliAbonos").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-verificar-abono]"), a = e.target.closest("[data-anular-abono]"), q = e.target.closest("[data-quitar-abono-pend]");
    if (q) {
      if (!await preguntar("¿Quitar este abono? Todavía no se ha enviado.")) return;
      acciones.quitar(q.dataset.quitarAbonoPend);
      ajustarSaldos(); pintarCifrasCliente(); pintarCuentaCliente(); pintarClientes(); pintarBandaRed();
      return;
    }
    if (v && (String(v.dataset.verificarAbono).startsWith("acc:") || !enLinea())) {
      if (!await preguntar("¿Confirma que ya vio este abono en la app del banco?")) return;
      const id = String(v.dataset.verificarAbono);
      if (id.startsWith("acc:")) {
        const x = acciones.leer().find((y) => y.id === id.slice(4));
        if (x) acciones.guardar({ ...x, datos: { ...x.datos, verificado: true } });
      } else acciones.agregar("verificar_abono", { abono_id: Number(id) }, { desc: `Abono ${id} visto en el banco · ${CLI.nombre}` });
      toast("Anotado. Se envía al volver la conexión.");
      pintarCuentaCliente(); pintarBandaRed();
      return;
    }
    if (v) {
      const { error } = await db.rpc("verificar_abono", { p_id: Number(v.dataset.verificarAbono) });
      if (error) return toast(errTxt(error), true);
      toast("Abono marcado como recibido"); await recargarCliente(); contarPorVerificar();
    }
    if (a) {
      const motivo = await pedirTexto("¿Por qué se anula este abono? (vuelve a quedar como deuda)", "");
      if (motivo === null) return;
      if (motivo.trim().length < 5) return toast("Escriba el motivo (al menos 5 letras).", true);
      const { error } = await db.rpc("anular_abono", { p_id: Number(a.dataset.anularAbono), p_motivo: motivo.trim() });
      if (error) return toast(errTxt(error), true);
      toast("Abono anulado"); await recargarCliente(); cargarVentas();
    }
  });
  $("#btnCobrarCredito").addEventListener("click", () => {
    const c = CLI, tel = U.soloDigitos(c.telefono), num = U.soloDigitos(ajustesCache.sinpe_numero);
    if (tel.length < 8) return toast("El cliente no tiene teléfono.", true);
    if (!(Number(c.saldo) > 0)) return toast("Este cliente no debe nada.", true);
    const pend = cliVentas.filter((p) => p.total - p.pagado_registrado > 0).sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
    const msg = [
      `¡Hola, ${c.nombre}! Le saludamos de ${C.NEGOCIO}.`,
      `Su saldo de crédito es de ${fmt(c.saldo)}${Number(c.vencido) > 0 ? `, de los cuales ${fmt(c.vencido)} ya están vencidos` : ""}.`,
      "",
      ...pend.map((p) => `• ${p.saldo_inicial ? `Saldo anterior${docMoriah(p) ? ` (doc. ${docMoriah(p)})` : ""}` : p.codigo} — ${fmt(p.total - p.pagado_registrado)} (vence ${fechaCorta(p.vence)})`),
      num.length === 8 ? "" : null,
      num.length === 8 ? `Puede abonar por SINPE Móvil al ${num.slice(0, 4)}-${num.slice(4)}${ajustesCache.sinpe_titular ? ` a nombre de ${ajustesCache.sinpe_titular}` : ""} y enviarnos el comprobante por aquí.` : null,
      "¡Muchas gracias!"
    ].filter((l) => l !== null).join("\n");
    const w = window.open(`https://wa.me/${tel.length === 8 ? "506" + tel : tel}?text=${encodeURIComponent(msg)}`, "_blank");
    if (w) w.opener = null;
  });

  // ---------- saldos de crédito que vienen de Moriah (v18) ----------
  // el número de documento de Moriah (si al pasarlo no traía documento, la referencia es "vence monto" y no se muestra)
  const docMoriah = (p) => (p.ref_anterior && !/^\d{4}-\d{2}-\d{2} [\d.]+$/.test(p.ref_anterior) ? p.ref_anterior : "");
  let SALDOS = [], saldoCli = null;
  // fecha de una celda: número de Excel, 25/11/2026, 25-11-26 o 2026-11-25
  function leerFecha(v) {
    const t = String(v ?? "").trim();
    if (!t) return "";
    let a, m, d;
    if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 864e5).toISOString().slice(0, 10);
    let x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (x) [, a, m, d] = x;
    else if ((x = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/))) { [, d, m, a] = x; if (a.length === 2) a = "20" + a; }
    else return null;
    const iso = `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const f = new Date(iso + "T12:00:00Z");
    return Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== iso || a < 2000 || a > 2100 ? null : iso;
  }
  // columnas del reporte de cuentas por cobrar: para cada dato, los títulos posibles en orden de preferencia
  const COLS_SALDO = [
    ["vence", "Vence", [/venc/]],
    ["monto", "Saldo", [/^saldo$/, /^saldo (actual|pendiente|total)/, /saldo/, /pendiente/, /por cobrar/, /^debe$/, /^monto$/, /monto/, /^total$/]],
    ["nombre", "Cliente", [/^nombre/, /^cliente$/, /^(nombre del |razon social|deudor)/, /nombre/, /^(?!cod).*cliente/]],
    ["identificacion", "Cédula", [/cedula/, /identificacion/, /^ident/, /^ced/]],
    ["telefono", "Teléfono", [/telefono/, /celular/, /^tel/]],
    ["documento", "Documento", [/^documento/, /^factura/, /^(n|no|nro|num)[.°º]? ?(doc|factura)/, /^doc/, /consecutivo/, /comprobante/, /^numero$/, /^(n|no|nro|num)[.°º]?$/]],
    ["fecha", "Fecha", [/^fecha$/, /^fecha (de )?(doc|fact|emision)/, /^emision/, /^fecha/]],
    ["limite", "Límite", [/limite/]],
    ["plazo_dias", "Plazo", [/^plazo/, /dias (de )?credito/]]
  ];
  // cédula que Hacienda aceptaría: física 9 dígitos, jurídica 10 (empieza con 3), DIMEX 11 o 12 (empieza con 1)
  const cedulaValida = (c) => { c = U.soloDigitos(c); return /^[1-9]\d{8}$/.test(c) || /^3\d{9}$/.test(c) || /^1\d{10,11}$/.test(c) ? c : ""; };
  // Moriah: hoja 1 = Referencia, Nombre, Límite, Saldo, Plazo, Teléfono…; cada otra hoja (con el nombre = Referencia) = Fecha, Documento, Monto, Saldo
  function listadoMoriah(hojas) {
    if (hojas.length < 2) return null;
    const cab = (h) => (h.filas[0]?.celdas || []).map((c) => norm(c));
    const c0 = cab(hojas[0]), ix = (re) => c0.findIndex((h) => re.test(h || ""));
    const iRef = ix(/^referencia$/), iNom = ix(/^nombre$/), iSal = ix(/^saldo$/), iLim = ix(/^limite/), iPla = ix(/^plazo/), iTel = ix(/^telefono/);
    if (iRef < 0 || iNom < 0 || iSal < 0) return null;
    const detalle = new Map();
    for (const h of hojas.slice(1)) {
      const c = cab(h);
      if (c[0] !== "fecha" || !c.includes("saldo")) continue;
      detalle.set(String(h.nombre).trim(), h.filas.slice(1).map((f) => ({ fecha: String(f.celdas[0] ?? "").trim(), doc: String(f.celdas[1] ?? "").trim(), saldo: Number(f.celdas[c.indexOf("saldo")]) || 0 })));
    }
    if (!detalle.size) return null;
    const isoDe = (t) => /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : leerFecha(t) || null;
    const out = { filas: [], clientes: 0, conSaldo: 0, sinCedula: 0, difieren: 0 };
    for (const f of hojas[0].filas.slice(1)) {
      const v = (i) => (i < 0 ? "" : String(f.celdas[i] ?? "").trim());
      const nombre = v(iNom).replace(/\s+/g, " ").slice(0, 80);
      if (!nombre) continue;
      out.clientes++;
      const saldo = Math.round((Number(v(iSal)) || 0) * 100) / 100;
      if (saldo < 1) continue;                     // céntimos que quedaron de redondeos en Moriah
      out.conSaldo++;
      const ref = v(iRef), ced = cedulaValida(ref);
      if (!ced) out.sinCedula++;
      const docs = (detalle.get(ref) || []).filter((d) => d.saldo > 0.005);
      const suma = docs.reduce((a, d) => a + d.saldo, 0);
      if (docs.length && Math.abs(suma - saldo) > 1) out.difieren++;
      const fechas = docs.map((d) => isoDe(d.fecha)).filter(Boolean).sort();
      const r = { fila: f.r, nombre, identificacion: ced, telefono: v(iTel), monto: String(saldo), error: "",
        documento: docs.length === 1 ? docs[0].doc.slice(0, 40) : docs.length ? `Moriah: ${docs.length} facturas` : "Saldo de Moriah" };
      if (fechas[0]) r.fecha = fechas[0];
      const lim = Number(v(iLim)); if (lim > 0) r.limite = String(lim);
      const pl = parseInt(v(iPla), 10); if (pl >= 1 && pl <= 365) r.plazo_dias = String(pl);
      out.filas.push(r);
    }
    return out.filas.length ? out : null;
  }
  function mapaSaldos(cab) {
    const usados = new Set(), mapa = {};
    for (const [k, , res] of COLS_SALDO) {
      for (const re of res) {
        const i = cab.findIndex((h, n) => h && !usados.has(n) && re.test(h));
        if (i >= 0) { mapa[k] = i; usados.add(i); break; }
      }
    }
    return mapa;
  }
  const clienteDeSaldo = (r) => {
    if (r.cliente_id) return clientes.find((c) => c.id === r.cliente_id) || null;
    const ced = U.soloDigitos(r.identificacion);
    return (ced && clientes.find((c) => U.soloDigitos(c.identificacion) === ced)) || clientes.find((c) => norm(c.nombre) === norm(r.nombre)) || null;
  };
  function pintarSaldos() {
    const ok = SALDOS.filter((r) => !r.error), malas = SALDOS.length - ok.length;
    const total = ok.reduce((t, r) => t + Number(r.monto), 0);
    const nuevos = new Set(ok.filter((r) => !clienteDeSaldo(r)).map((r) => U.soloDigitos(r.identificacion) || norm(r.nombre))).size;
    const cuantos = new Set(ok.map((r) => clienteDeSaldo(r)?.id || U.soloDigitos(r.identificacion) || norm(r.nombre))).size;
    $("#saldosVista").hidden = !SALDOS.length;
    $("#saldosFilas").innerHTML = SALDOS.slice(0, 400).map((r, n) => {
      const c = clienteDeSaldo(r);
      return `<tr class="${r.error ? "imp--error" : ""}">
        <td>${U.esc(r.fila)}</td>
        <td>${U.esc(r.nombre || "")}${r.identificacion ? `<small class="imp__cod">${U.esc(r.identificacion)}</small>` : ""}</td>
        <td>${U.esc(r.documento || "")}</td>
        <td>${r.vence ? U.esc(fechaCorta(r.vence)) : '<small class="imp__cod">según el plazo</small>'}</td>
        <td class="num">${r.error && !(Number(r.monto) > 0) ? "" : fmt(r.monto)}</td>
        <td>${r.error ? `<b>No se pasa:</b> ${U.esc(r.error)}` : c ? `Se suma a la cuenta de ${U.esc(c.nombre)}` : "Cliente nuevo"}</td>
        <td><button type="button" class="cerrar-x" data-quitar-saldo="${n}" aria-label="Quitar de la lista">✕</button></td>
      </tr>`;
    }).join("") + (SALDOS.length > 400 ? `<tr><td colspan="7" class="vacio-adm">… y ${SALDOS.length - 400} filas más</td></tr>` : "");
    const b = $("#btnPasarSaldos");
    b.disabled = !ok.length;
    b.textContent = ok.length ? `Pasar ${ok.length} ${ok.length === 1 ? "saldo" : "saldos"} (${fmt(total)})` : "Pasar saldos";
    if (SALDOS.length && !$("#saldosMsg").classList.contains("msg--fijo")) {
      $("#saldosMsg").className = "msg";
      $("#saldosMsg").textContent = `${ok.length} ${ok.length === 1 ? "saldo listo" : "saldos listos"} por ${fmt(total)}, de ${cuantos} ${cuantos === 1 ? "cliente" : "clientes"}${nuevos ? ` (${nuevos} ${nuevos === 1 ? "nuevo" : "nuevos"})` : ""}.${malas ? ` ${malas} con problemas no se pasan.` : ""}`;
    }
  }
  $("#btnSaldosMoriah").addEventListener("click", async () => {
    SALDOS = []; saldoCli = null;
    $("#saldosArchivo").value = ""; $("#formSaldoManual").reset(); $("#saldoManualMsg").textContent = "";
    $("#saldoCliElegido").hidden = true; $("#boxSaldoManual").open = false;
    $("#saldosMsg").className = "msg"; $("#saldosMsg").textContent = "";
    pintarSaldos();
    $("#dlgSaldos").showModal();
    if (!clientes.length) { await cargarClientes(); pintarSaldos(); }
  });
  $("#btnCerrarSaldos").addEventListener("click", () => $("#dlgSaldos").close());
  $("#saldosFilas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quitar-saldo]"); if (!b) return;
    SALDOS.splice(Number(b.dataset.quitarSaldo), 1);
    $("#saldosMsg").classList.remove("msg--fijo");
    pintarSaldos();
  });
  $("#saldosArchivo").addEventListener("change", async () => {
    const msg = $("#saldosMsg"), file = $("#saldosArchivo").files[0];
    if (!file) return;
    msg.className = "msg"; msg.textContent = "Leyendo archivo…";
    try {
      // el "Listado de clientes de crédito" de Moriah trae un resumen y una hoja con las facturas de cada cliente
      const hojas = await XlsxMini.leerHojas(file);
      const moriah = listadoMoriah(hojas);
      if (moriah) {
        SALDOS = SALDOS.filter((r) => r.fila === "a mano").concat(moriah.filas);
        msg.classList.remove("msg--fijo");
        pintarSaldos();
        msg.textContent += ` Listado de clientes de crédito de Moriah: ${moriah.conSaldo} con saldo (de ${moriah.clientes}).`
          + (moriah.sinCedula ? ` ${moriah.sinCedula} sin cédula válida (se pasan sin cédula).` : "")
          + (moriah.difieren ? ` En ${moriah.difieren} las facturas no suman lo mismo que el saldo: se usó el saldo del resumen (revíselos con don Roberto).` : "")
          + " El vencimiento se calcula desde la factura más vieja con el plazo de cada cliente.";
        return;
      }
      const filas = hojas[0].filas;
      // los títulos: la primera fila (de las primeras 25) que tenga cliente y saldo
      let iCab = -1, mapa = null;
      for (let i = 0; i < Math.min(25, filas.length); i++) {
        const m = mapaSaldos(filas[i].celdas.map((c) => norm(c)));
        if (m.nombre !== undefined && m.monto !== undefined) { iCab = i; mapa = m; break; }
      }
      if (iCab < 0) throw new Error("No se encontraron las columnas del cliente y del saldo. Revise que el archivo tenga títulos como “Cliente” y “Saldo”.");
      const val = (f, k) => (mapa[k] === undefined ? "" : String(f.celdas[mapa[k]] ?? "").trim());
      const leidas = [];
      let ultimo = null, enCero = 0;
      for (const f of filas.slice(iCab + 1)) {
        if (Object.keys(mapa).every((k) => val(f, k) === "")) continue;                       // fila vacía
        let nombre = val(f, "nombre").replace(/\s+/g, " ").replace(/^\d{1,8}\s*[-–:]\s*/, "").slice(0, 80);   // "001 - JUAN PÉREZ" → "JUAN PÉREZ"
        const documento = val(f, "documento").slice(0, 40), fechaTxt = val(f, "fecha"), venceTxt = val(f, "vence");
        if (/^(sub)?total|^gran total|^saldo total/.test(norm(nombre))) continue;               // totales del reporte
        if (!nombre) {
          // reporte agrupado por cliente: las facturas vienen debajo del nombre; sin documento ni fechas es un subtotal
          if (!ultimo || (!documento && !fechaTxt && !venceTxt)) continue;
          nombre = ultimo.nombre;
        }
        const r = { fila: f.r, nombre, identificacion: U.soloDigitos(val(f, "identificacion")) || (nombre === ultimo?.nombre ? ultimo.identificacion : ""),
          telefono: val(f, "telefono") || (nombre === ultimo?.nombre ? ultimo.telefono : ""), documento, error: "" };
        ultimo = r;
        const crudo = val(f, "monto");
        if (/^[(-]/.test(crudo)) r.error = "Es saldo a favor del cliente (negativo).";
        else {
          const m = leerPrecio(crudo);
          if (m.error || m.v === "") r.error = `Saldo no válido: ${crudo || "vacío"}`;
          else if (Number(m.v) <= 0) { enCero++; continue; }                                     // factura ya pagada
          else r.monto = m.v;
        }
        const fe = leerFecha(fechaTxt), ve = leerFecha(venceTxt);
        if (fe) r.fecha = fe;
        if (ve) r.vence = ve;
        if (ve === null && !r.error) r.error = `No se entiende la fecha de vencimiento: ${venceTxt}`;
        if (r.nombre.length < 2 && !r.error) r.error = "Falta el nombre del cliente.";
        const lim = mapa.limite !== undefined ? leerPrecio(val(f, "limite")) : null;
        if (lim && !lim.error && Number(lim.v) > 0) r.limite = lim.v;
        const plazo = parseInt(val(f, "plazo_dias"), 10);
        if (plazo >= 1 && plazo <= 365) r.plazo_dias = String(plazo);
        leidas.push(r);
      }
      if (!leidas.length) throw new Error(enCero ? "Todas las filas del archivo tienen saldo en cero: no hay nada que pasar." : "El archivo no trae saldos debajo de los títulos.");
      SALDOS = SALDOS.filter((r) => r.fila === "a mano").concat(leidas);
      msg.classList.remove("msg--fijo");
      pintarSaldos();
      const cols = ["nombre", "identificacion", "telefono", "documento", "fecha", "vence", "monto", "limite", "plazo_dias"]
        .filter((k) => mapa[k] !== undefined).map((k) => COLS_SALDO.find((c) => c[0] === k)[1]).join(", ");
      msg.textContent += ` Columnas: ${cols}.${enCero ? ` ${enCero} ${enCero === 1 ? "fila con saldo en cero se dejó" : "filas con saldo en cero se dejaron"} por fuera.` : ""}${mapa.vence === undefined ? " El archivo no trae vencimiento: se calcula con el plazo de cada cliente." : ""}`;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    }
  });
  // a mano: si ya es cliente de crédito se escoge de la lista; si no, se crea al pasar el saldo
  buscadorClientes($("#formSaldoManual").nombre, $("#saldoCliRes"), (c) => {
    const f = $("#formSaldoManual");
    saldoCli = c;
    f.nombre.value = c.nombre;
    f.identificacion.value = c.identificacion || ""; f.telefono.value = c.telefono || "";
    $("#saldoCliElegido").hidden = false;
    $("#saldoCliElegido").innerHTML = `Se suma a la cuenta de <b>${U.esc(c.nombre)}</b>, que ahora debe ${fmt(c.saldo)}.`;
    f.monto.focus();
  }, "No es cliente de crédito todavía: se crea al pasar el saldo.");
  $("#formSaldoManual").nombre.addEventListener("input", () => { if (saldoCli) { saldoCli = null; $("#saldoCliElegido").hidden = true; } });
  $("#formSaldoManual").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#saldoManualMsg");
    const r = { fila: "a mano", nombre: f.nombre.value.trim().replace(/\s+/g, " "), identificacion: U.soloDigitos(f.identificacion.value), telefono: f.telefono.value.trim(),
      documento: f.documento.value.trim(), fecha: f.fecha.value || undefined, vence: f.vence.value || undefined, error: "" };
    if (saldoCli) r.cliente_id = saldoCli.id;
    const m = leerPrecio(f.monto.value);
    if (r.nombre.length < 2) { msg.textContent = "Escriba el nombre del cliente."; f.nombre.focus(); return; }
    if (r.identificacion && !/^\d{9,12}$/.test(r.identificacion)) { msg.textContent = "La cédula lleva de 9 a 12 números (o déjela vacía)."; return; }
    if (r.telefono && !/^[0-9 +()-]{8,20}$/.test(r.telefono)) { msg.textContent = "Revise el teléfono."; return; }
    if (m.error || !(Number(m.v) > 0)) { msg.textContent = "Escriba el saldo que debe."; f.monto.focus(); return; }
    if (r.fecha && r.fecha > hoyCR()) { msg.textContent = "La fecha de la factura no puede ser después de hoy."; return; }
    r.monto = m.v;
    msg.textContent = "";
    SALDOS.unshift(r);
    $("#saldosMsg").classList.remove("msg--fijo");
    pintarSaldos();
    f.reset(); saldoCli = null; $("#saldoCliElegido").hidden = true;
    toast(`Agregado: ${r.nombre}, ${fmt(r.monto)}. Toque “Pasar saldos” cuando termine.`);
    f.nombre.focus();
  });
  $("#btnPasarSaldos").addEventListener("click", async () => {
    const lista = SALDOS.filter((r) => !r.error), b = $("#btnPasarSaldos"), msg = $("#saldosMsg");
    if (!lista.length) return;
    const total = lista.reduce((t, r) => t + Number(r.monto), 0);
    if (!await preguntar(`¿Pasar ${lista.length} ${lista.length === 1 ? "saldo" : "saldos"} por ${fmt(total)}? Quedan como deudas a crédito en la cuenta de cada cliente.`)) return;
    b.disabled = true;
    const tot = { creados: 0, repetidos: 0, clientes_nuevos: 0 }, fallas = [];
    const pasadas = new Set();
    try {
      for (let i = 0; i < lista.length; i += 300) {
        const parte = lista.slice(i, i + 300);
        msg.className = "msg"; msg.textContent = `Pasando… ${Math.min(i + 300, lista.length)} de ${lista.length}`;
        const { data, error } = await db.rpc("importar_saldos_anteriores", { p_filas: parte.map(({ fila, error, ...r }) => r) });
        if (error) throw error;
        tot.creados += data.creados; tot.repetidos += data.repetidos; tot.clientes_nuevos += data.clientes_nuevos;
        const malas = new Map((data.errores || []).map((x) => [x.fila - 1, x.error]));
        parte.forEach((r, n) => { if (malas.has(n)) { r.error = malas.get(n); fallas.push(r); } else pasadas.add(r); });
      }
    } catch (e) {
      msg.className = "msg msg--error";
      msg.textContent = `${tot.creados ? `Se pasaron ${tot.creados} saldos, pero se detuvo: ` : ""}${errTxt(e)}`;
      SALDOS = SALDOS.filter((r) => !pasadas.has(r));
      pintarSaldos(); b.disabled = false;
      await cargarClientes(); pintarClientes();
      return;
    }
    SALDOS = fallas;                                   // en la lista quedan solo los que no se pudieron pasar
    msg.className = "msg msg--fijo" + (fallas.length ? " msg--error" : "");
    msg.textContent = `Listo: ${tot.creados} ${tot.creados === 1 ? "saldo pasado" : "saldos pasados"}${tot.clientes_nuevos ? `, ${tot.clientes_nuevos} ${tot.clientes_nuevos === 1 ? "cliente nuevo" : "clientes nuevos"}` : ""}.`
      + (tot.repetidos ? ` ${tot.repetidos === 1 ? "1 ya se había pasado antes" : `${tot.repetidos} ya se habían pasado antes`} (no se repite${tot.repetidos === 1 ? "" : "n"}).` : "")
      + (fallas.length ? ` ${fallas.length === 1 ? "1 no se pudo pasar: está" : `${fallas.length} no se pudieron pasar: están`} en la lista con el motivo.` : "");
    pintarSaldos();
    b.disabled = !fallas.length;
    toast(`${tot.creados} saldos de Moriah pasados`);
    await cargarClientes(); pintarClientes();
  });

  // ---------- facturación electrónica (función "facturar") ----------
  const FE_TIPO = { "01": "Factura electrónica", "03": "Nota de crédito", "04": "Tiquete electrónico", "08": "Factura de compra" };
  const FE_ESTADO = {
    firmado: ["Sin enviar", "etq--error"], enviado: ["Enviado a Hacienda", "etq--por_verificar"], procesando: ["Hacienda lo está revisando", "etq--por_verificar"],
    aceptado: ["Aceptado por Hacienda", "etq--pagado"], rechazado: ["Rechazado por Hacienda", "etq--error"], error: ["Con error", "etq--error"],
    sin_internet: ["Hecho sin internet: se envía a Hacienda al volver la conexión", "etq--por_verificar"]
  };
  async function llamarFE(cuerpo) {
    const { data, error } = await db.functions.invoke("facturar", { body: cuerpo });
    if (error) {
      let m = "";
      try { m = (await error.context.json()).error; } catch { /* sin detalle */ }
      if (!m && (U.esErrorRed(error) || error.name === "FunctionsFetchError" || /failed to send/i.test(error.message || ""))) m = "Sin internet: no se pudo hablar con Hacienda.";
      throw new Error(m || "No se pudo usar la facturación. ¿Está publicada la función “facturar” en Supabase?");
    }
    if (!data?.ok) throw new Error(data?.error || "No se pudo completar.");
    return data;
  }
  function feVigente() {
    return (V.fe || []).find((d) => ["01", "04"].includes(d.tipo) && d.estado !== "rechazado" && !d.anulado && d.ambiente === FE?.ambiente)
      || fePendientes().map(docSinRed)[0];
  }
  function pintarFEVenta() {
    const docs = (V.fe || []).filter((d) => d.ambiente === FE?.ambiente).concat(fePendientes().map(docSinRed));
    $("#feDocs").innerHTML = docs.map((d) => {
      const [txt, cls] = FE_ESTADO[d.estado] || [d.estado, ""];
      const acc = [];
      if (["firmado", "error"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--negro" data-fe="enviar" data-id="${d.id}">Enviar de nuevo</button>`);
      if (["enviado", "procesando"].includes(d.estado)) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-fe="consultar" data-id="${d.id}">Consultar</button>`);
      if (d.estado === "aceptado" && d.tipo !== "03" && !d.anulado && puede("anular") && !(V.devs || []).length) acc.push(`<button type="button" class="enlace enlace--peligro" data-fe="anular" data-id="${d.id}">Anular con nota de crédito</button>`);
      if (!d.sinRed && enLinea()) acc.push(`<button type="button" class="enlace" data-fe="xml" data-id="${d.id}">XML</button>`);
      if (d.sinRed) acc.push(`<button type="button" class="enlace" data-fe="pendientes">Ver pendientes</button>`);
      return `<li class="pago fe-doc ${d.anulado ? "pago--anulado" : ""}">
        <div class="pago__monto">${d.tipo === "03" ? "−" : ""}${fmt(d.total)}${d.parcial ? "<small>Nota de crédito</small><small>por devolución</small>" : `<small>${FE_TIPO[d.tipo] || d.tipo}</small>`}</div>
        <div class="pago__datos">
          <span>N.º <b>${U.esc(d.consecutivo.slice(-10).replace(/^0+/, ""))}</b> · ${fechaCR(d.fecha_emision, { dateStyle: "short", timeStyle: "short" })}${d.sinRed || String(d.clave).charAt(41) === "3" ? " · sin internet" : ""}</span>
          <span><span class="etq ${cls}">${txt}</span>${d.anulado ? ' <span class="etq">Anulado</span>' : ""}${d.ambiente === "pruebas" ? ' <span class="etq">Pruebas</span>' : ""}</span>
          ${d.detalle ? `<span>${U.esc(d.detalle)}</span>` : ""}
          <span class="fe-doc__clave">Clave ${U.esc(d.clave)}</span>
        </div>
        <div class="pago__acc">${acc.join("")}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">Esta venta todavía no tiene comprobante electrónico.</li>`;
    const vig = feVigente(), anulada = V.pedido?.estado === "anulada";
    $("#feEmitir").hidden = !!vig || anulada;
    $("#btnFEFactura").disabled = false;
    // sin internet el comprobante se hace aquí con su clave y se firma y manda al volver la señal
    const sr = !enLinea() || !!V.local;
    $("#btnFETiquete").textContent = sr ? "Hacer tiquete sin internet" : "Emitir tiquete";
    $("#btnFETiquete").hidden = !!V.exo;          // con exoneración solo factura
    $("#btnFEFactura").textContent = sr ? "Hacer factura sin internet" : "Emitir factura";
    $("#feSinRedInfo").hidden = !sr;
    if (sr) {
      const st = feRed(), q = st?.ambiente === FE?.ambiente ? quedanFE(st, "04") : 0;
      $("#feSinRedInfo").textContent = !V19 ? "Para hacer comprobantes sin internet falta correr supabase/v19_sin_internet.sql."
        : q ? `Sin internet: el comprobante sale con su clave (situación “sin internet”) y se manda a Hacienda solo al volver la conexión. A esta compu le quedan ${q} números para tiquetes.`
        : "Esta compu todavía no tiene números para facturar sin internet: se apartan solos la próxima vez que entre con internet.";
    }
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
      return d;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
      return null;
    } finally {
      botones.forEach((b) => (b.disabled = false));
      pintarFEVenta();
    }
  }
  // venta a crédito: el comprobante sale con condición crédito y el plazo hasta el vencimiento
  const plazoFE = () => (V.pedido?.credito && V.pedido.vence ? { credito_dias: Math.max(1, diasEntre(String(V.pedido.created_at).slice(0, 10), V.pedido.vence)) } : {});
  $("#btnFETiquete").addEventListener("click", async () => {
    if (V.exo) { $("#feMsg").className = "msg msg--error"; $("#feMsg").textContent = "Esta venta tiene exoneración: se emite factura con la cédula del exonerado."; return; }
    if (!enLinea() || V.local) return hacerFESinRed("04");
    if (V.dirty) return accionFE({}, "");
    if (!(await asegurarCabys(V.items))) return;
    accionFE({ accion: "emitir", pedido_id: V.pedido.id, tipo: "04", ...plazoFE() }, "Firmando y enviando el tiquete a Hacienda…");
  });
  $("#btnFEFactura").addEventListener("click", async () => {
    if (V.dirty && !V.local) return accionFE({}, "");
    if ((!enLinea() || V.local) && V.factura) return hacerFESinRed("01");
    abrirReceptor();
  });

  // ---------- exoneración de IVA (EXONET) ----------
  // Se aplica en la venta (antes de cobrar): los productos que cubre se cobran con el IVA rebajado
  // sin lista de CABYS la autorización cubre todo; con lista, solo esos
  const exoCubre = (exo, prod) => !!exo && !!prod && (!Array.isArray(exo.cabys) || !exo.cabys.length || (!!prod.cabys && exo.cabys.includes(prod.cabys)));
  // precio del catálogo que le toca a este cliente: precio 2 si es su tipo, menos su descuento general
  function precioDelCliente(prod, precio) {
    const c = V?.cond === "credito" ? V?.credCli : null;
    if (!V24 || !c || precio == null) return precio;
    let x = Number(precio);
    if (Number(c.tipo_precio) === 2 && prod?.precio2 != null) x = Math.min(x, Number(prod.precio2));
    if (Number(c.descuento) > 0) x = x * (1 - Number(c.descuento) / 100);
    return r2(x);
  }
  // precio final del renglón: el del cliente y, si hay exoneración, con el IVA rebajado
  const precioVenta = (prod, precio) => precioConExo(prod, precioDelCliente(prod, precio));
  function precioConExo(prod, precio) {
    const exo = V?.exo, t = TARIFA_PCT[prod?.iva_codigo || "08"] ?? 13;
    if (!exoCubre(exo, prod) || !(t > 0)) return precio;
    const pts = Math.min(Number(exo.porcentaje), t);
    return r2(precio / (1 + t / 100) * (1 + (t - pts) / 100));
  }
  // vuelve a poner los precios del catálogo y, si hay exoneración, rebaja el IVA de lo que cubre
  function aplicarExoPrecios() {
    for (const it of V.items) {
      const prod = prodDe(it.producto_id); if (!prod) continue;
      const cat = precioCatalogo(prod.id); if (cat == null) continue;
      it.precio_unit = precioVenta(prod, cat);
    }
    V.dirty = true;
  }
  function pintarExo() {
    const p = V.pedido, box = $("#boxExo"), exo = V.exo === undefined ? (V.exo = p?.exoneracion || null) : V.exo;
    box.hidden = !V22 || !V10 || !FE?.activo || !!V.copia || !!V.local || p?.estado === "anulada" || (!exo && !itemsEditables());
    if (box.hidden) return;
    $("#btnExo").hidden = !!exo || !itemsEditables();
    const exCli = V.cond === "credito" ? V.credCli?.exoneracion : null;
    $("#btnExo").textContent = exCli?.numero && exCli.vence >= hoyCR() ? `Usar la exoneración del cliente (${exCli.numero})…` : "Cliente exonerado…";
    const banda = $("#exoBanda");
    banda.hidden = !exo;
    if (!exo) return;
    const conCat = V.items.filter((i) => prodDe(i.producto_id));
    const cubiertos = conCat.filter((i) => exoCubre(exo, prodDe(i.producto_id))).length;
    const vencida = exo.vence < hoyCR();
    banda.innerHTML = `<b>Exoneración ${U.esc(exo.numero)}</b> · ${String(exo.porcentaje).replace(".", ",")} puntos de IVA · vence ${U.esc(fechaLarga(exo.vence))}${vencida ? ' <span class="etq etq--error">Vencida</span>' : ""}`
      + `<br><small>${conCat.length ? `Cubre ${cubiertos} de ${conCat.length} ${conCat.length === 1 ? "producto" : "productos"}` : "Agregue los productos"}${exo.identificacion ? ` · la factura sale a la cédula ${U.esc(exo.identificacion)}` : ""} · solo factura, no tiquete</small>`
      + (itemsEditables() ? ` <button type="button" class="enlace enlace--peligro" id="btnExoQuitar">Quitar</button>` : "");
  }
  $("#boxExo").addEventListener("click", async (e) => {
    if (e.target.closest("#btnExo")) return abrirExo();
    if (e.target.closest("#btnExoQuitar")) {
      if (!await preguntar("Se quita la exoneración y los productos vuelven a su precio con IVA completo.", { titulo: "¿Quitar la exoneración?", si: "Quitar", peligro: true })) return;
      V.exo = null; V.exoCambio = true; aplicarExoPrecios(); pintarVenta();
    }
  });
  let EXO_NUEVA = null;
  function abrirExo() {
    const f = $("#formExo"); f.reset(); EXO_NUEVA = null;
    $("#exoRes").hidden = true; $("#exoMsg").textContent = ""; $("#btnExoAplicar").disabled = true;
    $("#dlgExo").showModal(); f.numero.focus();
    // la del cliente de crédito se vuelve a consultar en Hacienda (pudo cambiar o vencer)
    const exCli = V.cond === "credito" ? V.credCli?.exoneracion : null;
    if (exCli?.numero) { f.numero.value = exCli.numero; f.requestSubmit(); }
  }
  $("#formExo").numero.addEventListener("input", (e) => {
    // "al00012345 24" → "AL-00012345-24"
    const d = e.target.value.toUpperCase().replace(/[^0-9]/g, "");
    if (d.length === 10 && !/^AL-/.test(e.target.value.toUpperCase())) e.target.value = `AL-${d.slice(0, 8)}-${d.slice(8)}`;
    EXO_NUEVA = null; $("#btnExoAplicar").disabled = true;
  });
  $("#formExo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#exoMsg"), res = $("#exoRes"), btn = $("#btnExoConsultar");
    const numero = f.numero.value.trim().toUpperCase().replace(/\s+/g, "");
    msg.textContent = ""; res.hidden = true; EXO_NUEVA = null; $("#btnExoAplicar").disabled = true;
    if (!/^AL-\d{8}-\d{2}$/.test(numero)) { msg.textContent = "El número va así: AL-00012345-24."; f.numero.focus(); return; }
    if (!enLinea()) { msg.textContent = "Sin internet no se puede consultar la exoneración en Hacienda."; return; }
    btn.disabled = true; btn.textContent = "Consultando…";
    try {
      const r = await llamarFE({ accion: "exoneracion", numero });
      if (!r.encontrado) { msg.textContent = `Hacienda no tiene la autorización ${numero}. Revise el número con el cliente.`; return; }
      // el porcentaje va en puntos de IVA (13 = todo); si viniera como % del impuesto (100), se pasa a puntos
      let pts = Number(r.porcentaje) || 0;
      if (pts > 13) pts = r2(13 * Math.min(pts, 100) / 100);
      const exo = { numero: r.numero || numero, tipo: r.tipo, institucion: r.institucion, institucion_otro: r.institucion === "99" ? (r.institucion_nombre || null) : null,
        identificacion: r.identificacion || "", porcentaje: pts, fecha_emision: r.fecha_emision, vence: r.vence,
        cabys: r.posee_cabys && r.cabys?.length ? r.cabys : null, tipo_desc: r.tipo_desc || "", institucion_nombre: r.institucion_nombre || "" };
      const problemas = [];
      if (!(pts > 0)) problemas.push("Hacienda no indica el porcentaje exonerado.");
      if (!exo.vence) problemas.push("Hacienda no indica la fecha de vencimiento.");
      else if (exo.vence < hoyCR()) problemas.push(`Venció el ${fechaLarga(exo.vence)}: ya no se puede usar.`);
      if (!exo.fecha_emision) problemas.push("Hacienda no indica la fecha de emisión.");
      const conCat = V.items.filter((i) => prodDe(i.producto_id));
      const fuera = conCat.filter((i) => !exoCubre(exo, prodDe(i.producto_id)));
      res.innerHTML = `<dl class="exo-datos">
          <dt>Tipo</dt><dd>${U.esc(exo.tipo)}${exo.tipo_desc ? ` · ${U.esc(exo.tipo_desc)}` : ""}</dd>
          <dt>Institución</dt><dd>${U.esc(exo.institucion_nombre || exo.institucion)}</dd>
          ${exo.identificacion ? `<dt>Cédula</dt><dd>${U.esc(exo.identificacion)}</dd>` : ""}
          <dt>Exonera</dt><dd><b>${String(pts).replace(".", ",")} puntos</b> del IVA${pts >= 13 ? " (todo el 13 %)" : ""}</dd>
          <dt>Vence</dt><dd>${exo.vence ? U.esc(fechaLarga(exo.vence)) : "—"}</dd>
          <dt>Productos</dt><dd>${exo.cabys ? `Solo ${exo.cabys.length} CABYS autorizados` : "Todos"}${conCat.length ? ` · de esta venta cubre ${conCat.length - fuera.length} de ${conCat.length}` : ""}</dd>
        </dl>`
        + (fuera.length ? `<p class="ayuda">No cubre: ${fuera.slice(0, 6).map((i) => U.esc(i.descripcion)).join(", ")}${fuera.length > 6 ? "…" : ""}. Esos se cobran con IVA completo.</p>` : "")
        + (problemas.length ? `<p class="msg msg--error">${problemas.map(U.esc).join(" ")}</p>` : "");
      res.hidden = false;
      if (!problemas.length) { EXO_NUEVA = exo; $("#btnExoAplicar").disabled = false; $("#btnExoAplicar").focus(); }
    } catch (err) { msg.textContent = errTxt(err); }
    finally { btn.disabled = false; btn.textContent = "Consultar"; }
  });
  $("#btnExoAplicar").addEventListener("click", () => {
    if (!EXO_NUEVA) return;
    const { tipo_desc, institucion_nombre, ...exo } = EXO_NUEVA;
    V.exo = { ...exo, institucion_nombre }; V.exoCambio = true;
    aplicarExoPrecios();
    $("#dlgExo").close();
    pintarVenta();
    toast("Exoneración aplicada: los productos que cubre ya tienen el IVA rebajado.");
  });

  // ---------- devoluciones parciales ----------
  const ETQ_REINT = { efectivo: "en efectivo (sale de la caja)", sinpe: "por SINPE", transferencia: "por transferencia", tarjeta: "a la tarjeta" };
  const devueltoDe = (itemId) => (V.devs || []).reduce((a, d) => a + (d.devolucion_items || []).filter((x) => x.pedido_item_id === itemId).reduce((b, x) => b + Number(x.cantidad), 0), 0);
  function pintarDevoluciones() {
    const p = V.pedido, devs = V.devs || [];
    const quedan = V.items.some((i) => i.id && Number(i.cantidad) - devueltoDe(i.id) > 0.001);
    $("#btnDevolver").hidden = !V23 || !p || !!V.local || !!V.copia || p.estado === "anulada" || !puede("anular") || V.dirty || !quedan || !enLinea();
    $("#boxDevoluciones").hidden = !devs.length;
    $("#listaDevoluciones").innerHTML = devs.map((d) => {
      const nc = (V.fe || []).find((f) => f.id === d.fe_documento_id);
      const sinNc = !nc && FE?.activo && V10;
      return `<li class="pago">
        <div class="pago__monto">−${fmt(d.total)}<small>Devolución</small></div>
        <div class="pago__datos">
          <span>${fechaCR(d.fecha, { dateStyle: "short", timeStyle: "short" })} · ${U.esc(d.motivo)}</span>
          <span>${(d.devolucion_items || []).map((x) => `${cantTxt(x.cantidad)} × ${U.esc(x.descripcion)}`).join(", ")}</span>
          <span>${Number(d.reintegro) > 0 ? `Se le devolvieron ${fmt(d.reintegro)} ${ETQ_REINT[d.metodo] || ""}` : "Sin devolver plata (rebajó lo que debía)"}</span>
          ${nc ? `<span>Nota de crédito N.º ${U.esc(String(nc.consecutivo).slice(-10).replace(/^0+/, ""))} · ${U.esc((FE_ESTADO[nc.estado] || [nc.estado])[0])}</span>` : ""}
        </div>
        <div class="pago__acc">${sinNc && puede("anular") && enLinea() ? `<button type="button" class="btn btn--sm btn--negro" data-dev-nc="${d.id}">Hacer la nota de crédito</button>` : ""}</div>
      </li>`;
    }).join("");
  }
  $("#listaDevoluciones").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dev-nc]"); if (!b) return;
    b.disabled = true;
    try { await llamarFE({ accion: "devolucion", devolucion_id: Number(b.dataset.devNc) }); toast("Nota de crédito enviada a Hacienda."); }
    catch (err) { toast(errTxt(err), true); }
    await abrirVenta(V.pedido.id);
  });
  let DEV = null;
  function abrirDevolucion() {
    const f = $("#formDevolucion"); f.reset();
    DEV = { cant: new Map(), metodo: "efectivo" };
    $("#devMsg").textContent = "";
    const necesitaFE = V10 && FE?.activo;
    const vig = necesitaFE ? feVigente() : null;
    $("#devAyuda").textContent = necesitaFE
      ? (vig?.estado === "aceptado" ? "Escoja cuánto devuelve de cada producto. Vuelve al inventario, se hace la nota de crédito de lo devuelto y, si ya pagó, se le devuelve la plata."
        : "Primero hay que emitir el tiquete o la factura de esta venta (y que Hacienda lo acepte): la devolución sale en una nota de crédito.")
      : "Escoja cuánto devuelve de cada producto. Vuelve al inventario y, si ya pagó, se le devuelve la plata.";
    $("#devItems").innerHTML = V.items.map((i) => {
      const max = Math.round((Number(i.cantidad) - devueltoDe(i.id)) * 100) / 100;
      return `<tr data-dev-item="${i.id}">
        <td>${U.esc(i.descripcion)}<small class="stock-nota">${fmt(i.precio_unit)} c/u</small></td>
        <td class="num">${cantTxt(i.cantidad)}</td>
        <td class="num">${cantTxt(devueltoDe(i.id))}</td>
        <td class="num"><input type="number" min="0" max="${max}" step="${Number.isInteger(Number(i.cantidad)) ? 1 : 0.01}" value="0" ${max > 0 ? "" : "disabled"} aria-label="Cantidad que devuelve" /></td>
        <td class="num" data-dev-sub>₡0</td>
      </tr>`;
    }).join("");
    pintarDevTotal();
    $("#dlgDevolucion").showModal();
    $("#devItems input:not([disabled])")?.focus();
  }
  function devTotales() {
    let total = 0;
    for (const i of V.items) total += (DEV.cant.get(i.id) || 0) * Number(i.precio_unit);
    total = Math.round(total * 100) / 100;
    const p = V.pedido, nuevo = Math.max(0, Number(p.total) - total);
    const reint = Math.max(0, Math.min(total, Number(p.pagado_registrado) - nuevo));
    return { total, reint: Math.round(reint * 100) / 100 };
  }
  function pintarDevTotal() {
    const { total, reint } = devTotales();
    $("#devPlata").hidden = !(reint > 0);
    $("#devPlataTxt").innerHTML = reint > 0 ? `Se le devuelven <b>${fmt(reint)}</b>. ¿Cómo?` : "";
    $$("#devMetodos [data-metodo]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.metodo === DEV.metodo)));
    const btn = $("#btnDevGuardar");
    btn.disabled = !(total > 0);
    btn.textContent = total > 0 ? (reint > 0 ? `Devolver y entregar ${fmt(reint)}` : `Devolver ${fmt(total)}`) : "Devolver";
  }
  $("#devItems").addEventListener("input", (e) => {
    const tr = e.target.closest("[data-dev-item]"); if (!tr) return;
    const id = Number(tr.dataset.devItem), it = V.items.find((x) => x.id === id);
    const max = Number(e.target.max) || 0;
    let v = Number(e.target.value) || 0;
    if (v > max) { v = max; e.target.value = max; }
    if (v < 0) { v = 0; e.target.value = 0; }
    DEV.cant.set(id, v);
    tr.querySelector("[data-dev-sub]").textContent = fmt(v * Number(it.precio_unit));
    pintarDevTotal();
  });
  $("#devMetodos").addEventListener("click", (e) => { const b = e.target.closest("[data-metodo]"); if (!b) return; DEV.metodo = b.dataset.metodo; pintarDevTotal(); });
  $("#btnDevolver").addEventListener("click", abrirDevolucion);
  $("#formDevolucion").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#devMsg"), btn = $("#btnDevGuardar");
    const items = [...DEV.cant].filter(([, c]) => c > 0).map(([pedido_item_id, cantidad]) => ({ pedido_item_id, cantidad }));
    const motivo = f.motivo.value.trim();
    if (!items.length) { msg.textContent = "Escoja cuánto devuelve de algún producto."; return; }
    if (motivo.length < 3) { msg.textContent = "Escriba el motivo de la devolución."; f.motivo.focus(); return; }
    const { total, reint } = devTotales();
    if (!await preguntar(`Se devuelven ${fmt(total)} en productos y vuelven al inventario.` + (reint > 0 ? `\nSe le entregan ${fmt(reint)} ${ETQ_REINT[DEV.metodo]}.` : "\nNo se le devuelve plata: se rebaja de lo que debe.")
      + (V10 && FE?.activo ? "\nSe hace la nota de crédito de lo devuelto." : ""), { titulo: "¿Hacer la devolución?", si: "Devolver" })) return;
    btn.disabled = true; msg.textContent = "";
    try {
      const { data, error } = await db.rpc("registrar_devolucion", { p: { pedido_id: V.pedido.id, motivo, metodo: reint > 0 ? DEV.metodo : null, items } });
      if (error) throw error;
      $("#dlgDevolucion").close();
      if (data?.fe_documento_id) {
        toast("Devolución hecha. Haciendo la nota de crédito…");
        try { await llamarFE({ accion: "devolucion", devolucion_id: data.id }); toast("Devolución hecha y nota de crédito enviada a Hacienda."); }
        catch (err) { toast(`La devolución quedó hecha, pero la nota de crédito no: ${errTxt(err)}. Toque “Hacer la nota de crédito” en la venta.`, true); }
      } else toast(Number(data?.reintegro) > 0 ? `Devolución hecha. Entregue ${fmt(data.reintegro)} al cliente.` : "Devolución hecha.");
      await abrirVenta(V.pedido.id);
      cargarVentas(); refrescarExistencias(items.map((x) => V.items.find((i) => i.id === x.pedido_item_id)?.producto_id));
      if (!$("#tCaja").hidden) cargarCaja();
    } catch (err) { msg.textContent = errTxt(err); }
    finally { btn.disabled = false; }
  });

  // ---------- datos del cliente para la factura ----------
  const RE_ID = { fisica: /^[1-9][0-9]{8}$/, juridica: /^[0-9]{10}$/, dimex: /^[0-9]{11,12}$/, nite: /^[0-9]{10}$/ };
  let recepAuto = false;          // el nombre lo puso Hacienda (si cambia la cédula, se cambia)
  function abrirReceptor() {
    const f = $("#formReceptor"), fac = V.factura, cli = V.credCli;
    f.reset(); recepAuto = false;
    $("#recepMsg").textContent = ""; $("#recepBusca").textContent = ""; $("#recepBusca").className = "ayuda recep-busca";
    const nom = V.pedido?.cliente_nombre && V.pedido.cliente_nombre !== CLIENTE_CONTADO ? V.pedido.cliente_nombre : "";
    if (fac) { f.tipo_id.value = fac.tipo_id || "fisica"; f.identificacion.value = fac.identificacion || ""; f.nombre.value = fac.nombre || ""; f.correo.value = fac.correo || ""; }
    else if (cli) { f.tipo_id.value = cli.tipo_id || "fisica"; f.identificacion.value = cli.identificacion || ""; f.nombre.value = cli.nombre || nom; f.correo.value = cli.correo || ""; }
    else f.nombre.value = nom;
    // con exoneración la factura va a la cédula del exonerado
    if (V.exo?.identificacion && U.soloDigitos(f.identificacion.value) !== V.exo.identificacion) {
      f.identificacion.value = V.exo.identificacion; f.nombre.value = ""; f.identificacion.dispatchEvent(new Event("input"));
    }
    $("#dlgReceptor").showModal();
    (f.identificacion.value ? f.correo : f.identificacion).focus();
  }
  // tipo por la cantidad de dígitos y nombre desde el registro de Hacienda
  $("#formReceptor").identificacion.addEventListener("input", (e) => {
    const f = e.target.form, id = U.soloDigitos(e.target.value), info = $("#recepBusca");
    clearTimeout(abrirReceptor.t);
    if (id.length === 9) f.tipo_id.value = "fisica";
    else if (id.length === 10) f.tipo_id.value = id.startsWith("3") ? "juridica" : f.tipo_id.value === "nite" ? "nite" : "juridica";
    else if (id.length >= 11) f.tipo_id.value = "dimex";
    if (recepAuto) { f.nombre.value = ""; recepAuto = false; }
    info.textContent = ""; info.className = "ayuda recep-busca";
    if (id.length < 9 || !enLinea()) return;
    abrirReceptor.t = setTimeout(async () => {
      info.textContent = "Buscando en Hacienda…";
      try {
        const r = await llamarFE({ accion: "contribuyente", identificacion: id });
        if (U.soloDigitos(f.identificacion.value) !== id) return;
        if (r.encontrado) {
          if (!f.nombre.value.trim() || recepAuto) { f.nombre.value = r.nombre; recepAuto = true; }
          if (r.tipo_id) f.tipo_id.value = r.tipo_id;
          info.textContent = `Inscrito en Hacienda: ${r.nombre}`; info.className = "ayuda recep-busca recep-busca--ok";
          if (!f.correo.value) f.correo.focus();
        } else info.textContent = "No aparece inscrito en Hacienda. Escriba el nombre como sale en la cédula.";
      } catch { info.textContent = ""; }
    }, 450);
  });
  $("#formReceptor").nombre.addEventListener("input", () => { recepAuto = false; });
  $("#formReceptor").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#recepMsg"), btn = $("#btnRecepEmitir");
    const d = { tipo_id: f.tipo_id.value, identificacion: U.soloDigitos(f.identificacion.value), nombre: f.nombre.value.trim(), correo: f.correo.value.trim().toLowerCase() };
    if (!RE_ID[d.tipo_id].test(d.identificacion)) { msg.textContent = "Revise la cédula: física 9 dígitos, jurídica 10, DIMEX 11 o 12."; f.identificacion.focus(); return; }
    if (d.nombre.length < 2) { msg.textContent = "Escriba el nombre o la razón social."; f.nombre.focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.correo)) { msg.textContent = "Revise el correo."; f.correo.focus(); return; }
    msg.textContent = ""; btn.disabled = true;
    try {
      if (V.local) {
        const rec = cola.buscar(V.local); if (!rec) return;
        rec.venta.factura = { ...d, estado: "pendiente", solicitada_por: "panel" };
        rec.error = null; cola.guardar(rec);
        $("#dlgReceptor").close();
        abrirLocal(rec.id);
        return hacerFESinRed("01");
      }
      if (!enLinea()) { msg.textContent = "Sin internet: la factura de una venta ya enviada se hace cuando vuelva la conexión."; return; }
      const r = V.factura
        ? await db.from("facturas").update({ ...d, estado: "pendiente" }).eq("id", V.factura.id).select().single()
        : await db.from("facturas").insert({ ...d, pedido_id: V.pedido.id, solicitada_por: "panel" }).select().single();   // estado: pendiente por defecto
      if (r.error) { msg.textContent = errTxt(r.error); return; }
      V.factura = r.data;
      $("#dlgReceptor").close();
      if (!(await asegurarCabys(V.items))) return;
      accionFE({ accion: "emitir", pedido_id: V.pedido.id, tipo: "01", ...plazoFE() }, "Firmando y enviando la factura a Hacienda…");
    } finally { btn.disabled = false; }
  });

  // ---------- comprobantes electrónicos sin internet ----------
  // Con internet, cada compu aparta su terminal y números (50 tiquetes y 20 facturas; se reponen al bajar).
  function idCompu() {
    let id = leerLS(LS_DISP, null);
    if (!id) { id = crypto.randomUUID(); ponerLS(LS_DISP, id); }
    return id;
  }
  const feRed = () => leerLS(LS_FE_RED, null);
  const quedanFE = (st, tipo) => (st?.rangos?.[tipo] || []).reduce((n, [a, b]) => n + Math.max(0, b - a + 1), 0);
  const nombreCompu = () => `${String(navigator.userAgentData?.platform || navigator.platform || "Compu").slice(0, 20)} · ${ACCESO?.nombre || ACCESO?.usuario || ""}`.slice(0, 60);
  async function prepararFESinRed() {
    if (!enLinea() || !V19 || !V10 || !FE?.activo || !puede("ventas")) return;
    let st = feRed();
    // si cambió el ambiente, la sucursal o la cédula, los números viejos ya no sirven (la terminal sí)
    if (st && (st.ambiente !== FE.ambiente || st.sucursal !== FE.sucursal || st.identificacion !== FE.identificacion)) st = { ...st, rangos: {} };
    const pedirT = quedanFE(st, "04") < 20 ? 50 : 0, pedirF = quedanFE(st, "01") < 8 ? 20 : 0;
    if (st?.terminal && !pedirT && !pedirF) return;
    let r;
    try { r = await db.rpc("fe_preparar_sin_internet", { p_dispositivo: idCompu(), p_nombre: nombreCompu(), p_tiquetes: pedirT, p_facturas: pedirF }); } catch { return; }
    if (r.error || !r.data?.activo) return;
    const d = r.data, rangos = { "04": [...(st?.rangos?.["04"] || [])], "01": [...(st?.rangos?.["01"] || [])] };
    for (const t of ["04", "01"]) if (d.bloques?.[t]) rangos[t].push(d.bloques[t]);
    ponerLS(LS_FE_RED, { terminal: d.terminal, sucursal: d.sucursal, ambiente: d.ambiente, identificacion: d.identificacion, rangos });
  }
  function tomarNumeroFE(tipo) {
    const st = feRed(); if (!st) return null;
    const r = (st.rangos?.[tipo] || []).filter(([a, b]) => a <= b);
    if (!r.length) return null;
    const numero = r[0][0];
    r[0] = [numero + 1, r[0][1]];
    st.rangos = { ...st.rangos, [tipo]: r.filter(([a, b]) => a <= b) };
    return ponerLS(LS_FE_RED, st) ? { ...st, numero } : null;
  }
  // clave de 50 dígitos: 506 · ddmmaa · cédula · sucursal · terminal · tipo · número · 3 (sin internet) · código de seguridad
  function claveSinInternet(st, tipo, numero, fecha) {
    const pt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(fecha);
    const g = (t) => pt.find((x) => x.type === t).value;
    const consecutivo = st.sucursal + st.terminal + tipo + String(numero).padStart(10, "0");
    const seguridad = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e8).padStart(8, "0");
    return { clave: "506" + g("day") + g("month") + g("year").slice(-2) + String(st.identificacion).padStart(12, "0") + consecutivo + "3" + seguridad, consecutivo };
  }
  // lo que Hacienda va a revisar se revisa ya: el cliente se lleva la clave en el papel
  function revisarFESinRed(tipo) {
    if (!V19) return "Para hacer comprobantes sin internet falta correr supabase/v19_sin_internet.sql en Supabase.";
    const st = feRed();
    if (!st?.terminal || st.ambiente !== FE?.ambiente) return "Esta compu no tiene números para facturar sin internet: se apartan solos la próxima vez que entre con internet.";
    if (!quedanFE(st, tipo)) return `A esta compu se le acabaron los números para ${tipo === "01" ? "facturas" : "tiquetes"} sin internet (se reponen al volver la conexión).`;
    if (V.dirty) return "Primero guarde la venta.";
    if (feVigente()) return "Esta venta ya tiene comprobante electrónico.";
    if (V.pedido.estado === "anulada") return "La venta está anulada.";
    for (const it of V.items) {
      const pr = prodDe(it.producto_id);
      if (!pr && /^env[ií]o/i.test(it.descripcion)) { if (!FE.cabys_envio) return "Falta el CABYS del servicio de envío (Datos del negocio)."; continue; }
      if (!pr) return `“${it.descripcion}” no es un producto del catálogo: para facturarlo cámbielo por el producto.`;
      if (!/^[0-9]{13}$/.test(String(pr.cabys || ""))) return `“${pr.nombre}” no tiene CABYS (o esta compu no lo tiene guardado: entre con internet una vez para bajarlo).`;
      if (!(Number(it.precio_unit) > 0) || !(Number(it.cantidad) > 0)) return `Revise el precio y la cantidad de “${it.descripcion}”.`;
    }
    if (tipo === "01" && !V.factura) return "Faltan los datos del cliente: toque “Emitir factura” y llénelos.";
    return "";
  }
  async function hacerFESinRed(tipo) {
    const msg = $("#feMsg");
    const err = revisarFESinRed(tipo);
    if (err) { msg.className = "msg msg--error"; msg.textContent = err; return; }
    const st = tomarNumeroFE(tipo);
    if (!st) { msg.className = "msg msg--error"; msg.textContent = "No se pudo apartar el número en esta compu."; return; }
    const p = V.pedido, fecha = new Date();
    const { clave, consecutivo } = claveSinInternet(st, tipo, st.numero, fecha);
    const desde = String(p.created_at || fecha.toISOString()).slice(0, 10);
    const credito_dias = p.credito && p.vence ? Math.max(1, diasEntre(desde, String(p.vence).slice(0, 10))) : null;
    const a = acciones.agregar("fe", { tipo, clave, consecutivo, fecha: fecha.toISOString(), total: actualizarTotal(), credito_dias,
      receptor: tipo === "01" ? { tipo_id: V.factura.tipo_id, identificacion: V.factura.identificacion, nombre: V.factura.nombre, correo: V.factura.correo } : null },
      { venta: refVenta(), desc: `${FE_TIPO[tipo]} sin internet N.º ${st.numero} · ${p.codigo} · ${p.cliente_nombre}` });
    if (!a) { msg.className = "msg msg--error"; msg.textContent = "No hay espacio en esta compu para guardarlo."; return; }
    msg.className = "msg"; msg.textContent = "Listo: imprima el recibo, lleva la clave del comprobante. Se manda a Hacienda solo cuando vuelva la conexión.";
    pintarFEVenta(); pintarBandaRed();
    if (await preguntar("Comprobante hecho sin internet. ¿Imprimir el recibo para el cliente?")) $("#btnImprimir").click();
  }
  $("#feDocs").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fe]"); if (!b) return;
    const id = Number(b.dataset.id), acc = b.dataset.fe;
    if (acc === "consultar") return accionFE({ accion: "consultar", documento_id: id }, "Consultando a Hacienda…");
    if (acc === "enviar") return accionFE({ accion: "enviar", documento_id: id }, "Enviando a Hacienda…");
    if (acc === "anular") {
      const motivo = await pedirTexto("Motivo de la nota de crédito (lo ve Hacienda):", "Devolución de la mercadería");
      if (motivo === null) return;
      if (motivo.trim().length < 3) return toast("Escriba el motivo.", true);
      if (!await preguntar("Se emite una nota de crédito por el total y el comprobante queda anulado ante Hacienda. ¿Seguir?")) return;
      return accionFE({ accion: "anular", documento_id: id, motivo: motivo.trim() }, "Emitiendo la nota de crédito…");
    }
    if (acc === "xml") return descargarXmlFE(id);
    if (acc === "pendientes") return abrirPendientes();
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
    const ventas = ok.filter((d) => d.tipo === "01" || d.tipo === "04"), notas = ok.filter((d) => d.tipo === "03");
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
      if (d.pedido_id) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-comp="venta" data-id="${d.pedido_id}">Ver venta</button>`);
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
    entrada: "Entrada de mercadería", entrada_anulada: "Entrada anulada", producto: "Editado en Productos", importacion: "Importación",
    ajuste: "Salida o conteo", ajuste_anulado: "Salida o conteo anulado"
  };
  let invVista = "entradas", invProd = null;
  const cant = (n) => Number(n).toLocaleString("es-CR", { maximumFractionDigits: 2 });
  function cargarInventario() {
    $("#invEntradas").hidden = invVista !== "entradas";
    $("#invMovs").hidden = invVista !== "movs";
    $("#invAjustes").hidden = invVista !== "ajustes";
    $$("#invVista [data-iv]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.iv === invVista)));
    return invVista === "entradas" ? cargarEntradas() : invVista === "ajustes" ? cargarAjustesInv() : cargarMovsInv();
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
          ${en.condicion === "credito" && en.estado === "aplicada" ? `<small class="${Number(en.saldo) > 0 && en.vence < hoyCR() ? "rojo" : ""}">A crédito · ${Number(en.saldo) > 0 ? `debe ${fmt(en.saldo)} de ${fmt(en.total_factura)} · vence ${fechaDia(en.vence)}` : "pagada"}</small>` : ""}
          <details data-entrada="${en.id}"><summary>Ver productos</summary><ul class="entrada__items"><li>Cargando…</li></ul></details>
        </div>
        <div class="fila__acc">${en.estado === "aplicada" && Number(en.saldo) > 0 && puede("compras") ? `<button type="button" class="btn btn--sm btn--negro" data-pagar-entrada="${en.id}">Pagar</button>` : ""}${en.estado === "aplicada" ? `<button type="button" class="enlace enlace--peligro" data-anular-entrada="${en.id}">Anular</button>` : '<span class="etq">Anulada</span>'}</div>
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
    const pg = e.target.closest("[data-pagar-entrada]");
    if (pg) return abrirPagoProv(Number(pg.dataset.pagarEntrada));
    const b = e.target.closest("[data-anular-entrada]"); if (!b) return;
    const motivo = await pedirTexto("¿Por qué se anula esta entrada? (se resta lo que había sumado)", "Se registró por error");
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
      .select(`id,producto_id,cantidad,existencia_antes,existencia_despues,origen,pedido_id,entrada_id,${V21 ? "ajuste_id," : ""}nota,created_at,productos(nombre,codigo)`)
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
        : g.entrada_id ? `Entrada ${g.entrada_id}` : g.ajuste_id ? `Ajuste ${g.ajuste_id}` : "";
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
  function nuevaEntrada() {
    ENT.clear(); $("#formEntrada").reset();
    $("#formEntrada").fecha.value = hoyCR(); $("#formEntrada").fecha.max = hoyCR();
    $("#formEntrada").recibido_id.value = "";
    $("#entRef").hidden = true; $("#entRefLineas").innerHTML = "";
    $("#entMsg").textContent = ""; $("#entMsg").className = "msg";
    condicionEntrada();
    if (V21) cargarProveedores();
    pintarEntrada();
  }
  $("#btnNuevaEntrada").addEventListener("click", () => {
    nuevaEntrada();
    $("#dlgEntrada").showModal();
    $("#formEntrada").proveedor.focus();
  });
  // contado o crédito: a crédito se pide el vencimiento (lo sugiere con los días de crédito del proveedor)
  function condicionEntrada() {
    const f = $("#formEntrada"), cred = f.condicion.value === "credito";
    $("#entVenceLbl").hidden = !cred;
    f.total_factura.required = cred;
    if (cred && !f.vence.value) {
      const pr = provPorNombre(f.proveedor.value), dias = pr?.dias_credito ?? 30;
      f.vence.value = new Date(new Date((f.fecha.value || hoyCR()) + "T12:00:00-06:00").getTime() + dias * 864e5).toISOString().slice(0, 10);
    }
  }
  $("#formEntrada").condicion.addEventListener("change", condicionEntrada);
  $("#formEntrada").proveedor.addEventListener("change", () => {
    const f = $("#formEntrada"), pr = provPorNombre(f.proveedor.value);
    if (pr && pr.dias_credito && f.condicion.value === "contado") { f.condicion.value = "credito"; f.vence.value = ""; }
    if (f.condicion.value === "credito") { f.vence.value = ""; condicionEntrada(); }
  });
  $("#btnCerrarEntrada").addEventListener("click", async () => {
    if (ENT.size && !await preguntar("La entrada no se ha guardado. ¿Cerrar de todos modos?")) return;
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
    const cred = V21 && f.condicion.value === "credito";
    const nomProv = f.proveedor.value.trim();
    let prov = V21 ? provPorNombre(nomProv) : null;
    if (cred && !nomProv) { msg.className = "msg msg--error"; msg.textContent = "Para una compra a crédito, escriba el proveedor."; return; }
    if (cred && !(Number(f.total_factura.value) > 0)) { msg.className = "msg msg--error"; msg.textContent = "Escriba el total de la factura (lo que se le debe al proveedor)."; return; }
    if (V21 && nomProv && !prov) {
      if (!await preguntar(`“${nomProv}” no está en la lista de proveedores. ¿Agregarlo?`)) return;
      const { data: np, error: eP } = await db.from("proveedores").insert({ nombre: nomProv }).select("*").single();
      if (eP) { msg.className = "msg msg--error"; msg.textContent = errTxt(eP); return; }
      PROVS.push(np); prov = np;
    }
    if (!await preguntar(`¿Guardar la entrada?${cred ? ` Queda a crédito: se le deben ${fmt(f.total_factura.value)} a ${prov.nombre}, vence ${fechaDia(f.vence.value)}.` : ""} Se suman ${filas.length} ${filas.length === 1 ? "producto" : "productos"} al inventario${precios ? ` y cambian ${precios} ${precios === 1 ? "precio" : "precios"} de venta` : ""}.`)) return;
    const b = $("#btnGuardarEntrada"); b.disabled = true; msg.className = "msg"; msg.textContent = "Guardando…";
    const datos = {
      proveedor: nomProv, documento: f.documento.value.trim(), fecha: f.fecha.value, nota: f.nota.value.trim(),
      items: filas.map((x) => ({ producto_id: x.p.id, cantidad: String(Number(x.cant)), costo: x.costo === "" ? "" : String(Number(x.costo)), precio: x.precio === "" ? "" : String(Number(x.precio)) }))
    };
    const { data, error } = V21
      ? await db.rpc("registrar_compra", { p: { ...datos, proveedor_id: prov?.id ?? "", condicion: f.condicion.value, vence: cred ? f.vence.value : "",
          total_factura: f.total_factura.value ? String(Math.round(Number(f.total_factura.value) * 100) / 100) : "", recibido_id: f.recibido_id.value } })
      : await db.rpc("registrar_entrada", { p: datos });
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); b.disabled = false; return; }
    ENT.clear();
    $("#dlgEntrada").close();
    toast(`Entrada ${data.id} guardada: ${data.productos} ${data.productos === 1 ? "producto" : "productos"} sumados al inventario${Number(data.saldo) > 0 ? ` · se deben ${fmt(data.saldo)}` : ""}`);
    invVista = "entradas";
    if (!$("#tCom").hidden) cargarCompras(); else cargarInventario();
    cargarProductos();
  });


  // =========================================================
  //  CABYS: ponerle el código a los productos que no lo tienen
  // =========================================================
  const IVA_DE_TARIFA = { 13: "08", 4: "04", 2: "03", 1: "02", 0.5: "09" };
  const NO_PALABRA = new Set(["para", "con", "sin", "por", "los", "las", "del", "una", "uno", "tipo", "marca", "color", "unidad", "unid", "pulg", "mts", "plg"]);
  const palabras = (t) => [...new Set(norm(t).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3 && !/^[0-9]+$/.test(w) && !NO_PALABRA.has(w)))];
  const CAB = { modo: "lista", cola: [], i: 0, prod: null, sel: null };
  function parecidosConCabys(p) {
    const pal = palabras(p.nombre); if (!pal.length) return [];
    const grupos = new Map();
    for (const x of productos) {
      if (!x.cabys || x.id === p.id) continue;
      const px = new Set(palabras(x.nombre));
      let pts = 0; pal.forEach((w, k) => { if (px.has(w)) pts += k === 0 ? 2 : 1; });
      if (pts < 2) continue;
      const g = grupos.get(x.cabys) || { codigo: x.cabys, pts: 0, n: 0, ejemplos: [], iva: x.iva_codigo };
      g.pts = Math.max(g.pts, pts); g.n++; if (g.ejemplos.length < 2) g.ejemplos.push(x.nombre);
      grupos.set(x.cabys, g);
    }
    return [...grupos.values()].sort((a, b) => b.pts - a.pts || b.n - a.n).slice(0, 6);
  }
  function pendientesParecidos(p) {
    const pal = palabras(p.nombre); if (!pal.length) return [];
    return CAB.cola.slice(CAB.i + 1).map((x) => {
      const px = new Set(palabras(x.nombre)); let pts = 0; pal.forEach((w, k) => { if (px.has(w)) pts += k === 0 ? 2 : 1; });
      return { x, pts };
    }).filter((o) => o.pts >= 2).sort((a, b) => b.pts - a.pts).slice(0, 15);
  }
  const filaCabys = (o, clave) => `<li><button type="button" class="cab__op ${CAB.sel?.clave === clave ? "cab__op--sel" : ""}" data-cab="${U.esc(clave)}">
      <b>${U.esc(o.codigo)}</b> <span>${U.esc(o.descripcion || "")}</span>
      <small>${o.impuesto != null ? `IVA ${String(o.impuesto).replace(".", ",")} %` : ""}${o.ejemplos ? `Lo usan: ${o.ejemplos.map(U.esc).join(" · ")}${o.n > 2 ? ` y ${o.n - 2} más` : ""}` : ""}${o.categorias?.length ? ` · ${o.categorias.map(U.esc).join(" › ")}` : ""}</small>
    </button></li>`;
  let CAB_OPC = {};
  function pintarCabys() {
    const p = CAB.prod;
    $("#cabCuenta").textContent = CAB.modo === "lista" ? `${CAB.i + 1} de ${CAB.cola.length}`
      : CAB.modo === "venta" ? `Para facturar esta venta · ${CAB.i + 1} de ${CAB.cola.length}` : "";
    $("#cabProd").innerHTML = `<b>${U.esc(p.nombre)}</b><small>${[p.codigo && "Cód. " + p.codigo, p.unidad, U.colones(p.precio)].filter(Boolean).map(U.esc).join(" · ")}</small>`;
    const sug = parecidosConCabys(p);
    CAB_OPC = {};
    sug.forEach((g, k) => { CAB_OPC["s" + k] = { codigo: g.codigo, iva: g.iva, ejemplos: g.ejemplos, n: g.n }; });
    $("#cabSugBox").hidden = !sug.length;
    $("#cabSug").innerHTML = sug.map((g, k) => filaCabys(CAB_OPC["s" + k], "s" + k)).join("");
    (CAB.res || []).forEach((r, k) => { CAB_OPC["h" + k] = r; });
    $("#cabRes").innerHTML = CAB.res == null ? "" : CAB.res.length ? CAB.res.map((r, k) => filaCabys(r, "h" + k)).join("")
      : `<li class="vacio-adm">No salió nada. Pruebe con otra palabra (qué es, no la marca).</li>`;
    const tam = CAB.modo === "lista" && CAB.sel ? pendientesParecidos(p) : [];
    $("#cabTambienBox").hidden = !tam.length;
    $("#cabTambien").innerHTML = tam.map((o) => `<li><label class="check"><input type="checkbox" data-cab-tambien="${o.x.id}" ${o.pts >= 3 ? "checked" : ""} /> ${U.esc(o.x.nombre)}</label></li>`).join("");
    $("#btnCabGuardar").disabled = !CAB.sel;
    $("#btnCabGuardar").textContent = CAB.modo === "uno" ? "Usar este" : CAB.modo === "venta" && CAB.i + 1 >= CAB.cola.length ? "Guardar y facturar" : "Guardar y seguir";
    $("#btnCabSaltar").hidden = CAB.modo !== "lista";
  }
  async function buscarCabys(q) {
    $("#cabRes").innerHTML = `<li class="vacio-adm">Buscando en Hacienda…</li>`;
    try {
      const r = await llamarFE(/^[0-9]{13}$/.test(q) ? { accion: "cabys", codigo: q } : { accion: "cabys", q });
      CAB.res = r.resultados || [];
    } catch (err) { CAB.res = null; $("#cabRes").innerHTML = `<li class="vacio-adm">${U.esc(err.message)}</li>`; return; }
    pintarCabys();
  }
  function mostrarProductoCabys() {
    CAB.prod = CAB.cola[CAB.i]; CAB.sel = null; CAB.res = null;
    $("#cabMsg").textContent = ""; $("#cabMsg").className = "msg";
    const q = palabras(CAB.prod.nombre).slice(0, 2).join(" ");
    $("#formCabysBuscar").q.value = q;
    pintarCabys();
    if (q.length >= 3) buscarCabys(q);
  }
  $("#btnCabys").addEventListener("click", () => {
    if (!puede("productos")) return toast("No tiene permiso para editar productos.", true);
    CAB.modo = "lista";
    CAB.cola = productos.filter((p) => p.activo && !p.cabys).sort((a, b) => (Number(b.vendido) || 0) - (Number(a.vendido) || 0) || a.nombre.localeCompare(b.nombre, "es"));
    if (!CAB.cola.length) return toast("Todos los productos a la venta ya tienen CABYS.");
    CAB.i = 0; mostrarProductoCabys(); $("#dlgCabys").showModal();
  });
  $("#btnProdCabys").addEventListener("click", () => {
    CAB.modo = "uno";
    CAB.cola = [{ id: Number(fp.id.value) || 0, nombre: fp.nombre.value || "Producto nuevo", codigo: fp.codigo.value, unidad: fp.unidad.value, precio: fp.precio.value === "" ? null : Number(fp.precio.value) }];
    CAB.i = 0; mostrarProductoCabys(); $("#dlgCabys").showModal();
  });
  $("#formCabysBuscar").addEventListener("submit", (e) => {
    e.preventDefault(); const q = e.currentTarget.q.value.trim();
    if (q.length < 3) return toast("Escriba al menos 3 letras.", true);
    CAB.sel = null; buscarCabys(q);
  });
  $("#dlgCabys").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cab]"); if (!b) return;
    const o = CAB_OPC[b.dataset.cab]; if (!o) return;
    CAB.sel = { clave: b.dataset.cab, codigo: o.codigo, iva: o.iva || (o.impuesto != null ? IVA_DE_TARIFA[o.impuesto] : null), impuesto: o.impuesto };
    pintarCabys();
  });
  $("#btnCabSaltar").addEventListener("click", () => {
    if (CAB.i + 1 >= CAB.cola.length) { $("#dlgCabys").close(); return toast("Ya no quedan más sin CABYS."); }
    CAB.i++; mostrarProductoCabys();
  });
  $("#btnCabGuardar").addEventListener("click", async () => {
    const sel = CAB.sel; if (!sel) return;
    if (CAB.modo === "uno") {
      fp.cabys.value = sel.codigo;
      if (sel.iva && V10) fp.iva_codigo.value = sel.iva;
      $("#dlgCabys").close();
      return toast(sel.iva ? "CABYS puesto (y el IVA que le corresponde). Guarde el producto." : "CABYS puesto. Revise el IVA y guarde el producto.");
    }
    const ids = [CAB.prod.id, ...$$("#cabTambien [data-cab-tambien]").filter((c) => c.checked).map((c) => Number(c.dataset.cabTambien))];
    const d = { cabys: sel.codigo }; if (sel.iva && V10) d.iva_codigo = sel.iva;
    const b = $("#btnCabGuardar"); b.disabled = true;
    const { error } = await db.from("productos").update(d).in("id", ids);
    b.disabled = false;
    if (error) { $("#cabMsg").className = "msg msg--error"; $("#cabMsg").textContent = errTxt(error); return; }
    for (const id of ids) { const x = productos.find((y) => y.id === id); if (x) Object.assign(x, d); }
    CAB.cola = CAB.cola.filter((x, k) => k <= CAB.i || !ids.includes(x.id));
    toast(`CABYS ${sel.codigo} puesto a ${ids.length} ${ids.length === 1 ? "producto" : "productos"}${sel.impuesto === 0 ? " · revise el IVA (tarifa 0)" : ""}`);
    if (CAB.i + 1 >= CAB.cola.length) {
      if (CAB.modo === "venta") CAB.ok = true;
      $("#dlgCabys").close(); pintarProductos();
      return CAB.modo === "venta" ? null : toast("Listo: ya no quedan productos sin CABYS.");
    }
    CAB.i++; mostrarProductoCabys(); pintarProductos();
  });
  // Al facturar: si un producto de la venta no tiene CABYS, se le pone ahí mismo y queda guardado en el producto
  function asegurarCabys(items) {
    const faltan = [];
    for (const it of items) {
      const pr = prodDe(it.producto_id);
      if (pr && !/^[0-9]{13}$/.test(String(pr.cabys || "")) && !faltan.includes(pr)) faltan.push(pr);
    }
    if (!faltan.length) return Promise.resolve(true);
    if (!puede("productos")) {
      toast(`“${faltan[0].nombre}” no tiene CABYS. Pídale al administrador que se lo ponga (Productos → Poner CABYS).`, true);
      return Promise.resolve(false);
    }
    CAB.modo = "venta"; CAB.cola = faltan; CAB.i = 0; CAB.ok = false;
    mostrarProductoCabys(); $("#dlgCabys").showModal();
    toast(faltan.length === 1 ? `“${faltan[0].nombre}” no tiene CABYS: escójalo y se guarda en el producto.` : `${faltan.length} productos de esta venta no tienen CABYS: escójalos y se guardan.`);
    return new Promise((ok) => $("#dlgCabys").addEventListener("close", () => ok(CAB.ok), { once: true }));
  }
  // =========================================================
  //  PAQUETE DEL MES PARA EL CONTADOR
  // =========================================================
  const TARIFA_PCT = { "01": 0, "02": 1, "03": 2, "04": 4, "05": 0, "06": 4, "07": 8, "08": 13, "09": 0.5, "10": 0, "11": 0 };
  const TARIFA_NOM = { "08": "13 %", "07": "8 %", "04": "4 %", "06": "4 % (transitoria)", "03": "2 %", "02": "1 %", "09": "0,5 %",
                       "01": "0 % (art. 32)", "05": "0 % (transitoria)", "11": "0 % sin crédito", "10": "Exento" };
  const ORDEN_TARIFA = ["08", "07", "04", "06", "03", "02", "09", "01", "05", "11", "10"];
  const TIPO_FE_NOM = { "01": "Factura", "03": "Nota de crédito", "04": "Tiquete", "08": "Factura de compra" };
  const ESTADO_FE_NOM = { aceptado: "Aceptado", rechazado: "Rechazado", firmado: "Sin enviar", enviado: "Enviado", procesando: "Procesando", error: "Con error" };
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const fechaHora = (iso) => iso ? new Date(iso).toLocaleString("es-CR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  async function todasLasFilas(armar) {
    const out = [];
    for (let d = 0; ; d += 1000) {
      const { data, error } = await armar().range(d, d + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  // base e IVA por tarifa de un comprobante emitido (lo que se firmó)
  function tarifasEmitido(datos) {
    const t = {};
    for (const l of datos?.detalleServicio || []) {
      const imp = (l.impuesto || [])[0] || {}, cod = imp.codigoTarifaIVA || "10";
      const x = t[cod] || (t[cod] = { base: 0, iva: 0 });
      x.base += Number(l.subTotal ?? l.montoTotal ?? 0);
      x.iva += Number(l.impuestoNeto ?? imp.monto ?? 0);
    }
    return t;
  }
  // lo mismo de una factura de proveedor (su XML, 4.3 o 4.4)
  function tarifasRecibido(xml) {
    const t = {};
    try {
      const raiz = new DOMParser().parseFromString(xml, "application/xml").documentElement;
      for (const l of [...(hijo(raiz, "DetalleServicio")?.children || [])].filter((x) => x.localName === "LineaDetalle")) {
        const imp = [...l.children].find((c) => c.localName === "Impuesto");
        let cod = imp ? (txt(imp, "CodigoTarifaIVA") || txt(imp, "CodigoTarifa")) : "10";
        if (!cod) cod = imp ? "08" : "10";
        const x = t[cod] || (t[cod] = { base: 0, iva: 0 });
        x.base += Number(txt(l, "SubTotal") || txt(l, "MontoTotal") || 0);
        x.iva += Number((imp && txt(imp, "Monto")) || 0);
      }
    } catch { /* XML raro: queda sin desglose */ }
    return t;
  }
  const sumarTarifas = (a, b, signo = 1, tc = 1) => { for (const [k, v] of Object.entries(b)) { const x = a[k] || (a[k] = { base: 0, iva: 0 }); x.base += signo * v.base * tc; x.iva += signo * v.iva * tc; } return a; };
  const tarifasOrden = (...objs) => ORDEN_TARIFA.filter((k) => objs.some((o) => o[k])).concat([...new Set(objs.flatMap(Object.keys))].filter((k) => !ORDEN_TARIFA.includes(k)));

  $("#formContador").mes.value = (() => { const d = new Date(Date.now() - 864e5 * new Date().getDate()); return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d); })();
  $("#formContador").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#contadorMsg"), btn = $("#btnContador"), mes = f.mes.value, conXml = f.xml.checked;
    if (!/^\d{4}-\d{2}$/.test(mes)) { msg.className = "msg msg--error"; msg.textContent = "Escoja el mes."; return; }
    const [an, me] = mes.split("-").map(Number);
    const sig = me === 12 ? `${an + 1}-01` : `${an}-${String(me + 1).padStart(2, "0")}`;
    const desde = `${mes}-01T00:00:00-06:00`, hasta = `${sig}-01T00:00:00-06:00`, dDesde = `${mes}-01`, dHasta = `${sig}-01`;
    const nombreMes = new Date(`${mes}-15T12:00:00-06:00`).toLocaleDateString("es-CR", { month: "long", year: "numeric", timeZone: TZ });
    const amb = FE?.ambiente || "produccion";
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Juntando los datos del mes…";
    const avisos = [];
    const intentar = async (nombre, fn) => { try { return await fn(); } catch (err) { avisos.push(`${nombre}: ${errTxt(err)}`); return null; } };
    try {
      // ---- datos ----
      const todosDocs = await intentar("Comprobantes emitidos", () => todasLasFilas(() => db.from("fe_documentos")
        .select("id,pedido_id,tipo,clave,consecutivo,fecha_emision,receptor,total,impuesto,estado,detalle,referencia_id,anulado,datos,pedidos(codigo,cliente_nombre)")
        .eq("ambiente", amb).gte("fecha_emision", desde).lt("fecha_emision", hasta).order("fecha_emision"))) || [];
      // las facturas de compra (08) las hace el almacén, pero son compras: van con las de proveedores
      const docs = todosDocs.filter((d) => d.tipo !== "08"), fecs = todosDocs.filter((d) => d.tipo === "08");
      const recs = V21 ? (await intentar("Facturas de proveedores", () => todasLasFilas(() => db.from("fe_recibidos")
        .select("id,clave,tipo_doc,emisor_id,emisor_nombre,consecutivo_doc,fecha_emision,moneda,tipo_cambio,total,impuesto,mensaje,condicion_impuesto,impuesto_acreditar,estado,ambiente,xml,xml_firmado,respuesta_xml")
        .gte("fecha_emision", desde).lt("fecha_emision", hasta).order("fecha_emision"))) || []) : [];
      const entradas = await intentar("Entradas de mercadería", () => todasLasFilas(() => db.from("entradas").select("*")
        .gte("fecha", dDesde).lt("fecha", dHasta).eq("estado", "aplicada").order("fecha"))) || [];
      const pagos = await intentar("Cobros", () => todasLasFilas(() => db.from("pagos").select("monto,metodo,fecha,anulado,verificado")
        .gte("fecha", desde).lt("fecha", hasta).order("fecha"))) || [];
      const porCobrar = V13 ? (await intentar("Por cobrar", () => todasLasFilas(() => db.from("v_clientes_credito").select("*").order("nombre"))) || []) : [];
      const porPagar = V21 ? (await intentar("Por pagar", () => todasLasFilas(() => db.from("v_cuentas_pagar").select("*").order("vence"))) || []) : [];
      const inv = await intentar("Inventario", () => todasLasFilas(() => db.from("productos").select("codigo,nombre,existencia,costo,precio,unidad,activo,cabys").not("existencia", "is", null).order("nombre"))) || [];
      inv.splice(0, inv.length, ...inv.filter((p) => p.existencia != null && Number.isFinite(Number(p.existencia))));
      msg.textContent = "Armando el Excel…";

      // ---- ventas ----
      const ventasT = {}, notasT = {}, porCliente = new Map();
      const filasVen = docs.map((d) => {
        const t = tarifasEmitido(d.datos), ok = d.estado === "aceptado", nc = d.tipo === "03";
        if (ok) sumarTarifas(nc ? notasT : ventasT, t);
        if (ok) {
          const ced = d.receptor?.identificacion || "", k = ced || "consumidor";
          const c = porCliente.get(k) || { nombre: ced ? d.receptor?.nombre || "" : "Consumidor final (tiquetes y facturas sin cédula)", ced, n: 0, base: 0, iva: 0, total: 0 };
          const s = nc ? -1 : 1;
          c.n += 1; c.total += s * Number(d.total); c.iva += s * Number(d.impuesto); c.base += s * (Number(d.total) - Number(d.impuesto));
          porCliente.set(k, c);
        }
        return { d, t };
      });
      const tarVen = tarifasOrden(...filasVen.map((x) => x.t));
      const hojaVentas = [["Fecha", "Tipo", "Consecutivo", "Venta", "Cliente", "Cédula", "Condición",
        ...tarVen.flatMap((k) => TARIFA_PCT[k] > 0 ? [`Base ${TARIFA_NOM[k]}`, `IVA ${TARIFA_NOM[k]}`] : [`Venta ${TARIFA_NOM[k]}`]),
        "IVA total", "Total", "Estado en Hacienda", "Cuenta para el IVA", "Clave", "Nota"]];
      for (const { d, t } of filasVen) {
        const s = d.tipo === "03" ? -1 : 1;
        hojaVentas.push([fechaHora(d.fecha_emision), TIPO_FE_NOM[d.tipo] || d.tipo, d.consecutivo, d.pedidos?.codigo || "",
          d.receptor?.nombre || d.pedidos?.cliente_nombre || "", d.receptor?.identificacion || "", d.datos?.condicionVenta === "02" ? "Crédito" : "Contado",
          ...tarVen.flatMap((k) => TARIFA_PCT[k] > 0 ? [r2(s * (t[k]?.base || 0)), r2(s * (t[k]?.iva || 0))] : [r2(s * (t[k]?.base || 0))]),
          r2(s * d.impuesto), r2(s * d.total), ESTADO_FE_NOM[d.estado] || d.estado, d.estado === "aceptado" ? "Sí" : "No",
          d.clave, [d.anulado ? "Anulado con nota de crédito" : "", d.estado !== "aceptado" ? d.detalle || "" : ""].filter(Boolean).join(" · ")]);
      }
      const dinVen = []; for (let i = 7; i < hojaVentas[0].length - 4; i++) dinVen.push(i);

      // ---- compras ----
      const comprasT = {}, porProv = new Map(); let acreditable = 0;
      const MSJ = { "1": "Aceptada", "2": "Aceptada en parte", "3": "Rechazada" };
      const filasCom = recs.map((r) => {
        const tc = Number(r.tipo_cambio) || 1, t = tarifasRecibido(r.xml), cuenta = r.mensaje !== "3" && r.tipo_doc !== "04";
        const s = r.tipo_doc === "03" ? -1 : 1;
        if (cuenta) {
          sumarTarifas(comprasT, t, s, tc);
          const p = porProv.get(r.emisor_id) || { nombre: r.emisor_nombre, ced: r.emisor_id, n: 0, base: 0, iva: 0, total: 0 };
          p.n += 1; p.total += s * Number(r.total) * tc; p.iva += s * Number(r.impuesto) * tc; p.base += s * (Number(r.total) - Number(r.impuesto)) * tc;
          porProv.set(r.emisor_id, p);
        }
        if (r.estado === "aceptado" && r.mensaje !== "3") acreditable += s * Number(r.impuesto_acreditar ?? 0) * tc;
        return { r, t, tc, s };
      }).concat(fecs.map((d) => {
        const t = tarifasEmitido(d.datos), ok = d.estado === "aceptado";
        const r = { fecha_emision: d.fecha_emision, tipo_doc: "08", emisor_nombre: d.receptor?.nombre || "", emisor_id: d.receptor?.identificacion?.numero || "",
          consecutivo_doc: d.consecutivo, impuesto: Number(d.impuesto), total: Number(d.total), moneda: "CRC", mensaje: null, condicion_impuesto: null,
          impuesto_acreditar: null, estado: d.estado, clave: d.clave };
        if (ok) {
          sumarTarifas(comprasT, t, 1, 1);
          const p = porProv.get(r.emisor_id) || { nombre: r.emisor_nombre, ced: r.emisor_id, n: 0, base: 0, iva: 0, total: 0 };
          p.n += 1; p.total += r.total; p.iva += r.impuesto; p.base += r.total - r.impuesto;
          porProv.set(r.emisor_id, p);
        }
        return { r, t, tc: 1, s: 1 };
      }));
      const tarCom = tarifasOrden(...filasCom.map((x) => x.t));
      const hojaCompras = [["Fecha", "Tipo", "Proveedor", "Cédula", "Consecutivo",
        ...tarCom.flatMap((k) => TARIFA_PCT[k] > 0 ? [`Base ${TARIFA_NOM[k]}`, `IVA ${TARIFA_NOM[k]}`] : [`Compra ${TARIFA_NOM[k]}`]),
        "IVA total", "Total (₡)", "Moneda", "Tipo de cambio", "Respuesta del almacén", "Condición del IVA", "IVA acreditable", "Respuesta en Hacienda", "Clave"]];
      const COND = { "01": "Crédito completo", "02": "Crédito parcial", "03": "Bienes de capital", "04": "Gasto sin crédito", "05": "Proporcionalidad" };
      for (const { r, t, tc, s } of filasCom) {
        hojaCompras.push([fechaHora(r.fecha_emision), TIPO_DOC_REC[r.tipo_doc] || r.tipo_doc, r.emisor_nombre, r.emisor_id, r.consecutivo_doc || "",
          ...tarCom.flatMap((k) => TARIFA_PCT[k] > 0 ? [r2(s * (t[k]?.base || 0) * tc), r2(s * (t[k]?.iva || 0) * tc)] : [r2(s * (t[k]?.base || 0) * tc)]),
          r2(s * r.impuesto * tc), r2(s * r.total * tc), r.moneda, tc === 1 ? "" : tc,
          r.tipo_doc === "08" ? "La hizo el almacén" : r.mensaje ? MSJ[r.mensaje] : "Sin contestar", COND[r.condicion_impuesto] || "", r.impuesto_acreditar != null ? r2(s * r.impuesto_acreditar * tc) : "",
          r.tipo_doc === "08" || r.mensaje ? (ESTADO_FE_NOM[r.estado] || r.estado) + (r.ambiente === "pruebas" ? " (pruebas)" : "") : "", r.clave]);
      }
      const dinCom = []; for (let i = 5; i < 5 + tarCom.reduce((n, k) => n + (TARIFA_PCT[k] > 0 ? 2 : 1), 0) + 2; i++) dinCom.push(i);
      dinCom.push(hojaCompras[0].indexOf("IVA acreditable"));

      // ---- resumen ----
      const R = [], neg = [];
      const fila = (...c) => R.push(c), titulo = (t) => { neg.push(R.length); R.push([t]); };
      fila("Paquete para el contador", nombreMes);
      fila("Negocio", FE?.nombre || "", FE?.identificacion ? `Cédula ${FE.identificacion}` : "");
      fila("Ambiente de facturación", amb === "produccion" ? "Producción" : "PRUEBAS (no cuenta para Hacienda)");
      fila("Generado", fechaHora(new Date().toISOString()));
      fila();
      titulo("VENTAS · comprobantes aceptados por Hacienda");
      neg.push(R.length); fila("Tarifa", "Base", "IVA");
      const tarR = tarifasOrden(ventasT, notasT);
      let vb = 0, vi = 0;
      for (const k of tarR) {
        const b = (ventasT[k]?.base || 0) - (notasT[k]?.base || 0), i = (ventasT[k]?.iva || 0) - (notasT[k]?.iva || 0);
        vb += b; vi += i; fila(TARIFA_NOM[k] || k, r2(b), r2(i));
      }
      neg.push(R.length); fila("Total ventas (ya restadas las notas de crédito)", r2(vb), r2(vi));
      const nNc = docs.filter((d) => d.tipo === "03" && d.estado === "aceptado").length;
      fila("Notas de crédito restadas", nNc);
      const malos = docs.filter((d) => d.estado !== "aceptado");
      if (malos.length) fila("Comprobantes que NO cuentan (rechazados o sin respuesta)", malos.length, "Ver hoja Ventas");
      fila();
      titulo("COMPRAS · facturas electrónicas de proveedores (sin las rechazadas)");
      neg.push(R.length); fila("Tarifa", "Base", "IVA");
      let cb = 0, ci = 0;
      for (const k of tarifasOrden(comprasT)) { cb += comprasT[k].base; ci += comprasT[k].iva; fila(TARIFA_NOM[k] || k, r2(comprasT[k].base), r2(comprasT[k].iva)); }
      neg.push(R.length); fila("Total compras", r2(cb), r2(ci));
      fila("IVA acreditable según lo contestado a Hacienda", "", r2(acreditable));
      const sinContestar = recs.filter((r) => !r.mensaje && r.tipo_doc !== "04").length;
      if (sinContestar) fila("Facturas de proveedores sin aceptar ni rechazar", sinContestar, "Contéstelas en Compras → Facturas recibidas");
      const entSin = entradas.filter((x) => !x.recibido_id);
      if (entSin.length) fila("Entradas de mercadería sin factura electrónica", entSin.length, "Ver hoja Entradas sin factura (no dan crédito de IVA)");
      fila();
      neg.push(R.length); fila("IVA de ventas menos IVA acreditable (referencia)", "", r2(vi - acreditable));
      fila("Es una ayuda para la declaración. El contador revisa los datos y presenta la declaración en TRIBU-CR.");
      fila();
      titulo("COBROS DEL MES (pagos recibidos en ventas y abonos)");
      neg.push(R.length); fila("Medio", "Cantidad", "Monto");
      const porMetodo = {};
      for (const p of pagos) if (!p.anulado) { const m = porMetodo[p.metodo] || (porMetodo[p.metodo] = { n: 0, m: 0 }); m.n++; m.m += Number(p.monto); }
      let tc = 0;
      for (const [k, v] of Object.entries(porMetodo).sort((a, b) => b[1].m - a[1].m)) { tc += v.m; fila(ETQ_METODO[k] || k, v.n, r2(v.m)); }
      neg.push(R.length); fila("Total cobrado", "", r2(tc));
      if (avisos.length) { fila(); titulo("No se pudieron leer"); avisos.forEach((a) => fila(a)); }

      // ---- demás hojas ----
      const filasCli = [["Cliente", "Cédula", "Comprobantes", "Base", "IVA", "Total"],
        ...[...porCliente.values()].sort((a, b) => b.total - a.total).map((c) => [c.nombre, c.ced, c.n, r2(c.base), r2(c.iva), r2(c.total)])];
      const filasProv = [["Proveedor", "Cédula", "Facturas", "Base", "IVA", "Total (₡)"],
        ...[...porProv.values()].sort((a, b) => b.total - a.total).map((p) => [p.nombre, p.ced, p.n, r2(p.base), r2(p.iva), r2(p.total)])];
      const filasEnt = [["Fecha", "Entrada", "Proveedor", "Documento", "Condición", "Costo de la mercadería", "Total de la factura", "Nota"],
        ...entSin.map((x) => [x.fecha, x.id, x.proveedor || "", x.documento || "", x.condicion === "credito" ? "Crédito" : "Contado", r2(x.total_costo), x.total_factura != null ? r2(x.total_factura) : "", x.nota || ""])];
      const filasCxc = [["Cliente", "Cédula", "Saldo", "Vencido", "Límite"],
        ...porCobrar.filter((c) => Number(c.saldo) > 0).map((c) => [c.nombre, c.identificacion || "", r2(c.saldo), r2(c.vencido), c.limite != null ? r2(c.limite) : ""])];
      filasCxc.push(["Total", "", r2(porCobrar.reduce((t, c) => t + Math.max(0, Number(c.saldo) || 0), 0))]);
      const filasCxp = [["Proveedor", "Factura", "Fecha", "Vence", "Total", "Saldo", "Días vencida"],
        ...porPagar.map((c) => [c.proveedor || "", c.documento || "", c.fecha, c.vence, r2(c.total_factura), r2(c.saldo), Math.max(0, Number(c.dias_vencida) || 0)])];
      filasCxp.push(["Total", "", "", "", "", r2(porPagar.reduce((t, c) => t + Number(c.saldo), 0))]);
      const filasInv = [["Código", "Producto", "Existencia", "Unidad", "Costo", "Valor al costo", "Precio de venta", "CABYS", "A la venta"],
        ...inv.map((p) => [p.codigo || "", p.nombre, Number(p.existencia), p.unidad || "", p.costo != null ? r2(p.costo) : "", p.costo != null ? r2(Number(p.existencia) * Number(p.costo)) : "", p.precio != null ? r2(p.precio) : "", p.cabys || "", p.activo ? "Sí" : "No"])];
      filasInv.push(["", "Total al costo (de los que tienen costo)", "", "", "", r2(inv.reduce((t, p) => t + (p.costo != null ? Number(p.existencia) * Number(p.costo) : 0), 0))]);
      const nota = (filas, texto) => { filas.push([], [texto]); return filas; };

      const xlsx = XlsxMini.libro([
        { nombre: "Resumen IVA", filas: R, anchos: [58, 18, 18], dinero: [1, 2], negritas: neg },
        { nombre: "Ventas", filas: hojaVentas, anchos: [17, 15, 22, 11, 30, 13, 10, ...tarVen.flatMap((k) => TARIFA_PCT[k] > 0 ? [14, 12] : [14]), 12, 14, 16, 10, 52, 40], dinero: dinVen },
        { nombre: "Compras", filas: hojaCompras, anchos: [17, 16, 32, 13, 22, ...tarCom.flatMap((k) => TARIFA_PCT[k] > 0 ? [14, 12] : [14]), 12, 14, 8, 10, 18, 18, 14, 20, 52], dinero: dinCom },
        { nombre: "Clientes", filas: filasCli, anchos: [40, 14, 13, 14, 12, 14], dinero: [3, 4, 5] },
        { nombre: "Proveedores", filas: filasProv, anchos: [40, 14, 10, 14, 12, 14], dinero: [3, 4, 5] },
        { nombre: "Entradas sin factura", filas: nota(filasEnt, "Mercadería que entró sin factura electrónica: no da crédito de IVA."), anchos: [11, 9, 30, 18, 10, 18, 16, 30], dinero: [5, 6] },
        { nombre: "Por cobrar", filas: nota(filasCxc, "Saldos de crédito al momento de descargar (no al cierre del mes)."), anchos: [36, 14, 14, 14, 14], dinero: [2, 3, 4], negritas: [filasCxc.length - 1] },
        { nombre: "Por pagar", filas: nota(filasCxp, "Saldos con proveedores al momento de descargar (no al cierre del mes)."), anchos: [32, 18, 11, 11, 14, 14, 12], dinero: [4, 5], negritas: [filasCxp.length - 1] },
        { nombre: "Inventario", filas: nota(filasInv, "Existencias al momento de descargar. Para el cierre del año, descárguelo el 31 de diciembre al cerrar."), anchos: [16, 44, 11, 10, 12, 14, 14, 15, 9], dinero: [4, 5, 6], negritas: [filasInv.length - 1] }
      ]);

      // ---- ZIP con los XML ----
      const archivos = [{ nombre: `contador-${mes}.xlsx`, datos: new Uint8Array(await xlsx.arrayBuffer()) }];
      if (conXml) {
        msg.textContent = "Bajando los XML…";
        for (let k = 0; k < todosDocs.length; k += 100) {
          const ids = todosDocs.slice(k, k + 100).map((d) => d.id);
          const { data, error } = await db.from("fe_documentos").select("tipo,clave,xml_firmado,respuesta_xml").in("id", ids);
          if (error) { avisos.push("XML emitidos: " + errTxt(error)); break; }
          for (const d of data) {
            const c = `emitidos/${TIPO_FE_NOM[d.tipo] || d.tipo}`;
            if (d.xml_firmado) archivos.push({ nombre: `${c}/${d.clave}.xml`, datos: d.xml_firmado });
            if (d.respuesta_xml) archivos.push({ nombre: `${c}/${d.clave}-respuesta-hacienda.xml`, datos: d.respuesta_xml });
          }
        }
        for (const r of recs) {
          archivos.push({ nombre: `recibidos/${r.clave}.xml`, datos: r.xml });
          if (r.xml_firmado) archivos.push({ nombre: `recibidos/${r.clave}-respuesta-almacen.xml`, datos: r.xml_firmado });
          if (r.respuesta_xml) archivos.push({ nombre: `recibidos/${r.clave}-respuesta-hacienda.xml`, datos: r.respuesta_xml });
        }
      }
      archivos.push({ nombre: "LEAME.txt", datos: [
        `Paquete para el contador · ${nombreMes}`, `${FE?.nombre || ""} ${FE?.identificacion ? "· cédula " + FE.identificacion : ""}`, "",
        `contador-${mes}.xlsx: Resumen IVA, Ventas, Compras, Clientes, Proveedores, Entradas sin factura, Por cobrar, Por pagar, Inventario.`,
        conXml ? "emitidos/: los comprobantes del almacén firmados y la respuesta de Hacienda de cada uno." : "",
        conXml ? "recibidos/: las facturas de los proveedores, la respuesta del almacén (aceptar/rechazar) y la de Hacienda." : "",
        amb === "pruebas" ? "\nOJO: la facturación está en PRUEBAS. Estos comprobantes no cuentan para Hacienda." : "",
        avisos.length ? "\nNo se pudieron leer:\n" + avisos.join("\n") : ""
      ].filter((x) => x !== "").join("\r\n") });
      descargar(XlsxMini.zip(archivos, "application/zip"), `contador-${mes}.zip`);
      msg.className = avisos.length ? "msg msg--error" : "msg";
      msg.textContent = `Listo: ${docs.length} comprobantes emitidos y ${recs.length} facturas de proveedores de ${nombreMes}.` + (avisos.length ? ` Faltó: ${avisos.join(" · ")}` : "");
    } catch (err) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(err);
    } finally { btn.disabled = false; }
  });

  // =========================================================
  //  v21 · SALIDAS Y CONTEOS, COMPRAS, PROVEEDORES Y FACTURAS RECIBIDAS
  // =========================================================
  const fechaDia = (d) => d ? new Date(String(d).slice(0, 10) + "T12:00:00-06:00").toLocaleDateString("es-CR", { dateStyle: "medium", timeZone: TZ }) : "";
  // cerrar cualquier diálogo con un botón data-cerrar-dlg
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-cerrar-dlg]"); if (b) b.closest("dialog")?.close(); });

  // ---------- salidas y conteos de inventario ----------
  const MOTIVO_AJ = { danado: "Dañado", perdido: "Perdido o robado", uso_interno: "Uso del almacén", vencido: "Vencido",
                      devolucion: "Devuelto al proveedor", conteo: "Conteo físico", otro: "Otro" };
  const AI = { tipo: "salida", filas: new Map() };          // id → { p, cant }
  function ayudaAjuste() {
    const salida = AI.tipo === "salida";
    $$("#aiTipo [data-ai]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.ai === AI.tipo)));
    $("#aiMotivoLbl").hidden = !salida;
    $("#aiColCant").textContent = salida ? "Sale" : "Contado";
    $("#aiAyuda").textContent = salida
      ? "Para mercadería que sale sin venderse: dañada, perdida, usada en el almacén, vencida o devuelta al proveedor. Se resta de la existencia."
      : "Escriba lo que contó en el estante. La existencia queda en ese número y la diferencia se anota (sobrante o faltante).";
  }
  function pintarAjusteInv() {
    const salida = AI.tipo === "salida";
    let costo = 0, faltan = 0, sobran = 0;
    $("#aiFilas").innerHTML = [...AI.filas.values()].map((f) => {
      const hay = f.p.existencia != null ? Number(f.p.existencia) : null, c = f.cant === "" ? null : Number(f.cant);
      const queda = c == null ? null : salida ? (hay ?? 0) - c : c;
      const dif = c == null ? 0 : salida ? -c : c - (hay ?? 0);
      costo += dif * (Number(f.p.costo) || 0);
      if (dif < 0) faltan++; else if (dif > 0) sobran++;
      return `<tr>
        <td>${U.esc(f.p.nombre)}${f.p.codigo ? `<small class="imp__cod">${U.esc(f.p.codigo)}</small>` : ""}${salida && hay == null ? `<small class="rojo">No lleva existencia: haga un conteo</small>` : ""}</td>
        <td class="num">${hay != null ? cant(hay) : "—"}</td>
        <td class="num"><input type="number" min="0" step="0.01" inputmode="decimal" value="${U.esc(String(f.cant))}" data-ai-cant="${f.p.id}" aria-label="${salida ? "Cantidad que sale" : "Cantidad contada"} de ${U.esc(f.p.nombre)}" /></td>
        <td class="num ${queda != null && queda < 0 ? "rojo" : ""}">${queda != null ? cant(queda) : ""}${!salida && c != null && dif ? `<small class="${dif > 0 ? "inv-mas" : "inv-menos"}">${dif > 0 ? "+" : "−"}${cant(Math.abs(dif))}</small>` : ""}</td>
        <td><button type="button" class="enlace enlace--peligro" data-ai-quitar="${f.p.id}">Quitar</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="vacio-adm">Busque arriba los productos (o páselos por el lector).</td></tr>`;
    const n = AI.filas.size;
    $("#aiResumen").textContent = !n ? "" : salida ? `${n} ${n === 1 ? "producto" : "productos"}` : `${n} contados · ${faltan} con faltante · ${sobran} con sobrante`;
    $("#aiCosto").textContent = costo ? (costo < 0 ? "−" : "+") + fmt(Math.abs(costo)) + " al costo" : "";
    $("#btnGuardarAjusteInv").disabled = !n;
  }
  $("#aiTipo").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ai]"); if (!b || b.dataset.ai === AI.tipo) return;
    if (AI.filas.size && !await preguntar("Se borra la lista que lleva. ¿Cambiar?")) return;
    AI.tipo = b.dataset.ai; AI.filas.clear(); ayudaAjuste(); pintarAjusteInv();
  });
  buscadorProductos($("#aiBuscar"), $("#aiRes"), (p) => {
    const f = AI.filas.get(p.id);
    if (f) { if (AI.tipo === "salida") f.cant = Math.round(((Number(f.cant) || 0) + 1) * 100) / 100; }
    else AI.filas.set(p.id, { p, cant: AI.tipo === "salida" ? 1 : "" });
    pintarAjusteInv();
    const inp = $(`#aiFilas [data-ai-cant="${p.id}"]`); if (inp) { inp.focus(); inp.select(); }
  }, { ocultos: true, nada: "No se encontró ese producto." });
  $("#aiFilas").addEventListener("input", (e) => {
    const i = e.target.closest("[data-ai-cant]"); if (!i) return;
    const f = AI.filas.get(Number(i.dataset.aiCant)); if (!f) return;
    f.cant = i.value.trim();
    const pos = i.selectionStart; pintarAjusteInv();
    const n = $(`#aiFilas [data-ai-cant="${f.p.id}"]`); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* number */ } }
  });
  $("#aiFilas").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.closest("[data-ai-cant]")) { e.preventDefault(); $("#aiBuscar").focus(); } });
  $("#aiFilas").addEventListener("click", (e) => { const b = e.target.closest("[data-ai-quitar]"); if (b) { AI.filas.delete(Number(b.dataset.aiQuitar)); pintarAjusteInv(); } });
  $("#btnNuevoAjusteInv").addEventListener("click", () => {
    if (!puede("inventario")) return toast("No tiene permiso para mover inventario.", true);
    AI.tipo = "salida"; AI.filas.clear();
    const f = $("#formAjusteInv"); f.reset(); f.fecha.value = hoyCR(); f.fecha.max = hoyCR();
    $("#aiMsg").textContent = ""; $("#aiMsg").className = "msg";
    ayudaAjuste(); pintarAjusteInv();
    $("#dlgAjusteInv").showModal(); $("#aiBuscar").focus();
  });
  $("#btnCerrarAjusteInv").addEventListener("click", async () => {
    if (AI.filas.size && !await preguntar("No se ha guardado. ¿Cerrar de todos modos?")) return;
    $("#dlgAjusteInv").close();
  });
  $("#formAjusteInv").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#aiMsg"), filas = [...AI.filas.values()], salida = AI.tipo === "salida";
    const mal = (t) => { msg.className = "msg msg--error"; msg.textContent = t; };
    for (const x of filas) {
      if (x.cant === "" || !numOk(x.cant)) return mal(`Revise la cantidad de ${x.p.nombre}.`);
      if (salida && !(Number(x.cant) > 0)) return mal(`La cantidad que sale de ${x.p.nombre} tiene que ser mayor que 0.`);
      if (salida && x.p.existencia == null) return mal(`${x.p.nombre} no lleva existencia: primero haga un conteo físico.`);
    }
    if (salida && f.motivo.value === "otro" && !f.nota.value.trim()) return mal("Con “Otro”, escriba en la nota qué pasó.");
    const negativos = salida ? filas.filter((x) => Number(x.p.existencia) - Number(x.cant) < 0).length : 0;
    if (!await preguntar(salida
      ? `¿Restar ${filas.length} ${filas.length === 1 ? "producto" : "productos"} del inventario (${MOTIVO_AJ[f.motivo.value]})?${negativos ? `\n\nOjo: ${negativos} quedan en negativo.` : ""}`
      : `¿Dejar la existencia de ${filas.length} ${filas.length === 1 ? "producto" : "productos"} en lo que contó?`)) return;
    const b = $("#btnGuardarAjusteInv"); b.disabled = true; msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.rpc("ajustar_inventario", { p: {
      tipo: AI.tipo, motivo: salida ? f.motivo.value : "conteo", fecha: f.fecha.value, nota: f.nota.value.trim(),
      items: filas.map((x) => ({ producto_id: x.p.id, cantidad: String(Number(x.cant)) }))
    } });
    if (error) { mal(errTxt(error)); b.disabled = false; return; }
    AI.filas.clear(); $("#dlgAjusteInv").close();
    toast(`${salida ? "Salida" : "Conteo"} ${data.id} guardado: ${data.productos} ${data.productos === 1 ? "producto" : "productos"}`);
    await refrescarExistencias(filas.map((x) => x.p.id));
    invVista = "ajustes"; if (!$("#tInv").hidden) cargarInventario();
  });

  async function cargarAjustesInv() {
    const ul = $("#listaAjustesInv");
    ul.innerHTML = `<li class="vacio-adm">Cargando…</li>`;
    const { data, error } = await db.from("ajustes_inventario").select("*").order("fecha", { ascending: false }).order("id", { ascending: false }).limit(300);
    if (error) { ul.innerHTML = ""; return toast(errTxt(error), true); }
    ul.innerHTML = data.map((a) => `<li class="fila fila--pago ${a.estado === "anulado" ? "fila--oculta" : ""}">
        <div class="fila__monto"><b class="${Number(a.costo_total) < 0 ? "inv-menos" : ""}">${Number(a.costo_total) ? (Number(a.costo_total) < 0 ? "−" : "+") + fmt(Math.abs(a.costo_total)) : `${a.productos} prod.`}</b><small>${fechaDia(a.fecha)}</small></div>
        <div class="fila__txt">
          <b>${a.tipo === "conteo" ? "Conteo físico" : "Salida"} ${a.id}${a.tipo === "salida" ? " · " + U.esc(MOTIVO_AJ[a.motivo] || a.motivo) : ""}</b>
          <small>${a.productos} ${a.productos === 1 ? "producto" : "productos"}${a.nota ? " · " + U.esc(a.nota) : ""}${a.estado === "anulado" ? " · Anulado: " + U.esc(a.motivo_anulacion || "") : ""}</small>
          <details data-ajuste="${a.id}"><summary>Ver productos</summary><ul class="entrada__items"><li>Cargando…</li></ul></details>
        </div>
        <div class="fila__acc">${a.estado === "aplicado" ? (puede("inventario") ? `<button type="button" class="enlace enlace--peligro" data-anular-ajuste="${a.id}">Anular</button>` : "") : '<span class="etq">Anulado</span>'}</div>
      </li>`).join("") || `<li class="vacio-adm">No hay salidas ni conteos. Use <b>Salida o conteo</b> para mercadería dañada, perdida o para el conteo físico.</li>`;
  }
  $("#listaAjustesInv").addEventListener("toggle", async (e) => {
    const d = e.target.closest("details[data-ajuste]"); if (!d || !d.open || d.dataset.cargado) return;
    const { data, error } = await db.from("ajuste_items").select("antes,cantidad,despues,productos(nombre)").eq("ajuste_id", d.dataset.ajuste).order("id");
    d.querySelector("ul").innerHTML = error ? `<li>${U.esc(errTxt(error))}</li>` : data.map((i) =>
      `<li><b class="${Number(i.cantidad) < 0 ? "inv-menos" : Number(i.cantidad) > 0 ? "inv-mas" : ""}">${Number(i.cantidad) > 0 ? "+" : Number(i.cantidad) < 0 ? "−" : "±"}${cant(Math.abs(i.cantidad))}</b> ${U.esc(i.productos?.nombre || "(borrado)")} · había ${i.antes != null ? cant(i.antes) : "—"}, quedó ${i.despues != null ? cant(i.despues) : "—"}</li>`).join("");
    d.dataset.cargado = "1";
  }, true);
  $("#listaAjustesInv").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-anular-ajuste]"); if (!b) return;
    const motivo = await pedirTexto("¿Por qué se anula? (la existencia vuelve a como estaba antes de este movimiento)", "Se registró por error");
    if (motivo === null) return;
    if (motivo.trim().length < 3) return toast("Escriba el motivo.", true);
    const { error } = await db.rpc("anular_ajuste", { p_id: Number(b.dataset.anularAjuste), p_motivo: motivo.trim() });
    if (error) return toast(errTxt(error), true);
    toast("Anulado: la existencia volvió");
    cargarAjustesInv(); cargarProductos();
  });

  // ---------- proveedores ----------
  let PROVS = [];
  const provPorNombre = (n) => { const k = norm(n || ""); return k ? PROVS.find((p) => norm(p.nombre) === k) : null; };
  async function cargarProveedores() {
    if (!V21) return [];
    const { data, error } = await db.from("proveedores").select("*").order("nombre");
    if (error) { toast(errTxt(error), true); return PROVS; }
    PROVS = data;
    $("#dlProveedores").innerHTML = PROVS.filter((p) => p.activo).map((p) => `<option value="${U.esc(p.nombre)}">`).join("");
    return PROVS;
  }
  function pintarProveedores() {
    const q = norm($("#provBuscar").value), debe = {};
    for (const c of PAGAR) if (c.proveedor_id) debe[c.proveedor_id] = (debe[c.proveedor_id] || 0) + Number(c.saldo);
    const lista = PROVS.filter((p) => !q || norm(p.nombre).includes(q) || String(p.identificacion || "").includes(q));
    $("#listaProveedores").innerHTML = lista.map((p) => `<li class="fila ${p.activo ? "" : "fila--oculta"}">
        <div class="fila__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${[p.identificacion && "Cédula " + p.identificacion, p.telefono, p.contacto, p.dias_credito != null && p.dias_credito + " días de crédito", !p.activo && "Inactivo"].filter(Boolean).map(U.esc).join(" · ")}</small>
          ${debe[p.id] ? `<small class="rojo">Se le deben ${fmt(debe[p.id])}</small>` : ""}
        </div>
        <div class="fila__acc"><button type="button" class="btn btn--sm btn--linea" data-prov-editar="${p.id}">Editar</button></div>
      </li>`).join("") || `<li class="vacio-adm">${q ? "No hay proveedores con ese nombre." : "Todavía no hay proveedores. Se agregan solos al subir una factura electrónica, o con <b>Nuevo proveedor</b>."}</li>`;
  }
  $("#provBuscar").addEventListener("input", pintarProveedores);
  function abrirProveedor(p) {
    const f = $("#formProveedor"); f.reset();
    $("#provTitulo").textContent = p ? "Editar proveedor" : "Nuevo proveedor";
    for (const k of ["id", "nombre", "tipo_id", "identificacion", "telefono", "correo", "contacto", "dias_credito", "nota"]) f.elements[k].value = p?.[k] ?? "";
    f.activo.checked = p ? !!p.activo : true;
    $("#provMsg").textContent = ""; $("#provMsg").className = "msg";
    $("#dlgProveedor").showModal(); f.nombre.focus();
  }
  // ---------- factura electrónica de compra ----------
  let FEC = [];
  const IVA_OPC = ["08", "04", "03", "02", "09", "10", "01"];
  function abrirFEC() {
    const f = $("#formFEC"); f.reset(); FEC = [];
    $("#fecMsg").textContent = ""; $("#fecBusca").textContent = "";
    pintarFEC();
    $("#dlgFEC").showModal(); f.identificacion.focus();
  }
  function pintarFEC() {
    $("#fecItems").innerHTML = FEC.map((l, n) => `<tr data-n="${n}">
        <td>${U.esc(l.detalle)}${l.cabys ? "" : '<small class="stock-nota">Sin CABYS: póngaselo en Productos</small>'}</td>
        <td class="num"><input data-k="cantidad" type="number" min="0.01" step="0.01" value="${U.esc(l.cantidad)}" aria-label="Cantidad" /></td>
        <td class="num"><input data-k="precio" type="number" min="0.01" step="0.01" value="${U.esc(l.precio)}" aria-label="Precio unitario sin IVA" /></td>
        <td><select data-k="iva_codigo" aria-label="IVA">${IVA_OPC.map((k) => `<option value="${k}"${k === l.iva_codigo ? " selected" : ""}>${U.esc(TARIFA_NOM[k] || k)}</option>`).join("")}</select></td>
        <td class="num" data-sub>${fmt(subFEC(l))}</td>
        <td><button type="button" class="cerrar-x" data-quitar="${n}" aria-label="Quitar">✕</button></td>
      </tr>`).join("") || `<tr><td colspan="6" class="vacio-adm">Busque arriba los productos que compró.</td></tr>`;
    $("#fecTotal").textContent = fmt(FEC.reduce((a, l) => a + subFEC(l), 0));
    const f = $("#formFEC");
    $("#fecMedioLbl").hidden = f.condicion.value !== "contado";
    $("#fecDiasLbl").hidden = f.condicion.value !== "credito";
  }
  const subFEC = (l) => r2((Number(l.cantidad) || 0) * (Number(l.precio) || 0) * (1 + (TARIFA_PCT[l.iva_codigo] || 0) / 100));
  buscadorProductos($("#fecBuscar"), $("#fecRes"), (p) => {
    const ya = FEC.find((l) => l.producto_id === p.id);
    if (ya) ya.cantidad = Number(ya.cantidad) + 1;
    else {
      const t = TARIFA_PCT[p.iva_codigo || "08"] ?? 13;
      FEC.push({ producto_id: p.id, detalle: p.nombre, cabys: p.cabys || "", codigo: p.codigo || null, unidad: p.unidad || null, iva_codigo: p.iva_codigo || "08",
        cantidad: 1, precio: p.costo != null ? r2(Number(p.costo) / (1 + t / 100)) : "" });
    }
    pintarFEC();
  }, { nada: "No está en el catálogo: créelo primero en Productos (con su CABYS)." });
  $("#fecItems").addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-n]"), k = e.target.dataset.k; if (!tr || !k) return;
    const l = FEC[Number(tr.dataset.n)]; l[k] = k === "iva_codigo" ? e.target.value : e.target.value;
    tr.querySelector("[data-sub]").textContent = fmt(subFEC(l));
    $("#fecTotal").textContent = fmt(FEC.reduce((a, x) => a + subFEC(x), 0));
  });
  $("#fecItems").addEventListener("change", (e) => { if (e.target.dataset.k === "iva_codigo") pintarFEC(); });
  $("#fecItems").addEventListener("click", (e) => { const b = e.target.closest("[data-quitar]"); if (b) { FEC.splice(Number(b.dataset.quitar), 1); pintarFEC(); } });
  $("#formFEC").condicion.addEventListener("change", pintarFEC);
  $("#formFEC").identificacion.addEventListener("input", (e) => {
    const f = e.target.form, id = U.soloDigitos(e.target.value), info = $("#fecBusca");
    clearTimeout(abrirFEC.t);
    if (id.length === 9) f.tipo_id.value = "fisica"; else if (id.length === 10) f.tipo_id.value = "juridica"; else if (id.length >= 11) f.tipo_id.value = "dimex";
    info.textContent = ""; info.className = "ayuda recep-busca";
    if (id.length < 9 || !enLinea()) return;
    abrirFEC.t = setTimeout(async () => {
      try {
        const r = await llamarFE({ accion: "contribuyente", identificacion: id });
        if (U.soloDigitos(f.identificacion.value) !== id) return;
        if (r.encontrado) { if (!f.nombre.value.trim()) f.nombre.value = r.nombre; info.textContent = `Registrado en Hacienda: ${r.nombre}`; info.className = "ayuda recep-busca recep-busca--ok"; }
        else info.textContent = "No aparece en el registro de Hacienda: escriba el nombre como sale en la cédula.";
      } catch { /* sin respuesta */ }
    }, 450);
  });
  $("#btnNuevaFEC").addEventListener("click", abrirFEC);
  $("#formFEC").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#fecMsg"), btn = $("#btnFECEmitir");
    const prov = { tipo_id: f.tipo_id.value, identificacion: U.soloDigitos(f.identificacion.value), nombre: f.nombre.value.trim(), senas: f.senas.value.trim() };
    msg.textContent = "";
    if (!RE_ID[prov.tipo_id].test(prov.identificacion)) { msg.textContent = "Revise la cédula del proveedor."; f.identificacion.focus(); return; }
    if (prov.nombre.length < 3) { msg.textContent = "Escriba el nombre del proveedor."; f.nombre.focus(); return; }
    if (prov.senas.length < 5) { msg.textContent = "Escriba la dirección del proveedor (señas)."; f.senas.focus(); return; }
    if (!FEC.length) { msg.textContent = "Agregue los productos que compró."; return; }
    if (FEC.some((l) => !(Number(l.cantidad) > 0) || !(Number(l.precio) > 0))) { msg.textContent = "Cada producto necesita cantidad y precio."; return; }
    if (!enLinea()) { msg.textContent = "Sin internet no se puede hacer la factura de compra."; return; }
    if (!(await asegurarCabys(FEC.map((l) => ({ producto_id: l.producto_id, descripcion: l.detalle }))))) return;
    for (const l of FEC) l.cabys = prodDe(l.producto_id)?.cabys || l.cabys;
    const total = FEC.reduce((a, l) => a + subFEC(l), 0), cred = f.condicion.value === "credito", inv = f.inventario.checked;
    if (!await preguntar(`Se hace la factura de compra a ${prov.nombre} por ${fmt(total)} y se manda a Hacienda (${FE?.ambiente === "produccion" ? "producción" : "pruebas"}).`
      + (inv ? `\nSe suman ${FEC.length} ${FEC.length === 1 ? "producto" : "productos"} al inventario.` : ""), { titulo: "¿Hacer la factura de compra?", si: "Hacer factura" })) return;
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Firmando y enviando a Hacienda…";
    try {
      let entrada_id = null;
      if (inv && V21) {
        let pv = provPorNombre(prov.nombre);
        if (!pv && cred) {
          const { data: np, error: eP } = await db.from("proveedores").insert({ nombre: prov.nombre }).select("*").single();
          if (eP) throw eP;
          PROVS.push(np); pv = np;
        }
        const { data, error } = await db.rpc("registrar_compra", { p: {
          proveedor: prov.nombre, proveedor_id: pv?.id ?? "", documento: "Factura de compra", fecha: hoyCR(), nota: `Factura electrónica de compra · ${prov.identificacion}`,
          condicion: cred ? "credito" : "contado", vence: "", total_factura: cred ? String(r2(total)) : "",
          items: FEC.map((l) => ({ producto_id: l.producto_id, cantidad: String(Number(l.cantidad)), costo: String(r2(Number(l.precio) * (1 + (TARIFA_PCT[l.iva_codigo] || 0) / 100))), precio: "" }))
        } });
        if (error) throw error;
        entrada_id = data?.id || null;
      }
      const r = await llamarFE({ accion: "compra", proveedor: prov, entrada_id,
        referencia: { tipo: f.ref_tipo.value, numero: f.ref_numero.value.trim() || null, fecha: hoyCR() },
        condicion: cred ? "credito" : "contado", dias: Number(f.dias.value) || 30, medio: f.medio.value,
        lineas: FEC.map((l) => ({ cabys: l.cabys, detalle: l.detalle, cantidad: Number(l.cantidad), precio: Number(l.precio), iva_codigo: l.iva_codigo, unidad: l.unidad, codigo: l.codigo })) });
      const d = r.documento || {};
      $("#dlgFEC").close();
      toast(d.estado === "aceptado" ? "Factura de compra aceptada por Hacienda." : `Factura de compra enviada (${(FE_ESTADO[d.estado] || [d.estado])[0]}). Véala en Comprobantes.`, d.estado === "rechazado");
      if (inv) { cargarCompras?.(); refrescarExistencias(FEC.map((l) => l.producto_id)); }
    } catch (err) { msg.className = "msg msg--error"; msg.textContent = errTxt(err); }
    finally { btn.disabled = false; }
  });

  $("#btnNuevoProv").addEventListener("click", () => {
    if (!(puede("compras") || puede("inventario"))) return toast("No tiene permiso para esto.", true);
    abrirProveedor(null);
  });
  $("#listaProveedores").addEventListener("click", (e) => {
    const b = e.target.closest("[data-prov-editar]"); if (b) abrirProveedor(PROVS.find((p) => p.id === Number(b.dataset.provEditar)));
  });
  $("#formProveedor").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#provMsg"), id = Number(f.id.value) || null;
    const ced = U.soloDigitos(f.identificacion.value);
    const d = {
      nombre: f.nombre.value.replace(/\s+/g, " ").trim(), tipo_id: f.tipo_id.value || null, identificacion: ced || null,
      telefono: f.telefono.value.trim() || null, correo: f.correo.value.trim() || null, contacto: f.contacto.value.trim() || null,
      dias_credito: f.dias_credito.value === "" ? null : Number(f.dias_credito.value), nota: f.nota.value.trim() || null, activo: f.activo.checked
    };
    const mal = (t) => { msg.className = "msg msg--error"; msg.textContent = t; };
    if (d.nombre.length < 2) return mal("Escriba el nombre.");
    if (ced && !/^[0-9]{9,12}$/.test(ced)) return mal("La cédula va de 9 a 12 números.");
    if (d.dias_credito != null && !(Number.isInteger(d.dias_credito) && d.dias_credito >= 0 && d.dias_credito <= 365)) return mal("Los días de crédito van de 0 a 365.");
    const r = id ? await db.from("proveedores").update(d).eq("id", id).select("*").single() : await db.from("proveedores").insert(d).select("*").single();
    if (r.error) return mal(r.error.code === "23505" ? "Ya hay un proveedor con ese nombre o esa cédula." : errTxt(r.error));
    $("#dlgProveedor").close();
    toast(id ? "Proveedor guardado" : "Proveedor agregado");
    await cargarProveedores(); pintarProveedores();
  });

  // ---------- compras: por pagar, facturas recibidas, pagos ----------
  let comVista = "pagar", PAGAR = [], RECIB = [];
  function cargarCompras() {
    if (!V21) return;
    for (const [v, id] of [["pagar", "#comPagar"], ["recibidas", "#comRecibidas"], ["proveedores", "#comProveedores"], ["pagos", "#comPagos"]]) $(id).hidden = comVista !== v;
    $$("#comVista [data-cv]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cv === comVista)));
    const vista = comVista;
    return Promise.all([cargarProveedores(), vista === "pagar" || vista === "proveedores" ? cargarPorPagar() : null]).then(() => {
      if (vista === "recibidas") return cargarRecibidos();
      if (vista === "proveedores") return pintarProveedores();
      if (vista === "pagos") return cargarPagosProv();
    });
  }
  $("#comVista").addEventListener("click", (e) => { const b = e.target.closest("[data-cv]"); if (b) { comVista = b.dataset.cv; cargarCompras(); } });

  async function cargarPorPagar() {
    const { data, error } = await db.from("v_cuentas_pagar").select("*").order("vence").order("entrada_id");
    if (error) { toast(errTxt(error), true); return; }
    PAGAR = data;
    if (comVista !== "pagar") return;
    const total = PAGAR.reduce((t, c) => t + Number(c.saldo), 0), venc = PAGAR.filter((c) => c.dias_vencida > 0);
    $("#comPagarRes").innerHTML = PAGAR.length ? `Se le deben <b>${fmt(total)}</b> a proveedores en ${PAGAR.length} ${PAGAR.length === 1 ? "factura" : "facturas"}${venc.length ? ` · <span class="rojo">${venc.length} ${venc.length === 1 ? "vencida" : "vencidas"} (${fmt(venc.reduce((t, c) => t + Number(c.saldo), 0))})</span>` : ""}.` : "";
    $("#listaPorPagar").innerHTML = PAGAR.map((c) => {
      const d = Number(c.dias_vencida);
      return `<li class="fila fila--pago">
        <div class="fila__monto"><b>${fmt(c.saldo)}</b><small>de ${fmt(c.total_factura)}</small></div>
        <div class="fila__txt">
          <b>${U.esc(c.proveedor || "Sin proveedor")}${c.documento ? " · Factura " + U.esc(c.documento) : ""}</b>
          <small>Compra del ${fechaDia(c.fecha)} · <span class="${d > 0 ? "rojo" : d >= -5 ? "amarillo" : ""}">${d > 0 ? `venció hace ${d} ${d === 1 ? "día" : "días"}` : d === 0 ? "vence hoy" : `vence el ${fechaDia(c.vence)}`}</span>${c.telefono ? " · Tel. " + U.esc(c.telefono) : ""}</small>
        </div>
        <div class="fila__acc">${puede("compras") ? `<button type="button" class="btn btn--sm btn--negro" data-pagar-entrada="${c.entrada_id}">Pagar</button>` : ""}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">No se le debe nada a ningún proveedor. Las compras a crédito se anotan en <b>Inventario → Entrada de mercadería</b> (“Se pagó: a crédito”).</li>`;
  }
  $("#listaPorPagar").addEventListener("click", (e) => { const b = e.target.closest("[data-pagar-entrada]"); if (b) abrirPagoProv(Number(b.dataset.pagarEntrada)); });

  async function abrirPagoProv(entradaId) {
    const { data: en, error } = await db.from("entradas").select("id,fecha,vence,documento,proveedor,total_factura,saldo,estado").eq("id", entradaId).single();
    if (error) return toast(errTxt(error), true);
    if (!(Number(en.saldo) > 0)) return toast("Esa compra ya no tiene saldo.", true);
    const f = $("#formPagoProv"); f.reset();
    f.entrada_id.value = en.id; f.monto.value = Number(en.saldo); f.monto.max = Number(en.saldo);
    f.fecha.value = hoyCR(); f.fecha.max = hoyCR();
    $("#ppInfo").innerHTML = `${U.esc(en.proveedor || "Proveedor")}${en.documento ? " · factura " + U.esc(en.documento) : ""} · se debe <b>${fmt(en.saldo)}</b> de ${fmt(en.total_factura)} · vence ${fechaDia(en.vence)}`;
    $("#ppCajaLbl").hidden = true;
    $("#ppMsg").textContent = ""; $("#ppMsg").className = "msg";
    $("#dlgPagoProv").showModal(); f.monto.focus(); f.monto.select();
  }
  $("#formPagoProv").metodo.addEventListener("change", (e) => {
    const ef = e.target.value === "efectivo";
    $("#ppCajaLbl").hidden = !ef || !puede("caja");
    e.target.form.de_caja.checked = ef && puede("caja");
  });
  $("#formPagoProv").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#ppMsg"), monto = Number(f.monto.value);
    const mal = (t) => { msg.className = "msg msg--error"; msg.textContent = t; };
    if (!(monto > 0) || !numOk(f.monto.value)) return mal("Revise el monto.");
    if (monto > Number(f.monto.max)) return mal(`El pago es mayor que lo que se debe (${fmt(f.monto.max)}).`);
    const deCaja = f.metodo.value === "efectivo" && f.de_caja.checked;
    if (!await preguntar(`¿Anotar el pago de ${fmt(monto)} (${ETQ_METODO[f.metodo.value] || f.metodo.value})${deCaja ? " y sacarlo de la caja" : ""}?`)) return;
    msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.rpc("pagar_proveedor", { p: { entrada_id: f.entrada_id.value, monto: String(Math.round(monto * 100) / 100), metodo: f.metodo.value,
      fecha: f.fecha.value, referencia: f.referencia.value.trim(), nota: f.nota.value.trim(), de_caja: deCaja } });
    if (error) return mal(errTxt(error));
    $("#dlgPagoProv").close();
    toast(Number(data.saldo) > 0 ? `Pago anotado · todavía se deben ${fmt(data.saldo)}` : "Pago anotado · factura cancelada");
    if (!$("#tCom").hidden) cargarCompras();
    if (!$("#tInv").hidden) cargarInventario();
    if (deCaja && !$("#tCaja").hidden) cargarCaja();
  });

  async function cargarPagosProv() {
    const ul = $("#listaPagosProv");
    ul.innerHTML = `<li class="vacio-adm">Cargando…</li>`;
    const { data, error } = await db.from("pagos_proveedor").select("*,entradas(documento,proveedor)").order("fecha", { ascending: false }).order("id", { ascending: false }).limit(300);
    if (error) { ul.innerHTML = ""; return toast(errTxt(error), true); }
    ul.innerHTML = data.map((g) => `<li class="fila fila--pago ${g.anulado ? "fila--oculta" : ""}">
        <div class="fila__monto"><b>${fmt(g.monto)}</b><small>${fechaDia(g.fecha)}</small></div>
        <div class="fila__txt">
          <b>${U.esc(g.entradas?.proveedor || "Proveedor")}${g.entradas?.documento ? " · Factura " + U.esc(g.entradas.documento) : ""}</b>
          <small>${U.esc(ETQ_METODO[g.metodo] || (g.metodo === "otro" ? "Otro" : g.metodo))}${g.referencia ? " · " + U.esc(g.referencia) : ""}${g.de_caja ? " · salió de la caja" : ""}${g.nota ? " · " + U.esc(g.nota) : ""}${g.anulado ? " · Anulado: " + U.esc(g.motivo_anulacion || "") : ""}</small>
        </div>
        <div class="fila__acc">${!g.anulado && puede("compras") ? `<button type="button" class="enlace enlace--peligro" data-anular-pagoprov="${g.id}">Anular</button>` : g.anulado ? '<span class="etq">Anulado</span>' : ""}</div>
      </li>`).join("") || `<li class="vacio-adm">Todavía no hay pagos a proveedores.</li>`;
  }
  $("#listaPagosProv").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-anular-pagoprov]"); if (!b) return;
    const motivo = await pedirTexto("¿Por qué se anula este pago? (vuelve a quedar como deuda; si salió de la caja, el efectivo vuelve a la caja abierta)", "Se anotó por error");
    if (motivo === null) return;
    if (motivo.trim().length < 3) return toast("Escriba el motivo.", true);
    const { error } = await db.rpc("anular_pago_proveedor", { p_id: Number(b.dataset.anularPagoprov), p_motivo: motivo.trim() });
    if (error) return toast(errTxt(error), true);
    toast("Pago anulado"); cargarPagosProv();
  });

  // ---------- facturas recibidas (XML del proveedor) ----------
  const TIPO_DOC_REC = { "01": "Factura", "02": "Nota de débito", "03": "Nota de crédito", "04": "Tiquete", "08": "Factura de compra", "09": "Factura de exportación" };
  const RAIZ_REC = { FacturaElectronica: "01", NotaDebitoElectronica: "02", NotaCreditoElectronica: "03", TiqueteElectronico: "04",
                     FacturaElectronicaCompra: "08", FacturaElectronicaExportacion: "09" };
  const MSJ_REC = { "1": "Aceptada", "2": "Aceptada en parte", "3": "Rechazada" };
  const ESTADO_REC = {
    nuevo: ["Sin contestar", "etq--por_verificar"], firmado: ["Respuesta sin enviar", "etq--error"], enviado: ["Respuesta enviada", "etq--por_verificar"],
    procesando: ["Hacienda la está revisando", "etq--por_verificar"], aceptado: ["Hacienda recibió la respuesta", "etq--pagado"],
    rechazado: ["Hacienda rechazó la respuesta", "etq--error"], error: ["Con error", "etq--error"]
  };
  // busca un hijo por nombre sin importar el espacio de nombres del XML (4.3 o 4.4)
  const hijo = (el, ruta) => ruta.split("/").reduce((n, nom) => n && [...n.children].find((c) => c.localName === nom), el);
  const txt = (el, ruta) => (hijo(el, ruta)?.textContent || "").trim();
  function leerXmlRecibido(texto) {
    const doc = new DOMParser().parseFromString(texto, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("no es un XML válido");
    const raiz = doc.documentElement, tipo = RAIZ_REC[raiz.localName];
    if (raiz.localName === "MensajeHacienda") throw new Error("es la respuesta de Hacienda; suba el otro XML (el de la factura)");
    if (raiz.localName === "MensajeReceptor") throw new Error("es una respuesta de receptor, no una factura");
    if (!tipo) throw new Error("no es un comprobante electrónico de Hacienda");
    const num = (v) => (v === "" ? null : Number(v));
    const lineas = [...(hijo(raiz, "DetalleServicio")?.children || [])].filter((l) => l.localName === "LineaDetalle").slice(0, 1000).map((l) => ({
      codigo: txt(l, "CodigoComercial/Codigo") || null,
      cabys: txt(l, "CodigoCABYS") || (/^[0-9]{13}$/.test(txt(l, "Codigo")) ? txt(l, "Codigo") : null),
      detalle: txt(l, "Detalle").slice(0, 200), cantidad: num(txt(l, "Cantidad")), unidad: txt(l, "UnidadMedida") || null,
      precio: num(txt(l, "PrecioUnitario")), monto: num(txt(l, "MontoTotalLinea"))
    }));
    return {
      clave: txt(raiz, "Clave"), tipo_doc: tipo, consecutivo_doc: txt(raiz, "NumeroConsecutivo"), fecha_emision: txt(raiz, "FechaEmision"),
      emisor_nombre: txt(raiz, "Emisor/Nombre"), emisor_tipo: txt(raiz, "Emisor/Identificacion/Tipo"), emisor_id: txt(raiz, "Emisor/Identificacion/Numero"),
      emisor_correo: txt(raiz, "Emisor/CorreoElectronico"), receptor_id: txt(raiz, "Receptor/Identificacion/Numero"),
      moneda: txt(raiz, "ResumenFactura/CodigoTipoMoneda/CodigoMoneda") || "CRC", tipo_cambio: txt(raiz, "ResumenFactura/CodigoTipoMoneda/TipoCambio") || "1",
      total: txt(raiz, "ResumenFactura/TotalComprobante"), impuesto: txt(raiz, "ResumenFactura/TotalImpuesto") || "0", lineas
    };
  }
  $("#xmlRecibido").addEventListener("change", async (e) => {
    const archivos = [...e.target.files]; e.target.value = "";
    if (!archivos.length) return;
    if (!puede("compras")) return toast("No tiene permiso para subir facturas de proveedores.", true);
    let nuevos = 0, repetidos = 0; const malos = [];
    for (const a of archivos) {
      try {
        if (a.size > 2e6) throw new Error("pesa más de 2 MB");
        const texto = await a.text(), d = leerXmlRecibido(texto);
        const { data, error } = await db.rpc("guardar_recibido", { p: { ...d, xml: texto } });
        if (error) throw new Error(errTxt(error));
        if (data.repetido) repetidos++; else nuevos++;
      } catch (err) { malos.push(`${a.name}: ${err.message}`); }
    }
    if (nuevos || repetidos) toast(`${nuevos ? `${nuevos} ${nuevos === 1 ? "factura subida" : "facturas subidas"}` : ""}${nuevos && repetidos ? " · " : ""}${repetidos ? `${repetidos} ya estaba${repetidos === 1 ? "" : "n"}` : ""}`);
    if (malos.length) await avisar("No se pudieron subir:\n\n" + malos.join("\n"));
    comVista = "recibidas"; cargarCompras(); contarRecibidos();
  });

  async function contarRecibidos() {
    if (!V21) return;
    const { count } = await db.from("fe_recibidos").select("id", { count: "exact", head: true }).in("estado", ["nuevo", "error", "rechazado", "firmado"]).neq("tipo_doc", "04");
    for (const id of ["#badgeCom", "#badgeRecib"]) { $(id).hidden = !count; $(id).textContent = count || ""; }
  }
  async function cargarRecibidos() {
    const ul = $("#listaRecibidas");
    ul.innerHTML = `<li class="vacio-adm">Cargando…</li>`;
    const { data, error } = await db.from("v_fe_recibidos").select("*").order("fecha_emision", { ascending: false }).limit(300);
    if (error) { ul.innerHTML = ""; return toast(errTxt(error), true); }
    RECIB = data;
    ul.innerHTML = RECIB.map((r) => {
      const [et, cls] = ESTADO_REC[r.estado] || [r.estado, ""];
      const acc = [];
      const puedeC = puede("compras");
      if (puedeC && r.tipo_doc !== "04" && ["nuevo", "rechazado"].includes(r.estado)) acc.push(`<button type="button" class="btn btn--sm btn--negro" data-rec="contestar" data-id="${r.id}">${r.estado === "nuevo" ? "Aceptar o rechazar" : "Contestar de nuevo"}</button>`);
      if (puedeC && ["firmado", "error"].includes(r.estado)) acc.push(`<button type="button" class="btn btn--sm btn--negro" data-rec="enviar" data-id="${r.id}">Enviar de nuevo</button>`);
      if (puedeC && ["enviado", "procesando"].includes(r.estado)) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-rec="consultar" data-id="${r.id}">Consultar</button>`);
      if (r.entrada_id) acc.push(`<span class="etq etq--pagado">Entrada ${r.entrada_id}</span>`);
      else if (puede("inventario") && r.mensaje !== "3" && ["01", "04", "08"].includes(r.tipo_doc)) acc.push(`<button type="button" class="btn btn--sm btn--linea" data-rec="entrada" data-id="${r.id}">Hacer la entrada</button>`);
      acc.push(`<button type="button" class="enlace" data-rec="xml" data-id="${r.id}">XML</button>`);
      if (puedeC && r.estado === "nuevo") acc.push(`<button type="button" class="enlace enlace--peligro" data-rec="borrar" data-id="${r.id}">Borrar</button>`);
      const ext = r.moneda !== "CRC";
      return `<li class="fila fila--pago">
        <div class="fila__monto"><b>${ext ? U.esc(r.moneda) + " " + Number(r.total).toLocaleString("es-CR") : fmt(r.total)}</b><small>${fechaDia(r.fecha_emision)}</small></div>
        <div class="fila__txt">
          <b>${U.esc(r.emisor_nombre)}</b>
          <small>${TIPO_DOC_REC[r.tipo_doc] || r.tipo_doc}${r.consecutivo_doc ? " " + U.esc(r.consecutivo_doc.slice(10).replace(/^0+/, "")) : ""} · IVA ${ext ? Number(r.impuesto).toLocaleString("es-CR") : fmt(r.impuesto)} · ${r.n_lineas} ${r.n_lineas === 1 ? "línea" : "líneas"}${r.mensaje ? " · " + MSJ_REC[r.mensaje] + (r.detalle_mensaje ? ": " + U.esc(r.detalle_mensaje) : "") : ""}</small>
          <small><span class="etq ${cls}">${et}</span>${r.ambiente === "pruebas" ? ' <span class="etq">Pruebas</span>' : ""}${r.detalle ? " " + U.esc(r.detalle) : ""}${r.tipo_doc === "04" ? " · Los tiquetes no se aceptan ni rechazan" : ""}</small>
        </div>
        <div class="fila__acc">${acc.join("")}</div>
      </li>`;
    }).join("") || `<li class="vacio-adm">No hay facturas de proveedores. Toque <b>Subir factura del proveedor (XML)</b> y escoja el archivo .xml que llegó al correo (puede escoger varios a la vez).</li>`;
  }
  $("#listaRecibidas").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rec]"); if (!b) return;
    const id = Number(b.dataset.id), r = RECIB.find((x) => x.id === id), acc = b.dataset.rec;
    if (acc === "contestar") return abrirRecibido(r);
    if (acc === "entrada") return entradaDesdeRecibido(id);
    if (acc === "xml") {
      const { data, error } = await db.from("fe_recibidos").select("clave,xml,xml_firmado,respuesta_xml").eq("id", id).single();
      if (error) return toast(errTxt(error), true);
      descargar(new Blob([data.xml], { type: "application/xml" }), `${data.clave}.xml`);
      if (data.respuesta_xml) setTimeout(() => descargar(new Blob([data.respuesta_xml], { type: "application/xml" }), `${data.clave}-respuesta-hacienda.xml`), 400);
      return;
    }
    if (acc === "borrar") {
      if (!await preguntar(`¿Borrar la factura de ${r.emisor_nombre}? (solo se borra aquí; no se le contesta nada a Hacienda)`)) return;
      const { error } = await db.rpc("borrar_recibido", { p_id: id });
      if (error) return toast(errTxt(error), true);
      toast("Factura borrada"); cargarRecibidos(); contarRecibidos(); return;
    }
    if (acc === "enviar" || acc === "consultar") {
      b.disabled = true;
      try { await llamarFE({ accion: "recibido_" + acc, recibido_id: id }); }
      catch (err) { toast(err.message, true); }
      cargarRecibidos(); contarRecibidos();
    }
  });

  let recMsj = "1";
  function pintarRecibidoForm() {
    const f = $("#formRecibido"), r = RECIB.find((x) => x.id === Number(f.id.value));
    $$("#recMensaje [data-msj]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.msj === recMsj)));
    $("#recIva").hidden = recMsj === "3" || !(Number(r?.impuesto) > 0);
    $("#recAcredLbl").hidden = !["02", "05"].includes(f.condicion.value);
    $("#recDetLbl").hidden = recMsj === "1";
    f.detalle.required = recMsj !== "1";
    $("#btnRecEnviar").textContent = { "1": "Aceptar ante Hacienda", "2": "Aceptar en parte ante Hacienda", "3": "Rechazar ante Hacienda" }[recMsj];
  }
  function abrirRecibido(r) {
    if (!FE?.identificacion) return toast("Primero llene los datos de Facturación electrónica (Datos del negocio).", true);
    const f = $("#formRecibido"); f.reset(); f.id.value = r.id;
    recMsj = "1";
    const ext = r.moneda !== "CRC";
    $("#recDatos").innerHTML = `
      <div><dt>Proveedor</dt><dd>${U.esc(r.emisor_nombre)} · ${U.esc(r.emisor_id)}</dd></div>
      <div><dt>${TIPO_DOC_REC[r.tipo_doc] || "Comprobante"}</dt><dd>${U.esc(r.consecutivo_doc || r.clave)} · ${fechaDia(r.fecha_emision)}</dd></div>
      <div><dt>Total</dt><dd>${ext ? U.esc(r.moneda) + " " + Number(r.total).toLocaleString("es-CR") : fmt(r.total)} · IVA ${ext ? Number(r.impuesto).toLocaleString("es-CR") : fmt(r.impuesto)}</dd></div>`;
    $("#recMsg").textContent = ""; $("#recMsg").className = "msg";
    pintarRecibidoForm();
    $("#dlgRecibido").showModal();
  }
  $("#recMensaje").addEventListener("click", (e) => { const b = e.target.closest("[data-msj]"); if (b) { recMsj = b.dataset.msj; pintarRecibidoForm(); } });
  $("#formRecibido").condicion.addEventListener("change", pintarRecibidoForm);
  $("#formRecibido").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#recMsg"), r = RECIB.find((x) => x.id === Number(f.id.value));
    const mal = (t) => { msg.className = "msg msg--error"; msg.textContent = t; };
    const det = f.detalle.value.trim();
    if (recMsj !== "1" && det.length < 3) return mal("Escriba el motivo.");
    const conIva = recMsj !== "3" && Number(r.impuesto) > 0;
    if (conIva && ["02", "05"].includes(f.condicion.value) && !(Number(f.acreditar.value) >= 0 && Number(f.acreditar.value) <= Number(r.impuesto) && f.acreditar.value !== "")) return mal(`El IVA que se acredita va de 0 a ${fmt(r.impuesto)}.`);
    if (!await preguntar(`¿${MSJ_REC[recMsj] === "Rechazada" ? "Rechazar" : recMsj === "2" ? "Aceptar en parte" : "Aceptar"} la factura de ${r.emisor_nombre} ante Hacienda (${FE?.ambiente === "produccion" ? "producción" : "pruebas"})? Esto no se puede deshacer.`)) return;
    const b = $("#btnRecEnviar"); b.disabled = true; msg.className = "msg"; msg.textContent = "Firmando y mandando a Hacienda…";
    try {
      const res = await llamarFE({ accion: "recibido_responder", recibido_id: r.id, mensaje: recMsj, detalle: det || null,
        condicion: conIva ? f.condicion.value : null, acreditar: conIva && ["02", "05"].includes(f.condicion.value) ? Number(f.acreditar.value) : null });
      $("#dlgRecibido").close();
      const est = res.recibido?.estado;
      toast(est === "aceptado" ? "Listo: Hacienda recibió la respuesta" : est === "rechazado" ? "Hacienda rechazó la respuesta: vea el detalle" : "Respuesta enviada; Hacienda la está revisando", est === "rechazado");
    } catch (err) { mal(err.message); }
    finally { b.disabled = false; }
    cargarRecibidos(); contarRecibidos();
  });

  // Entrada de mercadería con los productos de la factura del proveedor
  async function entradaDesdeRecibido(id) {
    const { data: r, error } = await db.from("fe_recibidos").select("id,emisor_nombre,consecutivo_doc,fecha_emision,moneda,total,lineas,proveedor_id,entrada_id").eq("id", id).single();
    if (error) return toast(errTxt(error), true);
    if (r.entrada_id) return toast(`Esa factura ya tiene la entrada ${r.entrada_id}.`, true);
    await cargarProveedores();
    nuevaEntrada();
    const f = $("#formEntrada"), prov = PROVS.find((p) => p.id === r.proveedor_id);
    f.proveedor.value = prov?.nombre || r.emisor_nombre;
    f.documento.value = (r.consecutivo_doc || "").slice(-20);
    f.fecha.value = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(r.fecha_emision));
    f.recibido_id.value = r.id;
    if (r.moneda === "CRC") f.total_factura.value = Number(r.total);
    if (prov?.dias_credito) { f.condicion.value = "credito"; f.vence.value = ""; }
    condicionEntrada();
    // une cada línea con un producto: por código comercial; si no, por CABYS cuando hay uno solo con ese CABYS
    const porCodigo = new Map(), porCabys = new Map();
    for (const p of productos) {
      if (p.codigo) porCodigo.set(String(p.codigo).trim().toLowerCase(), p);
      if (p.cabys) porCabys.set(p.cabys, porCabys.has(p.cabys) ? null : p);
    }
    const ref = [];
    for (const l of r.lineas || []) {
      const p = (l.codigo && porCodigo.get(String(l.codigo).trim().toLowerCase())) || (l.cabys && porCabys.get(l.cabys)) || null;
      if (p && l.cantidad > 0) {
        const ya = ENT.get(p.id);
        const costo = r.moneda === "CRC" && l.precio != null ? Math.round(l.precio * 100) / 100 : (p.costo != null ? Number(p.costo) : "");
        if (ya) ya.cant = Math.round(((Number(ya.cant) || 0) + l.cantidad) * 100) / 100;
        else ENT.set(p.id, { p, cant: l.cantidad, costo, precio: "" });
      }
      ref.push(`<li class="${p ? "inv-mas" : "rojo"}">${p ? "✔" : "✘"} ${cant(l.cantidad || 0)} × ${U.esc(l.detalle)}${l.codigo ? ` <small>(${U.esc(l.codigo)})</small>` : ""}${l.precio != null ? ` · ${r.moneda === "CRC" ? fmt(l.precio) : l.precio} c/u sin IVA` : ""}${p ? ` → ${U.esc(p.nombre)}` : " · busque el producto abajo y agréguelo"}</li>`);
    }
    $("#entRefLineas").innerHTML = ref.join("");
    $("#entRef").hidden = !ref.length; $("#entRef").open = ref.some((x) => x.includes("✘"));
    pintarEntrada();
    $("#dlgEntrada").showModal();
    toast(`${ENT.size} de ${(r.lineas || []).length} líneas se unieron con un producto por su código`);
  }

  // ---------- lista para dejar Moriah ----------
  const LS_ARRANQUE = "lc_arranque_v1";
  const ARRANQUE_MANUAL = [
    ["registros", "En Supabase: Authentication → Sign In / Providers → apagar “Allow new users to sign up”"],
    ["llave", "Revocar en Supabase la llave secreta (secret key) que se compartió por chat y crear otra"],
    ["impresora", "Impresora térmica probada: tiquete de venta y cierre de caja"],
    ["app", "Panel instalado como programa en la compu de caja (botón Instalar)"],
    ["prueba", "Prueba completa con Marvin: venta, cobro, crédito, abono, apartado, cierre de caja y sin internet"],
    ["moriah", "El día del cambio: importar otra vez el Excel de productos de Moriah y los saldos de crédito"],
    ["produccion", "Credenciales y llave de producción de La Campiña en los secretos de Supabase; ambiente en Producción"],
    ["contador", "El contador revisó la actividad económica y lo de facturar sin internet"]
  ];
  async function revisarArranque() {
    const ul = $("#arranqueLista"), b = $("#btnArranque");
    b.disabled = true; ul.innerHTML = `<li>Revisando…</li>`;
    const { data, error } = await db.rpc("revisar_arranque");
    b.disabled = false;
    if (error) { ul.innerHTML = ""; return toast(errTxt(error), true); }
    const t = leerLS(LS_RESPALDO, null), dias = t ? Math.floor((Date.now() - t) / 864e5) : null;
    const respaldo = { grupo: "Sistema", que: "Respaldo reciente en esta compu", ok: dias != null && dias <= 7, aviso: true,
      detalle: dias == null ? "Nunca se ha descargado un respaldo aquí" : dias === 0 ? "Hoy" : `Hace ${dias} ${dias === 1 ? "día" : "días"}` };
    const items = data.filter((i) => i.grupo === "Sistema").concat([respaldo], data.filter((i) => i.grupo !== "Sistema"));
    const marcados = leerLS(LS_ARRANQUE, {});
    const icono = (i) => i.ok ? ["✔", "arr--ok"] : i.aviso ? ["!", "arr--aviso"] : ["✘", "arr--mal"];
    let grupo = "";
    ul.innerHTML = items.map((i) => {
      const [ic, cls] = icono(i), g = i.grupo !== grupo ? `<li class="arr__grupo">${U.esc(i.grupo)}</li>` : "";
      grupo = i.grupo;
      return `${g}<li class="arr ${cls}"><span class="arr__ic" aria-hidden="true">${ic}</span><span><b>${U.esc(i.que)}</b><small>${U.esc(i.detalle || "")}</small></span></li>`;
    }).join("") + `<li class="arr__grupo">A mano (márquelos cuando estén hechos)</li>` + ARRANQUE_MANUAL.map(([k, t]) =>
      `<li class="arr arr--manual"><label class="check"><input type="checkbox" data-arr="${k}" ${marcados[k] ? "checked" : ""} /> ${U.esc(t)}</label></li>`).join("");
    const mal = items.filter((i) => !i.ok && !i.aviso).length, manual = ARRANQUE_MANUAL.filter(([k]) => !marcados[k]).length;
    toast(mal || manual ? `Faltan ${mal} cosas necesarias y ${manual} a mano` : "Todo listo para dejar Moriah");
  }
  $("#btnArranque").addEventListener("click", revisarArranque);
  $("#arranqueLista").addEventListener("change", (e) => {
    const c = e.target.closest("[data-arr]"); if (!c) return;
    const m = leerLS(LS_ARRANQUE, {}); m[c.dataset.arr] = c.checked; ponerLS(LS_ARRANQUE, m);
  });

  // ---------- fotos que faltan: buscar en Google y pegar ----------
  const FOTOS_PAG = 24, TOP_VENDIDOS = 150;
  const FT = { modo: "vendidos", ids: [], hasta: FOTOS_PAG, activo: null, subiendo: new Set(), chicas: new Set() };
  const porVendido = (a, b) => (Number(b.vendido) || 0) - (Number(a.vendido) || 0) || a.nombre.localeCompare(b.nombre, "es");
  const hayVendidos = () => V15 && productos.some((p) => Number(p.vendido) > 0);
  // puesto en ventas de cada producto (entre los que se muestran en la tienda)
  function puestosVenta() {
    const m = new Map();
    productos.filter((p) => p.activo && Number(p.vendido) > 0).sort(porVendido).forEach((p, i) => m.set(p.id, i + 1));
    return m;
  }
  // lo que se busca en Google: el nombre de Moriah, un poco más legible
  const consultaFoto = (p) => p.nombre.replace(/pulg\./gi, " pulgadas").replace(/N°\s*/g, "#").replace(/\s+/g, " ").trim();
  function armarListaFotos() {
    const sin = productos.filter((p) => p.activo && !p.imagen_url);
    const l = FT.modo === "vendidos" ? sin.filter((p) => Number(p.vendido) > 0).sort(porVendido)
      : sin.sort(porVendido);
    FT.ids = l.map((p) => p.id);
    FT.hasta = FOTOS_PAG;
    FT.activo = FT.ids[0] ?? null;
  }
  function cuentaFotos() {
    if (hayVendidos()) {
      const top = productos.filter((p) => p.activo && Number(p.vendido) > 0).sort(porVendido).slice(0, TOP_VENDIDOS);
      const con = top.filter((p) => p.imagen_url).length;
      return `De los ${top.length} más vendidos: ${con} con foto, ${top.length === con ? "no falta ninguno" : `faltan ${top.length - con}`}.`;
    }
    const n = productos.filter((p) => p.activo && !p.imagen_url).length;
    return `${n === 1 ? "Falta 1 producto" : `Faltan ${n.toLocaleString("es-CR")} productos`} con foto.`;
  }
  function pintarFotos() {
    const puesto = puestosVenta(), lista = FT.ids.slice(0, FT.hasta);
    $("#fotosCuenta").textContent = cuentaFotos();
    $("#listaFotos").innerHTML = lista.map((id) => {
      const p = productos.find((x) => x.id === id);
      if (!p) return "";
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "", sube = FT.subiendo.has(id);
      const google = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(consultaFoto(p))}`;
      return `<li class="foto-item${FT.activo === id ? " foto-item--activo" : ""}${url ? " foto-item--lista" : ""}" data-fid="${id}">
        <div class="foto-item__zona" tabindex="0" role="button" data-zona="${id}" aria-label="${url ? "Cambiar" : "Pegar"} la foto de ${U.esc(p.nombre)}">
          ${sube ? '<span class="foto-item__aviso">Subiendo…</span>'
            : url ? `<img ${U.srcMini(url)} alt="" />`
            : `<span class="foto-item__aviso">${FT.activo === id ? "Presione Ctrl + V para pegar la foto" : "Toque aquí y pegue la foto"}</span>`}
        </div>
        <div class="foto-item__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${puesto.has(id) ? `N.º ${puesto.get(id)} en ventas` : "Sin ventas anotadas"}${p.codigo ? ` · Cód. ${U.esc(p.codigo)}` : ""}</small>
          ${url ? `<span class="etq etq--pagado">Con foto</span>${FT.chicas.has(id) ? ' <span class="etq etq--por_verificar">Foto chica: mejor cópiela de la vista grande</span>' : ""}` : ""}
        </div>
        <div class="foto-item__acc">
          <a class="btn btn--sm btn--negro" href="${U.esc(google)}" target="_blank" rel="noopener noreferrer" data-buscar="${id}">Buscar en Google</a>
          <label class="btn btn--sm btn--linea">Archivo<input type="file" accept="image/*" data-archivo="${id}" class="sr" /></label>
        </div>
      </li>`;
    }).join("") || `<li class="vacio-adm">${FT.modo === "vendidos" && !hayVendidos()
      ? (V15 ? "Todavía no hay ventas anotadas. Importe el inventario de Moriah (Productos → Importar de Excel) y aquí salen ordenados por lo que más se vende."
        : "Para ordenarlos por lo que más se vende, corra supabase/v15_mas_vendidos.sql en Supabase y vuelva a importar el inventario de Moriah. Mientras tanto use «Todos sin foto».")
      : "No falta ninguna foto en este grupo."}</li>`;
    $("#btnMasFotos").hidden = FT.ids.length <= FT.hasta;
    $("#btnMasFotos").textContent = `Ver más (${(FT.ids.length - FT.hasta).toLocaleString("es-CR")} más)`;
  }
  function avisoFotos(txt, error = false) {
    const m = $("#fotosMsg");
    m.className = error ? "msg msg--error" : "msg"; m.textContent = txt;
  }
  function marcarActivo(id, enfocar = false) {
    FT.activo = id;
    $$("#listaFotos .foto-item").forEach((li) => li.classList.toggle("foto-item--activo", Number(li.dataset.fid) === id));
    $$("#listaFotos .foto-item").forEach((li) => {
      const z = li.querySelector(".foto-item__zona .foto-item__aviso");
      if (z && !FT.subiendo.has(Number(li.dataset.fid))) z.textContent = Number(li.dataset.fid) === id ? "Presione Ctrl + V para pegar la foto" : "Toque aquí y pegue la foto";
    });
    const li = $(`#listaFotos [data-fid="${id}"]`);
    if (li) { li.scrollIntoView({ block: "nearest" }); if (enfocar) li.querySelector(".foto-item__zona").focus({ preventScroll: true }); }
  }
  // el siguiente de la lista que todavía no tiene foto
  function siguienteSinFoto(id) {
    const i = FT.ids.indexOf(id);
    const sig = FT.ids.slice(i + 1).find((x) => !productos.find((p) => p.id === x)?.imagen_url && !FT.subiendo.has(x));
    if (sig !== undefined && FT.ids.indexOf(sig) >= FT.hasta) FT.hasta = FT.ids.indexOf(sig) + FOTOS_PAG;
    return sig ?? null;
  }
  async function ponerFoto(id, file) {
    const p = productos.find((x) => x.id === id);
    if (!p || FT.subiendo.has(id)) return;
    if (!file || !/^image\//.test(file.type)) return avisoFotos("Eso no es una foto. En Google, clic derecho sobre la foto → Copiar imagen.", true);
    if (file.size > 25 * 1024 * 1024) return avisoFotos("La foto pesa demasiado (más de 25 MB).", true);
    FT.subiendo.add(id);
    const sig = siguienteSinFoto(id);
    pintarFotos();
    if (sig !== null) marcarActivo(sig);
    avisoFotos(`Subiendo la foto de ${p.nombre}…`);
    let url = null;
    try {
      const info = {};
      url = await subirFoto(file, info);
      const anterior = p.imagen_url;
      const { error } = await db.from("productos").update({ imagen_url: url }).eq("id", id);
      if (error) throw error;
      p.imagen_url = url;
      if (anterior) borrarFoto(anterior).catch(() => {});
      if (Math.min(info.ancho, info.alto) < 300) FT.chicas.add(id); else FT.chicas.delete(id);
      avisoFotos(`Listo: ${p.nombre}.${sig !== null ? " Ya puede buscar la del siguiente." : ""}`);
    } catch (e) {
      if (url) borrarFoto(url).catch(() => {});
      avisoFotos(`No se pudo poner la foto de ${p.nombre}: ${errTxt(e)}`, true);
      FT.activo = id;
    } finally {
      FT.subiendo.delete(id);
      pintarFotos();
      pintarProductos();
    }
  }
  $("#btnFotos").addEventListener("click", () => {
    FT.modo = hayVendidos() || V15 ? "vendidos" : "todos";
    $$("#fotosModo [data-fm]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.fm === FT.modo)));
    armarListaFotos();
    avisoFotos("");
    pintarFotos();
    $("#dlgFotos").showModal();
  });
  $("#fotosModo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fm]");
    if (!b || b.dataset.fm === FT.modo) return;
    FT.modo = b.dataset.fm;
    $$("#fotosModo [data-fm]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    armarListaFotos(); avisoFotos(""); pintarFotos();
  });
  $("#btnMasFotos").addEventListener("click", () => { FT.hasta += FOTOS_PAG; pintarFotos(); });
  $("#dlgFotos").addEventListener("click", async (e) => {
    if (e.target.closest("[data-cerrar-fotos]")) {
      if (FT.subiendo.size && !await preguntar("Todavía se está subiendo una foto. ¿Cerrar de todos modos?")) return;
      $("#dlgFotos").close();
      return;
    }
    const b = e.target.closest("[data-buscar]");
    if (b) { marcarActivo(Number(b.dataset.buscar)); return; }   // el enlace se abre en otra pestaña
    const z = e.target.closest("[data-zona]");
    if (z) marcarActivo(Number(z.dataset.zona), true);
  });
  $("#dlgFotos").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-archivo]");
    if (!inp || !inp.files[0]) return;
    const id = Number(inp.dataset.archivo);
    marcarActivo(id);
    ponerFoto(id, inp.files[0]);
    inp.value = "";
  });
  $("#dlgFotos").addEventListener("keydown", (e) => {
    const z = e.target.closest?.("[data-zona]");
    if (z && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); marcarActivo(Number(z.dataset.zona)); }
  });
  // arrastrar un archivo de la compu sobre el producto
  $("#listaFotos").addEventListener("dragover", (e) => { if (e.target.closest("[data-zona]")) e.preventDefault(); });
  $("#listaFotos").addEventListener("drop", (e) => {
    const z = e.target.closest("[data-zona]");
    if (!z) return;
    e.preventDefault();
    const id = Number(z.dataset.zona), f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
    marcarActivo(id);
    if (f) ponerFoto(id, f);
    else avisoFotos("Arrastrar desde Google no trae la foto. Mejor: clic derecho sobre la foto → Copiar imagen, y aquí Ctrl + V.", true);
  });
  // Ctrl + V en cualquier parte de la ventana: va al producto marcado
  document.addEventListener("paste", (e) => {
    if (!$("#dlgFotos").open) return;
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === "file" && /^image\//.test(i.type));
    if (!img) {
      if (items.length) avisoFotos("Lo que copió no es la foto (parece un enlace o texto). En Google: clic derecho sobre la foto → Copiar imagen.", true);
      return;
    }
    e.preventDefault();
    if (FT.activo === null) return avisoFotos("Primero toque el producto al que va la foto.", true);
    ponerFoto(FT.activo, img.getAsFile());
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
  $("#dlgAjuste").addEventListener("click", async (e) => {
    if (!e.target.closest("[data-cerrar-ajuste]")) return;
    if ([...AJ.values()].some(cambiaAJ) && !await preguntar("Hay precios sin guardar. ¿Cerrar de todos modos?")) return;
    $("#dlgAjuste").close();
  });
  $("#btnGuardarAjuste").addEventListener("click", async () => {
    const cambios = [...AJ.values()].filter(cambiaAJ);
    for (const f of cambios) {
      if (!/^[0-9]{1,10}(\.[0-9]{1,2})?$/.test(String(Number(f.nuevo)))) return toast(`Revise el precio de ${f.p.nombre}.`, true);
    }
    const sube = cambios.filter((f) => f.p.precio != null && Number(f.nuevo) > Number(f.p.precio)).length;
    if (!await preguntar(`¿Cambiar ${cambios.length} ${cambios.length === 1 ? "precio" : "precios"}${sube ? ` (${sube} suben)` : ""}? Queda anotado en Movimientos.`)) return;
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
    if (d.actividad) d.actividad = d.actividad.replace(/[^0-9.]/g, "");
    ["identificacion", "canton", "distrito", "telefono", "sucursal", "terminal", "cabys_envio"].forEach((k) => { if (d[k]) d[k] = U.soloDigitos(d[k]); });
    if (d.canton) d.canton = d.canton.padStart(2, "0");
    if (d.distrito) d.distrito = d.distrito.padStart(2, "0");
    d.sucursal = (d.sucursal || "001").padStart(3, "0"); d.terminal = (d.terminal || "00002").padStart(5, "0");
    if (d.ambiente === "produccion" && FE?.ambiente !== "produccion" &&
        !await preguntar("En producción cada tiquete y factura es real ante Hacienda. ¿Pasar a producción?")) return;
    msg.className = "msg"; msg.textContent = "Guardando…";
    const { data, error } = await db.from("fe_emisor").update(d).eq("id", 1).select("*").single();
    if (error) {
      msg.className = "msg msg--error";
      msg.textContent = /check constraint/i.test(error.message || "") ? "Revise los datos: algún campo no tiene el formato correcto (cédula, actividad como en TRIBU-CR (ej. 6201.0), cantón y distrito de 2, teléfono de 8, CABYS de 13)." : errTxt(error);
      return;
    }
    FE = data; pintarConfFE();
    copia.poner("fe", { activo: FE.activo, ambiente: FE.ambiente, identificacion: FE.identificacion, sucursal: FE.sucursal,
      terminal: FE.terminal, cabys_envio: FE.cabys_envio, tipo_id: FE.tipo_id, nombre: FE.nombre });
    prepararFESinRed();
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

  // cobrar: se elige la forma de pago con botones grandes y solo se pide lo que hace falta
  const AUTO_VERIF = ["efectivo", "tarjeta"];          // la plata está en la mano: queda verificado solo
  const CON_REF = ["sinpe", "transferencia", "cheque", "anterior"];
  const ETQ_CHIP = { efectivo: "Efectivo", sinpe: "SINPE", tarjeta: "Tarjeta", transferencia: "Transferencia", cheque: "Cheque", anterior: "Abonado en Moriah" };
  function chipsCobro() {
    const f = $("#formPago"), box = $("#cobroMetodos");
    const ops = [...f.metodo.options].map((o) => o.value).filter((v) => !["cheque", "anterior"].includes(v));
    if (box.dataset.ops === ops.join()) return;
    box.dataset.ops = ops.join();
    box.innerHTML = ops.map((v) => `<button type="button" role="radio" class="cobro__chip${v === "anterior" ? " cobro__chip--sec" : ""}" data-metodo="${v}">${ETQ_CHIP[v] || v}</button>`).join("");
  }
  // cuánto falta y qué botón de guardar se ve; se llama cada vez que cambian los productos
  function refrescarCobro(total) {
    if (!V || !V.items) return;
    const p = V.pedido, fp = $("#formPago");
    if (total === undefined) total = V.items.reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0);
    const saldo = Math.max(0, Math.round((total - devueltoVenta() - (Number(p?.pagado_registrado) || 0)) * 100) / 100);
    // a crédito no se cobra: primero se guarda a crédito y después, si quiere, se recibe un abono
    const cred = V.cond === "credito", pend = !V.copia && p?.estado !== "anulada" && saldo >= 0.005;
    const credListo = cred && !!p && !!p.credito && !V.dirty && !V.local;
    $("#boxPago").hidden = !pend || (cred && !(credListo && V.abonoAbierto));
    $("#btnAbonar").hidden = !(pend && credListo && !V.abonoAbierto);
    $("#boxPago .cobro__tit").textContent = cred ? "Abono" : "Cobrar";
    if (fp.dataset.montoAuto !== "0") fp.monto.value = cred ? "" : saldo || "";
    pintarVuelto();
    refrescarGuardar();
  }
  function refrescarGuardar() {
    if (!V) return;
    const p = V.pedido, g = $("#btnGuardarVenta");
    const aCredito = V.cond === "credito" && (!p || !p.credito || !!V.local);
    const fuerte = aCredito || (!p && V.cond !== "contado");
    const total = V.items ? V.items.reduce((a, i) => a + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0), 0) : 0;
    g.textContent = aCredito ? `Guardar a crédito${total > 0 ? " " + fmt(total) : ""}` : p ? "Guardar cambios"
      : V.cond === "apartado" ? "Guardar apartado" : "Guardar para después";
    g.className = `btn ${aCredito ? "btn--cobrar" : fuerte ? "btn--negro" : "btn--linea"}`;
    g.hidden = !!V.copia || p?.estado === "anulada" || (!!p && !V.dirty);
  }
  $("#btnAbonar").addEventListener("click", () => {
    V.abonoAbierto = true;
    const fp = $("#formPago"); fp.dataset.montoAuto = "1"; fp.monto.value = "";
    refrescarCobro(); pintarVuelto();
    $("#boxPago").scrollIntoView({ block: "nearest", behavior: "smooth" });
    fp.monto.focus();
  });
  $("#dlgVenta").addEventListener("input", () => queueMicrotask(refrescarGuardar));
  $("#dlgVenta").addEventListener("click", () => queueMicrotask(refrescarGuardar));
  function pintarVuelto() {
    const f = $("#formPago"), monto = Number(f.monto.value) || 0, paga = Number($("#cobroPaga").value) || 0;
    const v = $("#cobroVuelto");
    if (f.metodo.value !== "efectivo" || !paga) { v.textContent = ""; v.className = "cobro__vuelto"; }
    else if (paga >= monto) { v.textContent = `Vuelto ${fmt(paga - monto)}`; v.className = "cobro__vuelto cobro__vuelto--ok"; }
    else { v.textContent = `Faltan ${fmt(monto - paga)}`; v.className = "cobro__vuelto cobro__vuelto--falta"; }
    const verbo = V?.cond === "credito" ? "Abonar" : "Cobrar";
    $("#btnGuardarPago").textContent = monto > 0 ? `${verbo} ${fmt(monto)}` : verbo;
  }
  function pintarFormaPago() {
    chipsCobro();
    const f = $("#formPago"), m = f.metodo.value, ant = m === "anterior";
    $$("#cobroMetodos .cobro__chip").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.metodo === m)));
    $("#cobroPagaLbl").hidden = m !== "efectivo";
    $("#cobroRefLbl").hidden = !CON_REF.includes(m);
    $("#pagoRefTxt").textContent = m === "cheque" ? "N.º del cheque" : ant ? "N.º de recibo de Moriah (opcional)" : "N.º de comprobante";
    $("#cobroVerLbl").hidden = AUTO_VERIF.includes(m) || ant;
    $("#pagoVerTxt").textContent = m === "cheque" ? "El banco ya pagó el cheque" : "Ya lo vi en el banco";
    $("#pagoAyuda").textContent = ant ? "Lo que ya había pagado en Moriah. Rebaja lo que debe, pero no entra en la caja."
      : m === "cheque" ? "Sin marcar, queda “por verificar” hasta que el banco lo pague."
      : CON_REF.includes(m) ? "Si todavía no lo ve en el banco, déjelo sin marcar: queda “por verificar”." : "";
    f.verificado.disabled = ant;
    if (ant || AUTO_VERIF.includes(m)) f.verificado.checked = true;
    else if (f.verificado.dataset.auto) f.verificado.checked = false;
    f.verificado.dataset.auto = (ant || AUTO_VERIF.includes(m)) ? "1" : "";
    pintarVuelto();
  }
  $("#cobroMetodos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-metodo]");
    if (!b) return;
    $("#formPago").metodo.value = b.dataset.metodo;
    pintarFormaPago();
    const r = $("#formPago").referencia;
    if (!$("#cobroRefLbl").hidden && !r.value) r.focus();
    else if (b.dataset.metodo === "efectivo") $("#cobroPaga").focus();
  });
  $("#formPago").monto.addEventListener("input", (e) => { e.currentTarget.form.dataset.montoAuto = "0"; pintarVuelto(); });
  $("#cobroPaga").addEventListener("input", pintarVuelto);
  $("#formPago").metodo.addEventListener("change", pintarFormaPago);

  $("#btnLeerBanco").addEventListener("click", () => {
    const d = leerMensajeBanco($("#txtBanco").value), f = $("#formPago");
    const leidos = Object.keys(d);
    leidos.forEach((k) => { if (f.elements[k] && d[k]) f.elements[k].value = d[k]; });
    pintarFormaPago();
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
    const f = e.currentTarget, msg = $("#pagoMsg");
    msg.className = "msg msg--error";
    const d = {
      pedido_id: null,
      metodo: f.metodo.value,
      monto: Number(f.monto.value),
      referencia: f.referencia.value.trim().replace(/\s+/g, "") || null,
      telefono_origen: f.telefono_origen.value.trim() || null,
      nombre_origen: f.nombre_origen.value.trim() || null,
      fecha: f.fecha.value ? localCRaISO(f.fecha.value) : null,
      verificado: f.verificado.checked || AUTO_VERIF.includes(f.metodo.value)
    };
    const oid = crypto.randomUUID();
    if (!(d.monto > 0)) { msg.textContent = "Escriba el monto del pago."; return; }
    if (d.metodo === "cheque" && !d.referencia) { msg.textContent = "Ponga el número del cheque: así no se registra dos veces."; f.referencia.focus(); return; }
    if (["sinpe", "transferencia"].includes(d.metodo) && !d.referencia) { msg.textContent = "Para SINPE o transferencia, el número de comprobante es obligatorio: así se evita usar el mismo comprobante dos veces."; f.referencia.focus(); return; }
    if (d.metodo === "anterior") d.verificado = true;
    if (d.referencia && !/^[0-9A-Za-z-]{4,40}$/.test(d.referencia)) { msg.textContent = "El comprobante solo lleva números, letras o guiones."; return; }
    if (d.telefono_origen && !/^[0-9 +()-]{8,20}$/.test(d.telefono_origen)) { msg.textContent = "Revise el teléfono que pagó."; return; }
    if (!d.fecha) { msg.textContent = "Indique la fecha del pago."; return; }
    const saldo = actualizarTotal() - (Number(V.pedido?.pagado_registrado) || 0);
    if (d.monto > saldo + 0.001 && !await preguntar(`El monto (${fmt(d.monto)}) es mayor que lo que falta (${fmt(Math.max(0, saldo))}). ¿Cobrar igual?`)) return;
    // una sola pregunta: si la venta no está guardada, se guarda junto con el cobro
    const guardarPrimero = !V.pedido || V.dirty;
    const COMO = { efectivo: "en efectivo", tarjeta: "con tarjeta", sinpe: "por SINPE", transferencia: "por transferencia", cheque: "con cheque", anterior: "como abonado en Moriah" };
    let pregunta = d.metodo === "anterior" ? `¿Anotar ${fmt(d.monto)} como abonado en Moriah? Rebaja lo que debe esta venta, pero no entra en la caja de hoy.`
      : d.verificado && !AUTO_VERIF.includes(d.metodo) ? (d.metodo === "cheque" ? `¿Confirma que el banco ya pagó el cheque ${d.referencia} por ${fmt(d.monto)}?`
        : `¿Confirma que ve ${fmt(d.monto)} con el comprobante ${d.referencia || "(sin número)"} en la app del banco?`)
      : null;
    const paga = Number($("#cobroPaga").value) || 0;
    const vuelto = d.metodo === "efectivo" && paga > d.monto ? `\nVuelto: ${fmt(paga - d.monto)}` : "";
    if (guardarPrimero) pregunta = `Se guarda la venta y se cobran ${fmt(d.monto)} ${COMO[d.metodo] || ""}.${vuelto}` + (pregunta ? "\n\n" + pregunta : "");
    if (pregunta && !await preguntar(pregunta, { titulo: guardarPrimero ? "¿Cobrar la venta?" : "", si: guardarPrimero ? `Cobrar ${fmt(d.monto)}` : "Sí, seguir", cobrar: guardarPrimero })) return;
    // al guardar la venta el formulario se vuelve a pintar: lo que falta se toma antes
    const archivoSel = f.comprobante.files[0] || null, compId = f.dataset.compId || null, rutaComp = f.dataset.ruta || null;
    if (guardarPrimero && !(await guardarVenta())) return;
    const p = V.pedido;
    d.pedido_id = p.id;
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
    // sin internet: queda en la compu y se manda solo al volver la conexión
    const pagoSinRed = () => {
      const { pedido_id, ...pago } = d;
      const usada = d.referencia && acciones.leer().some((a) => a.tipo === "pago" && a.datos.metodo === d.metodo && String(a.datos.referencia || "").toUpperCase() === d.referencia.toUpperCase());
      if (usada) { msg.textContent = "¡Alerta! Ese comprobante ya está anotado en otro pago hecho sin internet."; return; }
      const a = acciones.agregar("pago", pago, { id: oid, venta: { id: p.id }, desc: `Pago de ${fmt(d.monto)} (${ETQ_METODO[d.metodo] || d.metodo}) · ${p.codigo} · ${p.cliente_nombre}` });
      if (!a) { msg.textContent = "No hay espacio en esta compu para guardarlo."; return; }
      f.reset(); $("#txtBanco").value = "";
      toast("Sin internet: pago anotado en esta compu. Se envía solo cuando vuelva la conexión.");
      aplicarPendientesVenta(); pintarVenta(); cargarVentas(); pintarBandaRed();
    };
    if (!enLinea()) {
      if (!V19) { msg.textContent = "Para cobrar ventas ya enviadas sin internet falta correr supabase/v19_sin_internet.sql."; return; }
      if (archivoSel) { msg.textContent = "Sin internet no se puede subir la foto del comprobante: quítela o súbala cuando vuelva la conexión."; return; }
      return pagoSinRed();
    }

    const btn = $("#btnGuardarPago");
    btn.disabled = true; msg.textContent = "";
    try {
      if (rutaComp) d.comprobante_path = rutaComp;
      const r = await db.from("pagos").insert(V19 ? { ...d, offline_id: oid } : d).select("id").single();
      if (r.error) {
        if (r.error.code === "23505") {
          const dup = await db.from("pagos").select("pedidos(codigo,cliente_nombre)").ilike("referencia", d.referencia).eq("anulado", false).limit(1).maybeSingle();
          const ped = dup.data?.pedidos;
          throw new Error(`¡Alerta! Ese comprobante ya está registrado${ped ? ` en la venta ${ped.codigo} (${ped.cliente_nombre})` : ""}. No se puede usar dos veces.`);
        }
        throw r.error;
      }
      if (compId) {
        const u = await db.from("comprobantes_cliente").update({ estado: "registrado", pago_id: r.data.id }).eq("id", compId);
        if (u.error) toast("El pago quedó registrado, pero no se pudo marcar el comprobante del cliente: " + errTxt(u.error), true);
      }
      const archivo = rutaComp ? null : archivoSel;
      if (archivo) {
        try {
          const ruta = await subirComprobante(archivo);
          const u = await db.from("pagos").update({ comprobante_path: ruta }).eq("id", r.data.id);
          if (u.error) throw u.error;
        } catch (err2) { toast("Pago registrado, pero la foto no se subió: " + errTxt(err2), true); }
      }
      $("#txtBanco").value = "";
      toast(d.verificado ? `Cobrado ${fmt(d.monto)}` : "Cobro anotado. Queda por verificar en el banco.");
      await abrirVenta(p.id);
      cargarVentas(); contarPorVerificar();
      // pagada: lo siguiente es el comprobante
      const sig = ["#btnFETiquete", "#btnFEFactura"].map((x) => $(x)).find((b) => b && !b.hidden && !b.disabled && b.offsetParent);
      if (sig) { sig.scrollIntoView({ block: "center", behavior: "smooth" }); sig.focus({ preventScroll: true }); }
    } catch (err) {
      if (U.esErrorRed(err) && V19 && !compId && !archivoSel) { sinSenal(err); btn.disabled = false; delete d.comprobante_path; return pagoSinRed(); }   // se cayó la señal
      msg.textContent = errTxt(err);
    } finally { btn.disabled = false; }
  });

  async function verificarPago(id, monto, ref) {
    if (!await preguntar(`¿Confirma que ve ${fmt(monto)}${ref ? ` con el comprobante ${ref}` : ""} en la app del banco?`)) return false;
    // un pago anotado sin internet: se marca antes de mandarlo
    if (String(id).startsWith("acc:")) {
      const a = acciones.leer().find((x) => x.id === String(id).slice(4));
      if (a) acciones.guardar({ ...a, datos: { ...a.datos, verificado: true } });
      toast("Pago marcado como visto en el banco. Se envía al volver la conexión.");
      return true;
    }
    if (!enLinea()) {
      const v = V?.pedido;
      acciones.agregar("verificar", { pago_id: Number(id), monto: Number(monto) }, { venta: v?.id ? { id: v.id } : undefined,
        desc: `Pago de ${fmt(monto)} visto en el banco${ref ? ` (comprobante ${ref})` : ""}${v?.codigo ? ` · ${v.codigo}` : ""}` });
      toast("Sin internet: queda anotado que lo vio en el banco. Se envía al volver la conexión.");
      pintarBandaRed();
      return true;
    }
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
    if (!enLinea()) {
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
    ["clientes", "id"], ["abonos", "id"], ["caja_turnos", "id"], ["caja_movimientos", "id"],
    ["entradas", "id"], ["entrada_items", "id"], ["inventario_movimientos", "id"],
    ["ajustes_inventario", "id"], ["ajuste_items", "id"], ["proveedores", "id"], ["pagos_proveedor", "id"], ["fe_recibidos", "id"]
  ];

  function pintarUltimoRespaldo() {
    const t = leerLS(LS_RESPALDO, null), el = $("#respaldoUltimo");
    if (!t) { el.textContent = "Todavía no se ha hecho un respaldo en esta compu."; el.classList.add("msg--error"); return; }
    const dias = Math.floor((Date.now() - t) / 864e5);
    el.textContent = `Último respaldo en esta compu: ${fechaCR(new Date(t).toISOString(), { dateStyle: "long", timeStyle: "short" })}${dias ? ` (hace ${dias} ${dias === 1 ? "día" : "días"})` : " (hoy)"}.${dias >= 30 ? " Ya toca hacer otro." : ""}`;
    el.classList.toggle("msg--error", dias >= 30);
  }

  // la primera página dice cuántas hay; las demás se piden de 4 en 4 a la vez
  async function leerTabla(tabla, orden, progreso, filtro) {
    const P = 1000;
    const pag = (desde, conteo) => {
      const q = db.from(tabla).select("*", conteo ? { count: "exact" } : undefined);
      return (filtro ? filtro(q) : q).order(orden).range(desde, desde + P - 1);
    };
    const pri = await pag(0, true);
    if (pri.error) throw pri.error;
    const total = pri.count ?? pri.data.length;
    let n = pri.data.length;
    progreso?.(n, total);
    const paginas = [pri.data];
    if (pri.data.length === P && total > P) {
      const desdes = [];
      for (let d = P; d < total; d += P) desdes.push(d);
      for (let i = 0; i < desdes.length; i += 4) {
        const res = await Promise.all(desdes.slice(i, i + 4).map(async (d) => {
          const r = await pag(d);
          if (r.error) throw r.error;
          n += r.data.length; progreso?.(n, total);
          return r.data;
        }));
        paginas.push(...res);
      }
      // si mientras tanto agregaron productos, se trae el resto
      let desde = desdes.length ? desdes[desdes.length - 1] + P : P;
      while (paginas[paginas.length - 1].length === P) {
        const r = await pag(desde); if (r.error) throw r.error;
        if (!r.data.length) break;
        paginas.push(r.data); desde += P;
      }
    }
    // por si una fila se repite entre páginas (cambios mientras se leía)
    const vistos = new Set();
    return paginas.flat().filter((f) => (f.id == null || !vistos.has(f.id)) && (f.id == null || vistos.add(f.id)));
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
    if (!enLinea()) return toast("Sin internet: el respaldo se hace cuando vuelva la conexión.", true);
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
        const csv = t === "fe_documentos" ? filas.map(({ xml_firmado, respuesta_xml, datos, ...r }) => r)
          : t === "fe_recibidos" ? filas.map(({ xml, xml_firmado, respuesta_xml, lineas, ...r }) => r) : filas;
        archivos.push({ nombre: `tablas/${t}.csv`, datos: aCsv(csv) });
      }
      for (const d of tablas.fe_documentos || []) {
        const carpeta = `comprobantes-electronicos/${d.ambiente}/${String(d.fecha_emision).slice(0, 7)}`;
        archivos.push({ nombre: `${carpeta}/${d.clave}.xml`, datos: d.xml_firmado });
        if (d.respuesta_xml) archivos.push({ nombre: `${carpeta}/${d.clave}-respuesta.xml`, datos: d.respuesta_xml });
      }
      for (const d of tablas.fe_recibidos || []) {
        const carpeta = `facturas-recibidas/${String(d.fecha_emision).slice(0, 7)}`;
        archivos.push({ nombre: `${carpeta}/${d.clave}.xml`, datos: d.xml });
        if (d.xml_firmado) archivos.push({ nombre: `${carpeta}/${d.clave}-mi-respuesta.xml`, datos: d.xml_firmado });
        if (d.respuesta_xml) archivos.push({ nombre: `${carpeta}/${d.clave}-respuesta-hacienda.xml`, datos: d.respuesta_xml });
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
        // cada foto con su versión chica (si la tiene; si falta, no cuenta como error)
        const fotosProd = (tablas.productos || []).map((p) => p.imagen_url).filter((u) => u && /\/storage\/v1\/object\/public\/productos\//.test(u))
          .flatMap((u) => (U.fotoMini(u) === u ? [[u, false]] : [[u, false], [U.fotoMini(u), true]]));
        for (const [u, esMini] of fotosProd) {
          msg.textContent = "Copiando fotos de productos…";
          let ok = false;
          try { const r = await fetch(u); if (r.ok) { archivos.push({ nombre: `fotos/productos/${u.split("/").pop()}`, datos: new Uint8Array(await r.arrayBuffer()) }); ok = true; } } catch { /* abajo */ }
          if (ok) fotosOk++; else if (!esMini) fotosMal++;
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
    if (!enLinea()) { txt.textContent = "Sin internet: el espacio se puede ver cuando vuelva la conexión."; return; }
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
    if (!await preguntar(`¿Borrar del sistema ${enZip.length} fotos de comprobantes? Los pagos quedan registrados; solo se borran las imágenes. Asegúrese de haber guardado el ZIP.`)) return;
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
    if (b.dataset.verificar) {
      if (V.local) {
        // pago de una venta hecha sin internet: se marca dentro de la venta guardada
        if (!await preguntar(`¿Confirma que ve ${fmt(b.dataset.monto)}${b.dataset.ref ? ` con el comprobante ${b.dataset.ref}` : ""} en la app del banco?`)) return;
        const rec = cola.buscar(V.local), i = Number(b.dataset.verificar);
        if (rec && rec.venta.pagos[i]) { rec.venta.pagos[i].verificado = true; rec.error = null; cola.guardar(rec); abrirLocal(rec.id); pintarVentas(); }
        return;
      }
      if (!(await verificarPago(b.dataset.verificar, b.dataset.monto, b.dataset.ref))) return;
      if (enLinea() && !String(b.dataset.verificar).startsWith("acc:")) await abrirVenta(V.pedido.id);
      else { aplicarPendientesVenta(); pintarVenta(); }
      cargarVentas();
    }
    if (b.dataset.anularPago) {
      const motivo = await pedirTexto("Motivo de la anulación del pago (queda registrado):");
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
      $("#boxPago").hidden = false;
      fp.querySelector(".cobro__mas").open = true;
      fp.metodo.value = "sinpe";
      pintarFormaPago();
      if (c.monto_reportado) fp.monto.value = c.monto_reportado;
      pintarVuelto();
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
      const motivo = await pedirTexto("¿Por qué se rechaza este comprobante? El cliente verá el motivo en “Mi pedido”.");
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
    if (p.apartado && Number(p.pagado_verificado) < Number(p.total))
      return toast(`Este apartado no está pagado completo (falta ${fmt(p.total - p.pagado_verificado)} pagado y verificado). Se entrega cuando termine de pagar.`, true);
    if (p.pagado_verificado < p.total && !await preguntar(`Esta venta no está pagada y verificada por completo (falta ${fmt(p.total - p.pagado_verificado)}). ¿Marcarla entregada igual?`)) return;
    if (!enLinea() || V.local) {
      if (V.dirty) return toast("Primero guarde los cambios de la venta.", true);
      acciones.agregar("entregar", {}, { venta: refVenta(), desc: `Entregar ${p.codigo} · ${p.cliente_nombre}` });
      toast(V.local ? "Entregada. Se envía junto con la venta." : "Sin internet: entregada. Se envía al volver la conexión.");
      if (V.local) abrirLocal(V.local); else { aplicarPendientesVenta(); pintarVenta(); }
      cargarVentas(); pintarVentas(); pintarBandaRed();
      return;
    }
    const { error } = await db.from("pedidos").update({ estado: "entregada" }).eq("id", p.id);
    if (error) return toast(errTxt(error), true);
    toast("Venta entregada");
    await abrirVenta(p.id); cargarVentas();
  });

  // Ventas: se anulan (si tienen tiquete o factura electrónica, con nota de crédito).
  // Borrar solo lo puede el administrador (v16), sin pagos ni comprobante electrónico, y queda en la bitácora.
  function puedeBorrarVenta() {
    const p = V?.pedido;
    if (V?.local) return esAdministradorReal();
    if (!p || V.copia || V.pedido?.pendiente) return false;
    if (!V16) return p.estado === "abierta" && V.pagos.length === 0;
    return esAdministradorReal() && V.pagos.length === 0 && !(V.fe || []).length && !V.factura;
  }
  // tiquete o factura electrónica de la venta que todavía no tiene nota de crédito
  function feSinNota() {
    const docs = V.fe || [];
    return docs.find((d) => ["01", "04"].includes(d.tipo) && d.estado !== "rechazado" && !d.anulado
      && !docs.some((n) => n.tipo === "03" && n.referencia_id === d.id && n.estado !== "rechazado")) || null;
  }
  $("#btnAnularVenta").addEventListener("click", async () => {
    if (!enLinea() || V.local) {
      if (V.dirty) return toast("Primero guarde los cambios de la venta.", true);
      const conFE = (V10 && feSinNota()) || fePendientes().length;
      const motivo = await pedirTexto(conFE ? "Esta venta tiene comprobante electrónico: la nota de crédito se hace sola cuando vuelva la conexión (y Hacienda haya aceptado el comprobante). Después se anula la venta.\n\n¿Por qué se anula?"
        : "¿Por qué se anula esta venta? (queda registrado)");
      if (motivo === null) return;
      if (motivo.trim().length < 5) return toast("Escriba el motivo (al menos 5 letras).", true);
      const p = V.pedido;
      acciones.agregar("anular", { motivo: motivo.trim().slice(0, 300) }, { venta: refVenta(), desc: `Anular ${p.codigo} · ${p.cliente_nombre}: ${motivo.trim().slice(0, 60)}` });
      toast(V.local ? "Anulada. Se envía junto con la venta." : "Sin internet: la anulación se envía al volver la conexión.");
      if (V.local) abrirLocal(V.local); else { aplicarPendientesVenta(); pintarVenta(); }
      cargarVentas(); pintarVentas(); pintarBandaRed();
      return;
    }
    const doc = V10 ? feSinNota() : null;
    if (doc && doc.estado !== "aceptado") {
      return toast(`Hacienda todavía no ha aceptado ${doc.tipo === "01" ? "la factura electrónica" : "el tiquete electrónico"} de esta venta. Cuando lo acepte, se anula con nota de crédito.`.replace("Cuando lo acepte", doc.tipo === "01" ? "Cuando la acepte" : "Cuando lo acepte"), true);
    }
    const motivo = await pedirTexto(doc ? `Esta venta tiene ${doc.tipo === "01" ? "factura electrónica" : "tiquete electrónico"} N.º ${numeroFE(doc)}: se anula con una nota de crédito por el total (la ve Hacienda).\n\n¿Por qué se anula?`
      : "¿Por qué se anula esta venta? (queda registrado)");
    if (motivo === null) return;
    if (motivo.trim().length < 5) return toast("Escriba el motivo (al menos 5 letras).", true);
    if (doc) {
      const nc = await accionFE({ accion: "anular", documento_id: doc.id, motivo: motivo.trim().slice(0, 180) }, "Emitiendo la nota de crédito…");
      if (!nc || nc.tipo !== "03" || nc.estado === "rechazado") return toast("No se pudo hacer la nota de crédito, así que la venta no se anuló. Vea el mensaje en Comprobante electrónico.", true);
    }
    const { error } = await db.from("pedidos").update({ estado: "anulada", motivo_anulacion: motivo.trim().slice(0, 300) }).eq("id", V.pedido.id);
    if (error) return toast(errTxt(error), true);
    toast("Venta anulada");
    refrescarExistencias(V.items.map((i) => i.producto_id));
    await abrirVenta(V.pedido.id); cargarVentas();
  });

  $("#btnBorrarVenta").addEventListener("click", async () => {
    if (V.local) {
      if (!await preguntar("¿Borrar esta venta hecha sin internet? Todavía no se ha enviado, así que se pierde.")) return;
      cola.quitar(V.local);
      $("#dlgVenta").close();
      toast("Venta borrada");
      pintarVentas(); estadoRedPanel();
      return;
    }
    let error;
    if (V16) {
      const motivo = await pedirTexto("Borrar la venta la quita del sistema; queda solo en la bitácora con todo lo que tenía.\n\n¿Por qué se borra? (si fue una venta real, mejor anúlela)");
      if (motivo === null) return;
      if (motivo.trim().length < 5) return toast("Escriba el motivo (al menos 5 letras).", true);
      ({ error } = await db.rpc("borrar_venta", { p_pedido: V.pedido.id, p_motivo: motivo.trim().slice(0, 300) }));
    } else {
      if (!await preguntar("¿Borrar esta venta? No tiene pagos.")) return;
      ({ error } = await db.from("pedidos").delete().eq("id", V.pedido.id));
    }
    if (error) return toast(errTxt(error), true);
    $("#dlgVenta").close();
    toast("Venta borrada");
    refrescarExistencias(V.items.map((i) => i.producto_id));
    cargarVentas();
  });

  // ---------- caja SINPE ----------
  async function contarPorVerificar() {
    if (!enLinea()) return;
    let count = 0;
    try { ({ count } = await db.from("pagos").select("id", { count: "exact", head: true }).eq("verificado", false).eq("anulado", false)); } catch { return; }
    $("#badgeCaja").hidden = !count;
    $("#badgeCaja").textContent = count || "";
  }

  async function cargarCaja() {
    cargarTurno();
    if (!enLinea()) {
      $("#resumenCaja").innerHTML = `<p class="ayuda">Sin internet: los SINPE del día y los pendientes de verificar se ven cuando vuelva la conexión. Puede verificar desde cada venta.</p>`;
      $("#listaPorVerificar").innerHTML = $("#listaPagosDia").innerHTML = `<li class="vacio-adm">Sin internet.</li>`;
      return;
    }
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
        <b>${g.referencia ? "Comp. " + U.esc(g.referencia) : g.abono_id ? U.esc(g.nota || "Abono " + g.abono_id) : "Sin comprobante"}</b>
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
  // las facturas y clientes usan palabras; el emisor usa los códigos de Hacienda
  const TIPO_ID = { fisica: "Cédula física", juridica: "Cédula jurídica", dimex: "DIMEX", nite: "NITE", "01": "Cédula física", "02": "Cédula jurídica", "03": "DIMEX", "04": "NITE" };
  (function () {
    let guardado = null;
    try { guardado = localStorage.getItem("lc_papel"); } catch { /* sin almacenamiento */ }
    $("#papel").value = PAPELES[guardado] ? guardado : "80";
  })();
  $("#papel").addEventListener("change", (e) => { try { localStorage.setItem("lc_papel", e.target.value); } catch { /* sin almacenamiento */ } });

  function reciboHTML(extra = {}) {
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
    // comprobantes electrónicos que salieron de esta venta (los rechazados no cuentan)
    const feDocs = FE ? (V.fe || []).filter((d) => d.ambiente === FE.ambiente && d.estado !== "rechazado").concat(fePendientes().map(docSinRed)) : [];
    const feFactura = feDocs.some((d) => d.tipo === "01");
    let electronico = "";
    if (feDocs.length) {
      electronico = `<div class="r-lin"></div>` + feDocs.map((d) => {
        const rec = d.tipo === "01" && d.receptor ? d.receptor : null;
        return `<div class="r-tit">${U.esc(FE_TIPO[d.tipo] || "Comprobante electrónico")}${d.anulado ? " (anulado)" : ""}</div>
          ${fila("N.º", `<b>${U.esc(numeroFE(d))}</b>`)}
          ${fila("Emitido", fechaCR(d.fecha_emision, { dateStyle: "short", timeStyle: "short" }))}
          ${rec ? `<div>${U.esc(rec.nombre)}</div><div class="r-peq">${U.esc(TIPO_ID[rec.tipo_id] || rec.tipo_id)} ${U.esc(rec.identificacion)}</div>${rec.correo ? `<div class="r-peq">${U.esc(rec.correo)}</div>` : ""}` : ""}
          ${d.tipo !== "03" ? fila("Condición", p.credito ? `Crédito${p.vence ? ` a ${Math.max(1, diasEntre(String(p.created_at).slice(0, 10), p.vence))} días` : ""}` : "Contado") : ""}
          ${Number(d.impuesto) > 0 ? fila("IVA incluido", fmt(d.impuesto)) : ""}
          <div class="r-peq">Consecutivo</div><div class="r-clave">${U.esc(d.consecutivo)}</div>
          <div class="r-peq">Clave</div><div class="r-clave">${U.esc(d.clave)}</div>
          ${d.sinRed || String(d.clave).charAt(41) === "3" ? `<div class="r-peq">Emitido sin internet${d.sinRed ? ": pendiente de envío a Hacienda" : ""}</div>` : ""}
          ${d.sinRed ? "" : `<div class="r-peq">${U.esc((FE_ESTADO[d.estado] || [d.estado])[0])}</div>`}`;
      }).join(`<div class="r-sep"></div>`);
    }
    // venta a crédito: a quién se le fía, cuándo vence y cómo queda su cuenta
    let credito = "";
    if (p.credito && p.estado !== "anulada") {
      const cli = extra.cuenta || V.credCli;
      credito = `<div class="r-lin"></div><div class="r-tit">Venta a crédito</div>
        ${cli ? `<div>${U.esc(cli.nombre)}</div>${cli.identificacion ? `<div class="r-peq">${U.esc(TIPO_ID[cli.tipo_id] || cli.tipo_id)} ${U.esc(cli.identificacion)}</div>` : ""}` : ""}
        ${p.vence ? fila("Vence", `<b>${U.esc(String(p.vence).slice(0, 10).split("-").reverse().join("/"))}</b>`) : ""}
        ${extra.cuenta ? fila("Saldo total de la cuenta", fmt(extra.cuenta.saldo)) + (Number(extra.cuenta.vencido) > 0 ? fila("<b>Vencido</b>", `<b>${fmt(extra.cuenta.vencido)}</b>`) : "") : ""}
        <div class="r-firma">Recibí conforme</div>`;
    }
    // apartado: hasta cuándo se le guarda y que se entrega al terminar de pagar
    let apartado = "";
    if (p.apartado && p.estado === "abierta") {
      apartado = `<div class="r-lin"></div><div class="r-tit">Apartado</div>
        ${p.apartado_vence ? fila("Se le guarda hasta", `<b>${U.esc(String(p.apartado_vence).slice(0, 10).split("-").reverse().join("/"))}</b>`) : ""}
        <div class="r-peq">La mercadería se entrega cuando se cancele el total.</div>`;
    }
    let factura = "";
    if (fac && !feFactura) {
      factura = `<div class="r-lin"></div><div class="r-tit">Datos para factura electrónica</div>
        <div>${U.esc(fac.nombre)}</div>
        <div>${U.esc(TIPO_ID[fac.tipo_id] || fac.tipo_id)} ${U.esc(fac.identificacion)}</div>
        ${fac.correo ? `<div class="r-peq">${U.esc(fac.correo)}</div>` : ""}
        ${fac.consecutivo ? fila("Consecutivo", U.esc(fac.consecutivo)) : ""}
        ${fac.clave ? `<div class="r-peq">Clave</div><div class="r-clave">${U.esc(fac.clave)}</div>` : ""}
        <div class="r-peq">Estado: ${U.esc(ETQ_FAC[fac.estado] || fac.estado)}</div>`;
    }
    const valeFactura = fac && fac.estado === "aceptada";
    const pie = feDocs.length && FE.ambiente === "pruebas" ? "Ambiente de pruebas: estos comprobantes no tienen validez ante Hacienda."
      : feDocs.length || valeFactura ? "" : "Comprobante de venta. No es factura electrónica.";
    return `
      <div class="r-cab">
        <img class="r-logo" src="assets/img/marca.png" alt="" />
        <b class="r-neg">${U.esc(C.NEGOCIO)}</b>
        <span class="r-peq">${U.esc(aj.direccion || C.DIRECCION)}</span>
        ${tels ? `<span class="r-peq">Tel. ${tels}</span>` : ""}
        ${feDocs.length && FE.identificacion ? `<span class="r-peq">${U.esc(FE.nombre)}</span><span class="r-peq">${U.esc(TIPO_ID[FE.tipo_id] || FE.tipo_id)} ${U.esc(FE.identificacion)}</span>` : ""}
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
      ${apartado}
      ${credito}
      ${electronico}
      ${factura}
      <div class="r-lin"></div>
      ${pie ? `<div class="r-centro r-peq">${pie}</div>` : ""}
      <div class="r-centro"><b>¡Gracias por su compra!</b></div>
      <div class="r-centro r-peq">Impreso ${fechaCR(new Date().toISOString(), { dateStyle: "short", timeStyle: "short" })}</div>`;
  }

  // espera a que cargue el estilo del papel y el logo antes de mandar a imprimir
  const esperar = (el, ok) => new Promise((res) => { if (ok) return res(); const t = setTimeout(res, 2500); el.addEventListener("load", () => { clearTimeout(t); res(); }, { once: true }); el.addEventListener("error", () => { clearTimeout(t); res(); }, { once: true }); });

  // imprime cualquier recibo (venta o cierre de caja) en el papel escogido
  async function imprimirHTML(html) {
    const papel = PAPELES[$("#papel").value] ? $("#papel").value : "80";
    const css = $("#papelCss"), cambia = css.getAttribute("href") !== PAPELES[papel];
    const listoCss = esperar(css, !cambia);
    if (cambia) css.setAttribute("href", PAPELES[papel]);
    const r = $("#recibo");
    r.innerHTML = html;
    const img = r.querySelector("img");
    await Promise.all([listoCss, img ? esperar(img, img.complete) : null]);
    window.print();
  }
  // saldo al día del cliente de crédito, para ponerlo en el recibo (si no hay internet, sale sin él)
  async function cuentaParaRecibo() {
    const p = V.pedido;
    if (!V13 || !p?.credito || !p.cliente_id || V.local || !enLinea()) return null;
    try {
      const r = await Promise.race([
        db.from("v_clientes_credito").select("nombre,tipo_id,identificacion,saldo,vencido").eq("id", p.cliente_id).maybeSingle(),
        new Promise((res) => setTimeout(() => res({ error: "tiempo" }), 4000))
      ]);
      return r.error ? null : r.data;
    } catch { return null; }
  }
  $("#btnImprimir").addEventListener("click", async () => {
    if (!V || !V.pedido) return;
    if (V.dirty) { toast("Primero guarde los cambios de la venta.", true); return; }
    const b = $("#btnImprimir");
    b.disabled = true;
    try { await imprimirHTML(reciboHTML({ cuenta: await cuentaParaRecibo() })); }
    finally { b.disabled = false; }
  });

  // ---------- turno y cierre de caja ----------
  let TURNO = null, TURNO_RES = null, CIERRES = [];
  const BILLETES = [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5];
  const difTxt = (d) => (Math.abs(d) < 0.005 ? "cuadró" : d > 0 ? `sobró ${fmt(d)}` : `faltó ${fmt(-d)}`);
  const horaCR = (iso) => fechaCR(iso, { timeStyle: "short" });
  async function cargarTurno() {
    if (!V14) return;
    if (!enLinea()) return pintarCajaSinRed();
    let data, error;
    try { ({ data, error } = await conTiempo(db.from("caja_turnos").select("*").order("abierta_at", { ascending: false }).limit(31), 15000)); } catch (e) { error = e; }
    if (error && U.esErrorRed(error)) { sinSenal(error); return pintarCajaSinRed(); }
    if (error) return toast(errTxt(error), true);
    TURNO = data.find((t) => t.estado === "abierta") || null;
    CIERRES = data.filter((t) => t.estado === "cerrada");
    const ult = CIERRES[0];
    if (!TURNO) {
      $("#turnoEstado").innerHTML = "La caja está <b>cerrada</b>." + (ult ? ` Último cierre: ${fechaCR(ult.cerrada_at, { dateStyle: "medium", timeStyle: "short" })} (${difTxt(Number(ult.diferencia))}).` : "");
      $("#formAbrirCaja").hidden = false; $("#turnoAbierto").hidden = true;
      $("#formAbrirCaja").fondo.placeholder = ult ? String(Math.round(Number(ult.efectivo_contado))) : "20000";
    } else {
      const hoy = String(TURNO.abierta_at).slice(0, 10) === new Date().toISOString().slice(0, 10);
      $("#turnoEstado").innerHTML = `Abierta desde <b>${fechaCR(TURNO.abierta_at, hoy ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" })}</b> · fondo ${fmt(TURNO.fondo)}`;
      $("#formAbrirCaja").hidden = true; $("#turnoAbierto").hidden = false;
      const { data: r, error: e2 } = await db.rpc("resumen_caja", { p_turno: TURNO.id });
      if (e2) return toast(errTxt(e2), true);
      TURNO_RES = r; pintarTurno(r);
    }
    pintarCierres();
    // copia para seguir sin internet (lo que se cobre después se suma desde la compu)
    copia.poner("caja", { turno: TURNO, res: TURNO_RES, cierres: CIERRES.slice(0, 10), t: Date.now() });
    // lo hecho sin internet en la caja que todavía no llega
    if (acciones.leer().some((a) => a.tipo.startsWith("caja_"))) pintarCajaSinRed(true);
  }

  // ---------- caja sin internet ----------
  // Parte de la copia de la última conexión y le suma lo hecho en esta compu que todavía no se envía:
  // apertura, entradas/salidas, cierre, ventas y pagos. Las cifras son aproximadas hasta que todo llegue.
  function cajaSinRed() {
    const c = copia.leer().caja || {};
    let turno = c.turno ? { ...c.turno } : null, res = c.res ? JSON.parse(JSON.stringify(c.res)) : null;
    const cierres = [...(c.cierres || [])];
    const vacio = (fondo) => ({ fondo, ventas: { cantidad: 0, total: 0, a_credito: 0, de_contado: 0, apartados: 0, anuladas: 0 },
      pagos: { efectivo: 0, sinpe: 0, sinpe_sin_verificar: 0, tarjeta: 0, transferencia: 0, cheque: 0, cheques: 0, abonos_credito: 0, cantidad: 0, total: 0 },
      entradas: 0, salidas: 0, movimientos: [], efectivo_esperado: fondo });
    const sumarPago = (g, fecha) => {
      if (!turno || !res || new Date(fecha) < new Date(turno.abierta_at) || g.metodo === "anterior") return;
      const m = Number(g.monto) || 0, k = g.metodo, p = res.pagos;
      p[k] = Number(p[k] || 0) + m; p.total = Number(p.total || 0) + m; p.cantidad = Number(p.cantidad || 0) + 1;
      if (k === "sinpe" && !g.verificado) p.sinpe_sin_verificar = Number(p.sinpe_sin_verificar || 0) + m;
      if (k === "cheque") p.cheques = Number(p.cheques || 0) + 1;
    };
    const cuentaLoDemas = () => {
      for (const r of cola.leer()) {
        if (!turno || new Date(r.venta.fecha) < new Date(turno.abierta_at)) continue;
        const t = totalesLocal(r.venta);
        res.ventas.cantidad = Number(res.ventas.cantidad || 0) + 1; res.ventas.total = Number(res.ventas.total || 0) + t.total;
        for (const g of r.venta.pagos || []) sumarPago(g, g.fecha || r.venta.fecha);
      }
      for (const a of acciones.leer()) {
        if (a.tipo === "pago") sumarPago(a.datos, a.datos.fecha || a.cuando);
        if (a.tipo === "abono") { sumarPago(a.datos, a.datos.fecha || a.cuando); if (turno && new Date(a.datos.fecha || a.cuando) >= new Date(turno.abierta_at)) res.pagos.abonos_credito = Number(res.pagos.abonos_credito || 0) + Number(a.datos.monto); }
      }
    };
    let contado = false;
    for (const a of acciones.leer().filter((x) => x.tipo.startsWith("caja_"))) {
      if (a.tipo === "caja_abrir") { turno = { id: null, local: true, estado: "abierta", abierta_at: a.cuando, fondo: Number(a.datos.fondo) }; res = vacio(Number(a.datos.fondo)); }
      if (a.tipo === "caja_mover" && res) {
        res.movimientos.push({ tipo: a.datos.tipo, monto: Number(a.datos.monto), motivo: a.datos.motivo, fecha: a.cuando, local: true });
        if (a.datos.tipo === "entrada") res.entradas = Number(res.entradas) + Number(a.datos.monto); else res.salidas = Number(res.salidas) + Number(a.datos.monto);
      }
      if (a.tipo === "caja_cerrar" && turno) {
        cierres.unshift({ ...turno, id: null, local: true, estado: "cerrada", cerrada_at: a.cuando, resumen: a.datos.resumen || res, efectivo_esperado: a.datos.esperado,
          efectivo_contado: a.datos.contado, diferencia: Number(a.datos.contado) - Number(a.datos.esperado), conteo: a.datos.conteo, nota: a.datos.nota });
        turno = null; res = null; contado = true;
      }
    }
    if (turno && res && !contado) cuentaLoDemas();
    if (res) res.efectivo_esperado = Number(res.fondo) + Number(res.pagos.efectivo || 0) + Number(res.entradas || 0) - Number(res.salidas || 0);
    return { turno, res, cierres };
  }
  function pintarCajaSinRed(conRed = false) {
    const { turno, res, cierres } = cajaSinRed();
    TURNO = turno; TURNO_RES = res; CIERRES = cierres;
    const aviso = conRed ? "Hay movimientos de caja hechos sin internet que todavía no se envían." : "Sin internet: las cifras son aproximadas (la última copia más lo hecho en esta compu) y se ajustan solas al volver la conexión.";
    if (!turno) {
      $("#turnoEstado").innerHTML = `La caja está <b>cerrada</b>. <span class="vence-pronto">${U.esc(aviso)}</span>`;
      $("#formAbrirCaja").hidden = false; $("#turnoAbierto").hidden = true;
      const ult = cierres[0];
      $("#formAbrirCaja").fondo.placeholder = ult ? String(Math.round(Number(ult.efectivo_contado))) : "20000";
    } else {
      $("#turnoEstado").innerHTML = `Abierta desde <b>${fechaCR(turno.abierta_at, { dateStyle: "short", timeStyle: "short" })}</b> · fondo ${fmt(turno.fondo)}. <span class="vence-pronto">${U.esc(aviso)}</span>`;
      $("#formAbrirCaja").hidden = true; $("#turnoAbierto").hidden = false;
      if (res) pintarTurno(res);
    }
    pintarCierres();
  }
  function pintarTurno(r) {
    const v = r.ventas, g = r.pagos;
    $("#turnoCifras").innerHTML = `
      <div><dt>Ventas</dt><dd>${fmt(v.total)}<small>${v.cantidad} ${v.cantidad === 1 ? "venta" : "ventas"}${Number(v.a_credito) > 0 ? ` · ${fmt(v.a_credito)} a crédito` : ""}${Number(v.apartados) > 0 ? ` · ${fmt(v.apartados)} en apartados` : ""}${v.anuladas ? ` · ${v.anuladas} ${v.anuladas === 1 ? "anulada" : "anuladas"}` : ""}</small></dd></div>
      <div><dt>Efectivo recibido</dt><dd>${fmt(g.efectivo)}<small>${Number(g.abonos_credito) > 0 ? `incluye abonos de crédito` : "pagos en efectivo"}</small></dd></div>
      <div><dt>SINPE Móvil</dt><dd>${fmt(g.sinpe)}<small>${Number(g.sinpe_sin_verificar) > 0 ? `<span class="vence-pronto">${fmt(g.sinpe_sin_verificar)} sin verificar</span>` : "todo verificado"}</small></dd></div>
      <div><dt>Tarjeta${Number(g.transferencia) > 0 ? " / transferencia" : ""}</dt><dd>${fmt(g.tarjeta)}<small>${Number(g.transferencia) > 0 ? `transferencias ${fmt(g.transferencia)}` : "compare con el datáfono"}</small></dd></div>
      ${Number(g.cheque) > 0 ? `<div><dt>Cheques</dt><dd>${fmt(g.cheque)}<small>${g.cheques} ${Number(g.cheques) === 1 ? "cheque" : "cheques"} · no van en el efectivo</small></dd></div>` : ""}
      <div><dt>Efectivo que debería haber</dt><dd class="cifra--clave">${fmt(r.efectivo_esperado)}<small>fondo ${fmt(r.fondo)} + efectivo ${fmt(g.efectivo)}${Number(r.entradas) ? ` + entradas ${fmt(r.entradas)}` : ""}${Number(r.salidas) ? ` − salidas ${fmt(r.salidas)}` : ""}</small></dd></div>`;
    $("#turnoMovs").innerHTML = (r.movimientos || []).map((m) => `<li>${m.tipo === "salida" ? '<span class="inv-menos">Salida</span>' : '<span class="inv-mas">Entrada</span>'} ${fmt(m.monto)} · ${U.esc(m.motivo)} · ${horaCR(m.fecha)}</li>`).join("");
  }
  function pintarCierres() {
    $("#listaCierres").innerHTML = CIERRES.map((t, i) => {
      const d = Number(t.diferencia), r = t.resumen || {};
      return `<li class="fila fila--pago">
        <div class="fila__monto"><b>${fmt(t.efectivo_contado)}</b><small>contado</small></div>
        <div class="fila__txt">
          <b>${fechaCR(t.abierta_at, { weekday: "short", day: "numeric", month: "short", timeZone: TZ })} · ${horaCR(t.abierta_at)} a ${horaCR(t.cerrada_at)}</b>
          <small>Ventas ${fmt(r.ventas?.total || 0)} · debía haber ${fmt(t.efectivo_esperado)}${t.nota ? " · " + U.esc(t.nota) : ""}</small>
          <span class="etiquetas"><span class="etq ${Math.abs(d) < 0.005 ? "etq--pagado" : "etq--error"}">${difTxt(d).replace(/^./, (c) => c.toUpperCase())}</span></span>
        </div>
        <div class="fila__acc">${t.local ? '<span class="etq etq--por_verificar">Por enviar</span>' : ""}<button type="button" class="btn btn--sm btn--linea" data-imprimir-cierre="${t.id ?? "l" + i}">Imprimir</button></div>
      </li>`;
    }).join("") || `<li class="vacio-adm">Todavía no hay cierres.</li>`;
  }
  $("#listaCierres").addEventListener("click", (e) => {
    const b = e.target.closest("[data-imprimir-cierre]"); if (!b) return;
    const k = b.dataset.imprimirCierre;
    const t = k.startsWith("l") ? CIERRES[Number(k.slice(1))] : CIERRES.find((x) => x.id === Number(k)); if (t) imprimirHTML(cierreHTML(t));
  });
  $("#btnActualizarTurno").addEventListener("click", cargarTurno);
  $("#formAbrirCaja").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, v = f.fondo.value === "" ? Number(f.fondo.placeholder) : Number(f.fondo.value);
    if (!(v >= 0)) return toast("Escriba el fondo inicial.", true);
    if (!enLinea()) {
      if (!V19) return toast("Para usar la caja sin internet falta correr supabase/v19_sin_internet.sql.", true);
      if (cajaSinRed().turno) return toast("Ya hay una caja abierta.", true);
      acciones.agregar("caja_abrir", { fondo: v }, { desc: `Abrir caja con ${fmt(v)} de fondo` });
      f.reset(); toast(`Sin internet: caja abierta con ${fmt(v)}. Se envía al volver la conexión.`);
      pintarCajaSinRed(); pintarBandaRed();
      return;
    }
    const { error } = await db.rpc("abrir_caja", { p_fondo: v });
    if (error) return toast(errTxt(error), true);
    f.reset(); toast(`Caja abierta con ${fmt(v)} de fondo`);
    cargarTurno();
  });
  $("#formMovCaja").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#movCajaMsg");
    const monto = Number(f.monto.value), motivo = f.motivo.value.trim();
    msg.className = "msg msg--error";
    if (!(monto > 0)) { msg.textContent = "Escriba el monto."; return; }
    if (motivo.length < 3) { msg.textContent = "Escriba el motivo."; return; }
    if (!enLinea()) {
      if (!V19) { msg.textContent = "Para usar la caja sin internet falta correr supabase/v19_sin_internet.sql."; return; }
      if (!cajaSinRed().turno) { msg.textContent = "Primero abra la caja."; return; }
      acciones.agregar("caja_mover", { tipo: f.tipo.value, monto, motivo }, { desc: `${f.tipo.value === "salida" ? "Salida" : "Entrada"} de caja ${fmt(monto)}: ${motivo}` });
      f.reset(); msg.textContent = ""; $("#boxMovCaja").open = false;
      toast("Sin internet: movimiento guardado. Se envía al volver la conexión.");
      pintarCajaSinRed(); pintarBandaRed();
      return;
    }
    const { error } = await db.rpc("mover_caja", { p_tipo: f.tipo.value, p_monto: monto, p_motivo: motivo });
    if (error) { msg.textContent = errTxt(error); return; }
    f.reset(); msg.textContent = ""; $("#boxMovCaja").open = false;
    toast("Movimiento de caja guardado");
    cargarTurno();
  });

  // cierre: conteo de billetes y monedas
  $("#conteoBilletes").innerHTML = BILLETES.map((b) => `<label>${b >= 1000 ? "Billete" : "Moneda"} ${fmt(b)}<input type="number" min="0" step="1" inputmode="numeric" data-billete="${b}" /></label>`).join("");
  function totalConteo() { return $$("#conteoBilletes [data-billete]").reduce((t, i) => t + (Number(i.value) || 0) * Number(i.dataset.billete), 0); }
  function pintarDiferencia() {
    const f = $("#formCierre"), r = TURNO_RES;
    if (!r || f.contado.value === "") { $("#cierreDif").innerHTML = ""; return; }
    const d = Math.round((Number(f.contado.value) - Number(r.efectivo_esperado)) * 100) / 100;
    $("#cierreDif").innerHTML = Math.abs(d) < 0.005 ? `<span class="dif--ok"><b>Cuadra</b></span>`
      : `<span class="dif--mal">${d > 0 ? "Sobran" : "Faltan"} <b>${fmt(Math.abs(d))}</b></span>`;
  }
  $("#conteoBilletes").addEventListener("input", () => { $("#formCierre").contado.value = totalConteo() || ""; pintarDiferencia(); });
  $("#formCierre").contado.addEventListener("input", pintarDiferencia);
  $("#btnCerrarCaja").addEventListener("click", async () => {
    await cargarTurno();
    if (!TURNO || !TURNO_RES) return toast("No hay una caja abierta.", true);
    const f = $("#formCierre"), r = TURNO_RES, g = r.pagos;
    f.reset(); $("#cierreMsg").textContent = "";
    $$("#conteoBilletes [data-billete]").forEach((i) => (i.value = ""));
    const lin = (a, b) => `<div><span>${a}</span><b>${b}</b></div>`;
    $("#cierreRes").innerHTML = lin("Fondo inicial", fmt(r.fondo)) + lin("Efectivo recibido", fmt(g.efectivo)) +
      (Number(r.entradas) ? lin("Entradas de efectivo", fmt(r.entradas)) : "") + (Number(r.salidas) ? lin("Salidas de efectivo", "−" + fmt(r.salidas)) : "") +
      lin("Efectivo que debería haber", fmt(r.efectivo_esperado)) +
      (Number(g.sinpe_sin_verificar) > 0 ? `<div class="cred-alerta"><span>SINPE sin verificar</span><b>${fmt(g.sinpe_sin_verificar)}</b></div>` : "") +
      (Number(g.tarjeta) > 0 ? lin("Tarjeta (compare con el cierre del datáfono)", fmt(g.tarjeta)) : "") +
      (Number(g.cheque) > 0 ? lin(`Cheques (${g.cheques}): no se cuentan con el efectivo`, fmt(g.cheque)) : "") +
      (!enLinea() ? `<div class="cred-alerta"><span>Sin internet: lo que debería haber es aproximado. El cuadre exacto queda en “Cierres anteriores” al volver la conexión.</span></div>` : "");
    pintarDiferencia();
    $("#dlgCierre").showModal();
    $("#conteoBilletes input").focus();
  });
  $("#btnCancelarCierre").addEventListener("click", () => $("#dlgCierre").close());
  $("#formCierre").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, msg = $("#cierreMsg");
    if (f.contado.value === "" || !(Number(f.contado.value) >= 0)) { msg.className = "msg msg--error"; msg.textContent = "Escriba el efectivo contado."; return; }
    const contado = Math.round(Number(f.contado.value) * 100) / 100;
    const d = Math.round((contado - Number(TURNO_RES.efectivo_esperado)) * 100) / 100;
    if (Math.abs(d) >= 0.005 && !await preguntar(`${d > 0 ? "Sobran" : "Faltan"} ${fmt(Math.abs(d))}. ¿Cerrar la caja así?`)) return;
    if (Number(TURNO_RES.pagos.sinpe_sin_verificar) > 0 && !await preguntar(`Hay ${fmt(TURNO_RES.pagos.sinpe_sin_verificar)} en SINPE sin verificar. ¿Cerrar de todos modos?`)) return;
    const conteo = {};
    $$("#conteoBilletes [data-billete]").forEach((i) => { if (Number(i.value) > 0) conteo[i.dataset.billete] = Math.round(Number(i.value)); });
    if (!enLinea()) {
      if (!V19) { msg.className = "msg msg--error"; msg.textContent = "Para cerrar la caja sin internet falta correr supabase/v19_sin_internet.sql."; return; }
      const datos = { turno: TURNO.id || null, contado, conteo: Object.keys(conteo).length ? conteo : null, nota: f.nota.value.trim() || null,
        esperado: Number(TURNO_RES.efectivo_esperado), resumen: TURNO_RES };
      acciones.agregar("caja_cerrar", datos, { desc: `Cierre de caja (contado ${fmt(contado)})` });
      $("#dlgCierre").close();
      toast(`Sin internet: caja cerrada (${difTxt(d)}, aproximado). Se envía al volver la conexión.`);
      pintarCajaSinRed(); pintarBandaRed();
      const t = CIERRES[0];
      if (t && await preguntar("¿Imprimir el cierre de caja?")) imprimirHTML(cierreHTML(t));
      return;
    }
    msg.className = "msg"; msg.textContent = "Cerrando…";
    const { error } = await db.rpc("cerrar_caja", { p_turno: TURNO.id, p_contado: contado, p_conteo: Object.keys(conteo).length ? conteo : null, p_nota: f.nota.value.trim() || null });
    if (error) { msg.className = "msg msg--error"; msg.textContent = errTxt(error); return; }
    $("#dlgCierre").close();
    toast(`Caja cerrada: ${difTxt(d)}`);
    await cargarTurno();
    const t = CIERRES[0];
    if (t && await preguntar("¿Imprimir el cierre de caja?")) imprimirHTML(cierreHTML(t));
  });
  function cierreHTML(t) {
    const r = t.resumen || {}, v = r.ventas || {}, g = r.pagos || {}, aj = ajustesCache;
    const fila = (a, b) => `<div class="r-fila"><span>${a}</span><span>${b}</span></div>`;
    const d = Number(t.diferencia);
    const conteo = t.conteo ? BILLETES.filter((b) => t.conteo[b]).map((b) => fila(`${t.conteo[b]} × ${fmt(b)}`, fmt(t.conteo[b] * b))).join("") : "";
    return `
      <div class="r-cab">
        <img class="r-logo" src="assets/img/marca.png" alt="" />
        <b class="r-neg">${U.esc(C.NEGOCIO)}</b>
        <span class="r-peq">${U.esc(aj.direccion || C.DIRECCION)}</span>
      </div>
      <div class="r-lin"></div>
      <div class="r-tit">CIERRE DE CAJA</div>
      ${t.local ? `<div class="r-peq">Hecho sin internet: las cifras son aproximadas; el cuadre exacto queda en el sistema al volver la conexión.</div>` : ""}
      ${fila("Abrió", fechaCR(t.abierta_at, { dateStyle: "short", timeStyle: "short" }))}
      ${fila("Cerró", fechaCR(t.cerrada_at, { dateStyle: "short", timeStyle: "short" }))}
      <div class="r-lin"></div>
      <div class="r-tit">Ventas</div>
      ${fila(`${v.cantidad || 0} ventas`, fmt(v.total))}
      ${Number(v.a_credito) > 0 || Number(v.apartados) > 0 ? fila("De contado", fmt(v.de_contado)) + (Number(v.a_credito) > 0 ? fila("A crédito", fmt(v.a_credito)) : "") + (Number(v.apartados) > 0 ? fila("Apartados", fmt(v.apartados)) : "") : ""}
      ${v.anuladas ? fila("Anuladas", v.anuladas) : ""}
      <div class="r-lin"></div>
      <div class="r-tit">Pagos recibidos</div>
      ${fila("Efectivo", fmt(g.efectivo))}
      ${fila("SINPE Móvil", fmt(g.sinpe))}
      ${Number(g.sinpe_sin_verificar) > 0 ? `<div class="r-peq">SINPE sin verificar: ${fmt(g.sinpe_sin_verificar)}</div>` : ""}
      ${fila("Tarjeta", fmt(g.tarjeta))}
      ${Number(g.transferencia) > 0 ? fila("Transferencia", fmt(g.transferencia)) : ""}
      ${Number(g.cheque) > 0 ? fila(`Cheques (${g.cheques})`, fmt(g.cheque)) : ""}
      ${Number(g.abonos_credito) > 0 ? `<div class="r-peq">Incluye abonos de crédito: ${fmt(g.abonos_credito)}</div>` : ""}
      <div class="r-lin"></div>
      <div class="r-tit">Efectivo</div>
      ${fila("Fondo inicial", fmt(r.fondo))}
      ${fila("+ Efectivo recibido", fmt(g.efectivo))}
      ${Number(r.entradas) ? fila("+ Entradas", fmt(r.entradas)) : ""}
      ${Number(r.salidas) ? fila("− Salidas", fmt(r.salidas)) : ""}
      ${(r.movimientos || []).map((m) => `<div class="r-peq">${m.tipo === "salida" ? "Salida" : "Entrada"} ${fmt(m.monto)}: ${U.esc(m.motivo)}</div>`).join("")}
      <div class="r-fila r-total"><span>Debía haber</span><span>${fmt(t.efectivo_esperado)}</span></div>
      ${fila("<b>Contado</b>", `<b>${fmt(t.efectivo_contado)}</b>`)}
      ${conteo ? `<div class="r-peq">Conteo:</div>${conteo}` : ""}
      ${fila(Math.abs(d) < 0.005 ? "Diferencia" : d > 0 ? "<b>Sobrante</b>" : "<b>Faltante</b>", Math.abs(d) < 0.005 ? "Cuadró" : `<b>${fmt(Math.abs(d))}</b>`)}
      ${t.nota ? `<div class="r-lin"></div><div class="r-peq">Nota: ${U.esc(t.nota)}</div>` : ""}
      <div class="r-lin"></div>
      <div class="r-centro r-peq">Firma: ______________________</div>
      <div class="r-centro r-peq">Impreso ${fechaCR(new Date().toISOString(), { dateStyle: "short", timeStyle: "short" })}</div>`;
  }

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
      // lo vendido de cada producto (columna "Monto V" de Moriah), para ordenar las fotos que faltan
      const iVend = iMoriah >= 0 && V15 ? cab.indexOf("monto v") : -1;
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
        if (iVend >= 0 && fila.codigo) {
          const raw = f.celdas[iVend], n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[\s,₡]/g, ""));
          if (Number.isFinite(n) && n >= 0 && n < 1e12) fila.vendido = Math.round(n * 100) / 100;
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
        + `${malas ? ` ${malas} con errores no se importan.` : ""} Columnas: ${mapa.map(([k]) => COLS.find((c) => c[0] === k)[1]).join(", ")}${iVend >= 0 ? " y lo vendido (Monto V)" : ""}.`;
      $("#btnHacerImport").disabled = !ok.length;
      $("#btnHacerImport").textContent = `Importar ${ok.length} ${ok.length === 1 ? "producto" : "productos"}`;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    }
  });
  $("#btnHacerImport").addEventListener("click", async () => {
    const b = $("#btnHacerImport"), msg = $("#impMsg");
    const conExist = !$("#impExistencias") || $("#impExistencias").checked;
    const filas = importacion.filter((x) => !x.error).map(({ fila: { _auto, vendido, ...f } }) => { if (!conExist) delete f.existencia; return f; });
    const vendidos = importacion.filter((x) => !x.error && x.fila.codigo && x.fila.vendido !== undefined)
      .map((x) => ({ codigo: x.fila.codigo, vendido: x.fila.vendido }));
    if (!filas.length) return;
    if (!await preguntar(`¿Importar ${filas.length} productos? Los que ya existen se actualizan con los datos del archivo.`)) return;
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
      // después de importar, cuánto se ha vendido de cada uno (si falla no se pierde la importación)
      let vendOk = true;
      for (let i = 0; i < vendidos.length; i += 5000) {
        msg.textContent = "Anotando lo más vendido…";
        const { error } = await db.rpc("anotar_vendido", { p_filas: vendidos.slice(i, i + 5000) });
        if (error) { vendOk = false; break; }
      }
      msg.className = tot.errores.length ? "msg msg--error" : "msg";
      msg.textContent = `Listo: ${tot.insertados} nuevos, ${tot.actualizados} actualizados${tot.categorias_nuevas ? `, ${tot.categorias_nuevas} categorías nuevas` : ""}.` +
        (vendidos.length ? (vendOk ? " También quedó anotado lo que más se vende (Productos → Fotos)." : " No se pudo anotar lo más vendido; vuelva a importar el archivo.") : "") +
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
