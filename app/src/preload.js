const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('squad', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  getTheme: () => ipcRenderer.invoke('api', 'getPrefs').then((p) => p.theme),
  setTheme: (theme) => ipcRenderer.invoke('api', 'setPrefs', {}, { theme }).then((p) => p.theme),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
