// Lo único que el panel puede pedirle al programa: imprimir directo y saber qué impresora usa.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lcEscritorio", {
  imprimir: () => ipcRenderer.invoke("lc:imprimir"),
  info: () => ipcRenderer.invoke("lc:info")
});
