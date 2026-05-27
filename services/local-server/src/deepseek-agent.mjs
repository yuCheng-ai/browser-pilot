import { budgets, intentBudget, repairBudget } from "./agent/config.mjs";

import { buildIntentRequestBody, buildRepairRequestBody, buildRequestBody, errorCause, isRetryableDeepSeekError, modelCandidates, noActionRetryError, requestIntentPlan, requestPlan, shouldRetryNoAction } from "./agent/deepseek-client.mjs";

import { shouldUseIntentRouter } from "./agent/intent-lexicon.mjs";

import { buildTaskState, deterministicSafetyPlan } from "./agent/progress.mjs";

import { buildAgentObservations, summarizeDecision, summarizeObservations } from "./agent/observations.mjs";

import { byteLength, cleanText } from "./agent/text.mjs";



export { buildAgentObservations } from "./agent/observations.mjs";



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
            const repairBody = buildRepairRequestBody({
              message,
              model: candidateModel,
              observations,
              previousPlan: plan,
              taskState,
            });
            repairAttempt.requestBytes = byteLength(JSON.stringify(repairBody));
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
                debug: {
                  model: candidateModel,
                  budget: budget.name,
                  retries: attempts.length,
                  previousError: attempts.at(-1)?.error || "",
                  observation: summarizeObservations(observations),
                  attempts: [...attempts, successAttempt, repairSuccessAttempt],
                  decision: summarizeDecision(repairedPlan),
                  repaired: true,
                },
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
          debug: {
            model: candidateModel,
            budget: budget.name,
            retries: attempts.length,
            previousError: attempts.at(-1)?.error || "",
            observation: summarizeObservations(observations),
            attempts: [...attempts, successAttempt],
            decision: summarizeDecision(plan),
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
