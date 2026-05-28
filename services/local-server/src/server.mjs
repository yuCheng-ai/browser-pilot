import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserPilotSession,
  RiskBlockedError,
} from "../../../integrations/playwright/src/index.mjs";
import {
  webViewCdpStatus,
} from "../../../integrations/playwright/src/webview-cdp.mjs";
import {
  executeSessionBrowserActions,
  executeWebViewBrowserActions,
  executeWebViewBrowserAction,
} from "./browser-tools.mjs";
import {
  buildAgentObservations,
  planBrowserAction,
} from "./deepseek-agent.mjs";
import { buildVisionContext } from "../../../packages/vision-inspector/src/index.mjs";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(serviceDir, "../../..");
const settingsPath = join(rootDir, "storage", "sqlite", "settings.json");
const profileDir = join(rootDir, "storage", "profiles", "default");
const port = Number(process.env.BROWSER_PILOT_PORT || 4178);
const session = new BrowserPilotSession({ profileDir });

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      send(response, 204);
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, publicSettings(await loadSettings()));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const payload = await readJson(request);
      const settings = await saveSettings(payload);
      sendJson(response, 200, publicSettings(settings));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/browser/state") {
      sendJson(response, 200, await session.snapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/navigate") {
      const payload = await readJson(request);
      sendJson(response, 200, await session.navigate(payload.url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/refresh") {
      sendJson(response, 200, await session.refresh());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/click") {
      const payload = await readJson(request);
      const result = await session.clickTarget(payload.targetId, {
        confirmRisk: Boolean(payload.confirmRisk),
      });
      sendJson(response, 200, result.state);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/pointer") {
      const payload = await readJson(request);
      const state = await session.pointerInput(payload);
      sendJson(response, 200, state || { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/browser/show") {
      sendJson(response, 200, await session.showVisibleBrowser());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/webview-cdp/status") {
      sendJson(response, 200, await webViewCdpStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/webview-cdp/execute") {
      const payload = await readJson(request);
      if (Array.isArray(payload?.actions)) {
        sendJson(response, 200, {
          results: await executeWebViewBrowserActions(payload, {
            maxActions: 2,
          }),
        });
        return;
      }

      sendJson(response, 200, await executeWebViewBrowserAction(payload));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/observe") {
      const payload = await readJson(request);
      const result = buildExternalBrowserObservations(payload);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/plan") {
      const payload = await readJson(request);
      const result = await planExternalBrowserTurn(payload);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const payload = await readJson(request);
      const result = await runChatTurn(payload.message);
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      error: "接口不存在。",
    });
  } catch (error) {
    if (error instanceof RiskBlockedError) {
      sendJson(response, 409, {
        error: error.message,
        risk: error.risk,
      });
      return;
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "本地服务异常。",
      debug: error && typeof error === "object" ? error.debug || null : null,
    });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `BrowserPilot local server port ${port} is already in use. Run "npm run stop:server" and start again.`,
    );
    process.exit(1);
    return;
  }

  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`BrowserPilot local server listening on http://127.0.0.1:${port}`);
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`BrowserPilot local server received ${signal}, shutting down.`);
  server.close(async () => {
    await session.close?.();
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 2500).unref();
}

function buildExternalBrowserObservations(payload) {
  const message = String(payload?.message || "").trim();
  const state = normalizeExternalBrowserState(payload?.state);
  const observations = buildAgentObservations({
    budgetName: payload?.budget || "normal",
    message,
    observation: payload?.observation,
    progress: payload?.progress,
    state,
    vision: buildVisionContext({ message, state }),
  });

  return {
    observations,
  };
}

async function planExternalBrowserTurn(payload) {
  const message = String(payload?.message || "").trim();
  if (!message) {
    throw new Error("任务内容不能为空。");
  }

  const settings = await loadSettings();
  if (!settings.deepSeekApiKey) {
    throw new Error("先在设置中保存 DeepSeek API Key。");
  }

  const state = normalizeExternalBrowserState(payload?.state);
  const plan = await planBrowserAction({
    apiKey: settings.deepSeekApiKey,
    model: settings.model,
    message,
    observation: payload?.observation,
    state,
    vision: buildVisionContext({ message, state }),
    progress: payload?.progress,
  });

  return {
    message: plan.reply,
    action: plan.action,
    actions: plan.actions || [plan.action],
    evaluationPreviousGoal: plan.evaluationPreviousGoal || plan.decision?.evaluationPreviousGoal || "",
    memory: plan.memory || plan.decision?.memory || "",
    nextGoal: plan.nextGoal || plan.decision?.nextGoal || "",
    done: Boolean(plan.done || plan.decision?.done),
    success: typeof plan.success === "boolean" ? plan.success : plan.decision?.success ?? null,
    decision: plan.decision || null,
    debug: plan.debug || null,
  };
}

async function runChatTurn(message) {
  if (!String(message || "").trim()) {
    throw new Error("任务内容不能为空。");
  }

  const settings = await loadSettings();
  if (!settings.deepSeekApiKey) {
    throw new Error("先在设置中保存 DeepSeek API Key。");
  }

  const state = await session.snapshot();
  const normalizedMessage = String(message).trim();
  const plan = await planBrowserAction({
    apiKey: settings.deepSeekApiKey,
    model: settings.model,
    message: normalizedMessage,
    state,
    vision: buildVisionContext({ message: normalizedMessage, state }),
  });

  const results = await executeSessionBrowserActions(session, plan.actions || [plan.action], {
    maxActions: 2,
  });
  const result = results.at(-1) || { state };

  return {
    message: plan.reply,
    actions: plan.actions || [plan.action],
    results,
    result,
    state: result.state || state,
  };
}

async function loadSettings() {
  try {
    const content = await readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(content));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return normalizeSettings({});
    }

    throw error;
  }
}

async function saveSettings(payload) {
  const current = await loadSettings();
  const next = normalizeSettings({
    ...current,
    model: payload.model || current.model,
    deepSeekApiKey: payload.clearKey
      ? ""
      : String(payload.apiKey || current.deepSeekApiKey || "").trim(),
  });

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function normalizeSettings(value) {
  const allowedModels = new Set([
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
  ]);

  return {
    deepSeekApiKey: String(value.deepSeekApiKey || "").trim(),
    model: allowedModels.has(value.model) ? value.model : "deepseek-v4-pro",
  };
}

function publicSettings(settings) {
  return {
    hasDeepSeekKey: Boolean(settings.deepSeekApiKey),
    model: settings.model,
  };
}

function normalizeExternalBrowserState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("缺少浏览器状态。");
  }

  const targets = Array.isArray(state.targets) ? state.targets : [];
  const content = Array.isArray(state.content) ? state.content : [];
  const blocks = Array.isArray(state.blocks) ? state.blocks : content;
  const regions = Array.isArray(state.regions) ? state.regions : [];
  const inputs = Array.isArray(state.inputs) ? state.inputs : [];
  const relations = Array.isArray(state.relations) ? state.relations : [];
  const visuals = Array.isArray(state.visuals) ? state.visuals : [];
  return {
    schemaVersion: String(state.schemaVersion || "page-json-v0"),
    title: String(state.title || ""),
    url: String(state.url || ""),
    viewport: state.viewport || { width: 0, height: 0 },
    state: normalizePageState(state.state),
    regions: regions.slice(0, 32).map((region) => ({
      id: String(region.id || ""),
      role: String(region.role || "section"),
      label: String(region.label || "").slice(0, 180),
      text: String(region.text || "").slice(0, 360),
      box: region.box || null,
      targetIds: normalizeIdList(region.targetIds, 40),
      blockIds: normalizeIdList(region.blockIds, 40),
      inputIds: normalizeIdList(region.inputIds, 24),
      visualIds: normalizeIdList(region.visualIds, 24),
    })),
    blocks: blocks.slice(0, 45).map((item) => ({
      id: String(item.id || ""),
      kind: String(item.kind || item.role || "content"),
      role: String(item.role || "content"),
      text: String(item.text || "").slice(0, 700),
      targetIds: normalizeIdList(item.targetIds, 10),
      regionId: String(item.regionId || ""),
      box: item.box || null,
    })),
    targets: targets.map((target) => ({
      id: String(target.id || ""),
      selector: String(target.selector || "").slice(0, 500),
      label: String(target.label || ""),
      tag: String(target.tag || ""),
      type: String(target.type || target.tag || ""),
      text: String(target.text || "").slice(0, 240),
      ariaLabel: String(target.ariaLabel || "").slice(0, 180),
      title: String(target.title || "").slice(0, 180),
      alt: String(target.alt || "").slice(0, 180),
      placeholder: String(target.placeholder || "").slice(0, 180),
      href: String(target.href || "").slice(0, 300),
      value: String(target.value || "").slice(0, 180),
      context: String(target.context || "").slice(0, 320),
      visibility: String(target.visibility || "visible"),
      interaction: normalizeInteraction(target.interaction),
      semantics: normalizeSemantics(target.semantics),
      regionId: String(target.regionId || ""),
      blockId: String(target.blockId || ""),
      box: target.box || null,
      risk: target.risk || null,
    })),
    content: content.slice(0, 35).map((item) => ({
      id: String(item.id || ""),
      kind: String(item.kind || item.role || "content"),
      role: String(item.role || "content"),
      text: String(item.text || "").slice(0, 560),
      targetIds: normalizeIdList(item.targetIds, 8),
      regionId: String(item.regionId || ""),
      box: item.box || null,
    })),
    inputs: inputs.slice(0, 40).map((item) => ({
      id: String(item.id || ""),
      targetId: String(item.targetId || ""),
      name: String(item.name || "").slice(0, 160),
      inputType: String(item.inputType || "").slice(0, 80),
      placeholder: String(item.placeholder || "").slice(0, 180),
      value: String(item.value || "").slice(0, 180),
      context: String(item.context || "").slice(0, 260),
      active: Boolean(item.active),
      multiline: Boolean(item.multiline),
      box: item.box || null,
      regionId: String(item.regionId || ""),
      blockId: String(item.blockId || ""),
    })),
    relations: relations.slice(0, 220).map((item) => ({
      type: String(item.type || ""),
      from: String(item.from || ""),
      to: String(item.to || ""),
      confidence: Number.isFinite(Number(item.confidence))
        ? Number(item.confidence)
        : 0,
    })),
    visuals: visuals.slice(0, 30).map((item) => ({
      id: String(item.id || ""),
      kind: String(item.kind || "visual"),
      alt: String(item.alt || "").slice(0, 220),
      title: String(item.title || "").slice(0, 220),
      ariaLabel: String(item.ariaLabel || "").slice(0, 220),
      nearbyText: String(item.nearbyText || "").slice(0, 420),
      targetIds: normalizeIdList(item.targetIds, 8),
      regionId: String(item.regionId || ""),
      box: item.box || null,
    })),
  };
}

function normalizePageState(state) {
  if (!state || typeof state !== "object") {
    return {
      readyState: "",
      activeTargetId: "",
      hasModal: false,
      hasOverlay: false,
      scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    };
  }

  const scroll = state.scroll && typeof state.scroll === "object" ? state.scroll : {};
  return {
    readyState: String(state.readyState || ""),
    activeTargetId: String(state.activeTargetId || ""),
    hasModal: Boolean(state.hasModal),
    hasOverlay: Boolean(state.hasOverlay),
    scroll: {
      x: Number(scroll.x) || 0,
      y: Number(scroll.y) || 0,
      maxX: Number(scroll.maxX) || 0,
      maxY: Number(scroll.maxY) || 0,
    },
  };
}

function normalizeInteraction(interaction) {
  if (!interaction || typeof interaction !== "object") {
    return {
      clickable: false,
      editable: false,
      selectable: false,
      scrollable: false,
    };
  }

  return {
    clickable: Boolean(interaction.clickable),
    editable: Boolean(interaction.editable),
    selectable: Boolean(interaction.selectable),
    scrollable: Boolean(interaction.scrollable),
  };
}

function normalizeSemantics(semantics) {
  if (!semantics || typeof semantics !== "object") {
    return {
      kind: "",
      role: "",
      intentHints: [],
      confidence: 0,
    };
  }

  return {
    kind: String(semantics.kind || "").slice(0, 80),
    role: String(semantics.role || "").slice(0, 80),
    intentHints: normalizeIdList(semantics.intentHints, 10),
    confidence: Number.isFinite(Number(semantics.confidence))
      ? Number(semantics.confidence)
      : 0,
  };
}

function normalizeIdList(value, limit) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "")).filter(Boolean).slice(0, limit)
    : [];
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function send(response, status, body = "", contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": contentType,
  });
  response.end(body);
}
