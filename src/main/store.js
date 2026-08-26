"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_PROMPTS,
  normalizeImportDocument,
  normalizeLibrary,
  normalizePrompt,
  normalizeSelectionHistory,
  normalizeSettings
} = require("../core/schema");

class PromptStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.library = normalizeLibrary();
    this.legacySelectionHistory = [];
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const raw = JSON.parse(text);
      this.library = normalizeLibrary(raw);
      this.legacySelectionHistory = normalizeSelectionHistory(raw.selectionHistory);
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.filePath, backupPath);
        } catch (backupError) {
          console.warn("无法备份损坏的数据文件：", backupError.message);
        }
        console.warn("提示词数据无法读取，已使用空数据：", error.message);
      }
      this.library = normalizeLibrary();
      this.legacySelectionHistory = [];
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.library);
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.library, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }

  legacyHistorySnapshot() {
    return structuredClone(this.legacySelectionHistory);
  }

  discardLegacySelectionHistory() {
    if (this.legacySelectionHistory.length === 0) return false;
    const backupPath = `${this.filePath}.pre-aggregate-backup`;
    try {
      fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    this.persist();
    this.legacySelectionHistory = [];
    return true;
  }

  savePrompt(input) {
    const now = new Date().toISOString();
    const candidate = normalizePrompt({ ...input, updatedAt: now });
    const index = this.library.prompts.findIndex((prompt) => prompt.id === candidate.id);

    if (index >= 0) {
      const existing = this.library.prompts[index];
      candidate.createdAt = existing.createdAt;
      this.library.prompts[index] = candidate;
    } else {
      if (this.library.prompts.length >= MAX_PROMPTS) {
        throw new Error(`最多可保存 ${MAX_PROMPTS} 条提示词`);
      }
      this.library.prompts.push(candidate);
    }

    this.persist();
    return structuredClone(candidate);
  }

  deletePrompt(id) {
    const previousLength = this.library.prompts.length;
    this.library.prompts = this.library.prompts.filter((prompt) => prompt.id !== id);
    if (this.library.prompts.length !== previousLength) {
      this.persist();
      return true;
    }
    return false;
  }

  mergeImport(document) {
    const incoming = normalizeImportDocument(document);
    const merged = new Map(this.library.prompts.map((prompt) => [prompt.id, prompt]));
    for (const prompt of incoming) {
      merged.set(prompt.id, prompt);
    }
    if (merged.size > MAX_PROMPTS) {
      throw new Error(`合并后超过 ${MAX_PROMPTS} 条提示词上限`);
    }
    this.library.prompts = [...merged.values()];
    this.persist();
    return { imported: incoming.length, total: this.library.prompts.length };
  }

  updateSettings(input) {
    this.library.settings = normalizeSettings({ ...this.library.settings, ...input });
    this.persist();
    return structuredClone(this.library.settings);
  }
}

module.exports = { PromptStore };
