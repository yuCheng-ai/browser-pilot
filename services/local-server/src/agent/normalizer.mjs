import { cleanText } from "./text.mjs";

export function normalizeBoxForPrompt(box) {
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

export function normalizeTargetIds(value) {
  return Array.isArray(value)
    ? value.map((targetId) => cleanText(targetId, 40)).filter(Boolean).slice(0, 6)
    : [];
}

export function normalizeInteraction(interaction) {
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

export function normalizeSemantics(semantics) {
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

export function normalizePageState(state) {
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

export function normalizeRegions(regions, budget) {
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

export function normalizeBlocks(blocks, budget) {
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

export function normalizeInputs(inputs, budget, activeTargetId = "") {
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

export function normalizeTargets(targets, budget, activeTargetId = "") {
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

export function normalizeRelations(relations, budget) {
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

export function normalizeVisualMeta(visuals, budget) {
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

export function normalizePatchInputs(inputs) {
  return Array.isArray(inputs)
    ? inputs.map(normalizePatchInput).filter(Boolean).slice(0, 8)
    : [];
}

export function normalizePatchInput(input) {
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

export function normalizePatchTargets(targets) {
  return Array.isArray(targets)
    ? targets.map(normalizePatchTarget).filter(Boolean).slice(0, 12)
    : [];
}

export function normalizePatchTarget(target) {
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

export function normalizePatchRegions(regions) {
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