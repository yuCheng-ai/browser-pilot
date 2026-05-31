import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { normalizeAgentDecision, normalizeBrowserAction as normalizeRuntimeAction } from "../../../../packages/agent-runtime/src/index.mjs";

import {
  absoluteMaxSteps,
  absoluteMaxStepsHardLimit,
  fallbackModel,
  intentBudget,
  intentPrompt,
  loopJudgeBudget,
  loopJudgePrompt,
  maxActionsPerStep,
  plannerModels,
  plannerPrompt,
  repairBudget,
  repairPrompt,
} from "./config.mjs";

import { hasBrowserActionIntent, isTerminalNoActionReply } from "./intent-lexicon.mjs";

import { cleanText, uniqueStrings } from "./text.mjs";

function getClient(apiKey) {
  return createDeepSeek({ apiKey });
}

function splitSystemMessages(messages) {
  const systemContent = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  return {
    system: systemContent || undefined,
    messages: messages.filter((m) => m.role !== "system"),
  };
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (timer.unref) timer.unref();
  return controller.signal;
}

export async function requestPlan({ apiKey, body, budget, model, timeoutMs }) {
  try {
    const { system, messages } = splitSystemMessages(body.messages);
    const result = await generateText({
      model: getClient(apiKey)(model),
      system,
      messages,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      providerOptions: {
        deepseek: {
          thinking: body.thinking || { type: "disabled" },
        },
      },
      abortSignal: abortAfter(timeoutMs || 12000),
    });

    const content = result.text;
    if (!content) {
      throw emptyContentError(
        { choices: [{ message: { content: "" }, finish_reason: result.finishReason }] },
        { budget, model },
      );
    }

    return parsePlan(content);
  } catch (error) {
    throw annotateAgentError(error);
  }
}

export async function requestIntentPlan({ apiKey, body, model, timeoutMs }) {
  try {
    const { system, messages } = splitSystemMessages(body.messages);
    const result = await generateText({
      model: getClient(apiKey)(model),
      system,
      messages,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      providerOptions: {
        deepseek: {
          thinking: { type: "disabled" },
        },
      },
      abortSignal: abortAfter(timeoutMs || intentBudget.timeoutMs),
    });

    const content = result.text;
    if (!content) {
      throw emptyContentError(
        { choices: [{ message: { content: "" }, finish_reason: result.finishReason }] },
        { budget: intentBudget, model },
      );
    }

    return parseIntentPlan(content);
  } catch (error) {
    throw annotateAgentError(error);
  }
}

export async function requestLoopJudgement({ apiKey, loopState, model, timeoutMs }) {
  try {
    const { system, messages } = splitSystemMessages(buildLoopJudgeRequestBody({ loopState, model }).messages);
    const result = await generateText({
      model: getClient(apiKey)(model),
      system,
      messages,
      maxTokens: loopJudgeBudget.maxTokens,
      temperature: 0,
      providerOptions: {
        deepseek: {
          thinking: { type: "disabled" },
        },
      },
      abortSignal: abortAfter(timeoutMs || loopJudgeBudget.timeoutMs),
    });

    const content = result.text;
    if (!content) {
      return {
        status: "progressing",
        confidence: 0.5,
        shouldContinue: true,
        shouldChangeStrategy: false,
        reason: "LoopJudge LLM returned empty content; defaulting to progressing.",
        recommendedNextStrategy: "",
        risk: "low",
      };
    }

    return parseLoopJudgement(content);
  } catch (error) {
    throw annotateAgentError(error);
  }
}

export function buildIntentRequestBody({ message, model, progress }) {
  return {
    model,
    thinking: { type: "disabled" },
    temperature: 0,
    max_tokens: intentBudget.maxTokens,
    messages: [
      { role: "system", content: intentPrompt },
      { role: "user", content: JSON.stringify({ request: cleanText(message, 800), progress: normalizeProgress(progress, { historyLimit: 2 }) }) },
    ],
  };
}

export function buildRequestBody({ budget, message, model, observations, taskState, promptText }) {
  const userContent = promptText || JSON.stringify({ request: cleanText(message, 800), taskState, observations });

  const body = {
    model,
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: budget.maxTokens,
    messages: [
      { role: "system", content: plannerPrompt },
      { role: "user", content: userContent },
    ],
  };

  return body;
}

export function buildRepairRequestBody({ message, model, observations, previousPlan, taskState, promptText }) {
  const userContent = promptText || JSON.stringify({
    request: cleanText(message, 800),
    previousReply: cleanText(previousPlan?.reply, 320),
    previousDecision: previousPlan?.decision || null,
    taskState,
    observations: repairObservationSlice(observations),
  });

  return {
    model,
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: repairBudget.maxTokens,
    messages: [
      { role: "system", content: repairPrompt },
      { role: "user", content: userContent },
    ],
  };
}

export function buildLoopJudgeRequestBody({ loopState, model }) {
  return {
    model,
    thinking: { type: "disabled" },
    temperature: 0,
    max_tokens: loopJudgeBudget.maxTokens,
    messages: [
      { role: "system", content: loopJudgePrompt },
      { role: "user", content: JSON.stringify(loopState) },
    ],
  };
}

function normalizeProgress(progress, { historyLimit }) {
  const history = Array.isArray(progress?.history) ? progress.history.slice(-historyLimit) : [];
  return {
    step: Number(progress?.step) || 1,
    recentActions: history.map((item) => ({
      action: cleanText(item?.action, 40),
      target: cleanText(item?.target, 120),
      targetId: cleanText(item?.targetId, 40),
      text: cleanText(item?.text, 240),
      submitted: Boolean(item?.submitted),
      changed: Boolean(item?.changed),
    })),
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
  return uniqueStrings([
    model || fallbackModel,
    fallbackModel,
    "deepseek-chat",
  ]).filter((candidate) => plannerModels.has(candidate));
}

function emptyContentError(payload, { budget, model }) {
  const choice = payload?.choices?.[0] || {};
  const finishReason = cleanText(choice.finish_reason, 80) || "unknown";
  const error = new Error(
    `DeepSeek returned empty content (model=${model}, budget=${budget?.name || "unknown"}, finish_reason=${finishReason}).`,
  );
  error.retryable = true;
  return error;
}

export function normalizeAction(action) {
  return normalizeRuntimeAction(action);
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

  return normalizeAgentDecision(parsed, {
    fallbackReply: "OK.",
    maxActions: maxActionsPerStep,
  });
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

  const reply = cleanText(parsed.reply || "", 320);
  const action = parsed.action || {};

  // Blind-executable: navigate to a known URL
  if (action.type === "navigate" && typeof action.url === "string") {
    return {
      reply: reply || "正在打开页面。",
      action: { type: "navigate", url: action.url },
    };
  }

  // Blind-executable: scroll (no target needed)
  if (action.type === "scroll") {
    return {
      reply: reply || (action.direction === "up" ? "向上滚动。" : "向下滚动。"),
      action: {
        type: "scroll",
        direction: action.direction === "up" ? "up" : "down",
        amount: Number.isFinite(Number(action.amount)) ? Number(action.amount) : 650,
      },
    };
  }

  // Blind-executable: browser history / refresh
  if (action.type === "refresh" || action.type === "go_back" || action.type === "go_forward") {
    const labels = { refresh: "刷新页面。", go_back: "返回上一页。", go_forward: "前进到下一页。" };
    return {
      reply: reply || labels[action.type],
      action: { type: action.type },
    };
  }

  // Needs page observation
  if (action.type === "needs_page") {
    return {
      reply: reply || "需要读取当前页面。",
      action: { type: "needs_page" },
    };
  }

  // Fallback: no executable blind action
  return {
    reply: reply || "需要读取当前页面。",
    action: { type: "needs_page" },
  };
}

/**
 * Quick intent-only planning — no page observation required.
 * Used when the frontend has not yet observed the page (step 1 fast path).
 * Returns a blind-executable plan or a needs_page signal.
 */
export async function quickIntentPlan({ apiKey, model, message, progress, timeoutMs }) {
  const body = buildIntentRequestBody({ message, model, progress });
  const result = await requestIntentPlan({
    apiKey,
    body,
    model,
    timeoutMs: timeoutMs || intentBudget.timeoutMs,
  });

  return {
    ...result,
    // Annotate so callers know this came from the fast path
    _intent: true,
  };
}

function parseLoopJudgement(content) {
  let parsed;
  const json = extractJsonObject(content);

  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      status: "progressing",
      confidence: 0.5,
      shouldContinue: true,
      shouldChangeStrategy: false,
      reason: "LoopJudge returned invalid JSON; defaulting to progressing.",
      recommendedNextStrategy: "",
      risk: "low",
    };
  }

  const validStatuses = new Set(["progressing", "exploring", "recovering", "stuck_loop", "near_completion"]);
  const status = validStatuses.has(parsed.status) ? parsed.status : "progressing";
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Math.max(0, Math.min(1, Number(parsed.confidence)))
    : 0.5;
  const validRisks = new Set(["low", "medium", "high"]);
  const risk = validRisks.has(String(parsed.risk)) ? String(parsed.risk) : "low";

  return {
    status,
    confidence,
    shouldContinue: parsed.shouldContinue !== false,
    shouldChangeStrategy: Boolean(parsed.shouldChangeStrategy),
    reason: cleanText(parsed.reason, 320),
    recommendedNextStrategy: cleanText(parsed.recommendedNextStrategy, 320),
    risk,
  };
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

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.cause?.name === "AbortError" ||
    error?.message?.includes("abort") ||
    error?.message?.includes("AbortError") ||
    error?.cause?.message?.includes("abort")
  );
}

export function isRetryableDeepSeekError(error) {
  if (isAbortError(error)) return true;
  if (error?.retryable) return true;

  const name = (error?.name || "").toLowerCase();
  if (name.includes("apicall") || name.includes("timeout") || name.includes("retry")) return true;

  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("fetch failed") || msg.includes("timeout") || msg.includes("rate limit")) return true;
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("enetunreach")) return true;
  if (msg.includes("unable to connect") || msg.includes("network")) return true;

  const status = error?.statusCode || error?.providerStatus;
  if (status && status >= 500) return true;

  return false;
}

function annotateAgentError(error) {
  if (isAbortError(error)) {
    const wrapped = new Error("Request timed out");
    wrapped.retryable = true;
    return wrapped;
  }

  // Network-level errors (DNS, TCP reset, connection refused) are always retryable
  if (isNetworkError(error)) {
    error.retryable = true;
    return error;
  }

  const status = error?.statusCode || error?.providerStatus || 0;
  if (status >= 500) {
    error.retryable = true;
    return error;
  }

  if (status === 429) {
    error.retryable = true;
    return error;
  }

  if (status === 400 && isModelCompatibilityError(error)) {
    error.retryable = true;
    error.skipModel = true;
    return error;
  }

  error.retryable = false;
  return error;
}

function isNetworkError(error) {
  const code = (error?.cause?.code || error?.code || "").toLowerCase();
  if (code && (code.includes("econn") || code.includes("enet") || code.includes("dns") || code.includes("enotfound"))) return true;
  const msg = (error?.cause?.message || error?.message || "").toLowerCase();
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("enetunreach")) return true;
  if (msg.includes("unable to connect") || msg.includes("network error") || msg.includes("fetch failed")) return true;
  return false;
}

function isModelCompatibilityError(error) {
  if ((error?.statusCode || error?.providerStatus) !== 400) return false;
  const text = `${error?.message || ""}`;
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
  const step = Number(progress?.step) || 1;
  const absMax = Math.min(absoluteMaxSteps(), absoluteMaxStepsHardLimit);
  if (step >= absMax) return false;
  if (!Array.isArray(state?.targets) || !state.targets.length) return false;
  if (!hasBrowserActionIntent(message)) return false;
  return !isTerminalNoActionReply(cleanText(plan?.reply, 220));
}