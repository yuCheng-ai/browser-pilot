// Shared planner configuration. Keep model/prompt/budget changes here, not in the runtime loop.

export const fallbackModel = "deepseek-v4-pro";

export const plannerModels = new Set([
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
]);

export const plannerPrompt =
  "BrowserPilot task controller. Return JSON only. Preferred schema: " +
  "{\"reply\":\"Chinese reply\",\"evaluationPreviousGoal\":\"what happened last step\",\"memory\":\"task memory\",\"nextGoal\":\"next browser goal\",\"done\":false,\"actions\":[{type}]}. " +
  "Legacy {\"reply\":\"Chinese reply\",\"action\":{type}} is also accepted, but actions[] is preferred. " +
  "Actions: none, navigate{url}, click{targetId}, type{targetId,text,submit}, scroll{direction,targetId?,amount?}. " +
  "You receive taskState and layered observations from BrowserPilot tools, not raw DOM. Execute one planning step with at most two actions. " +
  "This is a browser-general agent; do not assume any site-specific schema. " +
  "Observation layers: fullSnapshot for page slices, actionableDiff for changes after the last action, focusedTargetContext for task-relevant candidates, visionOnDemand for optional visual hints. " +
  "Available affordances are listed in observations.layers, observations.focused, observations.views, observations.blocks, observations.targets, observations.inputs, and observations.diff. " +
  "focusedTargetContext is the task-relevant retrieval shortlist; prefer its recommendedActions and candidates over broad page lists when they fit the goal. " +
  "If the next natural operation is focus then type into the same known editable target, return both click and type actions in order. " +
  "If taskState.recentFailures is non-empty, recover by choosing a different visible target, scrolling, or stopping with a clear reason when recovery is unsafe. " +
  "Decide from the user's original request, taskState, history, and observations whether to continue or stop. " +
  "Set done true only when the user's requested browser task is complete, impossible, unsafe, or requires user confirmation. " +
  "Return action none only when done is true or no browser action can safely advance the task. " +
  "If your reply says the task still needs a next browser step, action must not be none. " +
  "When observations.diff.candidateActions is non-empty, treat it as the generic recommended next-action shortlist. " +
  "If a required control/input is not visible but more page content can be revealed, use scroll instead of none. " +
  "Never invent target ids; use only ids from observations.targets, observations.inputs.targetId, or observations.blocks.targetIds.";

export const repairPrompt =
  "BrowserPilot action repair. Return JSON only. Preferred schema: " +
  "{\"reply\":\"Chinese reply\",\"evaluationPreviousGoal\":\"why previous output was insufficient\",\"memory\":\"task memory\",\"nextGoal\":\"next browser goal\",\"done\":false,\"actions\":[{type}]}. " +
  "The previous planner reply says the browser task should continue but it returned no executable action. " +
  "Choose one or two generic browser actions from the provided candidates and visible inputs/targets. " +
  "Actions: none, navigate{url}, click{targetId}, type{targetId,text,submit}, scroll{direction,targetId?,amount?}. " +
  "Do not invent target ids. Return none only if no candidate can safely advance the task.";

export const maxActionsPerStep = 2;

export const intentPrompt =
  "BrowserPilot intent router. Return JSON only. " +
  "Decide whether the first browser action can be planned from the user's request without reading the current page. " +
  "If the request explicitly asks to go/open/visit a website, app, service, domain, URL, homepage, or search engine result, return navigate with an absolute https URL when you know it. " +
  "For multi-step tasks, return only the first browser action. " +
  "If current page content is needed before deciding, return {\"reply\":\"Chinese reply\",\"action\":{\"type\":\"needs_page\"}}. " +
  "If the task is already complete or not a browser task, return none. " +
  "Do not use site-specific schemas; this is only generic task routing.";

export const intentBudget = {
  name: "intent",
  maxTokens: 180,
  timeoutMs: 6000,
};

export const budgets = [
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
    timeoutMs: 15000,
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
    timeoutMs: 12000,
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
    timeoutMs: 10000,
    visualLimit: 0,
    visualTextLimit: 0,
    jsonMode: false,
  },
];

export const repairBudget = {
  name: "repair",
  maxTokens: 340,
  timeoutMs: 9000,
  jsonMode: true,
};
