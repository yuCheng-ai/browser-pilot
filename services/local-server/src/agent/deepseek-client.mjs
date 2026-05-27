import { normalizeAgentDecision, normalizeBrowserAction as normalizeRuntimeAction } from "../../../../packages/agent-runtime/src/index.mjs";

import {
  fallbackModel,
  intentBudget,
  intentPrompt,
  plannerModels,
  plannerPrompt,
  repairBudget,
  repairPrompt,
} from "./config.mjs";

import { hasBrowserActionIntent, isTerminalNoActionReply } from "./intent-lexicon.mjs";

import { normalizeProgress } from "./progress.mjs";

import { cleanText, uniqueStrings } from "./text.mjs";

export async function requestPlan({ apiKey, body, budget, model, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 12000);
  let response;
  let payload;

  try {
    response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw annotateRetryable(error);
  } finally {
    clearTimeout(timeout);
  }

  try {
    payload = await response.json();
  } catch {
    payload = {
      message: await response.text().catch(() => ""),
    };
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `DeepSeek HTTP ${response.status}`;
    const error = new Error(message);
    error.providerCode = payload?.error?.code || "";
    error.providerStatus = response.status;
    error.retryable =
      response.status >= 500 || isModelCompatibilityError(error);
    throw error;
  }

  const content = extractChoiceContent(payload);
  if (!content) {
    throw emptyContentError(payload, { budget, model });
  }

  return parsePlan(content);
}

export async function requestIntentPlan({ apiKey, body, model, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || intentBudget.timeoutMs);
  let response;
  let payload;

  try {
    response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw annotateRetryable(error);
  } finally {
    clearTimeout(timeout);
  }

  try {
    payload = await response.json();
  } catch {
    payload = {
      message: await response.text().catch(() => ""),
    };
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `DeepSeek HTTP ${response.status}`;
    const error = new Error(message);
    error.providerCode = payload?.error?.code || "";
    error.providerStatus = response.status;
    error.retryable =
      response.status >= 500 || isModelCompatibilityError(error);
    throw error;
  }

  const content = extractChoiceContent(payload);
  if (!content) {
    throw emptyContentError(payload, { budget: intentBudget, model });
  }

  return parseIntentPlan(content);
}

export function buildIntentRequestBody({ message, model, progress }) {
  return {
    model,
    thinking: {
      type: "disabled",
    },
    temperature: 0,
    max_tokens: intentBudget.maxTokens,
    response_format: {
      type: "json_object",
    },
    messages: [
      {
        role: "system",
        content: intentPrompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          request: cleanText(message, 800),
          progress: normalizeProgress(progress, {
            historyLimit: 2,
          }),
        }),
      },
    ],
  };
}

export function buildRequestBody({ budget, message, model, observations, taskState }) {
  const body = {
    model,
    thinking: {
      type: "disabled",
    },
    temperature: 0.1,
    max_tokens: budget.maxTokens,
    messages: [
      {
        role: "system",
        content: plannerPrompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          request: cleanText(message, 800),
          taskState,
          observations,
        }),
      },
    ],
  };

  if (budget.jsonMode) {
    body.response_format = {
      type: "json_object",
    };
  }

  return body;
}

export function buildRepairRequestBody({ message, model, observations, previousPlan, taskState }) {
  return {
    model,
    thinking: {
      type: "disabled",
    },
    temperature: 0.1,
    max_tokens: repairBudget.maxTokens,
    response_format: {
      type: "json_object",
    },
    messages: [
      {
        role: "system",
        content: repairPrompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          request: cleanText(message, 800),
          previousReply: cleanText(previousPlan?.reply, 320),
          previousDecision: previousPlan?.decision || null,
          taskState,
          observations: repairObservationSlice(observations),
        }),
      },
    ],
  };
}

export function repairObservationSlice(observations) {
  const diff = observations?.diff
    ? {
        summary: observations.diff.summary,
        activeElement: observations.diff.activeElement,
        editableInputs: observations.diff.editableInputs,
        actionButtons: observations.diff.actionButtons,
        candidateActions: observations.diff.candidateActions,
        targets: {
          added: observations.diff.targets?.added?.slice?.(0, 8) || [],
          updated: observations.diff.targets?.updated?.slice?.(0, 8) || [],
        },
        regions: {
          changed: observations.diff.regions?.changed?.slice?.(0, 4) || [],
        },
      }
    : null;

  return {
    kind: observations?.kind,
    mode: observations?.mode,
    query: observations?.query,
    focusedTargetId: observations?.focusedTargetId,
    focusedInput: observations?.focusedInput,
    focused: observations?.focused
      ? {
          intent: observations.focused.intent,
          query: observations.focused.query,
          candidates: {
            primary: observations.focused.candidates?.primary?.slice?.(0, 6) || [],
            inputs: observations.focused.candidates?.inputs?.slice?.(0, 4) || [],
            actions: observations.focused.candidates?.actions?.slice?.(0, 4) || [],
            contents: observations.focused.candidates?.contents?.slice?.(0, 4) || [],
          },
          recommendedActions: observations.focused.recommendedActions?.slice?.(0, 4) || [],
          summary: observations.focused.summary,
        }
      : null,
    page: observations?.page,
    diff,
    blocks: Array.isArray(observations?.blocks) ? observations.blocks.slice(0, 4) : [],
    inputs: Array.isArray(observations?.inputs) ? observations.inputs.slice(0, 8) : [],
    targets: Array.isArray(observations?.targets) ? observations.targets.slice(0, 12) : [],
    views: Array.isArray(observations?.views) ? observations.views : [],
    summary: observations?.summary,
  };
}

export function noActionRetryError(plan, { budget, model }) {
  const error = new Error(
    `Model returned no action despite an explicit browser operation request (model=${model}, budget=${budget?.name || "unknown"}, reply=${cleanText(plan?.reply, 160)}).`,
  );
  error.retryable = true;
  return error;
}

export function modelCandidates(model) {
  return uniqueStrings([model || fallbackModel]).filter((candidate) =>
    plannerModels.has(candidate),
  );
}

function extractChoiceContent(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const raw =
    typeof message.content === "string"
      ? message.content
      : contentPartsText(message.content);
  return cleanText(raw, 4000);
}

function contentPartsText(value) {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      return part?.text || part?.content || "";
    })
    .join("\n");
}

function extractJsonObject(content) {
  const text = String(content || "").trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return text;
}

function emptyContentError(payload, { budget, model }) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = cleanText(choice.finish_reason, 80) || "unknown";
  const messageKeys = Object.keys(message).join(",") || "none";
  const error = new Error(
    `DeepSeek returned empty content (model=${model}, budget=${budget?.name || "unknown"}, finish_reason=${finishReason}, message_keys=${messageKeys}).`,
  );
  error.retryable = true;
  return error;
}

export function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return {
      type: "none",
    };
  }

  if (action.type === "navigate" && typeof action.url === "string") {
    return {
      type: "navigate",
      url: action.url,
    };
  }

  if (action.type === "click" && typeof action.targetId === "string") {
    return {
      type: "click",
      targetId: action.targetId,
    };
  }

  if (
    action.type === "type" &&
    typeof action.targetId === "string" &&
    typeof action.text === "string"
  ) {
    return {
      type: "type",
      targetId: action.targetId,
      text: action.text.slice(0, 2000),
      submit: Boolean(action.submit),
    };
  }

  return {
    type: "none",
  };
}

function parsePlan(content) {
  let parsed;
  const json = extractJsonObject(content);

  try {
    parsed = JSON.parse(json);
  } catch {
    const error = new Error("DeepSeek returned an invalid browser action.");
    error.retryable = true;
    throw error;
  }

  return {
    reply: cleanText(parsed.reply || "OK.", 320),
    action: normalizeAction(parsed.action),
  };
}

function parseIntentPlan(content) {
  let parsed;
  const json = extractJsonObject(content);

  try {
    parsed = JSON.parse(json);
  } catch {
    const error = new Error("DeepSeek returned an invalid intent action.");
    error.retryable = true;
    throw error;
  }

  const action = parsed.action || {};
  if (action.type === "navigate" && typeof action.url === "string") {
    return {
      reply: cleanText(parsed.reply || "正在打开页面。", 320),
      action: {
        type: "navigate",
        url: action.url,
      },
    };
  }

  if (action.type === "needs_page") {
    return {
      reply: cleanText(parsed.reply || "需要读取当前页面。", 320),
      action: {
        type: "needs_page",
      },
    };
  }

  return {
    reply: cleanText(parsed.reply || "需要读取当前页面。", 320),
    action: {
      type: "none",
    },
  };
}

function annotateRetryable(error) {
  error.retryable = true;
  return error;
}

export function isRetryableDeepSeekError(error) {
  return Boolean(
    error?.retryable ||
      error?.cause?.code === "UND_ERR_SOCKET" ||
      error?.cause?.code === "ECONNRESET" ||
      error?.message?.includes("fetch failed"),
  );
}

function isModelCompatibilityError(error) {
  if (error?.providerStatus !== 400) {
    return false;
  }

  const text = `${error?.providerCode || ""} ${error?.message || ""}`;
  return /model|response_format|json|thinking/i.test(text);
}

export function errorCause(error) {
  return (
    error?.cause?.code ||
    error?.cause?.message ||
    error?.message ||
    "unknown"
  );
}

export function shouldRetryNoAction(plan, { message, progress, state }) {
  if (plan?.action?.type !== "none") return false;
  if (plan?.decision?.done || plan?.action?.done) return false;
  const maxSteps = Number(progress?.maxSteps) || 1;
  const step = Number(progress?.step) || 1;
  if (step >= maxSteps) return false;
  if (!Array.isArray(state?.targets) || !state.targets.length) return false;
  if (!hasBrowserActionIntent(message)) return false;
  return !isTerminalNoActionReply(cleanText(plan?.reply, 220));
}
