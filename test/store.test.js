"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PromptStore } = require("../src/main/store");
const { PromptLearningStore } = require("../src/main/learning-store");
const { promptContentFingerprint } = require("../src/core/learning");

test("本地数据支持新增、编辑、删除、导入和重新加载", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-assistant-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "library.json");
  const store = new PromptStore(filePath);
  store.load();

  const saved = store.savePrompt({ title: "润色", content: "请润色以下内容", tags: ["工作"] });
  assert.equal(store.snapshot().prompts.length, 1);
  store.savePrompt({ ...saved, title: "邮件润色" });
  assert.equal(store.snapshot().prompts[0].title, "邮件润色");

  const imported = store.mergeImport({
    prompts: [{ id: "translate", title: "翻译", content: "请翻译", aliases: ["translate"] }]
  });
  assert.deepEqual(imported, { imported: 1, total: 2 });

  const reloaded = new PromptStore(filePath);
  reloaded.load();
  assert.equal(reloaded.snapshot().prompts.length, 2);
  assert.equal(reloaded.deletePrompt(saved.id), true);
  assert.equal(reloaded.snapshot().prompts.length, 1);
});

test("旧的 2000 条格式迁移到独立聚合文件且保持幂等", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-assistant-migration-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const libraryPath = path.join(directory, "prompt-library.json");
  const learningPath = path.join(directory, "prompt-learning.json");
  const prompts = [
    { id: "draft", title: "起草", content: "起草正文" },
    { id: "review", title: "校对", content: "校对正文" }
  ];
  const draftKey = promptContentFingerprint(prompts[0].content);
  const reviewKey = promptContentFingerprint(prompts[1].content);
  const legacyHistory = [
    { promptId: "draft", contentKey: draftKey, previousPromptId: null, previousContentKey: null, selectedAt: "2026-08-12T08:00:00.000Z" },
    { promptId: "review", contentKey: reviewKey, previousPromptId: "draft", previousContentKey: draftKey, selectedAt: "2026-08-12T08:01:00.000Z" }
  ];
  fs.writeFileSync(libraryPath, JSON.stringify({ prompts, selectionHistory: legacyHistory }), "utf8");

  const store = new PromptStore(libraryPath);
  store.load();
  assert.equal(store.legacyHistorySnapshot().length, 2);
  assert.equal(Object.hasOwn(store.snapshot(), "selectionHistory"), false);

  const learningStore = new PromptLearningStore(learningPath);
  learningStore.load(store.snapshot().prompts, store.legacyHistorySnapshot());
  const migrated = learningStore.snapshot();
  assert.equal(migrated.promptStats.length, 2);
  assert.equal(migrated.transitions.length, 1);
  assert.equal(migrated.legacyMigration.eventCount, 2);
  store.discardLegacySelectionHistory();
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(libraryPath, "utf8")), "selectionHistory"), false);
  assert.equal(fs.existsSync(`${libraryPath}.pre-aggregate-backup`), true);

  const reloaded = new PromptLearningStore(learningPath);
  reloaded.load(store.snapshot().prompts, legacyHistory);
  assert.deepEqual(reloaded.snapshot(), migrated);
});

test("聚合学习独立持久化并随正文修改和删除清理", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-assistant-learning-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const learningPath = path.join(directory, "prompt-learning.json");
  const draft = { id: "draft", title: "起草", content: "起草正文" };
  const review = { id: "review", title: "校对", content: "校对正文" };
  const store = new PromptLearningStore(learningPath);
  store.load([draft, review]);
  const first = store.record(draft, null, "2026-08-12T08:00:00.000Z");
  store.record(review, first, "2026-08-12T08:01:00.000Z");
  assert.equal(store.snapshot().transitions.length, 1);

  store.reconcile([{ ...draft, title: "起草邮件" }, review]);
  assert.equal(store.snapshot().transitions.length, 1);
  store.reconcile([{ ...draft, content: "正文已经变化" }, review]);
  assert.equal(store.snapshot().transitions.length, 0);
  assert.equal(store.snapshot().promptStats.some((item) => item.promptId === draft.id), false);

  store.reconcile([{ ...draft, content: "正文已经变化" }]);
  assert.equal(store.snapshot().promptStats.some((item) => item.promptId === review.id), false);
  const reloaded = new PromptLearningStore(learningPath);
  reloaded.load([{ ...draft, content: "正文已经变化" }]);
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
});
