"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createExportDocument,
  normalizeImportDocument,
  normalizeLibrary,
  normalizePrompt,
  normalizeSelectionHistory,
  normalizeSettings
} = require("../src/core/schema");
const {
  GLOBAL_USAGE_HALF_LIFE_MS,
  MAX_NEXT_PROMPTS_PER_SOURCE,
  MAX_TRANSITIONS,
  TRANSITION_HALF_LIFE_MS,
  migrateSelectionHistory,
  normalizeLearning,
  promptContentFingerprint,
  reconcileLearning,
  recordSelection,
  selectionReference
} = require("../src/core/learning");
const { filterPrompts, normalizeSearch } = require("../src/core/search");
const { withPromptSeparator } = require("../src/core/insertion");

const prompts = [
  normalizePrompt({
    id: "polish",
    title: "中文邮件润色",
    content: "请润色下面的邮件",
    keywords: ["润色", "邮件"],
    tags: ["工作", "常用"],
    aliases: ["polish", "email"],
    updatedAt: "2026-08-06T10:00:00.000Z"
  }),
  normalizePrompt({
    id: "translate",
    title: "中英翻译",
    content: "请翻译以下文字",
    keywords: ["翻译"],
    tags: ["语言"],
    aliases: ["translate"],
    updatedAt: "2026-08-06T11:00:00.000Z"
  })
];

test("插入提示词时自动保留一个尾部分隔空格", () => {
  assert.equal(withPromptSeparator("第一条提示词"), "第一条提示词 ");
  assert.equal(withPromptSeparator("已经有空格 "), "已经有空格 ");
  assert.equal(withPromptSeparator("保留换行\n"), "保留换行\n");
  assert.equal(withPromptSeparator(""), "");
  assert.equal(withPromptSeparator(null), "");
});

function approximately(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} 应接近 ${expected}`);
}

test("搜索兼容中文、英文别名与 NFKC 归一化", () => {
  assert.equal(normalizeSearch(" ＰＯＬＩＳＨ "), "polish");
  assert.deepEqual(filterPrompts(prompts, { query: "润色", limit: 3 }).map((item) => item.id), ["polish"]);
  assert.deepEqual(filterPrompts(prompts, { query: "POLISH", limit: 3 }).map((item) => item.id), ["polish"]);
});

test("双分号模式只搜索标签", () => {
  assert.deepEqual(filterPrompts(prompts, { mode: "tag", query: "工作", limit: 3 }).map((item) => item.id), ["polish"]);
  assert.deepEqual(filterPrompts(prompts, { mode: "tag", query: "翻译", limit: 3 }), []);
});

test("没有学习数据时按更新时间排序并限制条数", () => {
  assert.deepEqual(filterPrompts(prompts, { limit: 1 }).map((item) => item.id), ["translate"]);
});

test("聚合分数按 14 天和 30 天半衰期递推", () => {
  const start = new Date("2026-08-01T00:00:00.000Z").getTime();
  let learning = normalizeLearning();
  learning = recordSelection(learning, prompts[0], null, start).learning;
  learning = recordSelection(learning, prompts[0], null, start + GLOBAL_USAGE_HALF_LIFE_MS).learning;
  const globalStat = learning.promptStats.find((item) => item.promptId === prompts[0].id);
  approximately(globalStat.score, 1.5);
  assert.equal(globalStat.count, 2);

  const previous = selectionReference(prompts[0]);
  learning = recordSelection(learning, prompts[1], previous, start).learning;
  learning = recordSelection(learning, prompts[1], previous, start + TRANSITION_HALF_LIFE_MS).learning;
  const transition = learning.transitions.find((item) => item.toPromptId === prompts[1].id);
  approximately(transition.score, 1.5);
  assert.equal(transition.count, 2);
});

test("首次打开按照聚合后的近期使用频率排序", () => {
  const now = new Date("2026-08-12T10:00:00.000Z").getTime();
  let learning = normalizeLearning();
  learning = recordSelection(learning, prompts[0], null, now - 24 * 60 * 60 * 1000).learning;
  learning = recordSelection(learning, prompts[0], null, now - 60 * 60 * 1000).learning;
  assert.deepEqual(filterPrompts(prompts, { limit: 2, learning, now }).map((item) => item.id), ["polish", "translate"]);
});

test("下一条预测只使用真实聚合关系，正文变化后自动回退", () => {
  const draft = normalizePrompt({
    id: "draft",
    title: "起草",
    content: "起草一份正文",
    tags: ["工作"],
    updatedAt: "2026-08-06T09:00:00.000Z"
  });
  const review = normalizePrompt({
    id: "review",
    title: "校对",
    content: "校对这份正文",
    tags: ["工作"],
    updatedAt: "2026-08-06T08:00:00.000Z"
  });
  const translate = normalizePrompt({
    id: "translate-next",
    title: "翻译",
    content: "翻译这份正文",
    tags: ["工作"],
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  const now = new Date("2026-08-12T10:00:00.000Z").getTime();
  let learning = normalizeLearning();
  learning = recordSelection(learning, review, selectionReference(draft), now - 60 * 60 * 1000).learning;
  learning = recordSelection(learning, translate, null, now - 30 * 60 * 1000).learning;
  const options = { limit: 3, learning, now };

  assert.equal(filterPrompts([draft, review, translate], {
    ...options,
    previousSelection: selectionReference(draft)
  })[0].id, review.id);
  assert.equal(filterPrompts([draft, review, translate], {
    ...options,
    previousSelection: { promptId: draft.id, contentKey: promptContentFingerprint("正文已经修改") }
  })[0].id, translate.id);
  assert.deepEqual(filterPrompts([draft, review, translate], {
    ...options,
    query: "翻译",
    previousSelection: selectionReference(draft)
  }).map((item) => item.id), [translate.id]);
});

test("旧的原始事件会精确迁移且不会重复折算", () => {
  const now = new Date("2026-08-12T10:00:00.000Z").getTime();
  const polishKey = promptContentFingerprint(prompts[0].content);
  const translateKey = promptContentFingerprint(prompts[1].content);
  const history = [
    { promptId: "polish", contentKey: polishKey, previousPromptId: null, previousContentKey: null, selectedAt: "2026-08-12T08:00:00.000Z" },
    { promptId: "translate", contentKey: translateKey, previousPromptId: "polish", previousContentKey: polishKey, selectedAt: "2026-08-12T08:01:00.000Z" }
  ];
  const migrated = migrateSelectionHistory(normalizeLearning(), history, prompts, now);
  assert.equal(migrated.legacyMigration.eventCount, 2);
  assert.equal(migrated.promptStats.length, 2);
  assert.equal(migrated.transitions.length, 1);
  assert.deepEqual(migrateSelectionHistory(migrated, history, prompts, now), migrated);
});

test("每个来源最多保留十个下一条关系", () => {
  const source = normalizePrompt({ id: "source", title: "来源", content: "来源正文" });
  const targets = Array.from({ length: MAX_NEXT_PROMPTS_PER_SOURCE + 2 }, (_, index) => (
    normalizePrompt({ id: `target-${index}`, title: `目标 ${index}`, content: `目标正文 ${index}` })
  ));
  let learning = normalizeLearning();
  targets.forEach((target, index) => {
    learning = recordSelection(
      learning,
      target,
      selectionReference(source),
      new Date("2026-08-12T00:00:00.000Z").getTime() + index * 1000
    ).learning;
  });
  assert.equal(learning.transitions.length, MAX_NEXT_PROMPTS_PER_SOURCE);
});

test("聚合关系遵守全局上限并清理长期低分记录", () => {
  const now = new Date("2026-08-12T10:00:00.000Z").getTime();
  const isoTime = new Date(now).toISOString();
  const sources = Array.from({ length: 1001 }, (_, index) => (
    normalizePrompt({ id: `source-${index}`, title: `来源 ${index}`, content: `来源正文 ${index}` })
  ));
  const targets = Array.from({ length: 10 }, (_, index) => (
    normalizePrompt({ id: `shared-target-${index}`, title: `目标 ${index}`, content: `目标正文 ${index}` })
  ));
  const transitions = sources.flatMap((source) => targets.map((target) => ({
    fromPromptId: source.id,
    fromContentKey: promptContentFingerprint(source.content),
    toPromptId: target.id,
    toContentKey: promptContentFingerprint(target.content),
    score: 1,
    count: 1,
    scoreUpdatedAt: isoTime,
    lastSelectedAt: isoTime
  })));
  const capped = reconcileLearning({ promptStats: [], transitions }, [...sources, ...targets], now);
  assert.equal(capped.transitions.length, MAX_TRANSITIONS);

  const oldTime = new Date(now - 181 * 24 * 60 * 60 * 1000).toISOString();
  const stale = reconcileLearning({
    promptStats: [{
      ...selectionReference(targets[0]),
      score: 0.04,
      count: 1,
      scoreUpdatedAt: oldTime,
      lastSelectedAt: oldTime
    }],
    transitions: []
  }, targets, now);
  assert.equal(stale.promptStats.length, 0);
});

test("提示词字段、设置和旧历史会被安全规范化", () => {
  const prompt = normalizePrompt({ title: " 测试 ", content: "内容", tags: "工作，工作,常用" });
  assert.equal(prompt.title, "测试");
  assert.deepEqual(prompt.tags, ["工作", "常用"]);
  assert.deepEqual(normalizeSettings({ resultLimit: 99, contentFontSize: 2, tagFontSize: 50 }), {
    triggerEnabled: true,
    resultLimit: 20,
    contentFontSize: 12,
    tagFontSize: 16,
    launchAtLogin: false
  });
  assert.equal(normalizeSelectionHistory([{ promptId: "x", contentKey: "key", selectedAt: "invalid" }]).length, 0);
  assert.equal(Object.hasOwn(normalizeLibrary({ selectionHistory: [] }), "selectionHistory"), false);
  assert.deepEqual(normalizeLearning({ promptStats: [{ score: "NaN" }] }).promptStats, []);
});

test("正文修改清理聚合关系，只改标题则保留", () => {
  const source = normalizePrompt({ id: "source", title: "来源", content: "来源正文" });
  const target = normalizePrompt({ id: "target", title: "目标", content: "目标正文" });
  let learning = recordSelection(normalizeLearning(), target, selectionReference(source), Date.now()).learning;
  learning = reconcileLearning(learning, [{ ...source, title: "新标题" }, target]);
  assert.equal(learning.transitions.length, 1);
  learning = reconcileLearning(learning, [{ ...source, content: "修改后的正文" }, target]);
  assert.equal(learning.transitions.length, 0);
});

test("导入导出兼容 Chrome 扩展且不包含个人学习数据", () => {
  const document = createExportDocument(prompts);
  assert.equal(document.format, "chatgpt-prompt-sidepanel");
  assert.equal(normalizeImportDocument(document).length, 2);
  assert.equal(normalizeImportDocument(prompts).length, 2);
  assert.equal(Object.hasOwn(document, "learning"), false);
  assert.equal(Object.hasOwn(document, "selectionHistory"), false);
});
