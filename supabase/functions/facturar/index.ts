// =====================================================================
//  Función de Supabase "facturar" — comprobantes electrónicos con Hacienda
//
//  La llama el panel (administrador, o empleado con permiso "ventas"/"anular"). Acciones (POST JSON):
//   { accion: "probar" }                                  → revisa datos y entra a Hacienda (no envía nada)
//   { accion: "emitir", pedido_id, tipo: "04"|"01", credito_dias? } → tiquete o factura de una venta
//   { accion: "emitir_sin_internet", pedido_id, tipo, clave, fecha, credito_dias? }
//        → el comprobante que la compu hizo sin internet (situación 3): se arma con SU clave y SU fecha,
//          se firma y se manda ahora. El número tiene que estar reservado para esa compu (fe_bloques).
//   { accion: "consultar", documento_id }                 → pregunta el estado a Hacienda
//   { accion: "enviar", documento_id }                    → reenvía el mismo XML si no llegó
//   { accion: "anular", documento_id, motivo }            → nota de crédito que anula el comprobante
//   { accion: "recibido_responder", recibido_id, mensaje: "1"|"2"|"3", detalle?, condicion?, acreditar? }
//        → acepta, acepta en parte o rechaza la factura de un proveedor (mensaje de receptor)
//   { accion: "recibido_consultar", recibido_id }  /  { accion: "recibido_enviar", recibido_id }
//   { accion: "cabys", q?, codigo? }  → busca en el catálogo CABYS de Hacienda (permiso "productos")
//
//  Secretos (Supabase → Edge Functions → Secrets), nunca en el código ni en la base:
//   HACIENDA_USUARIO, HACIENDA_CLAVE, HACIENDA_P12_BASE64, HACIENDA_PIN
//   (opcional) PANEL_ORIGENES = https://johancubillo.github.io
// =====================================================================
import { createClient } from "@supabase/supabase-js";
import {
  armarComprobante, armarNotaCredito, armarMensajeReceptor, firmar, conectar, enviar, enviarMensaje, consultar, revisarEmisor,
  ErrorComprobante, type Emisor, type Linea,
} from "./comprobante.ts";

const ORIGENES = (Deno.env.get("PANEL_ORIGENES") || "https://johancubillo.github.io").split(",").map((s) => s.trim());
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const LLAVE_PUBLICA = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const LLAVE_SERVICIO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY")!;

const cabeceras = (origen: string | null) => ({
  "Access-Control-Allow-Origin": origen && ORIGENES.includes(origen) ? origen : ORIGENES[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
});
const COLS = "id,pedido_id,tipo,ambiente,clave,consecutivo,fecha_emision,receptor,total,impuesto,estado,detalle,referencia_id,anulado,intentos,created_at,updated_at";

function secretos() {
  const p12 = Deno.env.get("HACIENDA_P12_BASE64") || "";
  return {
    usuario: Deno.env.get("HACIENDA_USUARIO") || "",
    clave: Deno.env.get("HACIENDA_CLAVE") || "",
    pin: Deno.env.get("HACIENDA_PIN") || "",
    p12: p12 ? Uint8Array.from(atob(p12.replace(/\s/g, "")), (c) => c.charCodeAt(0)) : null,
  };
}
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const corto = (e: unknown) => String((e as Error)?.message || e).replace(/\s+/g, " ").slice(0, 400);

Deno.serve(async (req) => {
  const h = cabeceras(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const resp = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: h });
  if (req.method !== "POST") return resp({ ok: false, error: "Use POST." }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return resp({ ok: false, error: "Solicitud no válida." }, 400); }

  // 1) ¿quién llama? Las mismas reglas de la base (v17): emitir y consultar → permiso "ventas";
  //    nota de crédito → "anular"; probar la conexión → solo el administrador.
  const auth = req.headers.get("Authorization") || "";
  const usuario = createClient(URL_SB, LLAVE_PUBLICA, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const accion = String(b.accion || "");
  const necesario = accion === "probar" ? null : accion === "anular" ? "anular" : accion.startsWith("recibido_") ? "compras"
    : accion === "cabys" ? "productos" : "ventas";
  let permitido = false;
  if (necesario) {
    const r = await usuario.rpc("puede", { p_permiso: necesario });
    permitido = r.error ? (await usuario.rpc("is_admin")).data === true : r.data === true;   // base sin v17: solo admin
  } else {
    permitido = (await usuario.rpc("is_admin")).data === true;
  }
  if (!permitido) return resp({ ok: false, error: necesario === "anular" ? "No tiene permiso para anular (nota de crédito)."
    : necesario === "compras" ? "No tiene permiso para contestar facturas de proveedores."
    : necesario === "productos" ? "No tiene permiso para editar productos." : necesario ? "No tiene permiso para facturar." : "Solo el administrador." }, 403);
  const { data: quien } = await usuario.auth.getUser();
  const db = createClient(URL_SB, LLAVE_SERVICIO, { auth: { persistSession: false } });

  try {
    // ---------- buscar en el catálogo CABYS (no necesita credenciales) ----------
    if (accion === "cabys") {
      const q = String(b.q || "").replace(/\s+/g, " ").trim().slice(0, 80), codigo = String(b.codigo || "").replace(/\D/g, "");
      if (!codigo && q.length < 3) return resp({ ok: false, error: "Escriba al menos 3 letras." });
      const url = codigo ? `https://api.hacienda.go.cr/fe/cabys?codigo=${codigo}` : `https://api.hacienda.go.cr/fe/cabys?q=${encodeURIComponent(q)}&top=30`;
      let r: Response;
      try { r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) }); }
      catch (e) { return resp({ ok: false, error: "No se pudo consultar el catálogo de Hacienda: " + corto(e) }); }
      if (r.status === 404) return resp({ ok: true, resultados: [] });
      if (!r.ok) return resp({ ok: false, error: `El catálogo de Hacienda respondió ${r.status}. Intente de nuevo en un rato.` });
      const j = await r.json().catch(() => null) as unknown;
      const lista = (Array.isArray(j) ? j : (j as { cabys?: unknown[] } | null)?.cabys || []) as Record<string, unknown>[];
      const resultados = lista.slice(0, 30).map((x) => ({
        codigo: String(x.codigo || ""), descripcion: String(x.descripcion || ""),
        impuesto: x.impuesto == null ? null : Number(x.impuesto),
        categorias: Array.isArray(x.categorias) ? (x.categorias as unknown[]).map(String).slice(-2) : [],
      })).filter((x) => /^[0-9]{13}$/.test(x.codigo));
      return resp({ ok: true, resultados });
    }

    const { data: emisorFila, error: eE } = await db.from("fe_emisor").select("*").eq("id", 1).maybeSingle();
    if (eE) throw eE;
    const em = emisorFila as (Emisor & { activo: boolean; ambiente: "pruebas" | "produccion"; cabys_envio: string | null }) | null;
    const faltan = revisarEmisor(em);
    const s = secretos();
    const faltanSecretos = [!s.usuario && "HACIENDA_USUARIO", !s.clave && "HACIENDA_CLAVE", !s.p12 && "HACIENDA_P12_BASE64", !s.pin && "HACIENDA_PIN"].filter(Boolean);

    // ---------- probar ----------
    if (b.accion === "probar") {
      if (faltan.length) return resp({ ok: false, error: "Faltan datos del emisor: " + faltan.join(", ") + "." });
      if (faltanSecretos.length) return resp({ ok: false, error: "Faltan secretos de la función: " + faltanSecretos.join(", ") + "." });
      // abre la llave con un comprobante de muestra (no se guarda ni se envía)
      const muestra = armarComprobante({
        tipo: "04", numero: 1, emisor: em!, pagos: [{ metodo: "efectivo", monto: 113 }],
        lineas: [{ cabys: "4612202039900", detalle: "Prueba de firma (no se envía)", cantidad: 1, precio: 113, iva_codigo: "08" }],
      });
      await firmar(muestra.xml, s.p12!, s.pin, { validar: false });
      await conectar(em!.ambiente, s.usuario, s.clave);
      return resp({ ok: true, mensaje: `Todo listo: la llave abre bien y Hacienda aceptó el usuario (${em!.ambiente === "produccion" ? "producción" : "pruebas"}).` });
    }

    // ---------- facturas de proveedores (mensaje de receptor) ----------
    // No hace falta tener encendido "Facturar desde el panel": solo los datos y las credenciales.
    if (accion.startsWith("recibido_")) {
      if (faltan.length) return resp({ ok: false, error: "Faltan datos del negocio en Facturación electrónica: " + faltan.join(", ") + "." });
      if (faltanSecretos.length) return resp({ ok: false, error: "Faltan secretos de la función: " + faltanSecretos.join(", ") + "." });
      const recId = Number(b.recibido_id);
      if (!(recId > 0)) return resp({ ok: false, error: "Falta el comprobante." }, 400);
      const COLS_REC = "id,clave,tipo_doc,emisor_tipo,emisor_id,emisor_nombre,fecha_emision,total,impuesto,ambiente,mensaje,detalle_mensaje," +
        "condicion_impuesto,impuesto_acreditar,consecutivo,fecha_respuesta,estado,detalle,intentos,entrada_id,proveedor_id,updated_at";
      type Recibido = { id: number; clave: string; tipo_doc: string; emisor_tipo: string; emisor_id: string; fecha_emision: string;
        total: number; impuesto: number; ambiente: string | null; estado: string; consecutivo: string | null; fecha_respuesta: string | null;
        intentos: number; xml_firmado: string | null };
      const { data: fila, error: eR } = await db.from("fe_recibidos").select(COLS_REC + ",xml_firmado").eq("id", recId).single();
      if (eR) throw eR;
      const rec = fila as unknown as Recibido;
      const devolverRec = async () => {
        const { data } = await db.from("v_fe_recibidos").select("*").eq("id", recId).single();
        return resp({ ok: true, recibido: data });
      };
      const llave = (r: { clave: string; consecutivo: string | null }) => `${r.clave}-${r.consecutivo}`;
      const guardarRec = (cambios: Record<string, unknown>) => db.from("fe_recibidos").update(cambios).eq("id", recId);

      async function mandar(r: Recibido, firmado: string) {
        let http;
        try { http = await conectar(em!.ambiente, s.usuario, s.clave); }
        catch (e) { await guardarRec({ estado: "error", detalle: "No se pudo entrar a Hacienda: " + corto(e) }); return; }
        try {
          await enviarMensaje(http, { clave: r.clave, fecha: String(r.fecha_respuesta), consecutivo: String(r.consecutivo),
            emisor: { tipo: r.emisor_tipo, numero: r.emisor_id }, receptor: { tipo: em!.tipo_id, numero: em!.identificacion } }, firmado);
        } catch (e) {
          const st = (e as { statusCode?: number }).statusCode;
          if (st !== 409) {
            await guardarRec({ estado: "error", intentos: r.intentos + 1, detalle: "No llegó a Hacienda: " + corto(e) + ". Use “Enviar de nuevo”." });
            return;
          }
        }
        await guardarRec({ estado: "enviado", intentos: r.intentos + 1, detalle: null });
        for (const ms of [2500, 3500, 5000]) {
          await espera(ms);
          try {
            const q = await consultar(http, llave(r));
            if (q.estado === "procesando") continue;
            await guardarRec({ estado: q.estado, respuesta_xml: q.respuestaXml,
              detalle: q.estado === "aceptado" ? null : (q.motivo || (q.estado === "rechazado" ? "Hacienda rechazó la respuesta (vea el detalle)." : null)) });
            return;
          } catch { /* se puede consultar después */ }
        }
        await guardarRec({ estado: "procesando" });
      }

      if (accion === "recibido_responder") {
        if (["firmado", "enviado", "procesando", "aceptado"].includes(rec.estado)) {
          return resp({ ok: false, error: rec.estado === "aceptado" ? "Ese comprobante ya se contestó y Hacienda lo aceptó." : "Ya se contestó; use “Consultar”." });
        }
        if (rec.tipo_doc === "04") return resp({ ok: false, error: "Los tiquetes no se aceptan ni rechazan; solo las facturas y notas." });
        const mensaje = String(b.mensaje || "") as "1" | "2" | "3";
        const op = { emisor: em!, recibido: { clave: rec.clave, emisor_id: rec.emisor_id, fecha_emision: rec.fecha_emision, total: Number(rec.total), impuesto: Number(rec.impuesto) },
                     mensaje, detalle: b.detalle ? String(b.detalle) : null, condicion: b.condicion ? String(b.condicion) : null,
                     acreditar: b.acreditar == null || b.acreditar === "" ? null : Number(b.acreditar) };
        const prueba = armarMensajeReceptor({ ...op, numero: 1 });          // revisa antes de gastar un número
        const { data: numero, error: eN } = await db.rpc("fe_reservar", { p_ambiente: em!.ambiente, p_tipo: prueba.tipo, p_sucursal: em!.sucursal, p_terminal: em!.terminal });
        if (eN) throw eN;
        const m = armarMensajeReceptor({ ...op, numero: Number(numero) });
        const firmado = await firmar(m.xml, s.p12!, s.pin);
        const d = m.datos as Record<string, unknown>;
        const { error: eG } = await guardarRec({
          ambiente: em!.ambiente, mensaje, detalle_mensaje: d.detalleMensaje ?? null, condicion_impuesto: d.condicionImpuesto ?? null,
          impuesto_acreditar: d.montoTotalImpuestoAcreditar ?? null, gasto_aplicable: d.montoTotalDeGastoAplicable ?? null,
          consecutivo: m.consecutivo, fecha_respuesta: m.fecha, xml_firmado: firmado, respuesta_xml: null,
          estado: "firmado", detalle: null, respondido_por: quien?.user?.id ?? null,
        });
        if (eG) throw eG;
        await mandar({ ...rec, ambiente: em!.ambiente, consecutivo: m.consecutivo, fecha_respuesta: m.fecha }, firmado);
        return await devolverRec();
      }
      if (rec.ambiente && rec.ambiente !== em!.ambiente) return resp({ ok: false, error: `Esa respuesta se mandó en ${rec.ambiente}; ahora está en ${em!.ambiente}.` });
      if (accion === "recibido_enviar") {
        if (!["firmado", "error"].includes(rec.estado) || !rec.xml_firmado) return resp({ ok: false, error: rec.estado === "nuevo" ? "Primero conteste (aceptar o rechazar)." : "Ya está en Hacienda; use “Consultar”." });
        await mandar(rec, rec.xml_firmado);
        return await devolverRec();
      }
      if (accion === "recibido_consultar") {
        if (!rec.consecutivo || ["nuevo", "firmado"].includes(rec.estado)) return resp({ ok: false, error: "Esa respuesta no ha llegado a Hacienda." });
        const http = await conectar(em!.ambiente, s.usuario, s.clave);
        const q = await consultar(http, llave(rec));
        await guardarRec({ estado: q.estado, respuesta_xml: q.respuestaXml,
          detalle: q.estado === "aceptado" || q.estado === "procesando" ? null : (q.motivo || null) });
        return await devolverRec();
      }
      return resp({ ok: false, error: "Acción no válida." }, 400);
    }

    if (!em?.activo) return resp({ ok: false, error: "La facturación electrónica está apagada. Enciéndala en Datos del negocio → Facturación electrónica." });
    if (faltan.length) return resp({ ok: false, error: "Faltan datos del emisor: " + faltan.join(", ") + "." });
    if (faltanSecretos.length) return resp({ ok: false, error: "Faltan secretos de la función: " + faltanSecretos.join(", ") + "." });

    // envía y consulta un documento ya firmado y guardado; deja la base al día
    async function enviarYConsultar(doc: { id: number; clave: string; tipo: string; fecha_emision: string; datos: Record<string, unknown>; xml_firmado: string; intentos: number; pedido_id: number; referencia_id: number | null }, reenviar = false) {
      let http;
      try { http = await conectar(em!.ambiente, s.usuario, s.clave); }
      catch (e) { await db.from("fe_documentos").update({ detalle: "No se pudo entrar a Hacienda: " + corto(e) }).eq("id", doc.id); throw e; }
      let estado = "enviado", detalle: string | null = null;
      try {
        await enviar(http, { clave: doc.clave, fechaEmision: doc.datos.fechaEmision as string, doc: doc.datos }, doc.xml_firmado);
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 409 || (reenviar && st === 400 && /ya.*recib|exist/i.test(corto(e)))) estado = "enviado";   // Hacienda ya lo tenía
        else {
          await db.from("fe_documentos").update({ intentos: doc.intentos + 1, detalle: "No llegó a Hacienda: " + corto(e) + ". Use “Enviar de nuevo”." }).eq("id", doc.id);
          return;
        }
      }
      await db.from("fe_documentos").update({ estado, intentos: doc.intentos + 1, detalle }).eq("id", doc.id);
      // Hacienda suele responder en unos segundos
      for (const ms of [2500, 3500, 5000]) {
        await espera(ms);
        try {
          const r = await consultar(http, doc.clave);
          if (r.estado === "procesando") continue;
          await guardarEstado(doc, r.estado, r.motivo, r.respuestaXml);
          return;
        } catch { /* se puede consultar después */ }
      }
      await db.from("fe_documentos").update({ estado: "procesando" }).eq("id", doc.id).in("estado", ["enviado"]);
    }

    async function guardarEstado(doc: { id: number; tipo: string; pedido_id: number; referencia_id: number | null }, estado: string, motivo: string | null, respuestaXml: string | null) {
      await db.from("fe_documentos").update({
        estado, respuesta_xml: respuestaXml,
        detalle: estado === "rechazado" ? (motivo || "Rechazado por Hacienda (vea la respuesta).") : estado === "aceptado" ? null : motivo,
      }).eq("id", doc.id);
      if (estado === "aceptado" && doc.tipo === "03" && doc.referencia_id) {
        await db.from("fe_documentos").update({ anulado: true }).eq("id", doc.referencia_id);
        await db.from("facturas").update({ estado: "anulada" }).eq("pedido_id", doc.pedido_id);
      }
      if (doc.tipo === "01") {
        const est = { aceptado: "aceptada", rechazado: "rechazada", error: "error" }[estado] || "enviada";
        await db.from("facturas").update({ estado: est, mensaje: estado === "rechazado" ? (motivo || "").slice(0, 500) : null }).eq("pedido_id", doc.pedido_id);
      }
    }

    async function devolver(id: number) {
      const { data } = await db.from("fe_documentos").select(COLS).eq("id", id).single();
      return resp({ ok: true, documento: data });
    }

    async function guardarFirmado(c: ReturnType<typeof armarComprobante>, firmado: string, pedidoId: number, receptor: unknown, referenciaId: number | null,
                                  extra: Record<string, unknown> = {}) {
      const { data, error } = await db.from("fe_documentos").insert({
        pedido_id: pedidoId, tipo: c.tipo, ambiente: em!.ambiente, clave: c.clave, consecutivo: c.consecutivo,
        fecha_emision: c.fechaEmision, receptor, total: c.total, impuesto: c.impuesto, datos: c.doc,
        xml_firmado: firmado, estado: "firmado", referencia_id: referenciaId, creado_por: quien?.user?.id ?? null, ...extra,
      }).select("id,clave,tipo,fecha_emision,datos,xml_firmado,intentos,pedido_id,referencia_id").single();
      if (error) {
        if (error.code === "23505") throw new ErrorComprobante("Esta venta ya tiene un comprobante. Actualice la venta.");
        throw error;
      }
      return data;
    }

    // productos, pagos y cliente de una venta, listos para el comprobante
    async function datosVenta(pedidoId: number, tipo: "01" | "04", anuladaSirve = false) {
      const { data: p, error: eP } = await db.from("pedidos").select("id,codigo,estado,cliente_nombre").eq("id", pedidoId).single();
      if (eP) throw eP;
      if (p.estado === "anulada" && !anuladaSirve) throw new ErrorComprobante("La venta está anulada.");
      const { data: items, error: eI } = await db.from("pedido_items")
        .select("descripcion,cantidad,precio_unit,producto_id,productos(cabys,codigo,iva_codigo,unidad)").eq("pedido_id", pedidoId).order("id");
      if (eI) throw eI;
      const lineas: Linea[] = (items || []).map((i: Record<string, unknown>) => {
        const pr = i.productos as { cabys: string | null; codigo: string | null; iva_codigo: string; unidad: string | null } | null;
        const desc = String(i.descripcion);
        if (!pr && /^env[ií]o/i.test(desc)) {
          if (!em!.cabys_envio) throw new ErrorComprobante("Falta el CABYS del servicio de envío (Datos del negocio → Facturación electrónica).");
          return { cabys: em!.cabys_envio, detalle: desc, cantidad: Number(i.cantidad), precio: Number(i.precio_unit), iva_codigo: "08", servicio: true };
        }
        if (!pr) throw new ErrorComprobante(`“${desc}” no es un producto del catálogo. Para facturarlo, cámbielo por el producto (con su CABYS).`);
        if (!pr.cabys) throw new ErrorComprobante(`“${desc}” no tiene CABYS. Póngaselo en Productos → Editar.`);
        // el panel agrega " (unidad)" al nombre; en el comprobante la unidad va aparte
        const sufijo = pr.unidad ? ` (${pr.unidad})` : "";
        const detalle = sufijo && desc.endsWith(sufijo) ? desc.slice(0, -sufijo.length) : desc;
        return { cabys: pr.cabys, codigo: pr.codigo, detalle, cantidad: Number(i.cantidad),
                 precio: Number(i.precio_unit), iva_codigo: pr.iva_codigo || "08", unidad: pr.unidad };
      });
      const { data: pagos } = await db.from("pagos").select("metodo,monto").eq("pedido_id", pedidoId).eq("anulado", false);
      let receptor = null;
      if (tipo === "01") {
        const { data: f } = await db.from("facturas").select("tipo_id,identificacion,nombre,correo").eq("pedido_id", pedidoId).maybeSingle();
        if (!f) throw new ErrorComprobante("Para factura, primero anote los datos del cliente en “El cliente pide factura”.");
        receptor = f;
      }
      return { lineas, pagos: pagos || [], receptor };
    }

    // ---------- emitir tiquete o factura ----------
    if (b.accion === "emitir") {
      const pedidoId = Number(b.pedido_id), tipo = String(b.tipo) as "01" | "04";
      if (!(pedidoId > 0) || !["01", "04"].includes(tipo)) return resp({ ok: false, error: "Datos incompletos." }, 400);
      const { data: ya } = await db.from("fe_documentos").select("id").eq("pedido_id", pedidoId).eq("ambiente", em.ambiente)
        .in("tipo", ["01", "04"]).neq("estado", "rechazado").eq("anulado", false).maybeSingle();
      if (ya) return await devolver(ya.id);
      const { lineas, pagos, receptor } = await datosVenta(pedidoId, tipo);
      const dias = Number(b.credito_dias || 0);
      // primero se arma y valida; el número se reserva solo si todo está bien
      armarComprobante({ tipo, numero: 1, emisor: em, lineas, pagos, receptor, credito: dias ? { dias } : null });
      const { data: numero, error: eN } = await db.rpc("fe_reservar", { p_ambiente: em.ambiente, p_tipo: tipo, p_sucursal: em.sucursal, p_terminal: em.terminal });
      if (eN) throw eN;
      const c = armarComprobante({ tipo, numero: Number(numero), emisor: em, lineas, pagos, receptor, credito: dias ? { dias } : null });
      const firmado = await firmar(c.xml, s.p12!, s.pin);
      const doc = await guardarFirmado(c, firmado, pedidoId, receptor, null);
      if (tipo === "01") await db.from("facturas").update({ clave: c.clave, consecutivo: c.consecutivo, estado: "enviada" }).eq("pedido_id", pedidoId);
      await enviarYConsultar(doc);
      return await devolver(doc.id);
    }

    // ---------- comprobante hecho sin internet (situación 3) ----------
    if (b.accion === "emitir_sin_internet") {
      const pedidoId = Number(b.pedido_id), tipo = String(b.tipo) as "01" | "04", clave = String(b.clave || "");
      if (!(pedidoId > 0) || !["01", "04"].includes(tipo) || !/^[0-9]{50}$/.test(clave)) return resp({ ok: false, error: "Datos incompletos." }, 400);
      // ya llegó antes (el envío anterior se cortó después de guardarlo)
      const { data: mismo } = await db.from("fe_documentos").select("id").eq("clave", clave).maybeSingle();
      if (mismo) return await devolver(mismo.id);
      // 506 · ddmmaa · cédula(12) · sucursal(3) · terminal(5) · tipo(2) · número(10) · situación(1) · seguridad(8)
      const sucursal = clave.slice(21, 24), terminal = clave.slice(24, 29), numero = Number(clave.slice(31, 41));
      if (clave.slice(29, 31) !== tipo || clave.charAt(41) !== "3") return resp({ ok: false, error: "La clave no es de un comprobante sin internet." }, 400);
      if (clave.slice(9, 21) !== String(em.identificacion).padStart(12, "0")) {
        return resp({ ok: false, error: "La clave tiene otra cédula de emisor: ¿se cambiaron los datos del negocio después de hacerlo?" });
      }
      const { data: bloque } = await db.from("fe_bloques").select("dispositivo").eq("terminal", terminal).eq("tipo", tipo).eq("ambiente", em.ambiente)
        .eq("sucursal", sucursal).lte("desde", numero).gte("hasta", numero).limit(1).maybeSingle();
      if (!bloque) return resp({ ok: false, error: `El número ${numero} de la terminal ${terminal} no estaba reservado para facturar sin internet (${em.ambiente}).` });
      const fecha = new Date(String(b.fecha || ""));
      if (Number.isNaN(fecha.getTime()) || fecha.getTime() > Date.now() + 10 * 60e3 || fecha.getTime() < Date.now() - 30 * 864e5) {
        return resp({ ok: false, error: "La fecha del comprobante no es válida." });
      }
      const { data: ya } = await db.from("fe_documentos").select("id,clave").eq("pedido_id", pedidoId).eq("ambiente", em.ambiente)
        .in("tipo", ["01", "04"]).neq("estado", "rechazado").eq("anulado", false).maybeSingle();
      if (ya) return resp({ ok: false, error: "Esta venta ya tiene otro comprobante electrónico; el que se hizo sin internet no se mandó." });
      // si se anuló mientras tanto, igual se manda (el cliente ya tiene su tiquete) y luego va la nota de crédito
      const { lineas, pagos, receptor } = await datosVenta(pedidoId, tipo, true);
      const dias = Number(b.credito_dias || 0);
      const c = armarComprobante({ tipo, numero, emisor: { ...em, sucursal, terminal }, lineas, pagos, receptor,
                                   credito: dias ? { dias } : null, fecha, sinInternet: { seguridad: clave.slice(42) } });
      if (c.clave !== clave) return resp({ ok: false, error: "La clave hecha sin internet no coincide con la fecha o los datos del almacén." });
      const firmado = await firmar(c.xml, s.p12!, s.pin);
      const doc = await guardarFirmado(c, firmado, pedidoId, receptor, null, { situacion: "3", dispositivo: bloque.dispositivo });
      await db.from("fe_dispositivos").update({ usado_at: new Date().toISOString() }).eq("id", bloque.dispositivo);
      if (tipo === "01") await db.from("facturas").update({ clave: c.clave, consecutivo: c.consecutivo, estado: "enviada" }).eq("pedido_id", pedidoId);
      await enviarYConsultar(doc);
      return await devolver(doc.id);
    }

    // ---------- con un documento existente ----------
    const docId = Number(b.documento_id);
    if (!(docId > 0)) return resp({ ok: false, error: "Falta el documento." }, 400);
    const { data: doc, error: eD } = await db.from("fe_documentos")
      .select("id,clave,tipo,ambiente,estado,anulado,fecha_emision,datos,xml_firmado,intentos,pedido_id,referencia_id,receptor").eq("id", docId).single();
    if (eD) throw eD;
    if (doc.ambiente !== em.ambiente) return resp({ ok: false, error: `Ese comprobante es del ambiente de ${doc.ambiente}; ahora está en ${em.ambiente}.` });

    if (b.accion === "consultar") {
      if (doc.estado === "firmado") return resp({ ok: false, error: "Ese comprobante no ha llegado a Hacienda. Use “Enviar de nuevo”." });
      const http = await conectar(em.ambiente, s.usuario, s.clave);
      const r = await consultar(http, doc.clave);
      await guardarEstado(doc, r.estado === "procesando" ? "procesando" : r.estado, r.motivo, r.respuestaXml);
      return await devolver(doc.id);
    }

    if (b.accion === "enviar") {
      if (!["firmado", "error"].includes(doc.estado)) return resp({ ok: false, error: "Ese comprobante ya está en Hacienda. Use “Consultar”." });
      await enviarYConsultar(doc, true);
      return await devolver(doc.id);
    }

    if (b.accion === "anular") {
      if (!["01", "04"].includes(doc.tipo)) return resp({ ok: false, error: "Solo se anulan tiquetes y facturas." });
      if (doc.estado !== "aceptado") return resp({ ok: false, error: "Solo se puede anular un comprobante aceptado por Hacienda." });
      if (doc.anulado) return resp({ ok: false, error: "Ese comprobante ya está anulado." });
      const { data: ncYa } = await db.from("fe_documentos").select("id").eq("referencia_id", doc.id).eq("tipo", "03").neq("estado", "rechazado").maybeSingle();
      if (ncYa) return await devolver(ncYa.id);
      const { data: p } = await db.from("pedidos").select("cliente_nombre").eq("id", doc.pedido_id).single();
      const original = { tipo: doc.tipo, clave: doc.clave, fechaEmision: doc.datos.fechaEmision as string, doc: doc.datos };
      armarNotaCredito({ numero: 1, emisor: em, original, motivo: String(b.motivo || ""), nombreCliente: p?.cliente_nombre });
      const { data: numero, error: eN } = await db.rpc("fe_reservar", { p_ambiente: em.ambiente, p_tipo: "03", p_sucursal: em.sucursal, p_terminal: em.terminal });
      if (eN) throw eN;
      const c = armarNotaCredito({ numero: Number(numero), emisor: em, original, motivo: String(b.motivo || ""), nombreCliente: p?.cliente_nombre });
      const firmado = await firmar(c.xml, s.p12!, s.pin);
      const nc = await guardarFirmado(c, firmado, doc.pedido_id, c.doc.receptor, doc.id);
      await enviarYConsultar(nc);
      return await devolver(nc.id);
    }

    return resp({ ok: false, error: "Acción no válida." }, 400);
  } catch (e) {
    if (e instanceof ErrorComprobante) return resp({ ok: false, error: e.message });
    console.error("facturar:", e);
    return resp({ ok: false, error: "No se pudo completar: " + corto(e) });
  }
});
