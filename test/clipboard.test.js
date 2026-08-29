"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { captureSelectedText } = require("../src/main/clipboard");

function createClipboard(initialText = "") {
  let state = {
    text: initialText,
    html: "",
    rtf: "",
    formats: initialText ? ["text/plain"] : []
  };
  const emptyImage = { isEmpty: () => true };

  return {
    availableFormats: () => [...state.formats],
    readText: () => state.text,
    readHTML: () => state.html,
    readRTF: () => state.rtf,
    readImage: () => emptyImage,
    readBookmark: () => ({ title: "", url: "" }),
    writeText(value) {
      state = { text: String(value), html: "", rtf: "", formats: ["text/plain"] };
    },
    clear() {
      state = { text: "", html: "", rtf: "", formats: [] };
    },
    write(data) {
      state = {
        text: data.text ?? "",
        html: data.html ?? "",
        rtf: data.rtf ?? "",
        formats: Object.keys(data)
      };
    }
  };
}

test("快速收录读取选中文字并完整恢复原剪贴板", async () => {
  const clipboard = createClipboard("原剪贴板内容");
  const selected = await captureSelectedText(clipboard, async () => {
    clipboard.writeText("  被选中的提示词\n第二行  ");
    return true;
  }, {
    marker: "__selection_marker__",
    initialDelayMs: 0,
    timeoutMs: 0
  });

  assert.equal(selected, "  被选中的提示词\n第二行  ");
  assert.equal(clipboard.readText(), "原剪贴板内容");
});

test("没有选中文字时返回空字符串并恢复原剪贴板", async () => {
  const clipboard = createClipboard("不要覆盖我");
  const selected = await captureSelectedText(clipboard, async () => true, {
    marker: "__selection_marker__",
    initialDelayMs: 0,
    timeoutMs: 0
  });

  assert.equal(selected, "");
  assert.equal(clipboard.readText(), "不要覆盖我");
});
