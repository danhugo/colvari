const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('squad', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  getTheme: () => ipcRenderer.invoke('api', 'getPrefs').then((p) => p.theme),
  setTheme: (theme) => ipcRenderer.invoke('api', 'setPrefs', {}, { theme }).then((p) => p.theme),
  // t_993822cf: save a chat attachment in the main process; resolves {path,name,mime,size} or {error}.
  saveAttachment: (ctx, file) => ipcRenderer.invoke('api', 'saveAttachment', ctx, file),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
