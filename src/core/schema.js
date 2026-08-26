"use strict";

const { randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;
const MAX_PROMPTS = 5000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_SELECTION_HISTORY = 2000;

const DEFAULT_SETTINGS = Object.freeze({
  triggerEnabled: true,
  resultLimit: 3,
  contentFontSize: 16,
  tagFontSize: 11,
  launchAtLogin: false
});

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number)
    ? Math.min(Math.max(number, minimum), maximum)
    : fallback;
}

function parseList(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[，,]/u);
  const unique = new Set();

  for (const item of source) {
    const normalized = String(item).trim();
    if (normalized) {
      unique.add(normalized.slice(0, 100));
    }
  }

  return [...unique].slice(0, 50);
}

function normalizeDate(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizePrompt(raw, { requireId = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("提示词条目必须是对象");
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const content = typeof raw.content === "string" ? raw.content : "";

  if (!title) {
    throw new Error("提示词标题不能为空");
  }
  if (!content.trim()) {
    throw new Error(`“${title}”的提示词内容不能为空`);
  }
  if (title.length > 100) {
    throw new Error(`“${title.slice(0, 20)}…”的标题超过 100 个字符`);
  }
  if (content.length > 20000) {
    throw new Error(`“${title}”的内容超过 20000 个字符`);
  }

  const now = new Date().toISOString();
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  if (requireId && !rawId) {
    throw new Error(`“${title}”缺少 id`);
  }

  return {
    id: rawId.slice(0, 200) || randomUUID(),
    title,
    content,
    keywords: parseList(raw.keywords),
    tags: parseList(raw.tags),
    aliases: parseList(raw.aliases),
    createdAt: normalizeDate(raw.createdAt, now),
    updatedAt: normalizeDate(raw.updatedAt, now)
  };
}

function normalizeSettings(raw = {}) {
  return {
    triggerEnabled: raw.triggerEnabled !== false,
    resultLimit: clampInteger(raw.resultLimit, 1, 20, DEFAULT_SETTINGS.resultLimit),
    contentFontSize: clampInteger(raw.contentFontSize, 12, 22, DEFAULT_SETTINGS.contentFontSize),
    tagFontSize: clampInteger(raw.tagFontSize, 9, 16, DEFAULT_SETTINGS.tagFontSize),
    launchAtLogin: raw.launchAtLogin === true
  };
}

function normalizeSelectionHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const history = [];

  for (const item of raw.slice(-MAX_SELECTION_HISTORY)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const promptId = typeof item.promptId === "string" ? item.promptId.trim().slice(0, 200) : "";
    const contentKey = typeof item.contentKey === "string" ? item.contentKey.trim().slice(0, 100) : "";
    const selectedAt = new Date(item.selectedAt);
    if (!promptId || !contentKey || Number.isNaN(selectedAt.getTime())) continue;

    const rawPreviousId = typeof item.previousPromptId === "string" ? item.previousPromptId.trim().slice(0, 200) : "";
    const rawPreviousKey = typeof item.previousContentKey === "string" ? item.previousContentKey.trim().slice(0, 100) : "";
    history.push({
      promptId,
      contentKey,
      previousPromptId: rawPreviousId && rawPreviousKey ? rawPreviousId : null,
      previousContentKey: rawPreviousId && rawPreviousKey ? rawPreviousKey : null,
      selectedAt: selectedAt.toISOString()
    });
  }

  return history;
}

function normalizeLibrary(raw = {}) {
  const source = Array.isArray(raw.prompts) ? raw.prompts : [];
  const prompts = [];

  for (const item of source.slice(0, MAX_PROMPTS)) {
    try {
      prompts.push(normalizePrompt(item));
    } catch (error) {
      console.warn("已忽略损坏的提示词：", error.message);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    prompts,
    settings: normalizeSettings(raw.settings)
  };
}

function normalizeImportDocument(document) {
  const incoming = Array.isArray(document) ? document : document?.prompts;
  if (!Array.isArray(incoming)) {
    throw new Error("JSON 顶层必须是提示词数组，或包含 prompts 数组");
  }
  if (incoming.length > MAX_PROMPTS) {
    throw new Error(`单次最多导入 ${MAX_PROMPTS} 条提示词`);
  }

  return incoming.map((item, index) => {
    try {
      return normalizePrompt(item);
    } catch (error) {
      throw new Error(`第 ${index + 1} 条数据无效：${error.message}`);
    }
  });
}

function createExportDocument(prompts) {
  return {
    format: "chatgpt-prompt-sidepanel",
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    prompts
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MAX_IMPORT_BYTES,
  MAX_PROMPTS,
  MAX_SELECTION_HISTORY,
  SCHEMA_VERSION,
  createExportDocument,
  normalizeImportDocument,
  normalizeLibrary,
  normalizePrompt,
  normalizeSelectionHistory,
  normalizeSettings,
  parseList
};
