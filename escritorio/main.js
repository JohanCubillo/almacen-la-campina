// Almacén La Campiña · programa de escritorio (Windows)
// Abre el panel publicado en GitHub Pages en su propia ventana. Así:
//  - se actualiza solo cada vez que se publica el panel (no hay que reinstalar);
//  - imprime los recibos directo a la impresora, sin la ventana de imprimir;
//  - sigue abriendo sin internet (el panel guarda su copia en la compu).
const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const PANEL = process.env.LA_CAMPINA_URL || "https://johancubillo.github.io/almacen-la-campina/admin.html";
const BASE = new URL(".", PANEL).href;               // https://johancubillo.github.io/almacen-la-campina/
const ORIGEN = new URL(PANEL).origin;

// ---------- configuración de esta compu (impresora) ----------
const RUTA_CONF = () => path.join(app.getPath("userData"), "config.json");
let conf = { impresora: "", silencioso: true };
function leerConf() {
  try { conf = { ...conf, ...JSON.parse(fs.readFileSync(RUTA_CONF(), "utf8")) }; } catch { /* primera vez */ }
}
function guardarConf() {
  try { fs.writeFileSync(RUTA_CONF(), JSON.stringify(conf, null, 2)); } catch { /* sin permiso de escribir */ }
}

const esDelPanel = (url) => { try { return String(url).startsWith(BASE); } catch { return false; } };
const esLocal = (url) => String(url).startsWith("file://");

let ventana = null;

// una sola ventana: si se abre otra vez, se trae al frente la que ya está
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });
  app.whenReady().then(arrancar);
}
app.on("window-all-closed", () => app.quit());

function arrancar() {
  app.setAppUserModelId("cr.almacenlacampina.panel");   // avisos de Windows con el nombre del programa
  leerConf();

  // solo se permiten avisos y copiar al portapapeles
  const PERMITIDOS = ["notifications", "clipboard-sanitized-write", "fullscreen"];
  session.defaultSession.setPermissionRequestHandler((wc, permiso, responder) => responder(PERMITIDOS.includes(permiso)));
  session.defaultSession.setPermissionCheckHandler((wc, permiso) => PERMITIDOS.includes(permiso));

  ventana = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    show: false,
    title: "La Campiña",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,                       // el menú sale con la tecla Alt
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  ventana.once("ready-to-show", () => { ventana.maximize(); ventana.show(); });

  const wc = ventana.webContents;
  // enlaces de afuera (WhatsApp, Google, comprobantes): en el navegador normal
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (esDelPanel(url) || esLocal(url)) return;
    e.preventDefault();
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });
  // sin internet y sin la copia del panel guardada (la primera vez): pantalla para reintentar
  wc.on("did-fail-load", (e, codigo, desc, url, principal) => {
    if (!principal || codigo === -3) return;            // -3: se canceló (otra navegación)
    wc.loadFile(path.join(__dirname, "sin-internet.html"), { query: { url: PANEL } });
  });

  armarMenu();
  ventana.loadURL(PANEL);
}

// ---------- imprimir ----------
// el panel llama window.lcEscritorio.imprimir() en vez de window.print()
ipcMain.handle("lc:imprimir", (e) => {
  if (!esDelPanel(e.senderFrame?.url)) return { ok: false, error: "No permitido." };
  return new Promise((res) => {
    e.sender.print({
      silent: !!conf.silencioso,
      printBackground: true,
      deviceName: conf.impresora || undefined,       // vacío: la impresora predeterminada de Windows
      margins: { marginType: "none" }
    }, (ok, error) => res({ ok, error: ok ? null : error }));
  });
});
ipcMain.handle("lc:info", () => ({ version: app.getVersion(), impresora: conf.impresora || "", silencioso: !!conf.silencioso }));

async function armarMenu() {
  let impresoras = [];
  try { impresoras = ventana ? await ventana.webContents.getPrintersAsync() : []; } catch { impresoras = []; }
  const ponerImpresora = (nombre) => { conf.impresora = nombre; guardarConf(); armarMenu(); };
  const plantilla = [
    {
      label: "La Campiña",
      submenu: [
        { label: "Recargar", accelerator: "F5", click: () => ventana?.webContents.reload() },
        { label: "Ir al panel", click: () => ventana?.loadURL(PANEL) },
        { type: "separator" },
        { label: "Acerca de", click: () => dialog.showMessageBox(ventana, {
          type: "info", title: "La Campiña",
          message: `La Campiña ${app.getVersion()}`,
          detail: `Panel: ${PANEL}\nImpresora: ${conf.impresora || "la predeterminada de Windows"}\n\nEl panel se actualiza solo cada vez que se publica.`
        }) },
        { type: "separator" },
        { label: "Salir", role: "quit" }
      ]
    },
    {
      label: "Impresora",
      submenu: [
        { label: "Imprimir sin preguntar", type: "checkbox", checked: !!conf.silencioso,
          click: (it) => { conf.silencioso = it.checked; guardarConf(); } },
        { type: "separator" },
        { label: "La predeterminada de Windows", type: "radio", checked: !conf.impresora, click: () => ponerImpresora("") },
        ...impresoras.map((p) => ({
          label: p.displayName || p.name, type: "radio", checked: conf.impresora === p.name,
          click: () => ponerImpresora(p.name)
        })),
        { type: "separator" },
        { label: "Actualizar la lista", click: () => armarMenu() }
      ]
    },
    {
      label: "Ver",
      submenu: [
        { label: "Más grande", role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { label: "Más pequeño", role: "zoomOut" },
        { label: "Tamaño normal", role: "resetZoom" },
        { type: "separator" },
        { label: "Pantalla completa", role: "togglefullscreen" },
        { label: "Herramientas de desarrollo", role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(plantilla));
}
