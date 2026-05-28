const defaultEndpoint = `http://127.0.0.1:${process.env.BROWSER_PILOT_WEBVIEW_CDP_PORT || 9333}`;
const cdpTimeoutMs = 5000;

export async function webViewCdpStatus(options = {}) {
  const targets = await listTargets(options);
  const pages = targets
    .filter((target) => target.type === "page")
    .map((target) => ({
      title: target.title || "",
      url: target.url || "",
      id: target.id || "",
    }));

  return {
    ok: true,
    endpoint: endpoint(options),
    pages,
  };
}

export async function executeWebViewCdpAction({ action, state }, options = {}) {
  if (!action || typeof action !== "object") {
    throw new Error("missing browser action");
  }

  const targetInfo = await findTargetInfo(state?.url, options);
  const cdp = await CdpClient.connect(targetInfo.webSocketDebuggerUrl);
  const stateTarget = findStateTarget(state, action.targetId);

  try {
    await enableBestEffort(cdp, "Page.enable");
    await enableBestEffort(cdp, "Runtime.enable");
    await enableBestEffort(cdp, "DOM.enable");
    await enableBestEffort(cdp, "Input.setIgnoreInputEvents", {
      ignore: false,
    });
    await enableBestEffort(cdp, "Page.bringToFront");
    const beforePageState = await captureCompactPageState(cdp);
    const beforeFingerprint = fingerprintPageState(beforePageState);

    if (action.type === "navigate") {
      const url = normalizeUrl(action.url);
      await cdp.send("Page.navigate", { url });
      const progress = await waitForPageProgress(cdp, beforePageState, {
        actionType: "navigate",
      });
      return {
        ...progressResult({
          beforeFingerprint,
          beforePageState,
          progress,
        }),
        reply: progress.changed
          ? `已通过 CDP 打开 ${url}。`
          : `已通过 CDP 打开 ${url}，但未检测到页面变化。`,
        action: "navigate",
        url: progress.afterPageState?.url || url,
        point: null,
        target: null,
      };
    }

    if (action.type === "click") {
      const { point } = await locateTarget(cdp, action.targetId, stateTarget);
      await dispatchClick(cdp, point);
      const progress = await waitForPageProgress(cdp, beforePageState, {
        actionType: "click",
      });

      return {
        ...progressResult({
          beforeFingerprint,
          beforePageState,
          progress,
        }),
        reply: progress.changed
          ? `已通过 CDP 点击 ${stateTarget?.label || action.targetId}。`
          : `已通过 CDP 点击 ${stateTarget?.label || action.targetId}，但未检测到页面变化。`,
        action: "click",
        url: progress.afterPageState?.url || state?.url || targetInfo.url || "",
        point,
        target: stateTarget || null,
      };
    }

    if (action.type === "type") {
      const { point } = await locateTarget(cdp, action.targetId, stateTarget);
      await dispatchClick(cdp, point);
      await selectAll(cdp);
      await cdp.send("Input.insertText", {
        text: String(action.text || ""),
      });

      if (action.submit) {
        await pressEnter(cdp);
      }

      const progress = await waitForPageProgress(cdp, beforePageState, {
        actionType: "type",
      });
      return {
        ...progressResult({
          beforeFingerprint,
          beforePageState,
          progress,
        }),
        reply: action.submit
          ? progress.changed
            ? `已通过 CDP 输入并提交：${action.text || ""}。`
            : "已通过 CDP 输入并尝试提交，但未检测到页面变化。"
          : `已通过 CDP 输入：${action.text || ""}。`,
        action: "type",
        url: progress.afterPageState?.url || state?.url || targetInfo.url || "",
        point,
        target: stateTarget || null,
      };
    }

    if (action.type === "scroll") {
      const point = action.targetId
        ? (await locateTarget(cdp, action.targetId, stateTarget)).point
        : await viewportCenter(cdp);
      const amount = Math.max(80, Math.min(1800, Number(action.amount) || 650));
      const deltaY = action.direction === "up" ? -amount : amount;
      await dispatchWheel(cdp, point, deltaY);
      const progress = await waitForPageProgress(cdp, beforePageState, {
        actionType: "scroll",
      });
      return {
        ...progressResult({
          beforeFingerprint,
          beforePageState,
          progress,
        }),
        reply: progress.changed
          ? `已通过 CDP ${action.direction === "up" ? "向上" : "向下"}滚动。`
          : `已通过 CDP ${action.direction === "up" ? "向上" : "向下"}滚动，但未检测到页面变化。`,
        action: "scroll",
        url: progress.afterPageState?.url || state?.url || targetInfo.url || "",
        point,
        target: stateTarget || null,
      };
    }

    return {
      reply: "没有执行浏览器动作。",
      action: "none",
      url: state?.url || targetInfo.url || "",
      point: null,
      target: null,
    };
  } finally {
    cdp.close();
  }
}

async function findTargetInfo(expectedUrl, options) {
  const targets = await listTargets(options);
  const pages = targets.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );

  const exact = pages.find((page) => sameUrl(page.url, expectedUrl));
  if (exact) {
    return exact;
  }

  const external = pages.find((page) => isExternalPage(page.url));
  if (external) {
    return external;
  }

  if (pages[0]) {
    return pages[0];
  }

  throw new Error("没有找到可操作的 WebView 页面。");
}

async function listTargets(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 2500);

  try {
    const response = await fetch(new URL("/json/list", endpoint(options)), {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`CDP target list returned ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    throw new Error(
      `无法连接 Tauri WebView2 CDP，请确认桌面端已启动。${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function locateTarget(cdp, targetId, stateTarget) {
  if (!targetId) {
    throw new Error("missing targetId");
  }

  const result = await evaluate(cdp, buildLocateTargetScript(targetId, stateTarget));
  if (!result?.ok) {
    const label = stateTarget?.label ? ` (${stateTarget.label})` : "";
    throw new Error(result?.error || `target not found: ${targetId}${label}`);
  }

  const box = result.box;
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`target is not visible: ${targetId}`);
  }

  return {
    box,
    point: centerPoint(box),
  };
}

async function viewportCenter(cdp) {
  const viewport = await evaluate(
    cdp,
    "(() => ({ width: window.innerWidth || 1280, height: window.innerHeight || 900 }))()",
  );
  return {
    x: Math.round((Number(viewport?.width) || 1280) / 2),
    y: Math.round((Number(viewport?.height) || 900) / 2),
  };
}

export async function captureCompactPageState(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const active = document.activeElement;
      const activeText = active
        ? ("value" in active ? active.value : active.innerText || active.textContent || "")
        : "";
      const buttonLike = Array.from(document.querySelectorAll([
        "button",
        "input[type='button']",
        "input[type='submit']",
        "[role='button']",
        "[onclick]"
      ].join(",")));
      const actionButtonCount = buttonLike.filter((el) => {
        const text = normalize([
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("value")
        ].filter(Boolean).join(" "));
        return /send|submit|post|publish|search|confirm|save|ok|done|go|发送|提交|发表|发布|搜索|确认|保存|完成/.test(text.toLowerCase());
      }).length;
      const maxX = Math.max(0, document.documentElement.scrollWidth - innerWidth);
      const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        activeTag: active?.tagName || "",
        activeTargetId: active?.getAttribute?.("data-browser-pilot-target-id") || "",
        activeText: normalize(activeText).slice(0, 500),
        bodyTextSample: normalize(document.body?.innerText).slice(0, 3000),
        targetCount: document.querySelectorAll("[data-browser-pilot-target-id]").length,
        inputCount: document.querySelectorAll("input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])").length,
        actionButtonCount,
        scroll: {
          x: Math.round(scrollX || document.documentElement.scrollLeft || 0),
          y: Math.round(scrollY || document.documentElement.scrollTop || 0),
          maxX: Math.round(maxX),
          maxY: Math.round(maxY)
        },
        viewport: {
          width: Math.round(innerWidth || 0),
          height: Math.round(innerHeight || 0)
        }
      };
    })()`,
  );
}

export function fingerprintPageState(pageState) {
  const value = [
    urlWithoutHash(pageState?.url),
    cleanString(pageState?.title, 300),
    cleanString(pageState?.readyState, 40),
    cleanString(pageState?.activeTargetId, 80),
    normalizeComparableText(pageState?.bodyTextSample),
    Number(pageState?.targetCount) || 0,
    Number(pageState?.inputCount) || 0,
    Number(pageState?.scroll?.y) || 0,
    Number(pageState?.scroll?.maxY) || 0,
  ].join("|");
  return stableHash(value);
}

export function comparePageState(before, after) {
  const bodyTextChanged =
    stableHash(normalizeComparableText(before?.bodyTextSample)) !==
    stableHash(normalizeComparableText(after?.bodyTextSample));
  const activeTextChanged =
    stableHash(normalizeComparableText(before?.activeText)) !==
    stableHash(normalizeComparableText(after?.activeText));
  const signals = {
    urlChanged: urlWithoutHash(before?.url) !== urlWithoutHash(after?.url),
    titleChanged: cleanString(before?.title, 300) !== cleanString(after?.title, 300),
    activeTargetChanged: activeElementKey(before) !== activeElementKey(after),
    bodyTextChanged,
    activeTextChanged,
    targetCountChanged: Number(before?.targetCount) !== Number(after?.targetCount),
    inputCountChanged: Number(before?.inputCount) !== Number(after?.inputCount),
    scrollChanged: scrollChanged(before?.scroll, after?.scroll),
    readyStateChanged:
      cleanString(before?.readyState, 40) !== cleanString(after?.readyState, 40),
  };
  const changed = Object.values(signals).some(Boolean);

  return {
    changed,
    ...signals,
  };
}

export async function waitForPageProgress(cdp, before, options = {}) {
  const actionType = cleanString(options.actionType, 40);
  const timeoutMs =
    actionType === "navigate"
      ? 5000
      : actionType === "scroll"
        ? 1200
        : 2500;
  const intervalMs = 200;
  const deadline = Date.now() + timeoutMs;
  let afterPageState = before;
  let comparison = comparePageState(before, afterPageState);

  while (Date.now() < deadline) {
    await delay(intervalMs);
    const current = await safeCaptureCompactPageState(cdp);
    if (!current) {
      continue;
    }

    afterPageState = current;
    comparison = comparePageState(before, current);
    if (
      comparison.changed ||
      (actionType === "navigate" &&
        (comparison.urlChanged ||
          comparison.bodyTextChanged ||
          (comparison.readyStateChanged && current.readyState === "complete")))
    ) {
      return {
        changed: comparison.changed,
        signals: progressSignalsFromComparison(comparison),
        afterPageState,
        afterFingerprint: fingerprintPageState(afterPageState),
      };
    }
  }

  return {
    changed: comparison.changed,
    signals: progressSignalsFromComparison(comparison),
    afterPageState,
    afterFingerprint: fingerprintPageState(afterPageState),
  };
}

function buildLocateTargetScript(targetId, stateTarget) {
  const fallback = {
    selector: cleanString(stateTarget?.selector, 500),
    label: cleanString(stateTarget?.label, 180),
    text: cleanString(stateTarget?.text, 220),
    ariaLabel: cleanString(stateTarget?.ariaLabel, 180),
    title: cleanString(stateTarget?.title, 180),
    alt: cleanString(stateTarget?.alt, 180),
    placeholder: cleanString(stateTarget?.placeholder, 180),
    context: cleanString(stateTarget?.context, 260),
    box: normalizeBox(stateTarget?.box),
  };
  const attributeSelector = `[data-browser-pilot-target-id="${cssAttributeValue(targetId)}"]`;

  return `
(() => {
  const attributeSelector = ${JSON.stringify(attributeSelector)};
  const fallback = ${JSON.stringify(fallback)};
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width >= 4 &&
      rect.height >= 4 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= innerHeight &&
      rect.left <= innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none";
  };
  const boxOf = (el) => {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    return {
      x,
      y,
      width: Math.max(0, Math.min(rect.width, innerWidth - x)),
      height: Math.max(0, Math.min(rect.height, innerHeight - y))
    };
  };
  const measure = (el, source) => {
    if (!visible(el)) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = boxOf(el);
    return box.width > 0 && box.height > 0 ? { ok: true, source, box } : null;
  };
  const query = (selector, source) => {
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      return el ? measure(el, source) : null;
    } catch {
      return null;
    }
  };

  let found = query(attributeSelector, "target-id");
  if (found) return found;

  try {
    window.__BROWSER_PILOT__?.snapshot?.();
    found = query(attributeSelector, "target-id-after-refresh");
    if (found) return found;
  } catch {}

  found = query(fallback.selector, "selector");
  if (found) return found;

  const needles = [
    fallback.label,
    fallback.text,
    fallback.ariaLabel,
    fallback.title,
    fallback.alt,
    fallback.placeholder,
    fallback.context
  ].map(normalize).filter((value) => value.length >= 2);

  if (needles.length) {
    const candidates = Array.from(document.querySelectorAll([
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[aria-multiline='true']",
      "[contenteditable]:not([contenteditable='false'])",
      "[tabindex]:not([tabindex='-1'])",
      "[onclick]",
      "[class*='card' i]",
      "[class*='note' i]",
      "article",
      "li"
    ].join(",")));

    for (const el of candidates) {
      if (!visible(el)) continue;
      const haystack = normalize([
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("alt"),
        el.getAttribute("placeholder"),
        el.getAttribute("value")
      ].filter(Boolean).join(" "));

      if (!haystack) continue;
      if (needles.some((needle) => haystack === needle || haystack.includes(needle) || needle.includes(haystack))) {
        found = measure(el, "text");
        if (found) return found;
      }
    }
  }

  if (fallback.box && fallback.box.width > 0 && fallback.box.height > 0) {
    const x = fallback.box.x + fallback.box.width / 2;
    const y = fallback.box.y + fallback.box.height / 2;
    const el = document.elementFromPoint(x, y);
    if (visible(el)) {
      found = measure(el, "box-hit-test");
      if (found) return found;
    }

    return {
      ok: true,
      source: "stored-box",
      box: fallback.box
    };
  }

  return { ok: false, error: "target not found" };
})()
`;
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.text ||
        response.exceptionDetails.exception?.description ||
        "Runtime.evaluate failed",
    );
  }

  return response.result?.value;
}

async function dispatchClick(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    buttons: 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await delay(70);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function dispatchWheel(cdp, point, deltaY) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    buttons: 0,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
  });
}

async function selectAll(cdp) {
  const modifier = process.platform === "darwin" ? 4 : 2;
  const modifierKey = process.platform === "darwin" ? "Meta" : "Control";
  const modifierCode = process.platform === "darwin" ? "MetaLeft" : "ControlLeft";
  const modifierVk = process.platform === "darwin" ? 91 : 17;

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: modifierKey,
    code: modifierCode,
    windowsVirtualKeyCode: modifierVk,
    nativeVirtualKeyCode: modifierVk,
    modifiers: modifier,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: modifier,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: modifier,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: modifierKey,
    code: modifierCode,
    windowsVirtualKeyCode: modifierVk,
    nativeVirtualKeyCode: modifierVk,
    modifiers: 0,
  });
}

async function pressEnter(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function enableBestEffort(cdp, method, params = {}) {
  try {
    await cdp.send(method, params);
  } catch {
    // Optional domains may be unavailable on some WebView2 targets.
  }
}

function findStateTarget(state, targetId) {
  if (!targetId || !Array.isArray(state?.targets)) {
    return null;
  }

  return state.targets.find((target) => target.id === targetId) || null;
}

function sameUrl(left, right) {
  if (!left || !right) {
    return false;
  }

  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

function isExternalPage(url) {
  if (!url || url === "about:blank") {
    return false;
  }

  try {
    const parsed = new URL(url);
    return !(parsed.hostname === "127.0.0.1" && parsed.port === "5173");
  } catch {
    return true;
  }
}

function normalizeUrl(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error("url cannot be empty");
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input)) {
    return input;
  }

  return `https://${input}`;
}

function centerPoint(box) {
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

function progressResult({ beforeFingerprint, beforePageState, progress }) {
  return {
    ok: true,
    executed: true,
    changed: Boolean(progress.changed),
    progressSignals: progress.signals,
    beforePageState,
    afterPageState: progress.afterPageState,
    beforeFingerprint,
    afterFingerprint: progress.afterFingerprint,
  };
}

function progressSignalsFromComparison(comparison) {
  return {
    urlChanged: Boolean(comparison.urlChanged),
    titleChanged: Boolean(comparison.titleChanged),
    activeTargetChanged: Boolean(comparison.activeTargetChanged),
    bodyTextChanged: Boolean(comparison.bodyTextChanged),
    targetCountChanged: Boolean(comparison.targetCountChanged),
    inputCountChanged: Boolean(comparison.inputCountChanged),
    scrollChanged: Boolean(comparison.scrollChanged),
    readyStateChanged: Boolean(comparison.readyStateChanged),
    activeTextChanged: Boolean(comparison.activeTextChanged),
  };
}

async function safeCaptureCompactPageState(cdp) {
  try {
    return await captureCompactPageState(cdp);
  } catch {
    return null;
  }
}

function activeElementKey(state) {
  const targetId = cleanString(state?.activeTargetId, 80);
  if (targetId) {
    return `target:${targetId}`;
  }

  return [
    cleanString(state?.activeTag, 40),
    stableHash(normalizeComparableText(state?.activeText)),
  ].join(":");
}

function scrollChanged(before, after) {
  return (
    Math.abs((Number(before?.x) || 0) - (Number(after?.x) || 0)) > 5 ||
    Math.abs((Number(before?.y) || 0) - (Number(after?.y) || 0)) > 5 ||
    Math.abs((Number(before?.maxX) || 0) - (Number(after?.maxX) || 0)) > 5 ||
    Math.abs((Number(before?.maxY) || 0) - (Number(after?.maxY) || 0)) > 5
  );
}

function normalizeComparableText(value) {
  return cleanString(value, 4000).toLowerCase();
}

function urlWithoutHash(value) {
  const text = String(value || "");
  try {
    const url = new URL(text);
    url.hash = "";
    return url.href;
  } catch {
    return text.split("#")[0];
  }
}

function stableHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function endpoint(options) {
  return options.endpoint || process.env.BROWSER_PILOT_WEBVIEW_CDP_ENDPOINT || defaultEndpoint;
}

function cssAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cleanString(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizeBox(box) {
  if (!box || typeof box !== "object") {
    return null;
  }

  const normalized = {
    x: Number(box.x),
    y: Number(box.y),
    width: Number(box.width),
    height: Number(box.height),
  };

  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function errorMessage(error) {
  return error instanceof Error ? ` ${error.message}` : "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    this.socket.addEventListener("close", () => {
      this.rejectAll(new Error("CDP socket closed"));
    });
    this.socket.addEventListener("error", () => {
      this.rejectAll(new Error("CDP socket error"));
    });
  }

  static connect(webSocketDebuggerUrl) {
    if (!webSocketDebuggerUrl) {
      return Promise.reject(new Error("missing CDP websocket url"));
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("CDP websocket connect timeout"));
      }, cdpTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(new CdpClient(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP websocket connect failed"));
      });
    });
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, cdpTimeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });
      this.socket.send(message);
    });
  }

  close() {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    this.rejectAll(new Error("CDP client closed"));
  }

  handleMessage(data) {
    let payload;
    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }

    if (!payload.id) {
      return;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(payload.id);

    if (payload.error) {
      pending.reject(
        new Error(
          `${pending.method} failed: ${payload.error.message || "unknown CDP error"}`,
        ),
      );
      return;
    }

    pending.resolve(payload.result || {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
