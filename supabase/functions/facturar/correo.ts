// =====================================================================
//  Correo al cliente con su comprobante (PDF + XML firmado + respuesta de Hacienda)
//  Se manda solo cuando Hacienda acepta una factura (01) o una nota de crédito (03)
//  que tenga correo del cliente. Usa Resend (https://resend.com).
//
//  Secretos de la función (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY     la llave de Resend (re_…)
//   CORREO_REMITENTE   Almacén La Campiña <facturas@su-dominio.cr>   (el dominio verificado en Resend)
//   (opcional) CORREO_RESPONDER  a dónde le llegan las respuestas del cliente (ej. el Gmail del almacén)
//   (opcional) CORREO_LIMITE_MES (3000) y CORREO_LIMITE_DIA (100): los del plan de Resend
//  Sin RESEND_API_KEY o CORREO_REMITENTE no se manda nada y todo sigue igual.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { pdfComprobante, colones } from "./pdf.ts";

type Dic = Record<string, unknown>;
const env = (k: string) => (Deno.env.get(k) || "").trim();

export function correoConfigurado() {
  return !!env("RESEND_API_KEY") && !!env("CORREO_REMITENTE");
}
export function limites() {
  return { mes: Number(env("CORREO_LIMITE_MES")) || 3000, dia: Number(env("CORREO_LIMITE_DIA")) || 100 };
}

const NOMBRES: Record<string, string> = { "01": "factura electrónica", "03": "nota de crédito electrónica", "04": "tiquete electrónico" };
const corto = (e: unknown) => String((e as Error)?.message || e).replace(/\s+/g, " ").slice(0, 400);
const esc = (t: unknown) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Texto = (t: string) => base64(new TextEncoder().encode(t));

// a quién va: el correo que quedó en el comprobante
export function correoDe(doc: { datos?: Dic | null; receptor?: Dic | null }): string | null {
  const r = (doc.datos?.receptor || {}) as Dic, f = (doc.receptor || {}) as Dic;
  const c = String(r.correoElectronico || f.correo || f.correoElectronico || "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) ? c : null;
}

type Resultado = { estado: "enviado" | "error" | "sin_correo" | "sin_configurar" | "ya_enviado"; motivo?: string | null; detalle?: string | null; para?: string | null };

// manda el correo de un comprobante y anota el resultado en fe_correos
export async function enviarCorreo(db: SupabaseClient, docId: number, op: { forzar?: boolean; para?: string | null; quien?: string | null } = {}): Promise<Resultado> {
  if (!correoConfigurado()) return { estado: "sin_configurar" };
  const { data: doc, error } = await db.from("fe_documentos")
    .select("id,tipo,ambiente,estado,clave,consecutivo,total,datos,receptor,xml_firmado,respuesta_xml,pedido_id").eq("id", docId).single();
  if (error) throw error;
  if (!["01", "03", "04"].includes(doc.tipo)) return { estado: "error", detalle: "Ese comprobante no se manda por correo." };
  if (doc.estado !== "aceptado") return { estado: "error", detalle: "Se manda por correo cuando Hacienda lo acepta." };
  const para = (op.para && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(op.para) ? op.para.trim() : null) || correoDe(doc);
  if (!para) {
    if (!op.forzar) {
      const { data: ya } = await db.from("fe_correos").select("id").eq("documento_id", doc.id).limit(1);
      if (!ya?.length) await db.from("fe_correos").insert({ documento_id: doc.id, para: null, estado: "sin_correo", creado_por: op.quien ?? null });
    }
    return { estado: "sin_correo" };
  }
  if (!op.forzar) {
    const { data: ya } = await db.from("fe_correos").select("id").eq("documento_id", doc.id).eq("estado", "enviado").limit(1);
    if (ya?.length) return { estado: "ya_enviado", para };
  }

  const d = doc.datos as Dic, em = (d.emisor || {}) as Dic, rc = (d.receptor || {}) as Dic;
  const negocio = String(em.nombreComercial || em.nombre || "El almacén");
  const nombre = NOMBRES[doc.tipo] || "comprobante electrónico";
  const prueba = doc.ambiente !== "produccion";
  const asunto = `${prueba ? "[PRUEBAS] " : ""}${nombre.charAt(0).toUpperCase() + nombre.slice(1)} N.º ${doc.consecutivo} · ${negocio}`;
  const total = colones(doc.total).replace("¢", "₡");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1d1d1b;max-width:560px">
    <p>Hola${rc.nombre ? ", " + esc(rc.nombre) : ""}:</p>
    <p>Le enviamos su <b>${esc(nombre)}</b> N.º <b>${esc(doc.consecutivo)}</b> por <b>${esc(total)}</b>, aceptada por el Ministerio de Hacienda.</p>
    <p>Van adjuntos el PDF, el XML del comprobante y la respuesta de Hacienda. Guárdelos: el XML es el que vale ante Hacienda.</p>
    ${prueba ? "<p style=\"color:#b00\"><b>Este es un comprobante de PRUEBAS: no tiene validez.</b></p>" : ""}
    <p>¡Gracias por su compra!<br>${esc(negocio)}${em.telefono ? " · Tel. " + esc((em.telefono as Dic).numTelefono) : ""}</p>
    <p style="font-size:12px;color:#666">Clave: ${esc(doc.clave)}</p></div>`;
  const texto = `Hola${rc.nombre ? ", " + rc.nombre : ""}:\n\nLe enviamos su ${nombre} N.º ${doc.consecutivo} por ${total}, aceptada por el Ministerio de Hacienda.\n` +
    `Van adjuntos el PDF, el XML del comprobante y la respuesta de Hacienda.\n${prueba ? "\nEste es un comprobante de PRUEBAS: no tiene validez.\n" : ""}\n¡Gracias por su compra!\n${negocio}\n\nClave: ${doc.clave}`;

  const adjuntos = [
    { filename: `${doc.clave}.pdf`, content: base64(pdfComprobante({ tipo: doc.tipo, datos: d, ambiente: doc.ambiente, estado: doc.estado })) },
    { filename: `${doc.clave}.xml`, content: b64Texto(doc.xml_firmado) },
    ...(doc.respuesta_xml ? [{ filename: `${doc.clave}-respuesta-hacienda.xml`, content: b64Texto(doc.respuesta_xml) }] : []),
  ];
  const cuerpo: Dic = { from: env("CORREO_REMITENTE"), to: [para], subject: asunto, html, text: texto, attachments: adjuntos };
  if (env("CORREO_RESPONDER")) cuerpo.reply_to = env("CORREO_RESPONDER");

  let res: Response | null = null, json: Dic = {};
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json",
        // el envío automático no se repite aunque se llame dos veces (Resend lo reconoce 24 h)
        ...(op.forzar ? {} : { "Idempotency-Key": `fe-${doc.id}-${doc.clave.slice(-12)}` }),
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20000),
    });
    try { json = await res.json(); } catch { json = {}; }
  } catch (e) {
    const fila = { documento_id: doc.id, para, estado: "error", motivo: "red", detalle: "No se pudo hablar con Resend: " + corto(e), creado_por: op.quien ?? null };
    await db.from("fe_correos").insert(fila);
    return { estado: "error", motivo: "red", detalle: fila.detalle, para };
  }

  // Resend dice cuántos lleva usados del plan (el mes de Resend va por ciclo de cobro, no por mes del calendario)
  const usado = (h: string) => { const n = Number(res!.headers.get(h)); return Number.isFinite(n) && res!.headers.get(h) !== null ? n : null; };
  const uso = { usado_mes: usado("x-resend-monthly-quota"), usado_dia: usado("x-resend-daily-quota") };
  if (res.ok) {
    await db.from("fe_correos").insert({ documento_id: doc.id, para, estado: "enviado", resend_id: String(json.id || ""), creado_por: op.quien ?? null, ...uso });
    return { estado: "enviado", para };
  }
  // por qué no salió: el límite del plan (por día o por mes) se avisa en la pantalla
  const nombreErr = String(json.name || ""), msj = String(json.message || res.statusText || "");
  const motivo = /monthly_quota/i.test(nombreErr) || /month/i.test(msj) && res.status === 429 ? "limite_mes"
    : /daily_quota/i.test(nombreErr) || /dai?ly|day/i.test(msj) && res.status === 429 ? "limite_dia"
    : res.status === 429 ? "muchos"                                   // demasiados por segundo: se reintenta solo
    : res.status === 401 || res.status === 403 ? "llave"
    : /domain|from|verif/i.test(nombreErr + " " + msj) ? "dominio" : "otro";
  const detalle = `${res.status} ${nombreErr ? nombreErr + ": " : ""}${msj}`.slice(0, 400);
  await db.from("fe_correos").insert({ documento_id: doc.id, para, estado: "error", motivo, detalle, creado_por: op.quien ?? null });
  return { estado: "error", motivo, detalle, para };
}

// cómo van los correos (para el aviso del panel)
export async function estadoCorreos(db: SupabaseClient) {
  const lim = limites();
  if (!correoConfigurado()) return { configurado: false, ...lim };
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica" }).format(new Date());
  const inicioDia = new Date(`${hoy}T00:00:00-06:00`).toISOString();
  const inicioMes = new Date(`${hoy.slice(0, 7)}-01T00:00:00-06:00`).toISOString();
  const cuenta = async (desde: string) => (await db.from("fe_correos").select("id", { count: "exact", head: true }).eq("estado", "enviado").gte("created_at", desde)).count || 0;
  let [mes, dia] = await Promise.all([cuenta(inicioMes), cuenta(inicioDia)]);
  // si Resend ya dijo cuánto lleva usado, vale más eso (cuenta también lo que se mande desde otro lado)
  const { data: uso } = await db.from("fe_correos").select("usado_mes,usado_dia,created_at").eq("estado", "enviado").not("usado_mes", "is", null)
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (uso && Date.now() - new Date(uso.created_at).getTime() < 3 * 864e5) {
    mes = Math.max(mes, Number(uso.usado_mes) || 0);
    if (uso.usado_dia != null && new Date(uso.created_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) dia = Math.max(dia, Number(uso.usado_dia) || 0);
  }
  // el último intento dice si está trabado (un envío bueno después de un error lo destraba)
  const { data: ult } = await db.from("fe_correos").select("estado,motivo,detalle,created_at").in("estado", ["enviado", "error"]).order("id", { ascending: false }).limit(1).maybeSingle();
  const trabado = ult && ult.estado === "error" && ["limite_mes", "limite_dia", "llave", "dominio"].includes(String(ult.motivo)) ? ult : null;
  const pendientes = await pendientesCorreo(db, 200);
  return {
    configurado: true, ...lim, enviados_mes: mes, enviados_hoy: dia,
    bloqueado: trabado ? trabado.motivo : null, detalle: trabado ? trabado.detalle : null, desde: trabado ? trabado.created_at : null,
    pendientes: pendientes.length,
  };
}

// comprobantes aceptados de los últimos 30 días con correo del cliente que todavía no se mandaron
export async function pendientesCorreo(db: SupabaseClient, max = 20) {
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: docs } = await db.from("fe_documentos").select("id,datos,receptor,created_at")
    .in("tipo", ["01", "03"]).eq("estado", "aceptado").gte("created_at", desde).order("id").limit(500);
  const conCorreo = (docs || []).filter((x) => correoDe(x as never));
  if (!conCorreo.length) return [];
  const { data: env } = await db.from("fe_correos").select("documento_id").eq("estado", "enviado").in("documento_id", conCorreo.map((x) => x.id));
  const listos = new Set((env || []).map((x) => x.documento_id));
  return conCorreo.filter((x) => !listos.has(x.id)).slice(0, max).map((x) => x.id as number);
}
