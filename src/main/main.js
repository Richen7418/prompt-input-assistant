"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  systemPreferences,
  Tray
} = require("electron");
const { captureSelectedText, restoreClipboard, snapshotClipboard } = require("./clipboard");
const {
  activateAndCopy,
  activateAndPaste,
  activateWindow,
  captureTarget,
  initializePlatformBridge,
  shutdownPlatformBridge
} = require("./platform");
const { PromptStore } = require("./store");
const { PromptLearningStore } = require("./learning-store");
const { withPromptSeparator } = require("../core/insertion");
const { selectionReference } = require("../core/learning");
const { createExportDocument, MAX_IMPORT_BYTES } = require("../core/schema");
const { ICON_BASE64 } = require("../../scripts/generate-assets");

const isSmokeTest = process.argv.includes("--smoke-test");
const isFullSmokeTest = process.argv.includes("--full-smoke-test");
const fullSmokeUserDataPath = isFullSmokeTest
  ? fs.mkdtempSync(path.join(app.getPath("temp"), "prompt-input-assistant-smoke-"))
  : null;
if (fullSmokeUserDataPath) {
  app.setPath("userData", fullSmokeUserDataPath);
  process.on("exit", () => fs.rmSync(fullSmokeUserDataPath, { recursive: true, force: true }));
}
const SEARCH_TRIGGER = ";";
const QUICK_ADD_TRIGGERS = process.platform === "darwin"
  ? ["Control+;", "Command+;"]
  : ["CommandOrControl+;"];
const QUICK_ADD_CONTENT_LIMIT = 20000;
const PREDICTION_ESCAPE = "Escape";
const PREDICTION_SPACE = "Space";
const MAC_ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MAC_OVERLAY_WINDOW_LEVEL = "floating";

let store;
let learningStore;
let managerWindow;
let popupWindow;
let quickAddWindow;
let tray;
let currentTarget;
let quickAddTarget;
let triggerStatus = { search: false, quickAdd: false };
let openingPopup = false;
let quickAddInProgress = false;
let pendingMode = "prompt";
let popupReady = false;
let popupRawText = "";
let closingPopup = false;
let previousSelection = null;
let quitting = false;
let insertingPrompt = false;
let closeAfterInsert = false;
let predictionCloseStatus = { escape: false, space: false };
let accessibilitySettingsOpened = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSmokeCondition(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(message);
}

let smokePopupSequence = 0;

async function sendSmokePopupOpen(payload) {
  const targetName = `SmokeTestTarget-${++smokePopupSequence}`;
  popupWindow.webContents.send("popup:open", { ...payload, targetName });
  await waitForSmokeCondition(
    () => popupWindow.webContents.executeJavaScript(
      `document.querySelector("#target-name")?.textContent === ${JSON.stringify(`插入到 ${targetName}`)}`
    ),
    "Prediction popup renderer did not acknowledge the latest smoke payload"
  );
}

function waitForWindowLoad(window) {
  if (!window.webContents.isLoadingMainFrame()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`Window failed to load (${code}): ${description}`));
    });
  });
}

function rendererHealth(window) {
  return window.webContents.executeJavaScript(`(() => ({
    promptAssistant: typeof window.promptAssistant === "object",
    focusPopup: typeof window.promptAssistant?.focusPopup === "function",
    promptLearning: typeof window.PromptLearning === "object",
    promptSearch: typeof window.PromptSearch === "object"
  }))()`);
}

function quickAddRendererHealth() {
  return quickAddWindow.webContents.executeJavaScript(`(() => ({
    promptAssistant: typeof window.promptAssistant === "object",
    titleInput: Boolean(document.querySelector("#title-input")),
    contentInput: Boolean(document.querySelector("#content-input"))
  }))()`);
}

async function verifyPopupCloseShortcut(key, code) {
  const library = store.snapshot();
  const firstPrompt = library.prompts[0];
  if (!firstPrompt) throw new Error("Popup close smoke test requires at least one prompt");
  previousSelection = selectionReference(firstPrompt);
  currentTarget = { processName: "SmokeTestTarget" };
  await focusPopupWindow();
  await sendSmokePopupOpen({
    prompts: library.prompts,
    settings: library.settings,
    learning: learningStore.viewFor(previousSelection),
    previousSelection,
    mode: "prompt"
  });
  await popupWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ key, code })}))`
  );
  await waitForSmokeCondition(
    () => !popupWindow.isVisible() && currentTarget === null,
    `${code} did not close the prediction popup`
  );
}

async function verifyPopupCancelPreservesRawText() {
  const clipboardSnapshot = snapshotClipboard(clipboard);
  try {
    previousSelection = null;
    currentTarget = { processName: "SmokeTestTarget" };
    await focusPopupWindow();
    await sendSmokePopupOpen({
      prompts: store.snapshot().prompts,
      settings: store.snapshot().settings,
      learning: learningStore.viewFor(null),
      previousSelection: null,
      mode: "prompt"
    });
    await popupWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }))`
    );
    await waitForSmokeCondition(
      () => !popupWindow.isVisible() && currentTarget === null && clipboard.readText() === ";",
      "Escape did not preserve the uncommitted semicolon"
    );
  } finally {
    closePopupWindow();
    restoreClipboard(clipboard, clipboardSnapshot);
  }
}

async function verifyPopupCompositionSafety() {
  const library = store.snapshot();
  const firstPrompt = library.prompts[0];
  if (!firstPrompt) throw new Error("Popup composition smoke test requires at least one prompt");
  previousSelection = selectionReference(firstPrompt);
  currentTarget = { processName: "SmokeTestTarget" };
  await focusPopupWindow();
  await sendSmokePopupOpen({
    prompts: library.prompts,
    settings: library.settings,
    learning: learningStore.viewFor(previousSelection),
    previousSelection,
    mode: "prompt"
  });
  await popupWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("#query-input");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " ", code: "Space", isComposing: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape", isComposing: true }));
  })()`);
  await delay(120);
  if (!popupWindow.isVisible()) throw new Error("IME composition close keys unexpectedly closed the prediction popup");
  await popupWindow.webContents.executeJavaScript(`document.querySelector("#query-input")
    .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }))`);
  closePopupWindow();
}

async function verifyPopupKeyboardNavigation() {
  const library = store.snapshot();
  if (library.prompts.length < 4) {
    throw new Error("Popup navigation smoke test requires at least four prompts");
  }
  currentTarget = { processName: "SmokeTestTarget" };
  previousSelection = null;
  const bounds = popupBounds();
  popupWindow.setBounds({ ...bounds, height: 438 }, false);
  await focusPopupWindow();
  await sendSmokePopupOpen({
    prompts: library.prompts,
    settings: { ...library.settings, resultLimit: 3 },
    learning: learningStore.viewFor(null),
    previousSelection: null,
    mode: "prompt"
  });
  const result = await popupWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector("#candidate-list");
    const input = document.querySelector("#query-input");
    const candidates = Array.from(list.querySelectorAll(".candidate"));
    const firstCandidate = candidates[0];
    firstCandidate.focus();
    const arrowHandled = [];
    for (let index = 0; index < 3; index += 1) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown"
      });
      firstCandidate.dispatchEvent(event);
      arrowHandled.push(event.defaultPrevented);
    }
    const selectedIndex = Number.parseInt(list.querySelector(".selected")?.dataset.index ?? "-1", 10);
    const scrollable = list.scrollHeight > list.clientHeight;
    const scrolled = list.scrollTop > 0;
    input.value = "__no_smoke_match__";
    const tabEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      code: "Tab"
    });
    firstCandidate.dispatchEvent(tabEvent);
    input.value = "";
    return {
      candidateCount: candidates.length,
      arrowHandled: arrowHandled.every(Boolean),
      tabHandled: tabEvent.defaultPrevented,
      selectedIndex,
      scrollable,
      scrolled
    };
  })()`);
  closePopupWindow();
  if (result.candidateCount !== library.prompts.length
    || !result.arrowHandled
    || !result.tabHandled
    || result.selectedIndex !== 3
    || !result.scrollable
    || !result.scrolled) {
    throw new Error(`Popup navigation smoke test failed: ${JSON.stringify(result)}`);
  }
}

async function verifyQuickAddForm() {
  const content = "快速收录测试正文\n第二行";
  quickAddTarget = { processName: "SmokeTestTarget" };
  configureMacFloatingWindow(quickAddWindow);
  quickAddWindow.show();
  quickAddWindow.focus();
  quickAddWindow.webContents.send("quick-add:open", {
    content,
    truncated: false,
    targetName: "SmokeTestTarget"
  });
  await delay(100);
  const result = await quickAddWindow.webContents.executeJavaScript(`(() => ({
    windowVisible: document.visibilityState === "visible",
    heading: document.querySelector("h1").textContent,
    title: document.querySelector("#title-input").value,
    content: document.querySelector("#content-input").value,
    titleFocused: document.activeElement === document.querySelector("#title-input"),
    targetName: document.querySelector("#target-name").textContent
  }))()`);
  quickAddWindow.hide();
  quickAddTarget = null;
  if (!result.windowVisible
    || result.heading !== "快速新增提示词"
    || result.title !== ""
    || result.content !== content
    || !result.titleFocused
    || result.targetName !== "来自 SmokeTestTarget") {
    throw new Error(`Quick add form smoke test failed: ${JSON.stringify(result)}`);
  }
}

function getPreloadPath() {
  return path.join(__dirname, "..", "preload.js");
}

function getRendererPath(fileName) {
  return path.join(__dirname, "..", "renderer", fileName);
}

function focusedAssistantWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  return focused === managerWindow || focused === popupWindow || focused === quickAddWindow;
}

function setMacActivationPolicy(policy) {
  if (process.platform === "darwin") {
    app.setActivationPolicy(policy);
  }
}

function configureMacFloatingWindow(window) {
  if (process.platform !== "darwin" || !window || window.isDestroyed()) return;
  setMacActivationPolicy("accessory");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  // Keep the assistant above full-screen app windows without covering the
  // higher-level candidate panels owned by macOS input methods.
  window.setAlwaysOnTop(true, MAC_OVERLAY_WINDOW_LEVEL);
}

function unregisterTriggerShortcuts() {
  for (const accelerator of [SEARCH_TRIGGER, ...QUICK_ADD_TRIGGERS]) {
    if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  }
  triggerStatus = { search: false, quickAdd: false };
}

function unregisterPredictionCloseShortcuts() {
  for (const accelerator of [PREDICTION_ESCAPE, PREDICTION_SPACE]) {
    if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  }
  predictionCloseStatus = { escape: false, space: false };
}

async function requestPredictionClose(extra = "") {
  if (insertingPrompt) {
    closeAfterInsert = true;
    if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) {
      popupWindow.hide();
    }
    return true;
  }
  if (!previousSelection && popupRawText) {
    return insertRawTextAndClose(`${popupRawText}${extra}`);
  }
  return closePopupAndRestoreTarget();
}

function registerPredictionCloseShortcuts() {
  unregisterPredictionCloseShortcuts();
  try {
    predictionCloseStatus.escape = globalShortcut.register(PREDICTION_ESCAPE, () => {
      void requestPredictionClose();
    });
  } catch (error) {
    console.warn("Escape close shortcut registration failed:", error.message);
  }
  try {
    predictionCloseStatus.space = globalShortcut.register(PREDICTION_SPACE, () => {
      void requestPredictionClose(" ");
    });
  } catch (error) {
    console.warn("Space close shortcut registration failed:", error.message);
  }
  return { ...predictionCloseStatus };
}

function syncPredictionCloseShortcuts() {
  const needsFallback = Boolean(
    currentTarget
    && popupWindow
    && !popupWindow.isDestroyed()
    && popupWindow.isVisible()
    && !popupWindow.isFocused()
    && !closingPopup
  );
  if (!needsFallback) {
    unregisterPredictionCloseShortcuts();
    return { ...predictionCloseStatus };
  }
  return registerPredictionCloseShortcuts();
}

function broadcastStatus() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send("library:changed", {
      library: store.snapshot(),
      status: getStatus()
    });
  }
  updateTrayMenu();
}

function registerTriggerShortcuts() {
  unregisterTriggerShortcuts();
  if (!store?.snapshot().settings.triggerEnabled
    || focusedAssistantWindow()
    || popupWindow?.isVisible()
    || quickAddWindow?.isVisible()
    || currentTarget
    || openingPopup
    || quickAddInProgress) {
    broadcastStatus();
    return;
  }

  try {
    triggerStatus.search = globalShortcut.register(SEARCH_TRIGGER, () => openPopup("prompt"));
  } catch (error) {
    console.warn("分号快捷键注册失败：", error.message);
  }
  for (const [index, accelerator] of QUICK_ADD_TRIGGERS.entries()) {
    try {
      const registered = globalShortcut.register(accelerator, () => {
        void startQuickAdd();
      });
      if (index === 0) triggerStatus.quickAdd = registered;
    } catch (error) {
      console.warn(`快速收录快捷键 ${accelerator} 注册失败：`, error.message);
    }
  }
  broadcastStatus();
}

function getStatus() {
  return {
    platform: process.platform,
    trigger: { ...triggerStatus },
    accessibilityTrusted: process.platform !== "darwin"
      || systemPreferences.isTrustedAccessibilityClient(false),
    dataPath: store?.filePath ?? "",
    learningPath: learningStore?.filePath ?? "",
    targetName: currentTarget?.processName ?? "",
    isPackaged: app.isPackaged
  };
}

function macAccessibilityTrusted(prompt = false) {
  return process.platform !== "darwin"
    || systemPreferences.isTrustedAccessibilityClient(prompt);
}

async function openMacAccessibilitySettings() {
  if (process.platform !== "darwin") return true;
  if (macAccessibilityTrusted(false)) return true;
  systemPreferences.isTrustedAccessibilityClient(true);
  if (!accessibilitySettingsOpened) {
    accessibilitySettingsOpened = true;
    await shell.openExternal(MAC_ACCESSIBILITY_SETTINGS_URL);
  }
  return false;
}

function managerNotice(message, type = "info") {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send("manager:notice", { message, type });
  }
}

function showManager() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }
  setMacActivationPolicy("regular");
  if (process.platform === "darwin") {
    managerWindow.setVisibleOnAllWorkspaces(false);
    managerWindow.setAlwaysOnTop(false);
  }
  managerWindow.show();
  managerWindow.focus();
}

function showShortNotification(message) {
  if (!Notification.isSupported()) {
    console.warn(message);
    return;
  }
  new Notification({
    title: "中文提示词输入助手",
    body: message,
    silent: true
  }).show();
}

async function startQuickAdd() {
  if (quickAddInProgress || openingPopup || currentTarget) return false;
  if (!macAccessibilityTrusted(false)) {
    showShortNotification("请先为中文提示词输入助手开启辅助功能权限");
    void openMacAccessibilitySettings();
    return false;
  }
  quickAddInProgress = true;
  unregisterTriggerShortcuts();

  try {
    const target = await captureTarget();
    const selectedText = await captureSelectedText(clipboard, () => activateAndCopy(target));
    if (!selectedText.trim()) {
      showShortNotification("请先选中内容");
      return false;
    }

    const truncated = selectedText.length > QUICK_ADD_CONTENT_LIMIT;
    const content = selectedText.slice(0, QUICK_ADD_CONTENT_LIMIT);
    quickAddTarget = target;
    await waitForWindowLoad(quickAddWindow);
    quickAddWindow.setBounds(quickAddBounds(), false);
    configureMacFloatingWindow(quickAddWindow);
    quickAddWindow.show();
    if (process.platform === "darwin") quickAddWindow.moveTop();
    quickAddWindow.focus();
    quickAddWindow.webContents.send("quick-add:open", {
      content,
      truncated,
      targetName: target?.processName ?? "当前输入程序"
    });
    return true;
  } catch (error) {
    quickAddTarget = null;
    if (quickAddWindow?.isVisible()) quickAddWindow.hide();
    console.warn("快速收录选中文字失败：", error.message);
    showShortNotification("请先选中内容");
    return false;
  } finally {
    quickAddInProgress = false;
    setTimeout(registerTriggerShortcuts, 80);
  }
}

function popupBounds() {
  const settings = store.snapshot().settings;
  const width = 520;
  const height = Math.min(680, Math.max(280, 150 + settings.resultLimit * 96));
  const targetBounds = currentTarget?.bounds;
  const anchor = targetBounds && targetBounds.width > 0 && targetBounds.height > 0
    ? {
        x: Math.round(targetBounds.x + targetBounds.width / 2),
        y: Math.round(targetBounds.y + targetBounds.height - 120)
      }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(anchor);
  const { workArea } = display;
  const desiredX = targetBounds?.width > 0
    ? targetBounds.x + (targetBounds.width - width) / 2
    : workArea.x + (workArea.width - width) / 2;
  const desiredY = targetBounds?.height > 0
    ? targetBounds.y + targetBounds.height - height - 110
    : workArea.y + workArea.height - height - 100;
  return {
    x: Math.round(Math.min(Math.max(desiredX, workArea.x + 10), workArea.x + workArea.width - width - 10)),
    y: Math.round(Math.min(Math.max(desiredY, workArea.y + 10), workArea.y + workArea.height - height - 10)),
    width,
    height
  };
}

function quickAddBounds() {
  const anchor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(anchor);
  const { workArea } = display;
  const width = Math.min(640, workArea.width - 24);
  const height = Math.min(650, workArea.height - 24);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

async function closeQuickAddWindow(saved = false) {
  const target = quickAddTarget;
  if (quickAddWindow && !quickAddWindow.isDestroyed() && quickAddWindow.isVisible()) {
    quickAddWindow.hide();
  }
  quickAddTarget = null;
  if (saved) showShortNotification("提示词已保存");
  setTimeout(registerTriggerShortcuts, 80);
  if (!target) return false;
  await delay(60);
  return activateWindow(target);
}

function nativeWindowTarget(window) {
  if (!window || window.isDestroyed() || process.platform !== "win32") return null;
  const handle = window.getNativeWindowHandle();
  let windowHandle = 0;
  if (handle.length >= 8) {
    const value = handle.readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    windowHandle = Number(value);
  } else if (handle.length >= 4) {
    windowHandle = handle.readUInt32LE(0);
  }
  return windowHandle > 0 ? { windowHandle, processId: process.pid } : null;
}

async function focusPopupWindow() {
  configureMacFloatingWindow(popupWindow);
  popupWindow.show();
  if (process.platform === "darwin") popupWindow.moveTop();
  popupWindow.focus();
  if (process.platform !== "win32") return true;
  await delay(40);
  const target = nativeWindowTarget(popupWindow);
  const activated = target ? await activateWindow(target) : false;
  if (!activated) {
    popupWindow.moveTop();
    popupWindow.focus();
  }
  return activated;
}

async function openPopup(mode) {
  if (openingPopup) {
    pendingMode = "tag";
    return;
  }
  if (popupWindow?.isVisible()) {
    popupWindow.focus();
    return;
  }

  const library = store.snapshot();
  if (library.prompts.length === 0) {
    showManager();
    managerNotice("请先新增或导入至少一条提示词", "warning");
    return;
  }

  openingPopup = true;
  pendingMode = mode;
  insertingPrompt = false;
  closeAfterInsert = false;
  unregisterPredictionCloseShortcuts();
  currentTarget = await captureTarget();
  previousSelection = null;
  unregisterTriggerShortcuts();

  try {
    popupRawText = pendingMode === "tag" ? ";;" : ";";
    popupWindow.setBounds(popupBounds(), false);
    await focusPopupWindow();
    popupWindow.webContents.send("popup:open", {
      prompts: library.prompts,
      settings: library.settings,
      learning: learningStore.viewFor(null),
      mode: pendingMode,
      targetName: currentTarget?.processName ?? "当前应用"
    });
  } finally {
    openingPopup = false;
  }
}

function closePopupWindow() {
  unregisterPredictionCloseShortcuts();
  closeAfterInsert = false;
  closingPopup = true;
  if (popupWindow?.isVisible()) {
    popupWindow.hide();
  }
  currentTarget = null;
  previousSelection = null;
  popupRawText = "";
  popupWindow?.setFocusable(true);
  closingPopup = false;
  setTimeout(registerTriggerShortcuts, 80);
}

async function closePopupAndRestoreTarget() {
  const target = currentTarget;
  closePopupWindow();
  if (!target) return false;
  await delay(60);
  return activateWindow(target);
}

async function pasteTextIntoTarget(text) {
  const value = String(text ?? "");
  if (!value || !currentTarget) {
    return { attempted: false, inserted: false, reason: "没有可插入的内容或目标应用" };
  }

  closingPopup = true;
  const clipboardSnapshot = snapshotClipboard(clipboard);
  clipboard.writeText(value);
  popupWindow.setFocusable(false);
  popupWindow.hide();
  await delay(140);

  const missingAccessibility = !isFullSmokeTest && !macAccessibilityTrusted(false);
  const pasted = missingAccessibility ? false : await activateAndPaste(currentTarget);
  if (pasted) {
    await delay(450);
    restoreClipboard(clipboard, clipboardSnapshot);
  } else {
    new Notification({
      title: "中文提示词输入助手",
      body: missingAccessibility
        ? "缺少辅助功能权限，内容已保留在剪贴板；请授权后重试。"
        : "自动粘贴失败，提示词已保留在剪贴板，请手动粘贴。"
    }).show();
    if (missingAccessibility) void openMacAccessibilitySettings();
  }

  return { attempted: true, inserted: pasted, clipboardFallback: !pasted };
}

async function resumePopupWindow() {
  if (!popupWindow || popupWindow.isDestroyed() || !currentTarget) {
    closePopupWindow();
    return false;
  }
  popupRawText = ";";
  popupWindow.setFocusable(true);
  popupWindow.setBounds(popupBounds(), false);
  await focusPopupWindow();
  closingPopup = false;
  return true;
}

async function insertPromptAndContinue(prompt) {
  let result;
  insertingPrompt = true;
  try {
    result = await pasteTextIntoTarget(withPromptSeparator(prompt.content));
    if (!result.attempted || !currentTarget) {
      closePopupWindow();
      return { ...result, sessionContinues: false };
    }

    const selection = learningStore.record(prompt, previousSelection);
    previousSelection = { promptId: selection.promptId, contentKey: selection.contentKey };
    return {
      ...result,
      sessionContinues: true,
      previousSelection: { ...previousSelection },
      learning: learningStore.viewFor(previousSelection)
    };
  } finally {
    let resumed = false;
    try {
      if (!closeAfterInsert && currentTarget) {
        resumed = await resumePopupWindow();
      }
    } finally {
      insertingPrompt = false;
      if (closeAfterInsert) {
        await closePopupAndRestoreTarget();
      } else if (!currentTarget || !resumed) {
        closePopupWindow();
      } else {
        syncPredictionCloseShortcuts();
      }
    }
  }
}

async function insertRawTextAndClose(text) {
  try {
    return await pasteTextIntoTarget(text);
  } finally {
    closePopupWindow();
  }
}

function createManagerWindow() {
  managerWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: "中文提示词输入助手",
    backgroundColor: "#0f1714",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  managerWindow.setMenuBarVisibility(false);
  if (process.platform === "darwin") {
    managerWindow.setVisibleOnAllWorkspaces(false);
    managerWindow.setAlwaysOnTop(false);
  }
  managerWindow.loadFile(getRendererPath("manager.html"));
  managerWindow.once("ready-to-show", () => {
    if (!isFullSmokeTest) showManager();
  });
  managerWindow.on("focus", unregisterTriggerShortcuts);
  managerWindow.on("blur", () => setTimeout(registerTriggerShortcuts, 80));
  managerWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      managerWindow.hide();
      setMacActivationPolicy("accessory");
      setTimeout(registerTriggerShortcuts, 80);
    }
  });
}

function createQuickAddWindow() {
  quickAddWindow = new BrowserWindow({
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    width: 640,
    height: 650,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#101916",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (process.platform !== "darwin") {
    quickAddWindow.setAlwaysOnTop(true, "pop-up-menu");
  }
  quickAddWindow.loadFile(getRendererPath("quick-add.html"));
  quickAddWindow.on("focus", unregisterTriggerShortcuts);
  quickAddWindow.on("hide", () => setTimeout(registerTriggerShortcuts, 80));
  quickAddWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      void closeQuickAddWindow(false);
    }
  });
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    width: 520,
    height: 438,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#101916",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (process.platform !== "darwin") {
    popupWindow.setAlwaysOnTop(true, "pop-up-menu");
  }
  popupWindow.loadFile(getRendererPath("popup.html"));
  popupWindow.webContents.on("did-finish-load", () => {
    popupReady = true;
    registerTriggerShortcuts();
  });
  popupWindow.on("focus", unregisterPredictionCloseShortcuts);
  popupWindow.on("blur", () => setTimeout(syncPredictionCloseShortcuts, 0));
  popupWindow.on("hide", unregisterPredictionCloseShortcuts);
}

function trayImage() {
  return nativeImage.createFromDataURL(`data:image/png;base64,${ICON_BASE64}`).resize({
    width: 18,
    height: 18
  });
}

function updateTrayMenu() {
  if (!tray || !store) {
    return;
  }
  const enabled = store.snapshot().settings.triggerEnabled;
  const template = [
    { label: "打开提示词管理", click: showManager },
    {
      label: enabled ? "暂停快捷键" : "启用快捷键",
      click: () => {
        store.updateSettings({ triggerEnabled: !enabled });
        if (enabled) {
          unregisterTriggerShortcuts();
        } else {
          registerTriggerShortcuts();
        }
        broadcastStatus();
      }
    }
  ];
  if (process.platform === "darwin") {
    const trusted = macAccessibilityTrusted(false);
    template.push(
      { type: "separator" },
      {
        label: trusted ? "辅助功能权限已开启" : "开启辅助功能权限…",
        enabled: !trusted,
        click: () => { void openMacAccessibilitySettings(); }
      }
    );
  }
  template.push(
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("中文提示词输入助手");
  tray.on("click", showManager);
  updateTrayMenu();
}

function broadcastLibrary() {
  const payload = { library: store.snapshot(), status: getStatus() };
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send("library:changed", payload);
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send("library:changed", {
      ...payload,
      learning: learningStore.viewFor(previousSelection),
      previousSelection: previousSelection ? { ...previousSelection } : null
    });
  }
  updateTrayMenu();
}

function reconcileLearningAndSession() {
  const prompts = store.snapshot().prompts;
  learningStore.reconcile(prompts);
  if (!previousSelection) return;
  const currentPrompt = prompts.find((prompt) => prompt.id === previousSelection.promptId);
  const currentReference = selectionReference(currentPrompt);
  if (!currentReference || currentReference.contentKey !== previousSelection.contentKey) {
    previousSelection = null;
  }
}

function registerIpcHandlers() {
  ipcMain.handle("library:get", () => store.snapshot());
  ipcMain.handle("app:status", () => getStatus());
  ipcMain.handle("app:open-accessibility-settings", () => openMacAccessibilitySettings());
  ipcMain.handle("prompt:save", (_event, prompt) => {
    const saved = store.savePrompt(prompt);
    reconcileLearningAndSession();
    broadcastLibrary();
    return saved;
  });
  ipcMain.handle("prompt:delete", (_event, id) => {
    const normalizedId = String(id ?? "");
    const deleted = store.deletePrompt(normalizedId);
    if (previousSelection?.promptId === normalizedId) previousSelection = null;
    if (deleted) reconcileLearningAndSession();
    broadcastLibrary();
    return deleted;
  });
  ipcMain.handle("settings:update", (_event, settings) => {
    const updated = store.updateSettings(settings);
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: updated.launchAtLogin });
    }
    registerTriggerShortcuts();
    broadcastLibrary();
    return updated;
  });
  ipcMain.handle("library:import", async () => {
    const result = await dialog.showOpenDialog(managerWindow, {
      title: "导入提示词 JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = result.filePaths[0];
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_IMPORT_BYTES) {
      throw new Error("导入文件不能超过 5 MB");
    }
    const imported = store.mergeImport(JSON.parse(fs.readFileSync(filePath, "utf8")));
    reconcileLearningAndSession();
    broadcastLibrary();
    return { canceled: false, ...imported };
  });
  ipcMain.handle("library:export", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(managerWindow, {
      title: "导出提示词 JSON",
      defaultPath: `prompt-library-${date}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    const document = createExportDocument(store.snapshot().prompts);
    fs.writeFileSync(result.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return { canceled: false, count: document.prompts.length, filePath: result.filePath };
  });
  ipcMain.handle("popup:select", async (_event, id) => {
    const prompt = store.snapshot().prompts.find((item) => item.id === id);
    if (!prompt) {
      throw new Error("选中的提示词已不存在");
    }
    return insertPromptAndContinue(prompt);
  });
  ipcMain.handle("popup:cancel", (_event, rawText) => insertRawTextAndClose(rawText));
  ipcMain.handle("popup:close", () => requestPredictionClose());
  ipcMain.handle("quick-add:close", (_event, saved) => closeQuickAddWindow(saved === true));
  ipcMain.handle("popup:focus", () => {
    if (!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()) return false;
    return focusPopupWindow();
  });
  ipcMain.on("popup:state", (_event, state) => {
    if (state && typeof state.rawText === "string") {
      popupRawText = state.rawText.slice(0, 1000);
    }
  });
}

async function runSmokeTest() {
  let search = false;
  const quickAddAccelerators = {};
  try {
    search = globalShortcut.register(SEARCH_TRIGGER, () => {});
    for (const accelerator of QUICK_ADD_TRIGGERS) {
      quickAddAccelerators[accelerator] = false;
      quickAddAccelerators[accelerator] = globalShortcut.register(accelerator, () => {});
    }
  } finally {
    console.log(JSON.stringify({
      electron: process.versions.electron,
      platform: process.platform,
      search,
      quickAdd: Object.values(quickAddAccelerators).every(Boolean),
      quickAddAccelerators
    }));
    globalShortcut.unregisterAll();
    app.quit();
  }
}

async function initialize() {
  const userDataPath = app.getPath("userData");
  store = new PromptStore(path.join(userDataPath, "prompt-library.json"));
  store.load();
  if (isFullSmokeTest && store.snapshot().prompts.length < 4) {
    for (let index = 1; index <= 4; index += 1) {
      store.savePrompt({
        id: `smoke-prompt-${index}`,
        title: `冒烟测试提示词 ${index}`,
        content: `仅用于完整应用测试的提示词 ${index}`,
        tags: ["测试"]
      });
    }
  }
  learningStore = new PromptLearningStore(path.join(userDataPath, "prompt-learning.json"));
  learningStore.load(store.snapshot().prompts, store.legacyHistorySnapshot());
  store.discardLegacySelectionHistory();
  initializePlatformBridge();
  registerIpcHandlers();
  createPopupWindow();
  createQuickAddWindow();
  createManagerWindow();
  createTray();

  if (process.platform === "darwin" && !isFullSmokeTest) {
    setTimeout(() => {
      if (macAccessibilityTrusted(false)) return;
      systemPreferences.isTrustedAccessibilityClient(true);
      managerNotice("请开启辅助功能权限，否则无法快速收录或把提示词、分号写回输入框。", "warning");
      broadcastStatus();
    }, 700);
  }

  app.on("activate", showManager);
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    unregisterPredictionCloseShortcuts();
    unregisterTriggerShortcuts();
    shutdownPlatformBridge();
  });

  if (isFullSmokeTest) {
    await Promise.all([
      waitForWindowLoad(managerWindow),
      waitForWindowLoad(popupWindow),
      waitForWindowLoad(quickAddWindow)
    ]);
    const [managerHealth, popupHealth, quickAddHealth] = await Promise.all([
      rendererHealth(managerWindow),
      rendererHealth(popupWindow),
      quickAddRendererHealth()
    ]);
    if (!managerHealth.promptAssistant || !managerHealth.focusPopup
      || !managerHealth.promptLearning || !managerHealth.promptSearch
      || !popupHealth.promptAssistant || !popupHealth.focusPopup
      || !popupHealth.promptLearning || !popupHealth.promptSearch
      || !quickAddHealth.promptAssistant || !quickAddHealth.titleInput || !quickAddHealth.contentInput) {
      throw new Error(`Renderer initialization failed: ${JSON.stringify({
        managerHealth,
        popupHealth,
        quickAddHealth
      })}`);
    }
    await verifyQuickAddForm();
    await verifyPopupCancelPreservesRawText();
    await verifyPopupCloseShortcut("Escape", "Escape");
    await verifyPopupCloseShortcut(" ", "Space");
    await verifyPopupCompositionSafety();
    await verifyPopupKeyboardNavigation();
    const globalCloseKeys = registerPredictionCloseShortcuts();
    if (!globalCloseKeys.escape || !globalCloseKeys.space) {
      throw new Error(`Prediction global close shortcuts failed: ${JSON.stringify(globalCloseKeys)}`);
    }
    const fullScreenWorkspaceOverlay = process.platform !== "darwin"
      || popupWindow.isVisibleOnAllWorkspaces();
    if (!fullScreenWorkspaceOverlay) {
      throw new Error("macOS popup is not visible on all workspaces");
    }
    const quickAddFullScreenOverlay = process.platform !== "darwin"
      || quickAddWindow.isVisibleOnAllWorkspaces();
    if (!quickAddFullScreenOverlay) {
      throw new Error("macOS quick-add window is not visible on all workspaces");
    }
    const managerWorkspaceScoped = process.platform !== "darwin"
      || !managerWindow.isVisibleOnAllWorkspaces();
    if (!managerWorkspaceScoped) {
      throw new Error("macOS manager unexpectedly follows all workspaces");
    }
    unregisterPredictionCloseShortcuts();
    console.log(JSON.stringify({
      fullApp: true,
      managerTitle: managerWindow.getTitle(),
      popupLoaded: !popupWindow.webContents.isLoadingMainFrame(),
      bridgePlatform: process.platform,
      trayImageEmpty: trayImage().isEmpty(),
      promptCount: store.snapshot().prompts.length,
      rendererHealthy: true,
      quickAddForm: true,
      quickAddFloatingWindow: true,
      cancelRestoresRawText: true,
      predictionCloseKeys: true,
      compositionCloseSafety: true,
      candidateKeyboardScope: true,
      scrollableResults: true,
      predictionGlobalCloseKeys: true,
      fullScreenWorkspaceOverlay,
      quickAddFullScreenOverlay,
      managerWorkspaceScoped
    }));
    quitting = true;
    app.exit(0);
    return;
  }

}

if (!isSmokeTest && !isFullSmokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!isSmokeTest && !isFullSmokeTest) {
    app.on("second-instance", showManager);
  }
  app.whenReady().then(isSmokeTest ? runSmokeTest : initialize).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on("window-all-closed", (event) => {
  if (!quitting && process.platform !== "darwin") {
    event.preventDefault?.();
  }
});
