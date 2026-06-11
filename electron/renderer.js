const $ = (id) => document.getElementById(id);

const fields = [
  "machineName", "resolutionX", "resolutionY", "sizeX", "sizeY", "sizeZ", "layerHeight",
  "resinName", "exposure", "bottomExposure", "bottomLayers", "transitionLayers",
  "liftDistance", "liftSpeed", "retractDistance", "retractSpeed",
  "waitAfterRetract", "resinDensity", "lightPwm", "bottomLightPwm",
  "rotateX", "rotateY", "rotateZ", "translateX", "translateY", "translateZ",
  "scale", "modelLift", "overhangAngle", "supportSpacing", "postDiameter",
  "primaryDensityMultiplier", "primaryAreaDiameter", "primaryMaxExtra",
  "tipDiameter", "tipType", "sphericalContactDiameter", "sphericalContactInsetPercent",
  "tipLength", "footDiameter",
  "bedInterface", "raftOffset", "raftChamferWidth", "raftChamferAngle", "bedInterfaceThickness", "collisionClearance", "maxBaseReach",
  "maxSupportAngle", "enforcerReach", "enforcerMinDrop", "cadSlicingMode",
  "braceDiameter", "braceHeight", "braceDistance"
];

const placementFields = new Set(["rotateX", "rotateY", "rotateZ", "translateX", "translateY", "translateZ", "scale"]);
const translationPlacementFields = new Set(["translateX", "translateY", "translateZ"]);
const placementUnitFactors = {
  mm: 1,
  cm: 10,
  in: 25.4
};
const profileStorageKeys = {
  machines: "resinSlicer.machineProfiles",
  deletedMachines: "resinSlicer.deletedMachineProfiles",
  resins: "resinSlicer.resinProfilesByMachine",
  selectedMachine: "resinSlicer.selectedMachineProfile",
  placementUnit: "resinSlicer.placementUnit",
  supportPresets: "resinSlicer.supportPresets"
};

let builtinProfiles = {};
let profiles = {};
let userMachineProfiles = {};
let deletedMachineProfileIds = [];
let resinProfilesByMachine = {};
let selectedMachineProfileKey = "";
let models = [];
let selectedModelIds = new Set();
let lastSelectedModelId = null;
let buildPlates = [];
let activePlateId = null;
let expandedPlateId = null;
let nextBuildPlateId = 1;
let nextModelId = 1;
let nextImportJobId = 1;
let nextLoadProgressId = 1;
let latestImportJobId = 0;
let uvtoolsPrinterCache = [];
let viewer = null;
let partClipboard = [];
let soundPlayer = null;
let soundInitError = null;
let sceneUpdateFrame = null;
let toastTimer = null;
let themedPromptResolver = null;
let activeRightMenuId = "job";
let placementUnit = "mm";
let activeSupportPreset = "normal";
const loadProgressItems = new Map();
const fileReadProgressHandlers = new Map();
const previewLayerReadPromises = new Map();

const soundAssetRoot = "../src/assets/electron-sound-kit/";
const soundStorageKeys = {
  enabled: "resinSlicer.soundEnabled",
  volume: "resinSlicer.soundVolume"
};
const viewStorageKeys = {
  projection: "resinSlicer.projectionMode",
  navigation: "resinSlicer.navigationMode"
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

const defaultSupportPresets = {
  light: {
    supportsEnabled: true,
    modelLift: 4,
    overhangAngle: 42,
    supportSpacing: 4,
    primarySupportsEnabled: false,
    primaryDensityMultiplier: 1.6,
    primaryAreaDiameter: 6,
    primaryMaxExtra: 4,
    postDiameter: 0.42,
    tipDiameter: 0.26,
    tipType: "cone",
    sphericalContactEnabled: false,
    sphericalContactDiameter: 0.45,
    sphericalContactInsetPercent: 50,
    tipLength: 0.65,
    footDiameter: 1.1,
    bedInterface: "feet",
    raftOffset: 0.45,
    raftChamferWidth: 0.25,
    raftChamferAngle: 45,
    bedInterfaceThickness: 0.25,
    collisionClearance: 0.06,
    maxBaseReach: 40,
    maxSupportAngle: 40,
    enforcersEnabled: false,
    enforcerReach: 8,
    enforcerMinDrop: 1,
    braceEnabled: false,
    braceDiameter: 0.26,
    braceHeight: 2.5,
    braceDistance: 7
  },
  normal: {
    supportsEnabled: true,
    modelLift: 5,
    overhangAngle: 45,
    supportSpacing: 3,
    primarySupportsEnabled: false,
    primaryDensityMultiplier: 2,
    primaryAreaDiameter: 8,
    primaryMaxExtra: 8,
    postDiameter: 0.56,
    tipDiameter: 0.36,
    tipType: "cone",
    sphericalContactEnabled: false,
    sphericalContactDiameter: 0.6,
    sphericalContactInsetPercent: 50,
    tipLength: 0.8,
    footDiameter: 1.6,
    bedInterface: "raft",
    raftOffset: 0.6,
    raftChamferWidth: 0.4,
    raftChamferAngle: 45,
    bedInterfaceThickness: 0.35,
    collisionClearance: 0.08,
    maxBaseReach: 45,
    maxSupportAngle: 35,
    enforcersEnabled: false,
    enforcerReach: 10,
    enforcerMinDrop: 1,
    braceEnabled: true,
    braceDiameter: 0.36,
    braceHeight: 3,
    braceDistance: 8
  },
  heavy: {
    supportsEnabled: true,
    modelLift: 6,
    overhangAngle: 50,
    supportSpacing: 2,
    primarySupportsEnabled: true,
    primaryDensityMultiplier: 2.4,
    primaryAreaDiameter: 10,
    primaryMaxExtra: 12,
    postDiameter: 0.78,
    tipDiameter: 0.5,
    tipType: "cone",
    sphericalContactEnabled: false,
    sphericalContactDiameter: 0.8,
    sphericalContactInsetPercent: 50,
    tipLength: 1,
    footDiameter: 2.2,
    bedInterface: "raft",
    raftOffset: 0.9,
    raftChamferWidth: 0.6,
    raftChamferAngle: 45,
    bedInterfaceThickness: 0.5,
    collisionClearance: 0.1,
    maxBaseReach: 50,
    maxSupportAngle: 30,
    enforcersEnabled: true,
    enforcerReach: 12,
    enforcerMinDrop: 1,
    braceEnabled: true,
    braceDiameter: 0.5,
    braceHeight: 3.5,
    braceDistance: 10
  }
};
let supportPresets = cloneSettings(defaultSupportPresets);
let dragState = null;
let isGeneratingSupports = false;
let isBusy = false;
let slicePreviewActive = false;
let slicePreviewPlateId = null;
let slicePreviewSession = 0;
let previewLayerCache = new Map();
let previewZoom = 1.0;
let previewPanX = 0;
let previewPanY = 0;
let previewDragStart = null;

async function init() {
  viewer = new Viewer($("viewer"));
  viewer.onFrame = updateViewCube;
  initSounds();
  initViewControls();
  $("openButton").addEventListener("click", openStl);
  $("saveButton").addEventListener("click", chooseOutput);
  $("importMachineButton").addEventListener("click", browseMachineProfile);
  $("importUvtoolsMachineButton").addEventListener("click", importUvtoolsMachine);
  $("exportMachineButton").addEventListener("click", () => exportProfile("machine"));
  $("saveMachineProfileButton").addEventListener("click", () => saveCurrentMachineProfile({ createNew: true }));
  $("updateMachineProfileButton").addEventListener("click", () => saveCurrentMachineProfile({ key: currentMachineProfileKey() }));
  $("deleteMachineProfileButton").addEventListener("click", deleteSelectedMachineProfile);
  $("topbarResinSelect").addEventListener("change", applySelectedTopbarResin);
  $("importResinButton").addEventListener("click", () => importProfile("resin"));
  $("exportResinButton").addEventListener("click", () => exportProfile("resin"));
  $("saveResinProfileButton").addEventListener("click", () => saveCurrentResinProfile({ createNew: true }));
  $("updateResinProfileButton").addEventListener("click", () => saveCurrentResinProfile({ key: currentResinProfileKey() }));
  $("deleteResinProfileButton").addEventListener("click", deleteSelectedResinProfile);
  $("importSupportButton").addEventListener("click", () => importProfile("support"));
  $("exportSupportButton").addEventListener("click", () => exportProfile("support"));
  for (const button of document.querySelectorAll("[data-support-preset]")) {
    button.addEventListener("click", () => applySupportPreset(button.dataset.supportPreset));
  }
  $("saveSupportPresetButton").addEventListener("click", saveActiveSupportPreset);
  $("saveProjectButton").addEventListener("click", saveProject);
  $("addBuildPlateButton").addEventListener("click", addBuildPlate);
  $("fitViewButton").addEventListener("click", () => {
    viewer.recenter();
    playSound("click-soft");
  });
  $("selectAllButton").addEventListener("click", selectAllModels);
  $("moveToActivePlateButton").addEventListener("click", moveSelectedModelsToActivePlate);
  $("clipEnabled").addEventListener("change", () => {
    activePlate().clipEnabled = $("clipEnabled").checked;
    snapPlateClipHeightToLayer(activePlate());
    updatePlateControls(activePlate());
    updateScene();
  });
  $("clipHeight").addEventListener("input", () => setActivePlateClipLayer(Number($("clipHeight").value)));
  $("clipHeight").addEventListener("wheel", stepClipHeightFromWheel, { passive: false });
  $("clipHeightValue").addEventListener("wheel", stepClipHeightFromWheel, { passive: false });
  $("clipHeightValue").addEventListener("change", () => setActivePlateClipLayer(Number($("clipHeightValue").value)));
  $("clipHeightValue").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setActivePlateClipLayer(Number($("clipHeightValue").value));
      $("clipHeightValue").blur();
    }
  });
  $("clipLayerUp").addEventListener("click", () => stepActiveClipLayer(1));
  $("clipLayerDown").addEventListener("click", () => stepActiveClipLayer(-1));
  $("previewButton").addEventListener("click", generatePreview);
  $("sliceButton").addEventListener("click", slice);
  $("sliceAllButton").addEventListener("click", sliceAll);
  $("viewSliceButton").addEventListener("click", toggleSlicePreview);
  $("slicePreviewCloseButton").addEventListener("click", exitSlicePreview);
  $("slicePreviewViewport").addEventListener("wheel", (event) => {
    if (!slicePreviewActive) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = $("slicePreviewViewport").getBoundingClientRect();
      const cx = event.clientX - rect.left - rect.width / 2;
      const cy = event.clientY - rect.top - rect.height / 2;
      const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
      previewPanX = cx - (cx - previewPanX) * factor;
      previewPanY = cy - (cy - previewPanY) * factor;
      previewZoom = Math.max(0.5, Math.min(20, previewZoom * factor));
      applyPreviewTransform();
    } else {
      const step = event.shiftKey ? 10 : 1;
      stepActiveClipLayer(event.deltaY > 0 ? -step : step);
    }
  }, { passive: false });
  $("slicePreviewViewport").addEventListener("mousedown", (event) => {
    if (!slicePreviewActive || event.button !== 0) return;
    previewDragStart = { x: event.clientX - previewPanX, y: event.clientY - previewPanY };
    $("slicePreviewImage").classList.add("dragging");
    event.preventDefault();
  });
  $("slicePreviewViewport").addEventListener("mousemove", (event) => {
    if (!previewDragStart) return;
    previewPanX = event.clientX - previewDragStart.x;
    previewPanY = event.clientY - previewDragStart.y;
    applyPreviewTransform();
  });
  const endPreviewDrag = () => {
    previewDragStart = null;
    $("slicePreviewImage").classList.remove("dragging");
  };
  $("slicePreviewViewport").addEventListener("mouseup", endPreviewDrag);
  $("slicePreviewViewport").addEventListener("mouseleave", endPreviewDrag);
  $("saveAllButton").addEventListener("click", saveAll);
  $("profile").addEventListener("change", () => {
    persistSelectedMachinePreference();
    loadProfileDefaults();
    persistSelectedResinForCurrentMachine();
    applyCurrentMachineProfileToAllBuildPlates();
    syncSceneSettingCommits();
    updateScene();
  });
  $("format").addEventListener("change", () => {
    if (models.length && !$("outputPath").value) setDefaultOutput();
  });
  for (const id of ["centerModel", "supportsEnabled", "primarySupportsEnabled", "sphericalContactEnabled", "enforcersEnabled", "braceEnabled"]) {
    $(id).addEventListener("change", () => {
      if (id === "sphericalContactEnabled") syncSphericalContactFields();
      writeActivePlateSettingsFromForm();
      updateScene();
    });
  }
  $("sphericalContactInsetPercent").addEventListener("input", syncSphericalContactFields);
  syncSphericalContactFields();
  initPlacementUnits();
  bindSceneSettingUpdates();
  bindPanelToggles();
  bindTopbarMenus();
  bindAccordionMenus();
  initDropLoading();
  initThemedPrompts();
  initUvtoolsDialog();
  initGlobalShortcuts();
  viewer.onScenePick = handleScenePick;
  viewer.onSceneDoubleClick = handleSceneDoubleClick;
  viewer.onModelDrag = handleModelDrag;
  viewer.onModelDragEnd = handleModelDragEnd;
  viewer.onGizmoDrag = handleGizmoDrag;
  viewer.onGizmoDragEnd = handleGizmoDragEnd;

  window.slicer.onSliceProgress((message) => log(message.message));
  if (window.slicer.onFileReadProgress) {
    window.slicer.onFileReadProgress((message) => {
      const handler = fileReadProgressHandlers.get(message.jobId);
      if (handler) handler(message);
    });
  }
  try {
    const profilePayload = await window.slicer.profiles();
    builtinProfiles = profilePayload.profiles || {};
    loadStoredProfileState();
    loadStoredSupportPresets();
    renderMachineProfileOptions(preferredMachineProfileKey(profiles["generic-2k"] ? "generic-2k" : Object.keys(profiles)[0] || ""));
    persistSelectedMachinePreference();
    loadProfileDefaults();
    writeSupportPresetFields("normal");
    ensureInitialBuildPlate();
    syncSceneSettingCommits();
  } catch (error) {
    log(`Could not load Python profiles: ${error.message}`);
    showErrorPrompt("Profile Load Failed", error);
    builtinProfiles = {
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
    loadStoredProfileState();
    loadStoredSupportPresets();
    renderMachineProfileOptions(preferredMachineProfileKey("generic-2k"));
    persistSelectedMachinePreference();
    loadProfileDefaults();
    writeSupportPresetFields("normal");
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
  const dropOffset = $("dropOffset");
  dropOffset.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDropOffsetField(dropOffset);
      dropOffset.blur();
    }
  });
  dropOffset.addEventListener("blur", () => commitDropOffsetField(dropOffset));
  dropOffset.addEventListener("change", () => commitDropOffsetField(dropOffset));
  normalizeDropOffsetField(dropOffset);
  dropOffset.dataset.sceneCommittedValue = dropOffset.value;
  syncSceneSettingCommits();
}

function syncSceneSettingCommits() {
  for (const id of fields) {
    const field = $(id);
    if (placementFields.has(id)) field.value = formatPlacementValue(number(id));
    field.dataset.sceneCommittedValue = fieldValue(field);
  }
}

function commitSceneSetting(field) {
  const value = placementFields.has(field.id)
    ? normalizePlacementField(field)
    : fieldValue(field);
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

function normalizePlacementField(field) {
  const value = roundPlacementValue(Number(field.value));
  field.value = formatPlacementValue(value);
  return field.value;
}

function commitDropOffsetField(field) {
  const value = normalizeDropOffsetField(field);
  if (value === field.dataset.sceneCommittedValue) return;
  field.dataset.sceneCommittedValue = value;
  const snapped = snapSelectedModelsToDropOffset();
  if (!snapped) return;
  updatePlacementFieldsFromSelection();
  updateScene();
}

function normalizeDropOffsetField(field) {
  const value = Math.max(0, roundPlacementValue(Number(field.value)));
  field.value = formatPlacementValue(value);
  return field.value;
}

function roundPlacementValue(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function formatPlacementValue(value) {
  return roundPlacementValue(value).toFixed(2);
}

function bindPanelToggles() {
  const shell = $("appShell");
  $("hideLeftPanelButton").addEventListener("click", () => {
    shell.classList.add("left-hidden");
    resizeViewerThroughPanelTransition();
  });
  $("showLeftPanelButton").addEventListener("click", () => {
    shell.classList.remove("left-hidden");
    resizeViewerThroughPanelTransition();
  });
  for (const button of document.querySelectorAll("[data-right-menu]")) {
    button.addEventListener("click", () => {
      toggleRightMenu(button.dataset.rightMenu);
    });
  }
  syncRightMenuRail();
}

function bindTopbarMenus() {
  for (const button of document.querySelectorAll("[data-topbar-menu-button]")) {
    button.addEventListener("click", () => toggleTopbarMenu(button.dataset.topbarMenuButton));
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".topbar-menu")) return;
    closeTopbarMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTopbarMenus();
  });
}

function toggleTopbarMenu(panelId) {
  const panel = $(panelId);
  if (!panel) return;
  const button = document.querySelector(`[data-topbar-menu-button="${panelId}"]`);
  const willOpen = panel.hidden;
  closeTopbarMenus();
  panel.hidden = !willOpen;
  if (button) button.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) playSound("drawer-open");
}

function closeTopbarMenus() {
  for (const button of document.querySelectorAll("[data-topbar-menu-button]")) {
    button.setAttribute("aria-expanded", "false");
  }
  for (const panel of document.querySelectorAll(".topbar-menu-panel")) {
    panel.hidden = true;
  }
}

function resizeViewerThroughPanelTransition() {
  const startedAt = performance.now();
  const tick = () => {
    viewer.resize({ recenter: false });
    if (performance.now() - startedAt < 320) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function bindAccordionMenus() {
  const groups = [...document.querySelectorAll(".right-panel details.group")];
  const initialMenuId = activeRightMenuId || "job";
  const initiallyOpen = groups.find((details) => details.open && details.dataset.rightMenuSection === initialMenuId)
    || groups.find((details) => details.dataset.rightMenuSection === initialMenuId)
    || null;
  for (const details of groups) {
    details.open = details === initiallyOpen && details.dataset.rightMenuSection === initialMenuId;
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      for (const other of groups) {
        if (other !== details) other.open = false;
      }
      setActiveRightMenu(details.dataset.rightMenuSection || activeRightMenuId);
    });
  }
  openRightMenu(initialMenuId, { scroll: false, resize: false });
}

function openRightMenu(menuId, { scroll = true, resize = true } = {}) {
  const shell = $("appShell");
  const panel = $("rightPanel");
  const targets = [...document.querySelectorAll(`[data-right-menu-section="${menuId}"]`)];
  const fallback = document.querySelector(`[data-right-menu-section="${activeRightMenuId}"]`)
    || document.querySelector("[data-right-menu-section]");
  const target = targets[0] || fallback;
  if (!target) return;
  shell.classList.remove("right-hidden");
  panel.classList.add("menu-focused");
  for (const section of document.querySelectorAll("[data-right-menu-section]")) {
    section.classList.toggle("active-menu-section", section.dataset.rightMenuSection === (target.dataset.rightMenuSection || menuId));
  }
  for (const details of document.querySelectorAll(".right-panel details.group")) {
    details.open = details === target && target.tagName.toLowerCase() === "details";
  }
  setActiveRightMenu(target.dataset.rightMenuSection || menuId);
  syncRightMenuRail();
  if (resize) resizeViewerThroughPanelTransition();
  if (scroll) {
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function toggleRightMenu(menuId) {
  const shell = $("appShell");
  const isActive = activeRightMenuId === menuId;
  if (!shell.classList.contains("right-hidden") && isActive) {
    shell.classList.add("right-hidden");
    syncRightMenuRail();
    resizeViewerThroughPanelTransition();
    playSound("drawer-close");
    return;
  }
  openRightMenu(menuId);
  playSound("drawer-open");
}

function setActiveRightMenu(menuId) {
  activeRightMenuId = menuId || "placement";
  for (const button of document.querySelectorAll("[data-right-menu]")) {
    button.classList.toggle("active", button.dataset.rightMenu === activeRightMenuId);
  }
}

function syncRightMenuRail() {
  const shell = $("appShell");
  const hidden = shell.classList.contains("right-hidden");
  for (const button of document.querySelectorAll("[data-right-menu]")) {
    button.setAttribute("aria-expanded", hidden ? "false" : String(button.dataset.rightMenu === activeRightMenuId));
  }
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

function initViewControls() {
  const storedProjection = localStorageValue(viewStorageKeys.projection, "perspective");
  const storedNavigation = localStorageValue(viewStorageKeys.navigation, "turntable");
  $("projectionToggle").checked = storedProjection === "orthographic";
  $("navigationMode").value = ["turntable", "trackball", "selection", "cursor"].includes(storedNavigation)
    ? storedNavigation
    : "turntable";
  viewer.setProjectionMode($("projectionToggle").checked ? "orthographic" : "perspective");
  viewer.setNavigationMode($("navigationMode").value);
  $("projectionToggle").addEventListener("change", () => {
    const mode = $("projectionToggle").checked ? "orthographic" : "perspective";
    viewer.setProjectionMode(mode);
    storeValue(viewStorageKeys.projection, mode);
    playSound($("projectionToggle").checked ? "toggle-on" : "toggle-off");
  });
  $("navigationMode").addEventListener("change", () => {
    viewer.setNavigationMode($("navigationMode").value);
    storeValue(viewStorageKeys.navigation, $("navigationMode").value);
    playSound("click-soft");
  });
}

function updateViewCube() {
  const cube = document.querySelector("#viewCube .view-cube-object");
  if (!cube || !viewer) return;
  cube.style.transform = viewCubeMatrix(viewer.cameraState());
}

function viewCubeMatrix({ right, up, zAxis }) {
  const cssUp = scaleVec(up, -1);
  const localAxes = [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0]
  ];
  const values = localAxes.flatMap((axis) => [
    dot(axis, right),
    dot(axis, cssUp),
    dot(axis, zAxis),
    0
  ]);
  return `matrix3d(${[...values, 0, 0, 0, 1].map((value) => cleanMatrixValue(value)).join(",")})`;
}

function cleanMatrixValue(value) {
  return Math.abs(value) < 1e-8 ? 0 : Number(value.toFixed(8));
}

function localStorageValue(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    log(`Could not save local settings: ${error.message}`);
  }
}

function loadStoredSupportPresets() {
  const stored = readStoredJson(profileStorageKeys.supportPresets, null);
  supportPresets = cloneSettings(defaultSupportPresets);
  if (!stored || typeof stored !== "object") return;
  for (const name of Object.keys(defaultSupportPresets)) {
    if (stored[name] && typeof stored[name] === "object") {
      supportPresets[name] = { ...supportPresets[name], ...stored[name] };
    }
  }
}

function persistSupportPresets() {
  writeStoredJson(profileStorageKeys.supportPresets, supportPresets);
}

function loadStoredProfileState() {
  userMachineProfiles = readStoredJson(profileStorageKeys.machines, {}) || {};
  deletedMachineProfileIds = readStoredJson(profileStorageKeys.deletedMachines, []) || [];
  resinProfilesByMachine = readStoredJson(profileStorageKeys.resins, {}) || {};
  selectedMachineProfileKey = localStorageValue(profileStorageKeys.selectedMachine, "");
  mergeMachineProfiles();
}

function persistProfileStorage() {
  writeStoredJson(profileStorageKeys.machines, userMachineProfiles);
  writeStoredJson(profileStorageKeys.deletedMachines, deletedMachineProfileIds);
  writeStoredJson(profileStorageKeys.resins, resinProfilesByMachine);
  persistSelectedMachinePreference(profiles[selectedMachineProfileKey] ? selectedMachineProfileKey : currentMachineProfileKey(), { validate: true });
}

function mergeMachineProfiles() {
  const deleted = new Set(deletedMachineProfileIds);
  profiles = {};
  for (const [key, cfg] of Object.entries(builtinProfiles)) {
    if (!deleted.has(key)) profiles[key] = cfg;
  }
  for (const [key, cfg] of Object.entries(userMachineProfiles)) {
    profiles[key] = cfg;
  }
  return profiles;
}

function renderMachineProfileOptions(preferredKey = currentMachineProfileKey()) {
  mergeMachineProfiles();
  const select = $("profile");
  const previous = preferredKey || select.value;
  select.innerHTML = "";
  const keys = Object.keys(profiles).sort((a, b) => machineProfileLabel(a, profiles[a]).localeCompare(machineProfileLabel(b, profiles[b])));
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = machineProfileLabel(key, profiles[key]);
    option.title = key;
    select.appendChild(option);
  }
  select.value = profiles[previous] ? previous : keys[0] || "";
}

function preferredMachineProfileKey(fallback = "") {
  mergeMachineProfiles();
  if (selectedMachineProfileKey && profiles[selectedMachineProfileKey]) return selectedMachineProfileKey;
  if (fallback && profiles[fallback]) return fallback;
  return Object.keys(profiles)[0] || "";
}

function persistSelectedMachinePreference(machineKey = currentMachineProfileKey(), { validate = true } = {}) {
  const key = String(machineKey || "");
  if (validate && key && !profiles[key]) return;
  selectedMachineProfileKey = key;
  if (key) storeValue(profileStorageKeys.selectedMachine, key);
}

function machineProfileLabel(key, cfg) {
  return String(cfg?.machine_name || key || "Printer");
}

function currentMachineProfileKey() {
  return $("profile")?.value || Object.keys(profiles)[0] || "generic-2k";
}

function profileKeyFromName(value, fallback = "profile") {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function uniqueProfileKey(baseKey, collection, ignoreKey = "") {
  const base = profileKeyFromName(baseKey);
  if ((!collection[base] || base === ignoreKey) && !profiles[base]) return base;
  for (let index = 2; index < 1000; index++) {
    const key = `${base}-${index}`;
    if ((!collection[key] || key === ignoreKey) && !profiles[key]) return key;
  }
  return `${base}-${Date.now()}`;
}

function machineProfileConfigFromForm() {
  const resin = currentResinProfile();
  return {
    machine_name: $("machineName").value.trim() || "Custom Printer",
    resolution_x: intNumber("resolutionX"),
    resolution_y: intNumber("resolutionY"),
    size_x_mm: number("sizeX"),
    size_y_mm: number("sizeY"),
    size_z_mm: number("sizeZ"),
    layer_height_mm: number("layerHeight"),
    resin_name: resin.resinName || "Standard",
    exposure_time_s: resin.exposure,
    bottom_exposure_time_s: resin.bottomExposure,
    bottom_layers: resin.bottomLayers,
    transition_layers: resin.transitionLayers,
    lift_distance_mm: resin.liftDistance,
    lift_speed_mm_min: resin.liftSpeed,
    retract_distance_mm: resin.retractDistance,
    retract_speed_mm_min: resin.retractSpeed,
    wait_after_retract_s: resin.waitAfterRetract,
    resin_density_g_ml: resin.resinDensity,
    light_pwm: resin.lightPwm,
    bottom_light_pwm: resin.bottomLightPwm
  };
}

function applyMachineConfigToForm(cfg) {
  $("machineName").value = cfg.machine_name || "Generic MSLA";
  $("resolutionX").value = cfg.resolution_x ?? 1920;
  $("resolutionY").value = cfg.resolution_y ?? 1080;
  $("sizeX").value = cfg.size_x_mm ?? 120;
  $("sizeY").value = cfg.size_y_mm ?? 67.5;
  $("sizeZ").value = cfg.size_z_mm ?? 160;
  $("layerHeight").value = cfg.layer_height_mm ?? 0.05;
}

function resinProfileFromConfig(cfg = {}) {
  return {
    resinName: cfg.resin_name || "Standard",
    exposure: cfg.exposure_time_s ?? 2.5,
    bottomExposure: cfg.bottom_exposure_time_s ?? 35,
    bottomLayers: cfg.bottom_layers ?? 6,
    transitionLayers: cfg.transition_layers ?? 6,
    liftDistance: cfg.lift_distance_mm ?? 5,
    liftSpeed: cfg.lift_speed_mm_min ?? 65,
    retractDistance: cfg.retract_distance_mm ?? 5,
    retractSpeed: cfg.retract_speed_mm_min ?? 150,
    waitAfterRetract: cfg.wait_after_retract_s ?? 0.2,
    resinDensity: cfg.resin_density_g_ml ?? 1.1,
    lightPwm: cfg.light_pwm ?? 255,
    bottomLightPwm: cfg.bottom_light_pwm ?? 255
  };
}

function applyResinProfileToForm(resin = {}) {
  $("resinName").value = resin.resinName || "Standard";
  $("exposure").value = resin.exposure ?? 2.5;
  $("bottomExposure").value = resin.bottomExposure ?? 35;
  $("bottomLayers").value = resin.bottomLayers ?? 6;
  $("transitionLayers").value = resin.transitionLayers ?? 6;
  $("liftDistance").value = resin.liftDistance ?? 5;
  $("liftSpeed").value = resin.liftSpeed ?? 65;
  $("retractDistance").value = resin.retractDistance ?? 5;
  $("retractSpeed").value = resin.retractSpeed ?? 150;
  $("waitAfterRetract").value = resin.waitAfterRetract ?? 0.2;
  $("resinDensity").value = resin.resinDensity ?? 1.1;
  $("lightPwm").value = resin.lightPwm ?? 255;
  $("bottomLightPwm").value = resin.bottomLightPwm ?? 255;
}

function machineResinBucket(machineKey = currentMachineProfileKey()) {
  let bucket = resinProfilesByMachine[machineKey];
  if (!bucket || typeof bucket !== "object" || !bucket.items || typeof bucket.items !== "object") {
    bucket = { selected: "", items: {} };
  }
  if (!Object.keys(bucket.items).length) {
    const resin = resinProfileFromConfig(profiles[machineKey] || builtinProfiles[machineKey] || {});
    const key = profileKeyFromName(resin.resinName, "standard");
    bucket.items[key] = resin;
    bucket.selected = key;
  }
  if (!bucket.selected || !bucket.items[bucket.selected]) {
    bucket.selected = Object.keys(bucket.items)[0] || "";
  }
  resinProfilesByMachine[machineKey] = bucket;
  return bucket;
}

function renderTopbarResinOptions(machineKey = currentMachineProfileKey(), preferredKey = "") {
  const select = $("topbarResinSelect");
  if (!select) return;
  const bucket = machineResinBucket(machineKey);
  if (preferredKey && bucket.items[preferredKey]) bucket.selected = preferredKey;
  select.innerHTML = "";
  const keys = Object.keys(bucket.items).sort((a, b) => resinProfileLabel(bucket.items[a]).localeCompare(resinProfileLabel(bucket.items[b])));
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = resinProfileLabel(bucket.items[key]);
    select.appendChild(option);
  }
  select.value = bucket.selected || keys[0] || "";
}

function resinProfileLabel(resin) {
  return String(resin?.resinName || "Standard");
}

function currentResinProfileKey() {
  return $("topbarResinSelect")?.value || machineResinBucket().selected || "";
}

function selectedResinProfile(machineKey = currentMachineProfileKey()) {
  const bucket = machineResinBucket(machineKey);
  return bucket.items[bucket.selected] || Object.values(bucket.items)[0] || resinProfileFromConfig(profiles[machineKey]);
}

function findResinProfileKey(machineKey, resinName) {
  const bucket = machineResinBucket(machineKey);
  const normalized = profileKeyFromName(resinName, "standard");
  if (bucket.items[normalized]) return normalized;
  const target = String(resinName || "").trim().toLowerCase();
  return Object.keys(bucket.items).find((key) => resinProfileLabel(bucket.items[key]).trim().toLowerCase() === target) || "";
}

function upsertCurrentResinProfileForMachine(machineKey, { key = "", createNew = false, select = true, persist = true } = {}) {
  const bucket = machineResinBucket(machineKey);
  const resin = currentResinProfile();
  let targetKey = key && bucket.items[key] && !createNew ? key : "";
  if (!targetKey && !createNew) targetKey = findResinProfileKey(machineKey, resin.resinName);
  if (!targetKey) targetKey = uniqueProfileKey(profileKeyFromName(resin.resinName, "resin"), bucket.items, key);
  bucket.items[targetKey] = resin;
  if (select) bucket.selected = targetKey;
  resinProfilesByMachine[machineKey] = bucket;
  if (persist) persistProfileStorage();
  return targetKey;
}

function syncTopbarResinOptionsToForm({ persist = false } = {}) {
  const machineKey = currentMachineProfileKey();
  let key = findResinProfileKey(machineKey, $("resinName").value);
  if (!key) {
    key = upsertCurrentResinProfileForMachine(machineKey, { createNew: true, select: true, persist: false });
  } else {
    machineResinBucket(machineKey).selected = key;
  }
  if (persist) persistProfileStorage();
  renderTopbarResinOptions(machineKey, key);
}

function persistSelectedResinForCurrentMachine() {
  const bucket = machineResinBucket(currentMachineProfileKey());
  if ($("topbarResinSelect").value && bucket.items[$("topbarResinSelect").value]) {
    bucket.selected = $("topbarResinSelect").value;
    persistProfileStorage();
  }
}

function applySelectedTopbarResin() {
  const machineKey = currentMachineProfileKey();
  const bucket = machineResinBucket(machineKey);
  const key = $("topbarResinSelect").value;
  const resin = bucket.items[key];
  if (!resin) return;
  bucket.selected = key;
  persistProfileStorage();
  applyResinProfileToForm(resin);
  writeActivePlateSettingsFromForm();
  syncSceneSettingCommits();
  updateScene();
  playSound("click-soft");
}

function saveCurrentMachineProfile({ key = "", createNew = false } = {}) {
  const cfg = machineProfileConfigFromForm();
  const targetKey = createNew || !key
    ? uniqueProfileKey(profileKeyFromName(cfg.machine_name, "custom-printer"), userMachineProfiles)
    : key;
  userMachineProfiles[targetKey] = cfg;
  deletedMachineProfileIds = deletedMachineProfileIds.filter((id) => id !== targetKey);
  mergeMachineProfiles();
  upsertCurrentResinProfileForMachine(targetKey, { select: true, persist: false });
  renderMachineProfileOptions(targetKey);
  $("profile").value = targetKey;
  persistSelectedMachinePreference(targetKey);
  persistProfileStorage();
  syncTopbarResinOptionsToForm({ persist: false });
  writeActivePlateSettingsFromForm();
  updateBuildPlateLayout({ force: true });
  renderWorkspaceLists();
  updateScene();
  log(`Saved printer profile: ${machineProfileLabel(targetKey, cfg)}`);
  playSound("save");
  return targetKey;
}

async function deleteSelectedMachineProfile() {
  const key = currentMachineProfileKey();
  if (!key || !profiles[key]) return;
  if (Object.keys(profiles).length <= 1) {
    logAndPrompt("Cannot Delete Printer", "At least one machine profile must remain in the list.", "warning");
    return;
  }
  const label = machineProfileLabel(key, profiles[key]);
  const confirmed = await showThemedConfirm({
    title: "Delete Printer?",
    message: `Delete "${label}" from your machine profile list?`,
    detail: "Any build plates currently using it will be switched to the next available printer profile.",
    kind: "warning",
    confirmText: "Delete",
    cancelText: "Cancel"
  });
  if (!confirmed) return;
  delete userMachineProfiles[key];
  if (builtinProfiles[key] && !deletedMachineProfileIds.includes(key)) deletedMachineProfileIds.push(key);
  delete resinProfilesByMachine[key];
  mergeMachineProfiles();
  const nextKey = preferredMachineProfileKey(Object.keys(profiles)[0] || "");
  renderMachineProfileOptions(nextKey);
  persistSelectedMachinePreference($("profile").value);
  persistProfileStorage();
  loadProfileDefaults();
  applyCurrentMachineProfileToAllBuildPlates();
  syncSceneSettingCommits();
  updateScene();
  log(`Deleted printer profile: ${label}`);
  playSound("delete");
}

function saveCurrentResinProfile({ key = "", createNew = false } = {}) {
  const machineKey = currentMachineProfileKey();
  const targetKey = upsertCurrentResinProfileForMachine(machineKey, { key, createNew, select: true, persist: true });
  renderTopbarResinOptions(machineKey, targetKey);
  writeActivePlateSettingsFromForm();
  syncSceneSettingCommits();
  updateScene();
  log(`Saved resin profile: ${resinProfileLabel(machineResinBucket(machineKey).items[targetKey])}`);
  playSound("save");
  return targetKey;
}

async function deleteSelectedResinProfile() {
  const machineKey = currentMachineProfileKey();
  const bucket = machineResinBucket(machineKey);
  const key = currentResinProfileKey();
  if (!key || !bucket.items[key]) return;
  if (Object.keys(bucket.items).length <= 1) {
    logAndPrompt("Cannot Delete Resin", "At least one resin must remain for the selected printer.", "warning");
    return;
  }
  const label = resinProfileLabel(bucket.items[key]);
  const confirmed = await showThemedConfirm({
    title: "Delete Resin?",
    message: `Delete "${label}" from this printer's resin list?`,
    kind: "warning",
    confirmText: "Delete",
    cancelText: "Cancel"
  });
  if (!confirmed) return;
  delete bucket.items[key];
  bucket.selected = Object.keys(bucket.items)[0] || "";
  persistProfileStorage();
  renderTopbarResinOptions(machineKey, bucket.selected);
  applyResinProfileToForm(selectedResinProfile(machineKey));
  writeActivePlateSettingsFromForm();
  syncSceneSettingCommits();
  updateScene();
  log(`Deleted resin profile: ${label}`);
  playSound("delete");
}

async function offerSaveImportedMachineProfile(label = $("machineName").value) {
  const confirmed = await showThemedConfirm({
    title: "Save Printer?",
    message: `Save "${label || "Imported Printer"}" to your machine profile list?`,
    kind: "info",
    confirmText: "Save",
    cancelText: "Not Now"
  });
  if (confirmed) saveCurrentMachineProfile({ createNew: true });
}

async function offerSaveImportedResinProfile(label = $("resinName").value) {
  const confirmed = await showThemedConfirm({
    title: "Save Resin?",
    message: `Save "${label || "Imported Resin"}" for ${machineProfileLabel(currentMachineProfileKey(), profiles[currentMachineProfileKey()])}?`,
    kind: "info",
    confirmText: "Save",
    cancelText: "Not Now"
  });
  if (confirmed) saveCurrentResinProfile({ createNew: true });
}

function initPlacementUnits() {
  const select = $("placementUnits");
  if (!select) return;
  placementUnit = validPlacementUnit(localStorageValue(profileStorageKeys.placementUnit, "mm"));
  select.value = placementUnit;
  select.addEventListener("change", () => {
    const previousUnit = placementUnit;
    const dropOffsetMm = placementDisplayToMm(Number($("dropOffset").value), previousUnit);
    placementUnit = validPlacementUnit(select.value);
    try {
      localStorage.setItem(profileStorageKeys.placementUnit, placementUnit);
    } catch {
      // Best-effort preference only.
    }
    updatePlacementFieldsFromSelection();
    $("dropOffset").value = formatPlacementValue(placementMmToDisplay(Math.max(0, dropOffsetMm), placementUnit));
    $("dropOffset").dataset.sceneCommittedValue = $("dropOffset").value;
  });
}

function validPlacementUnit(unit) {
  return Object.prototype.hasOwnProperty.call(placementUnitFactors, unit) ? unit : "mm";
}

function placementDisplayToMm(value, unit = placementUnit) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * placementUnitFactors[validPlacementUnit(unit)] : 0;
}

function placementMmToDisplay(value, unit = placementUnit) {
  const numeric = Number(value);
  const factor = placementUnitFactors[validPlacementUnit(unit)];
  return Number.isFinite(numeric) ? numeric / factor : 0;
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
  placeBuildPlateInSpiral(plate);
  buildPlates.push(plate);
  activePlateId = plate.id;
  expandedPlateId = plate.id;
  updateBuildPlateLayout();
  applyBuildPlateSettingsToForm(plate);
}

function createBuildPlate(name, settings) {
  return {
    id: nextBuildPlateId++,
    name,
    settings: cloneSettings(settings),
    origin: { x: 0, y: 0 },
    layoutSlot: null,
    clipHeight: Number(settings.printer.sizeZ) || 160,
    clipEnabled: false,
    layersGenerated: false,
    sliced: false,
    sliceLayerCount: 0,
    previewDir: null,
    supports: [],
    supportBraces: [],
    supportRaft: null,
    dropAnimation: null
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
    cadSlicingMode: $("cadSlicingMode")?.value || "tessellated",
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
      primaryAreaDiameter: number("primaryAreaDiameter"),
      primaryMaxExtra: intNumber("primaryMaxExtra"),
      postDiameter: number("postDiameter"),
      tipDiameter: number("tipDiameter"),
      tipType: $("tipType").value,
      sphericalContactEnabled: $("sphericalContactEnabled").checked,
      sphericalContactDiameter: number("sphericalContactDiameter"),
      sphericalContactInsetPercent: number("sphericalContactInsetPercent"),
      tipLength: number("tipLength"),
      footDiameter: number("footDiameter"),
      bedInterface: $("bedInterface").value,
      raftOffset: number("raftOffset"),
      raftChamferWidth: number("raftChamferWidth"),
      raftChamferAngle: number("raftChamferAngle"),
      bedInterfaceThickness: number("bedInterfaceThickness"),
      collisionClearance: number("collisionClearance"),
      maxBaseReach: number("maxBaseReach"),
      maxSupportAngle: number("maxSupportAngle"),
      enforcersEnabled: $("enforcersEnabled").checked,
      enforcerReach: number("enforcerReach"),
      enforcerMinDrop: number("enforcerMinDrop"),
      braceEnabled: $("braceEnabled").checked,
      braceDiameter: number("braceDiameter"),
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
  snapPlateClipHeightToLayer(plate);
  updatePlateControls(plate);
  renderBuildPlateList();
}

function settingsValue(settings, key, fallback) {
  const value = settings?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function diameterSetting(settings, diameterKey, radiusKey, fallbackDiameter) {
  const diameter = Number(settings?.[diameterKey]);
  if (Number.isFinite(diameter)) return diameter;
  const radius = Number(settings?.[radiusKey]);
  if (Number.isFinite(radius)) return radius * 2;
  return fallbackDiameter;
}

function insetPercentSetting(support) {
  const percent = Number(support?.sphericalContactInsetPercent);
  if (Number.isFinite(percent)) return clamp(percent, 5, 95);
  const insetMm = Number(support?.sphericalContactInset);
  const diameterMm = Number(support?.sphericalContactDiameter);
  if (Number.isFinite(insetMm) && Number.isFinite(diameterMm) && diameterMm > 0) {
    return clamp(Math.round((insetMm / diameterMm) * 100), 5, 95);
  }
  return 50;
}

function applyBuildPlateSettingsToForm(plate) {
  const settings = plate.settings;
  if (profiles[settings.profile]) $("profile").value = settings.profile;
  $("centerModel").checked = !!settings.centerModel;
  if ($("cadSlicingMode")) $("cadSlicingMode").value = settings.cadSlicingMode || "tessellated";
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
  syncTopbarResinOptionsToForm({ persist: false });
  const support = settings.support;
  $("supportsEnabled").checked = !!support.enabled;
  $("modelLift").value = support.modelLift;
  $("overhangAngle").value = support.overhangAngle;
  $("supportSpacing").value = support.spacing;
  $("primarySupportsEnabled").checked = !!support.primarySupportsEnabled;
  $("primaryDensityMultiplier").value = support.primaryDensityMultiplier;
  $("primaryAreaDiameter").value = diameterSetting(support, "primaryAreaDiameter", "primaryAreaRadius", 8);
  $("primaryMaxExtra").value = support.primaryMaxExtra;
  $("postDiameter").value = diameterSetting(support, "postDiameter", "postRadius", 0.56);
  $("tipDiameter").value = diameterSetting(support, "tipDiameter", "tipRadius", 0.36);
  $("tipType").value = support.tipType;
  $("sphericalContactEnabled").checked = !!support.sphericalContactEnabled;
  $("sphericalContactDiameter").value = support.sphericalContactDiameter ?? 0.6;
  $("sphericalContactInsetPercent").value = insetPercentSetting(support);
  $("tipLength").value = support.tipLength;
  $("footDiameter").value = diameterSetting(support, "footDiameter", "footRadius", 1.6);
  $("bedInterface").value = support.bedInterface;
  $("raftOffset").value = settingsValue(support, "raftOffset", settingsValue(support, "raftMargin", 0.6));
  $("raftChamferWidth").value = settingsValue(support, "raftChamferWidth", settingsValue(support, "raft_chamfer_width_mm", 0.4));
  $("raftChamferAngle").value = settingsValue(support, "raftChamferAngle", settingsValue(support, "raft_chamfer_angle_deg", 45));
  $("bedInterfaceThickness").value = settingsValue(support, "bedInterfaceThickness", 0.35);
  $("collisionClearance").value = support.collisionClearance;
  $("maxBaseReach").value = support.maxBaseReach;
  $("maxSupportAngle").value = support.maxSupportAngle;
  $("enforcersEnabled").checked = !!support.enforcersEnabled;
  $("enforcerReach").value = support.enforcerReach;
  $("enforcerMinDrop").value = support.enforcerMinDrop;
  $("braceEnabled").checked = !!support.braceEnabled;
  $("braceDiameter").value = diameterSetting(support, "braceDiameter", "braceRadius", 0.36);
  $("braceHeight").value = support.braceHeight;
  $("braceDistance").value = support.braceDistance;
  syncSphericalContactFields();
  updatePlacementFieldsFromSelection();
  updatePlateControls(plate);
  syncSceneSettingCommits();
}

function syncSphericalContactFields() {
  const fields = $("sphericalContactFields");
  if (!fields) return;
  fields.hidden = !$("sphericalContactEnabled").checked;
  const value = clamp(Math.round(number("sphericalContactInsetPercent")), 5, 95);
  $("sphericalContactInsetPercent").value = value;
  $("sphericalContactInsetValue").textContent = `${value}%`;
}

function supportPresetFromForm() {
  return {
    supportsEnabled: $("supportsEnabled").checked,
    modelLift: number("modelLift"),
    overhangAngle: number("overhangAngle"),
    supportSpacing: number("supportSpacing"),
    primarySupportsEnabled: $("primarySupportsEnabled").checked,
    primaryDensityMultiplier: number("primaryDensityMultiplier"),
    primaryAreaDiameter: number("primaryAreaDiameter"),
    primaryMaxExtra: intNumber("primaryMaxExtra"),
    postDiameter: number("postDiameter"),
    tipDiameter: number("tipDiameter"),
    tipType: $("tipType").value,
    sphericalContactEnabled: $("sphericalContactEnabled").checked,
    sphericalContactDiameter: number("sphericalContactDiameter"),
    sphericalContactInsetPercent: number("sphericalContactInsetPercent"),
    tipLength: number("tipLength"),
    footDiameter: number("footDiameter"),
    bedInterface: $("bedInterface").value,
    raftOffset: number("raftOffset"),
    raftChamferWidth: number("raftChamferWidth"),
    raftChamferAngle: number("raftChamferAngle"),
    bedInterfaceThickness: number("bedInterfaceThickness"),
    collisionClearance: number("collisionClearance"),
    maxBaseReach: number("maxBaseReach"),
    maxSupportAngle: number("maxSupportAngle"),
    enforcersEnabled: $("enforcersEnabled").checked,
    enforcerReach: number("enforcerReach"),
    enforcerMinDrop: number("enforcerMinDrop"),
    braceEnabled: $("braceEnabled").checked,
    braceDiameter: number("braceDiameter"),
    braceHeight: number("braceHeight"),
    braceDistance: number("braceDistance")
  };
}

function saveActiveSupportPreset() {
  const name = supportPresets[activeSupportPreset] ? activeSupportPreset : "normal";
  supportPresets[name] = supportPresetFromForm();
  persistSupportPresets();
  writeActivePlateSettingsFromForm();
  syncSceneSettingCommits();
  updateScene();
  log(`Saved current support settings to ${titleCase(name)} support preset`);
  playSound("save");
}

function writeSupportPresetFields(name) {
  const preset = supportPresets[name];
  if (!preset) return false;
  for (const [id, value] of Object.entries(preset)) {
    const field = $(id);
    if (!field) continue;
    if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = value;
    }
  }
  activeSupportPreset = name;
  for (const button of document.querySelectorAll("[data-support-preset]")) {
    button.classList.toggle("active", button.dataset.supportPreset === name);
  }
  syncSphericalContactFields();
  return true;
}

function applySupportPreset(name) {
  if (!writeSupportPresetFields(name)) return;
  const plate = activePlate();
  writeActivePlateSettingsFromForm();
  plate.supports = [];
  plate.supportBraces = [];
  plate.supportRaft = null;
  plate.layersGenerated = false;
  $("supportStatus").textContent = "Supports not generated";
  syncSceneSettingCommits();
  updateScene();
  log(`${titleCase(name)} support preset applied`);
  playSound("click-soft");
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function updatePlateControls(plate) {
  const maxLayer = plateOccupiedMaxLayer(plate);
  const layer = clipHeightToLayer(plate, plate.clipHeight);
  $("clipHeight").min = 1;
  $("clipHeight").max = maxLayer;
  $("clipHeight").value = layer;
  $("clipHeightValue").min = 1;
  $("clipHeightValue").max = maxLayer;
  $("clipHeightValue").value = layer;
  $("clipEnabled").checked = !!plate.clipEnabled;
}

function addBuildPlate(options = {}) {
  if (options instanceof Event) options = {};
  writeActivePlateSettingsFromForm();
  const sourcePlate = options.sourcePlateId
    ? buildPlates.find((item) => item.id === options.sourcePlateId) || activePlate()
    : activePlate();
  const plate = createBuildPlate(`Plate ${buildPlates.length + 1}`, sourcePlate.settings);
  placeBuildPlateInSpiral(plate);
  buildPlates.push(plate);
  activePlateId = plate.id;
  expandedPlateId = plate.id;
  plate.dropAnimation = { start: performance.now(), duration: 820 };
  updateBuildPlateLayout();
  selectedModelIds = new Set();
  lastSelectedModelId = null;
  applyBuildPlateSettingsToForm(plate);
  updateScene();
  viewer.zoomToFitBuildPlateIfNeeded(plate);
  animateBuildPlateDrop(plate);
  playSound("confirm");
}

async function addPartsToBuildPlate(plateId) {
  setActiveBuildPlate(plateId);
  try {
    playSound("click-soft");
    const paths = await window.slicer.openStl();
    if (!paths || !paths.length) {
      log("Add parts canceled.");
      return;
    }
    await loadStlPaths(paths, { append: true, sound: "drop", targetPlateId: plateId });
  } catch (error) {
    log(`Add parts failed: ${error.message}`);
    showErrorPrompt("Add Parts Failed", error);
  }
}

async function deleteBuildPlate(plateId) {
  const plate = buildPlates.find((item) => item.id === plateId);
  if (!plate) return;
  const plateModels = models.filter((model) => model.plateId === plateId);
  if (plateModels.length) {
    const confirmed = await showThemedConfirm({
      title: "Delete Build Plate?",
      message: `Delete ${plate.name} and ${plateModels.length.toLocaleString()} part${plateModels.length === 1 ? "" : "s"} on it?`,
      detail: "This removes the build plate and every part assigned to it from the current job.",
      confirmText: "Delete",
      kind: "warning"
    });
    if (!confirmed) return;
  }

  const deletedIds = new Set(plateModels.map((model) => model.id));
  models = models.filter((model) => model.plateId !== plateId);
  selectedModelIds = new Set([...selectedModelIds].filter((id) => !deletedIds.has(id)));
  if (deletedIds.has(lastSelectedModelId)) lastSelectedModelId = null;
  buildPlates = buildPlates.filter((item) => item.id !== plateId);

  if (!buildPlates.length) {
    const replacement = createBuildPlate("Plate 1", plate.settings);
    placeBuildPlateInSpiral(replacement);
    buildPlates.push(replacement);
    activePlateId = replacement.id;
  } else if (activePlateId === plateId) {
    activePlateId = buildPlates[Math.min(buildPlates.length - 1, 0)].id;
  }
  expandedPlateId = activePlateId;
  updateBuildPlateLayout();
  applyBuildPlateSettingsToForm(activePlate());
  normalizeLastSelectedModel();
  updateScene();
  log(`Deleted ${plate.name}`);
  playSound("delete");
}

function setActiveBuildPlate(id, { loadSettings = true, sound = true } = {}) {
  const plate = buildPlates.find((item) => item.id === id);
  if (!plate || plate.id === activePlateId) return;
  writeActivePlateSettingsFromForm();
  activePlateId = plate.id;
  expandedPlateId = plate.id;
  if (loadSettings) applyBuildPlateSettingsToForm(plate);
  renderWorkspaceLists();
  updateScene();
  if (sound) playSound("focus-ring");
}

function applyCurrentMachineProfileToAllBuildPlates() {
  ensureInitialBuildPlate();
  const nextSettings = buildPlateSettingsFromForm();
  for (const plate of buildPlates) {
    plate.settings.profile = nextSettings.profile;
    plate.settings.centerModel = nextSettings.centerModel;
    plate.settings.printer = cloneSettings(nextSettings.printer);
    snapPlateClipHeightToLayer(plate);
  }
  updateBuildPlateLayout({ force: true });
  applyBuildPlateSettingsToForm(activePlate());
  renderWorkspaceLists();
}

function updateBuildPlateLayout({ force = false } = {}) {
  buildPlates.forEach((plate) => {
    if (!Number.isFinite(plate.layoutSlot) || !isFiniteOrigin(plate.origin)) {
      placeBuildPlateInSpiral(plate);
    } else if (force) {
      plate.origin = buildPlateOriginForSlot(plate.layoutSlot, plate);
    } else {
      plate.origin = buildPlateOriginForSlot(plate.layoutSlot, plate);
    }
  });
}

function nextBuildPlatePreview() {
  const settings = cloneSettings(activePlate().settings);
  const preview = { settings, origin: { x: 0, y: 0 }, layoutSlot: null };
  const slot = nextOpenSpiralSlot(preview);
  const origin = buildPlateOriginForSlot(slot, preview);
  const bed = {
    x: settings.printer.sizeX || 120,
    y: settings.printer.sizeY || 67.5,
    z: settings.printer.sizeZ || 160
  };
  return {
    id: "next-build-plate",
    origin,
    bed,
    visual: { z: 0, scaleX: 1, scaleY: 1 }
  };
}

function placeBuildPlateInSpiral(plate) {
  const slot = Number.isFinite(plate.layoutSlot) && !spiralSlotOccupied(plate.layoutSlot, plate)
    ? plate.layoutSlot
    : nextOpenSpiralSlot(plate);
  plate.layoutSlot = slot;
  plate.origin = buildPlateOriginForSlot(slot, plate);
}

function nextOpenSpiralSlot(candidate) {
  const used = new Set(buildPlates
    .filter((plate) => plate !== candidate && Number.isFinite(plate.layoutSlot))
    .map((plate) => plate.layoutSlot));
  for (let slot = 0; slot < 512; slot++) {
    if (used.has(slot)) continue;
    const origin = buildPlateOriginForSlot(slot, candidate);
    const candidateBed = buildPlateBed(candidate);
    const overlaps = buildPlates.some((plate) => plate !== candidate && rectsOverlap(
      origin,
      candidateBed,
      plate.origin,
      buildPlateBed(plate)
    ));
    if (!overlaps) return slot;
  }
  return buildPlates.length;
}

function spiralSlotOccupied(slot, candidate) {
  return buildPlates.some((plate) => plate !== candidate && plate.layoutSlot === slot);
}

function buildPlateOriginForSlot(slot, plate) {
  if (slot === 0) return { x: 0, y: 0 };
  const grid = spiralGridCoordinate(slot);
  const step = buildPlateSpiralStep(plate);
  return {
    x: grid.x * step.x,
    y: grid.y * step.y
  };
}

function spiralGridCoordinate(slot) {
  if (slot <= 0) return { x: 0, y: 0 };
  const directions = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1]
  ];
  let x = 0;
  let y = 0;
  let index = 0;
  let segmentLength = 1;
  let directionIndex = 0;
  while (index < slot) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const [dx, dy] = directions[directionIndex % directions.length];
      for (let step = 0; step < segmentLength; step++) {
        x += dx;
        y += dy;
        index++;
        if (index === slot) return { x, y };
      }
      directionIndex++;
    }
    segmentLength++;
  }
  return { x, y };
}

function buildPlateSpiralStep(plate) {
  const all = [...buildPlates, plate].filter(Boolean);
  const maxX = Math.max(...all.map((item) => buildPlateBed(item).x), 120);
  const maxY = Math.max(...all.map((item) => buildPlateBed(item).y), 67.5);
  const gap = Math.max(35, Math.max(maxX, maxY) * 0.35);
  return {
    x: maxX + gap,
    y: maxY + gap
  };
}

function buildPlateBed(plate) {
  return {
    x: plate?.settings?.printer?.sizeX || 120,
    y: plate?.settings?.printer?.sizeY || 67.5
  };
}

function isFiniteOrigin(origin) {
  return Number.isFinite(origin?.x) && Number.isFinite(origin?.y);
}

function rectsOverlap(aOrigin, aSize, bOrigin, bSize) {
  return aOrigin.x < bOrigin.x + bSize.x
    && aOrigin.x + aSize.x > bOrigin.x
    && aOrigin.y < bOrigin.y + bSize.y
    && aOrigin.y + aSize.y > bOrigin.y;
}

function renderWorkspaceLists() {
  renderLeftTree();
}

function renderBuildPlateList() {
  renderLeftTree();
}

function renderObjectList() {
  renderLeftTree();
}

function renderLeftTree() {
  const root = $("leftTree");
  if (!root) return;
  root.innerHTML = "";
  if (!expandedPlateId || !buildPlates.some((plate) => plate.id === expandedPlateId)) {
    expandedPlateId = activePlateId || buildPlates[0]?.id || null;
  }
  buildPlates.forEach((plate, plateIndex) => {
    const plateModels = models.filter((model) => model.plateId === plate.id);
    const node = document.createElement("section");
    node.className = `plate-node${plate.id === activePlateId ? " active" : ""}`;
    node.addEventListener("dragover", (event) => {
      if (Array.from(event.dataTransfer.types).includes("application/x-resin-slicer-models")) {
        event.preventDefault();
        node.classList.add("drag-over");
      }
    });
    node.addEventListener("dragleave", () => node.classList.remove("drag-over"));
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      node.classList.remove("drag-over");
      dropModelsOnPlate(event, plate.id);
    });

    const label = document.createElement("div");
    label.className = "plate-label";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "plate-toggle";
    toggle.innerHTML = `<span class="plate-title"><strong>${plateIndex + 1}. ${escapeText(plate.name)}</strong><small>${plateModels.length} part${plateModels.length === 1 ? "" : "s"}</small></span>`;
    toggle.addEventListener("click", (event) => {
      if (event.detail > 1) return;
      expandedPlateId = expandedPlateId === plate.id ? null : plate.id;
      setActiveBuildPlate(plate.id);
      renderLeftTree();
    });
    toggle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setActiveBuildPlate(plate.id);
      centerViewOnBuildPlate(plate.id);
    });
    label.appendChild(toggle);
    if (plate.id === activePlateId) {
      const actions = document.createElement("div");
      actions.className = "plate-actions";
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "plate-action add";
      addButton.title = "Add parts to this build plate";
      addButton.textContent = "+";
      addButton.addEventListener("click", (event) => {
        event.stopPropagation();
        addPartsToBuildPlate(plate.id);
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "plate-action delete";
      deleteButton.title = "Delete this build plate";
      deleteButton.innerHTML = "&#128465;";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteBuildPlate(plate.id);
      });
      actions.append(addButton, deleteButton);
      label.appendChild(actions);
    }
    node.appendChild(label);

    if (expandedPlateId === plate.id) {
      const list = document.createElement("div");
      list.className = "part-list";
      if (!plateModels.length) {
        const empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "No parts on this build plate";
        list.appendChild(empty);
      }
      plateModels.forEach((model, modelIndex) => {
        const row = document.createElement("div");
        row.className = "part-row";
        const part = document.createElement("button");
        part.type = "button";
        part.draggable = true;
        part.className = `part-item${selectedModelIds.has(model.id) ? " selected" : ""}`;
        part.innerHTML = `${modelIndex + 1}. ${escapeText(model.name)}<small>${escapeText(fileName(model.path))}</small>`;
        part.addEventListener("click", (event) => selectModel(model.id, { additive: event.ctrlKey || event.metaKey || event.shiftKey }));
        part.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectModel(model.id, { additive: event.ctrlKey || event.metaKey || event.shiftKey });
          centerViewOnModel(model.id);
        });
        part.addEventListener("dragstart", (event) => startPartListDrag(event, model.id));
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "part-delete";
        deleteButton.title = `Delete ${model.name}`;
        deleteButton.innerHTML = "&#128465;";
        deleteButton.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteModelsById([model.id]);
        });
        row.append(part, deleteButton);
        list.appendChild(row);
      });
      node.appendChild(list);
    }

    root.appendChild(node);
  });
}

function startPartListDrag(event, modelId) {
  if (!selectedModelIds.has(modelId)) {
    selectModel(modelId);
  }
  const ids = selectedModelIds.has(modelId) ? Array.from(selectedModelIds) : [modelId];
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-resin-slicer-models", JSON.stringify(ids));
  event.dataTransfer.setData("text/plain", ids.join(","));
  playSound("drag-start");
}

function dropModelsOnPlate(event, plateId) {
  const raw = event.dataTransfer.getData("application/x-resin-slicer-models");
  if (!raw) return;
  const target = buildPlates.find((plate) => plate.id === plateId);
  if (!target) return;
  let ids = [];
  try {
    ids = JSON.parse(raw).map((id) => Number(id)).filter(Number.isFinite);
  } catch {
    return;
  }
  const moving = models.filter((model) => ids.includes(model.id));
  if (!moving.length) return;
  for (const model of moving) model.plateId = target.id;
  snapModelsToDropOffset(moving);
  activePlateId = target.id;
  expandedPlateId = target.id;
  applyBuildPlateSettingsToForm(target);
  invalidateGeneratedLayersForSelection(moving);
  selectedModelIds = new Set(moving.map((model) => model.id));
  lastSelectedModelId = moving[moving.length - 1].id;
  renderWorkspaceLists();
  updatePlacementFieldsFromSelection();
  updateScene();
  playSound("drop");
}

function deleteModelsById(ids) {
  const idSet = new Set((ids || []).map((id) => Number(id)).filter(Number.isFinite));
  if (!idSet.size) return;
  const deleting = models.filter((model) => idSet.has(model.id));
  if (!deleting.length) return;
  removeSupportStructureForModels(deleting);
  models = models.filter((model) => !idSet.has(model.id));
  selectedModelIds = new Set([...selectedModelIds].filter((id) => !idSet.has(id)));
  if (idSet.has(lastSelectedModelId)) lastSelectedModelId = null;
  normalizeLastSelectedModel();
  renderWorkspaceLists();
  updatePlacementFieldsFromSelection();
  updateScene();
  log(`Deleted ${deleting.length.toLocaleString()} part${deleting.length === 1 ? "" : "s"}.`);
  playSound("delete");
}

function deleteSelectedModels() {
  if (!selectedModelIds.size) return;
  deleteModelsById([...selectedModelIds]);
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
  $("promptClose").addEventListener("click", () => hideThemedPrompt(true));
  $("promptCancel").addEventListener("click", () => hideThemedPrompt(false));
  $("promptOverlay").addEventListener("pointerdown", (event) => {
    if (event.target === $("promptOverlay")) hideThemedPrompt(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("promptOverlay").hidden) hideThemedPrompt(false);
  });
  if (window.slicer.onAppPrompt) {
    window.slicer.onAppPrompt((payload) => showThemedPrompt(payload));
  }
}

function showThemedPrompt({ title = "Resin Slicer", message = "", detail = "", kind = "info", confirmText = "OK", cancelText = "Cancel", cancelable = false } = {}) {
  const overlay = $("promptOverlay");
  const dialog = overlay.querySelector(".prompt-dialog");
  $("promptTitle").textContent = title;
  $("promptMessage").textContent = message || "Something needs your attention.";
  $("promptIcon").textContent = kind === "error" ? "!" : "i";
  $("promptDetail").textContent = detail || "";
  $("promptDetail").hidden = !detail;
  $("promptClose").textContent = confirmText;
  $("promptCancel").textContent = cancelText;
  $("promptCancel").hidden = !cancelable;
  dialog.classList.toggle("error", kind === "error");
  dialog.classList.toggle("warning", kind === "warning");
  overlay.hidden = false;
  $("promptClose").focus();
  playSound(kind === "error" ? "error" : kind === "warning" ? "warning" : "modal-open");
}

function hideThemedPrompt(result = true) {
  $("promptOverlay").hidden = true;
  $("promptClose").textContent = "OK";
  $("promptCancel").hidden = true;
  if (themedPromptResolver) {
    const resolver = themedPromptResolver;
    themedPromptResolver = null;
    resolver(result);
  }
  playSound("modal-close");
}

function showThemedConfirm(options = {}) {
  return new Promise((resolve) => {
    themedPromptResolver = resolve;
    showThemedPrompt({ ...options, cancelable: true });
  });
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

async function browseMachineProfile() {
  hideUvtoolsDialog();
  await importProfile("machine");
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
    await offerSaveImportedMachineProfile(printer.name);
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
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      selectAllModels();
      return;
    }
    if (!isEditableTarget(event.target) && (event.ctrlKey || event.metaKey) && key === "c") {
      event.preventDefault();
      event.stopPropagation();
      copySelectedParts();
      return;
    }
    if (!isEditableTarget(event.target) && (event.ctrlKey || event.metaKey) && key === "v") {
      event.preventDefault();
      event.stopPropagation();
      pasteCopiedParts();
      return;
    }
    if (!isEditableTarget(event.target) && event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      deleteSelectedModels();
    }
  }, true);
}

function isEditableTarget(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || !!target?.isContentEditable;
}

function selectAllModels() {
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection) selection.removeAllRanges();
  selectedModelIds = new Set(models.map((model) => model.id));
  lastSelectedModelId = models[models.length - 1]?.id || null;
  updateScene();
  if (models.length) {
    $("meshStatus").textContent = `${models.length.toLocaleString()} model${models.length === 1 ? "" : "s"} selected`;
    playSound("focus-ring");
  }
}

function copySelectedParts() {
  const selection = selectedModels();
  if (!selection.length) return;
  const centers = selection.map((model) => boundsCenter(modelWorldBounds(model)));
  const groupCenter = centers.reduce((sum, center) => add(sum, center), [0, 0, 0]).map((value) => value / centers.length);
  partClipboard = selection.map((model, index) => {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    const center = centers[index];
    return {
      path: model.path,
      name: model.name,
      mesh: model.mesh,
      transform: cloneSettings(model.transform),
      relativeCenter: sub(center, groupCenter),
      sourceCenterLocal: plate ? [center[0] - plate.origin.x, center[1] - plate.origin.y, center[2]] : center,
      supports: collectSupportStructureForModel(model)
    };
  });
  log(`Copied ${partClipboard.length.toLocaleString()} part${partClipboard.length === 1 ? "" : "s"}.`);
  playSound("focus-ring");
}

function pasteCopiedParts() {
  if (!partClipboard.length) return;
  ensureInitialBuildPlate();
  const targetPlate = highlightedBuildPlate() || activePlate();
  const targetCenter = [
    targetPlate.origin.x + (targetPlate.settings.printer.sizeX || 120) / 2,
    targetPlate.origin.y + (targetPlate.settings.printer.sizeY || 67.5) / 2,
    0
  ];
  const pastedModels = partClipboard.map((item) => ({
    id: nextModelId++,
    path: item.path,
    name: item.name,
    mesh: item.mesh,
    plateId: targetPlate.id,
    transform: cloneSettings(item.transform),
    dropAnimation: startDropAnimation()
  }));
  let copiedSupportStructure = false;
  for (let index = 0; index < pastedModels.length; index++) {
    const model = pastedModels[index];
    const desiredCenter = add(targetCenter, partClipboard[index].relativeCenter || [0, 0, 0]);
    const local = modelLocalCentroid(model);
    model.transform.translateX = desiredCenter[0] - targetPlate.origin.x - local[0];
    model.transform.translateY = desiredCenter[1] - targetPlate.origin.y - local[1];
    copiedSupportStructure = copySupportStructureToPlate(partClipboard[index], model, targetPlate) || copiedSupportStructure;
  }
  targetPlate.layersGenerated = copiedSupportStructure;
  models.push(...pastedModels);
  activePlateId = targetPlate.id;
  expandedPlateId = targetPlate.id;
  selectedModelIds = new Set(pastedModels.map((model) => model.id));
  lastSelectedModelId = pastedModels[pastedModels.length - 1]?.id || lastSelectedModelId;
  applyBuildPlateSettingsToForm(targetPlate);
  animateModelDrop(pastedModels);
  renderWorkspaceLists();
  updatePlacementFieldsFromSelection();
  updateScene();
  log(`Pasted ${pastedModels.length.toLocaleString()} part${pastedModels.length === 1 ? "" : "s"} onto ${targetPlate.name}.`);
  playSound("drop");
}

function highlightedBuildPlate() {
  const hit = viewer?.hoveredHit;
  const id = hit?.type === "plate-action" ? hit.plateId : hit?.type === "plate" ? hit.id : null;
  return id ? buildPlates.find((plate) => plate.id === id) || null : null;
}

function selectModel(modelId, { additive = false, preserveExisting = false } = {}) {
  const model = models.find((item) => item.id === modelId);
  if (!model) return;
  if (model.plateId !== activePlateId) {
    setActiveBuildPlate(model.plateId, { sound: false });
  }
  expandedPlateId = model.plateId;
  if (preserveExisting && selectedModelIds.has(modelId) && !additive) {
    // Keep the group selection intact when beginning a drag from one selected model.
  } else if (additive) {
    if (selectedModelIds.has(modelId)) {
      selectedModelIds.delete(modelId);
      if (lastSelectedModelId === modelId) lastSelectedModelId = null;
    } else {
      selectedModelIds.add(modelId);
      lastSelectedModelId = modelId;
    }
  } else {
    selectedModelIds = new Set([modelId]);
    lastSelectedModelId = modelId;
  }
  normalizeLastSelectedModel();
  updatePlacementFieldsFromSelection();
  renderWorkspaceLists();
  updateScene();
  playSound("focus-ring");
}

function clearModelSelection({ renderListsNow = true, updateSceneNow = true } = {}) {
  if (!selectedModelIds.size && !lastSelectedModelId) return false;
  selectedModelIds = new Set();
  lastSelectedModelId = null;
  if (renderListsNow) renderWorkspaceLists();
  if (updateSceneNow) updateScene();
  return true;
}

function handleScenePick(hit) {
  if (!hit) return;
  if (hit.type === "model") {
    selectModel(hit.id, { additive: hit.additive, preserveExisting: hit.dragStart });
  } else if (hit.type === "plate-action") {
    setActiveBuildPlate(hit.plateId);
    if (hit.action === "add") addPartsToBuildPlate(hit.plateId);
    if (hit.action === "delete") deleteBuildPlate(hit.plateId);
  } else if (hit.type === "plate") {
    const clickedActivePlate = hit.id === activePlateId;
    const clearedSelection = clearModelSelection({ renderListsNow: false, updateSceneNow: false });
    setActiveBuildPlate(hit.id);
    if (clickedActivePlate && clearedSelection) {
      renderWorkspaceLists();
      updateScene();
    }
  } else if (hit.type === "add-plate") {
    addBuildPlate();
  } else if (hit.type === "background") {
    clearModelSelection();
  }
}

function handleSceneDoubleClick(hit) {
  if (!hit) return;
  if (hit.type === "model") {
    selectModel(hit.id);
    centerViewOnModel(hit.id);
  } else if (hit.type === "plate") {
    setActiveBuildPlate(hit.id);
    centerViewOnBuildPlate(hit.id);
  } else if (hit.type === "plate-action") {
    setActiveBuildPlate(hit.plateId);
    centerViewOnBuildPlate(hit.plateId);
  }
}

function centerViewOnBuildPlate(plateId) {
  const plate = buildPlates.find((item) => item.id === plateId);
  if (!plate) return;
  viewer.centerOnBuildPlate(plate);
}

function centerViewOnModel(modelId) {
  const model = models.find((item) => item.id === modelId);
  if (!model) return;
  viewer.centerOnBounds(modelWorldBounds(model));
}

function handleModelDrag(drag) {
  const selection = selectedModels();
  if (!selection.length) return;
  if (!dragState) {
    dragState = {
      type: "move-xy",
      totalAngleDeg: 0,
      snapshots: new Map(selection.map((m) => [m.id, {
        translateX: m.transform.translateX,
        translateY: m.transform.translateY
      }]))
    };
  }
  for (const model of selection) {
    model.transform.translateX += drag.x;
    model.transform.translateY += drag.y;
    maybeMoveModelToPlateByCentroid(model);
  }
  requestSceneUpdate({ renderLists: false, updateStatus: false, skipDerivedGeometry: true });
}

function handleModelDragEnd() {
  const selection = selectedModels();
  if (!selection.length) return;
  snapModelsToDropOffset(selection);
  const state = dragState;
  dragState = null;
  if (state?.type === "move-xy") {
    for (const model of selection) {
      const plate = buildPlates.find((p) => p.id === model.plateId);
      const snap = state.snapshots?.get(model.id);
      if (!plate || !snap || (!plate.supports?.length && !plate.supportBraces?.length)) continue;
      const dx = model.transform.translateX - snap.translateX;
      const dy = model.transform.translateY - snap.translateY;
      if (dx === 0 && dy === 0) continue;
      const cur = expandedModelPlateBounds(model, plate, 2.5);
      const oldBounds = { minX: cur.minX - dx, maxX: cur.maxX - dx, minY: cur.minY - dy, maxY: cur.maxY - dy, minZ: cur.minZ, maxZ: cur.maxZ };
      plate.supports = plate.supports.map((s) => supportInsidePlateBounds(s, oldBounds) ? translateSupport(s, dx, dy) : s);
      plate.supportBraces = plate.supportBraces.map((b) => braceInsidePlateBounds(b, oldBounds) ? translateBrace(b, dx, dy) : b);
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  } else if (state?.type === "rotate-z") {
    const angleRad = (state.totalAngleDeg ?? 0) * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    for (const model of selection) {
      const plate = buildPlates.find((p) => p.id === model.plateId);
      const snap = state.snapshots?.get(model.id);
      if (!plate || !snap || (!plate.supports?.length && !plate.supportBraces?.length)) continue;
      const savedRX = model.transform.rotateX, savedRY = model.transform.rotateY, savedRZ = model.transform.rotateZ;
      model.transform.rotateX = snap.rotateX ?? savedRX;
      model.transform.rotateY = snap.rotateY ?? savedRY;
      model.transform.rotateZ = snap.rotateZ ?? savedRZ;
      model.renderMesh = null;
      const oldBounds = expandedModelPlateBounds(model, plate, 2.5);
      const [cx, cy] = snap.plateCenter ?? modelPlateCenter(model, plate);
      model.transform.rotateX = savedRX;
      model.transform.rotateY = savedRY;
      model.transform.rotateZ = savedRZ;
      model.renderMesh = null;
      plate.supports = plate.supports.map((s) => supportInsidePlateBounds(s, oldBounds) ? rotateSupportAround(s, cx, cy, cos, sin) : s);
      plate.supportBraces = plate.supportBraces.map((b) => braceInsidePlateBounds(b, oldBounds) ? rotateBraceAround(b, cx, cy, cos, sin) : b);
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  } else {
    removeSupportStructureForModels(selection);
    invalidateGeneratedLayersForSelection(selection);
  }
  updatePlacementFieldsFromSelection();
  renderWorkspaceLists();
  updateScene();
}

function handleGizmoDragEnd() {
  const selection = selectedModels();
  if (!selection.length) return;
  handleModelDragEnd();
}

function handleGizmoDrag(drag) {
  const selection = selectedModels();
  if (!selection.length) return;
  const planeDelta = viewer.screenDeltaToBuildPlane(drag.dx, drag.dy);
  const zDelta = -drag.dy * Math.max(0.02, viewer.distance * 0.0015);
  const translatesModel = drag.action.startsWith("move-");
  const rotatesModel = drag.action.startsWith("rotate-");
  const rotationDelta = rotatesModel ? viewer.gizmoRotationDelta(drag) : 0;
  if (!dragState) {
    const isXYOnly = drag.action === "move-x" || drag.action === "move-y" || drag.action === "move-xy";
    const isZRotOnly = drag.action === "rotate-z";
    const type = isXYOnly ? "move-xy" : (isZRotOnly ? "rotate-z" : "other");
    dragState = {
      type,
      totalAngleDeg: 0,
      snapshots: new Map(selection.map((m) => {
        const plate = buildPlates.find((p) => p.id === m.plateId);
        return [m.id, {
          translateX: m.transform.translateX,
          translateY: m.transform.translateY,
          rotateX: m.transform.rotateX,
          rotateY: m.transform.rotateY,
          rotateZ: m.transform.rotateZ,
          plateCenter: plate ? modelPlateCenter(m, plate) : [0, 0, 0]
        }];
      }))
    };
  }
  for (const model of selection) {
    if (drag.action === "move-x") model.transform.translateX += planeDelta.x;
    if (drag.action === "move-y") model.transform.translateY += planeDelta.y;
    if (drag.action === "move-z") model.transform.translateZ += zDelta;
    if (drag.action === "move-xy") {
      model.transform.translateX += planeDelta.x;
      model.transform.translateY += planeDelta.y;
    }
    if (drag.action === "move-xz") {
      model.transform.translateX += planeDelta.x;
      model.transform.translateZ += zDelta;
    }
    if (drag.action === "move-yz") {
      model.transform.translateY += planeDelta.y;
      model.transform.translateZ += zDelta;
    }
    if (drag.action === "rotate-x") applyGlobalRotationToTransform(model.transform, "x", rotationDelta);
    if (drag.action === "rotate-y") applyGlobalRotationToTransform(model.transform, "y", -rotationDelta);
    if (drag.action === "rotate-z") applyGlobalRotationToTransform(model.transform, "z", rotationDelta);
    if (translatesModel) maybeMoveModelToPlateByCentroid(model);
  }
  if (drag.action === "rotate-z" && dragState?.type === "rotate-z") {
    dragState.totalAngleDeg += rotationDelta;
  }
  requestSceneUpdate({ renderLists: false, updateStatus: false, skipDerivedGeometry: true });
}

function selectedModels() {
  return models.filter((model) => selectedModelIds.has(model.id));
}

function snapSelectedModelsToDropOffset() {
  const selection = selectedModels();
  if (!selection.length) return false;
  snapModelsToDropOffset(selection);
  invalidateGeneratedLayersForSelection(selection);
  renderWorkspaceLists();
  return true;
}

function snapModelsToDropOffset(items) {
  for (const model of items) dropModelToBuildPlate(model, { exact: true });
}

function normalizeLastSelectedModel() {
  if (lastSelectedModelId && selectedModelIds.has(lastSelectedModelId)) return;
  lastSelectedModelId = [...selectedModelIds].pop() || null;
}

function widgetModel() {
  normalizeLastSelectedModel();
  return lastSelectedModelId ? models.find((model) => model.id === lastSelectedModelId) || null : null;
}

function applyPlacementFieldToSelected(fieldId) {
  const selection = selectedModels();
  if (!selection.length) return;
  const key = placementKey(fieldId);
  const displayValue = roundPlacementValue(number(fieldId));
  const value = translationPlacementFields.has(fieldId)
    ? roundPlacementValue(placementDisplayToMm(displayValue))
    : displayValue;
  $(fieldId).value = formatPlacementValue(displayValue);
  const rotatesModel = key === "rotateX" || key === "rotateY" || key === "rotateZ";
  const transformsModel = key === "translateX"
    || key === "translateY"
    || key === "translateZ"
    || key === "scale"
    || rotatesModel;
  const priorTransforms = new Map(selection.map((m) => [m.id, {
    translateX: m.transform.translateX,
    translateY: m.transform.translateY,
    rotateX: m.transform.rotateX,
    rotateY: m.transform.rotateY,
    rotateZ: m.transform.rotateZ
  }]));
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
  if (transformsModel) snapModelsToDropOffset(selection);
  const isXYTranslate = key === "translateX" || key === "translateY";
  const isZRotate = key === "rotateZ";
  if (isXYTranslate) {
    for (const model of selection) {
      const plate = buildPlates.find((p) => p.id === model.plateId);
      const prior = priorTransforms.get(model.id);
      if (!plate || !prior || (!plate.supports?.length && !plate.supportBraces?.length)) continue;
      const dx = key === "translateX" ? value - prior.translateX : 0;
      const dy = key === "translateY" ? value - prior.translateY : 0;
      if (dx === 0 && dy === 0) continue;
      const cur = expandedModelPlateBounds(model, plate, 2.5);
      const oldBounds = { minX: cur.minX - dx, maxX: cur.maxX - dx, minY: cur.minY - dy, maxY: cur.maxY - dy, minZ: cur.minZ, maxZ: cur.maxZ };
      plate.supports = plate.supports.map((s) => supportInsidePlateBounds(s, oldBounds) ? translateSupport(s, dx, dy) : s);
      plate.supportBraces = plate.supportBraces.map((b) => braceInsidePlateBounds(b, oldBounds) ? translateBrace(b, dx, dy) : b);
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  } else if (isZRotate) {
    for (const model of selection) {
      const plate = buildPlates.find((p) => p.id === model.plateId);
      const prior = priorTransforms.get(model.id);
      if (!plate || !prior || (!plate.supports?.length && !plate.supportBraces?.length)) continue;
      const dAngleDeg = value - prior.rotateZ;
      if (Math.abs(dAngleDeg) < 0.0001) continue;
      const savedRX = model.transform.rotateX, savedRY = model.transform.rotateY, savedRZ = model.transform.rotateZ;
      model.transform.rotateX = prior.rotateX;
      model.transform.rotateY = prior.rotateY;
      model.transform.rotateZ = prior.rotateZ;
      model.renderMesh = null;
      const oldBounds = expandedModelPlateBounds(model, plate, 2.5);
      const center = modelPlateCenter(model, plate);
      model.transform.rotateX = savedRX;
      model.transform.rotateY = savedRY;
      model.transform.rotateZ = savedRZ;
      model.renderMesh = null;
      const cos = Math.cos(dAngleDeg * Math.PI / 180);
      const sin = Math.sin(dAngleDeg * Math.PI / 180);
      plate.supports = plate.supports.map((s) => supportInsidePlateBounds(s, oldBounds) ? rotateSupportAround(s, center[0], center[1], cos, sin) : s);
      plate.supportBraces = plate.supportBraces.map((b) => braceInsidePlateBounds(b, oldBounds) ? rotateBraceAround(b, center[0], center[1], cos, sin) : b);
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  } else if (transformsModel) {
    for (const model of selection) {
      const plate = buildPlates.find((p) => p.id === model.plateId);
      const prior = priorTransforms.get(model.id);
      if (!plate || !prior) continue;
      const savedTX = model.transform.translateX, savedTY = model.transform.translateY;
      const savedRX = model.transform.rotateX, savedRY = model.transform.rotateY, savedRZ = model.transform.rotateZ;
      const savedScale = model.transform.scale;
      model.transform.translateX = prior.translateX;
      model.transform.translateY = prior.translateY;
      model.transform.rotateX = prior.rotateX;
      model.transform.rotateY = prior.rotateY;
      model.transform.rotateZ = prior.rotateZ;
      model.renderMesh = null;
      removeSupportStructureForModels([model]);
      model.transform.translateX = savedTX;
      model.transform.translateY = savedTY;
      model.transform.rotateX = savedRX;
      model.transform.rotateY = savedRY;
      model.transform.rotateZ = savedRZ;
      model.transform.scale = savedScale;
      model.renderMesh = null;
    }
    invalidateGeneratedLayersForSelection(selection);
  }
  renderWorkspaceLists();
  if (transformsModel) updatePlacementFieldsFromSelection();
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
  $("rotateX").value = formatPlacementValue(model.transform.rotateX);
  $("rotateY").value = formatPlacementValue(model.transform.rotateY);
  $("rotateZ").value = formatPlacementValue(model.transform.rotateZ);
  $("translateX").value = formatPlacementValue(placementMmToDisplay(model.transform.translateX));
  $("translateY").value = formatPlacementValue(placementMmToDisplay(model.transform.translateY));
  $("translateZ").value = formatPlacementValue(placementMmToDisplay(model.transform.translateZ));
  $("scale").value = formatPlacementValue(model.transform.scale);
  syncSceneSettingCommits();
}

function invalidateGeneratedLayersForSelection(selection) {
  for (const model of selection) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    if (plate) {
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  }
}

function collectSupportStructureForModel(model) {
  const plate = buildPlates.find((item) => item.id === model.plateId);
  if (!plate) return { supports: [], braces: [] };
  const bounds = expandedModelPlateBounds(model, plate, 2.5);
  return {
    supports: (plate.supports || []).filter((support) => supportInsidePlateBounds(support, bounds)).map(cloneSettings),
    braces: (plate.supportBraces || []).filter((brace) => braceInsidePlateBounds(brace, bounds)).map(cloneSettings)
  };
}

function copySupportStructureToPlate(snapshot, model, targetPlate) {
  const structure = snapshot?.supports;
  if (!structure || (!structure.supports?.length && !structure.braces?.length)) return false;
  const newCenter = modelPlateCenter(model, targetPlate);
  const oldCenter = snapshot.sourceCenterLocal || [newCenter[0], newCenter[1], newCenter[2]];
  const dx = newCenter[0] - oldCenter[0];
  const dy = newCenter[1] - oldCenter[1];
  const copiedSupports = (structure.supports || []).map((support) => translateSupport(support, dx, dy));
  const copiedBraces = (structure.braces || []).map((brace) => translateBrace(brace, dx, dy));
  targetPlate.supports = [...(targetPlate.supports || []), ...copiedSupports];
  targetPlate.supportBraces = [...(targetPlate.supportBraces || []), ...copiedBraces];
  return !!(copiedSupports.length || copiedBraces.length);
}

function removeSupportStructureForModels(selection) {
  const byPlate = new Map();
  for (const model of selection) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    if (!plate) continue;
    if (!byPlate.has(plate.id)) byPlate.set(plate.id, { plate, bounds: [] });
    byPlate.get(plate.id).bounds.push(expandedModelPlateBounds(model, plate, 2.5));
  }
  for (const { plate, bounds } of byPlate.values()) {
    const beforeSupports = plate.supports?.length || 0;
    const beforeBraces = plate.supportBraces?.length || 0;
    plate.supports = (plate.supports || []).filter((support) => !bounds.some((box) => supportInsidePlateBounds(support, box)));
    plate.supportBraces = (plate.supportBraces || []).filter((brace) => !bounds.some((box) => braceInsidePlateBounds(brace, box)));
    if (beforeSupports !== plate.supports.length || beforeBraces !== plate.supportBraces.length) {
      plate.layersGenerated = false;
      plate.supportRaft = null;
    }
  }
}

function expandedModelPlateBounds(model, plate, margin = 0) {
  const bounds = modelWorldBounds(model);
  return {
    minX: bounds.minX - plate.origin.x - margin,
    minY: bounds.minY - plate.origin.y - margin,
    minZ: bounds.minZ - margin,
    maxX: bounds.maxX - plate.origin.x + margin,
    maxY: bounds.maxY - plate.origin.y + margin,
    maxZ: bounds.maxZ + margin
  };
}

function modelPlateCenter(model, plate = buildPlates.find((item) => item.id === model.plateId)) {
  const center = boundsCenter(modelWorldBounds(model));
  return plate ? [center[0] - plate.origin.x, center[1] - plate.origin.y, center[2]] : center;
}

function supportInsidePlateBounds(support, bounds) {
  return pointInsideBounds2d(support.x, support.y, bounds)
    || pointInsideBounds2d(support.baseX, support.baseY, bounds)
    || pointInsideBounds2d(support.jointX, support.jointY, bounds);
}

function braceInsidePlateBounds(brace, bounds) {
  return pointInsideBounds2d(brace.x0, brace.y0, bounds) || pointInsideBounds2d(brace.x1, brace.y1, bounds);
}

function pointInsideBounds2d(x, y, bounds) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY;
}

function translateSupport(support, dx, dy) {
  return {
    ...cloneSettings(support),
    x: translateCoord(support.x, dx),
    y: translateCoord(support.y, dy),
    baseX: translateCoord(support.baseX ?? support.x, dx),
    baseY: translateCoord(support.baseY ?? support.y, dy),
    jointX: translateCoord(support.jointX ?? support.x, dx),
    jointY: translateCoord(support.jointY ?? support.y, dy)
  };
}

function translateBrace(brace, dx, dy) {
  return {
    ...cloneSettings(brace),
    x0: translateCoord(brace.x0, dx),
    y0: translateCoord(brace.y0, dy),
    x1: translateCoord(brace.x1, dx),
    y1: translateCoord(brace.y1, dy)
  };
}

function translateCoord(value, delta) {
  return Number.isFinite(value) ? value + delta : value;
}

function rotatePoint2d(x, y, cx, cy, cos, sin) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x, y };
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function rotateSupportAround(support, cx, cy, cos, sin) {
  const tip = rotatePoint2d(support.x, support.y, cx, cy, cos, sin);
  const base = rotatePoint2d(support.baseX ?? support.x, support.baseY ?? support.y, cx, cy, cos, sin);
  const joint = rotatePoint2d(support.jointX ?? support.x, support.jointY ?? support.y, cx, cy, cos, sin);
  return { ...cloneSettings(support), x: tip.x, y: tip.y, baseX: base.x, baseY: base.y, jointX: joint.x, jointY: joint.y };
}

function rotateBraceAround(brace, cx, cy, cos, sin) {
  const p0 = rotatePoint2d(brace.x0, brace.y0, cx, cy, cos, sin);
  const p1 = rotatePoint2d(brace.x1, brace.y1, cx, cy, cos, sin);
  return { ...cloneSettings(brace), x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
}

function maybeMoveModelToPlateByCentroid(model) {
  const currentPlate = buildPlates.find((plate) => plate.id === model.plateId);
  if (!currentPlate) return;
  const centroid = boundsCenter(modelWorldBounds(model));
  const destination = buildPlates.find((plate) => pointInsidePlate(centroid, plate));
  if (!destination || destination.id === model.plateId) return;

  currentPlate.layersGenerated = false;
  currentPlate.supportRaft = null;
  destination.layersGenerated = false;
  destination.supportRaft = null;
  model.plateId = destination.id;
  model.transform.translateX = centroid[0] - destination.origin.x - modelLocalCentroid(model)[0];
  model.transform.translateY = centroid[1] - destination.origin.y - modelLocalCentroid(model)[1];
  activePlateId = destination.id;
  expandedPlateId = destination.id;
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
  snapModelsToDropOffset(selection);
  expandedPlateId = plate.id;
  renderWorkspaceLists();
  updateScene();
  playSound("drop");
}

async function openStl() {
  try {
    playSound("click-soft");
    const targetPlateId = activePlate().id;
    const paths = await window.slicer.openStl();
    if (!paths || !paths.length) {
      log("Open mesh canceled.");
      return;
    }
    await loadStlPaths(paths, { append: true, targetPlateId });
  } catch (error) {
    log(`Open mesh failed: ${error.message}`);
    showErrorPrompt("Open Mesh Failed", error);
  }
}

async function loadStlPaths(paths, { append = false, sound = append ? "drop" : "confirm", targetPlateId = activePlate().id } = {}) {
  ensureInitialBuildPlate();
  const initialTargetPlate = buildPlates.find((plate) => plate.id === targetPlateId) || activePlate();
  const resolvedTargetPlateId = initialTargetPlate.id;
  const nextPaths = normalizeStlPaths(paths);
  if (!nextPaths.length) {
    logAndPrompt("No Mesh Files", "Choose or drop at least one STL, OBJ, STP, or STEP file.");
    return;
  }

  const importJobId = nextImportJobId++;
  latestImportJobId = importJobId;
  const shouldReplace = !append && importJobId === latestImportJobId;
  if (shouldReplace) {
    models = [];
    selectedModelIds = new Set();
    lastSelectedModelId = null;
    for (const plate of buildPlates) {
      plate.supports = [];
      plate.supportBraces = [];
      plate.supportRaft = null;
      plate.layersGenerated = false;
    }
    $("outputPath").value = "";
    renderWorkspaceLists();
    updateScene();
  }

  const results = await Promise.allSettled(nextPaths.map((path) => loadSingleMeshPath(path, {
    importJobId,
    append,
    sound,
    targetPlateId: resolvedTargetPlateId
  })));
  const loadedCount = results.filter((result) => result.status === "fulfilled" && result.value).length;
  if (loadedCount > 1) {
    const destinationPlate = buildPlates.find((plate) => plate.id === resolvedTargetPlateId) || activePlate();
    log(`Loaded ${loadedCount.toLocaleString()} mesh files on ${destinationPlate.name}.`);
  }
}

async function loadSingleMeshPath(path, { importJobId, append, sound, targetPlateId }) {
  const progress = createLoadProgressItem(path);
  const readJobId = `mesh-read-${progress.id}`;
  try {
    updateLoadProgressItem(progress.id, 0.02, "Queued");
    fileReadProgressHandlers.set(readJobId, (message) => {
      const percent = Math.round((message.progress || 0) * 100);
      updateLoadProgressItem(progress.id, 0.04 + (message.progress || 0) * 0.68, `Reading ${percent}%`);
    });
    log(`Loading ${path}`);
    let raw;
    if (isStepMeshPath(path)) {
      updateLoadProgressItem(progress.id, 0.08, "Tessellating STEP");
      raw = await window.slicer.readStepMesh(path);
    } else {
      raw = window.slicer.readFileProgress
        ? await window.slicer.readFileProgress(path, readJobId)
        : await window.slicer.readFile(path);
    }
    fileReadProgressHandlers.delete(readJobId);

    updateLoadProgressItem(progress.id, 0.78, "Parsing");
    await nextFrame();
    const bytes = new Uint8Array(raw);
    const mesh = parseMesh(path, bytes);
    updateLoadProgressItem(progress.id, 0.92, "Adding");

    if (!append && importJobId !== latestImportJobId) {
      updateLoadProgressItem(progress.id, 1, "Skipped");
      scheduleLoadProgressRemoval(progress.id);
      return null;
    }

    const model = {
      id: nextModelId++,
      path,
      name: fileName(path),
      mesh,
      plateId: targetPlateId,
      transform: defaultModelTransform(),
      dropAnimation: startDropAnimation()
    };
    const committed = commitLoadedModel(model, { importJobId, targetPlateId });
    updateLoadProgressItem(progress.id, 1, committed ? "Loaded" : "Skipped");
    scheduleLoadProgressRemoval(progress.id);
    if (committed) {
      log(`Loaded ${fileName(path)} (${mesh.triangleCount.toLocaleString()} triangles)`);
      if (sound) playSound(sound);
    }
    return committed ? model : null;
  } catch (error) {
    fileReadProgressHandlers.delete(readJobId);
    updateLoadProgressItem(progress.id, 1, "Failed");
    log(`Load failed for ${fileName(path)}: ${error.message}`);
    showErrorPrompt("Mesh Load Failed", error);
    scheduleLoadProgressRemoval(progress.id, 4200);
    return null;
  }
}

function commitLoadedModel(model, { importJobId, targetPlateId }) {
  const destinationPlate = buildPlates.find((plate) => plate.id === targetPlateId) || activePlate();
  if (!destinationPlate) return false;
  model.plateId = destinationPlate.id;
  placeNewModelOnPlate(model, destinationPlate);
  models.push(model);
  destinationPlate.layersGenerated = false;
  destinationPlate.supportRaft = null;

  if (importJobId === latestImportJobId) {
    activePlateId = destinationPlate.id;
    expandedPlateId = destinationPlate.id;
    applyBuildPlateSettingsToForm(destinationPlate);
    selectedModelIds.add(model.id);
    lastSelectedModelId = model.id;
  } else {
    selectedModelIds = new Set([...selectedModelIds].filter((id) => models.some((item) => item.id === id)));
    normalizeLastSelectedModel();
  }

  setDefaultOutput();
  updateMeshStatusFromModels();
  $("supportStatus").textContent = "Supports not generated";
  renderWorkspaceLists();
  updatePlacementFieldsFromSelection();
  updateScene();
  animateModelDrop([model]);
  return true;
}

function updateMeshStatusFromModels() {
  const triangleCount = models.reduce((sum, item) => sum + item.mesh.triangleCount, 0);
  $("meshStatus").textContent = `${models.length.toLocaleString()} mesh${models.length === 1 ? "" : "es"}, ${triangleCount.toLocaleString()} triangles`;
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

async function saveProject() {
  try {
    writeActivePlateSettingsFromForm();
    playSound("click-soft");
    const content = JSON.stringify(buildProjectSnapshot(), null, 2);
    const path = await window.slicer.saveProject(projectFileName(), content);
    if (!path) {
      log("Save project canceled.");
      return;
    }
    log(`Saved project: ${path}`);
    playSound("save");
  } catch (error) {
    log(`Save project failed: ${error.message}`);
    showErrorPrompt("Save Project Failed", error);
  }
}

function buildProjectSnapshot() {
  return {
    schema: "resin-slicer-project",
    version: 1,
    savedAt: new Date().toISOString(),
    format: $("format").value,
    outputPath: $("outputPath").value.trim(),
    activePlateId,
    expandedPlateId,
    nextBuildPlateId,
    nextModelId,
    selectedModelIds: [...selectedModelIds],
    lastSelectedModelId,
    buildPlates: buildPlates.map((plate) => ({
      id: plate.id,
      name: plate.name,
      origin: cloneSettings(plate.origin),
      layoutSlot: plate.layoutSlot,
      clipHeight: plate.clipHeight,
      clipEnabled: !!plate.clipEnabled,
      layersGenerated: !!plate.layersGenerated,
      settings: cloneSettings(plate.settings),
      supports: cloneSettings(plate.supports || []),
      supportBraces: cloneSettings(plate.supportBraces || []),
      supportRaft: cloneSettings(plate.supportRaft || null)
    })),
    models: models.map((model) => ({
      id: model.id,
      plateId: model.plateId,
      name: model.name,
      path: model.path,
      transform: cloneSettings(model.transform)
    }))
  };
}

function projectFileName() {
  const outputPath = $("outputPath").value.trim();
  if (outputPath) return `${safeFileStem(fileName(outputPath).replace(/\.[^.]+$/, ""))}-project.json`;
  if (models.length) return `${safeFileStem(fileName(models[0].path).replace(/\.[^.]+$/, ""))}-project.json`;
  return "resin-slicer-project.json";
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
      updateExternalDropHover(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
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
      if (eventName === "dragleave") viewer.setHoverHit(null);
      if (shell) shell.classList.remove("drag-over");
    });
  }
}

function updateExternalDropHover(event) {
  if (!viewer) return;
  const hit = viewer.hitAt(event.clientX, event.clientY, { skipModels: true });
  if (hit?.type === "plate") {
    viewer.setHoverHit(hit);
  } else if (hit?.type === "plate-action") {
    viewer.setHoverHit({ type: "plate", id: hit.plateId });
  } else {
    viewer.setHoverHit(null);
  }
}

async function handleDrop(event) {
  const hit = viewer.hitAt(event.clientX, event.clientY, { skipModels: true });
  const dropPlateId = hit?.type === "plate-action" ? hit.plateId : hit?.type === "plate" ? hit.id : null;
  const targetPlateId = dropPlateId || activePlate().id;
  if (dropPlateId && dropPlateId !== activePlateId) {
    setActiveBuildPlate(dropPlateId, { sound: false });
  }
  viewer.setHoverHit(null);
  const files = Array.from(event.dataTransfer?.files || []);
  const paths = files
    .map((file) => window.slicer.pathForFile ? window.slicer.pathForFile(file) : file.path)
    .filter(isSupportedMeshPath);
  if (!paths.length) {
    logAndPrompt("Unsupported Drop", "Drop one or more STL, OBJ, STP, or STEP files into the viewer.");
    return;
  }
  await loadStlPaths(paths, { append: true, sound: "drop", targetPlateId });
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
  return /\.(stl|obj|stp|step)$/i.test(path || "");
}

function isStepMeshPath(path) {
  return /\.(stp|step)$/i.test(path || "");
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
    if (kind === "machine") {
      await offerSaveImportedMachineProfile($("machineName").value.trim() || fileName(file.path));
    } else if (kind === "resin") {
      await offerSaveImportedResinProfile($("resinName").value.trim() || fileName(file.path));
    }
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
  isGeneratingSupports = true;
  $("supportStatus").textContent = `Generating supports for ${plate.name}...`;
  log(`Generating supports for ${plate.name}...`);

  // Show supports as the Python analysis emits them, throttled so we are not
  // rebuilding the scene geometry on every single anchor.
  const streamed = [];
  let pendingRender = false;
  let lastRenderAt = 0;
  const flushStreamed = () => {
    pendingRender = false;
    lastRenderAt = performance.now();
    // Suppress any late-firing throttled render once generation has finished
    // (the authoritative result has already been rendered by then).
    if (!isGeneratingSupports || activePlate().id !== plate.id) return;
    plate.supports = streamed.slice();
    $("supportStatus").textContent = `Generating supports for ${plate.name}... ${streamed.length.toLocaleString()}`;
    updateScene();
  };
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    const wait = Math.max(0, 120 - (performance.now() - lastRenderAt));
    setTimeout(() => {
      if (pendingRender) flushStreamed();
    }, wait);
  };
  const stopListening = window.slicer.onPreviewProgress((message) => {
    if (!message) return;
    if (message.type === "support" && message.support) {
      streamed.push(message.support);
      scheduleRender();
    } else if (message.type === "progress" && message.message) {
      if (!streamed.length) $("supportStatus").textContent = `Generating supports for ${plate.name}...`;
    }
  });

  try {
    plate.supports = [];
    plate.supportBraces = [];
    plate.supportRaft = null;
    const result = await window.slicer.preview(collectPayloadForPlate(plate));
    plate.supports = result.supports || [];
    plate.supportBraces = result.braces || [];
    plate.supportRaft = result.raft || null;
    plate.layersGenerated = true;
    $("supportStatus").textContent = `${plate.supports.length.toLocaleString()} supports generated`;
    updateScene();
    log(`Generated ${plate.name}: ${result.layers} layers, ${plate.supports.length} supports, ${plate.supportBraces.length} braces`);
    playSound("success");
  } catch (error) {
    $("supportStatus").textContent = "Support generation failed";
    log(`Generate supports failed: ${error.message}`);
    showErrorPrompt("Generate Supports Failed", error);
  } finally {
    stopListening();
    isGeneratingSupports = false;
    setBusy(false);
  }
}

async function slice() {
  if (!ensureReady(true, true)) return;
  await slicePlates([activePlate()], { forceSuffix: false, label: "Slicing" });
}

async function sliceAll() {
  if (!ensureReady(true, false)) return;
  await slicePlates(platesWithModels(), { forceSuffix: true, label: "Slicing all build plates" });
}

async function saveAll() {
  if (!ensureReady(false, false)) return;
  playSound("click-crisp");
  try {
    const path = await window.slicer.saveOutput($("format").value);
    if (!path) {
      log("Save all canceled.");
      return;
    }
    $("outputPath").value = path;
    await slicePlates(platesWithModels(), { forceSuffix: true, label: "Saving all build plates" });
  } catch (error) {
    log(`Save all failed: ${error.message}`);
    showErrorPrompt("Save All Failed", error);
  }
}

async function slicePlates(platesToSlice, { forceSuffix = false, label = "Slicing" } = {}) {
  const occupied = (platesToSlice || []).filter((plate) => models.some((model) => model.plateId === plate.id));
  if (!occupied.length) {
    logAndPrompt("No Objects To Slice", "Move or load at least one object onto a build plate first.");
    return;
  }
  playSound("click-crisp");
  setBusy(true);
  log(`${label}...`);
  try {
    for (const plate of occupied) {
      const payload = collectPayloadForPlate(plate, outputPathForPlate(plate, { forceSuffix }));
      log(`Slicing ${plate.name}...`);
      const result = await window.slicer.slice(payload);
      plate.layersGenerated = true;
      plate.sliced = true;
      plate.sliceLayerCount = result.layers || 0;
      plate.previewDir = result.previewDir || null;
      log(`Done ${plate.name}: ${result.outputPath}`);
      log(`${result.layers} layers, ${result.supports} supports, ${result.materialMl.toFixed(2)} ml resin`);
    }
    updateScene();
    playSound("success");
  } catch (error) {
    log(`${label} failed: ${error.message}`);
    showErrorPrompt(`${label} Failed`, error);
  } finally {
    setBusy(false);
  }
}

function platesWithModels() {
  return buildPlates.filter((plate) => models.some((model) => model.plateId === plate.id));
}

function ensureReady(requireOutput, requireActivePlateObjects = true) {
  if (!models.length) {
    logAndPrompt("No Mesh Loaded", "Open or drop at least one STL, OBJ, STP, or STEP first.");
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
    cadSlicingMode: settings.cadSlicingMode || "tessellated",
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

function outputPathForPlate(plate, { forceSuffix = false } = {}) {
  const outputPath = $("outputPath").value.trim();
  if (!forceSuffix) return outputPath;
  const ext = $("format").value;
  const suffix = `-plate-${plate.id}`;
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
  changed += applyDiameterValue("primaryAreaDiameter", flat, ["primaryAreaDiameter", "primary_area_diameter_mm"], ["primaryAreaRadius", "primary_area_radius_mm"]);
  changed += applyNumberValue("primaryMaxExtra", flat, ["primaryMaxExtra", "primary_max_extra_per_island"], Math.round);
  changed += applyDiameterValue("postDiameter", flat, ["postDiameter", "supportDiameter", "post_diameter_mm"], ["postRadius", "supportRadius", "post_radius_mm"]);
  changed += applyDiameterValue("tipDiameter", flat, ["tipDiameter", "contactDiameter", "tip_diameter_mm"], ["tipRadius", "contactRadius", "tip_radius_mm"]);
  changed += applySelectValue("tipType", flat, ["tipType", "tip_type"], ["cone", "sphere", "cylinder"]);
  changed += applyCheckedValue("sphericalContactEnabled", flat, ["sphericalContactEnabled", "spherical_contact_enabled"]);
  changed += applyNumberValue("sphericalContactDiameter", flat, ["sphericalContactDiameter", "spherical_contact_diameter_mm", "contactSphereDiameter", "contact_sphere_diameter_mm"]);
  changed += applyInsetPercentValue(flat);
  changed += applyNumberValue("tipLength", flat, ["tipLength", "tip_length_mm"]);
  changed += applyDiameterValue("footDiameter", flat, ["footDiameter", "foot_diameter_mm"], ["footRadius", "foot_radius_mm"]);
  changed += applySelectValue("bedInterface", flat, ["bedInterface", "bed_interface"], ["none", "feet", "raft", "skate"]);
  changed += applyNumberValue("raftOffset", flat, ["raftOffset", "raft_offset_mm", "raftMargin", "raft_margin_mm"]);
  changed += applyNumberValue("raftChamferWidth", flat, ["raftChamferWidth", "raft_chamfer_width_mm"]);
  changed += applyNumberValue("raftChamferAngle", flat, ["raftChamferAngle", "raft_chamfer_angle_deg"]);
  changed += applyNumberValue("bedInterfaceThickness", flat, ["bedInterfaceThickness", "bed_interface_thickness_mm"]);
  changed += applyNumberValue("collisionClearance", flat, ["collisionClearance", "collision_clearance_mm", "pathClearance"]);
  changed += applyNumberValue("maxBaseReach", flat, ["maxBaseReach", "max_base_reach_mm"]);
  changed += applyNumberValue("maxSupportAngle", flat, ["maxSupportAngle", "max_support_angle_deg"]);
  changed += applyCheckedValue("enforcersEnabled", flat, ["enforcersEnabled", "enforcers_enabled"]);
  changed += applyNumberValue("enforcerReach", flat, ["enforcerReach", "enforcer_reach_mm"]);
  changed += applyNumberValue("enforcerMinDrop", flat, ["enforcerMinDrop", "enforcer_min_drop_mm"]);
  changed += applyCheckedValue("braceEnabled", flat, ["braceEnabled", "brace_enabled"]);
  changed += applyDiameterValue("braceDiameter", flat, ["braceDiameter", "brace_diameter_mm"], ["braceRadius", "brace_radius_mm"]);
  changed += applyNumberValue("braceHeight", flat, ["braceHeight", "brace_height_mm"]);
  changed += applyNumberValue("braceDistance", flat, ["braceDistance", "brace_max_distance_mm"]);
  syncSphericalContactFields();
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

function applyDiameterValue(id, flat, diameterKeys, radiusKeys) {
  const diameterValue = profileValue(flat, diameterKeys);
  const diameter = importedNumber(diameterValue);
  if (Number.isFinite(diameter)) {
    $(id).value = diameter;
    return 1;
  }
  const radiusValue = profileValue(flat, radiusKeys);
  const radius = importedNumber(radiusValue);
  if (!Number.isFinite(radius)) return 0;
  $(id).value = radius * 2;
  return 1;
}

function applyInsetPercentValue(flat) {
  const percentValue = profileValue(flat, [
    "sphericalContactInsetPercent",
    "spherical_contact_inset_percent",
    "contactSphereInsetPercent",
    "contact_sphere_inset_percent"
  ]);
  const percent = importedNumber(percentValue);
  if (Number.isFinite(percent)) {
    $("sphericalContactInsetPercent").value = clamp(Math.round(percent), 5, 95);
    return 1;
  }
  const insetValue = profileValue(flat, [
    "sphericalContactInset",
    "spherical_contact_inset_mm",
    "contactSphereInset",
    "contact_sphere_inset_mm"
  ]);
  const insetMm = importedNumber(insetValue);
  const diameterMm = number("sphericalContactDiameter");
  if (!Number.isFinite(insetMm) || diameterMm <= 0) return 0;
  $("sphericalContactInsetPercent").value = clamp(Math.round((insetMm / diameterMm) * 100), 5, 95);
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
  applyMachineConfigToForm(cfg);
  renderTopbarResinOptions($("profile").value);
  applyResinProfileToForm(selectedResinProfile($("profile").value));
}

function requestSceneUpdate(options = {}) {
  if (sceneUpdateFrame !== null) return;
  sceneUpdateFrame = requestAnimationFrame(() => {
    sceneUpdateFrame = null;
    updateScene(options);
  });
}

function animateBuildPlateDrop(plate) {
  const tick = () => {
    if (!plate.dropAnimation) return;
    const elapsed = performance.now() - plate.dropAnimation.start;
    if (elapsed >= plate.dropAnimation.duration) {
      plate.dropAnimation = null;
      updateScene();
      return;
    }
    updateScene({ renderLists: false, updateStatus: false, skipDerivedGeometry: true });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function animateModelDrop(items) {
  const dropping = (items || []).filter(Boolean);
  if (!dropping.length) return;
  const tick = () => {
    const active = dropping.some((model) => model.dropAnimation);
    if (!active) return;
    const now = performance.now();
    for (const model of dropping) {
      if (model.dropAnimation && now - model.dropAnimation.start >= model.dropAnimation.duration) {
        model.dropAnimation = null;
      }
    }
    updateScene({ renderLists: false, updateStatus: false, skipDerivedGeometry: true });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startDropAnimation() {
  return { start: performance.now(), duration: 820 };
}

function updateScene({ renderLists = true, updateStatus = true, skipDerivedGeometry = false } = {}) {
  ensureInitialBuildPlate();
  updateBuildPlateLayout();
  const scene = buildScene({ skipDerivedGeometry });
  viewer.setScene(scene);
  if (renderLists) renderWorkspaceLists();
  if (!updateStatus) return;
  const active = activePlate();
  const activeModels = models.filter((model) => model.plateId === active.id);
  $("meshStatus").textContent = selectedModelIds.size
    ? `${selectedModelIds.size.toLocaleString()} model${selectedModelIds.size === 1 ? "" : "s"} selected`
    : `${activeModels.length.toLocaleString()} object${activeModels.length === 1 ? "" : "s"} on ${active.name}`;
  if (slicePreviewActive && (!active.sliced || slicePreviewPlateId !== active.id)) closeSlicePreview();
  if (active.layersGenerated) {
    $("supportStatus").textContent = `${active.supports.length.toLocaleString()} supports generated`;
  } else if (isGeneratingSupports) {
    // preserve the "Generating supports..." text set by generatePreview
  } else if (activeModels.some((model) => modelOutOfBounds(model, active))) {
    $("supportStatus").textContent = "Active plate has out-of-bounds geometry";
  } else {
    $("supportStatus").textContent = "Layer/support preview stale";
  }
  if (!isBusy) $("viewSliceButton").disabled = !active.sliced;
}

function setActivePlateClipLayer(value) {
  const plate = activePlate();
  const maxLayer = slicePreviewActive ? plateOccupiedMaxLayer(plate) : plateMaxLayer(plate);
  const layer = clamp(Math.round(Number.isFinite(value) ? value : clipHeightToLayer(plate, plate.clipHeight)), 1, maxLayer);
  plate.clipEnabled = true;
  plate.clipHeight = layerToClipHeight(plate, layer);
  $("clipHeight").value = layer;
  $("clipHeightValue").value = layer;
  $("clipEnabled").checked = true;
  if (slicePreviewActive) {
    if (slicePreviewPlateId === plate.id) {
      loadPreviewLayer(layer, { session: slicePreviewSession, plateId: plate.id });
    } else {
      closeSlicePreview({ refreshScene: true });
    }
  } else {
    updateScene();
  }
}

function setActivePlateClipHeight(value) {
  const plate = activePlate();
  setActivePlateClipLayer(clipHeightToLayer(plate, value));
}

function stepActiveClipLayer(delta) {
  const plate = activePlate();
  setActivePlateClipLayer(clipHeightToLayer(plate, plate.clipHeight) + delta);
}

function stepClipHeightFromWheel(event) {
  event.preventDefault();
  const step = event.shiftKey ? 10 : 1;
  stepActiveClipLayer(event.deltaY > 0 ? -step : step);
}

function snapPlateClipHeightToLayer(plate) {
  const maxZ = plate.settings.printer.sizeZ || 160;
  const layer = clipHeightToLayer(plate, clamp(plate.clipHeight, 0, maxZ));
  plate.clipHeight = layerToClipHeight(plate, layer);
}

function clipHeightToLayer(plate, height) {
  const layerHeight = plateLayerHeight(plate);
  const maxLayer = plateMaxLayer(plate);
  return clamp(Math.round((Number.isFinite(height) ? height : layerHeight) / layerHeight), 1, maxLayer);
}

function layerToClipHeight(plate, layer) {
  const maxZ = plate.settings.printer.sizeZ || 160;
  return clamp(Math.round(layer) * plateLayerHeight(plate), plateLayerHeight(plate), maxZ);
}

function plateLayerHeight(plate) {
  const value = Number(plate?.settings?.printer?.layerHeight);
  return Number.isFinite(value) && value > 0 ? value : 0.05;
}

function plateMaxLayer(plate) {
  return Math.max(1, Math.ceil((plate?.settings?.printer?.sizeZ || 160) / plateLayerHeight(plate)));
}

function plateOccupiedMaxLayer(plate) {
  if (plate.sliceLayerCount) return plate.sliceLayerCount;
  const plateModels = models.filter((m) => m.plateId === plate.id);
  if (!plateModels.length) return plateMaxLayer(plate);
  const zValues = plateModels.map((m) => modelWorldBounds(m).maxZ).filter(Number.isFinite);
  if (!zValues.length) return plateMaxLayer(plate);
  const maxZ = Math.max(...zValues);
  if (maxZ <= 0) return plateMaxLayer(plate);
  return Math.max(1, Math.ceil(maxZ / plateLayerHeight(plate)));
}

function buildScene({ skipDerivedGeometry = false } = {}) {
  const active = activePlate();
  const activeClipLayer = clipHeightToLayer(active, active.clipHeight);
  const clipSliceCacheKey = active.sliced && active.previewDir
    ? previewLayerCacheKey(active, activeClipLayer)
    : null;
  const clipSliceDataUrl = clipSliceCacheKey ? previewLayerCache.get(clipSliceCacheKey) : null;
  if (!skipDerivedGeometry && active.clipEnabled && active.sliced && active.previewDir && !clipSliceDataUrl) {
    ensureClipSliceLayerLoaded(active, activeClipLayer);
  }
  const modelItems = [];
  const selectionBoxes = [];
  const gizmoModel = widgetModel();
  let transformGizmo = null;

  for (const model of models) {
    const plate = buildPlates.find((item) => item.id === model.plateId);
    if (!plate) continue;
    const local = model.mesh;
    const localBounds = modelDisplayLocalBounds(model);
    const visual = buildModelVisual(model);
    const offset = modelWorldOffset(model, plate);
    offset[2] += visual.z;
    const bounds = offsetBounds(localBounds, offset);
    const isActive = plate.id === active.id;
    const selected = selectedModelIds.has(model.id);
    const outOfBounds = boundsOutsidePlate(bounds, plate);
    modelItems.push({
      id: model.id,
      plateId: plate.id,
      mesh: local,
      offset,
      geometryKey: "raw",
      modelOrigin: boundsCenter(model.mesh.bounds),
      modelRotation: modelRotationRadians(model.transform),
      modelScale: model.transform.scale || 1,
      scale: [visual.scaleX, visual.scaleY, visual.scaleZ],
      scaleOrigin: boundsCenter(localBounds),
      bounds,
      plateClipBox: plateClipBox(plate),
      outOfBounds,
      color: isActive ? (selected ? [0.3, 0.78, 0.95, 1] : [0.26, 0.72, 0.86, 1]) : [0.44, 0.48, 0.52, 1]
    });
    if (selected) selectionBoxes.push(bounds);
  }

  if (gizmoModel && selectedModelIds.size) {
    const gizmoPlate = buildPlates.find((item) => item.id === gizmoModel.plateId);
    const bounds = offsetBounds(modelDisplayLocalBounds(gizmoModel), modelWorldOffset(gizmoModel, gizmoPlate));
    const center = boundsCenter(bounds);
    const span = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      bounds.maxZ - bounds.minZ,
      18
    );
    transformGizmo = {
      center,
      length: clamp(span * 0.48, 16, 44),
      radius: clamp(span * 0.018, 0.45, 1.25)
    };
  }

  return {
    plates: buildPlates.map((plate) => ({
      id: plate.id,
      name: plate.name,
      origin: plate.origin,
      visual: buildPlateVisual(plate),
      bed: {
        x: plate.settings.printer.sizeX || 120,
        y: plate.settings.printer.sizeY || 67.5,
        z: plate.settings.printer.sizeZ || 160
      },
      active: plate.id === active.id
    })),
    nextPlate: nextBuildPlatePreview(),
    models: modelItems,
    selectionBoxes,
    supports: skipDerivedGeometry ? null : offsetSupports(active.supports, active.origin),
    supportBraces: skipDerivedGeometry ? null : offsetBraces(active.supportBraces, active.origin),
    supportRaft: skipDerivedGeometry ? null : offsetSupportRaft(active.supportRaft, active.origin),
    transformGizmo,
    clip: {
      enabled: active.clipEnabled,
      z: active.clipHeight,
      plate: {
        x: active.origin.x,
        y: active.origin.y,
        width: active.settings.printer.sizeX || 120,
        depth: active.settings.printer.sizeY || 67.5
      },
      showLayer: active.sliced,
      layerLines: null,
      intersectionFill: null,
      sliceImage: !skipDerivedGeometry && active.clipEnabled && active.sliced && clipSliceDataUrl ? {
        cacheKey: clipSliceCacheKey,
        dataUrl: clipSliceDataUrl,
        x: active.origin.x,
        y: active.origin.y,
        width: active.settings.printer.sizeX || 120,
        depth: active.settings.printer.sizeY || 67.5,
        z: active.clipHeight
      } : null
    }
  };
}

function buildPlateVisual(plate) {
  if (!plate.dropAnimation) return { z: 0, scaleX: 1, scaleY: 1 };
  const t = clamp((performance.now() - plate.dropAnimation.start) / plate.dropAnimation.duration, 0, 1);
  const dropHeight = 112;
  const hitAt = 0.48;
  let z = 0;
  let squash = 0;
  let stretch = 0;
  if (t < hitAt) {
    const fallT = t / hitAt;
    z = dropHeight * (1 - fallT * fallT);
  } else {
    const bounceT = (t - hitAt) / (1 - hitAt);
    squash = Math.max(0, 1 - bounceT / 0.16);
    if (bounceT < 0.42) {
      const reboundT = bounceT / 0.42;
      z = Math.sin(reboundT * Math.PI) * 28 * Math.pow(1 - reboundT * 0.35, 1.5);
      stretch = Math.max(0, Math.sin(reboundT * Math.PI)) * Math.max(0, 1 - reboundT);
    }
  }
  return {
    z,
    scaleX: 1 + squash * 0.14 - stretch * 0.055,
    scaleY: 1 - squash * 0.08 + stretch * 0.11
  };
}

function buildModelVisual(model) {
  if (!model.dropAnimation) return { z: 0, scaleX: 1, scaleY: 1, scaleZ: 1 };
  const t = clamp((performance.now() - model.dropAnimation.start) / model.dropAnimation.duration, 0, 1);
  const dropHeight = 72;
  const hitAt = 0.48;
  let z = 0;
  let squash = 0;
  let stretch = 0;
  if (t < hitAt) {
    const fallT = t / hitAt;
    z = dropHeight * (1 - fallT * fallT);
  } else {
    const bounceT = (t - hitAt) / (1 - hitAt);
    squash = Math.max(0, 1 - bounceT / 0.16);
    if (bounceT < 0.42) {
      const reboundT = bounceT / 0.42;
      z = Math.sin(reboundT * Math.PI) * 18 * Math.pow(1 - reboundT * 0.35, 1.5);
      stretch = Math.max(0, Math.sin(reboundT * Math.PI)) * Math.max(0, 1 - reboundT);
    }
  }
  return {
    z,
    scaleX: 1 + squash * 0.1 - stretch * 0.04,
    scaleY: 1 + squash * 0.1 - stretch * 0.04,
    scaleZ: 1 - squash * 0.16 + stretch * 0.18
  };
}

function defaultModelTransform() {
  return { rotateX: 0, rotateY: 0, rotateZ: 0, translateX: 0, translateY: 0, translateZ: 0, scale: 1 };
}

function positionModelsAtPlateCenter(items, plate) {
  const placing = (items || []).filter(Boolean);
  if (!placing.length || !plate) return;
  const gap = placing.length > 1 ? 4 : 0;
  const bedX = plate.settings.printer.sizeX || 120;
  const bedY = plate.settings.printer.sizeY || 67.5;
  const packed = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(placing.length)));
  let cursorX = 0;
  let cursorY = 0;
  let rowDepth = 0;
  let groupWidth = 0;
  for (let index = 0; index < placing.length; index++) {
    const model = placing[index];
    const oriented = modelRenderMesh(model);
    const width = oriented.bounds.maxX - oriented.bounds.minX;
    const depth = oriented.bounds.maxY - oriented.bounds.minY;
    if (index > 0 && index % cols === 0) {
      cursorX = 0;
      cursorY += rowDepth + gap;
      rowDepth = 0;
    }
    packed.push({ model, bounds: oriented.bounds, x: cursorX, y: cursorY, width, depth });
    cursorX += width + gap;
    groupWidth = Math.max(groupWidth, cursorX - gap);
    rowDepth = Math.max(rowDepth, depth);
  }
  const groupDepth = packed.reduce((max, item) => Math.max(max, item.y + item.depth), 0);
  const startX = (bedX - groupWidth) / 2;
  const startY = (bedY - groupDepth) / 2;
  for (const item of packed) {
    item.model.plateId = plate.id;
    item.model.transform.translateX = startX + item.x - item.bounds.minX;
    item.model.transform.translateY = startY + item.y - item.bounds.minY;
    item.model.transform.translateZ = -item.bounds.minZ;
  }
}

function placeNewModelOnPlate(model, plate) {
  if (!model || !plate) return;
  const oriented = modelRenderMesh(model);
  const bounds = oriented.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  const bedX = plate.settings.printer.sizeX || 120;
  const bedY = plate.settings.printer.sizeY || 67.5;
  const centerX = (bedX - width) / 2;
  const centerY = (bedY - depth) / 2;
  const candidates = placementCandidates(centerX, centerY, width, depth, bedX, bedY);
  const existing = models
    .filter((item) => item !== model && item.plateId === plate.id)
    .map((item) => expandedModelPlateBounds(item, plate, 2));
  const chosen = candidates.find((candidate) => !candidateOverlapsModels(candidate, width, depth, existing))
    || { x: centerX, y: centerY };
  model.transform.translateX = chosen.x - bounds.minX;
  model.transform.translateY = chosen.y - bounds.minY;
  model.transform.translateZ = -bounds.minZ;
}

function placementCandidates(centerX, centerY, width, depth, bedX, bedY) {
  const stepX = Math.max(8, Math.min(width + 4, Math.max(8, bedX / 5)));
  const stepY = Math.max(8, Math.min(depth + 4, Math.max(8, bedY / 5)));
  const canClampX = width <= bedX;
  const canClampY = depth <= bedY;
  const seen = new Set();
  const out = [];
  const push = (x, y) => {
    const nextX = canClampX ? clamp(x, 0, bedX - width) : x;
    const nextY = canClampY ? clamp(y, 0, bedY - depth) : y;
    const key = `${nextX.toFixed(3)},${nextY.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x: nextX, y: nextY });
  };
  push(centerX, centerY);
  for (let radius = 1; radius <= 14; radius++) {
    for (let ix = -radius; ix <= radius; ix++) {
      for (let iy = -radius; iy <= radius; iy++) {
        if (Math.max(Math.abs(ix), Math.abs(iy)) !== radius) continue;
        push(centerX + ix * stepX, centerY + iy * stepY);
      }
    }
  }
  return out;
}

function candidateOverlapsModels(candidate, width, depth, existingBounds) {
  return existingBounds.some((bounds) => rectsOverlap(
    { x: candidate.x, y: candidate.y },
    { x: width, y: depth },
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX - bounds.minX, y: bounds.maxY - bounds.minY }
  ));
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
    const oriented = modelRenderMesh(model);
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
  return translateMesh(modelRenderMesh(model), ...modelWorldOffset(model, plate));
}

function modelRenderMesh(model) {
  const key = transformGeometryKey(model.transform);
  if (!model.renderMesh || model.renderMesh.key !== key) {
    model.renderMesh = {
      key,
      mesh: orientMesh(model.mesh, model.transform)
    };
  }
  return model.renderMesh.mesh;
}

function transformGeometryKey(transform) {
  return [
    transform.rotateX || 0,
    transform.rotateY || 0,
    transform.rotateZ || 0,
    transform.scale || 1
  ].join("|");
}

function modelDisplayLocalBounds(model) {
  return transformLocalBounds(model.mesh.bounds, model.transform);
}

function dropModelToBuildPlate(model, { exact = false } = {}) {
  const offset = reorientationDropOffset();
  const plate = buildPlates.find((item) => item.id === model.plateId);
  const bounds = exact
    ? modelPlacementWorldBounds(model)
    : offsetBounds(modelDisplayLocalBounds(model), modelPlacementOffset(model, plate));
  model.transform.translateZ += offset - bounds.minZ;
}

function reorientationDropOffset() {
  const value = Number($("dropOffset")?.value);
  return Math.max(0, Number.isFinite(value) ? placementDisplayToMm(value) : 0);
}

function transformLocalBounds(bounds, transform) {
  const origin = boundsCenter(bounds);
  return boundsForPointList(boundsCorners(bounds).map((point) => transformLocalPoint(point, transform, origin)));
}

function transformLocalPoint(point, transform, origin) {
  const scale = transform.scale || 1;
  const angles = modelRotationRadians(transform);
  let local = [
    (point[0] - origin[0]) * scale,
    (point[1] - origin[1]) * scale,
    (point[2] - origin[2]) * scale
  ];
  local = rotatePoint(local, angles);
  return [
    local[0] + origin[0],
    local[1] + origin[1],
    local[2] + origin[2]
  ];
}

function modelRotationRadians(transform) {
  return [deg(transform.rotateX || 0), deg(transform.rotateY || 0), deg(transform.rotateZ || 0)];
}

function modelWorldOffset(model, plate = buildPlates.find((item) => item.id === model.plateId)) {
  const offset = modelPlacementOffset(model, plate);
  offset[2] += modelLiftForPlate(plate);
  return offset;
}

function modelPlacementOffset(model, plate = buildPlates.find((item) => item.id === model.plateId)) {
  const origin = plate ? plate.origin : { x: 0, y: 0 };
  return [
    origin.x + model.transform.translateX,
    origin.y + model.transform.translateY,
    model.transform.translateZ
  ];
}

function modelLiftForPlate(plate) {
  const support = plate?.settings?.support;
  if (!support?.enabled) return 0;
  if (!plateHasGeneratedSupportStructure(plate)) return 0;
  const lift = Number(support.modelLift);
  return Math.max(0, Number.isFinite(lift) ? lift : 0);
}

function plateHasGeneratedSupportStructure(plate) {
  return !!(plate?.layersGenerated && (
    (plate.supports?.length || 0) > 0
    || (plate.supportBraces?.length || 0) > 0
    || plate.supportRaft
  ));
}

function modelPlacementWorldBounds(model) {
  return offsetBounds(modelRenderMesh(model).bounds, modelPlacementOffset(model));
}

function modelWorldBounds(model) {
  return offsetBounds(modelRenderMesh(model).bounds, modelWorldOffset(model));
}

function offsetBounds(bounds, offset) {
  return {
    minX: bounds.minX + offset[0],
    minY: bounds.minY + offset[1],
    minZ: bounds.minZ + offset[2],
    maxX: bounds.maxX + offset[0],
    maxY: bounds.maxY + offset[1],
    maxZ: bounds.maxZ + offset[2]
  };
}

function modelLocalCentroid(model) {
  const center = boundsCenter(modelRenderMesh(model).bounds);
  return [center[0], center[1], center[2]];
}

function boundsCenter(bounds) {
  return [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  ];
}

function boundsForPointList(points) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const point of points) {
    b.minX = Math.min(b.minX, point[0]);
    b.minY = Math.min(b.minY, point[1]);
    b.minZ = Math.min(b.minZ, point[2]);
    b.maxX = Math.max(b.maxX, point[0]);
    b.maxY = Math.max(b.maxY, point[1]);
    b.maxZ = Math.max(b.maxZ, point[2]);
  }
  return b;
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
  return boundsOutsidePlate(modelWorldBounds(model), plate);
}

function boundsOutsidePlate(bounds, plate) {
  const maxX = plate.origin.x + (plate.settings.printer.sizeX || 120);
  const maxY = plate.origin.y + (plate.settings.printer.sizeY || 67.5);
  return bounds.minX < plate.origin.x || bounds.maxX > maxX || bounds.minY < plate.origin.y || bounds.maxY > maxY;
}

function plateClipBox(plate) {
  return {
    minX: plate.origin.x,
    minY: plate.origin.y,
    maxX: plate.origin.x + (plate.settings.printer.sizeX || 120),
    maxY: plate.origin.y + (plate.settings.printer.sizeY || 67.5)
  };
}

function makeWorldRectGeometry(x0, y0, x1, y1, z) {
  const vertices = new Float32Array([
    x0, y0, z,
    x1, y0, z,
    x1, y1, z,
    x0, y0, z,
    x1, y1, z,
    x0, y1, z
  ]);
  const normals = new Float32Array(vertices.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return {
    vertices,
    normals,
    bounds: boundsFor(vertices)
  };
}

function makeSupportRaftGeometry(raft) {
  const x0 = Number(raft?.x0);
  const y0 = Number(raft?.y0);
  const x1 = Number(raft?.x1);
  const y1 = Number(raft?.y1);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
    return makeWorldRectGeometry(0, 0, 0.001, 0.001, 0.45);
  }
  const width = x1 - x0;
  const depth = y1 - y0;
  // Render the raft as a real slab sitting on the plate (z=0 up to its
  // thickness) so it is clearly visible rather than a flat translucent film.
  const topZ = Math.max(0.4, Number(raft.thickness) || 0.35);
  const radius = Math.max(1.2, Math.min(width, depth) * 0.045);
  const path = roundedRectPath(x0, y0, x1, y1, radius, 9);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const center = [cx, cy, topZ];
  const vertices = [];
  const normals = [];
  // Top face (fan), facing up.
  for (let i = 0; i < path.length; i++) {
    const next = (i + 1) % path.length;
    pushTri(
      vertices,
      normals,
      center,
      [path[i][0], path[i][1], topZ],
      [path[next][0], path[next][1], topZ],
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1]
    );
  }
  // Perimeter walls from the plate up to the top face.
  for (let i = 0; i < path.length; i++) {
    const next = (i + 1) % path.length;
    const ax = path[i][0];
    const ay = path[i][1];
    const bx = path[next][0];
    const by = path[next][1];
    let nx = ay - by;
    let ny = bx - ax;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const n = [nx, ny, 0];
    pushTri(vertices, normals, [ax, ay, 0], [bx, by, 0], [bx, by, topZ], n, n, n);
    pushTri(vertices, normals, [ax, ay, 0], [bx, by, topZ], [ax, ay, topZ], n, n, n);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
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

function offsetSupportRaft(raft, origin) {
  if (!raft) return null;
  return {
    ...raft,
    x0: raft.x0 + origin.x,
    y0: raft.y0 + origin.y,
    x1: raft.x1 + origin.x,
    y1: raft.y1 + origin.y
  };
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
  const toast = $("viewerToast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    toastTimer = null;
  }, 4200);
}

function createLoadProgressItem(path) {
  const item = {
    id: nextLoadProgressId++,
    name: fileName(path),
    progress: 0,
    status: "Queued",
    removeTimer: null
  };
  loadProgressItems.set(item.id, item);
  renderLoadProgress();
  return item;
}

function updateLoadProgressItem(id, progress, status) {
  const item = loadProgressItems.get(id);
  if (!item) return;
  item.progress = clamp(progress, 0, 1);
  item.status = status || item.status;
  renderLoadProgress();
}

function scheduleLoadProgressRemoval(id, delay = 1600) {
  const item = loadProgressItems.get(id);
  if (!item) return;
  if (item.removeTimer) clearTimeout(item.removeTimer);
  item.removeTimer = setTimeout(() => {
    loadProgressItems.delete(id);
    renderLoadProgress();
  }, delay);
}

function renderLoadProgress() {
  const panel = $("loadProgressPanel");
  if (!panel) return;
  const items = [...loadProgressItems.values()];
  panel.hidden = !items.length;
  panel.innerHTML = items.map((item) => `
    <div class="load-progress-item">
      <div class="load-progress-header">
        <span class="load-progress-name">${escapeText(item.name)}</span>
        <span class="load-progress-status">${escapeText(item.status)}</span>
      </div>
      <div class="load-progress-track">
        <div class="load-progress-fill" style="width: ${Math.round(item.progress * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function applyPreviewTransform() {
  $("slicePreviewImage").style.transform = `translate(${previewPanX}px, ${previewPanY}px) scale(${previewZoom})`;
}

function resetPreviewTransform() {
  previewZoom = 1.0;
  previewPanX = 0;
  previewPanY = 0;
  $("slicePreviewImage").style.transform = "";
}

function uint8ArrayToDataUrl(bytes) {
  const chunks = [];
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return "data:image/png;base64," + btoa(chunks.join(""));
}

function isPreviewRequestCurrent(session, plateId) {
  return slicePreviewActive && slicePreviewSession === session && slicePreviewPlateId === plateId;
}

function previewLayerCacheKey(plate, layer) {
  return `${plate.id}:${plate.previewDir || "preview"}:${layer}`;
}

function setPreviewLayerCache(key, dataUrl) {
  previewLayerCache.set(key, dataUrl);
  while (previewLayerCache.size > 12) {
    previewLayerCache.delete(previewLayerCache.keys().next().value);
  }
}

async function readPreviewLayerDataUrl(plate, layer) {
  if (!plate?.previewDir || !plate.sliceLayerCount) return null;
  const clamped = clamp(layer, 1, plate.sliceLayerCount);
  const cacheKey = previewLayerCacheKey(plate, clamped);
  if (previewLayerCache.has(cacheKey)) return previewLayerCache.get(cacheKey);
  if (previewLayerReadPromises.has(cacheKey)) return previewLayerReadPromises.get(cacheKey);
  const padded = String(clamped).padStart(5, "0");
  const path = `${plate.previewDir}/layer_${padded}.png`.replace(/\\/g, "/");
  const promise = window.slicer.readFile(path)
    .then((buffer) => {
      if (!buffer || !buffer.byteLength) return null;
      const dataUrl = uint8ArrayToDataUrl(new Uint8Array(buffer));
      setPreviewLayerCache(cacheKey, dataUrl);
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => previewLayerReadPromises.delete(cacheKey));
  previewLayerReadPromises.set(cacheKey, promise);
  return promise;
}

function ensureClipSliceLayerLoaded(plate, layer) {
  if (!plate?.sliced || !plate.previewDir) return;
  const clamped = clamp(layer, 1, plate.sliceLayerCount || 1);
  const cacheKey = previewLayerCacheKey(plate, clamped);
  if (previewLayerCache.has(cacheKey) || previewLayerReadPromises.has(cacheKey)) return;
  readPreviewLayerDataUrl(plate, clamped).then((dataUrl) => {
    if (!dataUrl) return;
    const current = activePlate();
    const currentLayer = clipHeightToLayer(current, current.clipHeight);
    if (current.id === plate.id && current.clipEnabled && current.sliced && currentLayer === clamped) {
      updateScene({ renderLists: false, updateStatus: false });
    }
  });
}

function closeSlicePreview({ refreshScene = false } = {}) {
  slicePreviewSession += 1;
  slicePreviewActive = false;
  slicePreviewPlateId = null;
  previewDragStart = null;
  previewLayerCache.clear();
  resetPreviewTransform();
  $("slicePreviewPanel").hidden = true;
  $("slicePreviewImage").removeAttribute("src");
  $("slicePreviewInfo").textContent = "";
  $("viewSliceButton").textContent = "View Slice Preview";
  $("viewSliceButton").disabled = isBusy || !activePlate().sliced;
  if (refreshScene) updateScene();
}

async function loadPreviewLayer(layer, request = {}) {
  const plate = activePlate();
  const session = request.session ?? slicePreviewSession;
  const plateId = request.plateId ?? plate.id;
  if (!isPreviewRequestCurrent(session, plateId)) return;
  if (!plate.previewDir || !plate.sliceLayerCount) return;
  const clamped = clamp(layer, 1, plate.sliceLayerCount);
  $("slicePreviewInfo").textContent = `Layer ${clamped} / ${plate.sliceLayerCount}`;
  $("clipHeight").value = clamped;
  $("clipHeightValue").value = clamped;
  const cacheKey = previewLayerCacheKey(plate, clamped);
  if (previewLayerCache.has(cacheKey)) {
    if (isPreviewRequestCurrent(session, plateId)) $("slicePreviewImage").src = previewLayerCache.get(cacheKey);
    return;
  }
  const dataUrl = await readPreviewLayerDataUrl(plate, clamped);
  if (dataUrl && isPreviewRequestCurrent(session, plateId)) {
    if (isPreviewRequestCurrent(session, plateId)) $("slicePreviewImage").src = dataUrl;
  }
}

function enterSlicePreview() {
  const plate = activePlate();
  if (!plate.sliced || !plate.previewDir) return;
  slicePreviewSession += 1;
  slicePreviewActive = true;
  slicePreviewPlateId = plate.id;
  previewLayerCache.clear();
  resetPreviewTransform();
  $("clipHeight").min = 1;
  $("clipHeight").max = plate.sliceLayerCount;
  $("clipHeightValue").min = 1;
  $("clipHeightValue").max = plate.sliceLayerCount;
  $("slicePreviewPanel").hidden = false;
  $("viewSliceButton").textContent = "Close Slice Preview";
  updatePlateControls(plate);
  loadPreviewLayer(clipHeightToLayer(plate, plate.clipHeight), {
    session: slicePreviewSession,
    plateId: plate.id
  });
}

function exitSlicePreview() {
  closeSlicePreview({ refreshScene: true });
}

function toggleSlicePreview(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (slicePreviewActive) {
    exitSlicePreview();
  } else {
    enterSlicePreview();
  }
}

function setBusy(busy) {
  isBusy = busy;
  $("previewButton").disabled = busy;
  $("saveProjectButton").disabled = busy;
  $("sliceButton").disabled = busy;
  $("sliceAllButton").disabled = busy;
  $("saveAllButton").disabled = busy;
  $("viewSliceButton").disabled = busy || !activePlate().sliced;
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

function applyGlobalRotationToTransform(transform, axis, deltaDegrees) {
  if (!Number.isFinite(deltaDegrees) || Math.abs(deltaDegrees) < 0.000001) return;
  const current = rotationMatrixFromEuler(
    deg(transform.rotateX || 0),
    deg(transform.rotateY || 0),
    deg(transform.rotateZ || 0)
  );
  const delta = rotationMatrixAroundAxis(axis, deg(deltaDegrees));
  const next = multiplyMatrix3(delta, current);
  const euler = eulerFromRotationMatrix(next);
  transform.rotateX = normalizeDegrees(radToDeg(euler[0]));
  transform.rotateY = normalizeDegrees(radToDeg(euler[1]));
  transform.rotateZ = normalizeDegrees(radToDeg(euler[2]));
}

function rotationMatrixFromEuler(rx, ry, rz) {
  const sx = Math.sin(rx), cx = Math.cos(rx);
  const sy = Math.sin(ry), cy = Math.cos(ry);
  const sz = Math.sin(rz), cz = Math.cos(rz);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx]
  ];
}

function rotationMatrixAroundAxis(axis, angle) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  if (axis === "x") {
    return [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c]
    ];
  }
  if (axis === "y") {
    return [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c]
    ];
  }
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1]
  ];
}

function multiplyMatrix3(a, b) {
  const out = [];
  for (let row = 0; row < 3; row++) {
    out[row] = [];
    for (let col = 0; col < 3; col++) {
      out[row][col] = a[row][0] * b[0][col]
        + a[row][1] * b[1][col]
        + a[row][2] * b[2][col];
    }
  }
  return out;
}

function eulerFromRotationMatrix(matrix) {
  const sy = clamp(-matrix[2][0], -1, 1);
  const ry = Math.asin(sy);
  const cy = Math.cos(ry);
  if (Math.abs(cy) > 0.000001) {
    return [
      Math.atan2(matrix[2][1], matrix[2][2]),
      ry,
      Math.atan2(matrix[1][0], matrix[0][0])
    ];
  }
  return [
    0,
    ry,
    Math.atan2(-matrix[0][1], matrix[1][1])
  ];
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
    this.textureProgram = createTextureProgram(this.gl);
    this.meshes = {};
    this.modelMeshCache = new Map();
    this.sliceTextureCache = new Map();
    this.bed = { x: 120, y: 67.5, z: 160 };
    this.yaw = -0.65;
    this.pitch = 0.68;
    this.roll = 0;
    this.fov = deg(45);
    this.projectionMode = "perspective";
    this.navigationMode = "turntable";
    this.distance = 180;
    this.target = [60, 34, 20];
    this.drag = null;
    this.pickables = [];
    this.pickRects = [];
    this.onScenePick = null;
    this.onSceneDoubleClick = null;
    this.onModelDrag = null;
    this.onModelDragEnd = null;
    this.onGizmoDrag = null;
    this.onGizmoDragEnd = null;
    this.onFrame = null;
    this.hoveredHit = null;
    this.pressedHit = null;
    this.activeGizmoAction = null;
    this.gizmoDragCenter = null;
    this.activePlateFocus = null;
    this.activePartFocus = null;
    this.lastMvp = null;
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
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize({ recenter: false }));
      this.resizeObserver.observe(this.canvas);
    }
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const hit = this.hitAt(event.clientX, event.clientY);
      const isLeft = event.button === 0;
      const isMiddle = event.button === 1;
      const isRight = event.button === 2;
      let mode = "press";
      if (isMiddle) {
        this.prepareOrbit(event, hit);
        mode = "orbit";
      } else if (isRight) {
        mode = "pan";
      } else if (isLeft && hit?.type === "gizmo") {
        mode = "gizmo";
        this.activeGizmoAction = hit.action;
        this.gizmoDragCenter = this.activePartFocus ? [...this.activePartFocus] : null;
        this.setHoverHit(hit);
      } else if (isLeft && hit?.type === "model") {
        mode = "model";
      }
      this.pressedHit = isLeft && hit && (hit.type === "plate" || hit.type === "add-plate" || hit.type === "plate-action") ? hit : null;
      const dragPlaneZ = mode === "model"
        ? (hit?.bounds ? boundsCenter(hit.bounds)[2] : (this.activePartFocus?.[2] || 0))
        : 0;
      this.drag = { x: event.clientX, y: event.clientY, mode, moved: false, action: mode === "gizmo" ? this.activeGizmoAction : null, planeZ: dragPlaneZ };
      this.pointerStart = { x: event.clientX, y: event.clientY, additive, hit, clickable: isLeft && mode !== "gizmo" };
      if (mode === "model" && this.onScenePick) {
        this.onScenePick({ type: "model", id: hit.id, plateId: hit.plateId, additive, dragStart: true });
      }
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) {
        this.setHoverHit(this.hitAt(event.clientX, event.clientY));
        return;
      }
      event.preventDefault();
      const fromX = this.drag.x;
      const fromY = this.drag.y;
      const dx = event.clientX - fromX;
      const dy = event.clientY - fromY;
      const mode = this.drag.mode;
      const action = this.drag.action;
      const planeZ = this.drag.planeZ || 0;
      const totalDx = this.pointerStart ? event.clientX - this.pointerStart.x : dx;
      const totalDy = this.pointerStart ? event.clientY - this.pointerStart.y : dy;
      const moved = this.drag.moved || Math.hypot(dx, dy) > 0.2 || Math.hypot(totalDx, totalDy) > 0.2;
      this.drag = { x: event.clientX, y: event.clientY, mode, moved, action, planeZ };
      if (mode === "model") {
        const delta = this.screenDragDeltaOnPlane(fromX, fromY, event.clientX, event.clientY, planeZ);
        if (this.onModelDrag && (Math.abs(delta.x) > 0.0001 || Math.abs(delta.y) > 0.0001)) {
          this.onModelDrag(delta);
        }
      } else if (mode === "gizmo") {
        if (this.onGizmoDrag) {
          this.onGizmoDrag({
            action: this.activeGizmoAction,
            dx,
            dy,
            fromX: event.clientX - dx,
            fromY: event.clientY - dy,
            toX: event.clientX,
            toY: event.clientY
          });
        }
      } else if (mode === "pan") {
        this.pan(dx, dy);
      } else if (mode === "orbit") {
        this.orbit(dx, dy);
      }
    });
    this.canvas.addEventListener("pointerup", (event) => {
      const finishedDrag = this.drag;
      if (this.pointerStart?.clickable) {
        const dx = event.clientX - this.pointerStart.x;
        const dy = event.clientY - this.pointerStart.y;
        if (Math.hypot(dx, dy) < 4 && this.pointerStart.hit?.type !== "model") {
          this.pickAt(event.clientX, event.clientY, this.pointerStart.additive, { skipModels: this.pointerStart.hit?.type === "model" });
        }
      }
      if (finishedDrag?.mode === "model" && finishedDrag.moved && this.onModelDragEnd) {
        this.onModelDragEnd();
      }
      if (finishedDrag?.mode === "gizmo") {
        if (finishedDrag.moved && this.onGizmoDragEnd) this.onGizmoDragEnd({ action: finishedDrag.action || this.activeGizmoAction });
        this.activeGizmoAction = null;
        this.gizmoDragCenter = null;
      }
      this.pressedHit = null;
      this.setHoverHit(this.hitAt(event.clientX, event.clientY));
      this.drag = null;
      this.pointerStart = null;
    });
    this.canvas.addEventListener("pointercancel", () => {
      if (this.drag?.mode === "model" && this.drag.moved && this.onModelDragEnd) {
        this.onModelDragEnd();
      }
      if (this.drag?.mode === "gizmo") {
        if (this.drag.moved && this.onGizmoDragEnd) this.onGizmoDragEnd({ action: this.drag.action || this.activeGizmoAction });
        this.activeGizmoAction = null;
        this.gizmoDragCenter = null;
      }
      this.pressedHit = null;
      this.drag = null;
      this.pointerStart = null;
    });
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.drag) this.setHoverHit(null);
    });
    this.canvas.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (this.onSceneDoubleClick) this.onSceneDoubleClick(this.hitAt(event.clientX, event.clientY));
    });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.distance = clamp(this.distance * (1 + event.deltaY * 0.001), 25, 1200);
    }, { passive: false });
  }

  setProjectionMode(mode) {
    this.projectionMode = mode === "orthographic" ? "orthographic" : "perspective";
    this.renderFrame();
  }

  setNavigationMode(mode) {
    this.navigationMode = ["turntable", "trackball", "selection", "cursor"].includes(mode) ? mode : "turntable";
    if (this.navigationMode !== "trackball") this.roll = 0;
    this.renderFrame();
  }

  prepareOrbit(event, hit) {
    if (this.navigationMode === "selection" && this.activePartFocus) {
      this.target = [...this.activePartFocus];
      return;
    }
    if (this.navigationMode === "cursor") {
      const point = this.pointOnBuildPlane(event.clientX, event.clientY)
        || (hit?.bounds ? boundsCenter(hit.bounds) : null);
      if (point) this.target = point;
    }
  }

  cameraState(distance = this.distance) {
    const zAxis = normalize([
      Math.cos(this.pitch) * Math.sin(this.yaw),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
      Math.sin(this.pitch)
    ]);
    const eye = [
      this.target[0] + distance * zAxis[0],
      this.target[1] + distance * zAxis[1],
      this.target[2] + distance * zAxis[2]
    ];
    let right = cross([0, 0, 1], zAxis);
    right = length(right) < 0.0001 ? [1, 0, 0] : normalize(right);
    let up = normalize(cross(zAxis, right));
    if (this.roll) {
      const c = Math.cos(this.roll);
      const s = Math.sin(this.roll);
      const rolledRight = add(scaleVec(right, c), scaleVec(up, s));
      const rolledUp = add(scaleVec(up, c), scaleVec(right, -s));
      right = normalize(rolledRight);
      up = normalize(rolledUp);
    }
    return {
      eye,
      right,
      up,
      zAxis,
      forward: scaleVec(zAxis, -1)
    };
  }

  screenRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const { eye, forward, right, up } = this.cameraState();
    const tanHalfFov = Math.tan(this.fov / 2);
    const halfHeight = Math.max(1, this.distance * tanHalfFov);
    if (this.projectionMode === "orthographic") {
      return {
        origin: add(
          this.target,
          add(scaleVec(right, ndcX * halfHeight * aspect), scaleVec(up, ndcY * halfHeight))
        ),
        direction: forward
      };
    }
    return {
      origin: eye,
      direction: normalize(add(
        forward,
        add(scaleVec(right, ndcX * aspect * tanHalfFov), scaleVec(up, ndcY * tanHalfFov))
      ))
    };
  }

  intersectScreenPlane(clientX, clientY, planePoint, planeNormal, { rejectBehind = false } = {}) {
    const ray = this.screenRay(clientX, clientY);
    if (!ray) return null;
    const denom = dot(planeNormal, ray.direction);
    if (Math.abs(denom) < 0.00001) return null;
    const t = dot(sub(planePoint, ray.origin), planeNormal) / denom;
    if (!Number.isFinite(t) || (rejectBehind && t < 0)) return null;
    return add(ray.origin, scaleVec(ray.direction, t));
  }

  screenDragDeltaOnPlane(fromX, fromY, toX, toY, planeZ = 0) {
    const options = { rejectBehind: this.projectionMode !== "orthographic" };
    const planePoint = [0, 0, Number.isFinite(planeZ) ? planeZ : 0];
    const planeNormal = [0, 0, 1];
    const fromPoint = this.intersectScreenPlane(fromX, fromY, planePoint, planeNormal, options);
    const toPoint = this.intersectScreenPlane(toX, toY, planePoint, planeNormal, options);
    if (!fromPoint || !toPoint) return { x: 0, y: 0 };
    return {
      x: toPoint[0] - fromPoint[0],
      y: toPoint[1] - fromPoint[1]
    };
  }

  pointOnBuildPlane(clientX, clientY) {
    return this.intersectScreenPlane(clientX, clientY, [0, 0, 0], [0, 0, 1], {
      rejectBehind: this.projectionMode !== "orthographic"
    });
  }

  gizmoRotationDelta(drag) {
    if (!drag?.action?.startsWith("rotate-")) return 0;
    const center = this.gizmoDragCenter || this.activePartFocus;
    if (!center) return 0;
    const axis = drag.action.slice("rotate-".length);
    const normal = gizmoAxisDirection(axis);
    const [u, v] = gizmoArcBasis(axis);
    const fromPoint = this.intersectScreenPlane(drag.fromX, drag.fromY, center, normal);
    const toPoint = this.intersectScreenPlane(drag.toX, drag.toY, center, normal);
    const fromAngle = fromPoint ? planeAngleAroundCenter(fromPoint, center, u, v) : null;
    const toAngle = toPoint ? planeAngleAroundCenter(toPoint, center, u, v) : null;
    if (fromAngle !== null && toAngle !== null) {
      return clamp(radToDeg(normalizeAngle(toAngle - fromAngle)), -30, 30);
    }
    return this.screenAngleRotationDelta(drag, center, normal);
  }

  screenAngleRotationDelta(drag, center, axisNormal) {
    const projected = this.projectWorldPoint(center);
    if (!projected) return 0;
    const from = this.canvasLocalPoint(drag.fromX, drag.fromY);
    const to = this.canvasLocalPoint(drag.toX, drag.toY);
    const fromAngle = Math.atan2(from.y - projected[1], from.x - projected[0]);
    const toAngle = Math.atan2(to.y - projected[1], to.x - projected[0]);
    const facing = dot(axisNormal, this.cameraState().zAxis) < 0 ? -1 : 1;
    return clamp(radToDeg(normalizeAngle(toAngle - fromAngle)) * facing, -30, 30);
  }

  canvasLocalPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  setHoverHit(hit) {
    const interactiveTypes = ["plate", "add-plate", "model", "plate-action", "gizmo"];
    this.hoveredHit = hit && interactiveTypes.includes(hit.type) ? hit : null;
    this.canvas.style.cursor = hit && interactiveTypes.includes(hit.type) ? "pointer" : "default";
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
    const { right, up } = this.cameraState();
    const scale = Math.max(0.02, this.distance * 0.0015);
    for (let i = 0; i < 3; i++) {
      this.target[i] += (-dx * right[i] + dy * up[i]) * scale;
    }
  }

  orbit(dx, dy) {
    if (this.navigationMode === "trackball") {
      this.yaw -= dx * 0.008;
      this.pitch = clamp(this.pitch - dy * 0.007, deg(-84), deg(84));
      this.roll = normalizeAngle(this.roll - dx * 0.003 + dy * 0.0015);
    } else {
      this.roll = 0;
      this.yaw -= dx * 0.008;
      this.pitch = clamp(this.pitch - dy * 0.006, deg(10), deg(82));
    }
  }

  centerOnBuildPlate(plate) {
    if (!plate) return;
    this.target = [
      plate.origin.x + (plate.settings.printer.sizeX || 120) / 2,
      plate.origin.y + (plate.settings.printer.sizeY || 67.5) / 2,
      Math.min(35, (plate.settings.printer.sizeZ || 160) / 3)
    ];
  }

  centerOnBounds(bounds) {
    if (!bounds) return;
    this.target = boundsCenter(bounds);
    const span = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      bounds.maxZ - bounds.minZ,
      20
    );
    this.distance = clamp(span * 2.4, 30, 1200);
  }

  zoomToFitBuildPlateIfNeeded(plate) {
    const bed = {
      x: plate?.settings?.printer?.sizeX || 120,
      y: plate?.settings?.printer?.sizeY || 67.5,
      z: plate?.settings?.printer?.sizeZ || 160
    };
    if (!plate?.origin || !Number.isFinite(plate.origin.x) || !Number.isFinite(plate.origin.y)) return false;
    const border = plateBorderWidth(bed);
    return this.zoomToFitBoundsIfNeeded({
      minX: plate.origin.x - border,
      minY: plate.origin.y - border,
      minZ: 0,
      maxX: plate.origin.x + bed.x + border,
      maxY: plate.origin.y + bed.y + border,
      maxZ: 0.2
    });
  }

  zoomToFitBoundsIfNeeded(bounds, { margin = 36 } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !bounds) return false;
    const fitMargin = Math.max(0, Math.min(margin, rect.width * 0.18, rect.height * 0.18));
    const originalDistance = this.distance;
    const originalTarget = [...this.target];
    if (this.boundsFitViewport(bounds, fitMargin, originalDistance)) return false;

    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 1);
    const centerOffset = length(sub(boundsCenter(bounds), this.target));
    const sceneSpan = Math.max(this.bed.x, this.bed.y, this.bed.z, span);
    const maxDistance = Math.min(2800, Math.max(1200, originalDistance, centerOffset * 6 + span * 8, sceneSpan * 4));
    let low = originalDistance;
    let high = originalDistance;
    let foundFit = false;
    for (let i = 0; i < 24; i++) {
      high = Math.min(maxDistance, high * 1.28 + 4);
      if (this.boundsFitViewport(bounds, fitMargin, high)) {
        foundFit = true;
        break;
      }
      if (high >= maxDistance) break;
    }
    if (foundFit) {
      for (let i = 0; i < 28; i++) {
        const mid = (low + high) / 2;
        if (this.boundsFitViewport(bounds, fitMargin, mid)) {
          high = mid;
        } else {
          low = mid;
        }
      }
    } else {
      high = maxDistance;
    }
    this.target = originalTarget;
    this.distance = Math.max(originalDistance, high);
    this.renderFrame();
    return this.distance > originalDistance + 0.001;
  }

  boundsFitViewport(bounds, margin, distance) {
    const rect = this.canvas.getBoundingClientRect();
    const points = boundsCorners(bounds).map((point) => projectPoint(point, this.mvpForDistance(distance), this.canvas));
    if (points.some((point) => !point)) return false;
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return Math.min(...xs) >= margin
      && Math.max(...xs) <= rect.width - margin
      && Math.min(...ys) >= margin
      && Math.max(...ys) <= rect.height - margin;
  }

  mvpForDistance(distance = this.distance) {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const halfHeight = Math.max(1, distance * Math.tan(this.fov / 2));
    const projection = this.projectionMode === "orthographic"
      ? orthographic(-halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, 0.1, 3000)
      : perspective(this.fov, aspect, 0.1, 3000);
    const { eye, up } = this.cameraState(distance);
    return multiply(projection, lookAt(eye, this.target, up));
  }

  screenDeltaToBuildPlane(dx, dy) {
    const { right, up } = this.cameraState();
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
    const changed = this.canvas.width !== width || this.canvas.height !== height;
    if (changed) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    if (recenter) this.recenter();
    if (changed || recenter) this.renderFrame();
  }

  setBed(x, y, z) {
    this.bed = { x: x || 120, y: y || 67.5, z: z || 160 };
    this.recenter();
    this.distance = Math.max(this.bed.x, this.bed.y, this.bed.z) * 1.25;
    this.meshes.bed = makeMesh(this.gl, makeBedGeometry(this.bed), [0.35, 0.39, 0.43, 1], this.gl.TRIANGLES);
    this.meshes.grid = makeMesh(this.gl, makeGridGeometry(this.bed), [0.46, 0.52, 0.57, 1], this.gl.LINES);
  }

  setScene(scene) {
    this.scene = scene;
    this.bed = combinedSceneBed([...scene.plates, scene.nextPlate].filter(Boolean));
    const activePlate = scene.plates.find((plate) => plate.active);
    this.activePlateFocus = activePlate
      ? [
        activePlate.origin.x + activePlate.bed.x / 2,
        activePlate.origin.y + activePlate.bed.y / 2,
        Math.min(35, activePlate.bed.z / 3)
      ]
      : null;
    this.activePartFocus = scene.transformGizmo?.center ? [...scene.transformGizmo.center] : null;
    this.meshes.plates = scene.plates.map((plate) => ({
      id: plate.id,
      active: plate.active,
      bounds: {
        minX: plate.origin.x,
        minY: plate.origin.y,
        minZ: Math.min(0, plate.visual?.z || 0),
        maxX: plate.origin.x + plate.bed.x,
        maxY: plate.origin.y + plate.bed.y,
        maxZ: Math.max(0.05, (plate.visual?.z || 0) + 0.05)
      },
      bed: makeMesh(this.gl, makeBedGeometry(plate.bed, plate.origin, plate.visual), plate.active ? [0.36, 0.43, 0.5, 1] : [0.24, 0.27, 0.3, 1], this.gl.TRIANGLES),
      border: makeMesh(this.gl, makeRoundedPlateBorderGeometry(plate.bed, plate.origin, plate.visual), plate.active ? [0.42, 0.67, 0.95, 1] : [0.20, 0.27, 0.33, 1], this.gl.TRIANGLES),
      actions: makeBuildPlateActionMeshes(this.gl, plate)
    }));
    this.meshes.nextPlate = scene.nextPlate ? {
      id: scene.nextPlate.id,
      bounds: {
        minX: scene.nextPlate.origin.x,
        minY: scene.nextPlate.origin.y,
        minZ: 0,
        maxX: scene.nextPlate.origin.x + scene.nextPlate.bed.x,
        maxY: scene.nextPlate.origin.y + scene.nextPlate.bed.y,
        maxZ: 1.1
      },
      bed: makeMesh(this.gl, makeBedGeometry(scene.nextPlate.bed, scene.nextPlate.origin, scene.nextPlate.visual), [0.09, 0.125, 0.15, 1], this.gl.TRIANGLES),
      border: makeMesh(this.gl, makeRoundedPlateBorderGeometry(scene.nextPlate.bed, scene.nextPlate.origin, scene.nextPlate.visual), [0.24, 0.34, 0.4, 1], this.gl.TRIANGLES),
      plusPad: makeMesh(this.gl, makePlatePlusPadGeometry(scene.nextPlate.bed, scene.nextPlate.origin), [0.14, 0.195, 0.23, 1], this.gl.TRIANGLES),
      plusOutline: makeMesh(this.gl, makePlatePlusOutlineGeometry(scene.nextPlate.bed, scene.nextPlate.origin), [0.4, 0.55, 0.64, 1], this.gl.TRIANGLES),
      plus: makeMesh(this.gl, makePlatePlusGeometry(scene.nextPlate.bed, scene.nextPlate.origin), [0.82, 0.93, 1.0, 1], this.gl.TRIANGLES)
    } : null;
    const liveModelIds = new Set();
    this.meshes.models = scene.models.map((item) => {
      liveModelIds.add(item.id);
      let cached = this.modelMeshCache.get(item.id);
      if (!cached || cached.geometryKey !== item.geometryKey) {
        cached = {
          geometryKey: item.geometryKey,
          mesh: makeMesh(this.gl, { vertices: item.mesh.vertices, normals: item.mesh.normals }, item.color, this.gl.TRIANGLES, {
            clip: scene.clip.enabled,
            offset: item.offset,
            modelOrigin: item.modelOrigin,
            modelRotation: item.modelRotation,
            modelScale: item.modelScale,
            scale: item.scale,
            scaleOrigin: item.scaleOrigin
          })
        };
        this.modelMeshCache.set(item.id, cached);
      }
      cached.mesh.color = item.color;
      cached.mesh.clip = scene.clip.enabled;
      cached.mesh.offset = item.offset || [0, 0, 0];
      cached.mesh.modelOrigin = item.modelOrigin || [0, 0, 0];
      cached.mesh.modelRotation = item.modelRotation || [0, 0, 0];
      cached.mesh.modelScale = item.modelScale || 1;
      cached.mesh.scale = item.scale || [1, 1, 1];
      cached.mesh.scaleOrigin = item.scaleOrigin || [0, 0, 0];
      return {
        id: item.id,
        plateId: item.plateId,
        bounds: item.bounds,
        plateClipBox: item.plateClipBox,
        outOfBounds: !!item.outOfBounds,
        mesh: cached.mesh
      };
    });
    for (const id of this.modelMeshCache.keys()) {
      if (!liveModelIds.has(id)) this.modelMeshCache.delete(id);
    }
    this.meshes.selection = scene.selectionBoxes.length
      ? makeMesh(this.gl, makeSelectionBoxGeometry(scene.selectionBoxes), [1.0, 0.86, 0.26, 1], this.gl.LINES)
      : null;
    this.meshes.supports = makeMesh(this.gl, makeSupportGeometry(scene.supports, scene.supportBraces), [1.0, 0.63, 0.18, 1], this.gl.TRIANGLES);
    this.meshes.supportRaft = scene.supportRaft
      ? makeMesh(this.gl, makeSupportRaftGeometry(scene.supportRaft), scene.supportRaft.type === "skate" ? [0.95, 0.7, 0.2, 1] : [1.0, 0.62, 0.16, 1], this.gl.TRIANGLES)
      : null;
    this.meshes.clipPlane = scene.clip.enabled ? {
      surface: makeMesh(this.gl, makeClipPlaneSurfaceGeometry(scene.clip.plate, scene.clip.z), [1.0, 0.86, 0.16, 0.2], this.gl.TRIANGLES, { unlit: true }),
      outline: makeMesh(this.gl, makeClipPlaneOutlineGeometry(scene.clip.plate, scene.clip.z), [1.0, 0.86, 0.16, 1], this.gl.TRIANGLES, { unlit: true }),
      intersection: scene.clip.intersectionFill
        ? makeMesh(this.gl, scene.clip.intersectionFill, [1.0, 0.92, 0.22, 0.78], this.gl.TRIANGLES, { unlit: true })
        : null
    } : null;
    this.meshes.layerLines = scene.clip.enabled && scene.clip.showLayer && scene.clip.layerLines
      ? makeMesh(this.gl, scene.clip.layerLines, [1.0, 0.95, 0.45, 1], this.gl.LINES)
      : null;
    this.meshes.sliceLayer = scene.clip.enabled && scene.clip.sliceImage
      ? this.sliceLayerMesh(scene.clip.sliceImage)
      : null;
    this.meshes.gizmo = scene.transformGizmo ? makeTransformGizmo(this.gl, scene.transformGizmo) : null;
    this.clipZ = scene.clip.z;
    const plateActionPickables = this.meshes.plates.flatMap((plate) => (plate.actions || []).map((action) => ({
      type: "plate-action",
      id: `${plate.id}:${action.action}`,
      plateId: plate.id,
      action: action.action,
      bounds: action.bounds,
      pickPoints: action.pickPoints
    })));
    const gizmoPickables = this.meshes.gizmo
      ? this.meshes.gizmo.features.map((feature) => ({
        type: "gizmo",
        id: feature.action,
        action: feature.action,
        bounds: feature.bounds,
        pickPoints: feature.pickPoints,
        pickPadding: feature.pickPadding
      }))
      : [];
    this.pickables = [
      ...gizmoPickables,
      ...scene.models.map((item) => ({ type: "model", id: item.id, plateId: item.plateId, bounds: item.bounds })),
      ...plateActionPickables,
      ...scene.plates.map((plate) => ({
        type: "plate",
        id: plate.id,
        bounds: {
          minX: plate.origin.x,
          minY: plate.origin.y,
          minZ: Math.min(0, plate.visual?.z || 0),
          maxX: plate.origin.x + plate.bed.x,
          maxY: plate.origin.y + plate.bed.y,
          maxZ: Math.max(0.05, (plate.visual?.z || 0) + 0.05)
        }
      })),
      ...(scene.nextPlate ? [{
        type: "add-plate",
        id: scene.nextPlate.id,
        bounds: {
          minX: scene.nextPlate.origin.x,
          minY: scene.nextPlate.origin.y,
          minZ: 0,
          maxX: scene.nextPlate.origin.x + scene.nextPlate.bed.x,
          maxY: scene.nextPlate.origin.y + scene.nextPlate.bed.y,
          maxZ: 0.05
        }
      }] : [])
    ];
  }

  sliceLayerMesh(sliceImage) {
    if (!sliceImage?.cacheKey || !sliceImage.dataUrl) return null;
    let cached = this.sliceTextureCache.get(sliceImage.cacheKey);
    if (!cached) {
      cached = { texture: null, loading: true, mesh: null, geometryKey: "" };
      const image = new Image();
      image.onload = () => {
        try {
          cached.texture = createTextureFromImage(this.gl, image);
        } catch (error) {
          log(`Could not show sliced layer on clip plane: ${error.message}`);
        }
        cached.loading = false;
        cached.mesh = null;
        this.renderFrame();
      };
      image.onerror = () => {
        cached.loading = false;
      };
      image.src = sliceImage.dataUrl;
      this.sliceTextureCache.set(sliceImage.cacheKey, cached);
      while (this.sliceTextureCache.size > 12) {
        this.sliceTextureCache.delete(this.sliceTextureCache.keys().next().value);
      }
    }
    if (!cached.texture) return null;
    const geometryKey = [
      sliceImage.x,
      sliceImage.y,
      sliceImage.width,
      sliceImage.depth,
      sliceImage.z
    ].map((value) => Number(value || 0).toFixed(4)).join("|");
    if (!cached.mesh || cached.geometryKey !== geometryKey) {
      cached.mesh = makeTextureMesh(this.gl, makeSliceLayerGeometry(sliceImage), cached.texture);
      cached.geometryKey = geometryKey;
    }
    return cached.mesh;
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

  renderFrame() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.075, 0.09, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const halfHeight = Math.max(1, this.distance * Math.tan(this.fov / 2));
    const projection = this.projectionMode === "orthographic"
      ? orthographic(-halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, 0.1, 3000)
      : perspective(this.fov, aspect, 0.1, 3000);
    const { eye, up } = this.cameraState();
    const view = lookAt(eye, this.target, up);
    const mvp = multiply(projection, view);
    this.lastMvp = mvp;
    this.updatePickRects(mvp);
    const plateAlpha = this.isViewingBuildPlateUnderside() ? 0.5 : 1;
    const deferPlateSurfaces = plateAlpha < 1;

    if (this.meshes.nextPlate) {
      this.applyPlateInteractionColors(this.meshes.nextPlate, "add-plate", plateAlpha);
      if (!deferPlateSurfaces) this.drawBuildPlateSurface(this.meshes.nextPlate, mvp);
      drawMesh(gl, this.program, this.meshes.nextPlate.plusPad, mvp, this.clipZ);
      drawMesh(gl, this.program, this.meshes.nextPlate.plusOutline, mvp, this.clipZ);
      drawMesh(gl, this.program, this.meshes.nextPlate.plus, mvp, this.clipZ);
    }
    for (const plate of this.meshes.plates || []) {
      this.applyPlateInteractionColors(plate, "plate", plateAlpha);
      if (!deferPlateSurfaces) this.drawBuildPlateSurface(plate, mvp);
      if (!this.shouldShowPlateActions(plate)) continue;
      this.applyPlateActionColors(plate);
      for (const action of plate.actions || []) {
        drawMesh(gl, this.program, action.pad, mvp, this.clipZ);
        drawMesh(gl, this.program, action.outline, mvp, this.clipZ);
        drawMesh(gl, this.program, action.icon, mvp, this.clipZ);
      }
    }
    if (this.meshes.supportRaft) drawMesh(gl, this.program, this.meshes.supportRaft, mvp, this.clipZ);
    if (this.meshes.supports) drawMesh(gl, this.program, this.meshes.supports, mvp, this.clipZ);
    for (const item of this.meshes.models || []) {
      this.drawModelItem(item, mvp);
    }
    if (this.meshes.clipPlane) this.drawClipPlane(mvp);
    if (this.meshes.sliceLayer) this.drawSliceLayer(mvp);
    if (this.meshes.layerLines) drawMesh(gl, this.program, this.meshes.layerLines, mvp, this.clipZ);
    if (this.meshes.selection) drawMesh(gl, this.program, this.meshes.selection, mvp, this.clipZ);
    if (deferPlateSurfaces) this.drawTransparentBuildPlateSurfaces(mvp);
    this.drawGizmo(mvp);
    if (this.onFrame) this.onFrame();
  }

  draw() {
    this.renderFrame();
    requestAnimationFrame(() => this.draw());
  }

  isViewingBuildPlateUnderside() {
    return this.cameraState().zAxis[2] < -0.05;
  }

  drawBuildPlateSurface(plate, mvp) {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    drawMesh(gl, this.program, plate.bed, mvp, this.clipZ);
    drawMesh(gl, this.program, plate.border, mvp, this.clipZ);
    gl.enable(gl.CULL_FACE);
  }

  drawTransparentBuildPlateSurfaces(mvp) {
    const gl = this.gl;
    gl.depthMask(false);
    if (this.meshes.nextPlate) this.drawBuildPlateSurface(this.meshes.nextPlate, mvp);
    for (const plate of this.meshes.plates || []) this.drawBuildPlateSurface(plate, mvp);
    gl.depthMask(true);
  }

  drawTransparentMesh(mesh, mvp) {
    const gl = this.gl;
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    drawMesh(gl, this.program, mesh, mvp, this.clipZ);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  drawModelItem(item, mvp) {
    if (!item.outOfBounds || !item.plateClipBox) {
      item.mesh.boxClip = null;
      drawMesh(this.gl, this.program, item.mesh, mvp, this.clipZ);
      return;
    }
    const originalColor = item.mesh.color;
    const originalBoxClip = item.mesh.boxClip;
    const originalUnlit = item.mesh.unlit;
    item.mesh.boxClip = { ...item.plateClipBox, mode: "inside" };
    drawMesh(this.gl, this.program, item.mesh, mvp, this.clipZ);
    item.mesh.color = [1.0, 0.04, 0.03, 1];
    item.mesh.unlit = true;
    item.mesh.boxClip = { ...item.plateClipBox, mode: "outside" };
    drawMesh(this.gl, this.program, item.mesh, mvp, this.clipZ);
    item.mesh.color = originalColor;
    item.mesh.unlit = originalUnlit;
    item.mesh.boxClip = originalBoxClip || null;
  }

  drawClipPlane(mvp) {
    const clip = this.meshes.clipPlane;
    if (!clip) return;
    const gl = this.gl;
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    drawMesh(gl, this.program, clip.surface, mvp, this.clipZ);
    if (clip.intersection) drawMesh(gl, this.program, clip.intersection, mvp, this.clipZ);
    drawMesh(gl, this.program, clip.outline, mvp, this.clipZ);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  drawSliceLayer(mvp) {
    const gl = this.gl;
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    drawTextureMesh(gl, this.textureProgram, this.meshes.sliceLayer, mvp);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  applyPlateInteractionColors(plate, type, surfaceAlpha = 1) {
    const pressed = this.pressedHit?.type === type && this.pressedHit.id === plate.id;
    const hovered = this.hoveredHit?.type === type && this.hoveredHit.id === plate.id;
    if (type === "add-plate") {
      plate.bed.color = withAlpha(pressed ? [0.06, 0.34, 0.18, 1] : hovered ? [0.12, 0.16, 0.16, 1] : [0.09, 0.125, 0.15, 1], surfaceAlpha);
      plate.border.color = withAlpha(pressed ? [0.18, 0.92, 0.42, 1] : hovered ? [1.0, 0.86, 0.22, 1] : [0.24, 0.34, 0.4, 1], surfaceAlpha);
      if (plate.plusPad) plate.plusPad.color = pressed ? [0.08, 0.42, 0.22, 1] : hovered ? [0.20, 0.22, 0.16, 1] : [0.14, 0.195, 0.23, 1];
      if (plate.plusOutline) plate.plusOutline.color = pressed ? [0.18, 0.92, 0.42, 1] : hovered ? [1.0, 0.86, 0.22, 1] : [0.4, 0.55, 0.64, 1];
      plate.plus.color = pressed ? [0.68, 1.0, 0.74, 1] : hovered ? [1.0, 0.9, 0.32, 1] : [0.82, 0.93, 1.0, 1];
      return;
    }
    const baseBed = plate.active ? [0.36, 0.43, 0.5, 1] : [0.24, 0.27, 0.3, 1];
    plate.bed.color = withAlpha(pressed ? [0.08, 0.42, 0.22, 1] : baseBed, surfaceAlpha);
    plate.border.color = withAlpha(pressed
      ? [0.18, 0.92, 0.42, 1]
      : hovered
        ? [1.0, 0.86, 0.22, 1]
        : plate.active
          ? [0.42, 0.67, 0.95, 1]
          : [0.20, 0.27, 0.33, 1], surfaceAlpha);
  }

  applyPlateActionColors(plate) {
    for (const action of plate.actions || []) {
      const pressed = this.pressedHit?.type === "plate-action"
        && this.pressedHit.plateId === plate.id
        && this.pressedHit.action === action.action;
      const hovered = this.hoveredHit?.type === "plate-action"
        && this.hoveredHit.plateId === plate.id
        && this.hoveredHit.action === action.action;
      action.pad.color = pressed
        ? [0.08, 0.42, 0.22, 1]
        : hovered
          ? [0.28, 0.30, 0.18, 1]
          : action.padBaseColor;
      action.outline.color = pressed
        ? [0.18, 0.92, 0.42, 1]
        : hovered
          ? [1.0, 0.86, 0.22, 1]
          : action.outlineBaseColor;
      action.icon.color = pressed
        ? [0.68, 1.0, 0.74, 1]
        : hovered
          ? [1.0, 0.9, 0.32, 1]
          : action.iconBaseColor;
    }
  }

  shouldShowPlateActions(plate) {
    if (plate.active) return true;
    if (this.hoveredHit?.type === "plate" && this.hoveredHit.id === plate.id) return true;
    if (this.pressedHit?.type === "plate" && this.pressedHit.id === plate.id) return true;
    if (this.hoveredHit?.type === "plate-action" && this.hoveredHit.plateId === plate.id) return true;
    if (this.pressedHit?.type === "plate-action" && this.pressedHit.plateId === plate.id) return true;
    return false;
  }

  drawGizmo(mvp) {
    if (!this.meshes.gizmo) return;
    const gl = this.gl;
    const hoveredAction = this.hoveredHit?.type === "gizmo" ? this.hoveredHit.action : null;
    const activeAction = this.activeGizmoAction;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    for (const feature of this.meshes.gizmo.features) {
      if (activeAction && feature.action !== activeAction) continue;
      const state = activeAction || hoveredAction
        ? (feature.action === (activeAction || hoveredAction) ? "bright" : "dim")
        : "normal";
      const mesh = activeAction === feature.action && feature.kind === "rotate" && feature.activeMesh
        ? feature.activeMesh
        : feature.mesh;
      mesh.color = gizmoColor(feature.axis, state);
      drawMesh(gl, this.program, mesh, mvp, this.clipZ);
    }
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
  }

  pickAt(clientX, clientY, additive, options = {}) {
    const hit = this.hitAt(clientX, clientY, options);
    if (this.onScenePick) {
      this.onScenePick(hit
        ? { type: hit.type, id: hit.id, plateId: hit.plateId, action: hit.action, additive }
        : { type: "background", additive });
    }
  }

  hitAt(clientX, clientY, { skipModels = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return this.pickRects
      .filter((item) => !skipModels || !["model", "gizmo"].includes(item.type))
      .filter((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom)
      .sort((a, b) => hitPriority(a) - hitPriority(b) || a.area - b.area)[0];
  }

  updatePickRects(mvp) {
    this.pickRects = this.pickables.map((item) => {
      const sourcePoints = item.pickPoints || boundsCorners(item.bounds);
      const points = sourcePoints.map((point) => projectPoint(point, mvp, this.canvas));
      const visible = points.filter(Boolean);
      if (!visible.length) return null;
      const xs = visible.map((point) => point[0]);
      const ys = visible.map((point) => point[1]);
      const padding = item.pickPadding || 0;
      const left = Math.min(...xs) - padding;
      const right = Math.max(...xs) + padding;
      const top = Math.min(...ys) - padding;
      const bottom = Math.max(...ys) + padding;
      return { ...item, left, right, top, bottom, area: Math.max(1, (right - left) * (bottom - top)) };
    }).filter(Boolean);
  }

  projectWorldPoint(point) {
    if (!this.lastMvp) return null;
    return projectPoint(point, this.lastMvp, this.canvas);
  }
}

function combinedSceneBed(plates) {
  if (!plates.length) return { x: 120, y: 67.5, z: 160 };
  const maxX = Math.max(...plates.map((plate) => plate.origin.x + plate.bed.x));
  const maxY = Math.max(...plates.map((plate) => plate.origin.y + plate.bed.y));
  const maxZ = Math.max(...plates.map((plate) => plate.bed.z));
  return { x: maxX, y: maxY, z: maxZ };
}

function makeBedGeometry(bed, origin = { x: 0, y: 0 }, visual = {}) {
  const path = roundedRectPath(0, 0, bed.x, bed.y, plateCornerRadius(bed), 10);
  const center = plateVisualPoint(bed.x / 2, bed.y / 2, bed, origin, visual);
  const vertices = [];
  const normals = [];
  for (let i = 0; i < path.length; i++) {
    const next = (i + 1) % path.length;
    const a = plateVisualPoint(path[i][0], path[i][1], bed, origin, visual);
    const b = plateVisualPoint(path[next][0], path[next][1], bed, origin, visual);
    pushTri(vertices, normals, center, a, b, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function makeGridGeometry(bed, origin = { x: 0, y: 0 }, visual = {}) {
  const values = [];
  const radius = plateCornerRadius(bed);
  const step = Math.max(5, Math.round(Math.max(bed.x, bed.y) / 16));
  const gridVisual = { ...visual, z: (visual?.z || 0) + 0.045 };
  for (let x = 0; x <= bed.x + 0.01; x += step) {
    const xLocal = Math.min(x, bed.x);
    const [y0, y1] = roundedRectVerticalSpan(xLocal, bed, radius);
    if (y1 > y0) values.push(...plateVisualPoint(xLocal, y0, bed, origin, gridVisual), ...plateVisualPoint(xLocal, y1, bed, origin, gridVisual));
  }
  for (let y = 0; y <= bed.y + 0.01; y += step) {
    const yLocal = Math.min(y, bed.y);
    const [x0, x1] = roundedRectHorizontalSpan(yLocal, bed, radius);
    if (x1 > x0) values.push(...plateVisualPoint(x0, yLocal, bed, origin, gridVisual), ...plateVisualPoint(x1, yLocal, bed, origin, gridVisual));
  }
  const vertices = new Float32Array(values);
  const normals = new Float32Array(vertices.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return { vertices, normals };
}

function makeRoundedPlateBorderGeometry(bed, origin = { x: 0, y: 0 }, visual = {}) {
  const border = plateBorderWidth(bed);
  const radius = plateCornerRadius(bed);
  const outer = roundedRectPath(-border, -border, bed.x + border, bed.y + border, radius + border, 7);
  const inner = roundedRectPath(0, 0, bed.x, bed.y, radius, 7);
  const vertices = [];
  const normals = [];
  const borderVisual = { ...visual, z: (visual?.z || 0) + 0.16 };
  for (let i = 0; i < outer.length; i++) {
    const next = (i + 1) % outer.length;
    const a = plateVisualPoint(outer[i][0], outer[i][1], bed, origin, borderVisual);
    const b = plateVisualPoint(outer[next][0], outer[next][1], bed, origin, borderVisual);
    const c = plateVisualPoint(inner[next][0], inner[next][1], bed, origin, borderVisual);
    const d = plateVisualPoint(inner[i][0], inner[i][1], bed, origin, borderVisual);
    pushTri(vertices, normals, a, b, c, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
    pushTri(vertices, normals, a, c, d, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function plateBorderWidth(bed) {
  return Math.max(1.1, Math.min(bed.x, bed.y) * 0.009);
}

function plateActionReferenceBorderWidth(bed) {
  return plateBorderWidth(bed) * 2;
}

function plateCornerRadius(bed) {
  return Math.max(6, Math.min(bed.x, bed.y) * 0.06);
}

function roundedRectVerticalSpan(x, bed, radius) {
  let y0 = 0;
  let y1 = bed.y;
  if (x < radius) {
    const cut = roundedRectCut(radius - x, radius);
    y0 = Math.max(y0, cut);
    y1 = Math.min(y1, bed.y - cut);
  } else if (x > bed.x - radius) {
    const cut = roundedRectCut(x - (bed.x - radius), radius);
    y0 = Math.max(y0, cut);
    y1 = Math.min(y1, bed.y - cut);
  }
  return [y0, y1];
}

function roundedRectHorizontalSpan(y, bed, radius) {
  let x0 = 0;
  let x1 = bed.x;
  if (y < radius) {
    const cut = roundedRectCut(radius - y, radius);
    x0 = Math.max(x0, cut);
    x1 = Math.min(x1, bed.x - cut);
  } else if (y > bed.y - radius) {
    const cut = roundedRectCut(y - (bed.y - radius), radius);
    x0 = Math.max(x0, cut);
    x1 = Math.min(x1, bed.x - cut);
  }
  return [x0, x1];
}

function roundedRectCut(distanceFromCornerCenter, radius) {
  return radius - Math.sqrt(Math.max(0, radius * radius - distanceFromCornerCenter * distanceFromCornerCenter));
}

function roundedRectPath(x0, y0, x1, y1, radius, segments) {
  const r = Math.min(radius, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2);
  const corners = [
    { cx: x1 - r, cy: y0 + r, start: -Math.PI / 2, end: 0 },
    { cx: x1 - r, cy: y1 - r, start: 0, end: Math.PI / 2 },
    { cx: x0 + r, cy: y1 - r, start: Math.PI / 2, end: Math.PI },
    { cx: x0 + r, cy: y0 + r, start: Math.PI, end: Math.PI * 1.5 }
  ];
  const points = [];
  for (const corner of corners) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = corner.start + (corner.end - corner.start) * t;
      points.push([corner.cx + Math.cos(angle) * r, corner.cy + Math.sin(angle) * r]);
    }
  }
  return points;
}

function makePlatePlusGeometry(bed, origin = { x: 0, y: 0 }) {
  const size = Math.max(14, Math.min(bed.x, bed.y) * 0.16);
  const thick = Math.max(3, size * 0.22);
  const cx = bed.x / 2;
  const cy = bed.y / 2;
  return combineGeometry([
    makeLocalRectGeometry(cx - size / 2, cy - thick / 2, cx + size / 2, cy + thick / 2, bed, origin, 0.78),
    makeLocalRectGeometry(cx - thick / 2, cy - size / 2, cx + thick / 2, cy + size / 2, bed, origin, 0.98)
  ]);
}

function makePlatePlusPadGeometry(bed, origin = { x: 0, y: 0 }) {
  const rect = platePlusPadRect(bed);
  return makeLocalRoundedRectGeometry(rect, bed, origin, { z: 0 }, 0.34);
}

function makePlatePlusOutlineGeometry(bed, origin = { x: 0, y: 0 }) {
  const rect = platePlusPadRect(bed);
  rect.outlineWidth = Math.max(2, Math.min(bed.x, bed.y) * 0.018);
  return makeLocalRoundedRectBorderGeometry(rect, bed, origin, { z: 0 }, 0.54);
}

function platePlusPadRect(bed) {
  const size = Math.max(22, Math.min(bed.x, bed.y) * 0.28);
  const cx = bed.x / 2;
  const cy = bed.y / 2;
  return {
    x0: cx - size / 2,
    y0: cy - size / 2,
    x1: cx + size / 2,
    y1: cy + size / 2,
    radius: Math.max(4, size * 0.18)
  };
}

function makeBuildPlateActionMeshes(gl, plate) {
  const layout = plateActionLayout(plate.bed);
  return ["add", "delete"].map((action) => {
    const layers = buildPlateActionLayers();
    const rect = layout[action];
    const padGeometry = makeLocalRoundedRectGeometry(layout[action], plate.bed, plate.origin, plate.visual, layers.pad);
    const outlineGeometry = makeLocalRoundedRectBorderGeometry(layout[action], plate.bed, plate.origin, plate.visual, layers.outline);
    const iconGeometry = makePlateActionSvgIconGeometry(action, layout[action], plate.bed, plate.origin, plate.visual, layers.icon);
    return {
      action,
      bounds: localRectBounds(expandRect(layout[action], layout.outlineWidth || 2), plate.bed, plate.origin, plate.visual, layers.pad, 0.8),
      padBaseColor: action === "delete" ? [0.28, 0.14, 0.15, 1] : [0.16, 0.25, 0.34, 1],
      outlineBaseColor: [0.42, 0.67, 0.95, 1],
      iconBaseColor: action === "delete" ? [1.0, 0.55, 0.55, 1] : [0.78, 0.9, 1.0, 1],
      pad: makeMesh(gl, padGeometry, action === "delete" ? [0.28, 0.14, 0.15, 1] : [0.16, 0.25, 0.34, 1], gl.TRIANGLES),
      outline: makeMesh(gl, outlineGeometry, [0.42, 0.67, 0.95, 1], gl.TRIANGLES),
      icon: makeMesh(gl, iconGeometry, action === "delete" ? [1.0, 0.55, 0.55, 1] : [0.78, 0.9, 1.0, 1], gl.TRIANGLES)
    };
  });
}

function buildPlateActionLayers() {
  return {
    pad: 0.18,
    outline: 0.21,
    icon: 0.24
  };
}

function plateActionLayout(bed) {
  const size = clamp(Math.min(bed.x, bed.y) * 0.15, 16, 28);
  const outlineWidth = plateBorderWidth(bed);
  const plateGap = Math.max(3.4, size * 0.32);
  const buttonGap = Math.max(3.2, size * 0.28) + outlineWidth * 2;
  const referenceBorder = plateActionReferenceBorderWidth(bed);
  const x0 = bed.x + referenceBorder + plateGap + outlineWidth;
  const x1 = x0 + size;
  const addY1 = bed.y - referenceBorder - plateGap - outlineWidth;
  const addY0 = addY1 - size;
  const deleteY1 = addY0 - buttonGap;
  const deleteY0 = deleteY1 - size;
  return {
    add: { x0, y0: addY0, x1, y1: addY1, radius: size * 0.22, outlineWidth },
    delete: { x0, y0: deleteY0, x1, y1: deleteY1, radius: size * 0.22, outlineWidth },
    outlineWidth
  };
}

const PLATE_ACTION_ICON_SVGS = {
  add: {
    viewBox: [0, 0, 24, 24],
    path: "M10 4 H14 V10 H20 V14 H14 V20 H10 V14 H4 V10 H10 Z"
  },
  delete: {
    viewBox: [0, 0, 24, 24],
    path: "M9 4 H15 L16 6 H20 V8 H18 L17 20 H7 L6 8 H4 V6 H8 Z"
  }
};

function makePlateActionSvgIconGeometry(action, rect, bed, origin, visual, zOffset) {
  const icon = PLATE_ACTION_ICON_SVGS[action] || PLATE_ACTION_ICON_SVGS.add;
  const [minX, minY, width, height] = icon.viewBox;
  const points = parseSimpleSvgPath(icon.path);
  const size = Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const iconSize = size * 0.62;
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const x0 = cx - iconSize / 2;
  const y0 = cy - iconSize / 2;
  const localPoints = points.map((point) => [
    x0 + ((point[0] - minX) / width) * iconSize,
    y0 + (1 - (point[1] - minY) / height) * iconSize
  ]);
  const triangles = triangulatePolygon2d(localPoints);
  const vertices = [];
  const normals = [];
  const localVisual = { ...visual, z: (visual?.z || 0) + zOffset };
  for (const [a, b, c] of triangles) {
    pushFlatTriangle(
      vertices,
      normals,
      plateVisualPoint(a[0], a[1], bed, origin, localVisual),
      plateVisualPoint(b[0], b[1], bed, origin, localVisual),
      plateVisualPoint(c[0], c[1], bed, origin, localVisual),
      [0, 0, 1]
    );
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function parseSimpleSvgPath(path) {
  const tokens = String(path).match(/[MLHVZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const points = [];
  let index = 0;
  let command = "";
  let cursor = [0, 0];
  while (index < tokens.length) {
    const token = tokens[index++];
    if (/^[MLHVZ]$/i.test(token)) {
      command = token.toUpperCase();
      if (command === "Z") break;
      continue;
    }
    index -= 1;
    if (command === "M" || command === "L") {
      cursor = [Number(tokens[index++]), Number(tokens[index++])];
      points.push(cursor);
      command = command === "M" ? "L" : command;
    } else if (command === "H") {
      cursor = [Number(tokens[index++]), cursor[1]];
      points.push(cursor);
    } else if (command === "V") {
      cursor = [cursor[0], Number(tokens[index++])];
      points.push(cursor);
    } else {
      index += 1;
    }
  }
  return points;
}

function triangulatePolygon2d(points) {
  if (points.length < 3) return [];
  const working = polygonArea2d(points) < 0 ? [...points].reverse() : [...points];
  const triangles = [];
  let guard = working.length * working.length;
  while (working.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < working.length; i++) {
      const previous = working[(i + working.length - 1) % working.length];
      const current = working[i];
      const next = working[(i + 1) % working.length];
      if (!isConvexPolygonCorner(previous, current, next)) continue;
      if (working.some((point, pointIndex) => (
        pointIndex !== i
        && pointIndex !== (i + working.length - 1) % working.length
        && pointIndex !== (i + 1) % working.length
        && pointInTriangle2d(point, previous, current, next)
      ))) continue;
      triangles.push([previous, current, next]);
      working.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (working.length === 3) triangles.push([working[0], working[1], working[2]]);
  return triangles;
}

function polygonArea2d(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function isConvexPolygonCorner(a, b, c) {
  return ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 0;
}

function pointInTriangle2d(point, a, b, c) {
  const area = Math.abs(cross2d(a, b, c));
  const a0 = Math.abs(cross2d(point, a, b));
  const a1 = Math.abs(cross2d(point, b, c));
  const a2 = Math.abs(cross2d(point, c, a));
  return Math.abs(area - (a0 + a1 + a2)) < 1e-6;
}

function cross2d(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function makeLocalRoundedRectGeometry(rect, bed, origin, visual, zOffset) {
  const path = roundedRectPath(rect.x0, rect.y0, rect.x1, rect.y1, rect.radius || 0, 5);
  const center = plateVisualPoint((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, bed, origin, { ...visual, z: (visual?.z || 0) + zOffset });
  const vertices = [];
  const normals = [];
  const localVisual = { ...visual, z: (visual?.z || 0) + zOffset };
  for (let i = 0; i < path.length; i++) {
    const next = (i + 1) % path.length;
    const a = plateVisualPoint(path[i][0], path[i][1], bed, origin, localVisual);
    const b = plateVisualPoint(path[next][0], path[next][1], bed, origin, localVisual);
    pushTri(vertices, normals, center, a, b, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function makeLocalRoundedRectBorderGeometry(rect, bed, origin, visual, zOffset) {
  const width = rect.outlineWidth || Math.max(1.6, Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0) * 0.16);
  const outerRect = expandRect(rect, width);
  const innerRadius = rect.radius || 0;
  const outerRadius = innerRadius + width;
  const outer = roundedRectPath(outerRect.x0, outerRect.y0, outerRect.x1, outerRect.y1, outerRadius, 5);
  const inner = roundedRectPath(rect.x0, rect.y0, rect.x1, rect.y1, innerRadius, 5);
  const vertices = [];
  const normals = [];
  const localVisual = { ...visual, z: (visual?.z || 0) + zOffset };
  for (let i = 0; i < outer.length; i++) {
    const next = (i + 1) % outer.length;
    const a = plateVisualPoint(outer[i][0], outer[i][1], bed, origin, localVisual);
    const b = plateVisualPoint(outer[next][0], outer[next][1], bed, origin, localVisual);
    const c = plateVisualPoint(inner[next][0], inner[next][1], bed, origin, localVisual);
    const d = plateVisualPoint(inner[i][0], inner[i][1], bed, origin, localVisual);
    pushTri(vertices, normals, a, b, c, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
    pushTri(vertices, normals, a, c, d, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function expandRect(rect, amount) {
  return {
    x0: rect.x0 - amount,
    y0: rect.y0 - amount,
    x1: rect.x1 + amount,
    y1: rect.y1 + amount,
    radius: (rect.radius || 0) + amount
  };
}

function localRectBounds(rect, bed, origin, visual, zOffset, zPadding = 0) {
  const localVisual = { ...visual, z: (visual?.z || 0) + zOffset };
  const points = [
    plateVisualPoint(rect.x0, rect.y0, bed, origin, localVisual),
    plateVisualPoint(rect.x1, rect.y0, bed, origin, localVisual),
    plateVisualPoint(rect.x1, rect.y1, bed, origin, localVisual),
    plateVisualPoint(rect.x0, rect.y1, bed, origin, localVisual)
  ];
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const zs = points.map((point) => point[2]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    minZ: Math.min(...zs) - 0.5,
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    maxZ: Math.max(...zs) + zPadding
  };
}

function makeLocalRectGeometry(x0, y0, x1, y1, bed, origin, z) {
  const visual = { z };
  const vertices = new Float32Array([
    ...plateVisualPoint(x0, y0, bed, origin, visual),
    ...plateVisualPoint(x1, y0, bed, origin, visual),
    ...plateVisualPoint(x1, y1, bed, origin, visual),
    ...plateVisualPoint(x0, y0, bed, origin, visual),
    ...plateVisualPoint(x1, y1, bed, origin, visual),
    ...plateVisualPoint(x0, y1, bed, origin, visual)
  ]);
  const normals = new Float32Array(vertices.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return { vertices, normals };
}

function plateVisualPoint(x, y, bed, origin = { x: 0, y: 0 }, visual = {}) {
  const ox = origin.x || 0;
  const oy = origin.y || 0;
  const centerX = ox + bed.x / 2;
  const centerY = oy + bed.y / 2;
  const scaleX = visual.scaleX || 1;
  const scaleY = visual.scaleY || 1;
  return [
    centerX + (ox + x - centerX) * scaleX,
    centerY + (oy + y - centerY) * scaleY,
    visual.z || 0
  ];
}

function makeClipPlaneSurfaceGeometry(plate, z) {
  return makeBedGeometry(
    { x: plate.width, y: plate.depth },
    { x: plate.x, y: plate.y },
    { z }
  );
}

function makeClipPlaneOutlineGeometry(plate, z) {
  return makeRoundedPlateBorderGeometry(
    { x: plate.width, y: plate.depth },
    { x: plate.x, y: plate.y },
    { z: z + 0.08 }
  );
}

function makeClipIntersectionFill(plate, z) {
  const segments = [];
  for (const model of models.filter((item) => item.plateId === plate.id)) {
    const world = modelWorldMesh(model);
    if (z < world.bounds.minZ || z > world.bounds.maxZ) continue;
    for (let i = 0; i < world.vertices.length; i += 9) {
      const segment = trianglePlaneSegment([
        [world.vertices[i], world.vertices[i + 1], world.vertices[i + 2]],
        [world.vertices[i + 3], world.vertices[i + 4], world.vertices[i + 5]],
        [world.vertices[i + 6], world.vertices[i + 7], world.vertices[i + 8]]
      ], z);
      if (segment) segments.push(segment);
    }
  }
  if (!segments.length) return null;
  return fillClipSegments(segments, {
    x: plate.origin.x,
    y: plate.origin.y,
    width: plate.settings.printer.sizeX || 120,
    depth: plate.settings.printer.sizeY || 67.5,
    z: z + 0.12
  });
}

function trianglePlaneSegment(triangle, z) {
  const points = [];
  for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
    const point = edgePlaneIntersection(a, b, z);
    if (!point) continue;
    if (!points.some((existing) => samePoint2d(existing, point))) points.push(point);
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (length(sub(points[0], points[points.length - 1])) <= 0.001) return null;
  return [points[0], points[points.length - 1]];
}

function samePoint2d(a, b) {
  return Math.abs(a[0] - b[0]) < 0.001 && Math.abs(a[1] - b[1]) < 0.001;
}

function fillClipSegments(segments, plate) {
  const cell = Math.max(0.35, Math.min(1.2, Math.min(plate.width, plate.depth) / 220));
  const rows = Math.max(1, Math.ceil(plate.depth / cell));
  const vertices = [];
  const normals = [];
  for (let row = 0; row < rows; row++) {
    const yLocal = Math.min(plate.depth, (row + 0.5) * cell);
    const yWorld = plate.y + yLocal;
    const xs = [];
    for (const [a, b] of segments) {
      const ay = a[1];
      const by = b[1];
      if (Math.abs(ay - by) < 0.0001) continue;
      if ((ay <= yWorld && yWorld < by) || (by <= yWorld && yWorld < ay)) {
        const t = (yWorld - ay) / (by - ay);
        xs.push(a[0] + (b[0] - a[0]) * t);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const y0 = plate.y + row * cell;
    const y1 = Math.min(plate.y + plate.depth, y0 + cell);
    for (let index = 0; index < xs.length - 1; index += 2) {
      const x0 = clamp(xs[index], plate.x, plate.x + plate.width);
      const x1 = clamp(xs[index + 1], plate.x, plate.x + plate.width);
      if (x1 - x0 <= 0.001) continue;
      pushWorldRect(vertices, normals, x0, y0, x1, y1, plate.z);
    }
  }
  if (!vertices.length) return null;
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function pushWorldRect(vertices, normals, x0, y0, x1, y1, z) {
  vertices.push(
    x0, y0, z,
    x1, y0, z,
    x1, y1, z,
    x0, y0, z,
    x1, y1, z,
    x0, y1, z
  );
  for (let i = 0; i < 6; i++) normals.push(0, 0, 1);
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
    const postRadius = support.postRadius || 0.28;
    const tipRadius = support.tipRadius || 0.18;
    addSegmentCylinder(vertices, normals, base, joint, postRadius, 30);
    addSphere(vertices, normals, joint, Math.max(postRadius, tipRadius), 42, 21);
    if ((support.kind || "bed") === "bed") {
      addCylinder(vertices, normals, baseX, baseY, 0, support.bedInterfaceThickness || 0.35, support.footRadius || 0.8, 16);
    } else {
      addSegmentCylinder(vertices, normals, base, pointBetween(base, joint, 0.2), tipRadius, 30);
    }
    addTipGeometry(vertices, normals, joint, top, support);
  }
  for (const brace of braces || []) {
    const z0 = Number.isFinite(brace.z0) ? brace.z0 : brace.z;
    const z1 = Number.isFinite(brace.z1) ? brace.z1 : z0;
    addSegmentCylinder(
      vertices,
      normals,
      [brace.x0, brace.y0, z0],
      [brace.x1, brace.y1, z1],
      brace.radius || 0.18,
      18
    );
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function addTipGeometry(vertices, normals, start, top, support) {
  const postRadius = support.postRadius || 0.28;
  const tipRadius = support.tipRadius || 0.18;
  const type = support.tipType || "cone";
  if (support.sphericalContactEnabled) {
    const radius = Math.max(0.01, (support.sphericalContactDiameter || 0.6) / 2);
    addSphere(vertices, normals, sphericalContactCenter(top, support, radius), radius, 18, 9);
  }
  if (type === "cylinder") {
    addSegmentCylinder(vertices, normals, start, top, tipRadius, 30);
    return;
  }
  if (type === "sphere") {
    const bulbRadius = Math.max(postRadius * 1.45, tipRadius * 2.2);
    const middle = pointBetween(start, top, 0.58);
    addTaperedSegment(vertices, normals, start, middle, postRadius, bulbRadius, 36);
    addSphere(vertices, normals, middle, bulbRadius, 36, 18);
    addTaperedSegment(vertices, normals, middle, top, bulbRadius, tipRadius, 36);
    return;
  }
  addTaperedSegment(vertices, normals, start, top, postRadius, tipRadius, 30);
}

function sphericalContactCenter(contactPoint, support, radius) {
  const inset = Math.min(Math.max(0, support.sphericalContactInset || 0), radius * 2);
  const normal = supportSurfaceNormal(support);
  return add(contactPoint, scaleVec(normal, radius - inset));
}

function supportSurfaceNormal(support) {
  const raw = support.normal || {};
  let normal = [
    Number.isFinite(raw.x) ? raw.x : 0,
    Number.isFinite(raw.y) ? raw.y : 0,
    Number.isFinite(raw.z) ? raw.z : -1
  ];
  if (normal[2] > 0) normal = scaleVec(normal, -1);
  if (length(normal) < 0.0001) return [0, 0, -1];
  normal = normalize(normal);
  return normal[2] > -0.05 ? normalize([normal[0] * 0.35, normal[1] * 0.35, -1]) : normal;
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
  const negativeAxis = scaleVec(axis, -1);
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
    if (startRadius > 0.001) pushTri(vertices, normals, start, p1, p0, negativeAxis, negativeAxis, negativeAxis);
    if (endRadius > 0.001) pushTri(vertices, normals, end, p3, p2, axis, axis, axis);
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

const GIZMO_ARC_START = Math.PI * 15 / 180;
const GIZMO_ARC_END = Math.PI * 75 / 180;
const GIZMO_ARC_SWEEP = GIZMO_ARC_END - GIZMO_ARC_START;

function makeTransformGizmo(gl, gizmo) {
  const moveLength = gizmo.length;
  const arrowLength = gizmo.length * 1.28;
  const arrowStroke = Math.max(0.72, gizmo.radius * 2.45);
  const arcRadius = gizmo.length * 0.82;
  const stroke = Math.max(1.1, gizmo.radius * 3.6);
  const rotationTubeRadius = Math.max(0.32, stroke * 0.28);
  const specs = [
    { action: "move-x", axis: "x", kind: "move" },
    { action: "move-y", axis: "y", kind: "move" },
    { action: "move-z", axis: "z", kind: "move" },
    { action: "move-xy", axis: "z", kind: "plane" },
    { action: "rotate-x", axis: "x", kind: "rotate" },
    { action: "rotate-y", axis: "y", kind: "rotate" },
    { action: "rotate-z", axis: "z", kind: "rotate" }
  ];
  return {
    features: specs.map((spec) => {
      const featureLength = spec.kind === "move" ? arrowLength : moveLength;
      const featureStroke = spec.kind === "move" ? arrowStroke : stroke;
      const geometry = spec.kind === "move"
        ? makeGizmoMoveGeometry(gizmo.center, spec.axis, arrowLength, arrowStroke)
        : spec.kind === "plane"
          ? makeGizmoPlaneSquareGeometry(gizmo.center, spec.axis, moveLength, stroke)
          : makeGizmoArcGeometry(gizmo.center, spec.axis, arcRadius, rotationTubeRadius, { fullCircle: true });
      const activeGeometry = spec.kind === "rotate"
        ? makeGizmoArcGeometry(gizmo.center, spec.axis, arcRadius, rotationTubeRadius, { fullCircle: true })
        : null;
      const points = gizmoFeaturePoints(gizmo.center, spec, featureLength, arcRadius, featureStroke);
      return {
        ...spec,
        bounds: boundsFromPoints(points, Math.max(4, featureStroke * 3.2)),
        pickPoints: points,
        pickPadding: spec.kind === "plane" ? Math.max(4, stroke * 1.8) : Math.max(6, featureStroke * 2.4),
        mesh: makeMesh(gl, geometry, gizmoColor(spec.axis, "normal"), gl.TRIANGLES, { unlit: true }),
        activeMesh: activeGeometry ? makeMesh(gl, activeGeometry, gizmoColor(spec.axis, "normal"), gl.TRIANGLES, { unlit: true }) : null
      };
    })
  };
}

function makeGizmoMoveGeometry(center, axis, lengthValue, stroke) {
  const vertices = [];
  const normals = [];
  const direction = gizmoAxisDirection(axis);
  const startAlong = Math.max(stroke * 1.35, lengthValue * 0.075);
  const coneLength = clamp(lengthValue * 0.24, stroke * 2.8, lengthValue * 0.34);
  const shaftRadius = Math.max(0.22, stroke * 0.22);
  const coneRadius = Math.max(shaftRadius * 2.6, stroke * 1.05);
  const shaftStart = add(center, scaleVec(direction, startAlong));
  const shaftEnd = add(center, scaleVec(direction, lengthValue - coneLength));
  const coneTip = add(center, scaleVec(direction, lengthValue));

  addGizmoTaperedSegment(vertices, normals, shaftStart, shaftEnd, shaftRadius, shaftRadius, 24, {
    capStart: true,
    capEnd: false
  });
  addGizmoTaperedSegment(vertices, normals, shaftEnd, coneTip, coneRadius, 0, 32, {
    capStart: true,
    capEnd: false
  });

  return {
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals)
  };
}

function makeGizmoArcGeometry(center, axis, radius, stroke, { fullCircle = false } = {}) {
  const vertices = [];
  const normals = [];
  const [u, v] = gizmoArcBasis(axis);
  const normal = gizmoAxisDirection(axis);
  const halfWidth = Math.max(0.05, stroke);
  const innerRadius = Math.max(0.01, radius - halfWidth);
  const outerRadius = radius + halfWidth;
  const startAngle = fullCircle ? 0 : GIZMO_ARC_START;
  const endAngle = fullCircle ? Math.PI * 2 : GIZMO_ARC_END;
  const segments = fullCircle ? 128 : 32;
  for (let i = 0; i < segments; i++) {
    const a0 = startAngle + (i / segments) * (endAngle - startAngle);
    const a1 = startAngle + ((i + 1) / segments) * (endAngle - startAngle);
    pushFlatQuad(
      vertices,
      normals,
      gizmoArcPoint(center, u, v, outerRadius, a0),
      gizmoArcPoint(center, u, v, outerRadius, a1),
      gizmoArcPoint(center, u, v, innerRadius, a1),
      gizmoArcPoint(center, u, v, innerRadius, a0),
      normal
    );
  }
  if (!fullCircle) {
    addGizmoArcCap(vertices, normals, center, u, v, radius, startAngle, halfWidth, normal, -1);
    addGizmoArcCap(vertices, normals, center, u, v, radius, endAngle, halfWidth, normal, 1);
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function addGizmoArcCap(vertices, normals, center, u, v, radius, angle, halfWidth, normal, tangentSign) {
  const capCenter = gizmoArcPoint(center, u, v, radius, angle);
  const radial = normalize(add(scaleVec(u, Math.cos(angle)), scaleVec(v, Math.sin(angle))));
  const tangent = normalize(add(scaleVec(u, -Math.sin(angle)), scaleVec(v, Math.cos(angle))));
  const capSegments = 12;
  for (let i = 0; i < capSegments; i++) {
    const a0 = (i / capSegments) * Math.PI;
    const a1 = ((i + 1) / capSegments) * Math.PI;
    const p0 = add(capCenter, add(
      scaleVec(radial, Math.cos(a0) * halfWidth),
      scaleVec(tangent, Math.sin(a0) * halfWidth * tangentSign)
    ));
    const p1 = add(capCenter, add(
      scaleVec(radial, Math.cos(a1) * halfWidth),
      scaleVec(tangent, Math.sin(a1) * halfWidth * tangentSign)
    ));
    pushFlatTriangle(vertices, normals, capCenter, p0, p1, normal);
  }
}

function makeGizmoPlaneSquareGeometry(center, lockedAxis, lengthValue, stroke) {
  const vertices = [];
  const normals = [];
  const { squareCenter, u, v, halfSize, radius, normal } = gizmoPlaneSquareMetrics(center, lockedAxis, lengthValue, stroke);
  const path = roundedRectPath(-halfSize, -halfSize, halfSize, halfSize, radius, 5);
  for (let i = 0; i < path.length; i++) {
    const next = (i + 1) % path.length;
    pushFlatTriangle(
      vertices,
      normals,
      squareCenter,
      add(squareCenter, add(scaleVec(u, path[i][0]), scaleVec(v, path[i][1]))),
      add(squareCenter, add(scaleVec(u, path[next][0]), scaleVec(v, path[next][1]))),
      normal
    );
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function gizmoFeaturePoints(center, spec, moveLength, arcRadius, stroke) {
  if (spec.kind === "move") {
    return [center, add(center, scaleVec(gizmoAxisDirection(spec.axis), moveLength))];
  }
  if (spec.kind === "plane") {
    return gizmoPlaneSquareCorners(center, spec.axis, moveLength, stroke);
  }
  return gizmoArcPoints(center, spec.axis, arcRadius, 24, { fullCircle: true });
}

function gizmoPlaneSquareCorners(center, lockedAxis, lengthValue, stroke) {
  const { squareCenter, u, v, halfSize } = gizmoPlaneSquareMetrics(center, lockedAxis, lengthValue, stroke);
  return [
    add(squareCenter, add(scaleVec(u, -halfSize), scaleVec(v, -halfSize))),
    add(squareCenter, add(scaleVec(u, halfSize), scaleVec(v, -halfSize))),
    add(squareCenter, add(scaleVec(u, halfSize), scaleVec(v, halfSize))),
    add(squareCenter, add(scaleVec(u, -halfSize), scaleVec(v, halfSize)))
  ];
}

function gizmoPlaneSquareMetrics(center, lockedAxis, lengthValue, stroke) {
  const [u, v] = gizmoPlaneAxes(lockedAxis);
  const halfSize = Math.max(stroke * 1.125, lengthValue * 0.0525);
  const gap = Math.max(stroke * 0.35, lengthValue * 0.018);
  const offset = stroke * 1.1 + halfSize + gap;
  const squareCenter = add(center, add(scaleVec(u, offset), scaleVec(v, offset)));
  return {
    squareCenter,
    u,
    v,
    halfSize,
    radius: halfSize * 0.28,
    normal: gizmoAxisDirection(lockedAxis)
  };
}

function gizmoArcPoint(center, u, v, radius, angle) {
  return add(center, add(scaleVec(u, Math.cos(angle) * radius), scaleVec(v, Math.sin(angle) * radius)));
}

function gizmoArcPoints(center, axis, radius, segments, { fullCircle = false } = {}) {
  const [u, v] = gizmoArcBasis(axis);
  const points = [];
  const startAngle = fullCircle ? 0 : GIZMO_ARC_START;
  const sweep = fullCircle ? Math.PI * 2 : GIZMO_ARC_SWEEP;
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + (i / segments) * sweep;
    points.push(gizmoArcPoint(center, u, v, radius, angle));
  }
  return points;
}

function gizmoAxisDirection(axis) {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function gizmoArcBasis(axis) {
  if (axis === "x") return [[0, 1, 0], [0, 0, 1]];
  if (axis === "y") return [[1, 0, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}

function gizmoPlaneAxes(lockedAxis) {
  if (lockedAxis === "x") return [[0, 1, 0], [0, 0, 1]];
  if (lockedAxis === "y") return [[1, 0, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}

function gizmoMovePlaneNormal(axis) {
  return axis === "z" ? [0, 1, 0] : [0, 0, 1];
}

function addGizmoTaperedSegment(vertices, normals, start, end, startRadius, endRadius, segments, options = {}) {
  if (length(sub(end, start)) < 0.001) return;
  const axis = normalize(sub(end, start));
  const negativeAxis = scaleVec(axis, -1);
  const reference = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = normalize(cross(axis, reference));
  const v = normalize(cross(axis, u));
  const capStart = options.capStart !== false;
  const capEnd = options.capEnd !== false;
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
    if (endRadius > 0.001) pushTri(vertices, normals, p0, p2, p3, n0, n1, n0);
    if (capStart && startRadius > 0.001) pushTri(vertices, normals, start, p1, p0, negativeAxis, negativeAxis, negativeAxis);
    if (capEnd && endRadius > 0.001) pushTri(vertices, normals, end, p3, p2, axis, axis, axis);
  }
}

function pushFlatQuad(vertices, normals, a, b, c, d, normal) {
  pushTri(vertices, normals, a, b, c, normal, normal, normal);
  pushTri(vertices, normals, a, c, d, normal, normal, normal);
}

function pushFlatTriangle(vertices, normals, a, b, c, normal) {
  pushTri(vertices, normals, a, b, c, normal, normal, normal);
}

function pushFlatPolygon(vertices, normals, points, normal) {
  if (points.length < 3) return;
  const center = points.reduce((sum, point) => add(sum, point), [0, 0, 0]).map((value) => value / points.length);
  for (let i = 0; i < points.length; i++) {
    pushFlatTriangle(vertices, normals, center, points[i], points[(i + 1) % points.length], normal);
  }
}

function gizmoColor(axis, state) {
  const palette = {
    x: {
      normal: [0.75, 0.16, 0.16, 0.5],
      bright: [1.0, 0.22, 0.22, 0.5],
      dim: [0.5, 0.09, 0.09, 0.5]
    },
    y: {
      normal: [0.16, 0.75, 0.16, 0.5],
      bright: [0.22, 1.0, 0.22, 0.5],
      dim: [0.09, 0.5, 0.09, 0.5]
    },
    z: {
      normal: [0.18, 0.34, 0.75, 0.5],
      bright: [0.26, 0.5, 1.0, 0.5],
      dim: [0.10, 0.18, 0.5, 0.5]
    }
  };
  return palette[axis]?.[state] || [0.75, 0.75, 0.75, 0.5];
}

function withAlpha(color, alpha) {
  return [color[0], color[1], color[2], clamp(alpha, 0, 1)];
}

function boundsFromPoints(points, padding) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const zs = points.map((point) => point[2]);
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    minZ: Math.min(...zs) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
    maxZ: Math.max(...zs) + padding
  };
}

function hitPriority(item) {
  if (item.type === "gizmo") return 0;
  if (item.type === "plate-action") return 1;
  if (item.type === "model") return 2;
  if (item.type === "add-plate") return 3;
  if (item.type === "plate") return 4;
  return 9;
}

function makeMesh(gl, geometry, color, mode, options = {}) {
  const vao = {
    count: geometry.vertices.length / 3,
    color,
    mode,
    clip: !!options.clip,
    offset: options.offset || [0, 0, 0],
    modelOrigin: options.modelOrigin || [0, 0, 0],
    modelRotation: options.modelRotation || [0, 0, 0],
    modelScale: options.modelScale || 1,
    scale: options.scale || [1, 1, 1],
    scaleOrigin: options.scaleOrigin || [0, 0, 0],
    boxClip: options.boxClip || null,
    unlit: !!options.unlit,
    positions: gl.createBuffer(),
    normals: gl.createBuffer()
  };
  gl.bindBuffer(gl.ARRAY_BUFFER, vao.positions);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, vao.normals);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
  return vao;
}

function makeSliceLayerGeometry(sliceImage) {
  const z = (sliceImage.z || 0) + 0.18;
  const x0 = sliceImage.x || 0;
  const y0 = sliceImage.y || 0;
  const x1 = x0 + (sliceImage.width || 1);
  const y1 = y0 + (sliceImage.depth || 1);
  return {
    vertices: new Float32Array([
      x0, y0, z,
      x1, y0, z,
      x1, y1, z,
      x0, y0, z,
      x1, y1, z,
      x0, y1, z
    ]),
    texCoords: new Float32Array([
      0, 1,
      1, 1,
      1, 0,
      0, 1,
      1, 0,
      0, 0
    ])
  };
}

function makeTextureMesh(gl, geometry, texture) {
  const mesh = {
    count: geometry.vertices.length / 3,
    mode: gl.TRIANGLES,
    texture,
    positions: gl.createBuffer(),
    texCoords: gl.createBuffer()
  };
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.texCoords);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.texCoords, gl.STATIC_DRAW);
  return mesh;
}

function createTextureFromImage(gl, image) {
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (image.width > maxTextureSize || image.height > maxTextureSize) {
    throw new Error(`slice image ${image.width}x${image.height} exceeds WebGL texture limit ${maxTextureSize}`);
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createProgram(gl) {
  const vs = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uMvp;
    uniform vec3 uOffset;
    uniform vec3 uModelOrigin;
    uniform vec3 uModelRotation;
    uniform float uModelScale;
    uniform vec3 uScale;
    uniform vec3 uScaleOrigin;
    varying float vLight;
    varying float vZ;
    varying vec3 vWorld;
    vec3 rotateModel(vec3 p) {
      float cx = cos(uModelRotation.x);
      float sx = sin(uModelRotation.x);
      p.yz = vec2(p.y * cx - p.z * sx, p.y * sx + p.z * cx);
      float cy = cos(uModelRotation.y);
      float sy = sin(uModelRotation.y);
      p.xz = vec2(p.x * cy + p.z * sy, -p.x * sy + p.z * cy);
      float cz = cos(uModelRotation.z);
      float sz = sin(uModelRotation.z);
      p.xy = vec2(p.x * cz - p.y * sz, p.x * sz + p.y * cz);
      return p;
    }
    void main() {
      vec3 local = (aPosition - uModelOrigin) * uModelScale;
      vec3 transformed = rotateModel(local) + uModelOrigin;
      vec3 position = ((transformed - uScaleOrigin) * uScale) + uScaleOrigin + uOffset;
      vec3 light = normalize(vec3(0.35, -0.45, 0.82));
      vLight = max(0.25, dot(normalize(rotateModel(aNormal)), light));
      vZ = position.z;
      vWorld = position;
      gl_Position = uMvp * vec4(position, 1.0);
    }
  `;
  const fs = `
    precision highp float;
    uniform vec4 uColor;
    uniform float uClipZ;
    uniform bool uUseClip;
    uniform bool uUseBoxClip;
    uniform int uBoxClipMode;
    uniform vec2 uBoxClipMin;
    uniform vec2 uBoxClipMax;
    uniform bool uUnlit;
    varying float vLight;
    varying float vZ;
    varying vec3 vWorld;
    void main() {
      if (uUseClip && vZ > uClipZ) discard;
      if (uUseBoxClip) {
        bool insideBox = vWorld.x >= uBoxClipMin.x
          && vWorld.x <= uBoxClipMax.x
          && vWorld.y >= uBoxClipMin.y
          && vWorld.y <= uBoxClipMax.y;
        if ((uBoxClipMode == 0 && !insideBox) || (uBoxClipMode == 1 && insideBox)) discard;
      }
      float light = uUnlit ? 1.0 : vLight;
      gl_FragColor = vec4(uColor.rgb * light, uColor.a);
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
    uOffset: gl.getUniformLocation(program, "uOffset"),
    uModelOrigin: gl.getUniformLocation(program, "uModelOrigin"),
    uModelRotation: gl.getUniformLocation(program, "uModelRotation"),
    uModelScale: gl.getUniformLocation(program, "uModelScale"),
    uScale: gl.getUniformLocation(program, "uScale"),
    uScaleOrigin: gl.getUniformLocation(program, "uScaleOrigin"),
    uColor: gl.getUniformLocation(program, "uColor"),
    uClipZ: gl.getUniformLocation(program, "uClipZ"),
    uUseClip: gl.getUniformLocation(program, "uUseClip"),
    uUseBoxClip: gl.getUniformLocation(program, "uUseBoxClip"),
    uBoxClipMode: gl.getUniformLocation(program, "uBoxClipMode"),
    uBoxClipMin: gl.getUniformLocation(program, "uBoxClipMin"),
    uBoxClipMax: gl.getUniformLocation(program, "uBoxClipMax"),
    uUnlit: gl.getUniformLocation(program, "uUnlit")
  };
}

function createTextureProgram(gl) {
  const vs = `
    attribute vec3 aPosition;
    attribute vec2 aTexCoord;
    uniform mat4 uMvp;
    varying vec2 vTexCoord;
    void main() {
      vTexCoord = aTexCoord;
      gl_Position = uMvp * vec4(aPosition, 1.0);
    }
  `;
  const fs = `
    precision highp float;
    uniform sampler2D uTexture;
    uniform float uAlpha;
    varying vec2 vTexCoord;
    void main() {
      vec4 sampleColor = texture2D(uTexture, vTexCoord);
      float mask = max(sampleColor.r, sampleColor.a < 1.0 ? sampleColor.a : 0.0);
      if (mask < 0.01) discard;
      gl_FragColor = vec4(1.0, 0.92, 0.22, uAlpha * mask);
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
    aTexCoord: gl.getAttribLocation(program, "aTexCoord"),
    uMvp: gl.getUniformLocation(program, "uMvp"),
    uTexture: gl.getUniformLocation(program, "uTexture"),
    uAlpha: gl.getUniformLocation(program, "uAlpha")
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
  gl.uniform3fv(program.uOffset, mesh.offset || [0, 0, 0]);
  gl.uniform3fv(program.uModelOrigin, mesh.modelOrigin || [0, 0, 0]);
  gl.uniform3fv(program.uModelRotation, mesh.modelRotation || [0, 0, 0]);
  gl.uniform1f(program.uModelScale, mesh.modelScale || 1);
  gl.uniform3fv(program.uScale, mesh.scale || [1, 1, 1]);
  gl.uniform3fv(program.uScaleOrigin, mesh.scaleOrigin || [0, 0, 0]);
  gl.uniform4fv(program.uColor, mesh.color);
  gl.uniform1f(program.uClipZ, clipZ);
  gl.uniform1i(program.uUseClip, mesh.clip ? 1 : 0);
  const boxClip = mesh.boxClip || null;
  gl.uniform1i(program.uUseBoxClip, boxClip ? 1 : 0);
  gl.uniform1i(program.uBoxClipMode, boxClip?.mode === "outside" ? 1 : 0);
  gl.uniform2fv(program.uBoxClipMin, boxClip ? [boxClip.minX, boxClip.minY] : [0, 0]);
  gl.uniform2fv(program.uBoxClipMax, boxClip ? [boxClip.maxX, boxClip.maxY] : [0, 0]);
  gl.uniform1i(program.uUnlit, mesh.unlit ? 1 : 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
  gl.enableVertexAttribArray(program.aPosition);
  gl.vertexAttribPointer(program.aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normals);
  gl.enableVertexAttribArray(program.aNormal);
  gl.vertexAttribPointer(program.aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(mesh.mode, 0, mesh.count);
}

function drawTextureMesh(gl, program, mesh, mvp) {
  gl.useProgram(program.handle);
  gl.uniformMatrix4fv(program.uMvp, false, mvp);
  gl.uniform1f(program.uAlpha, 0.86);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, mesh.texture);
  gl.uniform1i(program.uTexture, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
  gl.enableVertexAttribArray(program.aPosition);
  gl.vertexAttribPointer(program.aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.texCoords);
  gl.enableVertexAttribArray(program.aTexCoord);
  gl.vertexAttribPointer(program.aTexCoord, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(mesh.mode, 0, mesh.count);
  gl.bindTexture(gl.TEXTURE_2D, null);
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

function orthographic(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return new Float32Array([
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1
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
  const rect = canvas.getBoundingClientRect();
  return [
    (clip[0] * 0.5 + 0.5) * rect.width,
    (1 - (clip[1] * 0.5 + 0.5)) * rect.height,
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

function radToDeg(value) {
  return value * 180 / Math.PI;
}

function normalizeDegrees(value) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Math.abs(normalized) < 0.000001 ? 0 : normalized;
}

function normalizeAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function planeAngleAroundCenter(point, center, u, v) {
  const relative = sub(point, center);
  const x = dot(relative, u);
  const y = dot(relative, v);
  if (Math.hypot(x, y) < 0.0001) return null;
  return Math.atan2(y, x);
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
  const toast = $("viewerToast");
  if (toast) {
    toast.textContent = `Startup failed: ${error.message}`;
    toast.hidden = false;
  }
});
