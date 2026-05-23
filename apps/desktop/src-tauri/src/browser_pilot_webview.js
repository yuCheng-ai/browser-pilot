(() => {
  const apiName = "__BROWSER_PILOT__";
  if (window[apiName]) {
    return;
  }

  const targetAttribute = "data-browser-pilot-target-id";
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
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
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
    return (
      normalizeText(element.getAttribute("aria-label")) ||
      normalizeText(element.getAttribute("placeholder")) ||
      normalizeText(element.getAttribute("title")) ||
      normalizeText(element.getAttribute("value")) ||
      normalizeText(element.innerText) ||
      normalizeText(element.textContent) ||
      element.tagName.toLowerCase()
    );
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

    if (/delete|remove|publish|删除|移除|发布|清空/i.test(source)) {
      return { level: "high", reason: "目标可能删除或发布数据。" };
    }

    if (/submit|approve|confirm|提交|审批|通过|确认/i.test(source)) {
      return { level: "medium", reason: "目标可能提交或审批数据。" };
    }

    return null;
  }

  function candidateElements() {
    const elements = new Set([
      ...document.querySelectorAll(interactiveSelector),
      ...Array.from(document.querySelectorAll("a,button,div,span,li,img,svg")).filter(
        (element) => getComputedStyle(element).cursor === "pointer",
      ),
    ]);

    return Array.from(elements).filter((element) => {
      const rect = element.getBoundingClientRect();
      const tag = element.tagName.toLowerCase();
      const style = getComputedStyle(element);
      const likelyInteractive =
        isSemanticInteractive(element, tag) ||
        hasInlineHandler(element) ||
        (style.cursor === "pointer" && rect.width >= 12 && rect.height >= 12);

      return likelyInteractive && isVisible(element, rect);
    });
  }

  function serializeTarget(element, id) {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
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
      placeholder: normalizeText(element.getAttribute("placeholder")),
      href: normalizeText(element.getAttribute("href")),
      box: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.min(rect.width, innerWidth - Math.max(0, rect.x)),
        height: Math.min(rect.height, innerHeight - Math.max(0, rect.y)),
      },
    };
    target.risk = riskFor(target);
    return target;
  }

  function inspectTargets() {
    document
      .querySelectorAll(`[${targetAttribute}]`)
      .forEach((element) => element.removeAttribute(targetAttribute));

    return candidateElements()
      .slice(0, 100)
      .map((element, index) => {
        const id = `target-${index + 1}`;
        element.setAttribute(targetAttribute, id);
        return serializeTarget(element, id);
      });
  }

  function snapshot() {
    return {
      title: document.title,
      url: location.href,
      viewport: {
        width: innerWidth,
        height: innerHeight,
      },
      targets: inspectTargets(),
    };
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
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
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
      locateTarget,
      typeTarget,
    },
  });
})();
