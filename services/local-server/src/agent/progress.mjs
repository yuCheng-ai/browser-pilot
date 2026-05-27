import { cleanText } from "./text.mjs";

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

export function buildTaskState({ message, progress, state }) {
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
      reply: cleanText(item?.reply, 160),
      target: cleanText(item?.target, 120),
      targetId: cleanText(item?.targetId, 40),
      text: cleanText(item?.text, 180),
      submitted: Boolean(item?.submitted),
      url: cleanText(item?.url, 220),
    })),
  };
}
