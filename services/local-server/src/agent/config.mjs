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
  "You receive a structured text observation document, not raw DOM. Execute one planning step with at most two actions. " +
  "This is a browser-general agent; do not assume any site-specific schema. " +
  "Observation format (text document with ┌─ sections): " +
  "┌─ Task: user request. " +
  "┌─ Page State: step/maxSteps, failures, completed steps, flags. " +
  "┌─ History: recent actions with target, text, changed/nochange status. " +
  "┌─ Observations: mode (full/patch, intent mode), Page info (title, URL, ready/scroll/modal state), Changes (for patches). " +
  "├─ Regions (N/M shown): [rN] role: \"text\" → target IDs. Layout landmarks (viewport, navigation, main, etc.). " +
  "├─ Content (N/M shown): [cN] kind: \"text\" → target IDs. Semantic content blocks (card, heading, paragraph). " +
  "├─ Interactive (N/M shown): [Btn]/[Lnk]/[Inp]/[Sel] [tN] \"label\" type (region,block) context risk:level ← active. " +
  "  [Btn]=clickable button, [Lnk]=link, [Inp]=editable input, [Sel]=select. " +
  "├─ Inputs (N/M shown): → [tN] type \"name\" context ← active multiline. " +
  "├─ Relations (N/M shown): [rN] contains [cN,...]; [cN] belongs_to [tN,...]. " +
  "├─ Recommended: suggested actions from focused retrieval. " +
  "IMPORTANT: Use [tN] target IDs from Interactive/Inputs sections for click/type actions. " +
  "Content blocks show related target IDs with → [tN,...] hints. Use recommendedActions over broad lists when they fit the goal. " +
  "If the next natural operation is focus then type into the same known editable target, return both click and type actions in order. " +
  "If taskState.recentFailures is non-empty, recover by choosing a different visible target, scrolling, or stopping with a clear reason when recovery is unsafe. " +
  "Decide from the user's original request, taskState, history, and observations whether to continue or stop. " +
  "Set done true only when the user's requested browser task is complete, impossible, unsafe, or requires user confirmation. " +
  "Return action none only when done is true or no browser action can safely advance the task. " +
  "If your reply says the task still needs a next browser step, action must not be none. " +
  "When observations show candidate actions or recommended actions, treat them as the generic recommended next-action shortlist. " +
  "If a required control/input is not visible but more page content can be revealed (scroll y < maxY), use scroll instead of none. " +
  "Never invent target ids; use only ids from the Interactive section ([tN]) or Inputs section target references.";

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
    contentLimit: 5,
    contentTextLimit: 120,
    historyLimit: 5,
    maxTokens: 420,
    targetContextLimit: 30,
    targetLimit: 12,
    inputLimit: 6,
    regionLimit: 4,
    relationLimit: 4,
    timeoutMs: 15000,
    visualLimit: 2,
    visualTextLimit: 80,
    jsonMode: true,
  },
  {
    name: "compact",
    contentLimit: 4,
    contentTextLimit: 90,
    historyLimit: 3,
    maxTokens: 280,
    targetContextLimit: 24,
    targetLimit: 8,
    inputLimit: 4,
    regionLimit: 3,
    relationLimit: 2,
    timeoutMs: 12000,
    visualLimit: 1,
    visualTextLimit: 60,
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

export const softMaxSteps = 8;

export function absoluteMaxSteps() {
  return Math.max(softMaxSteps + 8, 24);
}

export const absoluteMaxStepsHardLimit = 40;

export const loopJudgeBudget = {
  name: "loop-judge",
  maxTokens: 300,
  timeoutMs: 10000,
  jsonMode: true,
};

export const loopJudgePrompt =
  "BrowserPilot loop judge. You analyze recent browser action trajectories to determine if the agent is making progress or stuck in a loop. " +
  "Return JSON only. Schema: {\"status\":\"progressing\"|\"exploring\"|\"recovering\"|\"stuck_loop\"|\"near_completion\",\"confidence\":0-1,\"shouldContinue\":boolean,\"shouldChangeStrategy\":boolean,\"reason\":\"brief Chinese reason\",\"recommendedNextStrategy\":\"Chinese suggestion\",\"risk\":\"low\"|\"medium\"|\"high\"}. " +
  "Judgment criteria: " +
  "- If the page transitions from homepage to search results, detail pages, forms, or comment boxes, that is progressing or near_completion. " +
  "- If recent actions have many changed=true, it is not stuck_loop. " +
  "- If the last 3 afterFingerprint values are identical and changed=false for all, lean toward stuck_loop. " +
  "- If actions vary but never approach the user goal, it can also be stuck_loop. " +
  "- If the last action activated an input box and the user goal involves commenting/replying/typing/filling, it is near_completion. " +
  "- If text has been typed and the next step is a public send/publish, it is near_completion with risk=medium; the agent must NOT auto-send without user confirmation. " +
  "- Do NOT judge stuck_loop just because the step count is high. " +
  "- Do NOT use site-specific logic. " +
  "- recovering: the agent has recent failures but is attempting recovery actions. " +
  "- exploring: the agent is scrolling or clicking through candidates reasonably. " +
  "Output must be valid JSON only, no extra text.";
