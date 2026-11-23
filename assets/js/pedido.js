(function () {
  "use strict";
  const C = window.APP_CONFIG, db = window.db, U = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  let actual = null;            // {codigo, tel, datos}
  let archivoCompartir = null;
  let waNum = C.WHATSAPP;

  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2800); }
  const fecha = (iso) => new Date(iso).toLocaleString("es-CR", { timeZone: C.ZONA_HORARIA, dateStyle: "medium", timeStyle: "short" });

  function textoEstado(d) {
    const envio = d.entrega === "envio", listo = !!d.listo_at;
    if (d.estado === "anulada") return ["Pedido anulado", "gris"];
    if (d.estado === "entregada") return ["Entregado. ¡Gracias por su compra!", "ok"];
    if (d.estado_pago === "pagado" || d.estado_pago === "sobrepago") {
      if (!envio) return ["Pagado. Puede pasar a recogerlo.", "ok"];
      return [listo ? "Pagado y listo: coordinamos la entrega por WhatsApp." : "Pagado. Coordinamos el envío por WhatsApp.", "ok"];
    }
    if (listo) return [envio ? "Su pedido está listo para el envío. Falta el pago." : "Su pedido está listo para recoger. Falta el pago.", "amarillo"];
    const nuevos = (d.comprobantes || []).some((c) => c.estado === "nuevo");
    if (nuevos || d.estado_pago === "por_verificar") return ["Recibimos su pago: lo estamos verificando en el banco.", "amarillo"];
    if (d.precios_pendientes) return ["Estamos preparando su cotización. Le confirmamos el total por WhatsApp.", "amarillo"];
    if (d.estado_pago === "parcial") return ["Pago parcial recibido. Falta completar el total.", "amarillo"];
    return ["Pendiente de pago.", "amarillo"];
  }

  function pintar(d) {
    $("#resultado").hidden = false;
    $("#rCliente").textContent = d.cliente;
    $("#rFecha").textContent = "Pedido del " + fecha(d.fecha);
    $("#rCodigo").textContent = d.codigo;
    const [txt, tono] = textoEstado(d);
    const est = $("#rEstado"); est.textContent = txt; est.dataset.tono = tono;
    $("#rEntrega").textContent = d.entrega === "envio" ? `Envío a domicilio${d.zona ? ": " + d.zona : ""}` : "Retiro en el almacén";
    const fac = d.factura, etqF = { pendiente: "en trámite", enviada: "enviada a Hacienda", aceptada: "emitida y enviada a su correo", rechazada: "con un problema; le escribimos", error: "con un problema; le escribimos", anulada: "anulada" };
    $("#rFactura").hidden = !fac;
    if (fac) $("#rFactura").textContent = `Factura electrónica: ${etqF[fac.estado] || fac.estado}`;

    $("#rItems").innerHTML = d.items.map((i) => `<tr>
      <td>${U.esc(Number(i.c))}</td>
      <td>${U.esc(i.d)}</td>
      <td class="num">${Number(i.p) > 0 ? U.esc(U.colones(i.p)) : "a confirmar"}</td>
      <td class="num">${Number(i.s) > 0 ? U.esc(U.colones(i.s)) : "—"}</td></tr>`).join("");
    $("#rTotal").innerHTML = Number(d.total) > 0
      ? U.esc(U.colones(d.total)) + (d.precios_pendientes ? "<small>más productos con precio por confirmar</small>" : "")
      : "A confirmar";
    $("#filaPagado").hidden = !(Number(d.pagado_verificado) > 0);
    $("#rPagado").textContent = U.colones(d.pagado_verificado);
    $("#rNota").textContent = "";

    const abierto = d.estado === "abierta" && !["pagado", "sobrepago"].includes(d.estado_pago);
    const sn = U.soloDigitos(d.sinpe_numero);
    const saldo = Math.max(0, Number(d.total) - Number(d.pagado_verificado));
    $("#cajaPagar").hidden = !(abierto && sn.length === 8);
    if (sn.length === 8) {
      $("#rComoPagar").textContent = (saldo > 0 && !d.precios_pendientes
        ? `Pague ${U.colones(saldo)} por SINPE Móvil al ${U.fmtTel(sn)}`
        : `Cuando le confirmemos el total, pague por SINPE Móvil al ${U.fmtTel(sn)}`)
        + (d.sinpe_titular ? ` a nombre de ${d.sinpe_titular}` : "") + `. En el detalle escriba ${d.codigo}. Luego suba aquí la foto del comprobante.`;
    }

    const comps = d.comprobantes || [];
    $("#cajaComprobantes").hidden = !comps.length;
    const etq = { nuevo: "Recibido, en revisión", registrado: "Registrado", rechazado: "No aceptado" };
    $("#rComprobantes").innerHTML = comps.map((c) => `<li data-estado="${U.esc(c.estado)}">
      <b>${etq[c.estado] || U.esc(c.estado)}</b> · ${fecha(c.fecha)}${c.monto ? " · " + U.esc(U.colones(c.monto)) : ""}
      ${c.estado === "rechazado" && c.motivo ? `<br><small>Motivo: ${U.esc(c.motivo)}</small>` : ""}</li>`).join("");

    $("#cajaSubir").hidden = d.estado === "anulada" || d.estado === "entregada";
    $("#formSubir").hidden = false; $("#subidoOk").hidden = true;
    const fm = $("#formSubir").monto;
    fm.value = saldo > 0 && !d.precios_pendientes ? saldo : "";
  }

  async function buscar(codigo, tel) {
    const err = $("#buscarError"), btn = $("#btnBuscar");
    err.textContent = "";
    if (!/^LC[A-Z0-9]{5,8}$/.test(codigo)) { err.textContent = "El código empieza con LC, por ejemplo LC7K2QFM."; return; }
    if (U.soloDigitos(tel).length < 8) { err.textContent = "Escriba el teléfono con el que hizo el pedido."; return; }
    if (!db) { err.textContent = "La tienda en línea no está disponible en este momento."; return; }
    btn.disabled = true;
    const { data, error } = await db.rpc("consultar_pedido", { p_codigo: codigo, p_telefono: tel });
    btn.disabled = false;
    if (error) { err.textContent = U.esErrorRed(error) ? "No hay internet. Su pedido se puede consultar cuando vuelva la conexión." : "No se pudo consultar. Intente de nuevo."; return; }
    if (!data.ok) { err.textContent = data.error; $("#resultado").hidden = true; return; }
    actual = { codigo, tel, datos: data };
    U.guardarPedidoLocal(codigo, tel);
    pintarRecientes();
    pintar(data);
    history.replaceState(null, "", `?c=${encodeURIComponent(codigo)}`);
    $("#resultado").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  function pintarRecientes() {
    const l = U.pedidosLocales();
    $("#recientes").hidden = !l.length;
    $("#listaRecientes").innerHTML = l.map((p) => `<button type="button" class="chip" data-c="${U.esc(p.codigo)}" data-t="${U.esc(p.tel)}">${U.esc(p.codigo)}</button>`).join("");
  }

  async function subir(e) {
    e.preventDefault();
    const f = e.currentTarget, err = $("#subirError"), btn = $("#btnSubir");
    const archivo = f.archivo.files[0];
    err.textContent = "";
    if (!archivo) { err.textContent = "Elija la foto o el PDF del comprobante."; return; }
    const ref = f.referencia.value.trim().replace(/\s+/g, "");
    if (ref && !/^[0-9A-Za-z-]{4,40}$/.test(ref)) { err.textContent = "El número de comprobante solo lleva números, letras o guiones."; return; }
    btn.disabled = true; btn.textContent = "Subiendo…";
    try {
      archivoCompartir = await U.subirComprobanteCliente(actual.codigo, actual.tel, archivo, { monto: f.monto.value, referencia: ref, nota: f.nota.value.trim() });
      f.reset();
      $("#formSubir").hidden = true;
      $("#subidoOk").hidden = false;
      $("#btnCompartir").hidden = !U.puedeCompartirArchivo(archivoCompartir);
      const r = await db.rpc("consultar_pedido", { p_codigo: actual.codigo, p_telefono: actual.tel });
      if (r.data?.ok) { actual.datos = r.data; const ok = $("#subidoOk"); pintar(r.data); $("#formSubir").hidden = true; ok.hidden = false; }
    } catch (e2) {
      err.textContent = e2.message;
    } finally { btn.disabled = false; btn.textContent = "Enviar comprobante"; }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const f = $("#formBuscar");
    const anio = $("#anio"); if (anio) anio.textContent = new Date().getFullYear();
    const params = new URLSearchParams(location.search);
    const cod = U.normalizarCodigo(params.get("c"));
    const locales = U.pedidosLocales();
    pintarRecientes();

    U.registrarCopia();
    const red = () => U.banda(navigator.onLine ? "" : "Sin internet. Su pedido se puede consultar cuando vuelva la conexión.");
    addEventListener("online", red); addEventListener("offline", red); red();
    if (db && navigator.onLine) {
      const a = await db.from("ajustes").select("clave,valor").in("clave", ["whatsapp"]);
      const w = a.data?.find((r) => r.clave === "whatsapp")?.valor;
      if (w) waNum = w;
    }
    $("#lnkWa").href = U.waLink(waNum, `¡Hola, ${C.NEGOCIO}! Tengo una consulta sobre mi pedido.`);

    f.codigo.addEventListener("input", () => { const p = f.codigo.selectionStart; f.codigo.value = f.codigo.value.toUpperCase(); f.codigo.setSelectionRange(p, p); });
    f.addEventListener("submit", (e) => { e.preventDefault(); buscar(U.normalizarCodigo(f.codigo.value), f.telefono.value.trim()); });
    $("#listaRecientes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-c]"); if (!b) return;
      f.codigo.value = b.dataset.c; f.telefono.value = b.dataset.t;
      buscar(b.dataset.c, b.dataset.t);
    });
    $("#formSubir").addEventListener("submit", subir);
    $("#btnCompartir").addEventListener("click", async () => {
      const r = await U.compartir(archivoCompartir, `Comprobante del pedido ${actual.codigo} — ${actual.datos.cliente}`);
      if (r === null) toast("Su teléfono no permite compartir el archivo. El comprobante ya quedó guardado en el pedido.");
    });
    $("#btnAvisar").addEventListener("click", () => U.abrir(U.waLink(waNum, `¡Hola! Subí el comprobante del pedido ${actual.codigo} a nombre de ${actual.datos.cliente}.`)));

    if (cod) {
      f.codigo.value = cod;
      const guardado = locales.find((p) => p.codigo === cod);
      if (guardado) { f.telefono.value = guardado.tel; buscar(cod, guardado.tel); }
      else f.telefono.focus();
    }
  });
})();
