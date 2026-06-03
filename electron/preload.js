const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("slicer", {
  openStl: () => ipcRenderer.invoke("dialog:open-stl"),
  saveOutput: (format) => ipcRenderer.invoke("dialog:save-output", format),
  saveProject: (defaultName, content) => ipcRenderer.invoke("dialog:save-project", defaultName, content),
  openProfile: (kind) => ipcRenderer.invoke("dialog:open-profile", kind),
  saveProfile: (kind, defaultName, content) => ipcRenderer.invoke("dialog:save-profile", kind, defaultName, content),
  pathForFile: (file) => webUtils.getPathForFile(file),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  readFileProgress: (filePath, jobId) => ipcRenderer.invoke("file:read-progress", { filePath, jobId }),
  readStepMesh: (filePath) => ipcRenderer.invoke("step:read-mesh", filePath),
  uvtoolsPrinters: () => ipcRenderer.invoke("uvtools:list-printers"),
  uvtoolsPrinter: (printerPath) => ipcRenderer.invoke("uvtools:read-printer", printerPath),
  profiles: () => ipcRenderer.invoke("bridge:profiles"),
  preview: (payload) => ipcRenderer.invoke("bridge:preview", payload),
  slice: (payload) => ipcRenderer.invoke("bridge:slice", payload),
  onSliceProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("slice:progress", listener);
    return () => ipcRenderer.removeListener("slice:progress", listener);
  },
  onFileReadProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("file:read-progress", listener);
    return () => ipcRenderer.removeListener("file:read-progress", listener);
  },
  onAppPrompt: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:prompt", listener);
    return () => ipcRenderer.removeListener("app:prompt", listener);
  }
});
