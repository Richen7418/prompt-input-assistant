"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("promptAssistant", Object.freeze({
  getLibrary: () => ipcRenderer.invoke("library:get"),
  savePrompt: (prompt) => ipcRenderer.invoke("prompt:save", prompt),
  deletePrompt: (id) => ipcRenderer.invoke("prompt:delete", id),
  importJson: () => ipcRenderer.invoke("library:import"),
  exportJson: () => ipcRenderer.invoke("library:export"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  getStatus: () => ipcRenderer.invoke("app:status"),
  openAccessibilitySettings: () => ipcRenderer.invoke("app:open-accessibility-settings"),
  selectPrompt: (id) => ipcRenderer.invoke("popup:select", id),
  cancelPopup: (rawText) => ipcRenderer.invoke("popup:cancel", rawText),
  closePopup: () => ipcRenderer.invoke("popup:close"),
  closeQuickAdd: (saved) => ipcRenderer.invoke("quick-add:close", saved === true),
  focusPopup: () => ipcRenderer.invoke("popup:focus"),
  updatePopupState: (state) => ipcRenderer.send("popup:state", state),
  onLibraryChanged: (callback) => subscribe("library:changed", callback),
  onQuickAdd: (callback) => subscribe("quick-add:open", callback),
  onPopupOpen: (callback) => subscribe("popup:open", callback),
  onManagerNotice: (callback) => subscribe("manager:notice", callback)
}));
