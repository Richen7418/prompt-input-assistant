"use strict";

const elements = {
  modeBadge: document.querySelector("#mode-badge"),
  targetName: document.querySelector("#target-name"),
  resultCount: document.querySelector("#result-count"),
  queryPrefix: document.querySelector("#query-prefix"),
  queryInput: document.querySelector("#query-input"),
  candidateList: document.querySelector("#candidate-list")
};

let prompts = [];
let learning = { promptStats: [], transitions: [] };
let settings = { resultLimit: 3, contentFontSize: 16, tagFontSize: 11 };
let mode = "prompt";
let previousSelection = null;
let hasSelectedPrompt = false;
let selectedIndex = 0;
let isComposing = false;
let submitting = false;
let pendingCloseRequest = null;
let focusRequestPending = false;

function rawText(extra = "") {
  return `${mode === "tag" ? ";;" : ";"}${elements.queryInput.value}${extra}`;
}

function syncPopupState() {
  window.promptAssistant.updatePopupState({ rawText: rawText(), mode });
}

function matches() {
  return window.PromptSearch.filterPrompts(prompts, {
    mode,
    query: elements.queryInput.value,
    limit: prompts.length,
    learning,
    previousSelection
  });
}

function updateSelectedCandidate(index, { scroll = true } = {}) {
  const candidates = Array.from(elements.candidateList.querySelectorAll(".candidate"));
  if (candidates.length === 0) {
    selectedIndex = 0;
    return;
  }
  selectedIndex = (index + candidates.length) % candidates.length;
  candidates.forEach((candidate, candidateIndex) => {
    candidate.classList.toggle("selected", candidateIndex === selectedIndex);
  });
  if (scroll) {
    candidates[selectedIndex].scrollIntoView({ block: "nearest" });
  }
}

async function choosePrompt(prompt) {
  if (!prompt || submitting) return;
  submitting = true;
  try {
    const result = await window.promptAssistant.selectPrompt(prompt.id);
    if (result?.sessionContinues) {
      learning = result.learning ?? learning;
      previousSelection = result.previousSelection ?? window.PromptLearning.selectionReference(prompt);
      hasSelectedPrompt = true;
      mode = "prompt";
      selectedIndex = 0;
      elements.queryInput.value = "";
      render();
      requestAnimationFrame(() => elements.queryInput.focus());
    }
  } catch (error) {
    console.error("插入提示词失败：", error);
  } finally {
    submitting = false;
    if (pendingCloseRequest) {
      const request = pendingCloseRequest;
      pendingCloseRequest = null;
      void closeCandidates(request.extra);
    }
  }
}

async function closeCandidates(extra = "") {
  if (submitting) {
    pendingCloseRequest = { extra };
    return;
  }
  submitting = true;
  try {
    if (hasSelectedPrompt) {
      await window.promptAssistant.closePopup();
    } else {
      await window.promptAssistant.cancelPopup(rawText(extra));
    }
  } catch (error) {
    console.error("关闭候选窗口失败：", error);
  } finally {
    submitting = false;
    pendingCloseRequest = null;
  }
}

function focusQueryInput() {
  elements.queryInput.focus({ preventScroll: true });
}

function handleCloseShortcut(event) {
  if (isComposing || event.isComposing || event.keyCode === 229) return false;
  const isSpace = event.key === " " || event.code === "Space";
  if (!isSpace && event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void closeCandidates(isSpace ? " " : "");
  return true;
}

function consumeShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function handleWindowShortcut(event) {
  if (isComposing || event.isComposing || event.keyCode === 229) return false;
  if (handleCloseShortcut(event)) return true;

  const isArrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  const isTab = event.key === "Tab";
  const isEnter = event.key === "Enter";
  if (!isArrow && !isTab && !isEnter) return false;

  consumeShortcut(event);
  if (submitting) return true;

  const candidates = matches();
  if (isArrow) {
    if (candidates.length === 0) return true;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    elements.candidateList.classList.add("keyboard-navigation");
    updateSelectedCandidate(selectedIndex + direction);
    return true;
  }
  if (isTab && candidates[selectedIndex]) {
    void choosePrompt(candidates[selectedIndex]);
  }
  return true;
}

function requestPopupKeyboardFocus() {
  if (document.hasFocus() || focusRequestPending || submitting) return;
  focusRequestPending = true;
  window.promptAssistant.focusPopup()
    .catch((error) => console.error("恢复候选窗口焦点失败：", error))
    .finally(() => { focusRequestPending = false; });
}

function render() {
  const candidates = matches();
  elements.candidateList.classList.remove("keyboard-navigation");
  if (selectedIndex >= candidates.length) selectedIndex = Math.max(0, candidates.length - 1);
  elements.modeBadge.textContent = previousSelection ? "预测下一条" : (mode === "tag" ? "标签检索" : "提示词检索");
  elements.queryPrefix.textContent = mode === "tag" ? ";;" : ";";
  elements.resultCount.textContent = `${candidates.length} 条`;
  elements.candidateList.replaceChildren();

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = mode === "tag" ? "没有匹配该标签的提示词" : "没有匹配的提示词";
    elements.candidateList.append(empty);
    syncPopupState();
    return;
  }

  candidates.forEach((prompt, index) => {
    const candidate = document.createElement("button");
    candidate.type = "button";
    candidate.className = `candidate${index === selectedIndex ? " selected" : ""}`;
    candidate.dataset.index = String(index);

    const titleRow = document.createElement("div");
    titleRow.className = "candidate-title-row";
    const title = document.createElement("span");
    title.className = "candidate-title";
    title.textContent = prompt.title;
    const tags = document.createElement("span");
    tags.className = "candidate-tags";
    tags.textContent = (prompt.tags ?? []).slice(0, 3).map((tag) => `#${tag}`).join(" ");
    titleRow.append(title, tags);

    const content = document.createElement("div");
    content.className = "candidate-content";
    content.textContent = prompt.content;
    candidate.append(titleRow, content);
    candidate.addEventListener("mouseenter", () => {
      elements.candidateList.classList.remove("keyboard-navigation");
      if (selectedIndex !== index) {
        updateSelectedCandidate(index, { scroll: false });
      }
    });
    candidate.addEventListener("pointermove", () => {
      if (!elements.candidateList.classList.contains("keyboard-navigation")) return;
      elements.candidateList.classList.remove("keyboard-navigation");
      updateSelectedCandidate(index, { scroll: false });
    });
    candidate.addEventListener("click", () => choosePrompt(prompt));
    elements.candidateList.append(candidate);
  });
  syncPopupState();
}

function applySettings() {
  document.documentElement.style.setProperty("--content-size", `${settings.contentFontSize}px`);
  document.documentElement.style.setProperty("--tag-size", `${settings.tagFontSize}px`);
}

elements.queryInput.addEventListener("compositionstart", () => { isComposing = true; });
elements.queryInput.addEventListener("compositionend", () => {
  isComposing = false;
  selectedIndex = 0;
  render();
});
elements.queryInput.addEventListener("input", () => {
  if (mode === "prompt" && elements.queryInput.value.startsWith(";")) {
    mode = "tag";
    elements.queryInput.value = elements.queryInput.value.slice(1);
  }
  if (!isComposing) {
    selectedIndex = 0;
    render();
  }
});

window.addEventListener("keydown", handleWindowShortcut, true);
window.addEventListener("focus", () => {
  if (!submitting) requestAnimationFrame(focusQueryInput);
});
elements.candidateList.addEventListener("pointermove", requestPopupKeyboardFocus);
elements.candidateList.addEventListener("pointerdown", requestPopupKeyboardFocus);

window.promptAssistant.onPopupOpen((payload) => {
  prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
  learning = payload.learning ?? { promptStats: [], transitions: [] };
  settings = { ...settings, ...payload.settings };
  mode = payload.mode === "tag" ? "tag" : "prompt";
  selectedIndex = 0;
  previousSelection = payload.previousSelection ?? null;
  hasSelectedPrompt = Boolean(previousSelection);
  submitting = false;
  pendingCloseRequest = null;
  focusRequestPending = false;
  elements.queryInput.value = "";
  elements.targetName.textContent = payload.targetName ? `插入到 ${payload.targetName}` : "";
  applySettings();
  render();
  focusQueryInput();
  requestAnimationFrame(focusQueryInput);
});

window.promptAssistant.onLibraryChanged((payload) => {
  if (payload?.library?.prompts) prompts = payload.library.prompts;
  if (payload?.library?.settings) settings = { ...settings, ...payload.library.settings };
  if (payload?.learning) learning = payload.learning;
  if (payload && Object.hasOwn(payload, "previousSelection")) {
    previousSelection = payload.previousSelection;
    hasSelectedPrompt = Boolean(previousSelection);
  }
  applySettings();
  render();
});
