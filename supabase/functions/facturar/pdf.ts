// =====================================================================
//  PDF de un comprobante electrónico (la "representación gráfica" que va
//  en el correo junto con los XML). Sin librerías: un PDF sencillo con
//  Helvetica, tamaño carta, y tantas páginas como hagan falta.
//  Se arma con los datos que ya se guardaron del comprobante (fe_documentos.datos).
// =====================================================================

type Dic = Record<string, unknown>;

// anchos de Helvetica (1/1000 de punto) para los caracteres 32–126; lo demás ≈ 556
const ANCHOS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

// Windows-1252 (la codificación de las fuentes estándar del PDF): letras con tilde, ñ, ¢…
const EXTRA_1252: Record<string, number> = { "€": 128, "‚": 130, "„": 132, "…": 133, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "™": 153 };
function a1252(t: string): string {
  let out = "";
  for (const ch of String(t ?? "").normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += String.fromCharCode(c);
    else if (EXTRA_1252[ch]) out += String.fromCharCode(EXTRA_1252[ch]);
    else if (c === 8353) out += "\xa2";             // ₡ no existe en la fuente: ¢, como se usa en Costa Rica
    else if (c === 9 || c === 10 || c === 13 || c === 8239 || c === 8201 || c === 8202) out += " ";   // espacios finos de los números
    else out += "?";
  }
  return out;
}
function ancho(t: string, tam: number, negrita = false): number {
  let w = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    w += c >= 32 && c <= 126 ? ANCHOS[c - 32] : 556;
  }
  return (w * tam / 1000) * (negrita ? 1.05 : 1);
}
const escapar = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
// corta un texto (ya en 1252) para que quepa en el ancho
function recortar(t: string, max: number, tam: number, negrita = false): string {
  if (ancho(t, tam, negrita) <= max) return t;
  while (t.length > 1 && ancho(t + "...", tam, negrita) > max) t = t.slice(0, -1);
  return t + "...";
}
// parte un texto en renglones que quepan en el ancho
function partir(t: string, max: number, tam: number): string[] {
  const out: string[] = [];
  let linea = "";
  for (const p of t.split(/\s+/).filter(Boolean)) {
    const prueba = linea ? linea + " " + p : p;
    if (ancho(prueba, tam) <= max) { linea = prueba; continue; }
    if (linea) out.push(linea);
    linea = ancho(p, tam) <= max ? p : recortar(p, max, tam);
  }
  if (linea) out.push(linea);
  return out.length ? out : [""];
}

const num = (n: unknown) => Number(n) || 0;
export const colones = (n: unknown) => "¢" + num(n).toLocaleString("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TIPOS: Record<string, string> = {
  "01": "FACTURA ELECTRÓNICA", "03": "NOTA DE CRÉDITO ELECTRÓNICA", "04": "TIQUETE ELECTRÓNICO", "02": "NOTA DE DÉBITO ELECTRÓNICA",
};
const MEDIOS: Record<string, string> = { "01": "Efectivo", "02": "Tarjeta", "03": "Cheque", "04": "Transferencia", "06": "SINPE Móvil", "99": "Otro" };
const IDS: Record<string, string> = { "01": "Cédula física", "02": "Cédula jurídica", "03": "DIMEX", "04": "NITE" };

function fechaTexto(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Costa_Rica" }).format(d);
}

export function pdfComprobante(op: { tipo: string; datos: Dic; ambiente: string; estado: string }): Uint8Array {
  const d = op.datos, em = (d.emisor || {}) as Dic, rc = (d.receptor || null) as Dic | null, rs = (d.resumenFactura || {}) as Dic;
  const lineas = (Array.isArray(d.detalleServicio) ? d.detalleServicio : []) as Dic[];

  // ---------- página y dibujo ----------
  const AN = 612, AL = 792, M = 42;
  const paginas: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const nueva = () => { ops = []; paginas.push(ops); y = AL - M; };
  const texto = (t: string, x: number, yy: number, tam = 9, negrita = false, alinear: "i" | "d" | "c" = "i") => {
    const s = a1252(t), w = ancho(s, tam, negrita);
    const xx = alinear === "d" ? x - w : alinear === "c" ? x - w / 2 : x;
    ops.push(`BT /${negrita ? "F2" : "F1"} ${tam} Tf ${xx.toFixed(2)} ${yy.toFixed(2)} Td (${escapar(s)}) Tj ET`);
  };
  const linea = (x1: number, y1: number, x2: number, y2: number, grosor = 0.6) => ops.push(`${grosor} w ${x1} ${y1.toFixed(2)} m ${x2} ${y2.toFixed(2)} l S`);
  const caja = (x: number, yy: number, w: number, h: number, gris = 0.94) => ops.push(`${gris} g ${x} ${yy.toFixed(2)} ${w} ${h.toFixed(2)} re f 0 g`);

  nueva();

  // ---------- encabezado: quién emite y qué documento es ----------
  const nombreCom = String(em.nombreComercial || em.nombre || "");
  texto(nombreCom, M, y - 4, 15, true);
  const ident = em.identificacion as Dic | undefined;
  const ub = em.ubicacion as Dic | undefined, tel = em.telefono as Dic | undefined;
  const datosEm = [
    nombreCom !== em.nombre ? String(em.nombre || "") : "",
    ident ? `${IDS[String(ident.tipo)] || "Identificación"} ${ident.numero}` : "",
    ub?.otrasSenas ? String(ub.otrasSenas) : "",
    [tel?.numTelefono ? `Tel. ${tel.numTelefono}` : "", em.correoElectronico ? String(em.correoElectronico) : ""].filter(Boolean).join(" · "),
  ].filter(Boolean);
  let yy = y - 20;
  for (const t of datosEm) { texto(recortar(a1252(t), 300, 9), M, yy, 9); yy -= 12; }

  texto(TIPOS[op.tipo] || "COMPROBANTE ELECTRÓNICO", AN - M, y - 4, 12, true, "d");
  texto(`N.º ${d.numeroConsecutivo || ""}`, AN - M, y - 20, 10, true, "d");
  texto(fechaTexto(String(d.fechaEmision || "")), AN - M, y - 33, 9, false, "d");
  if (op.ambiente !== "produccion") texto("AMBIENTE DE PRUEBAS · SIN VALIDEZ", AN - M, y - 46, 9, true, "d");
  y = Math.min(yy, y - 50) - 6;

  texto("Clave numérica", M, y, 8, true);
  texto(String(d.clave || ""), M + 70, y, 8);
  y -= 16;
  linea(M, y, AN - M, y);
  y -= 16;

  // ---------- cliente y condiciones ----------
  const col2 = AN / 2 + 10;
  texto("Cliente", M, y, 9, true);
  texto("Condiciones", col2, y, 9, true);
  y -= 13;
  const rid = rc?.identificacion as Dic | undefined;
  const datosRc = rc ? [String(rc.nombre || ""), rid ? `${IDS[String(rid.tipo)] || "Identificación"} ${rid.numero}` : "", rc.correoElectronico ? String(rc.correoElectronico) : ""].filter(Boolean)
    : ["Cliente de contado"];
  const medios = Array.isArray(rs.medioPago) ? (rs.medioPago as Dic[]).map((m) => MEDIOS[String(m.tipoMedioPago)] || "Otro").join(", ") : "";
  const cond = [
    d.condicionVenta === "02" ? `Crédito a ${d.plazoCredito || "?"} días` : "Contado",
    medios ? `Pago: ${medios}` : "",
    `Actividad económica ${d.codigoActividadEmisor || ""}`,
  ].filter(Boolean);
  const filas = Math.max(datosRc.length, cond.length);
  for (let i = 0; i < filas; i++) {
    if (datosRc[i]) texto(recortar(a1252(datosRc[i]), col2 - M - 12, 9), M, y, 9);
    if (cond[i]) texto(recortar(a1252(cond[i]), AN - M - col2, 9), col2, y, 9);
    y -= 12;
  }
  // nota de crédito: a qué documento se refiere
  const refs = (Array.isArray(d.informacionReferencia) ? d.informacionReferencia : d.informacionReferencia ? [d.informacionReferencia] : []) as Dic[];
  for (const r of refs) {
    y -= 4;
    texto("Se refiere a", M, y, 9, true);
    texto(recortar(a1252(`${r.numero || ""}${r.razon ? " · " + r.razon : ""}`), AN - 2 * M - 70, 9), M + 70, y, 9);
    y -= 12;
  }
  y -= 8;

  // ---------- renglones ----------
  const X = { cant: M + 4, desc: M + 50, unit: AN - M - 170, iva: AN - M - 95, total: AN - M - 4 };
  const cabeza = () => {
    caja(M, y - 5, AN - 2 * M, 17);
    texto("Cant.", X.cant, y, 8, true);
    texto("Descripción", X.desc, y, 8, true);
    texto("Precio unit.", X.unit, y, 8, true, "d");
    texto("IVA", X.iva, y, 8, true, "d");
    texto("Total", X.total, y, 8, true, "d");
    y -= 18;
  };
  cabeza();
  for (const l of lineas) {
    const cant = num(l.cantidad), total = num(l.montoTotalLinea);
    const imp = (Array.isArray(l.impuesto) ? l.impuesto[0] : null) as Dic | null;
    const renglones = partir(a1252(String(l.detalle || "")), X.unit - X.desc - 60, 9).slice(0, 3);
    const alto = 12 * renglones.length + 2;
    if (y - alto < M + 120) { texto("Sigue en la página siguiente…", AN - M, M + 10, 8, false, "d"); nueva(); cabeza(); }
    texto(cant.toLocaleString("es-CR", { maximumFractionDigits: 3 }), X.cant, y, 9);
    renglones.forEach((t, i) => texto(t, X.desc, y - i * 12, 9));
    texto(colones(cant ? total / cant : 0), X.unit, y, 9, false, "d");
    texto(imp ? `${num(imp.tarifa)} %` : "—", X.iva, y, 9, false, "d");
    texto(colones(total), X.total, y, 9, false, "d");
    if (l.codigoCabys) texto(`CABYS ${l.codigoCabys}`, X.desc, y - renglones.length * 12, 7);
    y -= alto + 12;
    linea(M, y + 9, AN - M, y + 9, 0.3);
  }

  // ---------- totales ----------
  if (y < M + 120) { nueva(); }
  y -= 6;
  const tot = (et: string, v: unknown, negrita = false) => { texto(et, AN - M - 130, y, negrita ? 11 : 9, negrita, "d"); texto(colones(v), AN - M - 4, y, negrita ? 11 : 9, negrita, "d"); y -= negrita ? 16 : 13; };
  tot("Total sin IVA", rs.totalVentaNeta ?? rs.totalVenta);
  if (num(rs.totalDescuentos)) tot("Descuentos", rs.totalDescuentos);
  if (num(rs.totalExonerado)) tot("Exonerado", rs.totalExonerado);
  tot("IVA", rs.totalImpuesto);
  linea(AN - M - 230, y + 9, AN - M, y + 9);
  y -= 3;
  tot("TOTAL", rs.totalComprobante, true);

  // ---------- pie ----------
  const pie = `Comprobante electrónico versión 4.4 · ${op.estado === "aceptado" ? "Aceptado por el Ministerio de Hacienda" : "Estado en Hacienda: " + op.estado}.`;
  for (const pg of paginas) {
    ops = pg;
    texto(pie, M, M - 8, 7.5);
    texto(`Página ${paginas.indexOf(pg) + 1} de ${paginas.length}`, AN - M, M - 8, 7.5, false, "d");
  }

  return armarPdf(paginas.map((p) => p.join("\n")), AN, AL);
}

// arma el archivo PDF (objetos, tabla de posiciones y final)
function armarPdf(contenidos: string[], an: number, al: number): Uint8Array {
  const objs: string[] = [];
  const n = contenidos.length;
  // 1 catálogo, 2 páginas, 3 Helvetica, 4 Helvetica-Bold, después página + contenido por cada hoja
  const kids = contenidos.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  contenidos.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${an} ${al}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  });
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const pos: number[] = [];
  objs.forEach((o, i) => { pos.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + pos.map((p) => String(p).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // cada carácter ya es un byte (Windows-1252)
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}
