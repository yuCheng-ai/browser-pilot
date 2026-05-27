export function cleanText(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

export function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanText(value, 80)).filter(Boolean))];
}
