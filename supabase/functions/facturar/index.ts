// =====================================================================
//  Función de Supabase "facturar" — comprobantes electrónicos con Hacienda
//
//  La llama el panel (administrador, o empleado con permiso "ventas"/"anular"). Acciones (POST JSON):
//   { accion: "probar" }                                  → revisa datos y entra a Hacienda (no envía nada)
//   { accion: "emitir", pedido_id, tipo: "04"|"01", credito_dias? } → tiquete o factura de una venta
//   { accion: "consultar", documento_id }                 → pregunta el estado a Hacienda
//   { accion: "enviar", documento_id }                    → reenvía el mismo XML si no llegó
//   { accion: "anular", documento_id, motivo }            → nota de crédito que anula el comprobante
//
//  Secretos (Supabase → Edge Functions → Secrets), nunca en el código ni en la base:
//   HACIENDA_USUARIO, HACIENDA_CLAVE, HACIENDA_P12_BASE64, HACIENDA_PIN
//   (opcional) PANEL_ORIGENES = https://johancubillo.github.io
// =====================================================================
import { createClient } from "@supabase/supabase-js";
import {
  armarComprobante, armarNotaCredito, firmar, conectar, enviar, consultar, revisarEmisor,
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
  const necesario = b.accion === "probar" ? null : b.accion === "anular" ? "anular" : "ventas";
  let permitido = false;
  if (necesario) {
    const r = await usuario.rpc("puede", { p_permiso: necesario });
    permitido = r.error ? (await usuario.rpc("is_admin")).data === true : r.data === true;   // base sin v17: solo admin
  } else {
    permitido = (await usuario.rpc("is_admin")).data === true;
  }
  if (!permitido) return resp({ ok: false, error: necesario === "anular" ? "No tiene permiso para anular (nota de crédito)." : necesario ? "No tiene permiso para facturar." : "Solo el administrador." }, 403);
  const { data: quien } = await usuario.auth.getUser();
  const db = createClient(URL_SB, LLAVE_SERVICIO, { auth: { persistSession: false } });

  try {
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

    async function guardarFirmado(c: ReturnType<typeof armarComprobante>, firmado: string, pedidoId: number, receptor: unknown, referenciaId: number | null) {
      const { data, error } = await db.from("fe_documentos").insert({
        pedido_id: pedidoId, tipo: c.tipo, ambiente: em!.ambiente, clave: c.clave, consecutivo: c.consecutivo,
        fecha_emision: c.fechaEmision, receptor, total: c.total, impuesto: c.impuesto, datos: c.doc,
        xml_firmado: firmado, estado: "firmado", referencia_id: referenciaId, creado_por: quien?.user?.id ?? null,
      }).select("id,clave,tipo,fecha_emision,datos,xml_firmado,intentos,pedido_id,referencia_id").single();
      if (error) {
        if (error.code === "23505") throw new ErrorComprobante("Esta venta ya tiene un comprobante. Actualice la venta.");
        throw error;
      }
      return data;
    }

    // ---------- emitir tiquete o factura ----------
    if (b.accion === "emitir") {
      const pedidoId = Number(b.pedido_id), tipo = String(b.tipo) as "01" | "04";
      if (!(pedidoId > 0) || !["01", "04"].includes(tipo)) return resp({ ok: false, error: "Datos incompletos." }, 400);
      const { data: ya } = await db.from("fe_documentos").select("id").eq("pedido_id", pedidoId).eq("ambiente", em.ambiente)
        .in("tipo", ["01", "04"]).neq("estado", "rechazado").eq("anulado", false).maybeSingle();
      if (ya) return await devolver(ya.id);

      const { data: p, error: eP } = await db.from("pedidos").select("id,codigo,estado,cliente_nombre").eq("id", pedidoId).single();
      if (eP) throw eP;
      if (p.estado === "anulada") return resp({ ok: false, error: "La venta está anulada." });
      const { data: items, error: eI } = await db.from("pedido_items")
        .select("descripcion,cantidad,precio_unit,producto_id,productos(cabys,codigo,iva_codigo,unidad)").eq("pedido_id", pedidoId).order("id");
      if (eI) throw eI;
      const lineas: Linea[] = (items || []).map((i: Record<string, unknown>) => {
        const pr = i.productos as { cabys: string | null; codigo: string | null; iva_codigo: string; unidad: string | null } | null;
        const desc = String(i.descripcion);
        if (!pr && /^env[ií]o/i.test(desc)) {
          if (!em.cabys_envio) throw new ErrorComprobante("Falta el CABYS del servicio de envío (Datos del negocio → Facturación electrónica).");
          return { cabys: em.cabys_envio, detalle: desc, cantidad: Number(i.cantidad), precio: Number(i.precio_unit), iva_codigo: "08", servicio: true };
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
        if (!f) return resp({ ok: false, error: "Para factura, primero anote los datos del cliente en “El cliente pide factura”." });
        receptor = f;
      }
      const dias = Number(b.credito_dias || 0);
      // primero se arma y valida; el número se reserva solo si todo está bien
      armarComprobante({ tipo, numero: 1, emisor: em, lineas, pagos: pagos || [], receptor, credito: dias ? { dias } : null });
      const { data: numero, error: eN } = await db.rpc("fe_reservar", { p_ambiente: em.ambiente, p_tipo: tipo, p_sucursal: em.sucursal, p_terminal: em.terminal });
      if (eN) throw eN;
      const c = armarComprobante({ tipo, numero: Number(numero), emisor: em, lineas, pagos: pagos || [], receptor, credito: dias ? { dias } : null });
      const firmado = await firmar(c.xml, s.p12!, s.pin);
      const doc = await guardarFirmado(c, firmado, pedidoId, receptor, null);
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
