const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("slicer", {
  openStl: () => ipcRenderer.invoke("dialog:open-stl"),
  saveOutput: (format) => ipcRenderer.invoke("dialog:save-output", format),
  openProfile: (kind) => ipcRenderer.invoke("dialog:open-profile", kind),
  saveProfile: (kind, defaultName, content) => ipcRenderer.invoke("dialog:save-profile", kind, defaultName, content),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  profiles: () => ipcRenderer.invoke("bridge:profiles"),
  preview: (payload) => ipcRenderer.invoke("bridge:preview", payload),
  slice: (payload) => ipcRenderer.invoke("bridge:slice", payload),
  onSliceProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("slice:progress", listener);
    return () => ipcRenderer.removeListener("slice:progress", listener);
  }
});
