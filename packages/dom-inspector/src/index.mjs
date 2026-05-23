const interactiveSelector = [
  "a",
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

export async function inspectInteractiveElements(page) {
  return page.evaluate((selector) => {
    function normalizeText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
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
      const style = window.getComputedStyle(element);
      return (
        rect.width >= 4 &&
        rect.height >= 4 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth &&
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

    function isLikelyInteractive(element, rect) {
      const tag = element.tagName.toLowerCase();
      const style = window.getComputedStyle(element);

      return (
        isSemanticInteractive(element, tag) ||
        hasInlineHandler(element) ||
        (style.cursor === "pointer" && rect.width >= 12 && rect.height >= 12)
      );
    }

    const candidates = new Set([
      ...document.querySelectorAll(selector),
      ...Array.from(document.querySelectorAll("a,div,span,li,img,svg")).filter(
        (element) => window.getComputedStyle(element).cursor === "pointer",
      ),
    ]);

    return Array.from(candidates)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();

        if (!isVisible(element, rect) || !isLikelyInteractive(element, rect)) {
          return null;
        }

        return {
          id: `target-${index + 1}`,
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
            width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.x)),
            height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.y)),
          },
        };
      })
      .filter(Boolean)
      .slice(0, 80);
  }, interactiveSelector);
}
