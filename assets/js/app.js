(function () {
  "use strict";
  const C = window.APP_CONFIG, db = window.db, U = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LS_CARRITO = "lc_lista_v1", LS_CLIENTE = "lc_cliente_v1";

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
      horario: C.HORARIO, horario_semana: "", facebook: C.FACEBOOK, aviso: "", sinpe_numero: "", sinpe_titular: ""
    },
    categorias: [], productos: [],
    cat: "", q: "",
    lista: [],          // [{k, id, nombre, unidad, precio, cant}]
    ultimo: null        // pedido recién enviado {codigo, tel, nombre, archivo}
  };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const waNum = () => U.soloDigitos(S.ajustes.whatsapp) || C.WHATSAPP;
  const esMovil = () => matchMedia("(max-width: 980px)").matches;
  const sinpeNum = () => { const d = U.soloDigitos(S.ajustes.sinpe_numero); return d.length === 8 ? d : ""; };

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
    else S.lista.push({ k: "p" + p.id, id: p.id, nombre: p.nombre, unidad: p.unidad || "", precio: p.precio ?? null, cant: 1 });
    cambioCarrito();
    if (esMovil()) toast(`Agregado: ${p.nombre}`);
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
    S.lista.forEach((i) => { if (i.id) { const p = S.productos.find((x) => x.id === i.id); if (p) i.precio = p.precio ?? null; } });
    guardarCarrito();
    pintarCarrito();
    pintarControles();
    const c = $("#contador");
    c.textContent = S.lista.length;
    c.classList.remove("salta"); void c.offsetWidth; c.classList.add("salta");
  }

  // ---------- datos ----------
  async function cargarDatos() {
    if (!db) { S.categorias = DEMO.categorias; S.productos = DEMO.productos; return "demo"; }
    try {
      const [a, c, p] = await Promise.all([
        db.from("ajustes").select("clave,valor"),
        db.from("categorias").select("id,nombre,orden").order("orden"),
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
    const a = S.ajustes, tel = U.soloDigitos(a.telefono);
    $$("[data-tel]").forEach((el) => (el.href = tel ? `tel:+506${tel.slice(-8)}` : U.waLink(waNum())));
    $$("[data-tel-num]").forEach((el) => (el.textContent = U.fmtTel(a.telefono)));
    $$("[data-wa]").forEach((el) => (el.href = U.waLink(waNum(), `¡Hola, ${C.NEGOCIO}! Quisiera hacer una consulta.`)));
    $$("[data-wa-num]").forEach((el) => (el.textContent = U.fmtTel(waNum())));
    $$("[data-dir]").forEach((el) => (el.textContent = a.direccion || C.DIRECCION));
    if (a.telefono2) $$("[data-tel2]").forEach((el) => (el.textContent = U.fmtTel(a.telefono2)));
    else $("#liTel2").hidden = true;
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
  function pintarChips() {
    const cont = (id) => S.productos.filter((p) => p.categoria_id === id).length;
    const chips = [{ id: "", nombre: "Todo", n: S.productos.length }]
      .concat(S.categorias.map((c) => ({ ...c, n: cont(c.id) })).filter((c) => c.n > 0));
    $("#chips").innerHTML = chips.map((c) =>
      `<button type="button" class="chip" data-cat="${U.esc(c.id)}" aria-pressed="${String(S.cat) === String(c.id)}">${U.esc(c.nombre)} <span class="chip__n">${c.n}</span></button>`
    ).join("");
  }

  const filtrados = () => {
    const q = norm(S.q);
    return S.productos.filter((p) =>
      (!S.cat || String(p.categoria_id) === String(S.cat)) &&
      (!q || norm(p.nombre + " " + (p.descripcion || "")).includes(q)));
  };

  function controlHTML(p) {
    const it = enLista(p.id);
    if (!it) return `<button type="button" class="btn-agregar" data-add="${p.id}" aria-label="Agregar ${U.esc(p.nombre)} al carrito">Agregar</button>`;
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
      const url = p.imagen_url ? U.safeUrl(p.imagen_url, "") : "";
      const precio = U.colones(p.precio);
      return `<li class="tarjeta-prod" data-id="${p.id}">
        <div class="tarjeta-prod__foto">
          ${url ? `<button type="button" data-foto="${p.id}" aria-label="Ver foto de ${U.esc(p.nombre)}"><img src="${U.esc(url)}" alt="" loading="lazy" /></button>` : SIN_FOTO}
          ${p.destacado ? '<span class="tarjeta-prod__rec">Recomendado</span>' : ""}
        </div>
        <div class="tarjeta-prod__cuerpo">
          <p class="tarjeta-prod__cat">${U.esc(catDe(p.categoria_id).nombre || "")}</p>
          <h3>${U.esc(p.nombre)}</h3>
          ${p.descripcion ? `<p class="tarjeta-prod__desc">${U.esc(p.descripcion)}</p>` : ""}
          <div class="tarjeta-prod__pie">
            ${precio ? `<p class="precio">${precio}${p.unidad ? ` <small>por ${U.esc(p.unidad)}</small>` : ""}</p>` : `<p class="precio precio--consultar">Precio a consultar</p>`}
            <span class="ctl">${controlHTML(p)}</span>
          </div>
        </div>
      </li>`;
    }).join("");
    ul.setAttribute("aria-busy", "false");
    $("#vacio").hidden = lista.length > 0;
    $("#btnAgregarLibre").textContent = S.q ? `Agregar “${S.q.slice(0, 40)}” al carrito` : "Escribirlo en el carrito";
  }

  function pintarControles() {
    $$("#lista .tarjeta-prod").forEach((li) => {
      const p = S.productos.find((x) => x.id === Number(li.dataset.id));
      if (!p) return;
      const ctl = li.querySelector(".ctl");
      const antes = document.activeElement && ctl.contains(document.activeElement) ? document.activeElement : null;
      const tipo = antes ? (antes.dataset.add ? "add" : antes.dataset.mas ? "mas" : "menos") : null;
      ctl.innerHTML = controlHTML(p);
      if (tipo) (ctl.querySelector(tipo === "add" ? "[data-mas]" : `[data-${tipo}]`) || ctl.querySelector("[data-add]"))?.focus();
    });
  }

  // ---------- carrito (proforma) ----------
  function totalEstimado() {
    let t = 0, sinPrecio = 0;
    S.lista.forEach((i) => { if (i.precio != null && i.precio > 0) t += i.precio * i.cant; else sinPrecio++; });
    return { t, sinPrecio };
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
        <span class="renglon__desc">${U.esc(i.nombre)}<small>${i.id ? (sub ? U.esc(sub) : "precio a confirmar") : "fuera del catálogo"}</small></span>
        <button type="button" class="renglon__quitar" data-quitar="${U.esc(i.k)}" aria-label="Quitar ${U.esc(i.nombre)} del carrito">✕</button>
      </li>`;
    }).join("");
    const { t, sinPrecio } = totalEstimado();
    $("#totales").hidden = !S.lista.length;
    $("#totalEstimado").textContent = t > 0 ? U.colones(t) : "A confirmar";
    $("#totalNota").textContent = sinPrecio
      ? `${sinPrecio === 1 ? "1 producto" : sinPrecio + " productos"} con precio a confirmar: le enviamos el total final.`
      : "Precios del catálogo. El almacén confirma disponibilidad.";
    const fm = $("#formEnviar").monto;
    if (!fm.dataset.tocado) fm.value = t > 0 && !sinPrecio ? t : "";
  }

  function abrirCarrito(abrir) {
    const p = $("#proforma");
    p.classList.toggle("abierta", abrir);
    $("#velo").hidden = !abrir;
    $("#btnAbrirLista").setAttribute("aria-expanded", String(abrir));
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
    err.textContent = "";
    if (f.empresa.value) { toast("Pedido enviado."); return; }    // bot

    try { localStorage.setItem(LS_CLIENTE, JSON.stringify({ nombre: d.nombre, tel: d.telefono })); } catch { /* */ }

    // Sin base de datos (modo demo): se manda por WhatsApp como antes
    if (!db) { U.abrir(U.waLink(waNum(), textoWhatsApp(d, null, false))); return; }

    btn.disabled = true;
    btn.textContent = "Enviando pedido…";
    try {
      const items = S.lista.map((i) => (i.id ? { id: i.id, c: i.cant } : { n: i.nombre, c: i.cant }));
      const r = await db.rpc("crear_pedido_web", { p_nombre: d.nombre, p_telefono: d.telefono, p_nota: d.detalle || null, p_items: items });
      if (r.error) throw new Error(r.error.message && /[áéíóúñ]|\./.test(r.error.message) ? r.error.message : "No se pudo enviar el pedido. Revise su conexión e intente de nuevo.");
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
      S.lista = [];
      f.detalle.value = ""; f.comprobante.value = ""; f.referencia.value = ""; delete f.monto.dataset.tocado;
      $("#pagoYa").open = false;
      cambioCarrito();
    } catch (e3) {
      err.textContent = e3.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  }

  function mostrarListo() {
    const u = S.ultimo, sn = sinpeNum();
    $("#pasoCarrito").hidden = true;
    $("#pasoListo").hidden = false;
    $("#listoCodigo").textContent = u.codigo;
    $("#lnkMiPedido").href = `pedido.html?c=${encodeURIComponent(u.codigo)}`;
    let txt;
    if (u.archivo) txt = "Recibimos su comprobante. Lo revisamos en el banco y le confirmamos por WhatsApp.";
    else if (u.errorComp) txt = `El pedido quedó guardado, pero el comprobante no se pudo subir (${u.errorComp}). Súbalo de nuevo en “Ver mi pedido”.`;
    else if (!u.pendientes && u.total > 0 && sn) txt = `Total: ${U.colones(u.total)}. Pague por SINPE Móvil al ${U.fmtTel(sn)}${S.ajustes.sinpe_titular ? " a nombre de " + S.ajustes.sinpe_titular : ""} y en el detalle escriba ${u.codigo}. Después suba el comprobante en “Ver mi pedido”.`;
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
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); pintarProductos(); }, 120); });
    $("#buscadorHero").addEventListener("submit", (e) => {
      e.preventDefault();
      S.q = $("#qHero").value.trim(); S.cat = "";
      $("#q").value = S.q;
      pintarChips(); pintarProductos();
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
      else if (b.dataset.quitar) { S.lista = S.lista.filter((i) => i.k !== b.dataset.quitar); cambioCarrito(); }
    });
    $("#formLibre").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = $("#libreTxt");
      if (agregarLibre(inp.value)) inp.value = "";
      inp.focus();
    });
    $("#btnAgregarLibre").addEventListener("click", () => {
      if (S.q && agregarLibre(S.q)) { toast(`Agregado: ${S.q}`); return; }
      if (esMovil()) abrirCarrito(true);
      $("#libreTxt").focus();
    });
    $("#formEnviar").monto.addEventListener("input", (e) => (e.target.dataset.tocado = "1"));
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
    $("#btnCerrarLista").addEventListener("click", () => abrirCarrito(false));
    $("#velo").addEventListener("click", () => abrirCarrito(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#proforma").classList.contains("abierta")) abrirCarrito(false); });
    matchMedia("(max-width: 980px)").addEventListener("change", (m) => { if (!m.matches) abrirCarrito(false); });
  }

  // ---------- inicio ----------
  document.addEventListener("DOMContentLoaded", async () => {
    $("#anio").textContent = new Date().getFullYear();
    cargarCarrito();
    try {
      const cli = JSON.parse(localStorage.getItem(LS_CLIENTE) || "null");
      if (cli) { $("#formEnviar").nombre.value = String(cli.nombre || "").slice(0, 80); $("#formEnviar").telefono.value = String(cli.tel || "").slice(0, 20); }
    } catch { /* */ }
    eventos();
    pintarContacto();
    const r = await cargarDatos();
    pintarContacto();
    if (r === "error") {
      $("#lista").innerHTML = "";
      $("#lista").setAttribute("aria-busy", "false");
      const v = $("#vacio");
      v.querySelector("p").innerHTML = "<strong>El catálogo no cargó.</strong> Revise su conexión o escríbanos por WhatsApp; igual puede armar su pedido a mano.";
      v.hidden = false;
    } else {
      pintarChips();
      pintarProductos();
    }
    cambioCarrito();
    $("#contador").classList.remove("salta");
  });
})();
