"use strict";

const elements = {
  newButton: document.querySelector("#new-prompt-button"),
  triggerEnabled: document.querySelector("#trigger-enabled"),
  triggerStatus: document.querySelector("#trigger-status"),
  dataPath: document.querySelector("#data-path"),
  resultLimit: document.querySelector("#result-limit"),
  contentFontSize: document.querySelector("#content-font-size"),
  tagFontSize: document.querySelector("#tag-font-size"),
  launchAtLogin: document.querySelector("#launch-at-login"),
  promptCount: document.querySelector("#prompt-count"),
  importButton: document.querySelector("#import-button"),
  exportButton: document.querySelector("#export-button"),
  searchInput: document.querySelector("#search-input"),
  promptList: document.querySelector("#prompt-list"),
  dialog: document.querySelector("#prompt-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogCloseButton: document.querySelector("#dialog-close-button"),
  form: document.querySelector("#prompt-form"),
  formCancelButton: document.querySelector("#form-cancel-button"),
  promptId: document.querySelector("#prompt-id"),
  titleInput: document.querySelector("#title-input"),
  contentInput: document.querySelector("#content-input"),
  keywordsInput: document.querySelector("#keywords-input"),
  tagsInput: document.querySelector("#tags-input"),
  aliasesInput: document.querySelector("#aliases-input"),
  toast: document.querySelector("#toast")
};

let library = { prompts: [], settings: {} };
let status = {};
let composingSearch = false;
let toastTimer;

function showToast(message, type = "info") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible ${type === "error" ? "error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 3000);
}

function splitList(value) {
  return String(value ?? "").split(/[，,]/u).map((item) => item.trim()).filter(Boolean);
}

function updateStatus() {
  elements.triggerEnabled.checked = library.settings.triggerEnabled !== false;
  elements.resultLimit.value = library.settings.resultLimit ?? 3;
  elements.contentFontSize.value = library.settings.contentFontSize ?? 16;
  elements.tagFontSize.value = library.settings.tagFontSize ?? 11;
  elements.launchAtLogin.checked = library.settings.launchAtLogin === true;
  elements.dataPath.textContent = status.dataPath ? `数据：${status.dataPath}` : "";

  if (!elements.triggerEnabled.checked) {
    elements.triggerStatus.textContent = "分号触发已暂停；可从这里或托盘菜单重新启用。";
    elements.triggerStatus.className = "status-line";
  } else if (status.trigger?.primary) {
    elements.triggerStatus.textContent = "分号触发正常。关闭本窗口到托盘后，在目标输入框按 ; 即可检索。";
    elements.triggerStatus.className = "status-line good";
  } else if (status.trigger?.fallback) {
    elements.triggerStatus.textContent = "单分号快捷键被其他程序占用，请暂用 Ctrl/⌘ + ;。";
    elements.triggerStatus.className = "status-line warning";
  } else {
    elements.triggerStatus.textContent = "管理窗口打开时会暂时释放分号；关闭窗口后自动启用。";
    elements.triggerStatus.className = "status-line";
  }
}

function searchableText(prompt) {
  return [prompt.title, ...(prompt.keywords ?? []), ...(prompt.tags ?? []), ...(prompt.aliases ?? [])]
    .map(window.PromptSearch.normalizeSearch).join(" ");
}

function button(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function renderPrompts() {
  const query = window.PromptSearch.normalizeSearch(elements.searchInput.value);
  const prompts = library.prompts.filter((prompt) => !query || searchableText(prompt).includes(query));
  elements.promptCount.textContent = query ? `${prompts.length}/${library.prompts.length}` : String(library.prompts.length);
  elements.promptList.replaceChildren();

  if (prompts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = library.prompts.length === 0
      ? "还没有提示词。点击“新增提示词”，或导入 Chrome 扩展导出的 JSON。"
      : "没有匹配的提示词。";
    elements.promptList.append(empty);
    return;
  }

  for (const prompt of prompts.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))) {
    const card = document.createElement("article");
    card.className = "prompt-card";
    const header = document.createElement("div");
    header.className = "prompt-card-header";
    const title = document.createElement("h3");
    title.textContent = prompt.title;
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(
      button("编辑", "text-button", () => openPromptDialog(prompt)),
      button("删除", "text-button danger", async () => {
        if (!window.confirm(`确定删除“${prompt.title}”吗？`)) return;
        try {
          await window.promptAssistant.deletePrompt(prompt.id);
          showToast("提示词已删除");
        } catch (error) {
          showToast(error.message, "error");
        }
      })
    );
    header.append(title, actions);

    const content = document.createElement("p");
    content.className = "prompt-content";
    content.textContent = prompt.content;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const value of [...(prompt.tags ?? []), ...(prompt.aliases ?? [])].slice(0, 6)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = value;
      chips.append(chip);
    }
    card.append(header, content, chips);
    elements.promptList.append(card);
  }
}

function openPromptDialog(prompt = null) {
  elements.dialogTitle.textContent = prompt ? "编辑提示词" : "新增提示词";
  elements.promptId.value = prompt?.id ?? "";
  elements.titleInput.value = prompt?.title ?? "";
  elements.contentInput.value = prompt?.content ?? "";
  elements.keywordsInput.value = prompt?.keywords?.join("，") ?? "";
  elements.tagsInput.value = prompt?.tags?.join("，") ?? "";
  elements.aliasesInput.value = prompt?.aliases?.join(", ") ?? "";
  elements.dialog.showModal();
  elements.titleInput.focus();
}

async function updateSettings(partial) {
  try {
    library.settings = await window.promptAssistant.updateSettings(partial);
    updateStatus();
  } catch (error) {
    showToast(error.message, "error");
  }
}

elements.newButton.addEventListener("click", () => openPromptDialog());
elements.dialogCloseButton.addEventListener("click", () => elements.dialog.close());
elements.formCancelButton.addEventListener("click", () => elements.dialog.close());
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await window.promptAssistant.savePrompt({
      id: elements.promptId.value,
      title: elements.titleInput.value,
      content: elements.contentInput.value,
      keywords: splitList(elements.keywordsInput.value),
      tags: splitList(elements.tagsInput.value),
      aliases: splitList(elements.aliasesInput.value)
    });
    elements.dialog.close();
    showToast("提示词已保存");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.searchInput.addEventListener("compositionstart", () => { composingSearch = true; });
elements.searchInput.addEventListener("compositionend", () => { composingSearch = false; renderPrompts(); });
elements.searchInput.addEventListener("input", () => { if (!composingSearch) renderPrompts(); });

elements.triggerEnabled.addEventListener("change", () => updateSettings({ triggerEnabled: elements.triggerEnabled.checked }));
elements.launchAtLogin.addEventListener("change", () => updateSettings({ launchAtLogin: elements.launchAtLogin.checked }));
for (const [element, key] of [
  [elements.resultLimit, "resultLimit"],
  [elements.contentFontSize, "contentFontSize"],
  [elements.tagFontSize, "tagFontSize"]
]) {
  element.addEventListener("change", () => updateSettings({ [key]: Number.parseInt(element.value, 10) }));
}

elements.importButton.addEventListener("click", async () => {
  try {
    const result = await window.promptAssistant.importJson();
    if (!result.canceled) showToast(`已导入 ${result.imported} 条，共 ${result.total} 条`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.exportButton.addEventListener("click", async () => {
  try {
    const result = await window.promptAssistant.exportJson();
    if (!result.canceled) showToast(`已导出 ${result.count} 条提示词`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

window.promptAssistant.onLibraryChanged((payload) => {
  if (payload?.library) library = payload.library;
  if (payload?.status) status = payload.status;
  updateStatus();
  renderPrompts();
});
window.promptAssistant.onManagerNotice(({ message, type }) => showToast(message, type === "warning" ? "error" : type));

Promise.all([window.promptAssistant.getLibrary(), window.promptAssistant.getStatus()]).then(([nextLibrary, nextStatus]) => {
  library = nextLibrary;
  status = nextStatus;
  updateStatus();
  renderPrompts();
}).catch((error) => showToast(error.message, "error"));
