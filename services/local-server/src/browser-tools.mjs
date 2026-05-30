import {
  normalizeBrowserAction,
  normalizeToolResult,
  ToolRegistry,
} from "../../../packages/agent-runtime/src/index.mjs";
import { executeWebViewCdpAction } from "../../../integrations/playwright/src/webview-cdp.mjs";

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
