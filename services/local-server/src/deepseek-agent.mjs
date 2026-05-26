const fallbackModel = "deepseek-v4-pro";
const plannerModels = new Set([
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
]);

const plannerPrompt =
  "BrowserPilot task controller. Return JSON only: {\"reply\":\"Chinese reply\",\"action\":{type}}. " +
  "Actions: none, navigate{url}, click{targetId}, type{targetId,text,submit}. " +
  "You receive taskState and observations from BrowserPilot tools, not raw DOM. Execute exactly one step. " +
  "This is a browser-general agent; do not assume any site-specific schema. " +
  "Observations may include full page slices and task-relevant actionable diffs after the last browser action. " +
  "Available affordances are listed in observations.views, observations.blocks, observations.targets, observations.inputs, and observations.diff. " +
  "Decide from the user's original request, taskState, history, and observations whether to continue or stop. " +
  "Never invent target ids; use only ids from observations.targets, observations.inputs.targetId, or observations.blocks.targetIds.";

const intentPrompt =
  "BrowserPilot intent router. Return JSON only. " +
  "Decide whether the first browser action can be planned from the user's request without reading the current page. " +
  "If the request explicitly asks to go/open/visit a website, app, service, domain, URL, homepage, or search engine result, return navigate with an absolute https URL when you know it. " +
  "For multi-step tasks, return only the first browser action. " +
  "If current page content is needed before deciding, return {\"reply\":\"Chinese reply\",\"action\":{\"type\":\"needs_page\"}}. " +
  "If the task is already complete or not a browser task, return none. " +
  "Do not use site-specific schemas; this is only generic task routing.";

const intentBudget = {
  name: "intent",
  maxTokens: 180,
  timeoutMs: 6000,
};

const budgets = [
  {
    name: "normal",
    contentLimit: 4,
    contentTextLimit: 120,
    historyLimit: 5,
    maxTokens: 420,
    targetContextLimit: 30,
    targetLimit: 8,
    inputLimit: 6,
    regionLimit: 3,
    relationLimit: 0,
    timeoutMs: 10000,
    visualLimit: 0,
    visualTextLimit: 0,
    jsonMode: true,
  },
  {
    name: "compact",
    contentLimit: 3,
    contentTextLimit: 90,
    historyLimit: 3,
    maxTokens: 280,
    targetContextLimit: 24,
    targetLimit: 6,
    inputLimit: 4,
    regionLimit: 2,
    relationLimit: 0,
    timeoutMs: 8000,
    visualLimit: 0,
    visualTextLimit: 0,
    jsonMode: true,
  },
  {
    name: "minimal",
    contentLimit: 2,
    contentTextLimit: 90,
    historyLimit: 2,
    maxTokens: 180,
    targetContextLimit: 18,
    targetLimit: 4,
    inputLimit: 2,
    regionLimit: 1,
    relationLimit: 0,
    timeoutMs: 6000,
    visualLimit: 0,
    visualTextLimit: 0,
    jsonMode: false,
  },
];

export async function planBrowserAction({ apiKey, model, message, observation, state, vision, progress }) {
  const safety = deterministicSafetyPlan({ message, progress });
  if (safety) {
    return safety;
  }

  let lastError = null;
  const attempts = [];
  const intentPlan = await planFromIntentOnly({
    apiKey,
    attempts,
    message,
    model,
    progress,
  });

  if (intentPlan) {
    return intentPlan;
  }

  for (const candidateModel of modelCandidates(model)) {
    for (const budget of budgets) {
      const taskState = buildTaskState({ message, progress, state });
      const observations = buildAgentObservations({
        budget,
        message,
        observation,
        progress,
        state,
        vision,
      });
      const body = buildRequestBody({
        budget,
        message,
        model: candidateModel,
        observations,
        taskState,
      });
      const attempt = {
        stage: "page",
        model: candidateModel,
        budget: budget.name,
        timeoutMs: budget.timeoutMs,
        requestBytes: byteLength(JSON.stringify(body)),
        observation: summarizeObservations(observations),
        startedAt: new Date().toISOString(),
      };
      const started = Date.now();
      try {
        const plan = await requestPlan({
          apiKey,
          budget,
          model: candidateModel,
          timeoutMs: budget.timeoutMs,
          body,
        });
        const successAttempt = {
          ...attempt,
          ok: true,
          elapsedMs: Date.now() - started,
        };
        if (shouldRetryNoAction(plan, { message, progress, state })) {
          throw noActionRetryError(plan, { budget, model: candidateModel });
        }

        return {
          ...plan,
          debug: {
            model: candidateModel,
            budget: budget.name,
            retries: attempts.length,
            previousError: attempts.at(-1)?.error || "",
            observation: summarizeObservations(observations),
            attempts: [...attempts, successAttempt],
          },
        };
      } catch (error) {
        lastError = error;
        attempts.push({
          ...attempt,
          ok: false,
          elapsedMs: Date.now() - started,
          error: cleanText(errorCause(error), 220),
        });
        if (!isRetryableDeepSeekError(error)) {
          error.debug = planDebug({ attempts, lastError, state });
          throw error;
        }

        if (error?.skipModel) {
          break;
        }
      }
    }
  }

  const error = new Error(
    `DeepSeek request failed after compact retries: ${errorCause(lastError)}`,
  );
  error.debug = planDebug({ attempts, lastError, state });
  throw error;
}

function deterministicSafetyPlan({ message, progress }) {
  const history = progressHistory(progress);
  const repeatedType = repeatedTypeSubmit(history);
  if (repeatedType) {
    return {
      reply: `检测到已连续提交相同内容“${repeatedType}”，先停止，避免重复操作。`,
      action: {
        type: "none",
      },
    };
  }

  const repeatedClick = repeatedClickTarget(history);

  if (repeatedClick) {
    return {
      reply: "\u68c0\u6d4b\u5230\u8fde\u7eed\u91cd\u590d\u70b9\u51fb\u540c\u4e00\u76ee\u6807\uff0c\u5148\u505c\u4e0b\uff0c\u907f\u514d\u9677\u5165\u5faa\u73af\u3002",
      action: {
        type: "none",
      },
    };
  }

  return null;
}

async function planFromIntentOnly({ apiKey, attempts, message, model, progress }) {
  if (!shouldUseIntentRouter({ message, progress })) {
    return null;
  }

  for (const candidateModel of modelCandidates(model)) {
    const body = buildIntentRequestBody({
      message,
      model: candidateModel,
      progress,
    });
    const attempt = {
      stage: "intent",
      model: candidateModel,
      budget: intentBudget.name,
      timeoutMs: intentBudget.timeoutMs,
      requestBytes: byteLength(JSON.stringify(body)),
      startedAt: new Date().toISOString(),
    };
    const started = Date.now();

    try {
      const plan = await requestIntentPlan({
        apiKey,
        body,
        model: candidateModel,
        timeoutMs: intentBudget.timeoutMs,
      });
      const successAttempt = {
        ...attempt,
        ok: true,
        elapsedMs: Date.now() - started,
      };
      attempts.push(successAttempt);

      if (plan.action.type === "navigate") {
        return {
          ...plan,
          debug: {
            stage: "intent",
            model: candidateModel,
            budget: intentBudget.name,
            retries: attempts.length - 1,
            previousError: attempts.at(-2)?.error || "",
            attempts,
          },
        };
      }

      return null;
    } catch (error) {
      attempts.push({
        ...attempt,
        ok: false,
        elapsedMs: Date.now() - started,
        error: cleanText(errorCause(error), 220),
      });

      if (!isRetryableDeepSeekError(error)) {
        return null;
      }
    }
  }

  return null;
}

function shouldUseIntentRouter({ message, progress }) {
  const step = Number(progress?.step) || 1;
  const history = Array.isArray(progress?.history) ? progress.history : [];
  return step === 1 && history.length === 0 && hasNavigationIntent(message);
}

function hasNavigationIntent(message) {
  return /https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}|go to|open|visit|navigate|homepage|home page|website|site|打开|访问|进入|去|主页|首页|网站|网页/.test(
    String(message || "").toLowerCase(),
  );
}

function buildIntentRequestBody({ message, model, progress }) {
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

function planDebug({ attempts, lastError, state }) {
  return {
    attempts: attempts.slice(-12),
    lastError: cleanText(errorCause(lastError), 220),
    page: {
      schemaVersion: cleanText(state?.schemaVersion, 40),
      url: cleanText(state?.url, 180),
      regions: Array.isArray(state?.regions) ? state.regions.length : 0,
      blocks: Array.isArray(state?.blocks) ? state.blocks.length : 0,
      targets: Array.isArray(state?.targets) ? state.targets.length : 0,
      inputs: Array.isArray(state?.inputs) ? state.inputs.length : 0,
      relations: Array.isArray(state?.relations) ? state.relations.length : 0,
      visuals: Array.isArray(state?.visuals) ? state.visuals.length : 0,
    },
  };
}

function progressHistory(progress) {
  const history = Array.isArray(progress?.history) ? progress.history : [];
  return history.map((item) => ({
    action: cleanText(item?.action, 40),
    reply: cleanText(item?.reply, 160),
    target: cleanText(item?.target, 120),
    targetId: cleanText(item?.targetId, 40),
    text: cleanText(item?.text, 240),
    submitted: Boolean(item?.submitted),
    url: cleanText(item?.url, 220).toLowerCase(),
  }));
}

function completedWriteAction(history) {
  const write = history.findLast?.((item) => item.action === "type" && item.submitted && item.text);
  if (write) {
    return write.text;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.action === "type" && item.submitted && item.text) {
      return item.text;
    }
  }

  return "";
}

function repeatedTypeSubmit(history) {
  const recentTypes = history
    .filter((item) => item.action === "type" && item.submitted && item.text)
    .slice(-2);
  if (recentTypes.length < 2) {
    return "";
  }

  const texts = recentTypes.map((item) => item.text);
  return new Set(texts).size === 1 ? texts[0] : "";
}

function repeatedClickTarget(history) {
  const recentClicks = history.filter((item) => item.action === "click").slice(-3);
  if (recentClicks.length < 3) {
    return "";
  }

  const targets = recentClicks.map((item) => item.target).filter(Boolean);
  return targets.length === 3 && new Set(targets).size === 1 ? targets[0] : "";
}

async function requestPlan({ apiKey, body, budget, model, timeoutMs }) {
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

async function requestIntentPlan({ apiKey, body, model, timeoutMs }) {
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

function buildRequestBody({ budget, message, model, observations, taskState }) {
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

export function buildAgentObservations({
  budget,
  budgetName,
  message,
  observation,
  progress,
  state,
  vision,
}) {
  const resolvedBudget = resolveObservationBudget({ budget, budgetName });
  const mode = inferObservationMode({ message, progress });
  const query = inferObservationQuery({ message, progress });
  const slice = selectPromptSlice({
    budget: resolvedBudget,
    message,
    progress,
    state,
  });
  const pageState = normalizePageState(state?.state);
  const regions = normalizeRegions(slice.regions, resolvedBudget);
  const blocks = normalizeBlocks(slice.blocks, resolvedBudget);
  const inputs = normalizeInputs(slice.inputs, resolvedBudget, pageState.activeTargetId);
  const targets = normalizeTargets(slice.targets, resolvedBudget, pageState.activeTargetId);
  const relations = normalizeRelations(slice.relations, resolvedBudget);
  const normalizedVision = normalizeVision({ ...vision, items: slice.visuals }, resolvedBudget);
  const focusedInput = inputs.find((input) => input.active) || null;
  const diff = buildActionableDiffObservation({
    message,
    observation,
    progress,
    state,
  });

  return {
    source: "observePage",
    kind: diff ? "patch" : "full",
    mode,
    query,
    diff,
    focusedTargetId: pageState.activeTargetId,
    focusedInput: focusedInput
      ? {
          targetId: focusedInput.targetId,
          name: focusedInput.name || focusedInput.placeholder || focusedInput.inputType,
          context: focusedInput.context,
        }
      : null,
    schemaVersion: cleanText(state?.schemaVersion, 40),
    page: {
      title: cleanText(state?.title, 120),
      url: cleanText(state?.url, 300),
      state: pageState,
    },
    views: [
      {
        name: "contentCandidates",
        count: blocks.length,
        items: blocks.map((block) => ({
          id: block.id,
          text: block.text,
          targetIds: block.targetIds,
        })),
      },
      {
        name: "actionCandidates",
        count: targets.length,
        items: targets.map((target) => ({
          id: target.id,
          label: target.label || target.text || target.placeholder,
          type: target.type,
          interaction: target.interaction,
          active: target.active,
          blockId: target.blockId,
        })),
      },
      {
        name: "inputCandidates",
        count: inputs.length,
        items: inputs.map((input) => ({
          id: input.id,
          targetId: input.targetId,
          name: input.name || input.placeholder || input.inputType,
          context: input.context,
          active: input.active,
          multiline: input.multiline,
          blockId: input.blockId,
        })),
      },
    ],
    regions,
    blocks,
    inputs,
    targets,
    relations,
    vision: normalizedVision,
    summary: {
      selectedRegions: regions.length,
      selectedBlocks: blocks.length,
      selectedTargets: targets.length,
      selectedInputs: inputs.length,
      selectedRelations: relations.length,
      selectedVisuals: normalizedVision.items.length,
      totalRegions: Array.isArray(state?.regions) ? state.regions.length : 0,
      totalBlocks: Array.isArray(state?.blocks) ? state.blocks.length : 0,
      totalTargets: Array.isArray(state?.targets) ? state.targets.length : 0,
      totalInputs: Array.isArray(state?.inputs) ? state.inputs.length : 0,
      totalRelations: Array.isArray(state?.relations) ? state.relations.length : 0,
      totalVisuals: Array.isArray(state?.visuals) ? state.visuals.length : 0,
    },
  };
}

function summarizeObservations(observations) {
  return {
    source: cleanText(observations?.source, 40),
    kind: cleanText(observations?.kind, 40),
    mode: cleanText(observations?.mode, 40),
    query: cleanText(observations?.query, 120),
    focusedTargetId: cleanText(observations?.focusedTargetId, 40),
    focusedInputTargetId: cleanText(observations?.focusedInput?.targetId, 40),
    diff: observations?.diff?.summary || null,
    regions: Array.isArray(observations?.regions) ? observations.regions.length : 0,
    blocks: Array.isArray(observations?.blocks) ? observations.blocks.length : 0,
    targets: Array.isArray(observations?.targets) ? observations.targets.length : 0,
    inputs: Array.isArray(observations?.inputs) ? observations.inputs.length : 0,
    relations: Array.isArray(observations?.relations) ? observations.relations.length : 0,
    visuals: Array.isArray(observations?.vision?.items)
      ? observations.vision.items.length
      : 0,
    totalRegions: Number(observations?.summary?.totalRegions) || 0,
    totalBlocks: Number(observations?.summary?.totalBlocks) || 0,
    totalTargets: Number(observations?.summary?.totalTargets) || 0,
    totalInputs: Number(observations?.summary?.totalInputs) || 0,
  };
}

function buildActionableDiffObservation({ message, observation, progress, state }) {
  const patch = observation?.kind === "patch" ? observation.patch : null;
  if (!patch || typeof patch !== "object") {
    return null;
  }

  const activeInput = normalizePatchInput(patch.editableInputs?.active);
  const addedInputs = normalizePatchInputs(patch.editableInputs?.added);
  const updatedInputs = normalizePatchInputs(patch.editableInputs?.updated);
  const actionButtons = normalizePatchTargets(patch.actionButtons?.addedOrUpdated);
  const addedTargets = normalizePatchTargets(patch.targets?.added);
  const updatedTargets = normalizePatchTargets(patch.targets?.updated);
  const disappearedTargets = normalizePatchTargets(patch.targets?.disappeared);
  const changedRegions = normalizePatchRegions(patch.regions?.changed);
  const candidateActions = candidateActionsFromDiff({
    activeInput,
    addedInputs,
    actionButtons,
    state,
    updatedInputs,
  });

  return {
    schemaVersion: "actionable-diff-v1",
    sequence: Number(patch.sequence) || Number(observation?.sequence) || 0,
    title: cleanText(patch.title || state?.title, 120),
    url: cleanText(patch.url || state?.url, 240),
    activeElement: {
      changed: Boolean(patch.activeElement?.changed),
      previousTargetId: cleanText(patch.activeElement?.previousTargetId, 40),
      currentTargetId: cleanText(patch.activeElement?.currentTargetId, 40),
      current: normalizePatchTarget(patch.activeElement?.current),
    },
    editableInputs: {
      active: activeInput,
      added: addedInputs,
      updated: updatedInputs,
    },
    actionButtons,
    targets: {
      added: addedTargets,
      updated: updatedTargets,
      disappeared: disappearedTargets,
    },
    regions: {
      changed: changedRegions,
    },
    summary: {
      activeChanged: Boolean(patch.summary?.activeChanged || patch.activeElement?.changed),
      newEditableInputs: addedInputs.length,
      updatedEditableInputs: updatedInputs.length,
      actionButtons: actionButtons.length,
      targetsAdded: addedTargets.length,
      targetsUpdated: updatedTargets.length,
      targetsDisappeared: disappearedTargets.length,
      regionsChanged: changedRegions.length,
      candidateActions: candidateActions.length,
    },
    candidateActions,
  };
}

function candidateActionsFromDiff({
  activeInput,
  addedInputs,
  actionButtons,
  state,
  updatedInputs,
}) {
  const input = activeInput || addedInputs[0] || updatedInputs[0] || null;
  const candidates = [];

  if (input?.targetId) {
    candidates.push({
      action: "type",
      targetId: input.targetId,
      reason: "editable input is active or newly visible after the previous action",
    });
  }

  actionButtons.slice(0, 3).forEach((button) => {
    candidates.push({
      action: "click",
      targetId: button.id,
      reason: "action-like control changed after the previous action",
    });
  });

  if (!state?.state?.readyState || state.state.readyState !== "complete") {
    candidates.push({
      action: "wait",
      reason: "page readyState is not complete",
    });
  }

  return candidates.slice(0, 4);
}

function normalizePatchInputs(inputs) {
  return Array.isArray(inputs)
    ? inputs.map(normalizePatchInput).filter(Boolean).slice(0, 8)
    : [];
}

function normalizePatchInput(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  return {
    id: cleanText(input.id, 40),
    targetId: cleanText(input.targetId, 40),
    name: cleanText(input.name, 100),
    inputType: cleanText(input.inputType, 60),
    placeholder: cleanText(input.placeholder, 100),
    value: cleanText(input.value, 120),
    context: cleanText(input.context, 160),
    active: Boolean(input.active),
    multiline: Boolean(input.multiline),
    box: normalizeBoxForPrompt(input.box),
    regionId: cleanText(input.regionId, 40),
    blockId: cleanText(input.blockId, 40),
  };
}

function normalizePatchTargets(targets) {
  return Array.isArray(targets)
    ? targets.map(normalizePatchTarget).filter(Boolean).slice(0, 12)
    : [];
}

function normalizePatchTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  return {
    id: cleanText(target.id, 40),
    label: cleanText(target.label, 120),
    tag: cleanText(target.tag, 24),
    type: cleanText(target.type || target.tag, 40),
    text: cleanText(target.text, 120),
    placeholder: cleanText(target.placeholder, 80),
    context: cleanText(target.context, 120),
    interaction: normalizeInteraction(target.interaction),
    semantics: normalizeSemantics(target.semantics),
    box: normalizeBoxForPrompt(target.box),
    risk: cleanText(target.risk?.level || target.risk || "none", 40),
    regionId: cleanText(target.regionId, 40),
    blockId: cleanText(target.blockId, 40),
  };
}

function normalizePatchRegions(regions) {
  return Array.isArray(regions)
    ? regions
        .slice(0, 8)
        .map((region) => ({
          id: cleanText(region?.id, 40),
          role: cleanText(region?.role || "section", 40),
          label: cleanText(region?.label, 100),
          text: cleanText(region?.text, 180),
          box: normalizeBoxForPrompt(region?.box),
          targetIds: normalizeTargetIds(region?.targetIds),
          blockIds: normalizeTargetIds(region?.blockIds),
          inputIds: normalizeTargetIds(region?.inputIds),
        }))
    : [];
}

function resolveObservationBudget({ budget, budgetName }) {
  if (budget && typeof budget === "object") {
    return budget;
  }

  return budgets.find((item) => item.name === budgetName) || budgets[0];
}

function buildTaskState({ message, progress, state }) {
  const history = progressHistory(progress);
  const completedSteps = [];
  const lastAction = history.at?.(-1) || history[history.length - 1] || null;
  const submittedText = completedWriteAction(history);
  const repeatedSubmitText = repeatedTypeSubmit(history);
  const currentUrl = cleanText(state?.url || lastAction?.url, 240);

  if (history.some((item) => item.action === "navigate")) {
    completedSteps.push("opened_requested_page");
  }

  if (history.some((item) => item.action === "click")) {
    completedSteps.push("opened_or_selected_target");
  }

  if (submittedText) {
    completedSteps.push("submitted_text");
  }

  return {
    goal: cleanText(message, 300),
    step: Number(progress?.step) || 1,
    maxSteps: Number(progress?.maxSteps) || 1,
    done: false,
    doneReason: "",
    requiresModelCompletionDecision: true,
    latestSubmittedText: submittedText,
    repeatedSubmittedText: repeatedSubmitText,
    completedSteps,
    lastAction,
    currentPage: {
      title: cleanText(state?.title, 120),
      url: currentUrl,
      readyState: cleanText(state?.state?.readyState, 40),
      hasModal: Boolean(state?.state?.hasModal),
      hasOverlay: Boolean(state?.state?.hasOverlay),
    },
    history: normalizeProgress(progress, {
      historyLimit: 6,
    }).history,
  };
}

function inferObservationMode({ message, progress }) {
  const history = progressHistory(progress);
  const lastAction = history.at?.(-1) || history[history.length - 1] || null;
  const hasSelectedTarget = history.some((item) => item.action === "click");

  if ((lastAction?.action === "click" || hasSelectedTarget) && hasWriteIntent(message)) {
    return "input_after_selection";
  }

  if (hasContentSelectionIntent(message)) {
    return "content_selection";
  }

  if (hasWriteIntent(message)) {
    return "input_or_submit";
  }

  if (hasReadIntent(message)) {
    return "read_or_extract";
  }

  if (hasNavigationIntent(message)) {
    return "navigation_followup";
  }

  return "general";
}

function inferObservationQuery({ message, progress }) {
  const terms = queryTerms(message);
  const history = progressHistory(progress);
  const lastAction = history.at?.(-1) || history[history.length - 1] || null;
  const lastTarget = cleanText(lastAction?.target, 80);
  return uniqueStrings([...terms, lastTarget].filter(Boolean)).slice(0, 12).join(" ");
}

function hasWriteIntent(message) {
  return /comment|reply|type|input|submit|send|post|write|publish|\u8bc4\u8bba|\u56de\u590d|\u8f93\u5165|\u63d0\u4ea4|\u53d1\u9001|\u53d1\u5e03|\u7559\u8a00/i.test(
    String(message || ""),
  );
}

function hasReadIntent(message) {
  return /read|inspect|extract|summarize|copy|look|view|\u770b\u4e00\u4e0b|\u67e5\u770b|\u9605\u8bfb|\u63d0\u53d6|\u603b\u7ed3|\u590d\u5236/i.test(
    String(message || ""),
  );
}

function hasContentSelectionIntent(message) {
  return /first|top|latest|open|click|select|choose|content|article|post|item|\u7b2c\u4e00|\u7b2c\u4e00\u4e2a|\u6700\u4e0a|\u6700\u65b0|\u6253\u5f00|\u70b9\u51fb|\u70b9\u5f00|\u9009\u62e9|\u5185\u5bb9|\u5e16\u5b50|\u6587\u7ae0/i.test(
    String(message || ""),
  );
}

function selectPromptSlice({ budget, message, progress, state }) {
  const terms = queryTerms(message);
  const pageState = normalizePageState(state?.state);
  const activeTargetId = pageState.activeTargetId;
  const writing = hasWriteIntent(message);
  const blocks = selectBlocks(state?.blocks || state?.content, budget, terms);
  const blockIds = new Set(blocks.map((block) => cleanText(block?.id, 40)).filter(Boolean));
  const pinnedTargetIds = new Set();

  blocks.forEach((block) => {
    normalizeTargetIds(block?.targetIds).forEach((targetId) => pinnedTargetIds.add(targetId));
  });

  const inputs = selectInputs(state?.inputs, budget, terms, blockIds, {
    activeTargetId,
    writing,
  });
  inputs.forEach((input) => {
    const targetId = cleanText(input?.targetId, 40);
    if (targetId) {
      pinnedTargetIds.add(targetId);
    }
  });

  const targets = selectTargets(state?.targets, budget, terms, blockIds, pinnedTargetIds, {
    activeTargetId,
    writing,
  });
  const targetIds = new Set(targets.map((target) => cleanText(target?.id, 40)).filter(Boolean));
  const regions = selectRegions(state?.regions, budget, blocks, targets, inputs);
  const regionIds = new Set(regions.map((region) => cleanText(region?.id, 40)).filter(Boolean));
  const relations = selectRelations(state?.relations, budget, {
    blockIds,
    regionIds,
    targetIds,
  });
  const visuals = selectVisuals(state?.visuals, budget, terms, targetIds, regionIds);

  return {
    regions,
    blocks,
    inputs,
    targets,
    relations,
    visuals,
  };
}

function normalizePageState(state) {
  if (!state || typeof state !== "object") {
    return {
      readyState: "",
      activeTargetId: "",
      hasModal: false,
      hasOverlay: false,
      scroll: null,
    };
  }

  return {
    readyState: cleanText(state.readyState, 40),
    activeTargetId: cleanText(state.activeTargetId, 40),
    hasModal: Boolean(state.hasModal),
    hasOverlay: Boolean(state.hasOverlay),
    scroll: state.scroll
      ? {
          x: Math.round(Number(state.scroll.x) || 0),
          y: Math.round(Number(state.scroll.y) || 0),
          maxX: Math.round(Number(state.scroll.maxX) || 0),
          maxY: Math.round(Number(state.scroll.maxY) || 0),
        }
      : null,
  };
}

function selectBlocks(blocks, budget, terms) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block, index) => ({
      block,
      score: scoreTextMatch(block?.text, terms) * 100 +
        scorePosition(block?.box) +
        Math.max(0, 30 - index),
    }))
    .filter((item) => cleanText(item.block?.text, 20) || normalizeTargetIds(item.block?.targetIds).length)
    .sort((first, second) => second.score - first.score)
    .slice(0, budget.contentLimit);
}

function selectInputs(inputs, budget, terms, blockIds, options = {}) {
  if (!Array.isArray(inputs)) {
    return [];
  }

  const activeTargetId = cleanText(options.activeTargetId, 40);
  return inputs
    .map((input, index) => ({
      input,
      score:
        (input?.active || cleanText(input?.targetId, 40) === activeTargetId ? 220 : 0) +
        (options.writing ? 80 : 0) +
        scoreTextMatch(
          [input?.name, input?.placeholder, input?.inputType, input?.context]
            .filter(Boolean)
            .join(" "),
          terms,
        ) *
          120 +
        (blockIds.has(cleanText(input?.blockId, 40)) ? 60 : 0) +
        Math.max(0, 20 - index),
    }))
    .sort((first, second) => second.score - first.score)
    .slice(0, budget.inputLimit)
    .map((item) => item.input);
}

function selectTargets(targets, budget, terms, blockIds, pinnedTargetIds, options = {}) {
  if (!Array.isArray(targets)) {
    return [];
  }

  const activeTargetId = cleanText(options.activeTargetId, 40);
  return targets
    .map((target, index) => ({
      target,
      score:
        (cleanText(target?.id, 40) === activeTargetId ? 220 : 0) +
        (pinnedTargetIds.has(cleanText(target?.id, 40)) ? 120 : 0) +
        (blockIds.has(cleanText(target?.blockId, 40)) ? 80 : 0) +
        scoreTextMatch(
          [
            target?.label,
            target?.text,
            target?.placeholder,
            target?.context,
            target?.semantics?.kind,
            target?.semantics?.role,
            ...(Array.isArray(target?.semantics?.intentHints)
              ? target.semantics.intentHints
              : []),
          ]
            .filter(Boolean)
            .join(" "),
          terms,
        ) *
          150 +
        (target?.interaction?.editable ? (options.writing ? 120 : 45) : 0) +
        (target?.interaction?.clickable ? 25 : 0) +
        scorePosition(target?.box) +
        Math.max(0, 20 - index),
    }))
    .sort((first, second) => second.score - first.score)
    .slice(0, budget.targetLimit)
    .map((item) => item.target);
}

function selectRegions(regions, budget, blocks, targets, inputs) {
  if (!Array.isArray(regions)) {
    return [];
  }

  const usedIds = new Set(
    [
      ...blocks.map((block) => block?.regionId),
      ...targets.map((target) => target?.regionId),
      ...inputs.map((input) => input?.regionId),
    ]
      .map((id) => cleanText(id, 40))
      .filter(Boolean),
  );

  return regions
    .map((region, index) => ({
      region,
      score:
        (usedIds.has(cleanText(region?.id, 40)) ? 100 : 0) +
        (["main", "dialog", "alertdialog", "form", "search"].includes(cleanText(region?.role, 40).toLowerCase())
          ? 50
          : 0) +
        scorePosition(region?.box) +
        Math.max(0, 12 - index),
    }))
    .sort((first, second) => second.score - first.score)
    .slice(0, budget.regionLimit)
    .map((item) => item.region);
}

function selectRelations(relations, budget, ids) {
  if (!Array.isArray(relations)) {
    return [];
  }

  return relations
    .filter((relation) => {
      const from = cleanText(relation?.from, 40);
      const to = cleanText(relation?.to, 40);
      return (
        ids.blockIds.has(from) ||
        ids.blockIds.has(to) ||
        ids.regionIds.has(from) ||
        ids.regionIds.has(to) ||
        ids.targetIds.has(from) ||
        ids.targetIds.has(to)
      );
    })
    .slice(0, budget.relationLimit);
}

function selectVisuals(visuals, budget, terms, targetIds, regionIds) {
  if (!Array.isArray(visuals)) {
    return [];
  }

  return visuals
    .map((visual, index) => ({
      visual,
      score:
        scoreTextMatch([visual?.alt, visual?.title, visual?.nearbyText].filter(Boolean).join(" "), terms) *
          80 +
        (regionIds.has(cleanText(visual?.regionId, 40)) ? 25 : 0) +
        (normalizeTargetIds(visual?.targetIds).some((targetId) => targetIds.has(targetId)) ? 60 : 0) +
        scorePosition(visual?.box) +
        Math.max(0, 10 - index),
    }))
    .sort((first, second) => second.score - first.score)
    .slice(0, budget.visualLimit)
    .map((item) => item.visual);
}

function queryTerms(message) {
  const text = cleanText(message, 300).toLowerCase();
  const ascii = text.match(/[a-z0-9._-]{2,}/g) || [];
  const chinese = Array.from(text.matchAll(/[\u4e00-\u9fff]{1,4}/g)).map((match) => match[0]);
  return uniqueStrings([...ascii, ...chinese]).slice(0, 24);
}

function scoreTextMatch(value, terms) {
  const text = cleanText(value, 800).toLowerCase();
  if (!text || !terms.length) {
    return 0;
  }

  return terms.reduce((score, term) => (term && text.includes(term) ? score + 1 : score), 0);
}

function scorePosition(box) {
  const normalized = normalizeBoxForPrompt(box);
  if (!normalized) {
    return 0;
  }

  return Math.max(0, 80 - normalized.y / 12 - normalized.x / 40);
}

function normalizeRegions(regions, budget) {
  if (!Array.isArray(regions)) {
    return [];
  }

  return regions.slice(0, budget.regionLimit).map((region) => ({
    id: cleanText(region?.id, 40),
    role: cleanText(region?.role || "section", 40),
    label: cleanText(region?.label, 100),
    text: cleanText(region?.text, 180),
    box: normalizeBoxForPrompt(region?.box),
    targetIds: normalizeTargetIds(region?.targetIds).slice(0, 8),
    blockIds: normalizeTargetIds(region?.blockIds).slice(0, 8),
    inputIds: normalizeTargetIds(region?.inputIds).slice(0, 6),
  }));
}

function normalizeBlocks(blocks, budget) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.slice(0, budget.contentLimit).map((block) => ({
    id: cleanText(block?.id, 40),
    kind: cleanText(block?.kind || block?.role || "content", 40),
    role: cleanText(block?.role || "content", 40),
    text: cleanText(block?.text, budget.contentTextLimit),
    regionId: cleanText(block?.regionId, 40),
    targetIds: normalizeTargetIds(block?.targetIds),
    box: normalizeBoxForPrompt(block?.box),
  }));
}

function normalizeInputs(inputs, budget, activeTargetId = "") {
  if (!Array.isArray(inputs)) {
    return [];
  }

  const activeId = cleanText(activeTargetId, 40);
  return inputs.slice(0, budget.inputLimit).map((input) => ({
    id: cleanText(input?.id, 40),
    targetId: cleanText(input?.targetId, 40),
    name: cleanText(input?.name, 100),
    inputType: cleanText(input?.inputType, 60),
    placeholder: cleanText(input?.placeholder, 100),
    value: cleanText(input?.value, 120),
    context: cleanText(input?.context, 160),
    active: Boolean(input?.active) || cleanText(input?.targetId, 40) === activeId,
    multiline: Boolean(input?.multiline),
    box: normalizeBoxForPrompt(input?.box),
    regionId: cleanText(input?.regionId, 40),
    blockId: cleanText(input?.blockId, 40),
  }));
}

function normalizeRelations(relations, budget) {
  if (!budget.relationLimit || !Array.isArray(relations)) {
    return [];
  }

  return relations.slice(0, budget.relationLimit).map((relation) => ({
    type: cleanText(relation?.type, 40),
    from: cleanText(relation?.from, 40),
    to: cleanText(relation?.to, 40),
    confidence: Number.isFinite(Number(relation?.confidence))
      ? Number(relation.confidence)
      : 0,
  }));
}

function normalizeTargets(targets, budget, activeTargetId = "") {
  if (!Array.isArray(targets)) {
    return [];
  }

  const activeId = cleanText(activeTargetId, 40);
  return targets.slice(0, budget.targetLimit).map((target) => ({
    id: cleanText(target?.id, 40),
    label: cleanText(target?.label, 120),
    tag: cleanText(target?.tag, 24),
    type: cleanText(target?.type || target?.tag, 40),
    text: cleanText(target?.text, 120),
    placeholder: cleanText(target?.placeholder, 80),
    context: cleanText(target?.context, budget.targetContextLimit),
    visibility: cleanText(target?.visibility || "visible", 40),
    regionId: cleanText(target?.regionId, 40),
    blockId: cleanText(target?.blockId, 40),
    active: cleanText(target?.id, 40) === activeId,
    interaction: normalizeInteraction(target?.interaction),
    semantics: normalizeSemantics(target?.semantics),
    box: normalizeBoxForPrompt(target?.box),
    risk: target?.risk?.level || "none",
  }));
}

function normalizeInteraction(interaction) {
  if (!interaction || typeof interaction !== "object") {
    return null;
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
    return null;
  }

  return {
    kind: cleanText(semantics.kind, 40),
    role: cleanText(semantics.role, 40),
    intentHints: normalizeTargetIds(semantics.intentHints),
    confidence: Number.isFinite(Number(semantics.confidence))
      ? Number(semantics.confidence)
      : 0,
  };
}

function normalizeContent(content, budget) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.slice(0, budget.contentLimit).map((item) => ({
    id: cleanText(item?.id, 40),
    role: cleanText(item?.role || "content", 40),
    text: cleanText(item?.text, budget.contentTextLimit),
    targetIds: normalizeTargetIds(item?.targetIds),
    box: normalizeBoxForPrompt(item?.box),
  }));
}

function normalizeVision(vision, budget) {
  if (!vision || typeof vision !== "object") {
    return {
      required: false,
      supported: false,
      items: [],
    };
  }

  return {
    required: Boolean(vision.required),
    supported: Boolean(vision.supported),
    reason: cleanText(vision.reason, 100),
    items: Array.isArray(vision.items)
      ? vision.items.slice(0, budget.visualLimit).map((item) => ({
          id: cleanText(item?.id, 40),
          kind: cleanText(item?.kind || "visual", 40),
          alt: cleanText(item?.alt, 100),
          title: cleanText(item?.title, 100),
          nearbyText: cleanText(item?.nearbyText, budget.visualTextLimit),
          targetIds: normalizeTargetIds(item?.targetIds),
          regionId: cleanText(item?.regionId, 40),
          box: normalizeBoxForPrompt(item?.box),
        }))
      : [],
  };
}

function normalizeBoxForPrompt(box) {
  if (!box || typeof box !== "object") {
    return null;
  }

  const values = {
    x: Number(box.x),
    y: Number(box.y),
    width: Number(box.width),
    height: Number(box.height),
  };

  if (!Object.values(values).every(Number.isFinite)) {
    return null;
  }

  return {
    x: Math.round(values.x),
    y: Math.round(values.y),
    width: Math.round(values.width),
    height: Math.round(values.height),
  };
}

function normalizeProgress(progress, budget) {
  if (!progress || typeof progress !== "object") {
    return {
      step: 1,
      maxSteps: 1,
      history: [],
    };
  }

  const history = Array.isArray(progress.history) ? progress.history : [];
  return {
    step: Number(progress.step) || 1,
    maxSteps: Number(progress.maxSteps) || 1,
    history: history.slice(-budget.historyLimit).map((item) => ({
      action: cleanText(item?.action, 40),
      reply: cleanText(item?.reply, 160),
      target: cleanText(item?.target, 120),
      targetId: cleanText(item?.targetId, 40),
      text: cleanText(item?.text, 180),
      submitted: Boolean(item?.submitted),
      url: cleanText(item?.url, 220),
    })),
  };
}

function normalizeTargetIds(value) {
  return Array.isArray(value)
    ? value.map((targetId) => cleanText(targetId, 40)).filter(Boolean).slice(0, 6)
    : [];
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

function shouldRetryNoAction(plan, { message, progress, state }) {
  if (plan?.action?.type !== "none") {
    return false;
  }

  const maxSteps = Number(progress?.maxSteps) || 1;
  const step = Number(progress?.step) || 1;
  if (step >= maxSteps) {
    return false;
  }

  if (!Array.isArray(state?.targets) || !state.targets.length) {
    return false;
  }

  if (!hasBrowserActionIntent(message)) {
    return false;
  }

  const reply = cleanText(plan?.reply, 220).toLowerCase();
  return !/完成|已完成|done|unsafe|risk|危险|风险|无法|不能|没有|未找到|no target|not visible|not found/.test(reply);
}

function hasBrowserActionIntent(message) {
  return /click|open|select|choose|type|input|search|submit|send|post|comment|reply|navigate|点击|点开|打开|选择|输入|搜索|提交|发送|发表|发布|评论|回复|留言|访问|进入/.test(
    String(message || ""),
  );
}

function noActionRetryError(plan, { budget, model }) {
  const error = new Error(
    `Model returned no action despite an explicit browser operation request (model=${model}, budget=${budget?.name || "unknown"}, reply=${cleanText(plan?.reply, 160)}).`,
  );
  error.retryable = true;
  return error;
}

function modelCandidates(model) {
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

function normalizeAction(action) {
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

function cleanText(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function annotateRetryable(error) {
  error.retryable = true;
  return error;
}

function isRetryableDeepSeekError(error) {
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

function errorCause(error) {
  return (
    error?.cause?.code ||
    error?.cause?.message ||
    error?.message ||
    "unknown"
  );
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanText(value, 80)).filter(Boolean))];
}
