import { budgets } from "./config.mjs";

import { normalizeAction } from "./llm-client.mjs";

import { hasContentSelectionIntent, hasNavigationIntent, hasReadIntent, hasWriteIntent } from "./intent-lexicon.mjs";

import { progressHistory } from "./progress.mjs";

import { cleanText, uniqueStrings } from "./text.mjs";

import {
  normalizeBlocks,
  normalizeInputs,
  normalizePageState,
  normalizePatchInput,
  normalizePatchInputs,
  normalizePatchRegions,
  normalizePatchTargets,
  normalizeRegions,
  normalizeRelations,
  normalizeTargets,
  normalizeVisualMeta,
} from "./normalizer.mjs";

import { queryTerms, selectPromptSlice } from "./selector.mjs";

export function buildAgentObservations({
  budget,
  budgetName,
  message,
  observation,
  progress,
  state,
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
  const normalizedVision = normalizeVisualMeta(slice.visuals, resolvedBudget);
  const focusedInput = inputs.find((input) => input.active) || null;
  const diff = buildActionableDiffObservation({
    message,
    observation,
    progress,
    state,
  });
  const focused = buildFocusedRetrieval({
    blocks,
    diff,
    inputs,
    mode,
    pageState,
    targets,
  });

  return {
    source: "observePage",
    observationSchema: "layered-observation-v1",
    kind: diff ? "patch" : "full",
    mode,
    query,
    diff,
    focused,
    layers: {
      fullSnapshot: {
        available: !diff,
        page: {
          title: cleanText(state?.title, 120),
          url: cleanText(state?.url, 300),
          state: pageState,
        },
        regions,
        blocks,
        inputs,
        targets,
        relations,
      },
      actionableDiff: diff,
      focusedTargetContext: focused,
      visionOnDemand: {
        available: normalizedVision.length > 0,
        items: normalizedVision,
        summary: null,
      },
    },
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
        name: "focusedCandidates",
        count: focused.summary.totalCandidates,
        items: focused.candidates.primary,
      },
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
      selectedVisuals: normalizedVision.length,
      totalRegions: Array.isArray(state?.regions) ? state.regions.length : 0,
      totalBlocks: Array.isArray(state?.blocks) ? state.blocks.length : 0,
      totalTargets: Array.isArray(state?.targets) ? state.targets.length : 0,
      totalInputs: Array.isArray(state?.inputs) ? state.inputs.length : 0,
      totalRelations: Array.isArray(state?.relations) ? state.relations.length : 0,
      totalVisuals: Array.isArray(state?.visuals) ? state.visuals.length : 0,
    },
  };
}

export function summarizeObservations(observations) {
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
    visuals: Array.isArray(observations?.vision)
      ? observations.vision.length
      : 0,
    totalRegions: Number(observations?.summary?.totalRegions) || 0,
    totalBlocks: Number(observations?.summary?.totalBlocks) || 0,
    totalTargets: Number(observations?.summary?.totalTargets) || 0,
    totalInputs: Number(observations?.summary?.totalInputs) || 0,
    focusedIntent: cleanText(observations?.focused?.intent, 60),
    focusedCandidates: Number(observations?.focused?.summary?.totalCandidates) || 0,
    recommendedActions: Array.isArray(observations?.focused?.recommendedActions)
      ? observations.focused.recommendedActions.length
      : 0,
  };
}

function buildFocusedRetrieval({ blocks, diff, inputs, mode, pageState, targets }) {
  const changedTargetIds = new Set([
    diff?.activeElement?.currentTargetId,
    diff?.editableInputs?.active?.targetId,
    ...(diff?.editableInputs?.added || []).map((input) => input.targetId),
    ...(diff?.editableInputs?.updated || []).map((input) => input.targetId),
    ...(diff?.actionButtons || []).map((target) => target.id),
    ...(diff?.targets?.added || []).map((target) => target.id),
    ...(diff?.targets?.updated || []).map((target) => target.id),
  ].map((id) => cleanText(id, 80)).filter(Boolean));
  const inputsRanked = inputs
    .filter((input) => input.active || changedTargetIds.has(input.targetId))
    .map((input) => ({
      kind: "input",
      targetId: input.targetId,
      label: input.name || input.placeholder || input.inputType,
      context: input.context,
      active: input.active,
    }))
    .slice(0, 6);
  const actionsRanked = targets
    .filter((target) => changedTargetIds.has(target.id) || target.interaction?.clickable)
    .map((target) => ({
      kind: "target",
      targetId: target.id,
      label: target.label || target.text || target.placeholder,
      type: target.type,
      interaction: target.interaction,
      blockId: target.blockId,
    }))
    .slice(0, 8);
  const contentsRanked = blocks
    .filter((block) => block.text || block.targetIds.length)
    .map((block) => ({
      kind: "content",
      id: block.id,
      text: block.text,
      targetIds: block.targetIds,
    }))
    .slice(0, 5);
  const recommendedActions = [
    ...inputsRanked.map((input) => ({
      action: "type",
      targetId: input.targetId,
      reason: input.active ? "editable input is active" : "editable input changed after the previous action",
    })),
    ...(diff?.actionButtons || []).slice(0, 3).map((target) => ({
      action: "click",
      targetId: target.id,
      reason: "action-like control changed after the previous action",
    })),
    ...(pageState?.scroll && Number(pageState.scroll.y) < Number(pageState.scroll.maxY)
      ? [{
          action: "scroll",
          direction: "down",
          amount: 650,
          reason: "more visible content can be revealed",
        }]
      : []),
  ].slice(0, 4);
  const primary = uniqueFocused([
    ...inputsRanked,
    ...actionsRanked,
    ...contentsRanked,
  ]).slice(0, 8);

  return {
    schemaVersion: "focused-retrieval-v1",
    intent: mode,
    candidates: {
      primary,
      contents: contentsRanked,
      inputs: inputsRanked,
      actions: actionsRanked,
    },
    recommendedActions,
    summary: {
      totalCandidates: primary.length,
      contents: contentsRanked.length,
      inputs: inputsRanked.length,
      actions: actionsRanked.length,
      recommendedActions: recommendedActions.length,
    },
  };
}

function uniqueFocused(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = cleanText(
      candidate.targetId || candidate.id || candidate.text,
      120,
    );
    if (!key) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
      current: normalizePatchTargets(patch.activeElement?.current ? [patch.activeElement.current] : [])[0] || null,
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

function resolveObservationBudget({ budget, budgetName }) {
  if (budget && typeof budget === "object") {
    return budget;
  }

  return budgets.find((item) => item.name === budgetName) || budgets[0];
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

export function summarizeDecision(plan) {
  return {
    evaluationPreviousGoal: cleanText(plan?.decision?.evaluationPreviousGoal, 180),
    memory: cleanText(plan?.decision?.memory, 220),
    nextGoal: cleanText(plan?.decision?.nextGoal, 180),
    done: Boolean(plan?.decision?.done || plan?.action?.done),
    action: normalizeAction(plan?.action),
  };
}

export function toPromptText({ message, taskState, observations }) {
  const lines = [];
  const diff = observations?.diff;
  const focused = observations?.focused;
  const layers = observations?.layers;
  const full = layers?.fullSnapshot || {};
  const page = full.page || observations?.page || {};
  const pageState = page.state || {};
  const regions = observations?.regions || full.regions || [];
  const blocks = observations?.blocks || full.blocks || [];
  const targets = observations?.targets || full.targets || [];
  const inputs = observations?.inputs || full.inputs || [];
  const relations = observations?.relations || full.relations || [];

  const goal = cleanText(message || taskState?.goal, 300);
  if (goal) {
    lines.push(`┌─ Task`);
    lines.push(`├─ ${goal}`);
  }

  if (taskState && typeof taskState === "object") {
    const doneFlags = [];
    if (taskState.latestSubmittedText) doneFlags.push("submitted");
    if (taskState.nearCompletion) doneFlags.push("nearCompletion");
    if (taskState.shouldChangeStrategy) doneFlags.push("changeStrategy");
    if (taskState.loopWarning) doneFlags.push(`loopWarn: ${cleanText(taskState.loopWarning, 80)}`);
    lines.push(`┌─ Page State`);
    lines.push(`├─ step ${taskState.step || 1}/${taskState.maxSteps || 8}, failures ${taskState.failureCount || 0}`);
    const completed = Array.isArray(taskState.completedSteps) && taskState.completedSteps.length
      ? taskState.completedSteps.join(", ")
      : "";
    if (completed) lines.push(`├─ completed: ${completed}`);
    if (doneFlags.length) lines.push(`├─ flags: ${doneFlags.join(", ")}`);
  }

  const history = taskState?.history || [];
  if (Array.isArray(history) && history.length) {
    lines.push(`┌─ History`);
    history.slice(-5).forEach((item, index) => {
      const label = [
        item.action || "",
        item.targetId ? `[${cleanText(item.targetId, 24)}]` : "",
        item.target ? `"${cleanText(item.target, 80)}"` : "",
        item.text ? `"${cleanText(item.text, 80)}"` : "",
        item.submitted ? "submitted" : "",
        item.ok === false ? "FAILED" : "",
        item.changed ? "" : "nochange",
      ].filter(Boolean).join(" ");
      lines.push(`├─ ${index + 1}. ${label}`);
    });
  }

  const modeLabel = diff ? "patch" : "full";
  if (modeLabel) {
    lines.push(`┌─ Observations (${modeLabel})`);
  }

  const pageUrl = cleanText(page.url || state?.url || taskState?.url, 300);
  const pageTitle = cleanText(page.title || state?.title, 120);
  if (pageUrl) {
    lines.push(`├─ URL: ${pageUrl}`);
  }
  if (pageTitle) {
    lines.push(`├─ Title: ${pageTitle}`);
  }
  if (pageState && typeof pageState === "object") {
    const stateParts = [];
    if (pageState.readyState) stateParts.push(`ready: ${pageState.readyState}`);
    if (pageState.hasModal) stateParts.push("modal");
    if (pageState.hasOverlay) stateParts.push("overlay");
    if (pageState.scroll) {
      stateParts.push(`scroll: ${pageState.scroll.y}/${pageState.scroll.maxY}`);
    }
    if (stateParts.length) {
      lines.push(`├─ State: ${stateParts.join(", ")}`);
    }
  }

  if (diff) {
    lines.push(`├─ Changes: ${diff.summary?.activeChanged ? "active changed" : ""} ${diff.summary?.newEditableInputs ? `+${diff.summary.newEditableInputs} inputs` : ""} ${diff.summary?.actionButtons ? `${diff.summary.actionButtons} buttons` : ""}`.trim());
  }

  buildRegionsSection(lines, regions, blocks.length);
  buildContentSection(lines, blocks);
  buildInteractiveSection(lines, targets);
  buildInputsSection(lines, inputs);
  buildRelationsSection(lines, relations);
  buildRecommendedSection(lines, focused);

  return lines.join("\n");
}

function buildRegionsSection(lines, regions, blockCount) {
  if (!regions.length) return;
  lines.push(`├─ Regions (${regions.length} shown)`);
  regions.forEach((region) => {
    const targetLabel = region.targetIds?.length ? ` → ${region.targetIds.slice(0, 4).join(", ")}` : "";
    const blockLabel = region.blockIds?.length ? ` blocks: ${region.blockIds.slice(0, 4).join(", ")}` : "";
    const inputLabel = region.inputIds?.length ? ` inputs: ${region.inputIds.slice(0, 4).join(", ")}` : "";
    lines.push(`│  [${region.id}] ${region.role}: "${cleanText(region.text, 60)}"${targetLabel}${blockLabel}${inputLabel}`);
  });
}

function buildContentSection(lines, blocks) {
  if (!blocks.length) return;
  lines.push(`├─ Content (${blocks.length} shown)`);
  blocks.forEach((block) => {
    const kindLabel = block.kind && block.kind !== "content" ? ` [${block.kind}]` : "";
    const targetLabel = block.targetIds?.length ? ` → ${block.targetIds.slice(0, 4).join(", ")}` : "";
    lines.push(`│  [${block.id}]${kindLabel}: "${cleanText(block.text, 80)}"${targetLabel}`);
  });
}

function buildInteractiveSection(lines, targets) {
  if (!targets.length) return;
  lines.push(`├─ Interactive (${targets.length} shown)`);
  targets.forEach((target) => {
    const tagIcon = target.tag === "button" ? "[Btn]" : target.tag === "a" ? "[Lnk]" : target.interaction?.editable ? "[Inp]" : target.interaction?.selectable ? "[Sel]" : `[${target.tag?.toUpperCase() || "?"}]`;
    const label = target.label || target.text || target.placeholder || "";
    const typeInfo = target.type ? ` ${target.type}` : "";
    const locationInfo = [target.regionId, target.blockId].filter(Boolean).join(",");
    const locationStr = locationInfo ? ` (${locationInfo})` : "";
    const contextInfo = target.context ? ` ${target.context}` : "";
    const riskInfo = target.risk && target.risk !== "none" ? ` risk:${target.risk}` : "";
    const activeInfo = target.active ? " ← active" : "";
    lines.push(`│  ${tagIcon} [${target.id}] "${label}"${typeInfo}${locationStr}${contextInfo}${riskInfo}${activeInfo}`);
  });
}

function buildInputsSection(lines, inputs) {
  if (!inputs.length) return;
  lines.push(`├─ Inputs (${inputs.length} shown)`);
  inputs.forEach((input) => {
    const typeInfo = input.inputType ? ` ${input.inputType}` : "";
    const nameInfo = input.name ? ` "${input.name}"` : input.placeholder ? ` "${input.placeholder}"` : "";
    const contextInfo = input.context ? ` ${input.context}` : "";
    const activeInfo = input.active ? " ← active" : "";
    const multilineInfo = input.multiline ? " multiline" : "";
    lines.push(`│  → [${input.targetId}]${typeInfo}${nameInfo}${contextInfo}${activeInfo}${multilineInfo}`);
  });
}

function buildRelationsSection(lines, relations) {
  if (!relations.length) return;
  lines.push(`├─ Relations (${relations.length} shown)`);
  relations.forEach((relation) => {
    lines.push(`│  [${relation.from}] ${relation.type} [${relation.to}]`);
  });
}

function buildRecommendedSection(lines, focused) {
  if (!focused?.recommendedActions?.length) return;
  lines.push(`├─ Recommended`);
  focused.recommendedActions.forEach((rec) => {
    const details = [
      rec.targetId ? `[${rec.targetId}]` : "",
      rec.direction ? `dir:${rec.direction}` : "",
      rec.amount ? `amount:${rec.amount}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`│  ${rec.action} ${details} — ${rec.reason}`);
  });
}