(() => {
  const apiName = "__BROWSER_PILOT__";
  if (window[apiName]) {
    return;
  }

  const targetAttribute = "data-browser-pilot-target-id";
  const observerState = {
    dirtyRoots: new Set(),
    lastSnapshot: null,
    mutationObserver: null,
    nextTargetSerial: 1000,
    sequence: 0,
    suspended: false,
  };
  const interactiveSelector = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "summary",
    "[onclick]",
    "[onmousedown]",
    "[onmouseup]",
    "[onpointerdown]",
    "[onpointerup]",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[aria-multiline='true']",
    "[contenteditable]:not([contenteditable='false'])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function normalizeText(value, limit = 140) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function normalizeUrl(value) {
    try {
      return value ? new URL(String(value), location.href).href : "";
    } catch {
      return "";
    }
  }

  function installLinkPatch() {
    if (window.__BROWSER_PILOT_LINK_PATCH__) {
      return;
    }

    Object.defineProperty(window, "__BROWSER_PILOT_LINK_PATCH__", {
      configurable: false,
      value: true,
    });

    const originalOpen = window.open;
    window.open = function browserPilotOpen(url, target, features) {
      const next = normalizeUrl(url);
      if (next) {
        location.href = next;
        return window;
      }

      return originalOpen ? originalOpen.call(window, url, target, features) : null;
    };

    document.addEventListener(
      "click",
      (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }

        const start =
          event.target instanceof Element ? event.target : event.target?.parentElement;
        const anchor = start?.closest?.("a[href]");
        if (!anchor) {
          return;
        }

        const target = (anchor.getAttribute("target") || "").toLowerCase();
        if (target && target !== "_self") {
          event.preventDefault();
          location.href = anchor.href;
        }
      },
      true,
    );
  }

  function selectorPath(element) {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const path = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 6) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      let part = tag;

      if (parent) {
        const matchingSiblings = Array.from(parent.children).filter(
          (candidate) => candidate.tagName === current.tagName,
        );

        if (matchingSiblings.length > 1) {
          part += `:nth-of-type(${matchingSiblings.indexOf(current) + 1})`;
        }
      }

      path.unshift(part);
      current = parent;

      if (current?.tagName === "BODY") {
        path.unshift("body");
        break;
      }
    }

    return path.join(" > ");
  }

  function isVisible(element, rect) {
    const style = getComputedStyle(element);
    return (
      rect.width >= 4 &&
      rect.height >= 4 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= innerHeight &&
      rect.left <= innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none" &&
      !element.hasAttribute("disabled")
    );
  }

  function targetLabel(element) {
    const directLabel =
      normalizeText(element.getAttribute("aria-label")) ||
      normalizeText(element.getAttribute("placeholder")) ||
      normalizeText(element.getAttribute("aria-placeholder")) ||
      normalizeText(element.getAttribute("data-placeholder")) ||
      normalizeText(element.getAttribute("data-slate-placeholder")) ||
      normalizeText(element.getAttribute("data-lexical-placeholder")) ||
      normalizeText(element.getAttribute("title")) ||
      normalizeText(element.getAttribute("alt")) ||
      normalizeText(element.getAttribute("data-testid")) ||
      normalizeText(element.getAttribute("value"));

    if (directLabel) {
      return directLabel;
    }

    if (isEditableNode(element)) {
      return editableLabel(element);
    }

    return (
      normalizeText(element.innerText) ||
      normalizeText(element.textContent) ||
      element.tagName.toLowerCase()
    );
  }

  function isEditableNode(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const tag = element.tagName.toLowerCase();
    const role = normalizeText(element.getAttribute("role")).toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      role === "textbox" ||
      element.isContentEditable ||
      element.getAttribute("aria-multiline") === "true"
    );
  }

  function editableLabel(element) {
    const ancestorLabel = nearestEditableAttributeLabel(element);
    if (ancestorLabel) {
      return ancestorLabel;
    }

    const text = normalizeText(element.innerText || element.textContent);
    if (text) {
      return text;
    }

    return document.activeElement === element ? "active text editor" : "text editor";
  }

  function nearestEditableAttributeLabel(element) {
    let current = element;

    for (let depth = 0; current && depth < 5; depth += 1) {
      const label =
        normalizeText(current.getAttribute?.("aria-label")) ||
        normalizeText(current.getAttribute?.("placeholder")) ||
        normalizeText(current.getAttribute?.("aria-placeholder")) ||
        normalizeText(current.getAttribute?.("data-placeholder")) ||
        normalizeText(current.getAttribute?.("data-slate-placeholder")) ||
        normalizeText(current.getAttribute?.("data-lexical-placeholder")) ||
        normalizeText(current.getAttribute?.("title"));

      if (label) {
        return label;
      }

      current = current.parentElement;
    }

    return "";
  }

  function clippedBox(rect) {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(rect.width, innerWidth - x)),
      height: Math.max(0, Math.min(rect.height, innerHeight - y)),
    };
  }

  function readableText(element, limit = 420) {
    const parts = [
      element.innerText || element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
    ];

    element.querySelectorAll?.("img[alt],img[title],input[placeholder],textarea[placeholder]").forEach(
      (node) => {
        parts.push(
          node.getAttribute("alt"),
          node.getAttribute("title"),
          node.getAttribute("placeholder"),
        );
      },
    );

    return normalizeText(parts.filter(Boolean).join(" "), limit);
  }

  function isReasonableContentRoot(element) {
    if (!element || element === document.documentElement || element === document.body) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const text = readableText(element, 520);
    const area = rect.width * rect.height;
    return (
      text.length >= 6 &&
      isVisible(element, rect) &&
      rect.width <= innerWidth * 0.82 &&
      rect.height <= innerHeight * 0.82 &&
      area <= innerWidth * innerHeight * 0.24
    );
  }

  function nearestReasonableAncestor(element) {
    let current = element;
    let best = null;

    while (current && current !== document.body && current !== document.documentElement) {
      if (isReasonableContentRoot(current)) {
        best = current;
      }

      current = current.parentElement;
    }

    return best || element;
  }

  function contentRootFor(element) {
    const explicitRoot = element.closest?.(
      [
        "article",
        "[role='article']",
        "li",
        "[data-testid*='card' i]",
        "[data-testid*='note' i]",
        "[class*='card' i]",
        "[class*='note' i]",
        "[class*='item' i]",
        "[class*='feed-item' i]",
      ].join(","),
    );

    if (isReasonableContentRoot(explicitRoot)) {
      return explicitRoot;
    }

    return nearestReasonableAncestor(element);
  }

  function contentRole(element) {
    if (
      element.matches?.(
        [
          "article",
          "[role='article']",
          "li",
          "[data-testid*='card' i]",
          "[data-testid*='note' i]",
          "[class*='card' i]",
          "[class*='note' i]",
        ].join(","),
      )
    ) {
      return "card";
    }

    if (element.matches?.("h1,h2,h3,[role='heading']")) {
      return "heading";
    }

    return "content";
  }

  function targetContext(element) {
    if (isEditableNode(element)) {
      const editorContext = editableContext(element);
      if (editorContext) {
        return editorContext;
      }
    }

    const root = contentRootFor(element);
    const context = readableText(root || element, 280);
    const label = targetLabel(element);
    return context && context !== label ? context : "";
  }

  function editableContext(element) {
    const parts = [];
    let current = element.parentElement;

    for (let depth = 0; current && depth < 6; depth += 1) {
      const text = readableText(current, 180);
      if (isMeaningfulEditorContext(text)) {
        parts.push(text);
      }

      current = current.parentElement;
    }

    return normalizeText(parts.join(" "), 220);
  }

  function isMeaningfulEditorContext(text) {
    const value = normalizeText(text, 220);
    if (!value || /^[\d\s.,，。]+$/.test(value)) {
      return false;
    }

    return (
      /send|cancel|submit|comment|reply|post|publish|发送|取消|提交|评论|回复|发表|发布|留言/i.test(value) ||
      value.length <= 80
    );
  }

  function boxesIntersect(first, second) {
    return !(
      first.x + first.width < second.x ||
      second.x + second.width < first.x ||
      first.y + first.height < second.y ||
      second.y + second.height < first.y
    );
  }

  function boxArea(box) {
    return Math.max(0, box.width) * Math.max(0, box.height);
  }

  function boxCenter(box) {
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  }

  function boxContainsPoint(box, point) {
    return (
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    );
  }

  function overlapArea(first, second) {
    const x = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
    const y = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
    return x * y;
  }

  function bestContainingItemId(box, items) {
    const center = boxCenter(box);
    let best = null;
    let bestScore = -1;

    items.forEach((item) => {
      if (!item.box) {
        return;
      }

      const contains = boxContainsPoint(item.box, center);
      const overlap = overlapArea(box, item.box);
      if (!contains && overlap <= 0) {
        return;
      }

      const score = (contains ? 1000000 : 0) + overlap - boxArea(item.box) * 0.001;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    });

    return best?.id || "";
  }

  function relatedTargetIds(root, rootBox) {
    return Array.from(document.querySelectorAll(`[${targetAttribute}]`))
      .filter((element) => {
        if (root.contains(element)) {
          return true;
        }

        const rect = element.getBoundingClientRect();
        return boxesIntersect(rootBox, clippedBox(rect));
      })
      .map((element) => element.getAttribute(targetAttribute))
      .filter(Boolean)
      .slice(0, 8);
  }

  function regionRole(element) {
    const role = normalizeText(element.getAttribute("role"), 40).toLowerCase();
    const tag = element.tagName.toLowerCase();

    if (element === document.body) {
      return "viewport";
    }

    if (role) {
      return role;
    }

    if (tag === "header") {
      return "banner";
    }

    if (tag === "nav") {
      return "navigation";
    }

    if (tag === "main") {
      return "main";
    }

    if (tag === "aside") {
      return "complementary";
    }

    if (tag === "footer") {
      return "contentinfo";
    }

    if (tag === "form") {
      return "form";
    }

    return "section";
  }

  function regionLabel(element, role) {
    return (
      normalizeText(element.getAttribute("aria-label"), 100) ||
      normalizeText(element.getAttribute("title"), 100) ||
      normalizeText(element.getAttribute("data-testid"), 100) ||
      normalizeText(role, 100) ||
      readableText(element, 100)
    );
  }

  function inspectRegions() {
    const candidates = new Set([
      document.body,
      ...document.querySelectorAll(
        [
          "header",
          "nav",
          "main",
          "aside",
          "footer",
          "section",
          "form",
          "dialog[open]",
          "[role='banner']",
          "[role='navigation']",
          "[role='main']",
          "[role='complementary']",
          "[role='contentinfo']",
          "[role='dialog']",
          "[role='alertdialog']",
          "[role='search']",
          "[role='form']",
          "[aria-modal='true']",
        ].join(","),
      ),
    ]);
    const seen = new Set();

    return Array.from(candidates)
      .filter(Boolean)
      .map((element) => {
        const rect =
          element === document.body
            ? new DOMRect(0, 0, innerWidth, innerHeight)
            : element.getBoundingClientRect();
        const box = clippedBox(rect);
        const role = regionRole(element);
        const style = getComputedStyle(element);
        return {
          element,
          role,
          label: regionLabel(element, role),
          box,
          text: readableText(element, 220),
          visible:
            element === document.body ||
            (isVisible(element, rect) && style.display !== "contents"),
        };
      })
      .filter((item) => {
        if (!item.visible || item.box.width < 24 || item.box.height < 24) {
          return false;
        }

        if (item.role !== "viewport" && boxArea(item.box) < 2400) {
          return false;
        }

        const key = [
          item.role,
          Math.round(item.box.x),
          Math.round(item.box.y),
          Math.round(item.box.width),
          Math.round(item.box.height),
        ].join(":");
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .sort((first, second) => {
        if (first.role === "viewport") {
          return -1;
        }

        if (second.role === "viewport") {
          return 1;
        }

        return first.box.y - second.box.y || first.box.x - second.box.x;
      })
      .slice(0, 24)
      .map((item, index) => ({
        id: `region-${index + 1}`,
        role: item.role,
        label: item.label,
        text: item.text,
        box: item.box,
        targetIds: [],
        blockIds: [],
        inputIds: [],
        visualIds: [],
      }));
  }

  function inspectContent() {
    const roots = new Set();

    document.querySelectorAll(`[${targetAttribute}]`).forEach((element) => {
      roots.add(contentRootFor(element));
    });

    document
      .querySelectorAll(
        [
          "article",
          "[role='article']",
          "li",
          "h1",
          "h2",
          "h3",
          "p",
          "[role='heading']",
          "[class*='title' i]",
          "[class*='desc' i]",
          "[class*='content' i]",
          "[class*='comment' i]",
          "[class*='card' i]",
          "[class*='note' i]",
        ].join(","),
      )
      .forEach((element) => roots.add(contentRootFor(element)));

    const seen = new Set();
    return Array.from(roots)
      .filter(Boolean)
      .map((root) => {
        const rect = root.getBoundingClientRect();
        const box = clippedBox(rect);
        const text = readableText(root, 520);
        return {
          root,
          id: "",
          role: contentRole(root),
          text,
          box,
          targetIds: relatedTargetIds(root, box),
        };
      })
      .filter((item) => {
        if (
          item.text.length < 6 ||
          item.box.width < 8 ||
          item.box.height < 8 ||
          !isReasonableContentRoot(item.root) ||
          seen.has(item.text)
        ) {
          return false;
        }

        seen.add(item.text);
        return true;
      })
      .sort((first, second) => first.box.y - second.box.y || first.box.x - second.box.x)
      .slice(0, 35)
      .map((item, index) => ({
        id: `content-${index + 1}`,
        kind: item.role,
        role: item.role,
        text: item.text,
        targetIds: item.targetIds,
        box: item.box,
        regionId: "",
      }));
  }

  function visualKind(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "img" || tag === "picture" || tag === "video" || tag === "canvas" || tag === "svg") {
      return tag;
    }

    return "background";
  }

  function visualText(element) {
    const root = contentRootFor(element);
    return readableText(root || element, 360);
  }

  function inspectVisuals() {
    const candidates = new Set([
      ...document.querySelectorAll("img,picture,video,canvas,svg"),
      ...Array.from(document.querySelectorAll("a,button,div,span,li,article,section")).filter(
        (element) => getComputedStyle(element).backgroundImage !== "none",
      ),
    ]);
    const seen = new Set();

    return Array.from(candidates)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const box = clippedBox(rect);
        const style = getComputedStyle(element);
        const alt = normalizeText(element.getAttribute("alt"), 180);
        const title = normalizeText(element.getAttribute("title"), 180);
        const ariaLabel = normalizeText(element.getAttribute("aria-label"), 180);
        const nearbyText = visualText(element);
        const root = contentRootFor(element);
        return {
          element,
          root,
          kind: visualKind(element),
          alt,
          title,
          ariaLabel,
          nearbyText,
          targetIds: relatedTargetIds(root || element, box),
          box,
          hidden:
            style.display === "none" ||
            style.visibility === "hidden" ||
            box.width < 48 ||
            box.height < 48,
        };
      })
      .filter((item) => {
        if (item.hidden || item.box.width * item.box.height < 2400) {
          return false;
        }

        const key = [
          Math.round(item.box.x),
          Math.round(item.box.y),
          Math.round(item.box.width),
          Math.round(item.box.height),
          item.nearbyText,
        ].join(":");
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .sort((first, second) => first.box.y - second.box.y || first.box.x - second.box.x)
      .slice(0, 30)
      .map((item, index) => ({
        id: `visual-${index + 1}`,
        kind: item.kind,
        alt: item.alt,
        title: item.title,
        ariaLabel: item.ariaLabel,
        nearbyText: item.nearbyText,
        targetIds: item.targetIds,
        box: item.box,
        regionId: "",
      }));
  }

  function hasInlineHandler(element) {
    return [
      "onclick",
      "onmousedown",
      "onmouseup",
      "onpointerdown",
      "onpointerup",
      "ontouchstart",
    ].some((name) => element.hasAttribute(name) || typeof element[name] === "function");
  }

  function isSemanticInteractive(element, tag) {
    const role = normalizeText(element.getAttribute("role"));
    return (
      tag === "a" ||
      tag === "button" ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      tag === "summary" ||
      role === "button" ||
      role === "link" ||
      element.isContentEditable ||
      (element.hasAttribute("tabindex") && element.getAttribute("tabindex") !== "-1")
    );
  }

  function riskFor(target) {
    const source = [
      target.label,
      target.text,
      target.ariaLabel,
      target.title,
      target.type,
    ]
      .filter(Boolean)
      .join(" ");

    if (/pay|checkout|purchase|支付|付款|下单|购买/i.test(source)) {
      return { level: "high", reason: "目标可能触发支付或下单。" };
    }

    if (/delete|remove|publish|post|send|删除|移除|发布|发表|发送|清空/i.test(source)) {
      return { level: "high", reason: "目标可能删除或发布数据。" };
    }

    if (/submit|approve|confirm|提交|审批|通过|确认/i.test(source)) {
      return { level: "medium", reason: "目标可能提交或审批数据。" };
    }

    return null;
  }

  function walkInteractiveElements(root, options = {}) {
    const {
      limit = 180,
      deadlineMs = 0,
      viewportCull = true,
      bufRatio = { top: 0.5, bottom: 0.5, left: 0.3, right: 0.3 },
    } = options;

    const collected = [];
    const deadline = deadlineMs ? performance.now() + deadlineMs : 0;
    const bufTop = viewportCull ? innerHeight * bufRatio.top : 1e6;
    const bufBottom = viewportCull ? innerHeight * bufRatio.bottom : 1e6;
    const bufLeft = viewportCull ? innerWidth * bufRatio.left : 1e6;
    const bufRight = viewportCull ? innerWidth * bufRatio.right : 1e6;
    let checkCount = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(element) {
        checkCount++;
        if ((checkCount & 63) === 0) {
          if (collected.length >= limit) return NodeFilter.FILTER_REJECT;
          if (deadline && performance.now() > deadline) return NodeFilter.FILTER_REJECT;
        }

        const rect = element.getBoundingClientRect();

        if (rect.width < 4 || rect.height < 4) {
          return NodeFilter.FILTER_SKIP;
        }

        if (
          rect.bottom < -bufTop ||
          rect.top > innerHeight + bufBottom ||
          rect.right < -bufLeft ||
          rect.left > innerWidth + bufRight
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        if (isCandidateElement(element)) {
          collected.push(element);
        }

        return NodeFilter.FILTER_SKIP;
      },
    });

    while (walker.nextNode()) { /* traversal driven by acceptNode */ }
    return collected;
  }

  function candidateElements() {
    return walkInteractiveElements(document.body, {
      limit: 180,
      deadlineMs: 8000,
      viewportCull: true,
    });
  }

  function isShortTextCandidate(element) {
    const rect = element.getBoundingClientRect();
    const text = normalizeText(element.innerText || element.textContent, 90);
    const childElementCount = element.children?.length || 0;
    if (
      !text ||
      childElementCount > 2 ||
      rect.width < 8 ||
      rect.height < 8 ||
      rect.width > 260 ||
      rect.height > 90 ||
      !isVisible(element, rect)
    ) {
      return false;
    }

    return text.length <= 24;
  }

  function isEditableElement(element, tag) {
    const role = normalizeText(element.getAttribute("role")).toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      role === "textbox" ||
      element.isContentEditable ||
      element.getAttribute("aria-multiline") === "true"
    );
  }

  function isScrollableElement(element) {
    const style = getComputedStyle(element);
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
    return (
      /(auto|scroll)/.test(overflow) &&
      (element.scrollHeight > element.clientHeight + 2 ||
        element.scrollWidth > element.clientWidth + 2)
    );
  }

  function targetInteraction(element, tag) {
    const style = getComputedStyle(element);
    const role = normalizeText(element.getAttribute("role")).toLowerCase();
    const editable = isEditableElement(element, tag);
    const clickable =
      tag === "a" ||
      tag === "button" ||
      tag === "summary" ||
      role === "button" ||
      role === "link" ||
      hasInlineHandler(element) ||
      style.cursor === "pointer" ||
      isShortTextCandidate(element);

    return {
      clickable,
      editable,
      selectable: tag === "select",
      scrollable: isScrollableElement(element),
    };
  }

  function targetSemantics(element, tag, interaction) {
    const role = normalizeText(element.getAttribute("role"), 40).toLowerCase();
    const hints = new Set([tag]);

    if (role) {
      hints.add(role);
    }

    if (interaction.editable) {
      hints.add("text-entry");
    }

    if (interaction.clickable) {
      hints.add("click-action");
    }

    if (interaction.scrollable) {
      hints.add("scroll-container");
    }

    if (tag === "a" || role === "link") {
      hints.add("navigation");
    }

    if (tag === "img" || tag === "svg" || element.querySelector?.("img,svg")) {
      hints.add("visual");
    }

    if (isShortTextCandidate(element)) {
      hints.add("short-visible-text");
    }

    if (element.getAttribute("aria-haspopup")) {
      hints.add("opens-popup");
    }

    if (element.getAttribute("aria-expanded") !== null) {
      hints.add("expandable");
    }

    const kind = interaction.editable
      ? "input"
      : tag === "a" || role === "link"
        ? "navigation"
        : tag === "img" || tag === "svg"
          ? "visual"
          : "action";
    const confidence =
      isSemanticInteractive(element, tag) || hasInlineHandler(element)
        ? 0.9
        : interaction.clickable
          ? 0.72
          : 0.58;

    return {
      kind,
      role: role || tag,
      intentHints: Array.from(hints).slice(0, 8),
      confidence,
    };
  }

  function targetValue(element, tag) {
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      return "";
    }

    if (String(element.getAttribute("type") || "").toLowerCase() === "password") {
      return "";
    }

    return normalizeText(element.value, 160);
  }

  function serializeTarget(element, id) {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const interaction = targetInteraction(element, tag);
    const target = {
      id,
      selector: selectorPath(element),
      label: targetLabel(element),
      tag,
      type:
        normalizeText(element.getAttribute("type")) ||
        normalizeText(element.getAttribute("role")) ||
        tag,
      text: normalizeText(element.innerText || element.textContent),
      ariaLabel: normalizeText(element.getAttribute("aria-label")),
      title: normalizeText(element.getAttribute("title")),
      alt: normalizeText(element.getAttribute("alt")),
      placeholder: normalizeText(element.getAttribute("placeholder")),
      href: normalizeText(element.getAttribute("href")),
      value: targetValue(element, tag),
      context: targetContext(element),
      box: clippedBox(rect),
      visibility: "visible",
      interaction,
      semantics: targetSemantics(element, tag, interaction),
      regionId: "",
      blockId: "",
    };
    target.risk = riskFor(target);
    return target;
  }

  function inspectTargets() {
    observerState.suspended = true;
    document
      .querySelectorAll(`[${targetAttribute}]`)
      .forEach((element) => element.removeAttribute(targetAttribute));

    const targets = candidateElements()
      .slice(0, 180)
      .map((element, index) => {
        const id = `target-${index + 1}`;
        element.setAttribute(targetAttribute, id);
        return serializeTarget(element, id);
      });

    observerState.nextTargetSerial = Math.max(observerState.nextTargetSerial, targets.length + 1000);
    observerState.suspended = false;
    return targets;
  }

  function inspectInputs(targets) {
    const activeTargetId =
      document.activeElement instanceof Element
        ? document.activeElement.getAttribute(targetAttribute) || ""
        : "";

    return targets
      .filter((target) => target.interaction?.editable || target.interaction?.selectable)
      .slice(0, 40)
      .map((target, index) => ({
        id: `input-${index + 1}`,
        targetId: target.id,
        name: target.label,
        inputType: target.type || target.tag,
        placeholder: target.placeholder,
        value: target.value,
        context: target.context,
        active: target.id === activeTargetId,
        multiline: target.tag === "textarea" || target.semantics?.role === "textbox",
        box: target.box,
        regionId: target.regionId || "",
        blockId: target.blockId || "",
      }));
  }

  function inspectRelations({ regions, blocks, targets, inputs, visuals }) {
    const relations = [];

    regions.forEach((region) => {
      region.blockIds.forEach((blockId) => {
        relations.push({
          type: "contains",
          from: region.id,
          to: blockId,
          confidence: 0.92,
        });
      });

      region.targetIds.forEach((targetId) => {
        relations.push({
          type: "contains",
          from: region.id,
          to: targetId,
          confidence: 0.86,
        });
      });
    });

    blocks.forEach((block) => {
      block.targetIds.forEach((targetId) => {
        relations.push({
          type: "belongs_to",
          from: targetId,
          to: block.id,
          confidence: 0.82,
        });
      });
    });

    inputs.forEach((input) => {
      relations.push({
        type: "maps_to",
        from: input.id,
        to: input.targetId,
        confidence: 1,
      });
    });

    visuals.forEach((visual) => {
      visual.targetIds.forEach((targetId) => {
        relations.push({
          type: "near",
          from: targetId,
          to: visual.id,
          confidence: 0.7,
        });
      });
    });

    return relations.slice(0, 220);
  }

  function inspectPageState() {
    const activeTargetId =
      document.activeElement instanceof Element
        ? document.activeElement.getAttribute(targetAttribute) || ""
        : "";
    const dialogs = Array.from(
      document.querySelectorAll("dialog[open],[role='dialog'],[role='alertdialog'],[aria-modal='true']"),
    ).filter((element) => isVisible(element, element.getBoundingClientRect()));
    const fixedOverlays = Array.from(document.querySelectorAll("body *"))
      .slice(0, 800)
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position !== "fixed") {
          return false;
        }

        const box = clippedBox(element.getBoundingClientRect());
        return boxArea(box) > innerWidth * innerHeight * 0.35;
      });

    return {
      readyState: document.readyState,
      activeTargetId,
      hasModal: dialogs.length > 0,
      hasOverlay: fixedOverlays.length > 0,
      scroll: {
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        maxX: Math.max(0, Math.round(document.documentElement.scrollWidth - innerWidth)),
        maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)),
      },
    };
  }

  function enrichPageModel({ regions, blocks, targets, visuals }) {
    blocks.forEach((block) => {
      block.regionId = bestContainingItemId(block.box, regions);
    });

    targets.forEach((target) => {
      target.regionId = bestContainingItemId(target.box, regions);
      target.blockId =
        blocks.find((block) => block.targetIds.includes(target.id))?.id ||
        bestContainingItemId(target.box, blocks);
    });

    visuals.forEach((visual) => {
      visual.regionId = bestContainingItemId(visual.box, regions);
    });

    const inputs = inspectInputs(targets);

    regions.forEach((region) => {
      region.blockIds = blocks
        .filter((block) => block.regionId === region.id)
        .map((block) => block.id)
        .slice(0, 24);
      region.targetIds = targets
        .filter((target) => target.regionId === region.id)
        .map((target) => target.id)
        .slice(0, 40);
      region.inputIds = inputs
        .filter((input) => input.regionId === region.id)
        .map((input) => input.id)
        .slice(0, 16);
      region.visualIds = visuals
        .filter((visual) => visual.regionId === region.id)
        .map((visual) => visual.id)
        .slice(0, 16);
    });

    return {
      regions,
      blocks,
      targets,
      inputs,
      visuals,
      relations: inspectRelations({ regions, blocks, targets, inputs, visuals }),
    };
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || null));
  }

  function ensureMutationObserver() {
    if (observerState.mutationObserver || !document.documentElement) {
      return;
    }

    observerState.mutationObserver = new MutationObserver((records) => {
      if (observerState.suspended) {
        return;
      }

      records.forEach((record) => {
        markDirtyRoot(record.target);
        record.addedNodes.forEach(markDirtyRoot);
        record.removedNodes.forEach(markDirtyRoot);
      });
    });

    observerState.mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function markDirtyRoot(node) {
    const element =
      node instanceof Element
        ? node
        : node?.parentElement instanceof Element
          ? node.parentElement
          : null;

    if (!element || element === document.documentElement) {
      observerState.dirtyRoots.add(document.body);
      return;
    }

    observerState.dirtyRoots.add(actionableRootFor(element));
  }

  function actionableRootFor(element) {
    return (
      element.closest?.(
        [
          "dialog[open]",
          "[role='dialog']",
          "[role='alertdialog']",
          "[aria-modal='true']",
          "form",
          "article",
          "[role='article']",
          "[class*='comment' i]",
          "[class*='reply' i]",
          "[class*='input' i]",
          "[class*='editor' i]",
          "[class*='modal' i]",
          "[class*='dialog' i]",
          "[class*='card' i]",
          "[class*='note' i]",
          "main",
          "section",
        ].join(","),
      ) || element
    );
  }

  function isCandidateElement(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const style = getComputedStyle(element);
    const likelyInteractive =
      isSemanticInteractive(element, tag) ||
      hasInlineHandler(element) ||
      isShortTextCandidate(element) ||
      (style.cursor === "pointer" && rect.width >= 12 && rect.height >= 12);

    return likelyInteractive && isVisible(element, rect);
  }

  function candidateElementsFromRoots(roots) {
    const elements = [];
    const seen = new Set();
    const active = document.activeElement instanceof Element ? document.activeElement : null;

    function addUnique(element) {
      if (element && !seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }

    if (active) {
      addUnique(active);
      if (active.parentElement) {
        roots.push(active.parentElement);
      }
    }

    roots.slice(0, 16).forEach((root) => {
      const element = root instanceof Element ? root : null;
      if (!element) return;

      if (isCandidateElement(element)) {
        addUnique(element);
      }

      const found = walkInteractiveElements(element, {
        limit: 30,
        deadlineMs: 2000,
        viewportCull: false,
      });
      found.forEach(addUnique);
    });

    return elements.slice(0, 80);
  }

  function ensureTargetId(element) {
    const existing = element.getAttribute(targetAttribute);
    if (existing) {
      return existing;
    }

    observerState.nextTargetSerial += 1;
    const id = `target-${observerState.nextTargetSerial}`;
    element.setAttribute(targetAttribute, id);
    return id;
  }

  function targetDigest(target) {
    return [
      target.label,
      target.text,
      target.placeholder,
      target.value,
      target.context,
      target.visibility,
      target.risk,
      target.interaction?.clickable ? "c" : "",
      target.interaction?.editable ? "e" : "",
      target.interaction?.selectable ? "s" : "",
      target.box
        ? [
            Math.round(target.box.x),
            Math.round(target.box.y),
            Math.round(target.box.width),
            Math.round(target.box.height),
          ].join(",")
        : "",
    ].join("|");
  }

  function inputDigest(input) {
    return [
      input.name,
      input.inputType,
      input.placeholder,
      input.value,
      input.context,
      input.active ? "active" : "",
      input.blockId,
    ].join("|");
  }

  function regionDigest(region) {
    return [
      region.role,
      region.label,
      region.text,
      region.box
        ? [
            Math.round(region.box.x),
            Math.round(region.box.y),
            Math.round(region.box.width),
            Math.round(region.box.height),
          ].join(",")
        : "",
    ].join("|");
  }

  function scrollDigest(scroll) {
    return [
      Math.round(Number(scroll?.x) || 0),
      Math.round(Number(scroll?.y) || 0),
      Math.round(Number(scroll?.maxX) || 0),
      Math.round(Number(scroll?.maxY) || 0),
    ].join(",");
  }

  function compactTarget(target) {
    return {
      id: target.id,
      label: target.label,
      tag: target.tag,
      type: target.type,
      text: target.text,
      placeholder: target.placeholder,
      context: target.context,
      box: target.box,
      interaction: target.interaction,
      semantics: target.semantics,
      regionId: target.regionId || "",
      blockId: target.blockId || "",
      risk: target.risk || null,
    };
  }

  function compactInput(input) {
    return {
      id: input.id,
      targetId: input.targetId,
      name: input.name,
      inputType: input.inputType,
      placeholder: input.placeholder,
      value: input.value,
      context: input.context,
      active: Boolean(input.active),
      multiline: Boolean(input.multiline),
      box: input.box || null,
      regionId: input.regionId || "",
      blockId: input.blockId || "",
    };
  }

  function compactRegion(region) {
    return {
      id: region.id,
      role: region.role,
      label: region.label,
      text: region.text,
      box: region.box,
      targetIds: region.targetIds || [],
      blockIds: region.blockIds || [],
      inputIds: region.inputIds || [],
    };
  }

  function isActionButton(target) {
    if (!target?.interaction?.clickable) {
      return false;
    }

    const text = [
      target.label,
      target.text,
      target.placeholder,
      target.context,
      target.semantics?.kind,
      target.semantics?.role,
      ...(Array.isArray(target.semantics?.intentHints) ? target.semantics.intentHints : []),
    ]
      .filter(Boolean)
      .join(" ");

    return /send|submit|post|publish|comment|reply|confirm|save|发送|提交|发表|发布|评论|回复|确认|保存/i.test(text);
  }

  function buildChangedRegions(roots, previousSnapshot) {
    const previousRegions = new Map((previousSnapshot?.regions || []).map((region) => [region.id, region]));
    const regions = [];

    roots.slice(0, 12).forEach((root, index) => {
      const element = root instanceof Element ? root : document.body;
      const rect =
        element === document.body
          ? new DOMRect(0, 0, innerWidth, innerHeight)
          : element.getBoundingClientRect();
      const box = clippedBox(rect);
      if (box.width < 12 || box.height < 12) {
        return;
      }

      const previousId = bestContainingItemId(box, previousSnapshot?.regions || []);
      const role = regionRole(element);
      const region = {
        id: previousId || `region-diff-${index + 1}`,
        role,
        label: regionLabel(element, role),
        text: readableText(element, 220),
        box,
        targetIds: relatedTargetIds(element, box),
        blockIds: [],
        inputIds: [],
        visualIds: [],
      };
      const previous = previousRegions.get(region.id);
      if (!previous || regionDigest(previous) !== regionDigest(region)) {
        regions.push(region);
      }
    });

    return regions.slice(0, 8);
  }

  function applyActionablePatch(previousSnapshot, patch, changedTargets, changedInputs, changedRegions, pageState) {
    const next = cloneJson(previousSnapshot);
    next.title = document.title;
    next.url = location.href;
    next.viewport = {
      width: innerWidth,
      height: innerHeight,
    };
    next.state = pageState;

    const targetMap = new Map((next.targets || []).map((target) => [target.id, target]));
    patch.targets.disappeared.forEach((target) => targetMap.delete(target.id));
    changedTargets.forEach((target) => targetMap.set(target.id, target));
    next.targets = Array.from(targetMap.values()).slice(0, 180);

    const changedInputTargetIds = new Set(changedInputs.map((input) => input.targetId));
    const disappearedIds = new Set(patch.targets.disappeared.map((target) => target.id));
    const inputMap = new Map((next.inputs || []).map((input) => [input.targetId, input]));
    disappearedIds.forEach((id) => inputMap.delete(id));
    changedInputTargetIds.forEach((id) => inputMap.delete(id));
    changedInputs.forEach((input) => inputMap.set(input.targetId, input));
    next.inputs = Array.from(inputMap.values()).slice(0, 40);

    const regionMap = new Map((next.regions || []).map((region) => [region.id, region]));
    changedRegions.forEach((region) => regionMap.set(region.id, region));
    next.regions = Array.from(regionMap.values()).slice(0, 32);

    return next;
  }

  function observeActionableDiff(payload = {}) {
    ensureMutationObserver();
    if (payload.forceFull || !observerState.lastSnapshot) {
      const full = snapshot();
      return {
        kind: "full",
        schemaVersion: "browser-observation-v1",
        sequence: observerState.sequence,
        snapshot: full,
        patch: null,
      };
    }

    const previous = observerState.lastSnapshot;
    const previousTargets = new Map((previous.targets || []).map((target) => [target.id, target]));
    const previousInputs = new Map((previous.inputs || []).map((input) => [input.targetId, input]));
    const roots = Array.from(observerState.dirtyRoots).filter(Boolean);
    observerState.dirtyRoots.clear();

    const previousActiveTargetId = previous.state?.activeTargetId || "";
    const pageState = inspectPageState();
    const activeChanged = previousActiveTargetId !== pageState.activeTargetId;
    const scrollChanged = scrollDigest(previous.state?.scroll) !== scrollDigest(pageState.scroll);
    if (scrollChanged) {
      roots.unshift(document.body);
    }
    if (activeChanged && document.activeElement instanceof Element) {
      roots.unshift(document.activeElement);
    }

    const changedTargets = candidateElementsFromRoots(roots).map((element) =>
      serializeTarget(element, ensureTargetId(element)),
    );
    const changedTargetMap = new Map(changedTargets.map((target) => [target.id, target]));
    const addedTargets = [];
    const updatedTargets = [];

    changedTargets.forEach((target) => {
      const previousTarget = previousTargets.get(target.id);
      if (!previousTarget) {
        addedTargets.push(target);
      } else if (targetDigest(previousTarget) !== targetDigest(target)) {
        updatedTargets.push(target);
      }
    });

    const disappearedTargets = [];
    previousTargets.forEach((target, id) => {
      const selector = `[${targetAttribute}="${CSS.escape(id)}"]`;
      const element = document.querySelector(selector);
      if (!element || !isVisible(element, element.getBoundingClientRect())) {
        disappearedTargets.push(target);
      }
    });

    const changedInputs = inspectInputs(changedTargets);
    const addedInputs = [];
    const updatedInputs = [];
    changedInputs.forEach((input) => {
      const previousInput = previousInputs.get(input.targetId);
      if (!previousInput) {
        addedInputs.push(input);
      } else if (inputDigest(previousInput) !== inputDigest(input)) {
        updatedInputs.push(input);
      }
    });

    const activeInput =
      changedInputs.find((input) => input.active) ||
      (pageState.activeTargetId
        ? (previous.inputs || []).find((input) => input.targetId === pageState.activeTargetId)
        : null) ||
      null;
    const changedRegions = buildChangedRegions(roots, previous);
    const actionButtons = [...addedTargets, ...updatedTargets].filter(isActionButton);

    const patch = {
      schemaVersion: "actionable-diff-v1",
      sequence: observerState.sequence + 1,
      url: location.href,
      title: document.title,
      activeElement: {
        changed: activeChanged,
        previousTargetId: previousActiveTargetId,
        currentTargetId: pageState.activeTargetId,
        current: pageState.activeTargetId
          ? compactTarget(
              changedTargetMap.get(pageState.activeTargetId) ||
                previousTargets.get(pageState.activeTargetId) ||
                {},
            )
          : null,
      },
      editableInputs: {
        active: activeInput ? compactInput(activeInput) : null,
        added: addedInputs.map(compactInput).slice(0, 8),
        updated: updatedInputs.map(compactInput).slice(0, 8),
      },
      actionButtons: {
        addedOrUpdated: actionButtons.map(compactTarget).slice(0, 8),
      },
      targets: {
        added: addedTargets.map(compactTarget).slice(0, 12),
        updated: updatedTargets.map(compactTarget).slice(0, 12),
        disappeared: disappearedTargets.map(compactTarget).slice(0, 12),
      },
      regions: {
        changed: changedRegions.map(compactRegion),
      },
      summary: {
        dirtyRoots: roots.length,
        activeChanged,
        scrollChanged,
        newEditableInputs: addedInputs.length,
        updatedEditableInputs: updatedInputs.length,
        actionButtons: actionButtons.length,
        targetsAdded: addedTargets.length,
        targetsUpdated: updatedTargets.length,
        targetsDisappeared: disappearedTargets.length,
        regionsChanged: changedRegions.length,
      },
    };

    const nextSnapshot = applyActionablePatch(
      previous,
      patch,
      changedTargets,
      changedInputs,
      changedRegions,
      pageState,
    );
    observerState.sequence += 1;
    observerState.lastSnapshot = cloneJson(nextSnapshot);

    return {
      kind: "patch",
      schemaVersion: "browser-observation-v1",
      sequence: observerState.sequence,
      snapshot: nextSnapshot,
      patch,
    };
  }

  function snapshot() {
    observerState.suspended = true;
    const targets = inspectTargets();
    const content = inspectContent();
    const visuals = inspectVisuals();
    const model = enrichPageModel({
      regions: inspectRegions(),
      blocks: content.map((item) => ({ ...item })),
      targets,
      visuals,
    });

    const nextSnapshot = {
      schemaVersion: "page-json-v1",
      title: document.title,
      url: location.href,
      viewport: {
        width: innerWidth,
        height: innerHeight,
      },
      state: inspectPageState(),
      regions: model.regions,
      blocks: model.blocks,
      targets: model.targets,
      inputs: model.inputs,
      relations: model.relations,
      content: model.blocks,
      visuals: model.visuals,
    };

    observerState.lastSnapshot = cloneJson(nextSnapshot);
    observerState.dirtyRoots.clear();
    observerState.sequence += 1;
    observerState.suspended = false;
    ensureMutationObserver();
    return nextSnapshot;
  }

  function findTarget(targetId) {
    if (!targetId) {
      return null;
    }

    const selector = `[${targetAttribute}="${CSS.escape(targetId)}"]`;
    let element = document.querySelector(selector);
    if (element) {
      return element;
    }

    snapshot();
    return document.querySelector(selector);
  }

  function locateTarget({ targetId }) {
    const element = findTarget(targetId);
    if (!element) {
      return {
        ok: false,
        error: `DOM target expired: ${targetId}`,
      };
    }

    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return {
      ok: true,
      target: serializeTarget(element, targetId),
    };
  }

  function setNativeValue(element, value) {
    if (element.isContentEditable) {
      element.focus();
      const text = String(value || "");
      const selection = getSelection();
      const range = document.createRange();
      element.textContent = "";
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: "insertText",
        }),
      );

      if (!document.execCommand?.("insertText", false, text)) {
        element.textContent = text;
      }

      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        }),
      );
      return;
    }

    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function submitFrom(element) {
    const keyboardEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const notCancelled = element.dispatchEvent(keyboardEvent);

    const form = element.form || element.closest?.("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }

    if (form && typeof form.submit === "function") {
      form.submit();
      return true;
    }

    if (notCancelled) {
      element.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    return false;
  }

  function nearestScrollableAncestor(element) {
    let current = element?.parentElement || null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollableElement(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function scrollPage({ targetId, direction, amount }) {
    const element = targetId ? findTarget(targetId) : null;
    if (targetId && !element) {
      return {
        ok: false,
        error: `DOM target expired: ${targetId}`,
      };
    }

    const delta = direction === "up" ? -Math.abs(Number(amount) || 650) : Math.abs(Number(amount) || 650);
    const container =
      (element && isScrollableElement(element) ? element : null) ||
      nearestScrollableAncestor(element) ||
      document.scrollingElement ||
      document.documentElement;

    if (element && container === document.scrollingElement) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }

    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      window.scrollBy({ top: delta, left: 0, behavior: "instant" });
    } else {
      container.scrollBy({ top: delta, left: 0, behavior: "instant" });
      observerState.dirtyRoots.add(container);
    }

    observerState.dirtyRoots.add(document.body);

    return {
      ok: true,
      target: element ? serializeTarget(element, targetId) : null,
    };
  }

  function typeTarget({ targetId, text, submit }) {
    const element = findTarget(targetId);
    if (!element) {
      return {
        ok: false,
        error: `DOM target expired: ${targetId}`,
      };
    }

    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    element.focus();
    setNativeValue(element, String(text || ""));

    if (submit) {
      submitFrom(element);
    }

    return {
      ok: true,
      target: serializeTarget(element, targetId),
      submitted: Boolean(submit),
    };
  }

  installLinkPatch();

  Object.defineProperty(window, apiName, {
    configurable: false,
    value: {
      install: installLinkPatch,
      snapshot,
      observeActionableDiff,
      locateTarget,
      scrollPage,
      typeTarget,
    },
  });
})();
