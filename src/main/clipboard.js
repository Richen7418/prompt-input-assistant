"use strict";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function snapshotClipboard(clipboard) {
  const formats = clipboard.availableFormats();
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  const bookmark = clipboard.readBookmark();

  return {
    formats,
    text,
    html,
    rtf,
    image: image.isEmpty() ? null : image,
    bookmark
  };
}

function restoreClipboard(clipboard, snapshot) {
  const data = {};
  const joinedFormats = snapshot.formats.join(" ").toLocaleLowerCase();

  if (snapshot.text || /text|unicode|string/u.test(joinedFormats)) {
    data.text = snapshot.text;
  }
  if (snapshot.html) {
    data.html = snapshot.html;
  }
  if (snapshot.rtf) {
    data.rtf = snapshot.rtf;
  }
  if (snapshot.image) {
    data.image = snapshot.image;
  }
  if (snapshot.bookmark?.title && snapshot.bookmark?.url) {
    data.bookmark = snapshot.bookmark.title;
    data.text = snapshot.bookmark.url;
  }

  clipboard.clear();
  if (Object.keys(data).length > 0) {
    clipboard.write(data);
  }
}

async function captureSelectedText(clipboard, copySelection, options = {}) {
  const marker = options.marker ?? `__prompt_assistant_selection_${Date.now()}_${Math.random()}__`;
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 120);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 40);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 900);
  const wait = options.wait ?? delay;
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText(marker);

  try {
    if (initialDelayMs > 0) await wait(initialDelayMs);
    if (await copySelection() !== true) return "";

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const selectedText = clipboard.readText();
      if (selectedText !== marker) {
        return selectedText.trim() ? selectedText : "";
      }
      if (Date.now() >= deadline) return "";
      await wait(pollIntervalMs);
    }
  } finally {
    restoreClipboard(clipboard, snapshot);
  }
}

module.exports = { captureSelectedText, restoreClipboard, snapshotClipboard };
