"use strict";

const elements = {
  form: document.querySelector("#quick-add-form"),
  closeButton: document.querySelector("#close-button"),
  cancelButton: document.querySelector("#cancel-button"),
  saveButton: document.querySelector("#save-button"),
  titleInput: document.querySelector("#title-input"),
  contentInput: document.querySelector("#content-input"),
  keywordsInput: document.querySelector("#keywords-input"),
  tagsInput: document.querySelector("#tags-input"),
  aliasesInput: document.querySelector("#aliases-input"),
  targetName: document.querySelector("#target-name"),
  notice: document.querySelector("#notice")
};

let submitting = false;

function splitList(value) {
  return String(value ?? "").split(/[，,]/u).map((item) => item.trim()).filter(Boolean);
}

function setSubmitting(value) {
  submitting = value;
  elements.saveButton.disabled = value;
  elements.cancelButton.disabled = value;
  elements.closeButton.disabled = value;
}

async function closeWindow(saved = false) {
  if (submitting && !saved) return;
  await window.promptAssistant.closeQuickAdd(saved);
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  setSubmitting(true);
  elements.notice.textContent = "";
  try {
    await window.promptAssistant.savePrompt({
      title: elements.titleInput.value,
      content: elements.contentInput.value,
      keywords: splitList(elements.keywordsInput.value),
      tags: splitList(elements.tagsInput.value),
      aliases: splitList(elements.aliasesInput.value)
    });
    await closeWindow(true);
  } catch (error) {
    elements.notice.textContent = error.message;
    setSubmitting(false);
  }
});

elements.closeButton.addEventListener("click", () => { void closeWindow(false); });
elements.cancelButton.addEventListener("click", () => { void closeWindow(false); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.isComposing) {
    event.preventDefault();
    void closeWindow(false);
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});

window.promptAssistant.onQuickAdd(({ content, truncated, targetName } = {}) => {
  setSubmitting(false);
  elements.form.reset();
  elements.contentInput.value = String(content ?? "");
  elements.targetName.textContent = targetName ? `来自 ${targetName}` : "来自当前输入程序";
  elements.notice.textContent = truncated ? "选中文字超过 20000 个字符，已截取前 20000 个字符" : "";
  elements.titleInput.focus();
});
