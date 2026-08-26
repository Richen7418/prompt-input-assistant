"use strict";

function withPromptSeparator(content) {
  const value = String(content ?? "");
  if (!value || /\s$/u.test(value)) return value;
  return `${value} `;
}

module.exports = { withPromptSeparator };
