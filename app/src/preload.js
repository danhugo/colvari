const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('squad', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
