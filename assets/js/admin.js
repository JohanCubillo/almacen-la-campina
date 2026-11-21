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
  const errTxt = (e) => (e && e.message) || "Algo falló. Intente de nuevo.";

  // =========================================================
  //  ACCESO: contraseña → (registrar MFA) → código → panel
  // =========================================================
  async function siguientePaso() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return vista("vLogin");

    const reg = await db.rpc("soy_admin_registrado");
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

  async function salir(motivo) {
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
  async function abrirPanel(user) {
    vista("vPanel");
    $("#userEmail").textContent = user.email;
    if (panelListo) return;
    panelListo = true;
    vigilarInactividad();
    pintarDiasHorario();
    await cargarCategorias();
    await Promise.all([cargarProductos(), cargarAjustes(), contarPorVerificar()]);
    await cargarVentas();
    setInterval(() => { if (!document.hidden && !$("#dlgVenta").open) { cargarVentas(); contarPorVerificar(); } }, 60000);
  }

  // ---------- pestañas ----------
  $$(".pestana").forEach((tab) => tab.addEventListener("click", () => {
    $$(".pestana").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $$("[role=tabpanel]").forEach((p) => (p.hidden = p.id !== tab.getAttribute("aria-controls")));
    if (tab.id === "tabAj") cargarAuditoria();
    if (tab.id === "tabVen") cargarVentas();
    if (tab.id === "tabCaja") cargarCaja();
  }));
  $(".pestanas").addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    const tabs = $$(".pestana"), i = tabs.indexOf(document.activeElement);
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); n.click();
  });

  // ---------- CATEGORÍAS ----------
  async function cargarCategorias() {
    const { data, error } = await db.from("categorias").select("*").order("orden");
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
  async function cargarProductos() {
    const { data, error } = await db.from("productos").select("*").order("nombre");
    if (error) return toast(errTxt(error), true);
    productos = data;
    pintarProductos();
  }

  function pintarProductos() {
    const q = $("#aBuscar").value.trim().toLowerCase();
    const lista = productos.filter((p) => !q || p.nombre.toLowerCase().includes(q));
    const cat = (id) => categorias.find((c) => c.id === id);
    $("#listaProd").innerHTML = lista.map((p) => {
      const c = cat(p.categoria_id);
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      return `<li class="fila ${p.activo ? "" : "fila--oculta"}">
        <span class="fila__img">${url ? `<img src="${U.esc(url)}" alt="" loading="lazy" />` : SIN_FOTO}</span>
        <div class="fila__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${U.esc(c?.nombre || "Sin categoría")} · ${U.colones(p.precio) ? U.esc(U.colones(p.precio)) + (p.unidad ? " por " + U.esc(p.unidad) : "") : "Precio a consultar"}</small>
          <span class="etiquetas">${p.destacado ? '<span class="etq etq--rec">Recomendado</span>' : ""}${p.activo ? "" : '<span class="etq">Oculto</span>'}</span>
        </div>
        <div class="fila__acc">
          <button type="button" class="btn btn--sm btn--linea" data-edit="${p.id}">Editar</button>
          <button type="button" class="enlace enlace--peligro" data-del="${p.id}">Borrar</button>
        </div>
      </li>`;
    }).join("") || `<li class="vacio-adm">${q ? "Ningún producto coincide con la búsqueda." : "Agregue el primer producto con el botón Nuevo producto."}</li>`;
  }
  $("#aBuscar").addEventListener("input", pintarProductos);

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
      if (fp.foto.files[0]) { btn.textContent = "Subiendo foto…"; nuevaFoto = await subirFoto(fp.foto.files[0]); d.imagen_url = nuevaFoto; }
      const { error } = id ? await db.from("productos").update(d).eq("id", id) : await db.from("productos").insert(d);
      if (error) throw error;
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
    const { data, error } = await db.from("ajustes").select("*");
    if (error) return toast(errTxt(error), true);
    const f = $("#formAjustes");
    ajustesCache = Object.fromEntries(data.map((r) => [r.clave, r.valor || ""]));
    data.forEach((r) => { if (f.elements[r.clave] && r.clave !== "horario_semana") f.elements[r.clave].value = r.valor || ""; });
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
    const { data, error } = await db.from("pedidos")
      .select("id,codigo,origen,revisado,cliente_nombre,cliente_telefono,estado,estado_pago,total,pagado_registrado,pagado_verificado,created_at")
      .order("created_at", { ascending: false }).limit(500);
    if (error) return toast(errTxt(error), true);
    ventas = data;
    const cn = await db.from("comprobantes_cliente").select("pedido_id").eq("estado", "nuevo");
    compNuevos = new Set((cn.data || []).map((r) => r.pedido_id));
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
    $("#listaVentas").innerHTML = lista.map((v) => {
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
    }).join("") || `<li class="vacio-adm">${filtroVenta === "nuevos" ? "No hay pedidos nuevos. Los pedidos que hagan los clientes en la página aparecen aquí." : filtroVenta === "todas" ? "Todavía no hay ventas." : "No hay ventas en este grupo."}</li>`;
  }

  $("#filtroVentas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    filtroVenta = b.dataset.f;
    $$("#filtroVentas [data-f]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    pintarVentas();
  });
  $("#vBuscar").addEventListener("input", pintarVentas);
  $("#listaVentas").addEventListener("click", (e) => { const b = e.target.closest("[data-ver-venta]"); if (b) abrirVenta(Number(b.dataset.verVenta)); });
  $("#btnNuevaVenta").addEventListener("click", () => abrirBorrador({ cliente_nombre: "", cliente_telefono: "", items: [] }));

  // ---------- abrir / borrador ----------
  function abrirBorrador(b) {
    V = { pedido: null, items: b.items, pagos: [], comps: [], dirty: true };
    const f = $("#formVenta");
    f.cliente_nombre.value = b.cliente_nombre || "";
    f.cliente_telefono.value = b.cliente_telefono || "";
    f.nota.value = (b.nota || "").slice(0, 500);
    pintarVenta();
    $("#dlgVenta").showModal();
    f.cliente_nombre.focus();
  }

  async function abrirVenta(id) {
    const [p, it, pg, cc] = await Promise.all([
      db.from("pedidos").select("*").eq("id", id).single(),
      db.from("pedido_items").select("*").eq("pedido_id", id).order("id"),
      db.from("pagos").select("*").eq("pedido_id", id).order("fecha"),
      db.from("comprobantes_cliente").select("*").eq("pedido_id", id).order("id")
    ]);
    if (p.error || it.error || pg.error || cc.error) return toast(errTxt(p.error || it.error || pg.error || cc.error), true);
    V = { pedido: p.data, items: it.data.map((i) => ({ ...i })), pagos: pg.data, comps: cc.data, dirty: false };
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

  const itemsEditables = () => !V.pedido || (V.pedido.estado === "abierta" && Number(V.pedido.pagado_verificado) === 0);

  function pintarVenta() {
    const p = V.pedido, edit = itemsEditables();
    $("#ventaTitulo").textContent = p ? p.cliente_nombre : "Nueva venta";
    $("#ventaCodigo").textContent = p ? p.codigo : "";
    $("#ventaEstado").innerHTML = p
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
    $("#agregarItemSel").innerHTML = `<option value="">Agregar del catálogo…</option>` +
      productos.filter((x) => x.activo).map((x) => `<option value="${x.id}">${U.esc(x.nombre)}${x.precio != null ? " — " + fmt(x.precio) : ""}</option>`).join("");

    const cerrada = p && p.estado !== "abierta";
    $("#btnGuardarVenta").hidden = !!(p && p.estado === "anulada");
    $("#btnCobrarWa").hidden = !p || p.estado === "anulada" || (Number(p.total) > 0 && Number(p.pagado_registrado) >= Number(p.total));
    $("#ventaMsg").textContent = "";

    // comprobantes enviados por el cliente
    const etqComp = { nuevo: '<span class="etq etq--por_verificar">Nuevo</span>', registrado: '<span class="etq etq--pagado">Registrado como pago</span>', rechazado: '<span class="etq">Rechazado</span>' };
    $("#boxCompCliente").hidden = !(V.comps && V.comps.length);
    $("#compCliente").innerHTML = (V.comps || []).map((c) => `<li class="pago">
      <div class="pago__monto">${c.monto_reportado ? fmt(c.monto_reportado) : "Sin monto"}<small>según el cliente</small></div>
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

    // pagos
    $("#ventaSaldo").textContent = p ? `· Total ${fmt(p.total)} · Registrado ${fmt(p.pagado_registrado)} · Verificado ${fmt(p.pagado_verificado)}` : "";
    $("#pagosVenta").innerHTML = p ? (V.pagos.map(pagoHTML).join("") || `<li class="vacio-adm">Sin pagos registrados.</li>`) : `<li class="vacio-adm">Guarde la venta para registrar pagos.</li>`;
    $("#boxPago").hidden = !p || p.estado === "anulada";
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

    $("#btnEntregar").hidden = !p || cerrada;
    $("#btnAnularVenta").hidden = !p || p.estado === "anulada";
    $("#btnBorrarVenta").hidden = !p || p.estado !== "abierta" || V.pagos.length > 0;
  }

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
  $("#agregarItemSel").addEventListener("change", (e) => {
    const p = productos.find((x) => x.id == e.target.value);
    if (!p) return;
    const ya = V.items.find((i) => i.producto_id === p.id);
    if (ya) ya.cantidad = Number(ya.cantidad) + 1;
    else V.items.push({ producto_id: p.id, descripcion: p.nombre + (p.unidad ? ` (${p.unidad})` : ""), cantidad: 1, precio_unit: p.precio != null ? Number(p.precio) : 0 });
    V.dirty = true;
    pintarVenta();
  });
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

    const btn = $("#btnGuardarVenta");
    btn.disabled = true; msg.textContent = "";
    try {
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
    if (file.type !== "application/pdf") blob = await comprimir(file, 1600);
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

  async function verComprobante(path) {
    const { data, error } = await db.storage.from("comprobantes").createSignedUrl(path, 120);
    if (error) return toast(errTxt(error), true);
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
    await abrirVenta(V.pedido.id); cargarVentas();
  });

  $("#btnBorrarVenta").addEventListener("click", async () => {
    if (!confirm("¿Borrar esta venta? No tiene pagos.")) return;
    const { error } = await db.from("pedidos").delete().eq("id", V.pedido.id);
    if (error) return toast(errTxt(error), true);
    $("#dlgVenta").close();
    toast("Venta borrada");
    cargarVentas();
  });

  // ---------- caja SINPE ----------
  async function contarPorVerificar() {
    const { count } = await db.from("pagos").select("id", { count: "exact", head: true }).eq("verificado", false).eq("anulado", false);
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
  $("#dlgVenta").addEventListener("close", () => { if (!$("#tCaja").hidden) cargarCaja(); });

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

  initAcceso();
})();
