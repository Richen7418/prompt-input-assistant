"use strict";

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

module.exports = { restoreClipboard, snapshotClipboard };
