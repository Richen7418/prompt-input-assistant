"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  migrateSelectionHistory,
  normalizeLearning,
  reconcileLearning,
  recordSelection,
  selectionReference
} = require("../core/learning");

class PromptLearningStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.learning = normalizeLearning();
  }

  load(prompts, legacySelectionHistory = []) {
    let fileExists = true;
    let shouldPersist = false;
    try {
      this.learning = normalizeLearning(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.filePath, backupPath);
        } catch (backupError) {
          console.warn("无法备份损坏的学习数据：", backupError.message);
        }
        console.warn("提示词学习数据无法读取，已重新建立：", error.message);
      } else {
        fileExists = false;
      }
      this.learning = normalizeLearning();
      shouldPersist = true;
    }

    const before = JSON.stringify(this.learning);
    if (Array.isArray(legacySelectionHistory)
      && legacySelectionHistory.length > 0
      && !this.learning.legacyMigration) {
      this.learning = migrateSelectionHistory(this.learning, legacySelectionHistory, prompts);
    } else {
      this.learning = reconcileLearning(this.learning, prompts);
    }

    if (!fileExists || shouldPersist || before !== JSON.stringify(this.learning)) this.persist();
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.learning);
  }

  persistValue(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  persist() {
    this.persistValue(this.learning);
  }

  viewFor(previousSelection = null) {
    const previous = selectionReference(previousSelection);
    return structuredClone({
      schemaVersion: this.learning.schemaVersion,
      promptStats: this.learning.promptStats,
      transitions: previous
        ? this.learning.transitions.filter((item) => (
            item.fromPromptId === previous.promptId && item.fromContentKey === previous.contentKey
          ))
        : [],
      legacyMigration: null
    });
  }

  reconcile(prompts) {
    const candidate = reconcileLearning(this.learning, prompts);
    this.persistValue(candidate);
    this.learning = candidate;
    return this.snapshot();
  }

  record(selectedPrompt, previousSelection = null, selectedAt = new Date().toISOString()) {
    const result = recordSelection(this.learning, selectedPrompt, previousSelection, selectedAt);
    this.persistValue(result.learning);
    this.learning = result.learning;
    return structuredClone(result.selection);
  }
}

module.exports = { PromptLearningStore };
