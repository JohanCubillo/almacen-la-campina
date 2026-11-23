// =====================================================================
//  Prueba de facturación electrónica en la compu (ambiente de PRUEBAS de Hacienda)
//
//  Usa el mismo código que la función de Supabase (supabase/functions/facturar/comprobante.ts),
//  así que si aquí sale "aceptado", la función también sirve.
//
//  Requisitos: Node 22.18 o más nuevo, y en la carpeta del repo:  npm install
//
//  1) Copie herramientas/prueba-emisor.ejemplo.json como herramientas/prueba-emisor.json
//     y ponga los datos del almacén.
//  2) En la misma ventana de CMD ponga los secretos de PRUEBAS (no se guardan en ningún archivo):
//        set HACIENDA_USUARIO=cpj-3-101-xxxxxx@stag.comprobanteselectronicos.go.cr
//        set HACIENDA_CLAVE=la-contraseña-de-pruebas
//        set HACIENDA_P12=C:\ruta\a\la-llave-de-pruebas.p12
//        set HACIENDA_PIN=1234
//  Sin llave todavía: sin poner HACIENDA_P12, el script solo arma los comprobantes y los
//  revisa contra el esquema 4.4 (no firma ni envía). Sirve para probar antes de tener credenciales.
//
//  3) node herramientas/prueba-hacienda.mjs           → arma, valida y firma un tiquete (no envía nada)
//     node herramientas/prueba-hacienda.mjs --enviar  → además lo envía a PRUEBAS y espera la respuesta
//     node herramientas/prueba-hacienda.mjs --enviar --factura   → igual, pero factura (pide receptor en el json)
//     node herramientas/prueba-hacienda.mjs --enviar --anular    → tiquete aceptado + nota de crédito que lo anula
//
//  Los XML quedan en herramientas/salida/ (esa carpeta no se sube a GitHub).
// =====================================================================
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  armarComprobante, armarNotaCredito, firmar, conectar, enviar, consultar, revisarEmisor, validarSinFirma,
} from "../supabase/functions/facturar/comprobante.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const ENVIAR = args.has("--enviar"), FACTURA = args.has("--factura"), ANULAR = args.has("--anular");

const archivoEmisor = join(aqui, "prueba-emisor.json");
if (!existsSync(archivoEmisor)) {
  console.error("Falta herramientas/prueba-emisor.json. Copie prueba-emisor.ejemplo.json con ese nombre y ponga los datos del almacén.");
  process.exit(1);
}
const conf = JSON.parse(await readFile(archivoEmisor, "utf8"));
const emisor = { sucursal: "001", terminal: "00099", ...conf.emisor };
const faltan = revisarEmisor(emisor);
if (faltan.length) { console.error("Faltan datos del emisor en prueba-emisor.json: " + faltan.join(", ")); process.exit(1); }

const req = (n) => {
  const v = process.env[n];
  if (!v) { console.error(`Falta ${n}. Póngalo con:  set ${n}=...  (en la misma ventana de CMD)`); process.exit(1); }
  return v;
};
const SIN_LLAVE = !process.env.HACIENDA_P12;
if (SIN_LLAVE && ENVIAR) { console.error("Para --enviar hacen falta la llave y las credenciales de pruebas (HACIENDA_P12, HACIENDA_PIN, HACIENDA_USUARIO, HACIENDA_CLAVE)."); process.exit(1); }
if (SIN_LLAVE) console.log("Sin llave (HACIENDA_P12 no está puesto): solo se revisa el XML contra el esquema 4.4.");
const p12 = SIN_LLAVE ? null : await readFile(req("HACIENDA_P12"));
const pin = SIN_LLAVE ? "" : req("HACIENDA_PIN");

const salida = join(aqui, "salida");
await mkdir(salida, { recursive: true });
const guardar = (nombre, txt) => writeFile(join(salida, nombre), txt, "utf8");
const numero = () => Math.floor(Date.now() / 1000) % 9999999999;   // único por segundo; solo para pruebas
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const lineas = conf.lineas?.length ? conf.lineas : [
  { cabys: "4612202039900", codigo: "609", detalle: "TRIFULCADOR CON PATILLA (15 AMP-125V) TANIA", cantidad: 2, precio: 1150, iva_codigo: "08" },
];

async function hacer(c, etiqueta) {
  console.log(`\n${etiqueta}: clave ${c.clave}`);
  console.log(`  consecutivo ${c.consecutivo} · total ₡${c.total} (IVA ₡${c.impuesto})`);
  await guardar(`${c.clave}-sin-firmar.xml`, c.xml);
  if (SIN_LLAVE) { await validarSinFirma(c.xml); console.log("  ✔ pasa el esquema 4.4 (sin firmar)"); return null; }
  const firmado = await firmar(c.xml, new Uint8Array(p12), pin);
  await guardar(`${c.clave}-firmado.xml`, firmado);
  console.log("  ✔ pasa el esquema 4.4 y quedó firmado");
  if (!ENVIAR) return null;

  const http = await conectar("pruebas", req("HACIENDA_USUARIO"), req("HACIENDA_CLAVE"));
  console.log("  ✔ Hacienda (pruebas) aceptó el usuario");
  await enviar(http, c, firmado);
  console.log("  ✔ enviado; esperando respuesta…");
  for (let i = 0; i < 12; i++) {
    await espera(i < 3 ? 3000 : 6000);
    const r = await consultar(http, c.clave);
    if (r.estado === "procesando") { process.stdout.write("  …procesando\n"); continue; }
    if (r.respuestaXml) await guardar(`${c.clave}-respuesta.xml`, r.respuestaXml);
    console.log(`  → ${r.estado.toUpperCase()}${r.motivo ? ": " + r.motivo : ""}`);
    return r.estado;
  }
  console.log("  Hacienda todavía no responde. Vuelva a consultar más tarde con la clave de arriba.");
  return "procesando";
}

try {
  const tipo = FACTURA ? "01" : "04";
  if (FACTURA && !conf.receptor) throw new Error("Para --factura ponga \"receptor\" en prueba-emisor.json.");
  const c = armarComprobante({
    tipo, numero: numero(), emisor, lineas,
    pagos: [{ metodo: "sinpe", monto: 1 }],
    receptor: FACTURA ? conf.receptor : null,
  });
  const estado = await hacer(c, tipo === "01" ? "Factura electrónica" : "Tiquete electrónico");
  if (SIN_LLAVE) {
    // también la nota de crédito, sin enviar
    const nc = armarNotaCredito({ numero: numero() + 1, emisor, motivo: "Prueba: anulación del comprobante",
      original: { tipo: c.tipo, clave: c.clave, fechaEmision: c.fechaEmision, doc: c.doc } });
    await hacer(nc, "Nota de crédito");
  } else if (ANULAR) {
    if (estado !== "aceptado") throw new Error("Para probar la nota de crédito, el comprobante tiene que salir aceptado (use --enviar).");
    await espera(1500);
    const nc = armarNotaCredito({
      numero: numero(), emisor, motivo: "Prueba: anulación del comprobante",
      original: { tipo: c.tipo, clave: c.clave, fechaEmision: c.fechaEmision, doc: c.doc },
    });
    await hacer(nc, "Nota de crédito");
  }
  console.log(`\nListo. Los XML están en ${salida}`);
} catch (e) {
  console.error("\n✘ " + (e?.message || e));
  process.exitCode = 1;
}
