// =====================================================================
//  Comprobantes electrónicos 4.4 (Hacienda Costa Rica)
//  Arma, valida, firma, envía y consulta tiquetes, facturas y notas de crédito.
//
//  Lo usan:
//   - la función de Supabase "facturar" (index.ts, en Deno)
//   - la prueba en la compu: herramientas/prueba-hacienda.mjs (en Node 22)
//  Por eso aquí no hay nada de Deno ni de Node: solo datos de entrada → comprobante.
//
//  El trabajo pesado (XML 4.4, firma XAdES-EPES, token, API) lo hace
//  @dojocoding/hacienda-sdk (MIT): https://github.com/DojoCodingLabs/hacienda-cr
// =====================================================================
import { Buffer } from "node:buffer";
import {
  buildClave, buildFacturaXml, buildTiqueteXml, buildNotaCreditoXml, buildMensajeReceptorXml,
  calculateLineItemTotals, calculateInvoiceSummary,
  signXml, validateDocumentXml,
  getEnvironmentConfig, Environment, TokenManager, HttpClient, loadCredentials,
  submitDocument, getStatus, extractRejectionReason,
} from "@dojocoding/hacienda-sdk";

// ---------- catálogos ----------
// Código de tarifa de IVA (CodigoTarifaIVA) → porcentaje
export const TARIFAS: Record<string, number> = {
  "01": 0, "02": 1, "03": 2, "04": 4, "05": 0, "06": 4, "07": 8, "08": 13, "09": 0.5, "10": 0, "11": 0,
};
export const NOMBRES_TARIFA: Record<string, string> = {
  "08": "13 % (general)", "02": "1 % (reducida)", "03": "2 % (reducida)", "04": "4 % (reducida)",
  "09": "0,5 % (reducida)", "07": "8 % (transitoria)", "06": "4 % (transitoria)", "05": "0 % (transitoria)",
  "01": "0 % (artículo 32)", "10": "Exento", "11": "0 % sin derecho a crédito",
};
// método de pago del panel → TipoMedioPago
export const MEDIOS: Record<string, string> = { efectivo: "01", tarjeta: "02", cheque: "03", transferencia: "04", sinpe: "06" };
// "Se vende por" del panel → UnidadMedida de Hacienda (lo demás va como "Unid")
const UNIDADES: Record<string, string> = {
  metro: "M", metros: "M", m: "M", mts: "M", kg: "Kg", kilo: "Kg", kilos: "Kg", kilogramo: "Kg",
  litro: "L", litros: "L", l: "L", "galón": "Gal", galon: "Gal", galones: "Gal",
};
const ID_TIPOS: Record<string, string> = { fisica: "01", juridica: "02", dimex: "03", nite: "04" };

// ---------- tipos de entrada ----------
export type Emisor = {
  tipo_id: string; identificacion: string; nombre: string; nombre_comercial?: string | null;
  actividad: string; provincia: string; canton: string; distrito: string; otras_senas: string;
  telefono?: string | null; correo: string; sucursal: string; terminal: string; proveedor_sistemas: string;
};
export type Linea = {
  cabys: string; codigo?: string | null; detalle: string; cantidad: number;
  precio: number;          // precio unitario CON IVA (como se cobra en el almacén)
  iva_codigo: string;      // "08" = 13 %
  unidad?: string | null; servicio?: boolean;
};
export type Pago = { metodo: string; monto: number };
export type Receptor = { tipo_id?: string | null; identificacion?: string | null; nombre: string; correo?: string | null };
export type Referencia = { tipo: string; clave: string; fecha: string; codigo: string; razon: string };

export class ErrorComprobante extends Error {}
const falla = (m: string): never => { throw new ErrorComprobante(m); };

// Fecha y hora de Costa Rica (siempre -06:00, no hay horario de verano)
export function fechaCR(d: Date = new Date()): string {
  return new Date(d.getTime() - 6 * 3600e3).toISOString().slice(0, 19) + "-06:00";
}
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

export function revisarEmisor(e: Partial<Emisor> | null): string[] {
  const faltan: string[] = [];
  if (!e) return ["todos los datos del emisor"];
  if (!/^0[1-4]$/.test(e.tipo_id || "")) faltan.push("tipo de identificación");
  if (!/^[0-9]{9,12}$/.test(e.identificacion || "")) faltan.push("cédula del emisor");
  if (!e.nombre || e.nombre.length < 3) faltan.push("nombre o razón social");
  if (!/^([0-9]{6}|[0-9]{4}\.[0-9])$/.test(e.actividad || "")) faltan.push("código de actividad económica (6 caracteres, como 6201.0 o 620100)");
  if (!/^[1-7]$/.test(e.provincia || "") || !/^[0-9]{2}$/.test(e.canton || "") || !/^[0-9]{2}$/.test(e.distrito || "")) faltan.push("provincia, cantón y distrito");
  if (!e.otras_senas || e.otras_senas.length < 5) faltan.push("otras señas (dirección)");
  if (!e.correo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.correo)) faltan.push("correo del emisor");
  if (!/^[0-9A-Za-z]{9,20}$/.test(e.proveedor_sistemas || "")) faltan.push("cédula del proveedor del sistema");
  return faltan;
}

function receptorXml(r: Receptor | null | undefined, obligatorio: boolean) {
  if (!r) return obligatorio ? falla("La factura necesita los datos del cliente (identificación, nombre y correo).") : undefined;
  const nombre = String(r.nombre || "").trim().slice(0, 100);
  if (nombre.length < 2) falla("Falta el nombre del cliente.");
  const tipo = r.tipo_id ? (ID_TIPOS[r.tipo_id] || r.tipo_id) : null;
  const num = String(r.identificacion || "").replace(/\D/g, "");
  if (obligatorio && (!tipo || !num)) falla("La factura necesita la identificación del cliente.");
  const out: Record<string, unknown> = { nombre };
  if (tipo && num) out.identificacion = { tipo, numero: num };
  if (r.correo) out.correoElectronico = String(r.correo).trim();
  return out;
}

function repartirPagos(pagos: Pago[] | undefined, total: number) {
  // Hacienda permite hasta 4 medios de pago; el total de los medios es el total del comprobante
  const porMedio = new Map<string, number>();
  for (const p of pagos || []) {
    const cod = MEDIOS[p.metodo] || "99";
    porMedio.set(cod, (porMedio.get(cod) || 0) + Number(p.monto || 0));
  }
  let lista = [...porMedio.entries()].filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!lista.length) lista = [["01", total]];          // sin pagos anotados: efectivo
  const suma = lista.reduce((a, [, m]) => a + m, 0);
  let usado = 0;
  return lista.map(([cod, m], i) => {
    const monto = i === lista.length - 1 ? r5(total - usado) : r5(total * (m / suma));
    usado += monto;
    return { tipoMedioPago: cod, ...(cod === "99" ? { medioPagoOtros: "Otro medio de pago" } : {}), totalMedioPago: monto };
  });
}

function lineasXml(lineas: Linea[]) {
  if (!lineas.length) falla("La venta no tiene productos.");
  if (lineas.length > 1000) falla("Máximo 1000 renglones por comprobante.");
  return lineas.map((l, i) => {
    const t = TARIFAS[l.iva_codigo];
    if (t === undefined) falla(`Renglón ${i + 1}: tarifa de IVA no válida (${l.iva_codigo}).`);
    if (!/^[0-9]{13}$/.test(String(l.cabys || ""))) falla(`“${l.detalle}” no tiene código CABYS.`);
    const cantidad = Number(l.cantidad), precio = Number(l.precio);
    if (!(cantidad > 0)) falla(`“${l.detalle}”: la cantidad debe ser mayor que 0.`);
    if (!(precio > 0)) falla(`“${l.detalle}” no tiene precio.`);
    const unidad = l.servicio ? "Sp" : (UNIDADES[String(l.unidad || "").trim().toLowerCase()] || "Unid");
    return calculateLineItemTotals({
      numeroLinea: i + 1,
      codigoCabys: String(l.cabys),
      ...(l.codigo ? { codigoComercial: [{ tipo: "01", codigo: String(l.codigo).slice(0, 20) }] } : {}),
      cantidad,
      unidadMedida: unidad,
      detalle: String(l.detalle).replace(/\s+/g, " ").trim().slice(0, 200),
      precioUnitario: r5(precio / (1 + t / 100)),        // el precio del almacén ya trae el IVA
      impuesto: [{ codigo: "01", codigoTarifaIVA: l.iva_codigo, tarifa: t }],
      esServicio: !!l.servicio,
    } as never);
  });
}

// situación 1 = normal; 3 = hecho sin internet (la clave ya se dio en la compu: se arma igual con su código de seguridad)
export type SinInternet = { seguridad: string };
function cabecera(tipo: string, numero: number, fecha: Date, e: Emisor, sinInternet?: SinInternet | null) {
  if (!(numero >= 1 && numero <= 9999999999)) falla("Consecutivo fuera de rango.");
  if (sinInternet && !/^[0-9]{8}$/.test(sinInternet.seguridad)) falla("Código de seguridad no válido.");
  const clave = buildClave({
    date: fecha, taxpayerId: e.identificacion, branch: e.sucursal, pos: e.terminal,
    documentType: tipo, sequence: numero, situation: sinInternet ? "3" : "1",
    ...(sinInternet ? { securityCode: sinInternet.seguridad } : {}),
  } as never);
  return {
    clave,
    proveedorSistemas: e.proveedor_sistemas,
    codigoActividadEmisor: e.actividad,
    numeroConsecutivo: `${e.sucursal}${e.terminal}${tipo}${String(numero).padStart(10, "0")}`,
    fechaEmision: fechaCR(fecha),
    emisor: {
      nombre: e.nombre,
      identificacion: { tipo: e.tipo_id, numero: e.identificacion },
      ...(e.nombre_comercial ? { nombreComercial: e.nombre_comercial } : {}),
      ubicacion: { provincia: e.provincia, canton: e.canton, distrito: e.distrito, otrasSenas: e.otras_senas },
      ...(e.telefono ? { telefono: { codigoPais: "506", numTelefono: e.telefono } } : {}),
      correoElectronico: e.correo,
    },
  };
}

export type Comprobante = {
  tipo: string; clave: string; consecutivo: string; fechaEmision: string;
  total: number; impuesto: number; doc: Record<string, unknown>; xml: string;
};

// Tiquete (04) o factura (01) de una venta
export function armarComprobante(op: {
  tipo: "01" | "04"; numero: number; emisor: Emisor; lineas: Linea[]; pagos?: Pago[];
  receptor?: Receptor | null; credito?: { dias: number } | null; fecha?: Date; sinInternet?: SinInternet | null;
}): Comprobante {
  const faltan = revisarEmisor(op.emisor);
  if (faltan.length) falla("Faltan datos del emisor: " + faltan.join(", ") + ".");
  const fecha = op.fecha || new Date();
  const items = lineasXml(op.lineas);
  const resumen = calculateInvoiceSummary(items as never);
  const receptor = receptorXml(op.receptor, op.tipo === "01");
  const dias = op.credito ? Math.round(Number(op.credito.dias)) : 0;
  if (op.credito && !(dias >= 1 && dias <= 99999)) falla("El plazo del crédito debe ser de 1 a 99999 días.");
  // al contado va cómo se pagó; a crédito todavía no hay pago
  const resumenFactura: Record<string, unknown> = { ...resumen };
  if (!op.credito) resumenFactura.medioPago = repartirPagos(op.pagos, resumen.totalComprobante);
  const doc: Record<string, unknown> = {
    ...cabecera(op.tipo, op.numero, fecha, op.emisor, op.sinInternet),
    ...(receptor ? { receptor } : {}),
    condicionVenta: op.credito ? "02" : "01",
    ...(op.credito ? { plazoCredito: String(dias) } : {}),
    detalleServicio: items,
    resumenFactura,
  };
  const xml = op.tipo === "01" ? buildFacturaXml(doc as never) : buildTiqueteXml(doc as never);
  return { tipo: op.tipo, clave: doc.clave as string, consecutivo: doc.numeroConsecutivo as string, fechaEmision: doc.fechaEmision as string,
           total: resumen.totalComprobante, impuesto: resumen.totalImpuesto, doc, xml };
}

// Nota de crédito (03) que anula por completo un tiquete o factura aceptado
export function armarNotaCredito(op: {
  numero: number; emisor: Emisor; original: { tipo: string; clave: string; fechaEmision: string; doc: Record<string, unknown> };
  motivo: string; nombreCliente?: string; fecha?: Date;
}): Comprobante {
  const faltan = revisarEmisor(op.emisor);
  if (faltan.length) falla("Faltan datos del emisor: " + faltan.join(", ") + ".");
  const razon = String(op.motivo || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (razon.length < 3) falla("Escriba el motivo de la nota de crédito.");
  const o = op.original.doc;
  const fecha = op.fecha || new Date();
  const receptor = (o.receptor as Record<string, unknown>) || { nombre: String(op.nombreCliente || "Cliente de contado").slice(0, 100) };
  const doc: Record<string, unknown> = {
    ...cabecera("03", op.numero, fecha, op.emisor),
    receptor,
    condicionVenta: o.condicionVenta || "01",
    ...(o.plazoCredito ? { plazoCredito: o.plazoCredito } : {}),
    detalleServicio: o.detalleServicio,
    resumenFactura: o.resumenFactura,
    informacionReferencia: [{
      tipoDoc: op.original.tipo, numero: op.original.clave, fechaEmision: op.original.fechaEmision,
      codigo: "01", razon,                                   // 01 = anula documento de referencia
    }],
  };
  const res = o.resumenFactura as Record<string, number>;
  const xml = buildNotaCreditoXml(doc as never);
  return { tipo: "03", clave: doc.clave as string, consecutivo: doc.numeroConsecutivo as string, fechaEmision: doc.fechaEmision as string,
           total: Number(res.totalComprobante), impuesto: Number(res.totalImpuesto), doc, xml };
}

// ---------- mensaje de receptor (aceptar o rechazar la factura de un proveedor) ----------
// mensaje: 1 acepta (consecutivo tipo 05), 2 acepta en parte (06), 3 rechaza (07)
// condición del IVA: 01 da crédito completo, 02 crédito parcial, 03 bienes de capital,
//                    04 gasto corriente sin crédito, 05 proporcionalidad
export const TIPO_MENSAJE: Record<string, string> = { "1": "05", "2": "06", "3": "07" };
export type MensajeReceptorEntrada = {
  numero: number; emisor: Emisor;                 // emisor = este negocio (el que contesta)
  recibido: { clave: string; emisor_id: string; fecha_emision: string; total: number; impuesto: number };
  mensaje: "1" | "2" | "3"; detalle?: string | null;
  condicion?: string | null; acreditar?: number | null;
  fecha?: Date;
};
export function armarMensajeReceptor(op: MensajeReceptorEntrada) {
  const faltan = revisarEmisor(op.emisor);
  if (faltan.length) falla("Faltan datos del negocio: " + faltan.join(", ") + ".");
  const tipo = TIPO_MENSAJE[op.mensaje];
  if (!tipo) falla("Escoja si acepta, acepta en parte o rechaza.");
  if (!(op.numero >= 1 && op.numero <= 9999999999)) falla("Consecutivo fuera de rango.");
  const r = op.recibido;
  if (!/^[0-9]{50}$/.test(r.clave)) falla("La clave del comprobante no es válida.");
  if (!/^[0-9]{9,12}$/.test(r.emisor_id)) falla("La cédula del proveedor no es válida.");
  const detalle = String(op.detalle || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (op.mensaje !== "1" && detalle.length < 3) falla("Escriba el motivo (se le manda al proveedor por medio de Hacienda).");
  const total = r5(Number(r.total)), impuesto = r5(Number(r.impuesto || 0));
  const consecutivo = `${op.emisor.sucursal}${op.emisor.terminal}${tipo}${String(op.numero).padStart(10, "0")}`;
  const datos: Record<string, unknown> = {
    clave: r.clave,
    numeroCedulaEmisor: r.emisor_id,
    fechaEmisionDoc: fechaCR(new Date(r.fecha_emision)),
    mensaje: op.mensaje,
    ...(detalle ? { detalleMensaje: detalle } : {}),
    totalFactura: total,
    numeroCedulaReceptor: String(op.emisor.identificacion),
    numeroConsecutivoReceptor: consecutivo,
  };
  if (impuesto > 0) datos.montoTotalImpuesto = impuesto;
  if (op.mensaje !== "3") {
    datos.codigoActividad = op.emisor.actividad;
    if (impuesto > 0) {
      const cond = String(op.condicion || "01");
      if (!["01", "02", "03", "04", "05"].includes(cond)) falla("Condición del IVA no válida.");
      let acreditar = impuesto;
      if (cond === "04") acreditar = 0;
      else if (cond === "02" || cond === "05") {
        acreditar = r5(Number(op.acreditar));
        if (!(acreditar >= 0) || acreditar > impuesto) falla("El IVA que se acredita tiene que estar entre 0 y el IVA de la factura.");
      }
      datos.condicionImpuesto = cond;
      datos.montoTotalImpuestoAcreditar = acreditar;
      datos.montoTotalDeGastoAplicable = r5(impuesto - acreditar);
    }
  }
  const xml = buildMensajeReceptorXml(datos as never);
  return { tipo, consecutivo, fecha: fechaCR(op.fecha || new Date()), datos, xml };
}

// Manda el mensaje de receptor: va con la clave del comprobante del proveedor
export async function enviarMensaje(http: HttpClient, m: {
  clave: string; fecha: string; emisor: { tipo: string; numero: string }; receptor: { tipo: string; numero: string }; consecutivo: string;
}, firmado: string) {
  return await submitDocument(http, {
    clave: m.clave,
    fecha: m.fecha,
    emisor: { tipoIdentificacion: m.emisor.tipo, numeroIdentificacion: m.emisor.numero },
    receptor: { tipoIdentificacion: m.receptor.tipo, numeroIdentificacion: m.receptor.numero },
    consecutivoReceptor: m.consecutivo,
    comprobanteXml: Buffer.from(firmado, "utf8").toString("base64"),
  } as never);
}

// Solo revisa el XML sin firmar contra el esquema 4.4 (para probar sin llave)
export async function validarSinFirma(xml: string): Promise<void> {
  await revisarEsquema(xml, false, "El comprobante no pasa el esquema de Hacienda: ");
}

const NO_CORRE = /not implemented|worker|webassembly|wasm|is not a constructor|is not defined/i;
// Revisa el XML contra el esquema 4.4. Si el validador no puede correr en este servidor
// (es WebAssembly), se sigue: Hacienda igual valida y lo rechazaría con el motivo.
async function revisarEsquema(xml: string, conFirma: boolean, que: string) {
  let v: { valid: boolean; issues: string[] };
  try { v = await validateDocumentXml(xml, conFirma ? ({ requireSignature: true } as never) : undefined); }
  catch (e) { console.warn("Validador de esquema no disponible:", String((e as Error)?.message || e)); return; }
  // en el servidor de Supabase el validador a veces no arranca (no hay Worker) y lo reporta como "problema" del XML:
  // eso no es un error del comprobante, así que se sigue y Hacienda lo revisa
  const deVerdad = v.issues.filter((i) => !NO_CORRE.test(String(i)));
  if (!v.valid && !deVerdad.length) { console.warn("Validador de esquema no disponible:", v.issues.join("; ")); return; }
  if (!v.valid) falla(que + deVerdad.slice(0, 5).join("; "));
}

// Valida contra el esquema 4.4 y firma con la llave criptográfica (.p12)
export async function firmar(xml: string, p12: Uint8Array, pin: string, opciones: { validar?: boolean } = {}): Promise<string> {
  const validar = opciones.validar !== false;
  if (validar) await revisarEsquema(xml, false, "El comprobante no pasa el esquema de Hacienda: ");
  let firmado: string;
  try {
    firmado = await signXml(xml, Buffer.from(p12), pin);
  } catch (e) {
    const m = String((e as Error)?.message || e);
    if (/pin|password|mac|decrypt|pkcs12|p12/i.test(m)) falla("No se pudo abrir la llave criptográfica: revise el archivo .p12 y el PIN.");
    throw e;
  }
  if (validar) await revisarEsquema(firmado, true, "La firma no quedó bien: ");
  return firmado;
}

// ---------- conexión con Hacienda ----------
export async function conectar(ambiente: "pruebas" | "produccion", usuario: string, clave: string) {
  if (!usuario || !clave) falla("Faltan el usuario y la contraseña de Hacienda (secretos de la función).");
  const envConfig = getEnvironmentConfig(ambiente === "produccion" ? Environment.Production : Environment.Sandbox);
  const tokenManager = new TokenManager({ envConfig });
  try {
    await tokenManager.authenticate(loadCredentials({ username: usuario, password: clave } as never));
  } catch (e) {
    falla(`Hacienda no aceptó el usuario o la contraseña (${ambiente}). Revise que sean los del ambiente de ${ambiente === "produccion" ? "producción" : "pruebas"}. ` +
      String((e as Error)?.message || "").slice(0, 200));
  }
  return new HttpClient({ envConfig, tokenManager });
}

export async function enviar(http: HttpClient, c: { clave: string; fechaEmision: string; doc: Record<string, unknown> }, firmado: string) {
  const em = (c.doc.emisor as { identificacion: { tipo: string; numero: string } }).identificacion;
  const rid = (c.doc.receptor as { identificacion?: { tipo: string; numero: string } } | undefined)?.identificacion;
  return await submitDocument(http, {
    clave: c.clave,
    fecha: c.fechaEmision,
    emisor: { tipoIdentificacion: em.tipo, numeroIdentificacion: em.numero },
    ...(rid ? { receptor: { tipoIdentificacion: rid.tipo, numeroIdentificacion: rid.numero } } : {}),
    comprobanteXml: Buffer.from(firmado, "utf8").toString("base64"),
  } as never);
}

// Estado en Hacienda → estado en la base
export async function consultar(http: HttpClient, clave: string) {
  const s = await getStatus(http, clave);
  const estado = s.status === "aceptado" ? "aceptado" : s.status === "rechazado" ? "rechazado"
    : s.status === "error" ? "error" : "procesando";
  const motivo = s.responseXml ? extractRejectionReason(s.responseXml) : undefined;
  return { estado, respuestaXml: s.responseXml || null, motivo: motivo || null };
}
