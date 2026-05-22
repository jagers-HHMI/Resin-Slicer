const $ = (id) => document.getElementById(id);

const fields = [
  "machineName", "resolutionX", "resolutionY", "sizeX", "sizeY", "sizeZ", "layerHeight",
  "resinName", "exposure", "bottomExposure", "bottomLayers", "transitionLayers",
  "liftDistance", "liftSpeed", "retractDistance", "retractSpeed",
  "waitAfterRetract", "resinDensity", "lightPwm", "bottomLightPwm",
  "rotateX", "rotateY", "rotateZ", "translateX", "translateY", "translateZ",
  "scale", "modelLift", "overhangAngle", "supportSpacing", "postRadius",
  "primaryDensityMultiplier", "primaryAreaRadius", "primaryMaxExtra",
  "tipRadius", "tipType", "tipLength", "tipAngle", "footRadius",
  "bedInterface", "raftMargin", "collisionClearance", "maxBaseReach",
  "maxSupportAngle", "enforcerReach", "enforcerMinDrop",
  "braceRadius", "braceHeight", "braceDistance"
];

let profiles = {};
let models = [];
let supports = [];
let supportBraces = [];
let viewer = null;

async function init() {
  viewer = new Viewer($("viewer"));
  $("openButton").addEventListener("click", openStl);
  $("inputPath").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadStlPaths(parseInputPaths($("inputPath").value), { append: false });
  });
  $("saveButton").addEventListener("click", chooseOutput);
  $("importMachineButton").addEventListener("click", () => importProfile("machine"));
  $("exportMachineButton").addEventListener("click", () => exportProfile("machine"));
  $("importResinButton").addEventListener("click", () => importProfile("resin"));
  $("exportResinButton").addEventListener("click", () => exportProfile("resin"));
  $("importSupportButton").addEventListener("click", () => importProfile("support"));
  $("exportSupportButton").addEventListener("click", () => exportProfile("support"));
  $("previewButton").addEventListener("click", generatePreview);
  $("sliceButton").addEventListener("click", slice);
  $("profile").addEventListener("change", () => {
    loadProfileDefaults();
    updateScene();
  });
  $("format").addEventListener("change", () => {
    if (models.length && !$("outputPath").value) setDefaultOutput();
  });
  $("centerModel").addEventListener("change", updateScene);
  $("supportsEnabled").addEventListener("change", updateScene);
  $("primarySupportsEnabled").addEventListener("change", updateScene);
  $("enforcersEnabled").addEventListener("change", updateScene);
  $("braceEnabled").addEventListener("change", updateScene);
  for (const id of fields) {
    $(id).addEventListener("input", updateScene);
  }
  initDropLoading();

  window.slicer.onSliceProgress((message) => log(message.message));
  try {
    const profilePayload = await window.slicer.profiles();
    profiles = profilePayload.profiles || {};
    for (const name of Object.keys(profiles).sort()) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      $("profile").appendChild(option);
    }
    $("profile").value = profiles["generic-2k"] ? "generic-2k" : Object.keys(profiles)[0] || "";
    loadProfileDefaults();
  } catch (error) {
    log(`Could not load Python profiles: ${error.message}`);
    profiles = {
      "generic-2k": {
        resolution_x: 1920,
        resolution_y: 1080,
        size_x_mm: 120,
        size_y_mm: 67.5,
        size_z_mm: 160,
        layer_height_mm: 0.05,
        exposure_time_s: 2.5,
        bottom_exposure_time_s: 35,
        bottom_layers: 6,
        transition_layers: 6,
        lift_distance_mm: 5,
        lift_speed_mm_min: 65,
        retract_distance_mm: 5,
        retract_speed_mm_min: 150,
        wait_after_retract_s: 0.2,
        light_pwm: 255,
        bottom_light_pwm: 255,
        machine_name: "Generic MSLA",
        resin_name: "Standard",
        resin_density_g_ml: 1.1
      }
    };
    const option = document.createElement("option");
    option.value = "generic-2k";
    option.textContent = "generic-2k";
    $("profile").appendChild(option);
    $("profile").value = "generic-2k";
    loadProfileDefaults();
  }

  updateScene();
}

async function openStl() {
  try {
    const paths = await window.slicer.openStl();
    if (!paths || !paths.length) {
      log("Open mesh canceled.");
      return;
    }
    await loadStlPaths(paths, { append: false });
  } catch (error) {
    log(`Open mesh failed: ${error.message}`);
  }
}

async function loadStlPaths(paths, { append = false } = {}) {
  const nextPaths = normalizeStlPaths(paths);
  if (!nextPaths.length) {
    log("Choose or drop at least one STL or OBJ file.");
    return;
  }

  const loaded = append ? models.slice() : [];
  const loadedKeys = new Set(loaded.map((item) => item.path.toLowerCase()));
  for (const path of nextPaths) {
    const key = path.toLowerCase();
    if (loadedKeys.has(key)) continue;
    log(`Loading ${path}`);
    const bytes = new Uint8Array(await window.slicer.readFile(path));
    const mesh = parseMesh(path, bytes);
    loaded.push({ path, name: fileName(path), mesh });
    loadedKeys.add(key);
    log(`Loaded ${fileName(path)} (${mesh.triangleCount.toLocaleString()} triangles)`);
  }

  models = loaded;
  supports = [];
  supportBraces = [];
  $("inputPath").value = models.map((item) => item.path).join("; ");
  if (!append) $("outputPath").value = "";
  setDefaultOutput();
  const triangleCount = models.reduce((sum, item) => sum + item.mesh.triangleCount, 0);
  $("meshStatus").textContent = `${models.length.toLocaleString()} mesh${models.length === 1 ? "" : "es"}, ${triangleCount.toLocaleString()} triangles`;
  $("supportStatus").textContent = "Supports not generated";
  if (models.length > 1) log(`Arranged ${models.length} mesh files on the build plate`);
  updateScene();
}

async function chooseOutput() {
  const path = await window.slicer.saveOutput($("format").value);
  if (path) $("outputPath").value = path;
}

function setDefaultOutput() {
  const ext = $("format").value;
  if (!models.length || $("outputPath").value) return;
  $("outputPath").value = defaultOutputPath(models, ext);
}

function initDropLoading() {
  const shell = document.querySelector(".viewer-shell");
  const dropTarget = shell || document.body;
  for (const eventName of ["dragenter", "dragover"]) {
    dropTarget.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (shell) shell.classList.add("drag-over");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropTarget.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === "drop") handleDrop(event);
      if (shell) shell.classList.remove("drag-over");
    });
  }
}

async function handleDrop(event) {
  const files = Array.from(event.dataTransfer?.files || []);
  const paths = files
    .map((file) => window.slicer.pathForFile ? window.slicer.pathForFile(file) : file.path)
    .filter(isSupportedMeshPath);
  if (!paths.length) {
    log("Drop one or more STL or OBJ files into the viewer.");
    return;
  }
  await loadStlPaths(paths, { append: models.length > 0 });
}

function parseInputPaths(text) {
  return String(text || "")
    .split(/[\r\n;]+/)
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function normalizeStlPaths(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const seen = new Set();
  const out = [];
  for (const rawPath of list) {
    const path = String(rawPath || "").trim();
    if (!isSupportedMeshPath(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function defaultOutputPath(items, ext) {
  if (items.length === 1) return replaceExtension(items[0].path, ext);
  const firstPath = items[0].path;
  const separatorIndex = Math.max(firstPath.lastIndexOf("\\"), firstPath.lastIndexOf("/"));
  const directory = separatorIndex >= 0 ? firstPath.slice(0, separatorIndex + 1) : "";
  return `${directory}resin-slicer-job.${ext}`;
}

function replaceExtension(path, ext) {
  return path.replace(/\.[^.\\/]+$/, `.${ext}`);
}

function fileName(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function isSupportedMeshPath(path) {
  return /\.(stl|obj)$/i.test(path || "");
}

async function importProfile(kind) {
  try {
    const file = await window.slicer.openProfile(kind);
    if (!file) {
      log(`Import ${kind} canceled.`);
      return;
    }
    const imported = parseImportedProfile(file.text);
    const changed = applyImportedProfile(kind, imported.flat);
    if (!changed) {
      log(`No recognizable ${kind} settings found in ${file.path}`);
      return;
    }
    log(`Imported ${kind} profile from ${file.path}`);
    updateScene();
  } catch (error) {
    log(`Import ${kind} failed: ${error.message}`);
  }
}

async function exportProfile(kind) {
  try {
    const payload = buildExportProfile(kind);
    const content = JSON.stringify(payload, null, 2);
    const path = await window.slicer.saveProfile(kind, profileFileName(kind), content);
    if (path) log(`Exported ${kind} profile to ${path}`);
  } catch (error) {
    log(`Export ${kind} failed: ${error.message}`);
  }
}

async function generatePreview() {
  if (!ensureReady(false)) return;
  setBusy(true);
  log("Generating support preview...");
  try {
    const result = await window.slicer.preview(collectPayload());
    supports = result.supports || [];
    supportBraces = result.braces || [];
    $("supportStatus").textContent = `${supports.length.toLocaleString()} supports previewed`;
    viewer.setSupports(supports, supportBraces);
    log(`Preview: ${result.layers} layers, ${supports.length} supports, ${supportBraces.length} braces`);
  } catch (error) {
    log(`Preview failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function slice() {
  if (!ensureReady(true)) return;
  setBusy(true);
  log("Slicing...");
  try {
    const result = await window.slicer.slice(collectPayload());
    log(`Done: ${result.outputPath}`);
    log(`${result.layers} layers, ${result.supports} supports, ${result.materialMl.toFixed(2)} ml resin`);
  } catch (error) {
    log(`Slice failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function ensureReady(requireOutput) {
  if (!models.length) {
    log("Open or drop at least one STL or OBJ first.");
    return false;
  }
  if (requireOutput && !$("outputPath").value.trim()) {
    log("Choose an output path first.");
    return false;
  }
  return true;
}

function collectPayload() {
  const payload = basePayload();
  payload.inputPath = models[0]?.path || "";
  payload.models = [];
  if (models.length) {
    const arranged = arrangeModels(payload);
    payload.models = arranged.placements.map((placement) => ({
      inputPath: placement.model.path,
      name: placement.model.name,
      transform: placement.transform
    }));
  }
  return payload;
}

function basePayload() {
  return {
    outputPath: $("outputPath").value.trim(),
    format: $("format").value,
    profile: $("profile").value,
    centerModel: $("centerModel").checked,
    printer: {
      machineName: $("machineName").value.trim(),
      resolutionX: number("resolutionX"),
      resolutionY: number("resolutionY"),
      sizeX: number("sizeX"),
      sizeY: number("sizeY"),
      sizeZ: number("sizeZ"),
      layerHeight: number("layerHeight"),
      resinName: $("resinName").value.trim(),
      exposure: number("exposure"),
      bottomExposure: number("bottomExposure"),
      bottomLayers: intNumber("bottomLayers"),
      transitionLayers: intNumber("transitionLayers"),
      liftDistance: number("liftDistance"),
      liftSpeed: number("liftSpeed"),
      retractDistance: number("retractDistance"),
      retractSpeed: number("retractSpeed"),
      waitAfterRetract: number("waitAfterRetract"),
      resinDensity: number("resinDensity"),
      lightPwm: intNumber("lightPwm"),
      bottomLightPwm: intNumber("bottomLightPwm")
    },
    transform: {
      rotateX: number("rotateX"),
      rotateY: number("rotateY"),
      rotateZ: number("rotateZ"),
      translateX: number("translateX"),
      translateY: number("translateY"),
      translateZ: number("translateZ"),
      scale: number("scale")
    },
    support: {
      enabled: $("supportsEnabled").checked,
      modelLift: number("modelLift"),
      overhangAngle: number("overhangAngle"),
      spacing: number("supportSpacing"),
      primarySupportsEnabled: $("primarySupportsEnabled").checked,
      primaryDensityMultiplier: number("primaryDensityMultiplier"),
      primaryAreaRadius: number("primaryAreaRadius"),
      primaryMaxExtra: intNumber("primaryMaxExtra"),
      postRadius: number("postRadius"),
      tipRadius: number("tipRadius"),
      tipType: $("tipType").value,
      tipLength: number("tipLength"),
      tipAngle: number("tipAngle"),
      footRadius: number("footRadius"),
      bedInterface: $("bedInterface").value,
      raftMargin: number("raftMargin"),
      collisionClearance: number("collisionClearance"),
      maxBaseReach: number("maxBaseReach"),
      maxSupportAngle: number("maxSupportAngle"),
      enforcersEnabled: $("enforcersEnabled").checked,
      enforcerReach: number("enforcerReach"),
      enforcerMinDrop: number("enforcerMinDrop"),
      braceEnabled: $("braceEnabled").checked,
      braceRadius: number("braceRadius"),
      braceHeight: number("braceHeight"),
      braceDistance: number("braceDistance")
    }
  };
}

function parseImportedProfile(text) {
  try {
    return { flat: flattenProfile(JSON.parse(text)) };
  } catch (_error) {
    return { flat: flattenProfile(parseKeyValueProfile(text)) };
  }
}

function parseKeyValueProfile(text) {
  const root = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const match = line.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const key = section ? `${section}.${match[1].trim()}` : match[1].trim();
    root[key] = coerceImportedValue(match[2].trim());
  }
  return root;
}

function flattenProfile(value, prefix = "", out = {}) {
  if (Array.isArray(value)) return out;
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenProfile(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  const pathKey = normalizeProfileKey(prefix);
  const leafKey = normalizeProfileKey(prefix.split(".").pop() || prefix);
  if (pathKey && out[pathKey] === undefined) out[pathKey] = value;
  if (leafKey && out[leafKey] === undefined) out[leafKey] = value;
  return out;
}

function normalizeProfileKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function coerceImportedValue(value) {
  const unquoted = String(value).replace(/^["']|["']$/g, "");
  if (/^(true|yes|on)$/i.test(unquoted)) return true;
  if (/^(false|no|off)$/i.test(unquoted)) return false;
  const numberMatch = unquoted.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (numberMatch && numberMatch[0].length === unquoted.trim().length) return Number(numberMatch[0]);
  return unquoted;
}

function applyImportedProfile(kind, flat) {
  if (kind === "machine") return applyMachineProfile(flat);
  if (kind === "resin") return applyResinProfile(flat);
  if (kind === "support") return applySupportProfile(flat);
  return 0;
}

function applyMachineProfile(flat) {
  let changed = 0;
  changed += applyTextValue("machineName", flat, ["machineName", "printerName", "machine_name", "printer_name", "name"]);
  changed += applyNumberValue("resolutionX", flat, ["resolutionX", "xResolution", "resolution_x", "screenX", "screenResolutionX", "pixelsX"]);
  changed += applyNumberValue("resolutionY", flat, ["resolutionY", "yResolution", "resolution_y", "screenY", "screenResolutionY", "pixelsY"]);
  changed += applyNumberValue("sizeX", flat, ["sizeX", "size_x_mm", "machineWidth", "buildPlateX", "buildVolumeX", "printX", "xSize"]);
  changed += applyNumberValue("sizeY", flat, ["sizeY", "size_y_mm", "machineDepth", "machineLength", "buildPlateY", "buildVolumeY", "printY", "ySize"]);
  changed += applyNumberValue("sizeZ", flat, ["sizeZ", "size_z_mm", "machineHeight", "buildVolumeZ", "printZ", "zSize"]);
  changed += applyNumberValue("layerHeight", flat, ["layerHeight", "layer_height_mm", "layerThickness"]);
  return changed;
}

function applyResinProfile(flat) {
  let changed = 0;
  changed += applyTextValue("resinName", flat, ["resinName", "materialName", "profileName", "name"]);
  changed += applyNumberValue("exposure", flat, ["exposure", "exposureTime", "exposure_time_s", "normalExposure", "normalExposureTime"]);
  changed += applyNumberValue("bottomExposure", flat, ["bottomExposure", "bottomExposureTime", "bottom_exposure_time_s", "baseExposure"]);
  changed += applyNumberValue("bottomLayers", flat, ["bottomLayers", "bottomLayerCount", "bottom_layers", "baseLayers"], Math.round);
  changed += applyNumberValue("transitionLayers", flat, ["transitionLayers", "transitionLayerCount", "transition_layers"], Math.round);
  changed += applyNumberValue("liftDistance", flat, ["liftDistance", "liftingDistance", "lift_distance_mm", "liftHeight", "normalLiftDistance"]);
  changed += applyNumberValue("liftSpeed", flat, ["liftSpeed", "liftingSpeed", "lift_speed_mm_min", "normalLiftSpeed"]);
  changed += applyNumberValue("retractDistance", flat, ["retractDistance", "retract_distance_mm", "retractHeight"]);
  changed += applyNumberValue("retractSpeed", flat, ["retractSpeed", "retract_speed_mm_min", "zRetractSpeed"]);
  changed += applyNumberValue("waitAfterRetract", flat, ["waitAfterRetract", "wait_after_retract_s", "restTimeAfterRetract", "lightOffDelay", "offTime"]);
  changed += applyNumberValue("resinDensity", flat, ["resinDensity", "density", "resin_density_g_ml"]);
  changed += applyNumberValue("lightPwm", flat, ["lightPwm", "lightPWM", "normalLightPwm", "normalLightPWM", "pwm"], Math.round);
  changed += applyNumberValue("bottomLightPwm", flat, ["bottomLightPwm", "bottomLightPWM", "bottom_light_pwm", "bottomPwm", "bottomPWM"], Math.round);
  return changed;
}

function applySupportProfile(flat) {
  let changed = 0;
  changed += applyCheckedValue("supportsEnabled", flat, ["supportsEnabled", "enabled"]);
  changed += applyNumberValue("modelLift", flat, ["modelLift", "model_lift_mm"]);
  changed += applyNumberValue("overhangAngle", flat, ["overhangAngle", "overhang_angle_deg"]);
  changed += applyNumberValue("supportSpacing", flat, ["supportSpacing", "spacing", "support_spacing_mm"]);
  changed += applyCheckedValue("primarySupportsEnabled", flat, ["primarySupportsEnabled", "primary_supports_enabled"]);
  changed += applyNumberValue("primaryDensityMultiplier", flat, ["primaryDensityMultiplier", "primary_density_multiplier"]);
  changed += applyNumberValue("primaryAreaRadius", flat, ["primaryAreaRadius", "primary_area_radius_mm"]);
  changed += applyNumberValue("primaryMaxExtra", flat, ["primaryMaxExtra", "primary_max_extra_per_island"], Math.round);
  changed += applyNumberValue("postRadius", flat, ["postRadius", "supportRadius", "post_radius_mm"]);
  changed += applyNumberValue("tipRadius", flat, ["tipRadius", "contactRadius", "tip_radius_mm"]);
  changed += applySelectValue("tipType", flat, ["tipType", "tip_type"], ["cone", "sphere", "cylinder"]);
  changed += applyNumberValue("tipLength", flat, ["tipLength", "tip_length_mm"]);
  changed += applyNumberValue("tipAngle", flat, ["tipAngle", "tip_angle_deg"]);
  changed += applyNumberValue("footRadius", flat, ["footRadius", "foot_radius_mm"]);
  changed += applySelectValue("bedInterface", flat, ["bedInterface", "bed_interface"], ["none", "feet", "raft", "skate"]);
  changed += applyNumberValue("raftMargin", flat, ["raftMargin", "raft_margin_mm"]);
  changed += applyNumberValue("collisionClearance", flat, ["collisionClearance", "collision_clearance_mm", "pathClearance"]);
  changed += applyNumberValue("maxBaseReach", flat, ["maxBaseReach", "max_base_reach_mm"]);
  changed += applyNumberValue("maxSupportAngle", flat, ["maxSupportAngle", "max_support_angle_deg"]);
  changed += applyCheckedValue("enforcersEnabled", flat, ["enforcersEnabled", "enforcers_enabled"]);
  changed += applyNumberValue("enforcerReach", flat, ["enforcerReach", "enforcer_reach_mm"]);
  changed += applyNumberValue("enforcerMinDrop", flat, ["enforcerMinDrop", "enforcer_min_drop_mm"]);
  changed += applyCheckedValue("braceEnabled", flat, ["braceEnabled", "brace_enabled"]);
  changed += applyNumberValue("braceRadius", flat, ["braceRadius", "brace_radius_mm"]);
  changed += applyNumberValue("braceHeight", flat, ["braceHeight", "brace_height_mm"]);
  changed += applyNumberValue("braceDistance", flat, ["braceDistance", "brace_max_distance_mm"]);
  return changed;
}

function applyTextValue(id, flat, keys) {
  const value = profileValue(flat, keys);
  if (value === undefined || value === null || value === "") return 0;
  $(id).value = String(value);
  return 1;
}

function applyNumberValue(id, flat, keys, transform = (value) => value) {
  const value = profileValue(flat, keys);
  const numberValue = importedNumber(value);
  if (!Number.isFinite(numberValue)) return 0;
  $(id).value = transform(numberValue);
  return 1;
}

function applyCheckedValue(id, flat, keys) {
  const value = profileValue(flat, keys);
  if (value === undefined) return 0;
  $(id).checked = importedBoolean(value);
  return 1;
}

function applySelectValue(id, flat, keys, allowed) {
  const value = profileValue(flat, keys);
  if (value === undefined || value === null) return 0;
  const normalized = String(value).toLowerCase();
  if (!allowed.includes(normalized)) return 0;
  $(id).value = normalized;
  return 1;
}

function profileValue(flat, keys) {
  for (const key of keys) {
    const normalized = normalizeProfileKey(key);
    if (flat[normalized] !== undefined) return flat[normalized];
  }
  return undefined;
}

function importedNumber(value) {
  if (typeof value === "number") return value;
  const match = String(value ?? "").match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function importedBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(true|yes|on|1)$/i.test(String(value).trim());
}

function buildExportProfile(kind) {
  if (kind === "machine") {
    const settings = currentMachineProfile();
    return {
      schema: "resin-slicer-profile",
      version: 1,
      profileType: "machine",
      settings,
      chitubox: {
        machineName: settings.machineName,
        resolutionX: settings.resolutionX,
        resolutionY: settings.resolutionY,
        machineWidth: settings.sizeX,
        machineDepth: settings.sizeY,
        machineHeight: settings.sizeZ,
        layerHeight: settings.layerHeight
      }
    };
  }
  if (kind === "resin") {
    const settings = currentResinProfile();
    return {
      schema: "resin-slicer-profile",
      version: 1,
      profileType: "resin",
      settings,
      chitubox: {
        resinName: settings.resinName,
        normalExposureTime: settings.exposure,
        bottomExposureTime: settings.bottomExposure,
        bottomLayerCount: settings.bottomLayers,
        transitionLayerCount: settings.transitionLayers,
        liftingDistance: settings.liftDistance,
        liftingSpeed: settings.liftSpeed,
        retractDistance: settings.retractDistance,
        retractSpeed: settings.retractSpeed,
        lightOffDelay: settings.waitAfterRetract,
        resinDensity: settings.resinDensity
      }
    };
  }
  return {
    schema: "resin-slicer-profile",
    version: 1,
    profileType: "support",
    settings: currentSupportProfile()
  };
}

function currentMachineProfile() {
  return {
    machineName: $("machineName").value.trim(),
    profile: $("profile").value,
    resolutionX: intNumber("resolutionX"),
    resolutionY: intNumber("resolutionY"),
    sizeX: number("sizeX"),
    sizeY: number("sizeY"),
    sizeZ: number("sizeZ"),
    layerHeight: number("layerHeight")
  };
}

function currentResinProfile() {
  return {
    resinName: $("resinName").value.trim(),
    exposure: number("exposure"),
    bottomExposure: number("bottomExposure"),
    bottomLayers: intNumber("bottomLayers"),
    transitionLayers: intNumber("transitionLayers"),
    liftDistance: number("liftDistance"),
    liftSpeed: number("liftSpeed"),
    retractDistance: number("retractDistance"),
    retractSpeed: number("retractSpeed"),
    waitAfterRetract: number("waitAfterRetract"),
    resinDensity: number("resinDensity"),
    lightPwm: intNumber("lightPwm"),
    bottomLightPwm: intNumber("bottomLightPwm")
  };
}

function currentSupportProfile() {
  return collectPayload().support;
}

function profileFileName(kind) {
  const base = kind === "machine"
    ? $("machineName").value
    : kind === "resin"
      ? $("resinName").value
      : "support-settings";
  const safe = String(base || kind).trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || kind;
  return `${safe}-${kind}.json`;
}

function loadProfileDefaults() {
  const cfg = profiles[$("profile").value];
  if (!cfg) return;
  $("machineName").value = cfg.machine_name || "Generic MSLA";
  $("resolutionX").value = cfg.resolution_x;
  $("resolutionY").value = cfg.resolution_y;
  $("sizeX").value = cfg.size_x_mm;
  $("sizeY").value = cfg.size_y_mm;
  $("sizeZ").value = cfg.size_z_mm;
  $("layerHeight").value = cfg.layer_height_mm;
  $("resinName").value = cfg.resin_name || "Standard";
  $("exposure").value = cfg.exposure_time_s ?? 2.5;
  $("bottomExposure").value = cfg.bottom_exposure_time_s ?? 35;
  $("bottomLayers").value = cfg.bottom_layers ?? 6;
  $("transitionLayers").value = cfg.transition_layers ?? 6;
  $("liftDistance").value = cfg.lift_distance_mm ?? 5;
  $("liftSpeed").value = cfg.lift_speed_mm_min ?? 65;
  $("retractDistance").value = cfg.retract_distance_mm ?? 5;
  $("retractSpeed").value = cfg.retract_speed_mm_min ?? 150;
  $("waitAfterRetract").value = cfg.wait_after_retract_s ?? 0.2;
  $("lightPwm").value = cfg.light_pwm ?? 255;
  $("bottomLightPwm").value = cfg.bottom_light_pwm ?? 255;
  $("resinDensity").value = cfg.resin_density_g_ml ?? 1.1;
}

function updateScene() {
  if (!models.length) {
    viewer.setBed(number("sizeX"), number("sizeY"), number("sizeZ"));
    viewer.setPart(null);
    viewer.setSupports([], []);
    return;
  }
  supports = [];
  supportBraces = [];
  $("supportStatus").textContent = "Support preview stale";
  const payload = basePayload();
  const arranged = arrangeModels(payload);
  if (arranged.overflow) {
    $("supportStatus").textContent = "Arranged models exceed build plate";
  }
  viewer.setBed(payload.printer.sizeX, payload.printer.sizeY, payload.printer.sizeZ);
  viewer.setPart(placeGroupMesh(arranged.mesh, payload));
  viewer.setSupports(supports, supportBraces);
}

function number(id) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : 0;
}

function intNumber(id) {
  return Math.round(number(id));
}

function log(message) {
  const out = $("log");
  out.textContent += `${message}\n`;
  out.scrollTop = out.scrollHeight;
}

function setBusy(busy) {
  $("previewButton").disabled = busy;
  $("sliceButton").disabled = busy;
}

function parseMesh(path, bytes) {
  if (/\.obj$/i.test(path)) return parseObj(new TextDecoder().decode(bytes));
  return parseStl(bytes);
}

function parseStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.byteLength) return parseBinaryStl(view, count);
  }
  return parseAsciiStl(new TextDecoder().decode(bytes));
}

function parseBinaryStl(view, triangleCount) {
  const vertices = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);
  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    const normal = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
    offset += 12;
    for (let v = 0; v < 3; v++) {
      const base = i * 9 + v * 3;
      vertices[base] = view.getFloat32(offset, true);
      vertices[base + 1] = view.getFloat32(offset + 4, true);
      vertices[base + 2] = view.getFloat32(offset + 8, true);
      normals[base] = normal[0];
      normals[base + 1] = normal[1];
      normals[base + 2] = normal[2];
      offset += 12;
    }
    offset += 2;
  }
  normalizeMissingNormals(vertices, normals);
  return { vertices, normals, triangleCount, bounds: boundsFor(vertices) };
}

function parseAsciiStl(text) {
  const points = [];
  const regex = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let match;
  while ((match = regex.exec(text))) {
    points.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const vertices = new Float32Array(points);
  const normals = new Float32Array(vertices.length);
  normalizeMissingNormals(vertices, normals);
  return { vertices, normals, triangleCount: vertices.length / 9, bounds: boundsFor(vertices) };
}

function parseObj(text) {
  const points = [];
  const values = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0].toLowerCase() === "v") {
      if (parts.length < 4) throw new Error(`Invalid OBJ vertex line: ${rawLine}`);
      points.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      if (points[points.length - 1].some((value) => !Number.isFinite(value))) {
        throw new Error(`Invalid OBJ vertex line: ${rawLine}`);
      }
    } else if (parts[0].toLowerCase() === "f") {
      if (parts.length < 4) throw new Error(`Invalid OBJ face line: ${rawLine}`);
      const face = parts.slice(1).map((token) => objVertex(points, token, rawLine));
      for (let i = 1; i < face.length - 1; i++) {
        values.push(...face[0], ...face[i], ...face[i + 1]);
      }
    }
  }
  if (!values.length) throw new Error("OBJ contains no faces");
  const vertices = new Float32Array(values);
  const normals = new Float32Array(vertices.length);
  normalizeMissingNormals(vertices, normals);
  return { vertices, normals, triangleCount: vertices.length / 9, bounds: boundsFor(vertices) };
}

function objVertex(points, token, rawLine) {
  const indexText = String(token).split("/", 1)[0];
  const index = Number.parseInt(indexText, 10);
  if (!Number.isInteger(index) || index === 0) throw new Error(`Invalid OBJ face line: ${rawLine}`);
  const resolved = index > 0 ? index - 1 : points.length + index;
  if (resolved < 0 || resolved >= points.length) throw new Error(`OBJ face references missing vertex ${index}: ${rawLine}`);
  return points[resolved];
}

function normalizeMissingNormals(vertices, normals) {
  for (let i = 0; i < vertices.length; i += 9) {
    let n = [normals[i], normals[i + 1], normals[i + 2]];
    if (length(n) < 0.001) {
      const a = [vertices[i], vertices[i + 1], vertices[i + 2]];
      const b = [vertices[i + 3], vertices[i + 4], vertices[i + 5]];
      const c = [vertices[i + 6], vertices[i + 7], vertices[i + 8]];
      n = normalize(cross(sub(b, a), sub(c, a)));
    } else {
      n = normalize(n);
    }
    for (let v = 0; v < 3; v++) {
      const base = i + v * 3;
      normals[base] = n[0];
      normals[base + 1] = n[1];
      normals[base + 2] = n[2];
    }
  }
}

function arrangeModels(payload) {
  const orientedModels = models.map((model) => {
    const oriented = orientMesh(model.mesh, payload.transform);
    const bounds = oriented.bounds;
    return {
      model,
      mesh: oriented,
      width: bounds.maxX - bounds.minX,
      depth: bounds.maxY - bounds.minY,
      height: bounds.maxZ - bounds.minZ
    };
  });
  const ordered = orientedModels
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => Math.max(b.depth, b.width) - Math.max(a.depth, a.width) || a.index - b.index);
  const gap = models.length > 1 ? 4 : 0;
  const bedX = payload.printer.sizeX || 120;
  let cursorX = 0;
  let cursorY = 0;
  let rowDepth = 0;
  let extentX = 0;
  let extentY = 0;
  let overflow = false;
  const placementsByIndex = [];
  const placedMeshes = [];

  for (const item of ordered) {
    if (cursorX > 0 && cursorX + item.width > bedX) {
      cursorX = 0;
      cursorY += rowDepth + gap;
      rowDepth = 0;
    }
    const transform = {
      rotateX: payload.transform.rotateX,
      rotateY: payload.transform.rotateY,
      rotateZ: payload.transform.rotateZ,
      scale: payload.transform.scale,
      translateX: cursorX - item.mesh.bounds.minX,
      translateY: cursorY - item.mesh.bounds.minY,
      translateZ: -item.mesh.bounds.minZ
    };
    const placed = translateMesh(item.mesh, transform.translateX, transform.translateY, transform.translateZ);
    const placedBounds = placed.bounds;
    extentX = Math.max(extentX, placedBounds.maxX);
    extentY = Math.max(extentY, placedBounds.maxY);
    rowDepth = Math.max(rowDepth, item.depth);
    cursorX += item.width + gap;
    placementsByIndex[item.index] = { model: item.model, transform };
    placedMeshes.push(placed);
  }

  overflow = extentX > payload.printer.sizeX || extentY > payload.printer.sizeY;
  return {
    placements: placementsByIndex.filter(Boolean),
    mesh: combineMeshes(placedMeshes),
    overflow
  };
}

function orientMesh(source, transform) {
  const t = transform;
  const bounds = source.bounds;
  const origin = [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  ];
  const angles = [deg(t.rotateX), deg(t.rotateY), deg(t.rotateZ)];
  const oriented = new Float32Array(source.vertices.length);
  const orientedNormals = new Float32Array(source.normals.length);
  for (let i = 0; i < source.vertices.length; i += 3) {
    let point = [
      (source.vertices[i] - origin[0]) * t.scale,
      (source.vertices[i + 1] - origin[1]) * t.scale,
      (source.vertices[i + 2] - origin[2]) * t.scale
    ];
    point = rotatePoint(point, angles);
    oriented[i] = point[0] + origin[0];
    oriented[i + 1] = point[1] + origin[1];
    oriented[i + 2] = point[2] + origin[2];
    const normal = rotatePoint([source.normals[i], source.normals[i + 1], source.normals[i + 2]], angles);
    orientedNormals[i] = normal[0];
    orientedNormals[i + 1] = normal[1];
    orientedNormals[i + 2] = normal[2];
  }
  return { vertices: oriented, normals: orientedNormals, triangleCount: source.triangleCount, bounds: boundsFor(oriented) };
}

function placeGroupMesh(source, payload) {
  const t = payload.transform;
  const printer = payload.printer;
  const centerModel = payload.centerModel;
  const lift = payload.support.enabled ? payload.support.modelLift : 0;
  const bounds = source.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  const ox = (centerModel ? (printer.sizeX - width) / 2 : 0) - bounds.minX + t.translateX;
  const oy = (centerModel ? (printer.sizeY - depth) / 2 : 0) - bounds.minY + t.translateY;
  const oz = lift + t.translateZ - bounds.minZ;
  return translateMesh(source, ox, oy, oz);
}

function translateMesh(source, x, y, z) {
  const vertices = new Float32Array(source.vertices.length);
  for (let i = 0; i < source.vertices.length; i += 3) {
    vertices[i] = source.vertices[i] + x;
    vertices[i + 1] = source.vertices[i + 1] + y;
    vertices[i + 2] = source.vertices[i + 2] + z;
  }
  return {
    vertices,
    normals: source.normals,
    triangleCount: source.triangleCount,
    bounds: boundsFor(vertices)
  };
}

function combineMeshes(items) {
  const totalVertices = items.reduce((sum, item) => sum + item.vertices.length, 0);
  const vertices = new Float32Array(totalVertices);
  const normals = new Float32Array(totalVertices);
  let offset = 0;
  let triangleCount = 0;
  for (const item of items) {
    vertices.set(item.vertices, offset);
    normals.set(item.normals, offset);
    offset += item.vertices.length;
    triangleCount += item.triangleCount;
  }
  return { vertices, normals, triangleCount, bounds: boundsFor(vertices) };
}

function rotatePoint(point, angles) {
  let [x, y, z] = point;
  const [rx, ry, rz] = angles;
  let c = Math.cos(rx), s = Math.sin(rx);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ry); s = Math.sin(ry);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rz); s = Math.sin(rz);
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

function boundsFor(vertices) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < vertices.length; i += 3) {
    b.minX = Math.min(b.minX, vertices[i]);
    b.minY = Math.min(b.minY, vertices[i + 1]);
    b.minZ = Math.min(b.minZ, vertices[i + 2]);
    b.maxX = Math.max(b.maxX, vertices[i]);
    b.maxY = Math.max(b.maxY, vertices[i + 1]);
    b.maxZ = Math.max(b.maxZ, vertices[i + 2]);
  }
  return b;
}

class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { antialias: true });
    this.program = createProgram(this.gl);
    this.meshes = {};
    this.bed = { x: 120, y: 67.5, z: 160 };
    this.yaw = -0.65;
    this.pitch = 0.68;
    this.distance = 180;
    this.target = [60, 34, 20];
    this.drag = null;
    this.resizeTimer = null;
    this.resizeFrame = null;
    this.initEvents();
    this.resize({ recenter: true });
    requestAnimationFrame(() => this.draw());
  }

  initEvents() {
    window.addEventListener("resize", () => this.scheduleResize({ recenter: true }));
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this.scheduleResize({ recenter: true }));
    }
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize({ recenter: true }));
      this.resizeObserver.observe(this.canvas);
    }
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      const mode = event.shiftKey || event.button === 1 || event.button === 2 ? "pan" : "orbit";
      this.drag = { x: event.clientX, y: event.clientY, mode };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      event.preventDefault();
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      const mode = this.drag.mode;
      this.drag = { x: event.clientX, y: event.clientY, mode };
      if (mode === "pan") {
        this.pan(dx, dy);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.2, 1.25);
      }
    });
    this.canvas.addEventListener("pointerup", () => {
      this.drag = null;
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.drag = null;
    });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.distance = clamp(this.distance * (1 + event.deltaY * 0.001), 25, 1200);
    }, { passive: false });
  }

  scheduleResize({ recenter = false } = {}) {
    this.resize({ recenter });
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.resize({ recenter });
    });
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.resize({ recenter });
    }, 250);
  }

  pan(dx, dy) {
    const zAxis = normalize([
      Math.cos(this.pitch) * Math.sin(this.yaw),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
      Math.sin(this.pitch)
    ]);
    const right = normalize(cross([0, 0, 1], zAxis));
    const up = normalize(cross(zAxis, right));
    const scale = Math.max(0.02, this.distance * 0.0015);
    for (let i = 0; i < 3; i++) {
      this.target[i] += (-dx * right[i] + dy * up[i]) * scale;
    }
  }

  resize({ recenter = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (recenter) this.recenter();
  }

  setBed(x, y, z) {
    this.bed = { x: x || 120, y: y || 67.5, z: z || 160 };
    this.recenter();
    this.distance = Math.max(this.bed.x, this.bed.y, this.bed.z) * 1.25;
    this.meshes.bed = makeMesh(this.gl, makeBedGeometry(this.bed), [0.35, 0.39, 0.43, 1], this.gl.TRIANGLES);
    this.meshes.grid = makeMesh(this.gl, makeGridGeometry(this.bed), [0.46, 0.52, 0.57, 1], this.gl.LINES);
  }

  recenter() {
    this.target = [this.bed.x / 2, this.bed.y / 2, Math.min(35, this.bed.z / 3)];
    this.drag = null;
  }

  setPart(part) {
    if (!part) {
      delete this.meshes.part;
      return;
    }
    this.meshes.part = makeMesh(this.gl, { vertices: part.vertices, normals: part.normals }, [0.26, 0.72, 0.86, 1], this.gl.TRIANGLES);
  }

  setSupports(items, braces = []) {
    this.meshes.supports = makeMesh(this.gl, makeSupportGeometry(items, braces), [1.0, 0.63, 0.18, 1], this.gl.TRIANGLES);
  }

  draw() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.075, 0.09, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const projection = perspective(deg(45), aspect, 0.1, 3000);
    const eye = [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[1] - this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch)
    ];
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const mvp = multiply(projection, view);

    for (const key of ["bed", "grid", "supports", "part"]) {
      if (this.meshes[key]) drawMesh(gl, this.program, this.meshes[key], mvp);
    }
    requestAnimationFrame(() => this.draw());
  }
}

function makeBedGeometry(bed) {
  const v = new Float32Array([0, 0, 0, bed.x, 0, 0, bed.x, bed.y, 0, 0, 0, 0, bed.x, bed.y, 0, 0, bed.y, 0]);
  const n = new Float32Array(v.length);
  for (let i = 2; i < n.length; i += 3) n[i] = 1;
  return { vertices: v, normals: n };
}

function makeGridGeometry(bed) {
  const values = [];
  const step = Math.max(5, Math.round(Math.max(bed.x, bed.y) / 16));
  for (let x = 0; x <= bed.x + 0.01; x += step) values.push(x, 0, 0.03, x, bed.y, 0.03);
  for (let y = 0; y <= bed.y + 0.01; y += step) values.push(0, y, 0.03, bed.x, y, 0.03);
  const vertices = new Float32Array(values);
  const normals = new Float32Array(vertices.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return { vertices, normals };
}

function makeSupportGeometry(items, braces) {
  const vertices = [];
  const normals = [];
  for (const support of items || []) {
    const baseX = Number.isFinite(support.baseX) ? support.baseX : support.x;
    const baseY = Number.isFinite(support.baseY) ? support.baseY : support.y;
    const baseZ = Number.isFinite(support.baseZ) ? Math.max(0, support.baseZ) : 0;
    const jointX = Number.isFinite(support.jointX) ? support.jointX : support.x;
    const jointY = Number.isFinite(support.jointY) ? support.jointY : support.y;
    const jointZ = Number.isFinite(support.jointZ) ? Math.max(0.05, support.jointZ) : Math.max(0.05, support.z - 0.8);
    const z = Math.max(0.1, support.z);
    const base = [baseX, baseY, baseZ];
    const joint = [jointX, jointY, Math.min(jointZ, z)];
    const top = [support.x, support.y, z];
    addSegmentCylinder(vertices, normals, base, joint, support.postRadius || 0.28, 10);
    if ((support.kind || "bed") === "bed") {
      addCylinder(vertices, normals, baseX, baseY, 0, 0.35, support.footRadius || 0.8, 16);
    } else {
      addSegmentCylinder(vertices, normals, base, pointBetween(base, joint, 0.2), support.tipRadius || 0.18, 10);
    }
    addTipGeometry(vertices, normals, joint, top, support);
  }
  for (const brace of braces || []) {
    addSegmentCylinder(
      vertices,
      normals,
      [brace.x0, brace.y0, brace.z],
      [brace.x1, brace.y1, brace.z],
      brace.radius || 0.18,
      8
    );
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function addTipGeometry(vertices, normals, start, top, support) {
  const postRadius = support.postRadius || 0.28;
  const tipRadius = support.tipRadius || 0.18;
  const type = support.tipType || "cone";
  if (type === "cylinder") {
    addSegmentCylinder(vertices, normals, start, top, tipRadius, 10);
    return;
  }
  if (type === "sphere") {
    const bulbRadius = Math.max(postRadius * 1.45, tipRadius * 2.2);
    const middle = pointBetween(start, top, 0.58);
    addTaperedSegment(vertices, normals, start, middle, postRadius, bulbRadius, 12);
    addSphere(vertices, normals, middle, bulbRadius, 12, 6);
    addTaperedSegment(vertices, normals, middle, top, bulbRadius, tipRadius, 12);
    return;
  }
  addTaperedSegment(vertices, normals, start, top, postRadius, tipRadius, 10);
}

function addSphere(vertices, normals, center, radius, segments, rings) {
  for (let ring = 0; ring < rings; ring++) {
    const t0 = ring / rings;
    const t1 = (ring + 1) / rings;
    const p0 = Math.PI * t0;
    const p1 = Math.PI * t1;
    for (let segment = 0; segment < segments; segment++) {
      const a0 = (segment / segments) * Math.PI * 2;
      const a1 = ((segment + 1) / segments) * Math.PI * 2;
      const n00 = sphereNormal(p0, a0);
      const n01 = sphereNormal(p0, a1);
      const n10 = sphereNormal(p1, a0);
      const n11 = sphereNormal(p1, a1);
      const v00 = add(center, scaleVec(n00, radius));
      const v01 = add(center, scaleVec(n01, radius));
      const v10 = add(center, scaleVec(n10, radius));
      const v11 = add(center, scaleVec(n11, radius));
      pushTri(vertices, normals, v00, v10, v11, n00, n10, n11);
      pushTri(vertices, normals, v00, v11, v01, n00, n11, n01);
    }
  }
}

function sphereNormal(polar, azimuth) {
  return [
    Math.sin(polar) * Math.cos(azimuth),
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar)
  ];
}

function addCylinder(vertices, normals, cx, cy, z0, z1, radius, segments) {
  addSegmentCylinder(vertices, normals, [cx, cy, z0], [cx, cy, z1], radius, segments);
}

function addSegmentCylinder(vertices, normals, start, end, radius, segments) {
  addTaperedSegment(vertices, normals, start, end, radius, radius, segments);
}

function addTaperedSegment(vertices, normals, start, end, startRadius, endRadius, segments) {
  if (length(sub(end, start)) < 0.001) return;
  const axis = normalize(sub(end, start));
  const reference = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = normalize(cross(axis, reference));
  const v = normalize(cross(axis, u));
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const n0 = add(scaleVec(u, Math.cos(a0)), scaleVec(v, Math.sin(a0)));
    const n1 = add(scaleVec(u, Math.cos(a1)), scaleVec(v, Math.sin(a1)));
    const p0 = add(start, scaleVec(n0, startRadius));
    const p1 = add(start, scaleVec(n1, startRadius));
    const p2 = add(end, scaleVec(n1, endRadius));
    const p3 = add(end, scaleVec(n0, endRadius));
    pushTri(vertices, normals, p0, p1, p2, n0, n1, n1);
    pushTri(vertices, normals, p0, p2, p3, n0, n1, n0);
  }
}

function pointAlong(from, toward, distance) {
  const direction = normalize(sub(toward, from));
  return add(from, scaleVec(direction, distance));
}

function pointBetween(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

function pushTri(vertices, normals, a, b, c, na, nb, nc) {
  vertices.push(...a, ...b, ...c);
  normals.push(...na, ...nb, ...nc);
}

function makeMesh(gl, geometry, color, mode) {
  const vao = {
    count: geometry.vertices.length / 3,
    color,
    mode,
    positions: gl.createBuffer(),
    normals: gl.createBuffer()
  };
  gl.bindBuffer(gl.ARRAY_BUFFER, vao.positions);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, vao.normals);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
  return vao;
}

function createProgram(gl) {
  const vs = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uMvp;
    varying float vLight;
    void main() {
      vec3 light = normalize(vec3(0.35, -0.45, 0.82));
      vLight = max(0.25, dot(normalize(aNormal), light));
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;
  const fs = `
    precision mediump float;
    uniform vec4 uColor;
    varying float vLight;
    void main() {
      gl_FragColor = vec4(uColor.rgb * vLight, uColor.a);
    }
  `;
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return {
    handle: program,
    aPosition: gl.getAttribLocation(program, "aPosition"),
    aNormal: gl.getAttribLocation(program, "aNormal"),
    uMvp: gl.getUniformLocation(program, "uMvp"),
    uColor: gl.getUniformLocation(program, "uColor")
  };
}

function shader(gl, type, source) {
  const out = gl.createShader(type);
  gl.shaderSource(out, source);
  gl.compileShader(out);
  if (!gl.getShaderParameter(out, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(out));
  return out;
}

function drawMesh(gl, program, mesh, mvp) {
  gl.useProgram(program.handle);
  gl.uniformMatrix4fv(program.uMvp, false, mvp);
  gl.uniform4fv(program.uColor, mesh.color);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
  gl.enableVertexAttribArray(program.aPosition);
  gl.vertexAttribPointer(program.aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normals);
  gl.enableVertexAttribArray(program.aNormal);
  gl.vertexAttribPointer(program.aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(mesh.mode, 0, mesh.count);
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function deg(value) {
  return value * Math.PI / 180;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec(a, value) {
  return [a[0] * value, a[1] * value, a[2] * value];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a) {
  return Math.sqrt(dot(a, a));
}

function normalize(a) {
  const len = length(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

init().catch((error) => {
  const logEl = $("log");
  if (logEl) logEl.textContent += `Startup failed: ${error.message}\n`;
});
