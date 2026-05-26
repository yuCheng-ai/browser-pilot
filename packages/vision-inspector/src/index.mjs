const visualRequestTerms = [
  /image/i,
  /picture/i,
  /photo/i,
  /screenshot/i,
  /ocr/i,
  /visual/i,
  /look like/i,
  /read.*image/i,
  /图/,
  /图片/,
  /照片/,
  /封面/,
  /截图/,
  /识别/,
  /看.*内容/,
  /图里/,
  /图中/,
  /图上/,
  /图片里/,
  /看得懂/,
];

export function requiresVisualUnderstanding(message) {
  const text = String(message || "");
  return visualRequestTerms.some((term) => term.test(text));
}

export function buildVisionContext({ message, state }) {
  const items = normalizeVisualItems(state?.visuals);
  const required = requiresVisualUnderstanding(message);

  return {
    required,
    supported: false,
    reason: required
      ? "Current DeepSeek planning path only receives DOM text, alt text, nearby text, and boxes. It does not receive image pixels."
      : "",
    items,
  };
}

export function normalizeVisualItems(visuals) {
  if (!Array.isArray(visuals)) {
    return [];
  }

  return visuals.slice(0, 30).map((item) => ({
    id: String(item.id || ""),
    kind: String(item.kind || "visual"),
    alt: cleanText(item.alt, 220),
    title: cleanText(item.title, 220),
    ariaLabel: cleanText(item.ariaLabel, 220),
    nearbyText: cleanText(item.nearbyText, 420),
    targetIds: Array.isArray(item.targetIds)
      ? item.targetIds.map((targetId) => String(targetId || "")).filter(Boolean).slice(0, 8)
      : [],
  }));
}

function cleanText(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
