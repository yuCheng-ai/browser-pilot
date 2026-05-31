// Generic browser-task language. This is not site-specific behavior; it centralizes planner vocabulary used for routing and ranking.
const intentPatterns = {
  navigation: [/https?:\/\//i, /www\./i, /[a-z0-9-]+\.[a-z]{2,}/i, /go to|open|visit|navigate|homepage|home page|website|site/i, /\u6253\u5f00|\u8bbf\u95ee|\u8fdb\u5165|\u53bb|\u4e3b\u9875|\u9996\u9875|\u7f51\u7ad9|\u7f51\u9875/],
  write: [/comment|reply|type|input|submit|send|post|write|publish/i, /\u8bc4\u8bba|\u56de\u590d|\u8f93\u5165|\u63d0\u4ea4|\u53d1\u9001|\u53d1\u5e03|\u7559\u8a00/],
  read: [/read|inspect|extract|summarize|copy|look|view/i, /\u770b\u4e00\u4e0b|\u67e5\u770b|\u9605\u8bfb|\u63d0\u53d6|\u603b\u7ed3|\u590d\u5236/],
  contentSelection: [/first|top|latest|open|click|select|choose|content|article|post|item/i, /\u7b2c\u4e00\u4e2a|\u6700\u4e0a|\u6700\u65b0|\u6253\u5f00|\u70b9\u51fb|\u70b9\u5f00|\u9009\u62e9|\u5185\u5bb9|\u5e16\u5b50|\u6587\u7ae0/],
  browserAction: [/click|open|select|choose|type|input|search|submit|send|post|comment|reply|navigate/i, /\u70b9\u51fb|\u70b9\u5f00|\u6253\u5f00|\u9009\u62e9|\u8f93\u5165|\u641c\u7d22|\u63d0\u4ea4|\u53d1\u9001|\u53d1\u8868|\u53d1\u5e03|\u8bc4\u8bba|\u56de\u590d|\u7559\u8a00|\u8bbf\u95ee|\u8fdb\u5165/],
  submitControl: [/send|submit|post|publish|comment|reply|confirm|save|ok|done/i, /\u53d1\u9001|\u63d0\u4ea4|\u53d1\u8868|\u53d1\u5e03|\u8bc4\u8bba|\u56de\u590d|\u786e\u8ba4|\u4fdd\u5b58|\u5b8c\u6210/],
  contentTarget: [/article|card|note|item|content|title|visual|navigation/i, /\u5e16\u5b50|\u5185\u5bb9|\u6587\u7ae0|\u7b14\u8bb0|\u56fe\u7247|\u89c6\u9891/],
  scroll: [/scroll|page down|move down|more content|below/i, /\u6eda\u52a8|\u4e0b\u6ed1|\u5411\u4e0b|\u5f80\u4e0b|\u4e0b\u65b9|\u66f4\u591a/],
  terminalNoAction: [/done|unsafe|risk|no target|not visible|not found/i, /\u5b8c\u6210|\u5df2\u5b8c\u6210|\u5371\u9669|\u98ce\u9669|\u65e0\u6cd5|\u4e0d\u80fd|\u6ca1\u6709|\u672a\u627e\u5230/],
};

export function matchesIntent(kind, value) {
  const text = String(value || "");
  return (intentPatterns[kind] || []).some((pattern) => pattern.test(text));
}
export function hasNavigationIntent(message) { return matchesIntent("navigation", message); }
export function hasWriteIntent(message) { return matchesIntent("write", message); }
export function hasReadIntent(message) { return matchesIntent("read", message); }
export function hasContentSelectionIntent(message) { return matchesIntent("contentSelection", message); }
export function hasBrowserActionIntent(message) { return matchesIntent("browserAction", message); }
export function hasScrollIntent(message) { return matchesIntent("scroll", message); }
export function isTerminalNoActionReply(reply) { return matchesIntent("terminalNoAction", reply); }
export function shouldUseIntentRouter({ message, progress }) {
  const step = Number(progress?.step) || 1;
  const history = Array.isArray(progress?.history) ? progress.history : [];
  // Always try intent-first routing on step 1 with no history — the LLM decides,
  // not hardcoded regex. This covers navigate, scroll, refresh, go_back, go_forward,
  // and returns needs_page when page observation is required.
  return step === 1 && history.length === 0;
}
