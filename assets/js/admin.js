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
    V4 = !(await db.from("avisos").select("id").limit(1)).error;
    document.documentElement.classList.toggle("sin-v4", !V4);
    $("#avisoV4").hidden = V4;
    await cargarCategorias();
    await Promise.all([cargarProductos(), cargarAjustes(), contarPorVerificar(), V4 ? cargarAvisos() : null]);
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
    if (tab.id === "tabRep") cargarReportes();
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

  const hoyCRp = () => new Intl.DateTimeFormat("en-CA", { timeZone: C.ZONA_HORARIA }).format(new Date());
  const ofertaVigente = (p) => p.precio_oferta != null && !!p.oferta_hasta && String(p.oferta_hasta) >= hoyCRp();
  let filtroProd = "todos";
  const PASA_PROD = { todos: () => true, agotados: (p) => p.agotado, ofertas: ofertaVigente, sinprecio: (p) => p.precio == null, ocultos: (p) => !p.activo };
  function pintarProductos() {
    const q = norm($("#aBuscar").value);
    const lista = productos.filter((p) => PASA_PROD[filtroProd](p) && (!q || norm(p.nombre).includes(q)));
    const cat = (id) => categorias.find((c) => c.id === id);
    $("#listaProd").innerHTML = lista.map((p) => {
      const c = cat(p.categoria_id);
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      return `<li class="fila ${p.activo ? "" : "fila--oculta"}">
        <span class="fila__img">${url ? `<img src="${U.esc(url)}" alt="" loading="lazy" />` : SIN_FOTO}</span>
        <div class="fila__txt">
          <b>${U.esc(p.nombre)}</b>
          <small>${U.esc(c?.nombre || "Sin categoría")} · ${U.colones(p.precio) ? U.esc(U.colones(p.precio)) + (p.unidad ? " por " + U.esc(p.unidad) : "") : "Precio a consultar"}</small>
          <span class="etiquetas">${p.destacado ? '<span class="etq etq--rec">Recomendado</span>' : ""}${p.activo ? "" : '<span class="etq">Oculto</span>'}${p.agotado ? '<span class="etq etq--sin_pago">Agotado</span>' : ""}${ofertaVigente(p) ? `<span class="etq etq--por_verificar">Oferta ${U.esc(U.colones(p.precio_oferta))} hasta ${U.esc(String(p.oferta_hasta).split("-").reverse().join("/"))}</span>` : p.oferta_hasta ? '<span class="etq">Oferta vencida</span>' : ""}</span>
        </div>
        <div class="fila__acc">
          ${V4 ? `<button type="button" class="btn btn--sm ${p.agotado ? "btn--negro" : "btn--linea"}" data-agotado="${p.id}">${p.agotado ? "Ya hay" : "Agotado"}</button>` : ""}
          <button type="button" class="btn btn--sm btn--linea" data-edit="${p.id}">Editar</button>
          <button type="button" class="enlace enlace--peligro" data-del="${p.id}">Borrar</button>
        </div>
      </li>`;
    }).join("") || `<li class="vacio-adm">${q || filtroProd !== "todos" ? "Ningún producto en este grupo." : "Agregue el primer producto con el botón Nuevo producto."}</li>`;
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
    const fac = V4 ? await db.from("facturas").select("*").eq("pedido_id", id).maybeSingle() : { data: null };
    V = { pedido: p.data, items: it.data.map((i) => ({ ...i })), pagos: pg.data, comps: cc.data, factura: fac.data || null, dirty: false };
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

    // entrega, listo y factura
    const ent = $("#ventaEntrega");
    ent.hidden = !p || !V4;
    if (p && V4) {
      ent.innerHTML = (p.entrega === "envio"
        ? `<b>Envío a ${U.esc(p.zona || "domicilio")}</b>${p.direccion ? ": " + U.esc(p.direccion) : ""}`
        : "<b>Retira en el almacén</b>") +
        (p.listo_at ? ` <span class="etq etq--ok">Listo desde ${fechaCR(p.listo_at, { dateStyle: "short", timeStyle: "short" })}</span>` : "");
    }
    $("#btnListo").hidden = !p || p.estado !== "abierta" || !V4;
    $("#btnListo").textContent = p?.listo_at ? "Avisar otra vez que está listo" : "Avisar que está listo";
    $("#boxFactura").hidden = !p || !V4;
    if (p && V4) pintarFactura();
    $("#btnAnularVenta").hidden = !p || p.estado === "anulada";
    $(".imprimir").hidden = !p;
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
      ? `${ETQ_FAC[fac.estado] || fac.estado}. La pidió ${fac.solicitada_por === "cliente" ? "el cliente en la página" : "el almacén"}. Emítala en su sistema de facturación y anote aquí el resultado.`
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
        <img class="r-logo" src="assets/img/emblema-redondo.png" alt="" />
        <b class="r-neg">${U.esc(C.NEGOCIO)}</b>
        <span class="r-peq">${U.esc(aj.direccion || C.DIRECCION)}</span>
        ${tels ? `<span class="r-peq">Tel. ${tels}</span>` : ""}
      </div>
      <div class="r-lin"></div>
      ${p.estado === "anulada" ? `<div class="r-anulada">ANULADA</div>` : ""}
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
    ["categoria", "Categoría", /^categoria/],
    ["precio", "Precio", /^precio( normal| colones| ₡)?$/],
    ["unidad", "Se vende por", /^(se vende por|unidad|presentacion|medida)/],
    ["descripcion", "Descripción", /^descripcion/],
    ["activo", "Mostrar", /^(mostrar|visible|activo|en el sitio)/],
    ["destacado", "Recomendado", /^(recomendado|destacado)/],
    ["agotado", "Agotado", /^agotado/],
    ["imagen_url", "Foto (enlace)", /^(foto|imagen)/]
  ];
  const ANCHOS = [44, 26, 12, 16, 50, 10, 13, 10, 50];
  function descargar(blob, nombre) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $("#btnPlantilla").addEventListener("click", () => descargar(XlsxMini.escribir([COLS.map((c) => c[1])], { hoja: "Productos", anchos: ANCHOS }), "plantilla-productos.xlsx"));
  $("#btnExportar").addEventListener("click", () => {
    const sn = (b) => (b ? "Sí" : "No"), cat = (id) => categorias.find((c) => c.id === id)?.nombre || "";
    const filas = [COLS.filter((c) => V4 || c[0] !== "agotado").map((c) => c[1])].concat(productos.map((p) => [
      p.nombre, cat(p.categoria_id), p.precio == null ? "" : Number(p.precio), p.unidad || "", p.descripcion || "",
      sn(p.activo), sn(p.destacado), ...(V4 ? [sn(p.agotado)] : []), p.imagen_url || ""]));
    descargar(XlsxMini.escribir(filas, { hoja: "Productos", anchos: V4 ? ANCHOS : ANCHOS.filter((_, i) => i !== 7) }), `productos-la-campina-${hoyCR()}.xlsx`);
  });

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
      const iCab = filas.slice(0, 6).findIndex((f) => f.celdas.some((c) => COLS[0][2].test(norm(c))));
      if (iCab < 0) throw new Error("No se encontró la columna “Nombre”. Use la plantilla o ponga los títulos en la primera fila.");
      const cab = filas[iCab].celdas.map((c) => norm(c));
      const mapa = COLS.map(([k, , re]) => [k, cab.findIndex((h) => re.test(h))]).filter(([k, i]) => i >= 0 && (V4 || k !== "agotado"));
      const existentes = new Set(productos.map((p) => norm(p.nombre)));
      const vistos = new Set();
      for (const f of filas.slice(iCab + 1)) {
        if (mapa.every(([, i]) => String(f.celdas[i] ?? "").trim() === "")) continue;     // fila vacía
        const fila = { fila: f.r };
        let error = "";
        for (const [k, i] of mapa) {
          const v = f.celdas[i] ?? "";
          if (k === "precio") { const p = leerPrecio(v); if (p.error) error = p.error; else fila.precio = p.v; }
          else if (["activo", "destacado", "agotado"].includes(k)) { const b = leerSiNo(v); if (b === null) error = `No se entiende “${v}” (use Sí o No)`; else if (b !== undefined) fila[k] = b; }
          else if (k === "imagen_url") { const u = String(v).trim(); if (u && !/^https:\/\/\S+$/.test(u)) error = "La foto debe ser un enlace que empiece con https://"; else if (u) fila.imagen_url = u; }
          else fila[k] = String(v).trim();
        }
        fila.nombre = String(fila.nombre || "").replace(/\s+/g, " ").slice(0, 100);
        if (fila.nombre.length < 2) error = error || "Falta el nombre";
        else if (vistos.has(norm(fila.nombre))) error = error || "Nombre repetido en el archivo";
        vistos.add(norm(fila.nombre));
        importacion.push({ fila, error, nuevo: !existentes.has(norm(fila.nombre)) });
      }
      const ok = importacion.filter((x) => !x.error), malas = importacion.length - ok.length;
      if (!importacion.length) throw new Error("El archivo no trae productos debajo de los títulos.");
      $("#impFilas").innerHTML = importacion.slice(0, 300).map((x) => `<tr class="${x.error ? "imp--error" : ""}">
        <td>${x.fila.fila}</td><td>${U.esc(x.fila.nombre)}</td><td>${U.esc(x.fila.categoria || "")}</td>
        <td class="num">${x.fila.precio === undefined ? "" : x.fila.precio === "" ? "a consultar" : U.esc(fmt(x.fila.precio))}</td>
        <td>${x.error ? `<b>No se importa:</b> ${U.esc(x.error)}` : x.nuevo ? "Producto nuevo" : "Actualiza el existente"}</td></tr>`).join("") +
        (importacion.length > 300 ? `<tr><td colspan="5" class="vacio-adm">… y ${importacion.length - 300} filas más</td></tr>` : "");
      $("#impVista").hidden = false;
      const nuevos = ok.filter((x) => x.nuevo).length;
      msg.textContent = `${ok.length} listos: ${nuevos} nuevos y ${ok.length - nuevos} para actualizar.${malas ? ` ${malas} con errores no se importan.` : ""} Columnas encontradas: ${mapa.map(([k]) => COLS.find((c) => c[0] === k)[1]).join(", ")}.`;
      $("#btnHacerImport").disabled = !ok.length;
      $("#btnHacerImport").textContent = `Importar ${ok.length} ${ok.length === 1 ? "producto" : "productos"}`;
    } catch (e) {
      msg.className = "msg msg--error"; msg.textContent = errTxt(e);
    }
  });
  $("#btnHacerImport").addEventListener("click", async () => {
    const b = $("#btnHacerImport"), msg = $("#impMsg");
    const filas = importacion.filter((x) => !x.error).map((x) => x.fila);
    if (!filas.length) return;
    if (!confirm(`¿Importar ${filas.length} productos? Los que ya existen se actualizan con los datos del archivo.`)) return;
    b.disabled = true;
    const tot = { insertados: 0, actualizados: 0, categorias_nuevas: 0, errores: [] };
    try {
      for (let i = 0; i < filas.length; i += 500) {
        msg.className = "msg"; msg.textContent = `Importando… ${Math.min(i + 500, filas.length)} de ${filas.length}`;
        const { data, error } = await db.rpc("importar_productos", { p_filas: filas.slice(i, i + 500) });
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

  initAcceso();
})();
