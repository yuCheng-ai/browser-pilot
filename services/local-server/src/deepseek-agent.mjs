import { budgets, intentBudget, repairBudget, softMaxSteps, absoluteMaxSteps, absoluteMaxStepsHardLimit } from "./agent/config.mjs";

import { buildIntentRequestBody, buildLoopJudgeRequestBody, buildRepairRequestBody, buildRequestBody, errorCause, isRetryableDeepSeekError, modelCandidates, noActionRetryError, normalizeAction, requestIntentPlan, requestLoopJudgement, requestPlan, shouldRetryNoAction } from "./agent/llm-client.mjs";

import { hasScrollIntent, shouldUseIntentRouter } from "./agent/intent-lexicon.mjs";

import { buildLoopJudgeState, buildTaskState, deterministicSafetyPlan } from "./agent/progress.mjs";

import { buildAgentObservations, summarizeDecision, summarizeObservations, toPromptText } from "./agent/observations.mjs";

import { byteLength, cleanText } from "./agent/text.mjs";
import { createThinkingLog } from "./thinking-log.mjs";



export { buildAgentObservations } from "./agent/observations.mjs";



export async function planBrowserAction({ apiKey, model, message, observation, state, progress, thinkingLog }) {
  const log = thinkingLog || createThinkingLog();
  const safety = deterministicSafetyPlan({ message, progress });
  if (safety) {
    return safety;
  }

  const step = Number(progress?.step) || 1;
  const absMax = Math.min(absoluteMaxSteps(), absoluteMaxStepsHardLimit);

  if (step >= absMax) {
    return {
      reply: `已达到绝对最大步骤限制（${absMax}步），任务停止。`,
      action: {
        type: "none",
      },
      done: true,
      decision: {
        done: true,
        success: false,
        nextGoal: "已达到绝对最大步骤限制。",
        memory: "任务步骤已达上限。",
        evaluationPreviousGoal: "任务步骤已达上限，必须停止。",
      },
    };
  }

  if (step >= softMaxSteps) {
    const loopState = buildLoopJudgeState({ message, progress, state });
    let loopJudgement;

    try {
      loopJudgement = await requestLoopJudgement({
        apiKey,
        loopState,
        model,
      });
    } catch {
      loopJudgement = {
        status: "progressing",
        confidence: 0.5,
        shouldContinue: true,
        shouldChangeStrategy: false,
        reason: "LoopJudge API call failed; defaulting to progressing.",
        recommendedNextStrategy: "",
        risk: "low",
      };
    }

    log.loopCheck({ status: loopJudgement.status, reason: loopJudgement.reason });

    if (loopJudgement.status === "stuck_loop" && loopJudgement.confidence >= 0.7) {
      return {
        reply: loopJudgement.shouldChangeStrategy
          ? `检测到无效循环：${loopJudgement.reason}。建议换策略：${loopJudgement.recommendedNextStrategy || "随机尝试不同的可选目标"}。`
          : `检测到无效循环：${loopJudgement.reason}。建议停止当前任务。`,
        action: {
          type: "none",
        },
        done: !loopJudgement.shouldChangeStrategy,
        decision: {
          done: !loopJudgement.shouldChangeStrategy,
          success: false,
          nextGoal: loopJudgement.recommendedNextStrategy || "暂停当前任务。",
          memory: `LoopJudge detected stuck loop at step ${step}: ${loopJudgement.reason}`,
          evaluationPreviousGoal: `LoopJudge returned stuck_loop (confidence=${loopJudgement.confidence}): ${loopJudgement.reason}`,
        },
      };
    }

    if (loopJudgement.status === "near_completion" && loopJudgement.risk === "high") {
      return {
        reply: `LoopJudge 判断接近完成但存在高风险：${loopJudgement.reason}。需要用户确认后才能继续。`,
        action: {
          type: "none",
        },
        done: false,
        decision: {
          done: false,
          success: null,
          nextGoal: "等待用户确认高风险操作。",
          memory: `LoopJudge near_completion with high risk: ${loopJudgement.reason}`,
          evaluationPreviousGoal: `LoopJudge returned near_completion (risk=high, confidence=${loopJudgement.confidence}): ${loopJudgement.reason}`,
        },
      };
    }

    progress = {
      ...progress,
      loopJudgement,
      loopWarning: loopJudgement.shouldChangeStrategy
        ? `LoopJudge warning: ${loopJudgement.reason}. 建议：${loopJudgement.recommendedNextStrategy || "换策略"}`
        : loopJudgement.reason,
      shouldChangeStrategy: loopJudgement.shouldChangeStrategy,
      nearCompletion: loopJudgement.status === "near_completion",
    };
  }

  const attempts = [];
  const intentPlan = await planFromIntentOnly({
    apiKey,
    attempts,
    message,
    model,
    progress,
    log,
  });

  if (intentPlan) {
    return intentPlan;
  }

  return planWithBudget({ apiKey, model, message, observation, state, progress, log });
}

async function planWithBudget({ apiKey, model, message, observation, state, progress, log }) {
  let lastError = null;
  const attempts = [];

  function buildPlanDebug({ plan, extraAttempts = [], repaired = false, repairSource = null }) {
    const debug = {
      model: candidateModel,
      budget: budget.name,
      retries: attempts.length,
      previousError: attempts.at(-1)?.error || "",
      observation: summarizeObservations(observations),
      attempts: [...attempts, ...extraAttempts],
      decision: summarizeDecision(plan),
    };
    if (repaired) debug.repaired = true;
    if (repairSource) debug.repairSource = repairSource;
    return debug;
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
      });
      const promptText = toPromptText({ message, taskState, observations });
      const body = buildRequestBody({
        budget,
        message,
        model: candidateModel,
        observations,
        taskState,
        promptText,
      });
      const attempt = {
        stage: "page",
        model: candidateModel,
        budget: budget.name,
        timeoutMs: budget.timeoutMs,
        requestBytes: byteLength(promptText),
        observation: summarizeObservations(observations),
        startedAt: new Date().toISOString(),
      };
      const started = Date.now();
      try {
        log.observe({ title: `正在规划 (${candidateModel}/${budget.name})` });
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
          const candidateRepair = repairNoActionFromCandidates({
            observations,
            plan,
            state,
          });
          if (candidateRepair) {
            return {
              ...candidateRepair,
              debug: buildPlanDebug({
                plan: candidateRepair,
                extraAttempts: [
                  successAttempt,
                  {
                    stage: "candidate-repair",
                    model: "local",
                    budget: "structured-candidates",
                    ok: true,
                    elapsedMs: 0,
                    error: "",
                  },
                ],
                repaired: true,
                repairSource: "observation-candidate",
              }),
            };
          }

          const repairAttempt = {
            stage: "repair",
            model: candidateModel,
            budget: repairBudget.name,
            timeoutMs: repairBudget.timeoutMs,
            requestBytes: 0,
            observation: summarizeObservations(observations),
            startedAt: new Date().toISOString(),
          };
          const repairStarted = Date.now();

          try {
            const repairPromptText = buildRepairPromptText({ message, observations, plan, taskState });
            const repairBody = buildRepairRequestBody({
              message,
              model: candidateModel,
              observations,
              previousPlan: plan,
              taskState,
              promptText: repairPromptText,
            });
            repairAttempt.requestBytes = byteLength(repairPromptText);
            const repairedPlan = await requestPlan({
              apiKey,
              budget: repairBudget,
              model: candidateModel,
              timeoutMs: repairBudget.timeoutMs,
              body: repairBody,
            });
            const repairSuccessAttempt = {
              ...repairAttempt,
              ok: true,
              elapsedMs: Date.now() - repairStarted,
            };

            if (!shouldRetryNoAction(repairedPlan, { message, progress, state })) {
              return {
                ...repairedPlan,
                debug: buildPlanDebug({
                  plan: repairedPlan,
                  extraAttempts: [successAttempt, repairSuccessAttempt],
                  repaired: true,
                }),
              };
            }

            attempts.push({
              ...repairSuccessAttempt,
              ok: false,
              error: cleanText(
                `repair returned no action: ${repairedPlan.reply || ""}`,
                220,
              ),
            });
          } catch (repairError) {
            attempts.push({
              ...repairAttempt,
              ok: false,
              elapsedMs: Date.now() - repairStarted,
              error: cleanText(errorCause(repairError), 220),
            });
          }

          throw noActionRetryError(plan, { budget, model: candidateModel });
        }

        return {
          ...plan,
          debug: buildPlanDebug({
            plan,
            extraAttempts: [successAttempt],
          }),
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

      if (plan.action.type === "navigate" || plan.action.type === "scroll" || plan.action.type === "refresh" || plan.action.type === "go_back" || plan.action.type === "go_forward") {
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

function repairNoActionFromCandidates({ observations, plan, state }) {
  const action = chooseRepairAction({ observations, plan, state });
  if (!action || action.type === "none") {
    return null;
  }

  const reply = cleanText(plan?.reply, 320) || "继续执行下一步。";
  return {
    reply,
    action,
    actions: [action],
    evaluationPreviousGoal: "Planner returned no executable action; selected a generic action from structured observation candidates.",
    memory: cleanText(plan?.memory || plan?.decision?.memory, 500),
    nextGoal: cleanText(plan?.nextGoal || plan?.decision?.nextGoal || reply, 320),
    done: false,
    success: null,
    decision: {
      evaluationPreviousGoal: "Planner returned no executable action; selected a generic action from structured observation candidates.",
      memory: cleanText(plan?.memory || plan?.decision?.memory, 500),
      nextGoal: cleanText(plan?.nextGoal || plan?.decision?.nextGoal || reply, 320),
      done: false,
      success: null,
    },
  };
}

function chooseRepairAction({ observations, plan, state }) {
  const candidates = [
    ...(observations?.focused?.recommendedActions || []),
    ...(observations?.diff?.candidateActions || []),
  ];
  const normalizedCandidates = candidates
    .map(candidateToAction)
    .filter((action) => action && action.type !== "none");
  const reply = `${plan?.reply || ""} ${plan?.nextGoal || ""} ${plan?.decision?.nextGoal || ""}`;

  if (hasScrollIntent(reply)) {
    const scroll = normalizedCandidates.find((action) => action.type === "scroll") ||
      scrollActionFromPageState(state);
    if (scroll) {
      return scroll;
    }
  }

  return normalizedCandidates.find((action) => action.type !== "type") || null;
}

function candidateToAction(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const type = cleanText(candidate.type || candidate.action, 40);
  if (type === "click") {
    return normalizeAction({
      type,
      targetId: candidate.targetId,
    });
  }

  if (type === "scroll") {
    return normalizeAction({
      type,
      targetId: candidate.targetId,
      direction: candidate.direction || "down",
      amount: candidate.amount || 650,
    });
  }

  if (type === "navigate") {
    return normalizeAction({
      type,
      url: candidate.url,
    });
  }

  if (type === "type" && typeof candidate.text === "string") {
    return normalizeAction({
      type,
      targetId: candidate.targetId,
      text: candidate.text,
      submit: candidate.submit,
    });
  }

  return null;
}

function scrollActionFromPageState(state) {
  const scroll = state?.state?.scroll;
  if (!scroll || Number(scroll.y) >= Number(scroll.maxY)) {
    return null;
  }

  return normalizeAction({
    type: "scroll",
    direction: "down",
    amount: 650,
  });
}

function buildRepairPromptText({ message, observations, plan, taskState }) {
  const lines = [];
  lines.push(`┌─ Repair Mode`);
  lines.push(`├─ Previous reply returned no executable action. Choose a generic action from candidates.`);
  lines.push(`├─ Previous reply: ${cleanText(plan?.reply, 200)}`);
  if (plan?.nextGoal || plan?.decision?.nextGoal) {
    lines.push(`├─ Previous nextGoal: ${cleanText(plan?.nextGoal || plan?.decision?.nextGoal, 200)}`);
  }
  lines.push("");

  const mainPrompt = toPromptText({ message, taskState, observations });
  lines.push(mainPrompt);

  return lines.join("\n");
}
