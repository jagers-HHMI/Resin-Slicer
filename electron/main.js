const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    autoHideMenuBar: true,
    icon: path.join(repoRoot, "assets", "resin-slicer.ico"),
    backgroundColor: "#111418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on("uncaughtException", (error) => {
  dialog.showErrorBox("Resin Slicer error", error.stack || error.message || String(error));
});

process.on("unhandledRejection", (reason) => {
  const message = reason && reason.stack ? reason.stack : String(reason);
  dialog.showErrorBox("Resin Slicer error", message);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("dialog:open-stl", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open STL",
    properties: ["openFile"],
    filters: [
      { name: "STL Mesh", extensions: ["stl"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:save-output", async (_event, format) => {
  const ext = format === "ctb" ? "ctb" : "goo";
  const result = await dialog.showSaveDialog({
    title: "Save sliced file",
    defaultPath: `model.${ext}`,
    filters: [
      { name: `${ext.toUpperCase()} Files`, extensions: [ext] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle("dialog:open-profile", async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: `Import ${profileKindLabel(kind)} profile`,
    properties: ["openFile"],
    filters: [
      { name: "Profile Files", extensions: ["json", "cfg", "ini", "txt", "chitubox", "cbprofile"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  return {
    path: filePath,
    text: await fs.readFile(filePath, "utf8")
  };
});

ipcMain.handle("dialog:save-profile", async (_event, kind, defaultName, content) => {
  const safeName = String(defaultName || `${kind || "profile"}.json`).replace(/[\\/:*?"<>|]+/g, "-");
  const result = await dialog.showSaveDialog({
    title: `Export ${profileKindLabel(kind)} profile`,
    defaultPath: safeName.endsWith(".json") ? safeName : `${safeName}.json`,
    filters: [
      { name: "JSON Profile", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, String(content || ""), "utf8");
  return result.filePath;
});

ipcMain.handle("file:read", async (_event, filePath) => {
  const data = await fs.readFile(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle("bridge:profiles", async () => runBridge("profiles", {}));
ipcMain.handle("bridge:preview", async (_event, payload) => runBridge("preview", payload));
ipcMain.handle("bridge:slice", async (event, payload) => {
  return runBridge("slice", payload, (message) => event.sender.send("slice:progress", message));
});

function pythonExecutable() {
  const bundled = path.resolve(__dirname, "..", "..", "..", "python", "python.exe");
  if (fsSync.existsSync(bundled)) return bundled;
  return process.env.PYTHON || "python";
}

function profileKindLabel(kind) {
  if (kind === "machine") return "machine";
  if (kind === "resin") return "resin";
  if (kind === "support") return "support";
  return "settings";
}

function runBridge(command, payload, onMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExecutable(),
      ["-m", "resin_slicer.electron_bridge", command],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
    );

    let stderr = "";
    let finalPayload = null;
    let stdoutBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleBridgeLine(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) handleBridgeLine(stdoutBuffer);
      if (finalPayload && finalPayload.type === "error") {
        reject(new Error(finalPayload.message));
      } else if (code !== 0) {
        reject(new Error(stderr || `Python bridge exited with code ${code}`));
      } else if (!finalPayload) {
        reject(new Error(stderr || "Python bridge returned no data"));
      } else {
        resolve(finalPayload);
      }
    });
    child.stdin.end(JSON.stringify(payload || {}));

    function handleBridgeLine(line) {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        stderr += line + "\n";
        return;
      }
      if (message.type === "progress" && onMessage) {
        onMessage(message);
      } else {
        finalPayload = message;
      }
    }
  });
}
