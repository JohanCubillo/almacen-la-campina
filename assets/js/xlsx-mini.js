/* =====================================================================
   Excel mínimo para el panel (sin librerías externas)
   - leer(file): .xlsx o .csv  →  [{ r: númeroDeFila, celdas: [..] }]
   - escribir(filas, opciones) →  Blob .xlsx (una hoja, primera fila en negrita)
   Los textos se guardan como texto (nunca como fórmulas).
   ===================================================================== */
(function () {
  "use strict";
  const MAX_FILAS = 5000;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------- ZIP ----------
  const TABLA_CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (u8) => {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = TABLA_CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // ZIP sin compresión (válido para Excel, LibreOffice y Google Sheets)
  function zip(archivos) {
    const partes = [], central = [];
    let offset = 0;
    for (const a of archivos) {
      const nombre = enc.encode(a.nombre), datos = enc.encode(a.datos), crc = crc32(datos);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, datos.length, true); lh.setUint32(22, datos.length, true);
      lh.setUint16(26, nombre.length, true); lh.setUint16(28, 0, true);
      partes.push(new Uint8Array(lh.buffer), nombre, datos);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, datos.length, true); ch.setUint32(24, datos.length, true);
      ch.setUint16(28, nombre.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nombre);
      offset += 30 + nombre.length + datos.length;
    }
    const tam = central.reduce((s, b) => s + b.length, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tam, true); fin.setUint32(16, offset, true);
    return new Blob([...partes, ...central, new Uint8Array(fin.buffer)],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  async function inflar(u8) {
    if (typeof DecompressionStream === "undefined") throw new Error("Este navegador no puede abrir Excel. Guárdelo como CSV o use Chrome.");
    const salida = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
    return new Uint8Array(await salida.arrayBuffer());
  }

  async function unzip(buf, quiero) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) throw new Error("El archivo no es un Excel (.xlsx) válido.");
    const n = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true), total = 0;
    const out = {};
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("El Excel parece dañado.");
      const metodo = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const nombre = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (!quiero(nombre)) continue;
      total += usize;
      if (usize > 40e6 || total > 80e6) throw new Error("El Excel es demasiado grande.");
      const ini = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const datos = u8.subarray(ini, ini + csize);
      if (metodo === 0) out[nombre] = datos;
      else if (metodo === 8) out[nombre] = await inflar(datos);
      else throw new Error("El Excel usa un formato que no se puede leer. Guárdelo de nuevo como .xlsx.");
    }
    return out;
  }

  // ---------- leer ----------
  const letrasACol = (ref) => {
    const l = (String(ref).match(/^[A-Z]+/) || [""])[0];
    let c = 0;
    for (const ch of l) c = c * 26 + ch.charCodeAt(0) - 64;
    return l ? c - 1 : -1;
  };

  async function leerXlsx(file) {
    const z = await unzip(await file.arrayBuffer(),
      (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/i.test(n));
    const xml = (n) => (z[n] ? new DOMParser().parseFromString(dec.decode(z[n]), "application/xml") : null);
    const wb = xml("xl/workbook.xml"), rels = xml("xl/_rels/workbook.xml.rels");
    let ruta = "xl/worksheets/sheet1.xml";
    const hoja = wb && wb.getElementsByTagName("sheet")[0];
    if (hoja && rels) {
      const rid = hoja.getAttribute("r:id") || hoja.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const rel = [...rels.getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid);
      if (rel) {
        const t = rel.getAttribute("Target") || "";
        ruta = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
      }
    }
    const ss = xml("xl/sharedStrings.xml");
    const textos = ss ? [...ss.getElementsByTagName("si")].map((si) =>
      [...si.getElementsByTagName("t")].filter((t) => t.parentNode.nodeName !== "rPh").map((t) => t.textContent).join("")) : [];
    const sh = xml(ruta);
    if (!sh) throw new Error("No se encontró la primera hoja del Excel.");
    const filas = [];
    for (const row of sh.getElementsByTagName("row")) {
      const celdas = [];
      for (const c of row.getElementsByTagName("c")) {
        let ci = letrasACol(c.getAttribute("r") || "");
        if (ci < 0) ci = celdas.length;
        const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0];
        let val;
        if (t === "s") val = textos[Number(v && v.textContent)] ?? "";
        else if (t === "inlineStr") val = [...c.getElementsByTagName("t")].map((x) => x.textContent).join("");
        else if (t === "b") val = v && v.textContent === "1" ? "Sí" : "No";
        else val = v ? v.textContent : "";
        celdas[ci] = val;
      }
      filas.push({ r: Number(row.getAttribute("r")) || filas.length + 1, celdas });
      if (filas.length > MAX_FILAS) break;
    }
    return filas;
  }

  function leerCsv(texto) {
    texto = texto.replace(/^﻿/, "");
    const primera = texto.split(/\r?\n/)[0] || "";
    const sep = [";", ",", "\t"].map((s) => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
    const filas = [];
    let fila = [], campo = "", comillas = false;
    for (let i = 0; i < texto.length && filas.length <= MAX_FILAS; i++) {
      const ch = texto[i];
      if (comillas) {
        if (ch === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false; }
        else campo += ch;
      } else if (ch === '"') comillas = true;
      else if (ch === sep) { fila.push(campo); campo = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && texto[i + 1] === "\n") i++;
        fila.push(campo); filas.push(fila); fila = []; campo = "";
      } else campo += ch;
    }
    if (campo || fila.length) { fila.push(campo); filas.push(fila); }
    return filas.map((celdas, i) => ({ r: i + 1, celdas }));
  }

  async function leer(file) {
    if (!file) throw new Error("Escoja un archivo.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El archivo pesa más de 15 MB.");
    if (/\.csv$/i.test(file.name) || file.type === "text/csv") return leerCsv(await file.text());
    if (/\.xls$/i.test(file.name)) throw new Error("Ese es un Excel viejo (.xls). Ábralo y guárdelo como .xlsx.");
    return leerXlsx(file);
  }

  // ---------- escribir ----------
  const escXml = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const colLetras = (i) => { let s = ""; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  function escribir(filas, { hoja = "Hoja1", anchos = [] } = {}) {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const nsr = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const filasXml = filas.map((f, ri) => `<row r="${ri + 1}">` + f.map((v, ci) => {
      if (v === null || v === undefined || v === "") return "";
      const ref = colLetras(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join("") + "</row>").join("");
    const cols = anchos.length ? `<cols>${anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const cab = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zip([
      { nombre: "[Content_Types].xml", datos: cab + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { nombre: "_rels/.rels", datos: cab + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { nombre: "xl/workbook.xml", datos: cab + `<workbook ${ns} ${nsr}><sheets><sheet name="${escXml(hoja).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { nombre: "xl/_rels/workbook.xml.rels", datos: cab + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { nombre: "xl/styles.xml", datos: cab + `<styleSheet ${ns}>` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      { nombre: "xl/worksheets/sheet1.xml", datos: cab + `<worksheet ${ns}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${filasXml}</sheetData></worksheet>` }
    ]);
  }

  window.XlsxMini = { leer, escribir };
})();
