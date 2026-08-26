(() => {
"use strict";

const Learning = typeof module !== "undefined" && module.exports
  ? require("./learning")
  : globalThis.PromptLearning;
const { promptContentFingerprint, rankingStats } = Learning;

function normalizeSearch(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .normalize("NFKC");
}

function referenceToken(promptId, contentKey) {
  return JSON.stringify([promptId, contentKey]);
}

function compareNumbersDescending(left, right) {
  return right - left;
}

function comparePromptRank(left, right, stats) {
  const leftToken = referenceToken(left.id, promptContentFingerprint(left.content));
  const rightToken = referenceToken(right.id, promptContentFingerprint(right.content));
  const leftGlobal = stats.global.get(leftToken) ?? { score: 0, count: 0, lastSelectedAt: 0 };
  const rightGlobal = stats.global.get(rightToken) ?? { score: 0, count: 0, lastSelectedAt: 0 };

  if (stats.hasPrevious) {
    const leftTransition = stats.transitions.get(leftToken) ?? { score: 0, count: 0, lastSelectedAt: 0 };
    const rightTransition = stats.transitions.get(rightToken) ?? { score: 0, count: 0, lastSelectedAt: 0 };
    const leftHasTransition = leftTransition.score >= 0.01 ? 1 : 0;
    const rightHasTransition = rightTransition.score >= 0.01 ? 1 : 0;
    if (leftHasTransition !== rightHasTransition) return rightHasTransition - leftHasTransition;
    if (leftTransition.score !== rightTransition.score) return compareNumbersDescending(leftTransition.score, rightTransition.score);
    if (leftTransition.count !== rightTransition.count) return compareNumbersDescending(leftTransition.count, rightTransition.count);
    if (leftTransition.lastSelectedAt !== rightTransition.lastSelectedAt) {
      return compareNumbersDescending(leftTransition.lastSelectedAt, rightTransition.lastSelectedAt);
    }
  }

  if (leftGlobal.score !== rightGlobal.score) return compareNumbersDescending(leftGlobal.score, rightGlobal.score);
  if (leftGlobal.count !== rightGlobal.count) return compareNumbersDescending(leftGlobal.count, rightGlobal.count);
  if (leftGlobal.lastSelectedAt !== rightGlobal.lastSelectedAt) {
    return compareNumbersDescending(leftGlobal.lastSelectedAt, rightGlobal.lastSelectedAt);
  }

  const updatedDifference = new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime();
  if (Number.isFinite(updatedDifference) && updatedDifference !== 0) return updatedDifference;
  const titleDifference = String(left.title ?? "").localeCompare(String(right.title ?? ""), "zh-CN");
  return titleDifference || String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function filterPrompts(prompts, {
  mode = "prompt",
  query = "",
  limit = 3,
  learning = null,
  previousSelection = null,
  now = Date.now()
} = {}) {
  if (!Array.isArray(prompts)) return [];

  const normalizedQuery = normalizeSearch(query);
  const matches = prompts.filter((prompt) => {
    if (!prompt || typeof prompt !== "object") return false;
    const tags = Array.isArray(prompt.tags) ? prompt.tags : [];
    if (mode === "tag") {
      return tags.length > 0
        && (!normalizedQuery || tags.some((tag) => normalizeSearch(tag).includes(normalizedQuery)));
    }
    if (!normalizedQuery) return true;
    return [
      prompt.title,
      ...(Array.isArray(prompt.keywords) ? prompt.keywords : []),
      ...tags,
      ...(Array.isArray(prompt.aliases) ? prompt.aliases : [])
    ].map(normalizeSearch).join(" ").includes(normalizedQuery);
  });

  const stats = rankingStats(learning, previousSelection, Number.isFinite(Number(now)) ? Number(now) : Date.now());
  return matches
    .sort((left, right) => comparePromptRank(left, right, stats))
    .slice(0, Math.max(0, Number.parseInt(limit, 10) || 0));
}

const PromptSearch = Object.freeze({ filterPrompts, normalizeSearch });

if (typeof module !== "undefined" && module.exports) module.exports = PromptSearch;
if (typeof globalThis !== "undefined") globalThis.PromptSearch = PromptSearch;
})();
