const browserActionTypes = new Set([
  "none",
  "done",
  "navigate",
  "click",
  "type",
  "scroll",
]);

export function normalizeAgentDecision(raw, options = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fallbackReply = options.fallbackReply || "OK.";
  const rawActions = rawActionsFromDecision(source);
  const parsedActions = rawActions
    .map((action) => normalizeBrowserAction(action))
    .filter(Boolean);
  const primaryAction =
    parsedActions.find((action) => action.type !== "none") ||
    parsedActions[0] ||
    { type: "none" };
  const normalizedActions = [primaryAction].slice(
    0,
    Math.max(1, Number(options.maxActions) || 1),
  );
  const explicitDone =
    Boolean(source.done) ||
    Boolean(source.isDone) ||
    Boolean(source.is_done) ||
    rawActions.some((action) => action?.type === "done");

  return {
    reply: cleanText(source.reply || source.message || fallbackReply, 320),
    action: primaryAction,
    actions: normalizedActions,
    decision: {
      evaluationPreviousGoal: cleanText(
        source.evaluationPreviousGoal || source.evaluation_previous_goal,
        320,
      ),
      memory: cleanText(source.memory, 500),
      nextGoal: cleanText(source.nextGoal || source.next_goal, 320),
      done: explicitDone,
      success:
        typeof source.success === "boolean"
          ? source.success
          : typeof source.is_success === "boolean"
            ? source.is_success
            : null,
    },
  };
}

export function normalizeBrowserAction(action) {
  if (!action || typeof action !== "object") {
    return { type: "none" };
  }

  const type = cleanText(action.type, 40);
  if (!browserActionTypes.has(type)) {
    return { type: "none" };
  }

  if (type === "done") {
    return {
      type: "none",
      done: true,
      success:
        typeof action.success === "boolean"
          ? action.success
          : typeof action.is_success === "boolean"
            ? action.is_success
            : null,
    };
  }

  if (type === "navigate" && typeof action.url === "string") {
    return {
      type,
      url: action.url,
    };
  }

  if (type === "click" && typeof action.targetId === "string") {
    return {
      type,
      targetId: cleanText(action.targetId, 80),
    };
  }

  if (
    type === "type" &&
    typeof action.targetId === "string" &&
    typeof action.text === "string"
  ) {
    return {
      type,
      targetId: cleanText(action.targetId, 80),
      text: String(action.text).slice(0, 2000),
      submit: Boolean(action.submit),
    };
  }

  if (type === "scroll") {
    const targetId = cleanText(action.targetId, 80);
    return {
      type,
      direction: action.direction === "up" ? "up" : "down",
      amount: clampNumber(action.amount, 650, 80, 1800),
      ...(targetId ? { targetId } : {}),
    };
  }

  return { type: "none" };
}

export function hasExecutableAction(decision) {
  return Boolean(decision?.action && decision.action.type !== "none");
}

export function actionTerminatesSequence(action) {
  return ["navigate"].includes(action?.type);
}

export function actionSummary(action) {
  if (!action || action.type === "none") {
    return "none";
  }

  if (action.type === "navigate") {
    return `navigate ${cleanText(action.url, 160)}`;
  }

  if (action.type === "click") {
    return `click ${cleanText(action.targetId, 80)}`;
  }

  if (action.type === "type") {
    return `type ${cleanText(action.targetId, 80)}${action.submit ? " submit" : ""}`;
  }

  if (action.type === "scroll") {
    return `scroll ${action.direction || "down"} ${Number(action.amount) || 0}`;
  }

  return cleanText(action.type, 80);
}

export class ToolRegistry {
  constructor(definitions = []) {
    this.tools = new Map();
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition) {
    if (!definition?.name || typeof definition.execute !== "function") {
      throw new Error("Tool definition requires name and execute().");
    }

    this.tools.set(definition.name, {
      description: "",
      timeoutMs: 30000,
      terminatesSequence: false,
      risk: "safe",
      ...definition,
    });

    return this;
  }

  describe() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      terminatesSequence: Boolean(tool.terminatesSequence),
      risk: tool.risk || "safe",
    }));
  }

  async execute(action, context = {}) {
    const normalizedAction = normalizeBrowserAction(action);

    if (normalizedAction.type === "none") {
      return createToolResult({
        action: "none",
        reply: "没有执行浏览器动作。",
      });
    }

    const tool = this.tools.get(normalizedAction.type);
    if (!tool) {
      return createToolResult({
        ok: false,
        action: normalizedAction.type,
        reply: "动作不可用。",
        error: `Unknown browser tool: ${normalizedAction.type}`,
      });
    }

    try {
      const result = await withTimeout(
        tool.execute(normalizedAction, context),
        tool.timeoutMs,
        `Tool timed out: ${tool.name}`,
      );
      return normalizeToolResult(result, {
        action: normalizedAction,
        fallbackReply: "动作执行完成。",
      });
    } catch (error) {
      return toolErrorResult(error, {
        action: normalizedAction,
      });
    }
  }
}

export function createToolResult(input = {}) {
  return {
    ok: input.ok !== false,
    isDone: Boolean(input.isDone),
    success:
      typeof input.success === "boolean"
        ? input.success
        : input.ok === false
          ? false
          : null,
    action: cleanText(input.action, 40) || "none",
    reply: cleanText(input.reply, 1000),
    error: cleanText(input.error, 1000),
    state: input.state || null,
    url: cleanText(input.url, 500),
    point: input.point || null,
    target: input.target || null,
    metadata: input.metadata || null,
  };
}

export function normalizeToolResult(value, options = {}) {
  if (value?.ok !== undefined || value?.isDone !== undefined) {
    return createToolResult({
      ...value,
      action: value.action || options.action?.type,
      reply: value.reply || options.fallbackReply,
    });
  }

  return createToolResult({
    ok: true,
    action: options.action?.type,
    reply: options.fallbackReply,
    state: value?.state || null,
    url: value?.url,
    point: value?.point,
    target: value?.target,
  });
}

export function toolErrorResult(error, options = {}) {
  return createToolResult({
    ok: false,
    action: options.action?.type || "none",
    reply: options.reply || "动作执行失败。",
    error: error instanceof Error ? error.message : String(error || "unknown"),
  });
}

function withTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

export function cleanText(value, limit = 1000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function rawActionsFromDecision(source) {
  if (Array.isArray(source.actions)) {
    return source.actions;
  }

  if (Array.isArray(source.action)) {
    return source.action;
  }

  if (source.action && typeof source.action === "object") {
    return [source.action];
  }

  return [];
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, number));
}
