const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const { spawn, execFileSync } = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const { createReadStream } = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "";
const isDev = Boolean(devServerUrl);
const uvtoolsPrinterApiUrl = "https://api.github.com/repos/sn4k3/UVtools/contents/PrusaSlicer/printer?ref=master";
const uvtoolsRawBaseUrl = "https://raw.githubusercontent.com/sn4k3/UVtools/master/";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(repoRoot, "assets", "resin-slicer.ico"),
    backgroundColor: "#111418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.once("ready-to-show", () => {
    win.showInactive();
  });

  if (isDev) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(repoRoot, "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on("uncaughtException", (error) => {
  showAppPrompt({
    title: "Resin Slicer Error",
    message: error.message || String(error),
    detail: error.stack || "",
    kind: "error"
  });
});

process.on("unhandledRejection", (reason) => {
  const message = reason && reason.stack ? reason.stack : String(reason);
  showAppPrompt({
    title: "Resin Slicer Error",
    message: reason && reason.message ? reason.message : String(reason),
    detail: message,
    kind: "error"
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("dialog:open-stl", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open Mesh",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Mesh Files", extensions: ["stl", "obj", "stp", "step"] },
      { name: "STL Mesh", extensions: ["stl"] },
      { name: "OBJ Mesh", extensions: ["obj"] },
      { name: "STEP CAD", extensions: ["stp", "step"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
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

ipcMain.handle("dialog:save-project", async (_event, defaultName, content) => {
  const safeName = String(defaultName || "resin-slicer-project.json").replace(/[\\/:*?"<>|]+/g, "-");
  const result = await dialog.showSaveDialog({
    title: "Save project",
    defaultPath: safeName.endsWith(".json") ? safeName : `${safeName}.json`,
    filters: [
      { name: "Resin Slicer Project", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, String(content || ""), "utf8");
  return result.filePath;
});

ipcMain.handle("dialog:open-profile", async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: `Import ${profileKindLabel(kind)} profile`,
    properties: ["openFile"],
    filters: [
      { name: "Profile Files", extensions: ["json", "cfg", "cfgx", "cfgd", "xml", "ini", "txt", "chitubox", "cbprofile"] },
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

ipcMain.handle("file:read-progress", async (event, payload) => {
  const filePath = String(payload?.filePath || "");
  const jobId = String(payload?.jobId || "");
  const stat = await fs.stat(filePath);
  const total = stat.size;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let loaded = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      chunks.push(chunk);
      loaded += chunk.length;
      event.sender.send("file:read-progress", {
        jobId,
        loaded,
        total,
        progress: total ? loaded / total : 1
      });
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const data = Buffer.concat(chunks);
      event.sender.send("file:read-progress", {
        jobId,
        loaded: total,
        total,
        progress: 1
      });
      resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    });
  });
});

ipcMain.handle("step:read-mesh", async (_event, filePath) => {
  const stlPath = await convertStepToStl(filePath);
  const data = await fs.readFile(stlPath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle("uvtools:list-printers", async () => {
  const response = await fetch(uvtoolsPrinterApiUrl, {
    headers: { "User-Agent": "Resin-Slicer" }
  });
  if (!response.ok) {
    throw new Error(`UVTools GitHub request failed: ${response.status} ${response.statusText}`);
  }
  const entries = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error("UVTools GitHub returned an unexpected printer list");
  }
  return {
    sourceUrl: "https://github.com/sn4k3/UVtools/tree/master/PrusaSlicer/printer",
    printers: entries
      .filter((entry) => entry.type === "file" && /\.ini$/i.test(entry.name))
      .map((entry) => ({
        name: entry.name.replace(/\.ini$/i, ""),
        path: entry.path,
        htmlUrl: entry.html_url,
        downloadUrl: entry.download_url
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
});

ipcMain.handle("uvtools:read-printer", async (_event, printerPath) => {
  const safePath = String(printerPath || "");
  if (!/^PrusaSlicer\/printer\/[^/]+\.ini$/i.test(safePath)) {
    throw new Error("Invalid UVTools printer profile path");
  }
  const url = uvtoolsRawBaseUrl + safePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(url, {
    headers: { "User-Agent": "Resin-Slicer" }
  });
  if (!response.ok) {
    throw new Error(`UVTools profile download failed: ${response.status} ${response.statusText}`);
  }
  return {
    path: safePath,
    sourceUrl: url,
    text: await response.text()
  };
});

ipcMain.handle("bridge:profiles", async () => runBridge("profiles", {}));
ipcMain.handle("bridge:preview", async (event, payload) => {
  return runBridge("preview", payload, (message) => event.sender.send("preview:progress", message));
});
ipcMain.handle("bridge:slice", async (event, payload) => {
  return runBridge("slice", payload, (message) => event.sender.send("slice:progress", message));
});

let cachedPython = null;

// Returns the concrete interpreter path for a candidate command if it is a
// Python >= 3.10, otherwise null. `py -3.12` etc. are resolved to the real
// python.exe so callers can spawn it with `-m` directly.
function probePython(command, args) {
  try {
    const script = "import sys;print('%d.%d|%s' % (sys.version_info[0], sys.version_info[1], sys.executable))";
    const out = execFileSync(command, [...args, "-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const [version, executable] = out.split("|");
    const [major, minor] = version.split(".").map((n) => parseInt(n, 10));
    if (major > 3 || (major === 3 && minor >= 10)) {
      return executable || command;
    }
  } catch {
    // not present / wrong version
  }
  return null;
}

function pythonExecutable() {
  // Packaged build ships its own interpreter next to the app.
  const bundled = path.resolve(__dirname, "..", "..", "..", "python", "python.exe");
  if (fsSync.existsSync(bundled)) return bundled;

  if (cachedPython) return cachedPython;

  // Detect a usable Python >= 3.10 rather than trusting bare `python`, which on
  // some machines resolves to an unrelated/old interpreter (e.g. a CAD suite's
  // bundled Python). An explicit PYTHON override is honored first if it's valid.
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  if (process.platform === "win32") {
    candidates.push(
      ["py", ["-3.12"]],
      ["py", ["-3.11"]],
      ["py", ["-3.10"]],
      ["py", ["-3"]],
      ["python", []],
      ["python3", []]
    );
  } else {
    candidates.push(["python3", []], ["python", []]);
  }

  for (const [command, args] of candidates) {
    const resolved = probePython(command, args);
    if (resolved) {
      cachedPython = resolved;
      return cachedPython;
    }
  }

  // Last resort: preserve previous behavior so the bridge surfaces a clear error.
  cachedPython = process.env.PYTHON || "python";
  return cachedPython;
}

function stepPythonExecutable() {
  const configured = process.env.RESIN_SLICER_STEP_PYTHON;
  if (configured && fsSync.existsSync(configured)) return configured;
  const skillPython = path.join(app.getPath("home"), ".codex", "skills", "cad", ".venv", "Scripts", "python.exe");
  if (fsSync.existsSync(skillPython)) return skillPython;
  return pythonExecutable();
}

function profileKindLabel(kind) {
  if (kind === "machine") return "machine";
  if (kind === "resin") return "resin";
  if (kind === "support") return "support";
  return "settings";
}

function showAppPrompt(payload) {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const target = BrowserWindow.getFocusedWindow() || windows[0];
  if (!target || target.webContents.isDestroyed()) {
    showStandalonePrompt(payload);
    return;
  }

  const sendPrompt = () => {
    if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
      target.webContents.send("app:prompt", payload);
    }
  };

  if (target.webContents.isLoading()) {
    target.webContents.once("did-finish-load", sendPrompt);
  } else {
    sendPrompt();
  }
}

function showStandalonePrompt(payload) {
  if (!app.isReady()) {
    app.whenReady().then(() => showStandalonePrompt(payload));
    return;
  }

  const prompt = new BrowserWindow({
    width: 500,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: payload.title || "Resin Slicer",
    icon: path.join(repoRoot, "assets", "resin-slicer.ico"),
    backgroundColor: "#181d23",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  prompt.setMenu(null);
  prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(standalonePromptHtml(payload))}`);
}

function standalonePromptHtml(payload) {
  const title = escapeHtml(payload.title || "Resin Slicer");
  const message = escapeHtml(payload.message || "Something needs your attention.");
  const detail = escapeHtml(payload.detail || "");
  const detailBlock = detail ? `<pre>${detail}</pre>` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root{color-scheme:dark;font-family:"Segoe UI",system-ui,sans-serif;background:#181d23;color:#eef2f5}
body{margin:0;background:#181d23}
main{display:grid;grid-template-columns:42px 1fr;gap:14px;padding:20px}
.icon{width:34px;height:34px;display:grid;place-items:center;border:1px solid #8f5353;border-radius:50%;color:#ff9b9b;background:#101419;font-weight:700}
h1{margin:0 0 8px;font-size:15px}
p{margin:0;color:#cdd6dd;font-size:13px;line-height:1.45}
pre{max-height:96px;overflow:auto;margin:12px 0 0;padding:10px;border:1px solid #2b333d;background:#0f1318;color:#aab5bf;font-size:12px;white-space:pre-wrap}
.actions{display:flex;justify-content:flex-end;margin-top:16px}
button{min-width:92px;border:1px solid #3c83cf;background:#2b6cb0;color:#eef2f5;border-radius:4px;padding:8px;font:inherit;cursor:pointer}
</style>
</head>
<body>
<main>
<div class="icon">!</div>
<section>
<h1>${title}</h1>
<p>${message}</p>
${detailBlock}
<div class="actions"><button autofocus onclick="window.close()">OK</button></div>
</section>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function runBridge(command, payload, onMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      payloadHasStepMesh(payload) ? stepPythonExecutable() : pythonExecutable(),
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
      if ((message.type === "progress" || message.type === "support") && onMessage) {
        onMessage(message);
      } else {
        finalPayload = message;
      }
    }
  });
}

function convertStepToStl(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      stepPythonExecutable(),
      ["-m", "resin_slicer.step", String(filePath || "")],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `STEP conversion exited with code ${code}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        if (!payload.outputPath) throw new Error("STEP converter returned no output path");
        resolve(payload.outputPath);
      } catch (error) {
        reject(new Error(stderr || error.message));
      }
    });
  });
}

function payloadHasStepMesh(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (isStepMeshPath(payload.inputPath)) return true;
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models.some((model) => isStepMeshPath(model?.inputPath || model?.path));
}

function isStepMeshPath(filePath) {
  return /\.(stp|step)$/i.test(String(filePath || ""));
}
