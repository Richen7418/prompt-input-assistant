"use strict";

const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
const { app } = require("electron");

const execFileAsync = promisify(execFile);
const MAC_TARGET_SEPARATOR = String.fromCharCode(30);
let windowsBridge = null;
let windowsBridgeReady = null;
let resolveWindowsBridgeReady = null;
let rejectWindowsBridgeReady = null;
const pendingWindowsResponses = [];

function platformScriptPath(fileName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "scripts", "platform", fileName);
  }
  return path.join(app.getAppPath(), "scripts", "platform", fileName);
}

async function runPowerShell(argumentsList) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    platformScriptPath("windows-bridge.ps1"),
    ...argumentsList
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  return stdout.trim();
}

function rejectPendingWindowsResponses(error) {
  while (pendingWindowsResponses.length > 0) {
    const pending = pendingWindowsResponses.shift();
    clearTimeout(pending.timer);
    if (!pending.settled) pending.reject(error);
  }
}

function resetWindowsBridge(error = new Error("Windows bridge stopped")) {
  rejectPendingWindowsResponses(error);
  if (rejectWindowsBridgeReady) rejectWindowsBridgeReady(error);
  windowsBridge = null;
  windowsBridgeReady = null;
  resolveWindowsBridgeReady = null;
  rejectWindowsBridgeReady = null;
}

function startWindowsBridge() {
  if (windowsBridgeReady) {
    return windowsBridgeReady;
  }

  windowsBridgeReady = new Promise((resolve, reject) => {
    resolveWindowsBridgeReady = resolve;
    rejectWindowsBridgeReady = reject;
  });
  windowsBridge = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    platformScriptPath("windows-bridge.ps1"),
    "-Action",
    "Server"
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const lines = readline.createInterface({ input: windowsBridge.stdout });
  lines.on("line", (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      console.warn("Windows bridge returned invalid JSON:", line);
      return;
    }

    if (payload.ready === true && resolveWindowsBridgeReady) {
      resolveWindowsBridgeReady(true);
      resolveWindowsBridgeReady = null;
      rejectWindowsBridgeReady = null;
      return;
    }

    const pending = pendingWindowsResponses.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    if (!pending.settled) pending.resolve(payload);
  });
  windowsBridge.stderr.setEncoding("utf8");
  windowsBridge.stderr.on("data", (message) => console.warn("Windows bridge:", message.trim()));
  windowsBridge.on("error", resetWindowsBridge);
  windowsBridge.on("exit", (code) => resetWindowsBridge(new Error(`Windows bridge exited (${code})`)));

  return windowsBridgeReady;
}

async function sendWindowsCommand(command) {
  await startWindowsBridge();
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, settled: false, timer: null };
    pending.timer = setTimeout(() => {
      pending.settled = true;
      reject(new Error("Windows bridge timed out"));
    }, 3000);
    pendingWindowsResponses.push(pending);
    windowsBridge.stdin.write(`${command}\n`);
  });
}

async function captureWindowsTarget() {
  try {
    return await sendWindowsCommand("GET");
  } catch (error) {
    const output = await runPowerShell(["-Action", "GetTarget"]);
    return JSON.parse(output);
  }
}

async function pasteWindows(target) {
  const windowHandle = String(target?.windowHandle ?? 0);
  const processId = String(target?.processId ?? 0);
  try {
    return (await sendWindowsCommand(`PASTE|${windowHandle}|${processId}`)).success === true;
  } catch (error) {
    const output = await runPowerShell([
      "-Action",
      "Paste",
      "-WindowHandle",
      windowHandle,
      "-ProcessId",
      processId
    ]);
    return JSON.parse(output).success === true;
  }
}

async function copyWindows(target) {
  const windowHandle = String(target?.windowHandle ?? 0);
  const processId = String(target?.processId ?? 0);
  try {
    return (await sendWindowsCommand(`COPY|${windowHandle}|${processId}`)).success === true;
  } catch (error) {
    const output = await runPowerShell([
      "-Action",
      "Copy",
      "-WindowHandle",
      windowHandle,
      "-ProcessId",
      processId
    ]);
    return JSON.parse(output).success === true;
  }
}

async function focusWindows(target) {
  const windowHandle = String(target?.windowHandle ?? 0);
  const processId = String(target?.processId ?? 0);
  try {
    return (await sendWindowsCommand(`FOCUS|${windowHandle}|${processId}`)).success === true;
  } catch (error) {
    const output = await runPowerShell([
      "-Action",
      "Focus",
      "-WindowHandle",
      windowHandle,
      "-ProcessId",
      processId
    ]);
    return JSON.parse(output).success === true;
  }
}

async function runAppleScript(script) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 5000
  });
  return stdout.trim();
}

async function captureMacTarget() {
  const output = await runAppleScript(`
    tell application "System Events"
      set targetProcess to first application process whose frontmost is true
      set pidText to unix id of targetProcess as text
      set processName to name of targetProcess as text
      set windowTitle to ""
      set wx to 0
      set wy to 0
      set ww to 0
      set wh to 0
      try
        set targetWindow to front window of targetProcess
        set windowTitle to name of targetWindow as text
        set {wx, wy} to position of targetWindow
        set {ww, wh} to size of targetWindow
      end try

      set inputKnown to false
      set inputFocused to false
      set inputRole to ""
      set ix to 0
      set iy to 0
      set iw to 0
      set ih to 0
      try
        set focusedElement to value of attribute "AXFocusedUIElement" of targetProcess
        set inputKnown to true
        set inputRole to value of attribute "AXRole" of focusedElement as text
        set isEditable to false
        try
          set isEditable to value of attribute "AXEditable" of focusedElement as boolean
        end try
        if isEditable or inputRole is "AXTextField" or inputRole is "AXTextArea" or inputRole is "AXComboBox" then
          set inputFocused to true
        end if
        try
          set {ix, iy} to position of focusedElement
          set {iw, ih} to size of focusedElement
        end try
      end try

      set fieldSeparator to ASCII character 30
      return pidText & fieldSeparator & processName & fieldSeparator & windowTitle & fieldSeparator & wx & fieldSeparator & wy & fieldSeparator & ww & fieldSeparator & wh & fieldSeparator & inputKnown & fieldSeparator & inputFocused & fieldSeparator & inputRole & fieldSeparator & ix & fieldSeparator & iy & fieldSeparator & iw & fieldSeparator & ih
    end tell
  `);
  const [
    pidText,
    processName,
    windowTitle,
    wx,
    wy,
    ww,
    wh,
    inputKnown,
    inputFocused,
    inputRole,
    ix,
    iy,
    iw,
    ih
  ] = output.split(MAC_TARGET_SEPARATOR);
  const windowBounds = {
    x: Number.parseFloat(wx) || 0,
    y: Number.parseFloat(wy) || 0,
    width: Number.parseFloat(ww) || 0,
    height: Number.parseFloat(wh) || 0
  };
  const inputBounds = {
    x: Number.parseFloat(ix) || 0,
    y: Number.parseFloat(iy) || 0,
    width: Number.parseFloat(iw) || 0,
    height: Number.parseFloat(ih) || 0
  };
  const hasInputBounds = inputBounds.width > 0 && inputBounds.height > 0;
  return {
    processId: Number.parseInt(pidText, 10),
    processName,
    windowTitle,
    windowBounds,
    inputBounds,
    bounds: inputFocused === "true" && hasInputBounds ? inputBounds : windowBounds,
    inputKnown: inputKnown === "true",
    inputFocused: inputFocused === "true",
    inputRole
  };
}

async function pasteMac(target) {
  const processId = Number.parseInt(target?.processId, 10);
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  await runAppleScript(`
    tell application "System Events"
      set targetProcess to first application process whose unix id is ${processId}
      set frontmost of targetProcess to true
      delay 0.2
      keystroke "v" using command down
    end tell
  `);
  return true;
}

async function copyMac(target) {
  const processId = Number.parseInt(target?.processId, 10);
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  await runAppleScript(`
    tell application "System Events"
      set targetProcess to first application process whose unix id is ${processId}
      set frontmost of targetProcess to true
      delay 0.2
      keystroke "c" using command down
    end tell
  `);
  return true;
}

async function focusMac(target) {
  const processId = Number.parseInt(target?.processId, 10);
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  await runAppleScript(`
    tell application "System Events"
      set targetProcess to first application process whose unix id is ${processId}
      set frontmost of targetProcess to true
    end tell
  `);
  return true;
}

async function captureTarget() {
  try {
    if (process.platform === "win32") {
      return await captureWindowsTarget();
    }
    if (process.platform === "darwin") {
      return await captureMacTarget();
    }
  } catch (error) {
    console.warn("无法记录当前输入目标：", error.message);
  }
  return { processName: "未知应用" };
}

async function activateAndPaste(target) {
  try {
    if (process.platform === "win32") {
      return await pasteWindows(target);
    }
    if (process.platform === "darwin") {
      return await pasteMac(target);
    }
  } catch (error) {
    console.warn("自动粘贴失败：", error.message);
  }
  return false;
}

async function activateAndCopy(target) {
  try {
    if (process.platform === "win32") {
      return await copyWindows(target);
    }
    if (process.platform === "darwin") {
      return await copyMac(target);
    }
  } catch (error) {
    console.warn("无法复制选中文字：", error.message);
  }
  return false;
}

async function activateWindow(target) {
  try {
    if (process.platform === "win32") return await focusWindows(target);
    if (process.platform === "darwin") return await focusMac(target);
    return true;
  } catch (error) {
    console.warn("无法激活目标窗口：", error.message);
    return false;
  }
}

function initializePlatformBridge() {
  if (process.platform === "win32") {
    void startWindowsBridge().catch((error) => console.warn("Windows bridge startup failed:", error.message));
  }
}

function shutdownPlatformBridge() {
  if (windowsBridge && !windowsBridge.killed) {
    windowsBridge.kill();
  }
}

module.exports = {
  activateAndCopy,
  activateAndPaste,
  activateWindow,
  captureTarget,
  initializePlatformBridge,
  shutdownPlatformBridge
};
