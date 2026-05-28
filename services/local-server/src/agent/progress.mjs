import { cleanText, uniqueStrings } from "./text.mjs";

export function deterministicSafetyPlan({ message, progress }) {
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

export function progressHistory(progress) {
  const history = Array.isArray(progress?.history) ? progress.history : [];
  return history.map((item) => ({
    action: cleanText(item?.action, 40),
    ok: item?.ok !== false,
    error: cleanText(item?.error, 220),
    goal: cleanText(item?.goal, 220),
    reply: cleanText(item?.reply, 160),
    target: cleanText(item?.target, 120),
    targetId: cleanText(item?.targetId, 40),
    text: cleanText(item?.text, 240),
    submitted: Boolean(item?.submitted),
    url: cleanText(item?.url, 220).toLowerCase(),
  }));
}

export function completedWriteAction(history) {
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

export function repeatedTypeSubmit(history) {
  const recentTypes = history
    .filter((item) => item.action === "type" && item.submitted && item.text)
    .slice(-2);
  if (recentTypes.length < 2) {
    return "";
  }

  const texts = recentTypes.map((item) => item.text);
  return new Set(texts).size === 1 ? texts[0] : "";
}

export function repeatedClickTarget(history) {
  const recentClicks = history.filter((item) => item.action === "click").slice(-3);
  if (recentClicks.length < 3) {
    return "";
  }

  const targets = recentClicks.map((item) => item.target).filter(Boolean);
  return targets.length === 3 && new Set(targets).size === 1 ? targets[0] : "";
}

export function inferStage({ history, message, state }) {
  const recent = history.slice(-4);
  const actions = recent.map((item) => item.action);
  const lastAction = recent.at(-1) || null;
  const url = cleanText(state?.url || lastAction?.url, 240).toLowerCase();
  const goal = cleanText(message, 300).toLowerCase();

  const hasNavigate = actions.includes("navigate");
  const hasType = actions.includes("type");
  const hasClick = actions.includes("click");
  const hasScroll = actions.includes("scroll");

  if (recent.some((item) => item.submitted)) {
    return "ready_to_submit";
  }

  if (hasType && !recent.some((item) => item.submitted)) {
    const typingGoal = /评论|回复|输入|填写|type|comment|reply|input|fill|write/i;
    if (typingGoal.test(goal)) {
      return "typing";
    }
  }

  if (hasType) {
    return "typing";
  }

  const inputGoal = /评论|回复|输入|填写|发[表布送]|type|comment|reply|input|fill|write|post|send/i;
  if (inputGoal.test(goal) && hasClick && !hasNavigate && !hasType) {
    return "finding_input";
  }

  const detailIndicators = /详情|detail|article|post|blog|阅读|read|内容|content/i;
  if (detailIndicators.test(url) || (hasClick && !hasNavigate && !hasScroll && actions.length >= 2)) {
    return "reading_detail";
  }

  const searchIndicators = /search|q=|query|keyword|关键词|搜索|查找|搜/i;
  if (searchIndicators.test(url) || recent.some((item) => item.action === "type" && !item.submitted)) {
    return "searching";
  }

  if (lastAction?.action === "click" && recent.length >= 2 && recent.slice(-2).every((item) => item.action === "click")) {
    return "selecting_content";
  }

  if (hasScroll && !hasNavigate && !hasType) {
    return "selecting_content";
  }

  if (hasNavigate && recent.length <= 2) {
    return "opening_site";
  }

  return "unknown";
}

export function buildLoopJudgeState({ message, progress, state }) {
  const rawHistory = Array.isArray(progress?.history) ? progress.history : [];
  const lastRaw = rawHistory.at(-1) || null;

  const recentActions = [];
  for (let index = Math.max(0, rawHistory.length - 8); index < rawHistory.length; index += 1) {
    const item = rawHistory[index];
    const prevItem = index > 0 ? rawHistory[index - 1] : null;
    recentActions.push({
      action: cleanText(item?.action, 40),
      target: cleanText(item?.target, 120),
      targetId: cleanText(item?.targetId, 40),
      text: cleanText(item?.text, 240),
      submitted: Boolean(item?.submitted),
      changed: Boolean(item?.changed),
      progressSignals: item?.progressSignals && typeof item.progressSignals === "object"
        ? item.progressSignals
        : null,
      beforeFingerprint: cleanText(item?.beforeFingerprint, 120) || simpleFingerprint(prevItem),
      afterFingerprint: cleanText(item?.afterFingerprint, 120) || simpleFingerprint(item),
      beforeUrl: cleanText(prevItem?.url || state?.url || "", 240).toLowerCase(),
      afterUrl: cleanText(item?.url || state?.url || "", 240).toLowerCase(),
      reply: cleanText(item?.reply, 160),
      goal: cleanText(item?.goal, 220),
    });
  }

  const changedCount = recentActions.filter((item) => item.changed).length;
  const unchangedCount = recentActions.filter((item) => !item.changed).length;
  const urlChangedCount = recentActions.filter((item) => item.beforeUrl && item.afterUrl && item.beforeUrl !== item.afterUrl).length;
  const bodyTextChangedCount = recentActions.filter(
    (item) => item.progressSignals?.bodyTextChanged,
  ).length;
  const activeTargetChangedCount = recentActions.filter(
    (item) => item.progressSignals?.activeTargetChanged,
  ).length;

  const fingerprints = recentActions.map((item) => item.afterFingerprint).filter(Boolean);
  const repeatedFingerprintCount = countRepeatedFingerprints(fingerprints);

  const actionTexts = recentActions.map((item) => `${item.action}:${item.targetId || item.target || ""}`).filter((s) => s.length > 3);
  const repeatedActionCount = countRepeatedActions(actionTexts);

  const lastChanged = findLastChangedIndex(recentActions);
  const lastAction = recentActions.at(-1) || null;

  const history = progressHistory(progress);
  const currentStage = inferStage({ history, message, state });

  const evidence = {
    hasOpenedNewPage: recentActions.some((item) => item.beforeUrl && item.afterUrl && item.beforeUrl !== item.afterUrl),
    hasEnteredDetailLikePage: recentActions.some((item) => {
      const after = item.afterUrl || "";
      return /detail|article|post|blog|详情|内容|阅读/i.test(after);
    }),
    hasFoundEditableInput: recentActions.some(
      (item) => item.action === "click" && (item.target || "").toLowerCase().includes("input") ||
        item.action === "type",
    ),
    hasTypedText: recentActions.some((item) => item.action === "type" && item.text),
    hasSubmittedText: recentActions.some((item) => item.submitted),
    hasScrolledWithNewContent: recentActions.some(
      (item) => item.action === "scroll" && item.progressSignals?.bodyTextChanged,
    ),
    hasModalOrOverlay: Boolean(state?.state?.hasModal || state?.state?.hasOverlay),
  };

  return {
    userGoal: cleanText(message, 300),
    currentUrl: cleanText(state?.url || lastRaw?.url, 240),
    currentTitle: cleanText(state?.title, 120),
    currentStage,
    recentActions,
    progressSummary: {
      changedCount,
      unchangedCount,
      urlChangedCount,
      bodyTextChangedCount,
      activeTargetChangedCount,
      repeatedFingerprintCount,
      repeatedActionCount,
      lastChanged: lastChanged >= 0 ? recentActions.length - 1 - lastChanged : recentActions.length,
      lastAction: lastAction
        ? `${lastAction.action}:${lastAction.targetId || lastAction.target || ""}`
        : "",
    },
    evidence,
  };
}

function simpleFingerprint(item) {
  if (!item) return "";
  const parts = [
    cleanText(item?.action, 20),
    cleanText(item?.targetId || item?.target, 40),
    cleanText(item?.url, 120),
  ].filter(Boolean);
  return parts.join("|");
}

function countRepeatedFingerprints(fingerprints) {
  if (fingerprints.length < 2) return 0;
  let count = 0;
  for (let index = 1; index < fingerprints.length; index += 1) {
    if (fingerprints[index] && fingerprints[index] === fingerprints[index - 1]) {
      count += 1;
    }
  }
  return count;
}

function countRepeatedActions(actionTexts) {
  if (actionTexts.length < 2) return 0;
  let count = 0;
  for (let index = 1; index < actionTexts.length; index += 1) {
    if (actionTexts[index] && actionTexts[index] === actionTexts[index - 1]) {
      count += 1;
    }
  }
  return count;
}

function findLastChangedIndex(recentActions) {
  for (let index = recentActions.length - 1; index >= 0; index -= 1) {
    if (recentActions[index].changed) return index;
  }
  return -1;
}

export function buildTaskState({ message, progress, state }) {
  const history = progressHistory(progress);
  const completedSteps = [];
  const lastAction = history.at?.(-1) || history[history.length - 1] || null;
  const submittedText = completedWriteAction(history);
  const repeatedSubmitText = repeatedTypeSubmit(history);
  const recentFailures = history.filter((item) => item.ok === false).slice(-3);
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

  const step = Number(progress?.step) || 1;

  return {
    goal: cleanText(message, 300),
    step,
    maxSteps: Number(progress?.maxSteps) || 1,
    done: false,
    doneReason: "",
    requiresModelCompletionDecision: true,
    latestSubmittedText: submittedText,
    repeatedSubmittedText: repeatedSubmitText,
    recentFailures,
    failureCount: history.filter((item) => item.ok === false).length,
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
    loopJudgement: progress?.loopJudgement || null,
    loopWarning: progress?.loopWarning || "",
    shouldChangeStrategy: Boolean(progress?.shouldChangeStrategy),
    nearCompletion: Boolean(progress?.nearCompletion),
  };
}

export function normalizeProgress(progress, budget) {
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
      ok: item?.ok !== false,
      error: cleanText(item?.error, 180),
      goal: cleanText(item?.goal, 220),
      reply: cleanText(item?.reply, 160),
      target: cleanText(item?.target, 120),
      targetId: cleanText(item?.targetId, 40),
      text: cleanText(item?.text, 180),
      submitted: Boolean(item?.submitted),
      url: cleanText(item?.url, 220),
    })),
  };
}
