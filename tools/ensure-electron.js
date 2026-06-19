#!/usr/bin/env node
"use strict";

// Guarantees the Electron binary is actually unpacked after `npm install`.
//
// Electron's own postinstall (extract-zip) silently no-ops on some Node
// versions (observed with Node 24 on Windows): the binary zip downloads to the
// cache fine, but `node_modules/electron/dist` is left empty and `path.txt` is
// never written, so `electron .` fails with "Electron failed to install
// correctly" / "spawn electron ENOENT".
//
// This runs as the project's own postinstall (after Electron's), checks whether
// the binary is present, and if not, extracts the cached zip with the system
// `tar` (bundled on Windows 10 1803+, macOS, and Linux) and writes path.txt.
// It is idempotent: a healthy install is detected and left untouched.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const distDir = path.join(electronDir, "dist");

function platformExe() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

function isInstalled() {
  const exe = path.join(distDir, platformExe());
  const pathTxt = path.join(electronDir, "path.txt");
  return fs.existsSync(exe) && fs.existsSync(pathTxt);
}

function electronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
  return pkg.version;
}

function cacheRoot() {
  if (process.env.electron_config_cache) return process.env.electron_config_cache;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "electron", "Cache");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "electron");
  }
  return path.join(home, ".cache", "electron");
}

function findCachedZip(version) {
  const arch = process.env.npm_config_arch || process.arch;
  const wanted = `electron-v${version}-${process.platform}-${arch}.zip`;
  const root = cacheRoot();
  if (!fs.existsSync(root)) return null;
  // The cache stores each artifact under a hashed subdirectory.
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === wanted) return full;
    }
  }
  return null;
}

function ensureCachedZip(version) {
  let zip = findCachedZip(version);
  if (zip) return zip;
  // The zip isn't cached yet (or extraction never ran). Run Electron's own
  // installer once: the download step is reliable even when extraction is not,
  // and it populates the cache for us.
  try {
    execFileSync(process.execPath, [path.join(electronDir, "install.js")], { stdio: "inherit" });
  } catch {
    // ignore — we re-check below
  }
  if (isInstalled()) return null; // Electron's own extraction worked this time
  return findCachedZip(version);
}

function extractWithTar(zip) {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", distDir], { stdio: "inherit" });
  } catch (err) {
    throw new Error(
      "Could not extract the Electron binary with `tar`. Ensure tar is available " +
      "(bundled on Windows 10 1803+, macOS, Linux), then run `npm install` again.\n" +
      (err && err.message ? err.message : String(err))
    );
  }
}

function main() {
  if (!fs.existsSync(electronDir)) return; // electron not a dependency / not installed
  if (isInstalled()) return; // healthy — nothing to do

  const version = electronVersion();
  const zip = ensureCachedZip(version);
  if (!zip) {
    if (isInstalled()) return; // repaired by Electron's own installer
    throw new Error(
      `Electron ${version} binary is missing and no cached download was found. ` +
      "Check your network connection and run `npm install` again."
    );
  }

  console.log(`ensure-electron: repairing Electron ${version} binary from ${zip}`);
  extractWithTar(zip);

  // Mirror Electron's install.js: hoist type defs and write path.txt.
  const srcTypeDef = path.join(distDir, "electron.d.ts");
  if (fs.existsSync(srcTypeDef)) {
    fs.renameSync(srcTypeDef, path.join(electronDir, "electron.d.ts"));
  }
  fs.writeFileSync(path.join(electronDir, "path.txt"), platformExe());

  if (!isInstalled()) {
    throw new Error("ensure-electron: extraction completed but the Electron binary is still missing.");
  }
  console.log("ensure-electron: Electron binary is ready.");
}

main();
