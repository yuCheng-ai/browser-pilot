import { budgets } from "./config.mjs";

import { normalizeAction } from "./llm-client.mjs";

import { hasContentSelectionIntent, hasNavigationIntent, hasReadIntent, hasWriteIntent } from "./intent-lexicon.mjs";

import { progressHistory } from "./progress.mjs";

import { cleanText, uniqueStrings } from "./text.mjs";

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

function normalizeVisualMeta(visuals, budget) {
  if (!Array.isArray(visuals)) {
    return [];
  }

  return visuals.slice(0, budget.visualLimit).map((item) => ({
    id: cleanText(item?.id, 40),
    kind: cleanText(item?.kind || "visual", 40),
    alt: cleanText(item?.alt, 100),
    title: cleanText(item?.title, 100),
    nearbyText: cleanText(item?.nearbyText, budget.visualTextLimit),
    targetIds: normalizeTargetIds(item?.targetIds),
    regionId: cleanText(item?.regionId, 40),
    box: normalizeBoxForPrompt(item?.box),
  }));
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

function normalizeTargetIds(value) {
  return Array.isArray(value)
    ? value.map((targetId) => cleanText(targetId, 40)).filter(Boolean).slice(0, 6)
    : [];
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

  // ── Task ──
  const goal = cleanText(message || taskState?.goal, 300);
  if (goal) {
    lines.push(`┌─ Task`);
    lines.push(`├─ ${goal}`);
  }

  // ── Page State ──
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

  // ── History ──
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

  // ── Observations ──
  lines.push(`┌─ Observations`);
  const kind = diff ? "patch" : "full";
  const mode = observations?.mode || observations?.focused?.intent || "";

  // Page header
  const title = cleanText(page.title, 120);
  const url = cleanText(page.url, 300);
  const scroll = pageState.scroll
    ? `scroll=${pageState.scroll.y || 0}/${pageState.scroll.maxY || 0}`
    : "";
  const modal = pageState.hasModal ? "modal=yes" : "";
  const overlay = pageState.hasOverlay ? "overlay=yes" : "";
  const ready = pageState.readyState ? `ready=${pageState.readyState}` : "";
  const stateBits = [ready, scroll, modal, overlay].filter(Boolean).join(", ");
  const intentInfo = [kind, mode].filter(Boolean).join(", ");

  lines.push(`├─ Page: ${title}`);
  lines.push(`├─ URL: ${url}`);
  if (stateBits) lines.push(`├─ State: ${stateBits}`);
  if (intentInfo) lines.push(`├─ Mode: ${intentInfo}`);

  // Diff summary (if patch)
  if (diff) {
    const d = diff.summary || {};
    const diffBits = [];
    if (d.activeChanged) diffBits.push("activeChanged");
    if (d.scrollChanged) diffBits.push("scrollChanged");
    if (d.newEditableInputs) diffBits.push(`inputs+${d.newEditableInputs}`);
    if (d.actionButtons) diffBits.push(`buttons=${d.actionButtons}`);
    if (d.targetsAdded) diffBits.push(`targets+${d.targetsAdded}`);
    if (d.targetsUpdated) diffBits.push(`targets~${d.targetsUpdated}`);
    if (d.targetsDisappeared) diffBits.push(`targets-${d.targetsDisappeared}`);
    if (diffBits.length) lines.push(`├─ Changes: ${diffBits.join(", ")}`);
  }

  // ── Intent-driven layer pruning ──
  // Different intents need different data. Search/input tasks only need
  // Inputs + Interactive + Recommended; content tasks need Content blocks;
  // read tasks only need Content. Skip noise for the current intent.
  const showRegions = mode === "general" || mode === "navigation_followup";
  const showContent = mode !== "input_or_submit" && mode !== "input_after_selection";
  const showInteractive = mode !== "read_or_extract";
  const showInputs = mode !== "content_selection" && mode !== "read_or_extract";

  // Regions
  const totalRegions = (observations?.summary?.totalRegions) || regions.length;
  if (showRegions && regions.length) {
    lines.push(`├─ Regions (${regions.length}/${totalRegions} shown)`);
    regions.forEach((region) => {
      const id = cleanText(region.id, 20);
      const role = cleanText(region.role || "section", 20);
      const text = cleanText(region.text || region.label || "", 120);
      const targetIds = normalizeTargetIds(region.targetIds).slice(0, 6).join(",");
      const ref = targetIds ? ` → [${targetIds}]` : "";
      lines.push(`│  [${id}] ${role}: "${text}"${ref}`);
    });
  }

  // Content blocks
  const totalBlocks = (observations?.summary?.totalBlocks) || blocks.length;
  if (showContent && blocks.length) {
    lines.push(`├─ Content (${blocks.length}/${totalBlocks} shown)`);
    blocks.forEach((block) => {
      const id = cleanText(block.id, 20);
      const kind = cleanText(block.kind || block.role || "content", 16);
      const text = cleanText(block.text, 110);
      const targetIds = normalizeTargetIds(block.targetIds).slice(0, 6).join(",");
      const ref = targetIds ? ` → [${targetIds}]` : "";
      lines.push(`│  [${id}] ${kind}: "${text}"${ref}`);
    });
  }

  // Interactive elements (targets)
  const totalTargets = (observations?.summary?.totalTargets) || targets.length;
  if (showInteractive && targets.length) {
    lines.push(`├─ Interactive (${targets.length}/${totalTargets} shown)`);
    targets.forEach((target) => {
      const tag = targetTypeTag(target);
      const id = cleanText(target.id, 20);
      const label = cleanText(target.label || target.text || target.placeholder, 80);
      const context = cleanText(target.context, 60);
      const type = cleanText(target.type || target.tag, 20);
      const regionId = cleanShortId(target.regionId);
      const blockId = cleanShortId(target.blockId);
      const spatial = [regionId, blockId].filter(Boolean).join(",");
      const contextPart = context && context !== label ? ` — ${context}` : "";
      const spatialPart = spatial ? ` (${spatial})` : "";
      const risk = target.risk === "high" || target.risk === "medium" ? ` risk:${target.risk}` : "";
      const active = target.active ? " ← active" : "";
      lines.push(`│  ${tag} [${id}] "${label}" ${type}${spatialPart}${contextPart}${risk}${active}`);
    });
  }

  // Inputs
  const totalInputs = (observations?.summary?.totalInputs) || inputs.length;
  if (showInputs && inputs.length) {
    lines.push(`├─ Inputs (${inputs.length}/${totalInputs} shown)`);
    inputs.forEach((input) => {
      const targetId = cleanText(input.targetId, 20);
      const name = cleanText(input.name || input.placeholder || input.inputType, 60);
      const type = cleanText(input.inputType, 20);
      const context = cleanText(input.context, 60);
      const contextPart = context && context !== name ? ` — ${context}` : "";
      const active = input.active ? " ← active" : "";
      const multiline = input.multiline ? " multiline" : "";
      lines.push(`│  → [${targetId}] ${type} "${name}"${contextPart}${active}${multiline}`);
    });
  }

  // Relations + Visuals disabled — structural metadata noise,
  // not useful for action planning. Target IDs on Interactive elements
  // already encode the spatial relationships that matter.

  // Focused context
  if (focused) {
    const recommended = focused.recommendedActions || [];
    if (recommended.length) {
      const actions = recommended.slice(0, 6).map((item) => {
        const actionType = item.action || item.type || "";
        const targetId = cleanText(item.targetId, 20);
        if (actionType === "scroll") {
          return `scroll ${item.direction || "down"} ${item.amount || ""}`;
        }
        return `${actionType}${targetId ? ` [${targetId}]` : ""}`;
      }).join(", ");
      lines.push(`├─ Recommended: ${actions}`);
    }
  }

  // If diff has candidate actions, show them
  if (diff?.candidateActions?.length) {
    const candidates = diff.candidateActions.slice(0, 4).map((item) => {
      const actionType = item.action || item.type || "";
      const targetId = cleanText(item.targetId, 20);
      return `${actionType}${targetId ? ` [${targetId}]` : ""}`;
    }).join(", ");
    if (candidates) lines.push(`├─ Diff candidates: ${candidates}`);
  }

  return lines.join("\n");
}

function targetTypeTag(target) {
  const interaction = target?.interaction || {};
  if (interaction.editable) return "[Inp]";
  if (interaction.selectable) return "[Sel]";
  const tag = (target?.tag || "").toLowerCase();
  const type = (target?.type || "").toLowerCase();
  if (tag === "a" || type === "link") return "[Lnk]";
  if (tag === "img" || tag === "svg" || type === "visual") return "[Img]";
  if (interaction.clickable) return "[Btn]";
  if (interaction.scrollable) return "[Scr]";
  return "[Btn]";
}

function cleanShortId(value) {
  const cleaned = cleanText(value, 20);
  if (!cleaned) return "";
  return cleaned.replace(/^(region|content|target|input|visual)-/, (_, prefix) => {
    const map = { region: "r", content: "c", target: "t", input: "inp", visual: "v" };
    return map[prefix] || prefix;
  });
}
