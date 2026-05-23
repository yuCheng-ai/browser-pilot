import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import {
  classifyTargetRisk,
  getClickablePoint,
} from "../../../packages/browser-core/src/index.mjs";
import { inspectInteractiveElements } from "../../../packages/dom-inspector/src/index.mjs";

const viewport = {
  width: 1280,
  height: 900,
};

export class RiskBlockedError extends Error {
  constructor(risk) {
    super(risk.reason);
    this.name = "RiskBlockedError";
    this.risk = risk;
  }
}

export class BrowserPilotSession {
  constructor({ profileDir }) {
    this.profileDir = profileDir;
    this.context = null;
    this.launchPromise = null;
    this.manualInputQueue = Promise.resolve();
    this.page = null;
    this.targets = new Map();
    this.visibleWindow = false;
  }

  async snapshot() {
    const page = await this.ensurePage();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => {});
        const screenshot = (await page.screenshot({ type: "png" })).toString("base64");
        const inspectedTargets = await inspectInteractiveElements(page);
        const targets = inspectedTargets.map((target) => ({
          ...target,
          risk: classifyTargetRisk(target),
        }));

        this.targets = new Map(targets.map((target) => [target.id, target]));

        return {
          title: await page.title(),
          url: page.url(),
          screenshot,
          viewport,
          visibleWindow: this.visibleWindow,
          targets: targets.map(({ selector, text, ariaLabel, title, placeholder, href, ...target }) => target),
        };
      } catch (error) {
        if (attempt === 2 || !isNavigationRace(error)) {
          throw error;
        }

        await page.waitForTimeout(300);
      }
    }
  }

  async navigate(url) {
    const page = await this.ensurePage();
    await page.goto(normalizeUrl(url), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(350);
    return this.snapshot();
  }

  async refresh() {
    const page = await this.ensurePage();

    if (page.url() === "about:blank") {
      await this.renderStartPage(page);
    } else {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }

    await page.waitForTimeout(250);
    return this.snapshot();
  }

  async clickTarget(targetId, { confirmRisk = false } = {}) {
    const page = await this.ensurePage();
    const target = await this.requireTarget(targetId);

    if (target.risk && !confirmRisk) {
      throw new RiskBlockedError(target.risk);
    }

    const locator = page.locator(target.selector).first();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();

    if (!box) {
      throw new Error("目标当前不可点击。");
    }

    const point = getClickablePoint(box);
    const previousUrl = page.url();
    await page.mouse.click(point.x, point.y, { delay: 45 });
    await page.waitForTimeout(250);

    if (page.url() !== previousUrl) {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }

    await page.waitForTimeout(200);

    return {
      point,
      target,
      state: await this.snapshot(),
    };
  }

  async typeIntoTarget(targetId, text, { submit = false } = {}) {
    const { target } = await this.clickTarget(targetId, { confirmRisk: true });
    const page = await this.ensurePage();
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(text, { delay: 26 });

    if (submit) {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(350);

    return {
      target,
      state: await this.snapshot(),
    };
  }

  async pointerInput(input) {
    const operation = this.manualInputQueue
      .catch(() => {})
      .then(() => this.performPointerInput(input));

    this.manualInputQueue = operation;
    return operation;
  }

  async showVisibleBrowser() {
    const page = await this.ensurePage();
    const restoreUrl = page.url();

    if (!this.visibleWindow) {
      await this.relaunchContext({
        restoreUrl,
        visibleWindow: true,
      });
    }

    const visiblePage = await this.ensurePage();
    await visiblePage.bringToFront();
    return this.snapshot();
  }

  async performPointerInput(input) {
    const page = await this.ensurePage();
    const point = normalizeViewportPoint(input);

    if (input.type === "down") {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({
        button: mouseButton(input.button),
      });
    } else if (input.type === "move") {
      await page.mouse.move(point.x, point.y);
    } else if (input.type === "up") {
      await page.mouse.move(point.x, point.y);
      await page.mouse.up({
        button: mouseButton(input.button),
      });
    } else if (input.type === "wheel") {
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(
        clampWheel(input.deltaX),
        clampWheel(input.deltaY),
      );
    } else {
      throw new Error("不支持的手动鼠标事件。");
    }

    await page.waitForTimeout(input.type === "move" ? 24 : 90);

    if (input.capture === false) {
      return null;
    }

    return this.snapshot();
  }

  async requireTarget(targetId) {
    if (!this.targets.has(targetId)) {
      await this.snapshot();
    }

    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error("DOM 目标已失效，请刷新页面后重试。");
    }

    return target;
  }

  async ensurePage() {
    if (!this.context) {
      if (!this.launchPromise) {
        this.launchPromise = this.launchContext().catch((error) => {
          this.launchPromise = null;
          throw error;
        });
      }

      await this.launchPromise;
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    if (this.page.url() === "about:blank") {
      await this.renderStartPage(this.page);
    }

    return this.page;
  }

  async launchContext() {
    await this.launchContextWithOptions({
      visibleWindow: this.visibleWindow,
    });
  }

  async relaunchContext({ restoreUrl, visibleWindow }) {
    if (this.context) {
      await this.context.close();
    }

    this.context = null;
    this.launchPromise = null;
    this.page = null;
    this.targets.clear();
    this.visibleWindow = visibleWindow;
    await this.launchContextWithOptions({
      restoreUrl,
      visibleWindow,
    });
  }

  async launchContextWithOptions({ restoreUrl, visibleWindow }) {
    await mkdir(this.profileDir, { recursive: true });

    const options = {
      headless: !visibleWindow,
      viewport,
    };
    const preferredChannel = process.env.BROWSER_PILOT_BROWSER_CHANNEL || "chrome";

    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        ...options,
        channel: preferredChannel,
      });
    } catch (channelError) {
      this.context = await chromium.launchPersistentContext(this.profileDir, options);
    }

    this.page = this.context.pages()[0] || (await this.context.newPage());

    if (restoreUrl && restoreUrl !== "about:blank") {
      await this.page.goto(restoreUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {});
      await this.page.waitForTimeout(250);
    }
  }

  async renderStartPage(page) {
    await page.setContent(`
      <!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <title>BrowserPilot Start</title>
          <style>
            * { box-sizing: border-box; }
            body {
              align-items: center;
              background: #f4f7f8;
              color: #20242b;
              display: grid;
              font-family: "Segoe UI", "PingFang SC", sans-serif;
              height: 100vh;
              justify-items: center;
              margin: 0;
            }
            main {
              border-left: 4px solid #1f8a70;
              max-width: 560px;
              padding: 24px 28px;
            }
            h1 { font-size: 44px; letter-spacing: 0; margin: 0 0 8px; }
            p { color: #5d6972; font-size: 20px; margin: 0; }
          </style>
        </head>
        <body>
          <main>
            <h1>BrowserPilot</h1>
            <p>浏览器领航员</p>
          </main>
        </body>
      </html>
    `);
  }
}

function normalizeUrl(value) {
  const input = String(value || "").trim();

  if (!input) {
    throw new Error("地址不能为空。");
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input)) {
    return input;
  }

  return `https://${input}`;
}

function isNavigationRace(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("frame was detached") ||
    message.includes("because of a navigation")
  );
}

function normalizeViewportPoint(input) {
  return {
    x: clampCoordinate(input.x, viewport.width),
    y: clampCoordinate(input.y, viewport.height),
  };
}

function clampCoordinate(value, maximum) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error("手动输入坐标无效。");
  }

  return Math.min(maximum - 1, Math.max(0, Math.round(number)));
}

function clampWheel(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.min(1200, Math.max(-1200, Math.round(number)));
}

function mouseButton(value) {
  if (value === "middle" || value === "right") {
    return value;
  }

  return "left";
}
