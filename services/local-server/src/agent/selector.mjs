import { cleanText, uniqueStrings } from "./text.mjs";
import { normalizeBoxForPrompt, normalizePageState, normalizeTargetIds } from "./normalizer.mjs";
import { hasWriteIntent } from "./intent-lexicon.mjs";

export function queryTerms(message) {
  const text = cleanText(message, 300).toLowerCase();
  const ascii = text.match(/[a-z0-9._-]{2,}/g) || [];
  const chinese = Array.from(text.matchAll(/[\u4e00-\u9fff]{1,4}/g)).map((match) => match[0]);
  return uniqueStrings([...ascii, ...chinese]).slice(0, 24);
}

export function scoreTextMatch(value, terms) {
  const text = cleanText(value, 800).toLowerCase();
  if (!text || !terms.length) {
    return 0;
  }

  return terms.reduce((score, term) => (term && text.includes(term) ? score + 1 : score), 0);
}

export function scorePosition(box) {
  const normalized = normalizeBoxForPrompt(box);
  if (!normalized) {
    return 0;
  }

  return Math.max(0, 80 - normalized.y / 12 - normalized.x / 40);
}

export function selectBlocks(blocks, budget, terms) {
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

export function selectInputs(inputs, budget, terms, blockIds, options = {}) {
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

export function selectTargets(targets, budget, terms, blockIds, pinnedTargetIds, options = {}) {
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

export function selectRegions(regions, budget, blocks, targets, inputs) {
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

export function selectRelations(relations, budget, ids) {
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

export function selectVisuals(visuals, budget, terms, targetIds, regionIds) {
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

export function selectPromptSlice({ budget, message, progress, state }) {
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