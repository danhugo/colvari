const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('squad', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  getTheme: () => ipcRenderer.invoke('api', 'getPrefs').then((p) => p.theme),
  setTheme: (theme) => ipcRenderer.invoke('api', 'setPrefs', {}, { theme }).then((p) => p.theme),
  // t_993822cf: save a chat attachment in the main process; resolves {path,name,mime,size} or {error}.
  saveAttachment: (ctx, file) => ipcRenderer.invoke('api', 'saveAttachment', ctx, file),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
  // IPC deltas (t_39bf39ac): the main-pushed {type,id,patch} batches on the 'delta' channel.
  onDelta: (fn) => ipcRenderer.on('delta', (_e, d) => fn(d)),
  // Core-agent watch (plan t_42f310cf item 2): direct helper for the 'watch-status' push channel.
  onWatchStatus: (fn) => ipcRenderer.on('watch-status', (_e, d) => fn(d)),
  // Scheduled restarts (plan t_42f310cf item 1): direct helper for the 'restart-state' push channel.
  onRestartState: (fn) => ipcRenderer.on('restart-state', (_e, d) => fn(d)),
});
