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

const placementFields = new Set(["rotateX", "rotateY", "rotateZ", "translateX", "translateY", "translateZ", "scale"]);

let profiles = {};
let models = [];
let selectedModelIds = new Set();
let buildPlates = [];
let activePlateId = null;
let nextBuildPlateId = 1;
let nextModelId = 1;
let uvtoolsPrinterCache = [];
let viewer = null;
let soundPlayer = null;
let soundInitError = null;

const soundAssetRoot = "../src/assets/electron-sound-kit/";
const soundStorageKeys = {
  enabled: "resinSlicer.soundEnabled",
  volume: "resinSlicer.soundVolume"
};
const soundPreloadIds = [
  "click-soft", "click-crisp", "toggle-on", "toggle-off", "confirm", "success",
  "warning", "error", "modal-open", "modal-close", "drawer-open", "drawer-close",
  "drop", "drag-start", "save", "search", "focus-ring", "app-ready"
];
const fallbackSoundEntries = {
  "app-ready": { file: "sounds/app-ready.wav", recommendedVolume: 0.65, loop: false },
  "click-soft": { file: "sounds/click-soft.wav", recommendedVolume: 0.55, loop: false },
  "click-crisp": { file: "sounds/click-crisp.wav", recommendedVolume: 0.55, loop: false },
  "toggle-on": { file: "sounds/toggle-on.wav", recommendedVolume: 0.55, loop: false },
  "toggle-off": { file: "sounds/toggle-off.wav", recommendedVolume: 0.55, loop: false },
  confirm: { file: "sounds/confirm.wav", recommendedVolume: 0.65, loop: false },
  success: { file: "sounds/success.wav", recommendedVolume: 0.65, loop: false },
  warning: { file: "sounds/warning.wav", recommendedVolume: 0.65, loop: false },
  error: { file: "sounds/error.wav", recommendedVolume: 0.65, loop: false },
  notification: { file: "sounds/notification.wav", recommendedVolume: 0.65, loop: false },
  "modal-open": { file: "sounds/modal-open.wav", recommendedVolume: 0.65, loop: false },
  "modal-close": { file: "sounds/modal-close.wav", recommendedVolume: 0.65, loop: false },
  "drawer-open": { file: "sounds/drawer-open.wav", recommendedVolume: 0.65, loop: false },
  "drawer-close": { file: "sounds/drawer-close.wav", recommendedVolume: 0.65, loop: false },
  drop: { file: "sounds/drop.wav", recommendedVolume: 0.65, loop: false },
  "drag-start": { file: "sounds/drag-start.wav", recommendedVolume: 0.65, loop: false },
  save: { file: "sounds/save.wav", recommendedVolume: 0.65, loop: false },
  search: { file: "sounds/search.wav", recommendedVolume: 0.65, loop: false },
  "focus-ring": { file: "sounds/focus-ring.wav", recommendedVolume: 0.55, loop: false }
};

async function init() {
  viewer = new Viewer($("viewer"));
  initSounds();
  $("openButton").addEventListener("click", openStl);
  $("inputPath").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadStlPaths(parseInputPaths($("inputPath").value), { append: false });
  });
  $("saveButton").addEventListener("click", chooseOutput);
  $("importMachineButton").addEventListener("click", () => importProfile("machine"));
  $("importUvtoolsMachineButton").addEventListener("click", importUvtoolsMachine);
  $("exportMachineButton").addEventListener("click", () => exportProfile("machine"));
  $("importResinButton").addEventListener("click", () => importProfile("resin"));
  $("exportResinButton").addEventListener("click", () => exportProfile("resin"));
  $("importSupportButton").addEventListener("click", () => importProfile("support"));
  $("exportSupportButton").addEventListener("click", () => exportProfile("support"));
  $("addBuildPlateButton").addEventListener("click", addBuildPlate);
  $("fitViewButton").addEventListener("click", () => {
    viewer.recenter();
    playSound("click-soft");
  });
  $("selectAllButton").addEventListener("click", selectAllModels);
  $("moveToActivePlateButton").addEventListener("click", moveSelectedModelsToActivePlate);
  $("clipEnabled").addEventListener("change", () => {
    activePlate().clipEnabled = $("clipEnabled").checked;
    updateScene();
  });
  $("clipHeight").addEventListener("input", () => setActivePlateClipHeight(Number($("clipHeight").value)));
  $("clipHeight").addEventListener("wheel", stepClipHeightFromWheel, { passive: false });
  $("clipHeightValue").addEventListener("wheel", stepClipHeightFromWheel, { passive: false });
  $("clipHeightValue").addEventListener("change", () => setActivePlateClipHeight(Number($("clipHeightValue").value)));
  $("clipHeightValue").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setActivePlateClipHeight(Number($("clipHeightValue").value));
      $("clipHeightValue").blur();
    }
  });
  $("previewButton").addEventListener("click", generatePreview);
  $("sliceButton").addEventListener("click", slice);
  $("profile").addEventListener("change", () => {
    loadProfileDefaults();
    writeActivePlateSettingsFromForm();
    syncSceneSettingCommits();
    updateScene();
  });
  $("format").addEventListener("change", () => {
    if (models.length && !$("outputPath").value) setDefaultOutput();
  });
  for (const id of ["centerModel", "supportsEnabled", "primarySupportsEnabled", "enforcersEnabled", "braceEnabled"]) {
    $(id).addEventListener("change", () => {
      writeActivePlateSettingsFromForm();
      updateScene();
    });
  }
  bindSceneSettingUpdates();
  initDropLoading();
  initThemedPrompts();
  initUvtoolsDialog();
  initGlobalShortcuts();
  viewer.onScenePick = handleScenePick;
  viewer.onModelDrag = handleModelDrag;

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
    ensureInitialBuildPlate();
    syncSceneSettingCommits();
  } catch (error) {
    log(`Could not load Python profiles: ${error.message}`);
    showErrorPrompt("Profile Load Failed", error);
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
    ensureInitialBuildPlate();
    syncSceneSettingCommits();
  }

  if (!buildPlates.length) ensureInitialBuildPlate();
  updateScene();
}

function bindSceneSettingUpdates() {
  for (const id of fields) {
    const field = $(id);
    if (field.tagName === "SELECT") {
      field.addEventListener("change", () => commitSceneSetting(field));
      continue;
    }
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitSceneSetting(field);
        field.blur();
      }
    });
    field.addEventListener("blur", () => commitSceneSetting(field));
    field.addEventListener("change", () => commitSceneSetting(field));
  }
  syncSceneSettingCommits();
}

function syncSceneSettingCommits() {
  for (const id of fields) {
    const field = $(id);
    field.dataset.sceneCommittedValue = fieldValue(field);
  }
}

function commitSceneSetting(field) {
  const value = fieldValue(field);
  if (value === field.dataset.sceneCommittedValue) return;
  field.dataset.sceneCommittedValue = value;
  if (placementFields.has(field.id)) {
    applyPlacementFieldToSelected(field.id);
  } else {
    writeActivePlateSettingsFromForm();
    if (["sizeX", "sizeY", "sizeZ"].includes(field.id)) updateBuildPlateLayout();
  }
  updateScene();
}

function fieldValue(field) {
  return field.type === "checkbox" ? String(field.checked) : field.value;
}

function initSounds() {
  const enabled = storedBool(soundStorageKeys.enabled, true);
  const volume = storedNumber(soundStorageKeys.volume, 0.55);
  $("soundEnabled").checked = enabled;
  $("soundVolume").value = volume;
  $("soundEnabled").addEventListener("change", () => {
    const nextEnabled = $("soundEnabled").checked;
    storeValue(soundStorageKeys.enabled, nextEnabled ? "1" : "0");
    if (soundPlayer) soundPlayer.setEnabled(nextEnabled);
    playSound(nextEnabled ? "toggle-on" : "toggle-off", { force: true });
  });
  $("soundVolume").addEventListener("input", () => {
    const nextVolume = clamp(Number($("soundVolume").value), 0, 1);
    storeValue(soundStorageKeys.volume, nextVolume);
    if (soundPlayer) soundPlayer.setVolume(nextVolume);
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || target.id === "soundEnabled") return;
    playSound(target.checked ? "toggle-on" : "toggle-off");
  });
  for (const details of document.querySelectorAll("details.group")) {
    details.addEventListener("toggle", () => playSound(details.open ? "drawer-open" : "drawer-close"));
  }

  createSoundKitPlayer(enabled, volume)
    .then((player) => {
      soundPlayer = player;
    })
    .catch((error) => {
      soundInitError = error;
      log(`Sound unavailable: ${error.message}`);
    });
}

async function createSoundKitPlayer(enabled, volume) {
  try {
    const baseUrl = new URL(soundAssetRoot, window.location.href);
    const module = await import(/* @vite-ignore */ new URL("sound-player.js", baseUrl).toString());
    const player = await module.createSoundPlayer({
      manifestUrl: new URL("manifest.json", baseUrl),
      baseUrl,
      enabled,
      volume
    });
    await player.preload(soundPreloadIds);
    return player;
  } catch (error) {
    soundInitError = error;
    const fallback = createFallbackSoundPlayer(enabled, volume);
    await fallback.preload(soundPreloadIds);
    return fallback;
  }
}

function createFallbackSoundPlayer(enabled, volume) {
  const cache = new Map();
  let isEnabled = enabled;
  let masterVolume = volume;
  const baseUrl = new URL(soundAssetRoot, window.location.href);
  return {
    manifest: { sounds: Object.keys(fallbackSoundEntries).map((id) => ({ id, ...fallbackSoundEntries[id] })) },
    preload(ids = Object.keys(fallbackSoundEntries)) {
      for (const id of ids) {
        const entry = fallbackSoundEntries[id];
        if (!entry || cache.has(id)) continue;
        const audio = new Audio(new URL(entry.file, baseUrl).toString());
        audio.preload = "auto";
        cache.set(id, audio);
      }
      return Promise.resolve();
    },
    play(id, options = {}) {
      if (!isEnabled && !options.force) return null;
      const entry = fallbackSoundEntries[id];
      if (!entry) return null;
      if (!cache.has(id)) {
        const audio = new Audio(new URL(entry.file, baseUrl).toString());
        audio.preload = "auto";
        cache.set(id, audio);
      }
      const audio = cache.get(id).cloneNode(true);
      audio.loop = Boolean(options.loop ?? entry.loop);
      audio.volume = clamp((options.volume ?? entry.recommendedVolume ?? 0.65) * masterVolume, 0, 1);
      const result = audio.play();
      if (result && typeof result.catch === "function") result.catch(() => {});
      return audio;
    },
    setEnabled(value) { isEnabled = Boolean(value); },
    setVolume(value) { masterVolume = clamp(Number(value), 0, 1); },
    get enabled() { return isEnabled; },
    get volume() { return masterVolume; }
  };
}

function playSound(id, options = {}) {
  if (!soundPlayer) return;
  try {
    const player = soundPlayer;
    const temporarilyEnabled = options.force && player.enabled === false && typeof player.setEnabled === "function";
    if (temporarilyEnabled) player.setEnabled(true);
    const result = player.play(id, options);
    if (result && typeof result.catch === "function") result.catch(() => {});
    if (temporarilyEnabled) setTimeout(() => {
      if (!$("soundEnabled").checked) player.setEnabled(false);
    }, 220);
  } catch (error) {
    soundInitError = error;
  }
}

function storedBool(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "1" || value === "true";
  } catch {
    return fallback;
  }
}

function storedNumber(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
  } catch {
    return fallback;
  }
}

function storeValue(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

function ensureInitialBuildPlate() {
  if (buildPlates.length) return;
  const plate = createBuildPlate("Plate 1", buildPlateSettingsFromForm());
  buildPlates.push(plate);
  activePlateId = plate.id;
  updateBuildPlateLayout();
  applyBuildPlateSettingsToForm(plate);
}

function createBuildPlate(name, settings) {
  return {
    id: nextBuildPlateId++,
    name,
    settings: cloneSettings(settings),
    origin: { x: 0, y: 0 },
    clipHeight: Number(settings.printer.sizeZ) || 160,
    clipEnabled: false,
    layersGenerated: false,
    supports: [],
    supportBraces: []
  };
}

function activePlate() {
  ensureInitialBuildPlate();
  return buildPlates.find((plate) => plate.id === activePlateId) || buildPlates[0];
}

function buildPlateSettingsFromForm() {
  return {
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

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function writeActivePlateSettingsFromForm() {
  const plate = activePlate();
  plate.settings = cloneSettings(buildPlateSettingsFromForm());
  plate.clipHeight = clamp(plate.clipHeight, 0, plate.settings.printer.sizeZ || 160);
  updatePlateControls(plate);
  renderBuildPlateList();
}

function applyBuildPlateSettingsToForm(plate) {
  const settings = plate.settings;
  $("profile").value = settings.profile || $("profile").value;
  $("centerModel").checked = !!settings.centerModel;
  const printer = settings.printer;
  $("machineName").value = printer.machineName || "Generic MSLA";
  $("resolutionX").value = printer.resolutionX;
  $("resolutionY").value = printer.resolutionY;
  $("sizeX").value = printer.sizeX;
  $("sizeY").value = printer.sizeY;
  $("sizeZ").value = printer.sizeZ;
  $("layerHeight").value = printer.layerHeight;
  $("resinName").value = printer.resinName || "Standard";
  $("exposure").value = printer.exposure;
  $("bottomExposure").value = printer.bottomExposure;
  $("bottomLayers").value = printer.bottomLayers;
  $("transitionLayers").value = printer.transitionLayers;
  $("liftDistance").value = printer.liftDistance;
  $("liftSpeed").value = printer.liftSpeed;
  $("retractDistance").value = printer.retractDistance;
  $("retractSpeed").value = printer.retractSpeed;
  $("waitAfterRetract").value = printer.waitAfterRetract;
  $("lightPwm").value = printer.lightPwm;
  $("bottomLightPwm").value = printer.bottomLightPwm;
  $("resinDensity").value = printer.resinDensity;
  const support = settings.support;
  $("supportsEnabled").checked = !!support.enabled;
  $("modelLift").value = support.modelLift;
  $("overhangAngle").value = support.overhangAngle;
  $("supportSpacing").value = support.spacing;
  $("primarySupportsEnabled").checked = !!support.primarySupportsEnabled;
  $("primaryDensityMultiplier").value = support.primaryDensityMultiplier;
  $("primaryAreaRadius").value = support.primaryAreaRadius;
  $("primaryMaxExtra").value = support.primaryMaxExtra;
  $("postRadius").value = support.postRadius;
  $("tipRadius").value = support.tipRadius;
  $("tipType").value = support.tipType;
  $("tipLength").value = support.tipLength;
  $("tipAngle").value = support.tipAngle;
  $("footRadius").value = support.footRadius;
  $("bedInterface").value = support.bedInterface;
  $("raftMargin").value = support.raftMargin;
  $("collisionClearance").value = support.collisionClearance;
  $("maxBaseReach").value = support.maxBaseReach;
  $("maxSupportAngle").value = support.maxSupportAngle;
  $("enforcersEnabled").checked = !!support.enforcersEnabled;
  $("enforcerReach").value = support.enforcerReach;
  $("enforcerMinDrop").value = support.enforcerMinDrop;
  $("braceEnabled").checked = !!support.braceEnabled;
  $("braceRadius").value = support.braceRadius;
  $("braceHeight").value = support.braceHeight;
  $("braceDistance").value = support.braceDistance;
  updatePlacementFieldsFromSelection();
  updatePlateControls(plate);
  syncSceneSettingCommits();
}

function updatePlateControls(plate) {
  const maxZ = plate.settings.printer.sizeZ || 160;
  $("clipHeight").max = maxZ;
  $("clipHeight").value = clamp(plate.clipHeight, 0, maxZ);
  $("clipHeightValue").value = Number($("clipHeight").value).toFixed(2);
  $("clipEnabled").checked = !!plate.clipEnabled;
}

function addBuildPlate() {
  writeActivePlateSettingsFromForm();
  const plate = createBuildPlate(`Plate ${buildPlates.length + 1}`, activePlate().settings);
  buildPlates.push(plate);
  activePlateId = plate.id;
  updateBuildPlateLayout();
  selectedModelIds = new Set();
  applyBuildPlateSettingsToForm(plate);
  renderWorkspaceLists();
  updateScene();
  viewer.recenter();
  playSound("confirm");
}

function setActiveBuildPlate(id, { loadSettings = true, sound = true } = {}) {
  const plate = buildPlates.find((item) => item.id === id);
  if (!plate || plate.id === activePlateId) return;
  writeActivePlateSettingsFromForm();
  activePlateId = plate.id;
  if (loadSettings) applyBuildPlateSettingsToForm(plate);
  renderWorkspaceLists();
  updateScene();
  if (sound) playSound("focus-ring");
}

function updateBuildPlateLayout() {
  const count = buildPlates.length || 1;
  const cols = Math.ceil(Math.sqrt(count));
  const maxX = Math.max(...buildPlates.map((plate) => plate.settings.printer.sizeX || 120), 120);
  const maxY = Math.max(...buildPlates.map((plate) => plate.settings.printer.sizeY || 67.5), 67.5);
  const gap = Math.max(35, Math.max(maxX, maxY) * 0.35);
  buildPlates.forEach((plate, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    plate.origin = { x: col * (maxX + gap), y: row * (maxY + gap) };
  });
}

function renderWorkspaceLists() {
  renderBuildPlateList();
  renderObjectList();
}

function renderBuildPlateList() {
  const root = $("buildPlateList");
  if (!root) return;
  root.innerHTML = "";
  for (const plate of buildPlates) {
    const count = models.filter((model) => model.plateId === plate.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `list-item${plate.id === activePlateId ? " active" : ""}`;
    button.innerHTML = `${escapeText(plate.name)}<small>${count} object${count === 1 ? "" : "s"} - ${plate.settings.printer.sizeX}x${plate.settings.printer.sizeY} mm</small>`;
    button.addEventListener("click", () => setActiveBuildPlate(plate.id));
    root.appendChild(button);
  }
}

function renderObjectList() {
  const root = $("objectList");
  if (!root) return;
  root.innerHTML = "";
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "list-item";
    empty.textContent = "No objects loaded";
    root.appendChild(empty);
    return;
  }
  for (const model of models) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `list-item${selectedModelIds.has(model.id) ? " selected" : ""}`;
    button.innerHTML = `${escapeText(model.name)}<small>${escapeText(plate ? plate.name : "No plate")}</small>`;
    button.addEventListener("click", (event) => selectModel(model.id, { additive: event.ctrlKey || event.metaKey || event.shiftKey }));
    root.appendChild(button);
  }
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function initThemedPrompts() {
  $("promptClose").addEventListener("click", hideThemedPrompt);
  $("promptOverlay").addEventListener("pointerdown", (event) => {
    if (event.target === $("promptOverlay")) hideThemedPrompt();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("promptOverlay").hidden) hideThemedPrompt();
  });
  if (window.slicer.onAppPrompt) {
    window.slicer.onAppPrompt((payload) => showThemedPrompt(payload));
  }
}

function showThemedPrompt({ title = "Resin Slicer", message = "", detail = "", kind = "info" } = {}) {
  const overlay = $("promptOverlay");
  const dialog = overlay.querySelector(".prompt-dialog");
  $("promptTitle").textContent = title;
  $("promptMessage").textContent = message || "Something needs your attention.";
  $("promptIcon").textContent = kind === "error" ? "!" : "i";
  $("promptDetail").textContent = detail || "";
  $("promptDetail").hidden = !detail;
  dialog.classList.toggle("error", kind === "error");
  overlay.hidden = false;
  $("promptClose").focus();
  playSound(kind === "error" ? "error" : kind === "warning" ? "warning" : "modal-open");
}

function hideThemedPrompt() {
  $("promptOverlay").hidden = true;
  playSound("modal-close");
}

function showErrorPrompt(title, error) {
  showThemedPrompt({
    title,
    message: error && error.message ? error.message : String(error),
    detail: error && error.stack ? error.stack : "",
    kind: "error"
  });
}

function logAndPrompt(title, message, kind = "info") {
  log(message);
  showThemedPrompt({ title, message, kind });
}

function initUvtoolsDialog() {
  $("uvtoolsCancel").addEventListener("click", hideUvtoolsDialog);
  $("uvtoolsImport").addEventListener("click", applySelectedUvtoolsMachine);
  $("uvtoolsSearch").addEventListener("input", renderUvtoolsPrinters);
  $("uvtoolsSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applySelectedUvtoolsMachine();
    }
  });
  $("uvtoolsPrinterList").addEventListener("dblclick", applySelectedUvtoolsMachine);
  $("uvtoolsOverlay").addEventListener("pointerdown", (event) => {
    if (event.target === $("uvtoolsOverlay")) hideUvtoolsDialog();
  });
}

async function importUvtoolsMachine() {
  showUvtoolsDialog();
  if (uvtoolsPrinterCache.length) {
    renderUvtoolsPrinters();
    return;
  }

  setUvtoolsStatus("Loading UVTools printer profiles...");
  $("uvtoolsImport").disabled = true;
  try {
    const payload = await window.slicer.uvtoolsPrinters();
    uvtoolsPrinterCache = payload.printers || [];
    renderUvtoolsPrinters();
    setUvtoolsStatus(`${uvtoolsPrinterCache.length.toLocaleString()} UVTools printer profiles available`);
  } catch (error) {
    setUvtoolsStatus("Could not load UVTools printer profiles.");
    showErrorPrompt("UVTools Import Failed", error);
  } finally {
    $("uvtoolsImport").disabled = false;
  }
}

function showUvtoolsDialog() {
  $("uvtoolsOverlay").hidden = false;
  $("uvtoolsSearch").value = "";
  $("uvtoolsPrinterList").innerHTML = "";
  $("uvtoolsImport").disabled = !uvtoolsPrinterCache.length;
  setUvtoolsStatus(uvtoolsPrinterCache.length ? "" : "Loading UVTools printer profiles...");
  $("uvtoolsSearch").focus();
  playSound("modal-open");
}

function hideUvtoolsDialog() {
  $("uvtoolsOverlay").hidden = true;
  playSound("modal-close");
}

function renderUvtoolsPrinters() {
  const list = $("uvtoolsPrinterList");
  const terms = $("uvtoolsSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = uvtoolsPrinterCache.filter((printer) => {
    const haystack = printer.name.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  list.innerHTML = "";
  for (const printer of matches) {
    const option = document.createElement("option");
    option.value = printer.path;
    option.textContent = printer.name;
    list.appendChild(option);
  }
  if (matches.length) {
    list.selectedIndex = 0;
  }
  $("uvtoolsImport").disabled = !matches.length;
  setUvtoolsStatus(matches.length
    ? `${matches.length.toLocaleString()} matching UVTools printer profile${matches.length === 1 ? "" : "s"}`
    : "No matching UVTools printer profiles");
}

async function applySelectedUvtoolsMachine() {
  const selectedPath = $("uvtoolsPrinterList").value;
  const printer = uvtoolsPrinterCache.find((item) => item.path === selectedPath);
  if (!printer) {
    setUvtoolsStatus("Choose a UVTools printer profile first.");
    return;
  }

  $("uvtoolsImport").disabled = true;
  setUvtoolsStatus(`Importing ${printer.name}...`);
  try {
    const profile = await window.slicer.uvtoolsPrinter(printer.path);
    const imported = parseImportedProfile(profile.text);
    const changed = applyMachineProfile(imported.flat);
    $("machineName").value = printer.name;
    if (!changed) {
      throw new Error(`${printer.name} did not contain recognizable machine settings`);
    }
    writeActivePlateSettingsFromForm();
    syncSceneSettingCommits();
    updateScene();
    hideUvtoolsDialog();
    log(`Imported UVTools machine profile: ${printer.name}`);
    playSound("confirm");
  } catch (error) {
    setUvtoolsStatus("Import failed.");
    showErrorPrompt("UVTools Import Failed", error);
  } finally {
    $("uvtoolsImport").disabled = false;
  }
}

function setUvtoolsStatus(message) {
  $("uvtoolsStatus").textContent = message;
}

function initGlobalShortcuts() {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      selectAllModels();
    }
  }, true);
}

function selectAllModels() {
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection) selection.removeAllRanges();
  selectedModelIds = new Set(models.map((model) => model.id));
  updateScene();
  if (models.length) {
    $("meshStatus").textContent = `${models.length.toLocaleString()} model${models.length === 1 ? "" : "s"} selected`;
    playSound("focus-ring");
  }
}

function selectModel(modelId, { additive = false, preserveExisting = false } = {}) {
  const model = models.find((item) => item.id === modelId);
  if (!model) return;
  if (model.plateId !== activePlateId) {
    setActiveBuildPlate(model.plateId, { sound: false });
  }
  if (preserveExisting && selectedModelIds.has(modelId) && !additive) {
    // Keep the group selection intact when beginning a drag from one selected model.
  } else if (additive) {
    if (selectedModelIds.has(modelId)) {
      selectedModelIds.delete(modelId);
    } else {
      selectedModelIds.add(modelId);
    }
  } else {
    selectedModelIds = new Set([modelId]);
  }
  updatePlacementFieldsFromSelection();
  renderWorkspaceLists();
  updateScene();
  playSound("focus-ring");
}

function handleScenePick(hit) {
  if (!hit) return;
  if (hit.type === "model") {
    selectModel(hit.id, { additive: hit.additive, preserveExisting: hit.dragStart });
  } else if (hit.type === "plate") {
    setActiveBuildPlate(hit.id);
  }
}

function handleModelDrag(drag) {
  const selection = selectedModels();
  if (!selection.length) return;
  for (const model of selection) {
    model.transform.translateX += drag.x;
    model.transform.translateY += drag.y;
    maybeMoveModelToPlateByCentroid(model);
  }
  invalidateGeneratedLayersForSelection(selection);
  updatePlacementFieldsFromSelection();
  renderWorkspaceLists();
  updateScene();
}

function selectedModels() {
  return models.filter((model) => selectedModelIds.has(model.id));
}

function applyPlacementFieldToSelected(fieldId) {
  const selection = selectedModels();
  if (!selection.length) return;
  const key = placementKey(fieldId);
  const value = number(fieldId);
  for (const model of selection) {
    if (key === "translateX" || key === "translateY" || key === "translateZ") {
      model.transform[key] = value;
    } else if (key === "scale") {
      model.transform.scale = Math.max(0.001, value || 1);
    } else {
      model.transform[key] = value;
    }
    maybeMoveModelToPlateByCentroid(model);
  }
  invalidateGeneratedLayersForSelection(selection);
  renderWorkspaceLists();
}

function placementKey(fieldId) {
  return {
    rotateX: "rotateX",
    rotateY: "rotateY",
    rotateZ: "rotateZ",
    translateX: "translateX",
    translateY: "translateY",
    translateZ: "translateZ",
    scale: "scale"
  }[fieldId];
}

function updatePlacementFieldsFromSelection() {
  const model = selectedModels()[0];
  if (!model) return;
  $("rotateX").value = model.transform.rotateX;
  $("rotateY").value = model.transform.rotateY;
  $("rotateZ").value = model.transform.rotateZ;
  $("translateX").value = model.transform.translateX;
  $("translateY").value = model.transform.translateY;
  $("translateZ").value = model.transform.translateZ;
  $("scale").value = model.transform.scale;
  syncSceneSettingCommits();
}

function invalidateGeneratedLayersForSelection(selection) {
  for (const model of selection) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    if (plate) plate.layersGenerated = false;
  }
}

function maybeMoveModelToPlateByCentroid(model) {
  const currentPlate = buildPlates.find((plate) => plate.id === model.plateId);
  if (!currentPlate) return;
  const world = modelWorldMesh(model);
  const centroid = boundsCenter(world.bounds);
  const destination = buildPlates.find((plate) => pointInsidePlate(centroid, plate));
  if (!destination || destination.id === model.plateId) return;

  model.plateId = destination.id;
  model.transform.translateX = centroid[0] - destination.origin.x - modelLocalCentroid(model)[0];
  model.transform.translateY = centroid[1] - destination.origin.y - modelLocalCentroid(model)[1];
  activePlateId = destination.id;
  applyBuildPlateSettingsToForm(destination);
  playSound("drop");
}

function moveSelectedModelsToActivePlate() {
  const plate = activePlate();
  const selection = selectedModels();
  if (!selection.length) return;
  for (const model of selection) {
    const world = modelWorldMesh(model);
    const centroid = boundsCenter(world.bounds);
    const local = modelLocalCentroid(model);
    model.plateId = plate.id;
    model.transform.translateX = centroid[0] - plate.origin.x - local[0];
    model.transform.translateY = centroid[1] - plate.origin.y - local[1];
  }
  renderWorkspaceLists();
  updateScene();
  playSound("drop");
}

async function openStl() {
  try {
    playSound("click-soft");
    const paths = await window.slicer.openStl();
    if (!paths || !paths.length) {
      log("Open mesh canceled.");
      return;
    }
    await loadStlPaths(paths, { append: false });
  } catch (error) {
    log(`Open mesh failed: ${error.message}`);
    showErrorPrompt("Open Mesh Failed", error);
  }
}

async function loadStlPaths(paths, { append = false, sound = append ? "drop" : "confirm" } = {}) {
  ensureInitialBuildPlate();
  const nextPaths = normalizeStlPaths(paths);
  if (!nextPaths.length) {
    logAndPrompt("No Mesh Files", "Choose or drop at least one STL or OBJ file.");
    return;
  }

  const loaded = append ? models.slice() : [];
  const loadedKeys = new Set(loaded.map((item) => item.path.toLowerCase()));
  const importedModels = [];
  for (const path of nextPaths) {
    const key = path.toLowerCase();
    if (loadedKeys.has(key)) continue;
    log(`Loading ${path}`);
    const bytes = new Uint8Array(await window.slicer.readFile(path));
    const mesh = parseMesh(path, bytes);
    const model = {
      id: nextModelId++,
      path,
      name: fileName(path),
      mesh,
      plateId: activePlateId,
      transform: defaultModelTransform()
    };
    loaded.push(model);
    importedModels.push(model);
    loadedKeys.add(key);
    log(`Loaded ${fileName(path)} (${mesh.triangleCount.toLocaleString()} triangles)`);
  }

  models = loaded;
  if (!append) {
    for (const plate of buildPlates) {
      plate.supports = [];
      plate.supportBraces = [];
      plate.layersGenerated = false;
    }
  }
  arrangeModelsOnPlate(activePlateId);
  selectedModelIds = new Set(importedModels.map((model) => model.id));
  $("inputPath").value = models.map((item) => item.path).join("; ");
  if (!append) $("outputPath").value = "";
  setDefaultOutput();
  const triangleCount = models.reduce((sum, item) => sum + item.mesh.triangleCount, 0);
  $("meshStatus").textContent = `${models.length.toLocaleString()} mesh${models.length === 1 ? "" : "es"}, ${triangleCount.toLocaleString()} triangles`;
  $("supportStatus").textContent = "Supports not generated";
  if (models.length > 1) log(`Arranged ${models.length} mesh files on the build plate`);
  renderWorkspaceLists();
  updatePlacementFieldsFromSelection();
  updateScene();
  if (importedModels.length && sound) playSound(sound);
}

async function chooseOutput() {
  try {
    playSound("click-soft");
    const path = await window.slicer.saveOutput($("format").value);
    if (path) {
      $("outputPath").value = path;
      playSound("save");
    }
  } catch (error) {
    log(`Choose output failed: ${error.message}`);
    showErrorPrompt("Choose Output Failed", error);
  }
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
      if (shell && !shell.classList.contains("drag-over")) {
        shell.classList.add("drag-over");
        playSound("drag-start");
      }
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
    logAndPrompt("Unsupported Drop", "Drop one or more STL or OBJ files into the viewer.");
    return;
  }
  await loadStlPaths(paths, { append: models.length > 0, sound: "drop" });
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
      logAndPrompt(
        "Profile Not Recognized",
        `No recognizable ${kind} settings found in ${file.path}`
      );
      return;
    }
    log(`Imported ${kind} profile from ${file.path}`);
    writeActivePlateSettingsFromForm();
    syncSceneSettingCommits();
    updateScene();
    playSound("confirm");
  } catch (error) {
    log(`Import ${kind} failed: ${error.message}`);
    showErrorPrompt(`Import ${profileKindLabel(kind)} Failed`, error);
  }
}

async function exportProfile(kind) {
  try {
    const payload = buildExportProfile(kind);
    const content = JSON.stringify(payload, null, 2);
    const path = await window.slicer.saveProfile(kind, profileFileName(kind), content);
    if (path) {
      log(`Exported ${kind} profile to ${path}`);
      playSound("save");
    }
  } catch (error) {
    log(`Export ${kind} failed: ${error.message}`);
    showErrorPrompt(`Export ${profileKindLabel(kind)} Failed`, error);
  }
}

async function generatePreview() {
  if (!ensureReady(false, true)) return;
  const plate = activePlate();
  playSound("click-crisp");
  setBusy(true);
  log(`Generating support preview for ${plate.name}...`);
  try {
    const result = await window.slicer.preview(collectPayloadForPlate(plate));
    plate.supports = result.supports || [];
    plate.supportBraces = result.braces || [];
    plate.layersGenerated = true;
    $("supportStatus").textContent = `${plate.supports.length.toLocaleString()} supports previewed`;
    updateScene();
    log(`Preview ${plate.name}: ${result.layers} layers, ${plate.supports.length} supports, ${plate.supportBraces.length} braces`);
    playSound("success");
  } catch (error) {
    log(`Preview failed: ${error.message}`);
    showErrorPrompt("Preview Failed", error);
  } finally {
    setBusy(false);
  }
}

async function slice() {
  if (!ensureReady(true, false)) return;
  playSound("click-crisp");
  setBusy(true);
  log("Slicing...");
  try {
    const platesToSlice = buildPlates.filter((plate) => models.some((model) => model.plateId === plate.id));
    for (let index = 0; index < platesToSlice.length; index++) {
      const plate = platesToSlice[index];
      const payload = collectPayloadForPlate(plate, outputPathForPlate(plate, index, platesToSlice.length));
      log(`Slicing ${plate.name}...`);
      const result = await window.slicer.slice(payload);
      plate.layersGenerated = true;
      log(`Done ${plate.name}: ${result.outputPath}`);
      log(`${result.layers} layers, ${result.supports} supports, ${result.materialMl.toFixed(2)} ml resin`);
    }
    updateScene();
    playSound("success");
  } catch (error) {
    log(`Slice failed: ${error.message}`);
    showErrorPrompt("Slice Failed", error);
  } finally {
    setBusy(false);
  }
}

function ensureReady(requireOutput, requireActivePlateObjects = true) {
  if (!models.length) {
    logAndPrompt("No Mesh Loaded", "Open or drop at least one STL or OBJ first.");
    return false;
  }
  if (requireOutput && !$("outputPath").value.trim()) {
    logAndPrompt("No Output Path", "Choose an output path first.");
    return false;
  }
  if (requireActivePlateObjects && !models.some((model) => model.plateId === activePlateId)) {
    logAndPrompt("No Objects On Active Plate", "Move or load at least one object onto the active build plate first.");
    return false;
  }
  return true;
}

function collectPayload() {
  return collectPayloadForPlate(activePlate());
}

function collectPayloadForPlate(plate, outputPath = $("outputPath").value.trim()) {
  const payload = basePayload(plate, outputPath);
  const plateModels = models.filter((model) => model.plateId === plate.id);
  payload.inputPath = plateModels[0]?.path || "";
  payload.models = plateModels.map((model) => ({
    inputPath: model.path,
    name: model.name,
    transform: model.transform
  }));
  return payload;
}

function basePayload(plate = activePlate(), outputPath = $("outputPath").value.trim()) {
  const settings = plate.settings;
  return {
    outputPath,
    format: $("format").value,
    profile: settings.profile,
    centerModel: false,
    printer: cloneSettings(settings.printer),
    transform: {
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      translateX: 0,
      translateY: 0,
      translateZ: 0,
      scale: 1
    },
    support: cloneSettings(settings.support)
  };
}

function outputPathForPlate(plate, index, total) {
  const outputPath = $("outputPath").value.trim();
  if (total <= 1) return outputPath;
  const ext = $("format").value;
  const suffix = `-${safeFileStem(plate.name || `plate-${index + 1}`)}`;
  if (/\.[^.\\/]+$/.test(outputPath)) return outputPath.replace(/\.[^.\\/]+$/, `${suffix}.${ext}`);
  return `${outputPath}${suffix}.${ext}`;
}

function safeFileStem(value) {
  return String(value).trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "plate";
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
  changed += applyNumberValue("resolutionX", flat, ["resolutionX", "xResolution", "resolution_x", "displayPixelsX", "display_pixels_x", "screenX", "screenResolutionX", "pixelsX"]);
  changed += applyNumberValue("resolutionY", flat, ["resolutionY", "yResolution", "resolution_y", "displayPixelsY", "display_pixels_y", "screenY", "screenResolutionY", "pixelsY"]);
  changed += applyNumberValue("sizeX", flat, ["sizeX", "size_x_mm", "displayWidth", "display_width", "machineWidth", "buildPlateX", "buildVolumeX", "printX", "xSize"]);
  changed += applyNumberValue("sizeY", flat, ["sizeY", "size_y_mm", "displayHeight", "display_height", "machineDepth", "machineLength", "buildPlateY", "buildVolumeY", "printY", "ySize"]);
  changed += applyNumberValue("sizeZ", flat, ["sizeZ", "size_z_mm", "maxPrintHeight", "max_print_height", "machineHeight", "buildVolumeZ", "printZ", "zSize"]);
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

function profileKindLabel(kind) {
  if (kind === "machine") return "Machine";
  if (kind === "resin") return "Resin";
  if (kind === "support") return "Support";
  return "Settings";
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
  ensureInitialBuildPlate();
  updateBuildPlateLayout();
  const scene = buildScene();
  viewer.setScene(scene);
  renderWorkspaceLists();
  const active = activePlate();
  const activeModels = models.filter((model) => model.plateId === active.id);
  $("meshStatus").textContent = selectedModelIds.size
    ? `${selectedModelIds.size.toLocaleString()} model${selectedModelIds.size === 1 ? "" : "s"} selected`
    : `${activeModels.length.toLocaleString()} object${activeModels.length === 1 ? "" : "s"} on ${active.name}`;
  if (active.layersGenerated) {
    $("supportStatus").textContent = `${active.supports.length.toLocaleString()} supports previewed`;
  } else if (activeModels.some((model) => modelOutOfBounds(model, active))) {
    $("supportStatus").textContent = "Active plate has out-of-bounds geometry";
  } else {
    $("supportStatus").textContent = "Layer/support preview stale";
  }
}

function setActivePlateClipHeight(value) {
  const plate = activePlate();
  const maxZ = plate.settings.printer.sizeZ || 160;
  plate.clipEnabled = true;
  plate.clipHeight = clamp(Number.isFinite(value) ? value : plate.clipHeight, 0, maxZ);
  $("clipHeight").value = plate.clipHeight;
  $("clipHeightValue").value = plate.clipHeight.toFixed(2);
  $("clipEnabled").checked = true;
  updateScene();
}

function stepClipHeightFromWheel(event) {
  event.preventDefault();
  const step = event.shiftKey ? 1 : 0.05;
  setActivePlateClipHeight(activePlate().clipHeight + (event.deltaY > 0 ? -step : step));
}

function buildScene() {
  const active = activePlate();
  const modelItems = [];
  const selectionBoxes = [];
  const outOfBounds = [];

  for (const model of models) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    if (!plate) continue;
    const world = modelWorldMesh(model);
    const isActive = plate.id === active.id;
    const selected = selectedModelIds.has(model.id);
    modelItems.push({
      id: model.id,
      plateId: plate.id,
      mesh: world,
      bounds: world.bounds,
      color: isActive ? (selected ? [0.3, 0.78, 0.95, 1] : [0.26, 0.72, 0.86, 1]) : [0.44, 0.48, 0.52, 1]
    });
    if (selected) selectionBoxes.push(world.bounds);
    if (isActive) {
      const redMesh = outOfBoundsMesh(model, plate);
      if (redMesh) outOfBounds.push(redMesh);
    }
  }

  return {
    plates: buildPlates.map((plate) => ({
      id: plate.id,
      name: plate.name,
      origin: plate.origin,
      bed: {
        x: plate.settings.printer.sizeX || 120,
        y: plate.settings.printer.sizeY || 67.5,
        z: plate.settings.printer.sizeZ || 160
      },
      active: plate.id === active.id
    })),
    models: modelItems,
    selectionBoxes,
    outOfBounds,
    supports: offsetSupports(active.supports, active.origin),
    supportBraces: offsetBraces(active.supportBraces, active.origin),
    clip: {
      enabled: active.clipEnabled,
      z: active.clipHeight,
      plate: {
        x: active.origin.x,
        y: active.origin.y,
        width: active.settings.printer.sizeX || 120,
        depth: active.settings.printer.sizeY || 67.5
      },
      showLayer: active.layersGenerated,
      layerLines: active.layersGenerated ? makeLayerLines(active, active.clipHeight) : null
    }
  };
}

function defaultModelTransform() {
  return { rotateX: 0, rotateY: 0, rotateZ: 0, translateX: 0, translateY: 0, translateZ: 0, scale: 1 };
}

function arrangeModelsOnPlate(plateId) {
  const plate = buildPlates.find((item) => item.id === plateId);
  if (!plate) return;
  const plateModels = models.filter((model) => model.plateId === plateId);
  const gap = plateModels.length > 1 ? 4 : 0;
  const bedX = plate.settings.printer.sizeX || 120;
  let cursorX = 0;
  let cursorY = 0;
  let rowDepth = 0;
  for (const model of plateModels) {
    const oriented = orientMesh(model.mesh, model.transform);
    const width = oriented.bounds.maxX - oriented.bounds.minX;
    const depth = oriented.bounds.maxY - oriented.bounds.minY;
    if (cursorX > 0 && cursorX + width > bedX) {
      cursorX = 0;
      cursorY += rowDepth + gap;
      rowDepth = 0;
    }
    model.transform.translateX = cursorX - oriented.bounds.minX;
    model.transform.translateY = cursorY - oriented.bounds.minY;
    model.transform.translateZ = -oriented.bounds.minZ;
    cursorX += width + gap;
    rowDepth = Math.max(rowDepth, depth);
  }
}

function modelWorldMesh(model) {
  const plate = buildPlates.find((item) => item.id === model.plateId);
  const origin = plate ? plate.origin : { x: 0, y: 0 };
  const oriented = orientMesh(model.mesh, model.transform);
  return translateMesh(
    oriented,
    origin.x + model.transform.translateX,
    origin.y + model.transform.translateY,
    model.transform.translateZ
  );
}

function modelLocalCentroid(model) {
  const oriented = orientMesh(model.mesh, model.transform);
  const center = boundsCenter(oriented.bounds);
  return [center[0], center[1], center[2]];
}

function boundsCenter(bounds) {
  return [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  ];
}

function pointInsidePlate(point, plate) {
  const sizeX = plate.settings.printer.sizeX || 120;
  const sizeY = plate.settings.printer.sizeY || 67.5;
  return point[0] >= plate.origin.x
    && point[0] <= plate.origin.x + sizeX
    && point[1] >= plate.origin.y
    && point[1] <= plate.origin.y + sizeY;
}

function modelOutOfBounds(model, plate) {
  const world = modelWorldMesh(model);
  return boundsOutsidePlate(world.bounds, plate);
}

function boundsOutsidePlate(bounds, plate) {
  const maxX = plate.origin.x + (plate.settings.printer.sizeX || 120);
  const maxY = plate.origin.y + (plate.settings.printer.sizeY || 67.5);
  return bounds.minX < plate.origin.x || bounds.maxX > maxX || bounds.minY < plate.origin.y || bounds.maxY > maxY;
}

function outOfBoundsMesh(model, plate) {
  const world = modelWorldMesh(model);
  const vertices = [];
  const normals = [];
  const maxX = plate.origin.x + (plate.settings.printer.sizeX || 120);
  const maxY = plate.origin.y + (plate.settings.printer.sizeY || 67.5);
  for (let i = 0; i < world.vertices.length; i += 9) {
    let outside = false;
    for (let j = 0; j < 9; j += 3) {
      const x = world.vertices[i + j];
      const y = world.vertices[i + j + 1];
      outside = outside || x < plate.origin.x || x > maxX || y < plate.origin.y || y > maxY;
    }
    if (outside) {
      for (let j = 0; j < 9; j++) vertices.push(world.vertices[i + j]);
      for (let j = 0; j < 9; j++) normals.push(world.normals[i + j]);
    }
  }
  if (!vertices.length) return null;
  return {
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals),
    bounds: boundsFor(new Float32Array(vertices))
  };
}

function offsetSupports(items, origin) {
  return (items || []).map((item) => ({
    ...item,
    x: item.x + origin.x,
    y: item.y + origin.y,
    baseX: item.baseX + origin.x,
    baseY: item.baseY + origin.y,
    jointX: item.jointX + origin.x,
    jointY: item.jointY + origin.y
  }));
}

function offsetBraces(items, origin) {
  return (items || []).map((item) => ({
    ...item,
    x0: item.x0 + origin.x,
    y0: item.y0 + origin.y,
    x1: item.x1 + origin.x,
    y1: item.y1 + origin.y
  }));
}

function makeLayerLines(plate, z) {
  const vertices = [];
  const normals = [];
  for (const model of models.filter((item) => item.plateId === plate.id)) {
    const world = modelWorldMesh(model);
    for (let i = 0; i < world.vertices.length; i += 9) {
      const tri = [
        [world.vertices[i], world.vertices[i + 1], world.vertices[i + 2]],
        [world.vertices[i + 3], world.vertices[i + 4], world.vertices[i + 5]],
        [world.vertices[i + 6], world.vertices[i + 7], world.vertices[i + 8]]
      ];
      const points = [];
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const point = edgePlaneIntersection(a, b, z);
        if (point) points.push(point);
      }
      if (points.length === 2 && length(sub(points[0], points[1])) > 0.001) {
        vertices.push(...points[0], ...points[1]);
        normals.push(0, 0, 1, 0, 0, 1);
      }
    }
  }
  if (!vertices.length) return null;
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function edgePlaneIntersection(a, b, z) {
  const az = a[2];
  const bz = b[2];
  if ((az < z && bz < z) || (az > z && bz > z) || az === bz) return null;
  const t = (z - az) / (bz - az);
  if (t < 0 || t > 1) return null;
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    z
  ];
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
    this.pickables = [];
    this.pickRects = [];
    this.onScenePick = null;
    this.onModelDrag = null;
    this.pointerStart = null;
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
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const hit = this.hitAt(event.clientX, event.clientY);
      const mode = hit && hit.type === "model" ? "model" : "pan";
      this.drag = { x: event.clientX, y: event.clientY, mode };
      this.pointerStart = { x: event.clientX, y: event.clientY, additive, hit };
      if (mode === "model" && this.onScenePick) {
        this.onScenePick({ type: "model", id: hit.id, plateId: hit.plateId, additive, dragStart: true });
      }
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      event.preventDefault();
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      const mode = this.drag.mode;
      this.drag = { x: event.clientX, y: event.clientY, mode };
      if (mode === "model") {
        const delta = this.screenDeltaToBuildPlane(dx, dy);
        if (this.onModelDrag && (Math.abs(delta.x) > 0.0001 || Math.abs(delta.y) > 0.0001)) {
          this.onModelDrag(delta);
        }
      } else {
        this.pan(dx, dy);
      }
    });
    this.canvas.addEventListener("pointerup", (event) => {
      if (this.pointerStart) {
        const dx = event.clientX - this.pointerStart.x;
        const dy = event.clientY - this.pointerStart.y;
        if (Math.hypot(dx, dy) < 4) {
          this.pickAt(event.clientX, event.clientY, this.pointerStart.additive, { skipModels: this.pointerStart.hit?.type === "model" });
        }
      }
      this.drag = null;
      this.pointerStart = null;
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.drag = null;
      this.pointerStart = null;
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

  screenDeltaToBuildPlane(dx, dy) {
    const zAxis = normalize([
      Math.cos(this.pitch) * Math.sin(this.yaw),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
      Math.sin(this.pitch)
    ]);
    const right = normalize(cross([0, 0, 1], zAxis));
    const up = normalize(cross(zAxis, right));
    const scale = Math.max(0.02, this.distance * 0.0015);
    return {
      x: (dx * right[0] - dy * up[0]) * scale,
      y: (dx * right[1] - dy * up[1]) * scale
    };
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

  setScene(scene) {
    this.bed = combinedSceneBed(scene.plates);
    this.meshes.plates = scene.plates.map((plate) => ({
      id: plate.id,
      bounds: {
        minX: plate.origin.x,
        minY: plate.origin.y,
        minZ: 0,
        maxX: plate.origin.x + plate.bed.x,
        maxY: plate.origin.y + plate.bed.y,
        maxZ: 0.05
      },
      bed: makeMesh(this.gl, makeBedGeometry(plate.bed, plate.origin), plate.active ? [0.36, 0.43, 0.5, 1] : [0.24, 0.27, 0.3, 1], this.gl.TRIANGLES),
      grid: makeMesh(this.gl, makeGridGeometry(plate.bed, plate.origin), plate.active ? [0.58, 0.66, 0.72, 1] : [0.34, 0.38, 0.42, 1], this.gl.LINES)
    }));
    this.meshes.models = scene.models.map((item) => ({
      id: item.id,
      plateId: item.plateId,
      bounds: item.bounds,
      mesh: makeMesh(this.gl, { vertices: item.mesh.vertices, normals: item.mesh.normals }, item.color, this.gl.TRIANGLES, { clip: scene.clip.enabled })
    }));
    this.meshes.selection = scene.selectionBoxes.length
      ? makeMesh(this.gl, makeSelectionBoxGeometry(scene.selectionBoxes), [1.0, 0.86, 0.26, 1], this.gl.LINES)
      : null;
    const redGeometry = combineGeometry(scene.outOfBounds);
    this.meshes.outOfBounds = redGeometry
      ? makeMesh(this.gl, redGeometry, [1.0, 0.16, 0.12, 1], this.gl.TRIANGLES, { clip: scene.clip.enabled })
      : null;
    this.meshes.supports = makeMesh(this.gl, makeSupportGeometry(scene.supports, scene.supportBraces), [1.0, 0.63, 0.18, 1], this.gl.TRIANGLES);
    this.meshes.clipPlane = scene.clip.enabled
      ? makeMesh(this.gl, makeClipPlaneGeometry(scene.clip.plate, scene.clip.z), [0.82, 0.78, 0.28, 1], this.gl.TRIANGLES)
      : null;
    this.meshes.layerLines = scene.clip.enabled && scene.clip.showLayer && scene.clip.layerLines
      ? makeMesh(this.gl, scene.clip.layerLines, [1.0, 0.95, 0.45, 1], this.gl.LINES)
      : null;
    this.clipZ = scene.clip.z;
    this.pickables = [
      ...scene.models.map((item) => ({ type: "model", id: item.id, plateId: item.plateId, bounds: item.bounds })),
      ...scene.plates.map((plate) => ({
        type: "plate",
        id: plate.id,
        bounds: {
          minX: plate.origin.x,
          minY: plate.origin.y,
          minZ: 0,
          maxX: plate.origin.x + plate.bed.x,
          maxY: plate.origin.y + plate.bed.y,
          maxZ: 0.05
        }
      }))
    ];
    this.distance = Math.max(this.distance, Math.max(this.bed.x, this.bed.y, this.bed.z) * 0.55);
  }

  recenter() {
    this.target = [this.bed.x / 2, this.bed.y / 2, Math.min(35, this.bed.z / 3)];
    this.drag = null;
  }

  setPart(part) {
    if (!part) {
      delete this.meshes.part;
      delete this.meshes.selection;
      return;
    }
    this.meshes.part = makeMesh(this.gl, { vertices: part.vertices, normals: part.normals }, [0.26, 0.72, 0.86, 1], this.gl.TRIANGLES);
  }

  setSelectionBoxes(boxes) {
    if (!boxes || !boxes.length) {
      delete this.meshes.selection;
      return;
    }
    this.meshes.selection = makeMesh(this.gl, makeSelectionBoxGeometry(boxes), [1.0, 0.86, 0.26, 1], this.gl.LINES);
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
    this.updatePickRects(mvp);

    for (const plate of this.meshes.plates || []) {
      drawMesh(gl, this.program, plate.bed, mvp, this.clipZ);
      drawMesh(gl, this.program, plate.grid, mvp, this.clipZ);
    }
    if (this.meshes.supports) drawMesh(gl, this.program, this.meshes.supports, mvp, this.clipZ);
    for (const item of this.meshes.models || []) {
      drawMesh(gl, this.program, item.mesh, mvp, this.clipZ);
    }
    if (this.meshes.outOfBounds) drawMesh(gl, this.program, this.meshes.outOfBounds, mvp, this.clipZ);
    if (this.meshes.clipPlane) drawMesh(gl, this.program, this.meshes.clipPlane, mvp, this.clipZ);
    if (this.meshes.layerLines) drawMesh(gl, this.program, this.meshes.layerLines, mvp, this.clipZ);
    if (this.meshes.selection) drawMesh(gl, this.program, this.meshes.selection, mvp, this.clipZ);
    requestAnimationFrame(() => this.draw());
  }

  pickAt(clientX, clientY, additive, options = {}) {
    const hit = this.hitAt(clientX, clientY, options);
    if (hit && this.onScenePick) {
      this.onScenePick({ type: hit.type, id: hit.id, plateId: hit.plateId, additive });
    }
  }

  hitAt(clientX, clientY, { skipModels = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return this.pickRects
      .filter((item) => !skipModels || item.type !== "model")
      .filter((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom)
      .sort((a, b) => (a.type === "model" ? -1 : 1) - (b.type === "model" ? -1 : 1) || a.area - b.area)[0];
  }

  updatePickRects(mvp) {
    this.pickRects = this.pickables.map((item) => {
      const points = boundsCorners(item.bounds).map((point) => projectPoint(point, mvp, this.canvas));
      const visible = points.filter(Boolean);
      if (!visible.length) return null;
      const xs = visible.map((point) => point[0]);
      const ys = visible.map((point) => point[1]);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return { ...item, left, right, top, bottom, area: Math.max(1, (right - left) * (bottom - top)) };
    }).filter(Boolean);
  }
}

function combinedSceneBed(plates) {
  if (!plates.length) return { x: 120, y: 67.5, z: 160 };
  const maxX = Math.max(...plates.map((plate) => plate.origin.x + plate.bed.x));
  const maxY = Math.max(...plates.map((plate) => plate.origin.y + plate.bed.y));
  const maxZ = Math.max(...plates.map((plate) => plate.bed.z));
  return { x: maxX, y: maxY, z: maxZ };
}

function makeBedGeometry(bed, origin = { x: 0, y: 0 }) {
  const ox = origin.x || 0;
  const oy = origin.y || 0;
  const v = new Float32Array([ox, oy, 0, ox + bed.x, oy, 0, ox + bed.x, oy + bed.y, 0, ox, oy, 0, ox + bed.x, oy + bed.y, 0, ox, oy + bed.y, 0]);
  const n = new Float32Array(v.length);
  for (let i = 2; i < n.length; i += 3) n[i] = 1;
  return { vertices: v, normals: n };
}

function makeGridGeometry(bed, origin = { x: 0, y: 0 }) {
  const values = [];
  const ox = origin.x || 0;
  const oy = origin.y || 0;
  const step = Math.max(5, Math.round(Math.max(bed.x, bed.y) / 16));
  for (let x = 0; x <= bed.x + 0.01; x += step) values.push(ox + x, oy, 0.03, ox + x, oy + bed.y, 0.03);
  for (let y = 0; y <= bed.y + 0.01; y += step) values.push(ox, oy + y, 0.03, ox + bed.x, oy + y, 0.03);
  const vertices = new Float32Array(values);
  const normals = new Float32Array(vertices.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return { vertices, normals };
}

function makeClipPlaneGeometry(plate, z) {
  const v = new Float32Array([
    plate.x, plate.y, z,
    plate.x + plate.width, plate.y, z,
    plate.x + plate.width, plate.y + plate.depth, z,
    plate.x, plate.y, z,
    plate.x + plate.width, plate.y + plate.depth, z,
    plate.x, plate.y + plate.depth, z
  ]);
  const n = new Float32Array(v.length);
  for (let i = 2; i < n.length; i += 3) n[i] = 1;
  return { vertices: v, normals: n };
}

function makeSelectionBoxGeometry(boxes) {
  const values = [];
  for (const box of boxes) {
    const minX = box.minX;
    const minY = box.minY;
    const minZ = box.minZ;
    const maxX = box.maxX;
    const maxY = box.maxY;
    const maxZ = box.maxZ;
    const corners = [
      [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
      [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ]
    ];
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      values.push(...corners[a], ...corners[b]);
    }
  }
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

function combineGeometry(items) {
  const geometries = (items || []).filter(Boolean);
  if (!geometries.length) return null;
  const total = geometries.reduce((sum, item) => sum + item.vertices.length, 0);
  const vertices = new Float32Array(total);
  const normals = new Float32Array(total);
  let offset = 0;
  for (const item of geometries) {
    vertices.set(item.vertices, offset);
    normals.set(item.normals, offset);
    offset += item.vertices.length;
  }
  return { vertices, normals };
}

function makeMesh(gl, geometry, color, mode, options = {}) {
  const vao = {
    count: geometry.vertices.length / 3,
    color,
    mode,
    clip: !!options.clip,
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
    varying float vZ;
    void main() {
      vec3 light = normalize(vec3(0.35, -0.45, 0.82));
      vLight = max(0.25, dot(normalize(aNormal), light));
      vZ = aPosition.z;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;
  const fs = `
    precision mediump float;
    uniform vec4 uColor;
    uniform float uClipZ;
    uniform bool uUseClip;
    varying float vLight;
    varying float vZ;
    void main() {
      if (uUseClip && vZ > uClipZ) discard;
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
    uColor: gl.getUniformLocation(program, "uColor"),
    uClipZ: gl.getUniformLocation(program, "uClipZ"),
    uUseClip: gl.getUniformLocation(program, "uUseClip")
  };
}

function shader(gl, type, source) {
  const out = gl.createShader(type);
  gl.shaderSource(out, source);
  gl.compileShader(out);
  if (!gl.getShaderParameter(out, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(out));
  return out;
}

function drawMesh(gl, program, mesh, mvp, clipZ = 0) {
  gl.useProgram(program.handle);
  gl.uniformMatrix4fv(program.uMvp, false, mvp);
  gl.uniform4fv(program.uColor, mesh.color);
  gl.uniform1f(program.uClipZ, clipZ);
  gl.uniform1i(program.uUseClip, mesh.clip ? 1 : 0);
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

function transformPoint(point, matrix) {
  const x = point[0], y = point[1], z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (w <= 0) return null;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
  ];
}

function projectPoint(point, matrix, canvas) {
  const clip = transformPoint(point, matrix);
  if (!clip) return null;
  return [
    (clip[0] * 0.5 + 0.5) * canvas.clientWidth,
    (1 - (clip[1] * 0.5 + 0.5)) * canvas.clientHeight,
    clip[2]
  ];
}

function boundsCorners(bounds) {
  return [
    [bounds.minX, bounds.minY, bounds.minZ],
    [bounds.maxX, bounds.minY, bounds.minZ],
    [bounds.maxX, bounds.maxY, bounds.minZ],
    [bounds.minX, bounds.maxY, bounds.minZ],
    [bounds.minX, bounds.minY, bounds.maxZ],
    [bounds.maxX, bounds.minY, bounds.maxZ],
    [bounds.maxX, bounds.maxY, bounds.maxZ],
    [bounds.minX, bounds.maxY, bounds.maxZ]
  ];
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
