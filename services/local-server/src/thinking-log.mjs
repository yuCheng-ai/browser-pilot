export function createThinkingLog() {
  const steps = [];

  return {
    add(step) {
      steps.push({
        id: `${steps.length + 1}-${Date.now()}`,
        ...step,
      });
    },

    observe({ title, detail }) {
      this.add({ phase: "observe", title: title || "观察页面", detail: detail || "" });
    },

    plan({ model, budget, actions, reply }) {
      const actionDesc = Array.isArray(actions) && actions.length
        ? actions.map((a) => a.type === "none" ? "无操作" : `${a.type} ${a.targetId || a.url || ""}`).join("; ")
        : "无操作";
      this.add({
        phase: "plan",
        title: `规划下一步 (${model || "unknown"})`,
        detail: `${actionDesc}\n${reply || ""}`.trim(),
        meta: { model, budget },
      });
    },

    action({ actions, results }) {
      const resultsDesc = Array.isArray(results)
        ? results.map((r) => `${r.ok ? "完成" : "失败"}: ${r.reply || r.error || ""}`).join("\n")
        : "";
      this.add({
        phase: "action",
        title: "执行动作",
        detail: resultsDesc,
      });
    },

    error({ title, detail }) {
      this.add({
        phase: "error",
        title: title || "出错",
        detail: detail || "",
      });
    },

    retry({ model, reason }) {
      this.add({
        phase: "plan",
        title: `重试 (${model || "unknown"})`,
        detail: reason || "",
        meta: { retry: true, model },
      });
    },

    loopCheck({ status, reason }) {
      this.add({
        phase: "observe",
        title: `循环检测: ${status}`,
        detail: reason || "",
      });
    },

    intentCheck({ action, reply }) {
      this.add({
        phase: "observe",
        title: "意图分析",
        detail: `${reply || ""}\n动作: ${action?.type || "none"}`,
      });
    },

    toArray() {
      return steps;
    },

    clear() {
      steps.length = 0;
    },
  };
}