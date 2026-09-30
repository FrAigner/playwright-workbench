const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

contextBridge.exposeInMainWorld('api', {
  call,
  on: (channel, cb) => {
    if (!['output', 'browsers:changed', 'browsers:installing'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  platform: process.platform,
});
