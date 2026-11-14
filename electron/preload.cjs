// Sandboxed preload (Electron 45: only `require('electron')` is available here). It exposes ONE function.
// The main process validates the channel and the arguments; the renderer never gets Node, the database or a secret.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('planner', {
  invoke: (channel, args) => ipcRenderer.invoke('planner:invoke', channel, args),
});
