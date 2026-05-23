import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserPilotSession,
  RiskBlockedError,
} from "../../../integrations/playwright/src/index.mjs";
import { planBrowserAction } from "./deepseek-agent.mjs";

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
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`BrowserPilot local server listening on http://127.0.0.1:${port}`);
});

async function planExternalBrowserTurn(payload) {
  const message = String(payload?.message || "").trim();
  if (!message) {
    throw new Error("任务内容不能为空。");
  }

  const settings = await loadSettings();
  if (!settings.deepSeekApiKey) {
    throw new Error("先在设置中保存 DeepSeek API Key。");
  }

  const plan = await planBrowserAction({
    apiKey: settings.deepSeekApiKey,
    model: settings.model,
    message,
    state: normalizeExternalBrowserState(payload?.state),
  });

  return {
    message: plan.reply,
    action: plan.action,
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
  const plan = await planBrowserAction({
    apiKey: settings.deepSeekApiKey,
    model: settings.model,
    message: String(message).trim(),
    state,
  });

  if (plan.action.type === "navigate") {
    return {
      message: plan.reply,
      state: await session.navigate(plan.action.url),
    };
  }

  if (plan.action.type === "click") {
    const result = await session.clickTarget(plan.action.targetId);
    return {
      message: plan.reply,
      state: result.state,
    };
  }

  if (plan.action.type === "type") {
    const result = await session.typeIntoTarget(
      plan.action.targetId,
      plan.action.text,
      {
        submit: plan.action.submit,
      },
    );
    return {
      message: plan.reply,
      state: result.state,
    };
  }

  return {
    message: plan.reply,
    state,
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
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
  ]);

  return {
    deepSeekApiKey: String(value.deepSeekApiKey || "").trim(),
    model: allowedModels.has(value.model) ? value.model : "deepseek-v4-flash",
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
  return {
    title: String(state.title || ""),
    url: String(state.url || ""),
    viewport: state.viewport || { width: 0, height: 0 },
    targets: targets.map((target) => ({
      id: String(target.id || ""),
      label: String(target.label || ""),
      tag: String(target.tag || ""),
      type: String(target.type || target.tag || ""),
      risk: target.risk || null,
    })),
  };
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
