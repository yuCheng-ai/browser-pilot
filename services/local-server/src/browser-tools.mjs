import {
  createToolResult,
  normalizeBrowserAction,
  normalizeToolResult,
  ToolRegistry,
} from "../../../packages/agent-runtime/src/index.mjs";
import { executeWebViewCdpAction } from "../../../integrations/playwright/src/webview-cdp.mjs";

export async function executeSessionBrowserAction(session, action) {
  return createSessionBrowserTools(session).execute(action);
}

export async function executeSessionBrowserActions(session, actions, options = {}) {
  return createSessionBrowserTools(session).executeMany(actions, {}, options);
}

export function createSessionBrowserTools(session) {
  return new ToolRegistry([
    {
      name: "navigate",
      description: "Open a URL in the controlled browser.",
      terminatesSequence: true,
      timeoutMs: 35000,
      execute: async (action) => {
        const state = await session.navigate(action.url);
        return createToolResult({
          action: "navigate",
          reply: `已打开 ${action.url}。`,
          state,
          url: state?.url || action.url,
        });
      },
    },
    {
      name: "click",
      description: "Click a visible target by targetId.",
      timeoutMs: 15000,
      execute: async (action) => {
        const result = await session.clickTarget(action.targetId);
        return createToolResult({
          action: "click",
          reply: `已点击 ${targetName(result.target, action.targetId)}。`,
          state: result.state,
          url: result.state?.url || "",
          point: result.point,
          target: result.target,
        });
      },
    },
    {
      name: "type",
      description: "Focus a target, type text, and optionally submit.",
      timeoutMs: 18000,
      execute: async (action) => {
        const result = await session.typeIntoTarget(action.targetId, action.text, {
          submit: action.submit,
        });
        return createToolResult({
          action: "type",
          reply: action.submit
            ? `已输入并提交：${action.text}。`
            : `已输入：${action.text}。`,
          state: result.state,
          url: result.state?.url || "",
          target: result.target,
        });
      },
    },
    {
      name: "scroll",
      description: "Scroll the page or a target area.",
      timeoutMs: 12000,
      execute: async (action) => {
        const result = await session.scrollPage({
          amount: action.amount,
          direction: action.direction,
          targetId: action.targetId,
        });
        return createToolResult({
          action: "scroll",
          reply: `已向${action.direction === "up" ? "上" : "下"}滚动。`,
          state: result.state,
          url: result.state?.url || "",
          point: result.point,
          target: result.target,
        });
      },
    },
  ]);
}

export async function executeWebViewBrowserAction(payload, options = {}) {
  const action = normalizeBrowserAction(payload?.action);
  return createWebViewBrowserTools(payload, options).execute(action);
}

export async function executeWebViewBrowserActions(payload, options = {}) {
  const actions = Array.isArray(payload?.actions)
    ? payload.actions
    : [payload?.action];
  return createWebViewBrowserTools(payload, options).executeMany(actions, {}, options);
}

export function createWebViewBrowserTools(payload, options = {}) {
  return new ToolRegistry(["navigate", "click", "type", "scroll"].map((name) => ({
    name,
    description: `Execute ${name} in the controlled WebView through CDP.`,
    terminatesSequence: name === "navigate",
    timeoutMs: name === "navigate" ? 35000 : 18000,
    execute: async (action) => {
      const result = await executeWebViewCdpAction(
        {
          ...payload,
          action,
        },
        options,
      );

      return normalizeToolResult(result, {
        action,
        fallbackReply: result?.reply || "动作执行完成。",
      });
    },
  })));
}

function targetName(target, fallback) {
  return target?.label || target?.text || target?.type || fallback || "目标";
}
