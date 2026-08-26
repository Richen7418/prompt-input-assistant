(() => {
"use strict";

const LEARNING_SCHEMA_VERSION = 1;
const GLOBAL_USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const TRANSITION_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_RELATION_MS = 180 * 24 * 60 * 60 * 1000;
const MIN_STALE_SCORE = 0.05;
const MAX_NEXT_PROMPTS_PER_SOURCE = 10;
const MAX_TRANSITIONS = 10000;
const MAX_PROMPT_STATS = 5000;

function promptContentFingerprint(value) {
  const source = String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .normalize("NFKC");
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return `${source.length}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function selectionReference(value) {
  if (!value || typeof value !== "object") return null;
  const promptId = String(value.promptId ?? value.id ?? "").trim().slice(0, 200);
  const explicitKey = String(value.contentKey ?? "").trim().slice(0, 100);
  const contentKey = explicitKey || (typeof value.content === "string" ? promptContentFingerprint(value.content) : "");
  return promptId && contentKey ? { promptId, contentKey } : null;
}

function referenceToken(promptId, contentKey) {
  return JSON.stringify([promptId, contentKey]);
}

function transitionToken(fromPromptId, fromContentKey, toPromptId, toContentKey) {
  return JSON.stringify([fromPromptId, fromContentKey, toPromptId, toContentKey]);
}

function validTime(value, fallback = null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function validScore(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}

function validCount(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}

function normalizePromptStat(raw) {
  const reference = selectionReference(raw);
  const score = validScore(raw?.score);
  const count = validCount(raw?.count);
  const scoreUpdatedAt = validTime(raw?.scoreUpdatedAt);
  const lastSelectedAt = validTime(raw?.lastSelectedAt);
  if (!reference || !score || !count || !scoreUpdatedAt || !lastSelectedAt) return null;
  return { ...reference, score, count, scoreUpdatedAt, lastSelectedAt };
}

function normalizeTransition(raw) {
  const fromPromptId = String(raw?.fromPromptId ?? "").trim().slice(0, 200);
  const fromContentKey = String(raw?.fromContentKey ?? "").trim().slice(0, 100);
  const toPromptId = String(raw?.toPromptId ?? "").trim().slice(0, 200);
  const toContentKey = String(raw?.toContentKey ?? "").trim().slice(0, 100);
  const score = validScore(raw?.score);
  const count = validCount(raw?.count);
  const scoreUpdatedAt = validTime(raw?.scoreUpdatedAt);
  const lastSelectedAt = validTime(raw?.lastSelectedAt);
  if (!fromPromptId || !fromContentKey || !toPromptId || !toContentKey
    || !score || !count || !scoreUpdatedAt || !lastSelectedAt) return null;
  return {
    fromPromptId,
    fromContentKey,
    toPromptId,
    toContentKey,
    score,
    count,
    scoreUpdatedAt,
    lastSelectedAt
  };
}

function decayScore(score, scoreUpdatedAt, now, halfLife) {
  const updatedAt = new Date(scoreUpdatedAt).getTime();
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now) || halfLife <= 0) return 0;
  return validScore(score) * Math.pow(2, -Math.max(0, now - updatedAt) / halfLife);
}

function mergeStat(existing, incoming, halfLife) {
  if (!existing) return { ...incoming };
  const anchor = Math.max(new Date(existing.scoreUpdatedAt).getTime(), new Date(incoming.scoreUpdatedAt).getTime());
  const score = decayScore(existing.score, existing.scoreUpdatedAt, anchor, halfLife)
    + decayScore(incoming.score, incoming.scoreUpdatedAt, anchor, halfLife);
  return {
    ...existing,
    score,
    count: Math.min(existing.count + incoming.count, Number.MAX_SAFE_INTEGER),
    scoreUpdatedAt: new Date(anchor).toISOString(),
    lastSelectedAt: new Date(Math.max(
      new Date(existing.lastSelectedAt).getTime(),
      new Date(incoming.lastSelectedAt).getTime()
    )).toISOString()
  };
}

function normalizeLearning(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const promptStats = new Map();
  for (const item of Array.isArray(raw.promptStats) ? raw.promptStats : []) {
    const normalized = normalizePromptStat(item);
    if (!normalized) continue;
    const token = referenceToken(normalized.promptId, normalized.contentKey);
    promptStats.set(token, mergeStat(promptStats.get(token), normalized, GLOBAL_USAGE_HALF_LIFE_MS));
  }

  const transitions = new Map();
  for (const item of Array.isArray(raw.transitions) ? raw.transitions : []) {
    const normalized = normalizeTransition(item);
    if (!normalized) continue;
    const token = transitionToken(
      normalized.fromPromptId,
      normalized.fromContentKey,
      normalized.toPromptId,
      normalized.toContentKey
    );
    transitions.set(token, mergeStat(transitions.get(token), normalized, TRANSITION_HALF_LIFE_MS));
  }

  const legacyMigration = raw?.legacyMigration?.version === 1
    ? {
        version: 1,
        migratedAt: validTime(raw.legacyMigration.migratedAt, new Date(0).toISOString()),
        eventCount: Math.max(0, Number.parseInt(raw.legacyMigration.eventCount, 10) || 0)
      }
    : null;

  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    promptStats: [...promptStats.values()],
    transitions: [...transitions.values()],
    legacyMigration
  };
}

function effectiveScore(item, now, halfLife) {
  return decayScore(item.score, item.scoreUpdatedAt, now, halfLife);
}

function compareAggregates(left, right, now, halfLife) {
  const scoreDifference = effectiveScore(right, now, halfLife) - effectiveScore(left, now, halfLife);
  if (scoreDifference !== 0) return scoreDifference;
  if (left.count !== right.count) return right.count - left.count;
  const recentDifference = new Date(right.lastSelectedAt).getTime() - new Date(left.lastSelectedAt).getTime();
  if (recentDifference !== 0) return recentDifference;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function isStaleLowScore(item, now, halfLife) {
  const age = Math.max(0, now - new Date(item.lastSelectedAt).getTime());
  return age > STALE_RELATION_MS && effectiveScore(item, now, halfLife) < MIN_STALE_SCORE;
}

function pruneLearning(raw, now = Date.now()) {
  const learning = normalizeLearning(raw);
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  learning.promptStats = learning.promptStats
    .filter((item) => !isStaleLowScore(item, timestamp, GLOBAL_USAGE_HALF_LIFE_MS))
    .sort((left, right) => compareAggregates(left, right, timestamp, GLOBAL_USAGE_HALF_LIFE_MS))
    .slice(0, MAX_PROMPT_STATS);

  const bySource = new Map();
  for (const item of learning.transitions.filter((entry) => !isStaleLowScore(entry, timestamp, TRANSITION_HALF_LIFE_MS))) {
    const token = referenceToken(item.fromPromptId, item.fromContentKey);
    const values = bySource.get(token) ?? [];
    values.push(item);
    bySource.set(token, values);
  }

  learning.transitions = [...bySource.values()]
    .flatMap((values) => values
      .sort((left, right) => compareAggregates(left, right, timestamp, TRANSITION_HALF_LIFE_MS))
      .slice(0, MAX_NEXT_PROMPTS_PER_SOURCE))
    .sort((left, right) => compareAggregates(left, right, timestamp, TRANSITION_HALF_LIFE_MS))
    .slice(0, MAX_TRANSITIONS);
  return learning;
}

function reconcileLearning(raw, prompts, now = Date.now()) {
  const learning = normalizeLearning(raw);
  const references = new Map();
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    const reference = selectionReference(prompt);
    if (reference) references.set(reference.promptId, reference.contentKey);
  }

  learning.promptStats = learning.promptStats.filter((item) => references.get(item.promptId) === item.contentKey);
  learning.transitions = learning.transitions.filter((item) => (
    references.get(item.fromPromptId) === item.fromContentKey
    && references.get(item.toPromptId) === item.toContentKey
  ));
  return pruneLearning(learning, now);
}

function updateAggregate(item, timestamp, halfLife) {
  const existingUpdatedAt = item ? new Date(item.scoreUpdatedAt).getTime() : timestamp;
  const anchor = Math.max(timestamp, Number.isFinite(existingUpdatedAt) ? existingUpdatedAt : timestamp);
  const isoTime = new Date(anchor).toISOString();
  if (!item) {
    return { score: 1, count: 1, scoreUpdatedAt: isoTime, lastSelectedAt: isoTime };
  }
  return {
    score: decayScore(item.score, item.scoreUpdatedAt, anchor, halfLife) + 1,
    count: Math.min(item.count + 1, Number.MAX_SAFE_INTEGER),
    scoreUpdatedAt: isoTime,
    lastSelectedAt: new Date(Math.max(timestamp, new Date(item.lastSelectedAt).getTime())).toISOString()
  };
}

function recordSelection(raw, selectedPrompt, previousSelection = null, selectedAt = Date.now()) {
  const learning = normalizeLearning(raw);
  const selected = selectionReference(selectedPrompt);
  if (!selected) throw new Error("选中的提示词无效");
  const parsedTime = new Date(selectedAt).getTime();
  const timestamp = Number.isFinite(parsedTime) ? parsedTime : Date.now();
  const promptIndex = learning.promptStats.findIndex((item) => (
    item.promptId === selected.promptId && item.contentKey === selected.contentKey
  ));
  const promptAggregate = updateAggregate(learning.promptStats[promptIndex], timestamp, GLOBAL_USAGE_HALF_LIFE_MS);
  const nextPromptStat = { ...selected, ...promptAggregate };
  if (promptIndex >= 0) learning.promptStats[promptIndex] = nextPromptStat;
  else learning.promptStats.push(nextPromptStat);

  const previous = selectionReference(previousSelection);
  if (previous) {
    const transitionIndex = learning.transitions.findIndex((item) => (
      item.fromPromptId === previous.promptId
      && item.fromContentKey === previous.contentKey
      && item.toPromptId === selected.promptId
      && item.toContentKey === selected.contentKey
    ));
    const aggregate = updateAggregate(learning.transitions[transitionIndex], timestamp, TRANSITION_HALF_LIFE_MS);
    const transition = {
      fromPromptId: previous.promptId,
      fromContentKey: previous.contentKey,
      toPromptId: selected.promptId,
      toContentKey: selected.contentKey,
      ...aggregate
    };
    if (transitionIndex >= 0) learning.transitions[transitionIndex] = transition;
    else learning.transitions.push(transition);
  }

  return {
    learning: pruneLearning(learning, timestamp),
    selection: { ...selected }
  };
}

function addWeightedAggregate(map, token, identity, selectedAt, now, halfLife) {
  const parsedEventTime = new Date(selectedAt).getTime();
  if (!Number.isFinite(parsedEventTime)) return;
  const eventTime = Math.min(parsedEventTime, now);
  const current = map.get(token) ?? {
    ...identity,
    score: 0,
    count: 0,
    scoreUpdatedAt: new Date(now).toISOString(),
    lastSelectedAt: new Date(eventTime).toISOString()
  };
  current.score += Math.pow(2, -Math.max(0, now - eventTime) / halfLife);
  current.count = Math.min(current.count + 1, Number.MAX_SAFE_INTEGER);
  if (eventTime > new Date(current.lastSelectedAt).getTime()) {
    current.lastSelectedAt = new Date(eventTime).toISOString();
  }
  map.set(token, current);
}

function migrateSelectionHistory(raw, history, prompts, now = Date.now()) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const learning = normalizeLearning(raw);
  if (learning.legacyMigration) return reconcileLearning(learning, prompts, timestamp);

  const references = new Map();
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    const reference = selectionReference(prompt);
    if (reference) references.set(reference.promptId, reference.contentKey);
  }

  const promptStats = new Map(learning.promptStats.map((item) => {
    const identity = { promptId: item.promptId, contentKey: item.contentKey };
    return [referenceToken(item.promptId, item.contentKey), {
      ...identity,
      score: effectiveScore(item, timestamp, GLOBAL_USAGE_HALF_LIFE_MS),
      count: item.count,
      scoreUpdatedAt: new Date(timestamp).toISOString(),
      lastSelectedAt: item.lastSelectedAt
    }];
  }));
  const transitions = new Map(learning.transitions.map((item) => {
    const identity = {
      fromPromptId: item.fromPromptId,
      fromContentKey: item.fromContentKey,
      toPromptId: item.toPromptId,
      toContentKey: item.toContentKey
    };
    return [transitionToken(item.fromPromptId, item.fromContentKey, item.toPromptId, item.toContentKey), {
      ...identity,
      score: effectiveScore(item, timestamp, TRANSITION_HALF_LIFE_MS),
      count: item.count,
      scoreUpdatedAt: new Date(timestamp).toISOString(),
      lastSelectedAt: item.lastSelectedAt
    }];
  }));

  let eventCount = 0;
  for (const event of Array.isArray(history) ? history : []) {
    if (references.get(event?.promptId) !== event?.contentKey) continue;
    eventCount += 1;
    const selectedIdentity = { promptId: event.promptId, contentKey: event.contentKey };
    addWeightedAggregate(
      promptStats,
      referenceToken(event.promptId, event.contentKey),
      selectedIdentity,
      event.selectedAt,
      timestamp,
      GLOBAL_USAGE_HALF_LIFE_MS
    );

    if (event.previousPromptId
      && references.get(event.previousPromptId) === event.previousContentKey) {
      const transitionIdentity = {
        fromPromptId: event.previousPromptId,
        fromContentKey: event.previousContentKey,
        toPromptId: event.promptId,
        toContentKey: event.contentKey
      };
      addWeightedAggregate(
        transitions,
        transitionToken(
          event.previousPromptId,
          event.previousContentKey,
          event.promptId,
          event.contentKey
        ),
        transitionIdentity,
        event.selectedAt,
        timestamp,
        TRANSITION_HALF_LIFE_MS
      );
    }
  }

  return reconcileLearning({
    schemaVersion: LEARNING_SCHEMA_VERSION,
    promptStats: [...promptStats.values()],
    transitions: [...transitions.values()],
    legacyMigration: {
      version: 1,
      migratedAt: new Date(timestamp).toISOString(),
      eventCount
    }
  }, prompts, timestamp);
}

function rankingStats(raw, previousSelection = null, now = Date.now()) {
  const learning = normalizeLearning(raw);
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const global = new Map(learning.promptStats.map((item) => [
    referenceToken(item.promptId, item.contentKey),
    {
      score: effectiveScore(item, timestamp, GLOBAL_USAGE_HALF_LIFE_MS),
      count: item.count,
      lastSelectedAt: new Date(item.lastSelectedAt).getTime()
    }
  ]));
  const transitions = new Map();
  const previous = selectionReference(previousSelection);
  if (previous) {
    for (const item of learning.transitions) {
      if (item.fromPromptId !== previous.promptId || item.fromContentKey !== previous.contentKey) continue;
      transitions.set(referenceToken(item.toPromptId, item.toContentKey), {
        score: effectiveScore(item, timestamp, TRANSITION_HALF_LIFE_MS),
        count: item.count,
        lastSelectedAt: new Date(item.lastSelectedAt).getTime()
      });
    }
  }
  return { global, transitions, hasPrevious: Boolean(previous) };
}

const PromptLearning = Object.freeze({
  GLOBAL_USAGE_HALF_LIFE_MS,
  LEARNING_SCHEMA_VERSION,
  MAX_NEXT_PROMPTS_PER_SOURCE,
  MAX_TRANSITIONS,
  TRANSITION_HALF_LIFE_MS,
  decayScore,
  migrateSelectionHistory,
  normalizeLearning,
  promptContentFingerprint,
  rankingStats,
  reconcileLearning,
  recordSelection,
  selectionReference
});

if (typeof module !== "undefined" && module.exports) module.exports = PromptLearning;
if (typeof globalThis !== "undefined") globalThis.PromptLearning = PromptLearning;
})();
