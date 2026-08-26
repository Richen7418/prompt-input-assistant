"use strict";

const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
const { app } = require("electron");

const execFileAsync = promisify(execFile);
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
      return (unix id of targetProcess as text) & "|" & (name of targetProcess as text)
    end tell
  `);
  const separator = output.indexOf("|");
  return {
    processId: Number.parseInt(output.slice(0, separator), 10),
    processName: output.slice(separator + 1)
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
      delay 0.08
      keystroke "v" using command down
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

module.exports = { activateAndPaste, activateWindow, captureTarget, initializePlatformBridge, shutdownPlatformBridge };
