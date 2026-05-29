import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Info,
  LockKeyhole,
  LoaderCircle,
  MoreVertical,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type SettingsState = {
  hasDeepSeekKey: boolean;
  model: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  thinking?: AgentTraceItem[];
  _pending?: boolean;
  _startedAt?: number;
};

type BrowserWebviewError = {
  label: string;
  message: string;
};

type NativeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserAgentAction = {
  type: "navigate" | "click" | "type" | "scroll" | "none";
  targetId?: string;
  url?: string;
  text?: string;
  submit?: boolean;
  direction?: "up" | "down";
  amount?: number;
};

type AgentObservationSummary = {
  source?: string;
  mode?: string;
  query?: string;
  kind?: string;
  diff?: AgentDiffSummary;
  regions?: number;
  blocks?: number;
  targets?: number;
  inputs?: number;
  relations?: number;
  visuals?: number;
  totalRegions?: number;
  totalBlocks?: number;
  totalTargets?: number;
  totalInputs?: number;
  focusedIntent?: string;
  focusedCandidates?: number;
  recommendedActions?: number;
};

type AgentDiffSummary = {
  activeChanged?: boolean;
  scrollChanged?: boolean;
  newEditableInputs?: number;
  updatedEditableInputs?: number;
  actionButtons?: number;
  targetsAdded?: number;
  targetsUpdated?: number;
  targetsDisappeared?: number;
  regionsChanged?: number;
  candidateActions?: number;
};

type BrowserAgentPlan = {
  message: string;
  action: BrowserAgentAction;
  actions?: BrowserAgentAction[];
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  done?: boolean;
  success?: boolean | null;
  decision?: {
    evaluationPreviousGoal?: string;
    memory?: string;
    nextGoal?: string;
    done?: boolean;
    success?: boolean | null;
  } | null;
  debug?: {
    stage?: string;
    model?: string;
    budget?: string;
    retries?: number;
    previousError?: string;
    observation?: AgentObservationSummary;
    decision?: {
      evaluationPreviousGoal?: string;
      memory?: string;
      nextGoal?: string;
      done?: boolean;
      action?: BrowserAgentAction;
    };
  } | null;
};

type BrowserAgentSnapshot = {
  schemaVersion?: string;
  title: string;
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  state?: {
    readyState?: string;
    activeTargetId?: string;
    hasModal?: boolean;
    hasOverlay?: boolean;
    scroll?: {
      x: number;
      y: number;
      maxX: number;
      maxY: number;
    };
  };
  regions?: Array<{
    id: string;
    role: string;
    label: string;
    text?: string;
    box?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    targetIds?: string[];
    blockIds?: string[];
    inputIds?: string[];
    visualIds?: string[];
  }>;
  targets: Array<{
    id: string;
    selector?: string;
    label: string;
    tag: string;
    type: string;
    text?: string;
    ariaLabel?: string;
    title?: string;
    alt?: string;
    placeholder?: string;
    href?: string;
    value?: string;
    context?: string;
    box?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    visibility?: string;
    interaction?: {
      clickable?: boolean;
      editable?: boolean;
      selectable?: boolean;
      scrollable?: boolean;
    };
    semantics?: {
      kind?: string;
      role?: string;
      intentHints?: string[];
      confidence?: number;
    };
    regionId?: string;
    blockId?: string;
    risk?: {
      level: string;
      reason: string;
    } | null;
  }>;
  blocks?: Array<{
    id: string;
    kind?: string;
    role: string;
    text: string;
    targetIds?: string[];
    regionId?: string;
    box?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  content?: Array<{
    id: string;
    kind?: string;
    role: string;
    text: string;
    targetIds?: string[];
    regionId?: string;
    box?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  inputs?: Array<{
    id: string;
    targetId: string;
    name?: string;
    inputType?: string;
    placeholder?: string;
    value?: string;
    context?: string;
    active?: boolean;
    multiline?: boolean;
    box?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    regionId?: string;
    blockId?: string;
  }>;
  visuals?: Array<{
    id: string;
    kind: string;
    alt?: string;
    title?: string;
    ariaLabel?: string;
    nearbyText?: string;
    targetIds?: string[];
    regionId?: string;
  }>;
  relations?: Array<{
    type: string;
    from: string;
    to: string;
    confidence?: number;
  }>;
};

type BrowserObservationEnvelope = {
  kind: "full" | "patch";
  schemaVersion?: string;
  sequence?: number;
  snapshot: BrowserAgentSnapshot;
  patch?: BrowserActionablePatch | null;
};

type BrowserActionablePatch = {
  schemaVersion?: string;
  sequence?: number;
  title?: string;
  url?: string;
  activeElement?: {
    changed?: boolean;
    previousTargetId?: string;
    currentTargetId?: string;
    current?: BrowserAgentSnapshot["targets"][number] | null;
  };
  editableInputs?: {
    active?: BrowserAgentSnapshot["inputs"] extends Array<infer T> ? T | null : unknown;
    added?: BrowserAgentSnapshot["inputs"];
    updated?: BrowserAgentSnapshot["inputs"];
  };
  actionButtons?: {
    addedOrUpdated?: BrowserAgentSnapshot["targets"];
  };
  targets?: {
    added?: BrowserAgentSnapshot["targets"];
    updated?: BrowserAgentSnapshot["targets"];
    disappeared?: BrowserAgentSnapshot["targets"];
  };
  regions?: {
    changed?: BrowserAgentSnapshot["regions"];
  };
  summary?: AgentDiffSummary;
  candidateActions?: Array<{
    action?: string;
    targetId?: string;
    reason?: string;
  }>;
};

type BrowserAgentResult = {
  ok?: boolean;
  error?: string;
  reply: string;
  action: string;
  url?: string;
  point?: {
    x: number;
    y: number;
  };
  target?: {
    id: string;
    label: string;
    tag: string;
    type: string;
  };
  state?: BrowserAgentSnapshot | null;
};

type AgentDriver = "playwright" | "native";

type AgentStepHistory = {
  action: string;
  ok?: boolean;
  error?: string;
  goal?: string;
  reply: string;
  target: string;
  targetId?: string;
  text?: string;
  submitted?: boolean;
  url: string;
};

type AgentTraceItem = {
  id: string;
  step: number;
  phase: "observe" | "plan" | "action" | "result" | "error";
  title: string;
  detail: string;
};

const desktopStartUrl = "https://www.baidu.com";
const defaultAgentModel = "deepseek-v4-pro";
const agentModelOptions = [
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
];
const maxAgentSteps = 8;
const maxActionsPerStep = 2;
const maxAgentFailures = 2;

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "任务已就绪。",
  },
];

async function api<T>(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 60000, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...fetchOptions.headers,
      },
      ...fetchOptions,
    });

    const payload = (await response.json()) as T & { error?: string; debug?: unknown };

    if (!response.ok) {
      throw new Error(formatApiError(payload.error || "请求失败。", payload.debug));
    }

    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatApiError(message: string, debug: unknown) {
  if (!debug || typeof debug !== "object") {
    return message;
  }

  const details = debug as {
    attempts?: Array<{
      model?: string;
      budget?: string;
      stage?: string;
      timeoutMs?: number;
      requestBytes?: number;
      elapsedMs?: number;
      error?: string;
      observation?: AgentObservationSummary;
    }>;
    page?: {
      schemaVersion?: string;
      regions?: number;
      blocks?: number;
      targets?: number;
      inputs?: number;
      relations?: number;
      visuals?: number;
    };
  };
  const page = details.page
    ? `页面 JSON：${details.page.schemaVersion || "unknown"}，regions ${details.page.regions ?? 0}，blocks ${details.page.blocks ?? 0}，targets ${details.page.targets ?? 0}，inputs ${details.page.inputs ?? 0}，relations ${details.page.relations ?? 0}，visuals ${details.page.visuals ?? 0}`
    : "";
  const attempts = Array.isArray(details.attempts)
    ? details.attempts
        .map((attempt, index) => {
          const size = attempt.requestBytes
            ? `${Math.round(attempt.requestBytes / 1024)}KB`
            : "?KB";
          const elapsed = attempt.elapsedMs ? `${attempt.elapsedMs}ms` : "?ms";
          const timeout = attempt.timeoutMs ? `${attempt.timeoutMs}ms` : "?ms";
          const observation = describeObservationSummary(attempt.observation);
          return [
            `${index + 1}. ${attempt.stage || "plan"} / ${attempt.model || "model"} / ${attempt.budget || "budget"}，请求 ${size}，耗时 ${elapsed}/${timeout}，错误：${attempt.error || "unknown"}`,
            observation ? `observe ${observation}` : "",
          ]
            .filter(Boolean)
            .join("；");
        })
        .join("\n")
    : "";

  return [message, page, attempts ? `DeepSeek 尝试：\n${attempts}` : ""]
    .filter(Boolean)
    .join("\n");
}

function newMessage(role: ChatMessage["role"], text: string, thinking?: AgentTraceItem[]): ChatMessage {
  return {
    id: `${role}-${crypto.randomUUID()}`,
    role,
    text,
    thinking,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function compactReplies(replies: string[]) {
  const compacted = replies
    .map((reply) => reply.trim())
    .filter(Boolean)
    .filter((reply) => !/^(动作|调试)：/.test(reply))
    .filter((reply, index, all) => index === 0 || reply !== all[index - 1]);

  return compacted.join("\n") || "已处理。";
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : String(cause || fallback);
}

function describeObservationSummary(observation?: AgentObservationSummary) {
  if (!observation) {
    return "";
  }

  const selected = [
    observation.kind ? `kind ${observation.kind}` : "",
    `mode ${observation.mode || "general"}`,
    `blocks ${observation.blocks ?? 0}/${observation.totalBlocks ?? 0}`,
    `targets ${observation.targets ?? 0}/${observation.totalTargets ?? 0}`,
    `inputs ${observation.inputs ?? 0}/${observation.totalInputs ?? 0}`,
    observation.diff
      ? `diff +${observation.diff.targetsAdded ?? 0}/~${observation.diff.targetsUpdated ?? 0}/-${observation.diff.targetsDisappeared ?? 0}, inputs +${observation.diff.newEditableInputs ?? 0}`
      : "",
    observation.diff?.candidateActions
      ? `candidates ${observation.diff.candidateActions}`
      : "",
    observation.focusedIntent
      ? `focused ${observation.focusedIntent} ${observation.focusedCandidates ?? 0}`
      : "",
    observation.recommendedActions
      ? `recommended ${observation.recommendedActions}`
      : "",
  ];
  return selected.filter(Boolean).join(", ");
}

function summarizeSnapshot(state: BrowserAgentSnapshot) {
  const title = state.title || "未命名页面";
  const url = shortUrl(state.url);
  const contentCount = state.blocks?.length || state.content?.length || 0;
  const targetCount = state.targets.length;
  const regionCount = state.regions?.length || 0;
  const inputCount = state.inputs?.length || 0;
  return `${title}\n${url}\n区域 ${regionCount} 个，内容块 ${contentCount} 条，可操作目标 ${targetCount} 个，输入目标 ${inputCount} 个。`;
}

function summarizeObservation(observation: BrowserObservationEnvelope) {
  const state = observation.snapshot;
  const base = summarizeSnapshot(state);
  if (observation.kind !== "patch" || !observation.patch?.summary) {
    return `full snapshot\n${base}`;
  }

  const summary = observation.patch.summary;
  const active = observation.patch.activeElement?.changed
    ? `active ${observation.patch.activeElement.previousTargetId || "-"} -> ${observation.patch.activeElement.currentTargetId || "-"}`
    : "active unchanged";
  return [
    "incremental patch",
    base,
    `${active}; scroll ${summary.scrollChanged ? "changed" : "same"}; inputs +${summary.newEditableInputs ?? 0}/~${summary.updatedEditableInputs ?? 0}; buttons ${summary.actionButtons ?? 0}; targets +${summary.targetsAdded ?? 0}/~${summary.targetsUpdated ?? 0}/-${summary.targetsDisappeared ?? 0}; regions ~${summary.regionsChanged ?? 0}`,
  ].join("\n");
}

function describeAction(action?: BrowserAgentAction) {
  if (!action || action.type === "none") {
    return "动作：不操作，继续观察或等待用户补充。";
  }

  if (action.type === "navigate") {
    return `动作：打开页面 ${action.url || ""}`;
  }

  if (action.type === "click") {
    return `动作：点击目标 ${action.targetId || ""}`;
  }

  if (action.type === "type") {
    const submit = action.submit ? "，并提交" : "";
    return `动作：向 ${action.targetId || ""} 输入“${action.text || ""}”${submit}`;
  }

  if (action.type === "scroll") {
    return `动作：向${action.direction === "up" ? "上" : "下"}滚动${action.targetId ? ` ${action.targetId}` : ""}`;
  }

  return `动作：${action.type}`;
}

function describeActions(actions?: BrowserAgentAction[]) {
  const executable = (actions || []).filter((action) => action.type !== "none");
  if (!executable.length) {
    return describeAction(actions?.[0]);
  }

  return executable.map((action, index) => `${index + 1}. ${describeAction(action)}`).join("\n");
}

function planActions(plan: BrowserAgentPlan) {
  const actions = Array.isArray(plan.actions) && plan.actions.length
    ? plan.actions
    : [plan.action];
  return actions.slice(0, maxActionsPerStep);
}

function describePlanDebug(debug?: BrowserAgentPlan["debug"]) {
  if (!debug) {
    return "";
  }

  const observation = describeObservationSummary(debug.observation);
  const parts = [
    observation ? `observe ${observation}` : "",
    debug.stage ? `阶段 ${debug.stage}` : "",
    debug.model ? `模型 ${debug.model}` : "",
    debug.budget ? `上下文 ${debug.budget}` : "",
    debug.decision?.evaluationPreviousGoal
      ? `上步评估 ${debug.decision.evaluationPreviousGoal}`
      : "",
    debug.decision?.nextGoal ? `下一目标 ${debug.decision.nextGoal}` : "",
    Number(debug.retries) > 0 ? `重试 ${debug.retries} 次` : "",
    debug.previousError ? `上一错误 ${debug.previousError}` : "",
  ].filter(Boolean);

  return parts.length ? `\n诊断：${parts.join("，")}` : "";
}

function shortUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value || "about:blank";
  }
}

export function App() {
  const tauriClient = isTauri();
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [address, setAddress] = useState(tauriClient ? desktopStartUrl : "");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const [agentTrace, setAgentTrace] = useState<AgentTraceItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(tauriClient);
  const localTraceRef = useRef<AgentTraceItem[]>([]);
  const pendingMessageIdRef = useRef<string | null>(null);
  const [thinkingTicker, setThinkingTicker] = useState(0);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setThinkingTicker((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [busy]);
  const [agentDriver, setAgentDriver] = useState<AgentDriver>("playwright");
  const [nativeBrowserReady, setNativeBrowserReady] = useState(false);
  const [nativeBrowserError, setNativeBrowserError] = useState("");
  const browserDock = useRef<HTMLDivElement | null>(null);
  const nativeWebview = useRef<string | null>(null);
  const nativeWebviewGeneration = useRef(0);
  const creationTimeout = useRef<number | null>(null);

  useEffect(() => {
    let active = true;

    api<SettingsState>("/api/settings")
      .then((savedSettings) => {
        if (active) {
          setSettings(savedSettings);
        }
      })
      .catch((cause: Error) => {
        if (active) {
          setError(cause.message);
        }
      })
      .finally(() => {
        if (active && !tauriClient) {
          setBusy(false);
        }
      });

    return () => {
      active = false;
    };
  }, [tauriClient]);

  useEffect(() => {
    if (!tauriClient) {
      return;
    }

    let active = true;
    const unlisteners: Array<() => void> = [];

    void listen<string>("browser:navigated", (event) => {
      if (active && event.payload) {
        setAddress(event.payload);
      }
    }).then((cleanup) => {
      active ? unlisteners.push(cleanup) : cleanup();
    });

    void listen<string>("browser:webview-created", (event) => {
      if (!active || event.payload !== nativeWebview.current) {
        return;
      }

      clearCreationTimeout();
      setNativeBrowserReady(true);
      setBusy(false);
      void syncNativeWebviewBounds();
      void invoke("browser_focus_webview", { label: event.payload }).catch(
        () => {},
      );
    }).then((cleanup) => {
      active ? unlisteners.push(cleanup) : cleanup();
    });

    void listen<BrowserWebviewError>("browser:webview-error", (event) => {
      if (!active || event.payload.label !== nativeWebview.current) {
        return;
      }

      clearCreationTimeout();
      nativeWebview.current = null;
      setNativeBrowserError(event.payload.message);
      setBusy(false);
    }).then((cleanup) => {
      active ? unlisteners.push(cleanup) : cleanup();
    });

    return () => {
      active = false;
      for (const cleanup of unlisteners) {
        cleanup();
      }
    };
  }, [tauriClient]);

  useEffect(() => {
    if (!tauriClient) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    const dock = browserDock.current;

    if (!dock) {
      return;
    }

    const scheduleBoundsSync = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        void syncNativeWebviewBounds();
      });
    };

    const observer = new ResizeObserver(scheduleBoundsSync);
    observer.observe(dock);
    window.addEventListener("resize", scheduleBoundsSync);
    animationFrame = requestAnimationFrame(() => {
      if (!disposed) {
        void replaceNativeWebview(address || desktopStartUrl);
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleBoundsSync);
      clearCreationTimeout();
      if (nativeWebview.current) {
        void closeNativeWebview(nativeWebview.current);
      }
      nativeWebview.current = null;
    };
  }, [tauriClient]);

  async function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = address.trim();
    if (!next || !tauriClient) {
      return;
    }

    await replaceNativeWebview(next);
  }

  async function refresh() {
    if (tauriClient) {
      await replaceNativeWebview(address || desktopStartUrl);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) {
      return;
    }

    setPrompt("");
    setError("");
    setAgentTrace([]);
    setBusy(true);
    setMessages((current) => [...current, newMessage("user", text)]);

    let nonTauriPid = "";
    const updateNonTauriPlaceholder = (updater: (m: ChatMessage) => ChatMessage) => {
      if (!nonTauriPid) return;
      setMessages((current) =>
        current.map((m) => (m.id === nonTauriPid ? updater(m) : m)),
      );
    };

    try {
      if (tauriClient) {
        const label = nativeWebview.current;
        if (!label) {
          throw new Error("浏览器 WebView 还没有准备好。");
        }

        const pid = `assistant-${crypto.randomUUID()}`;
        const placeholder: ChatMessage = {
          id: pid,
          role: "assistant",
          text: "",
          thinking: [],
          _pending: true,
          _startedAt: Date.now(),
        };
        pendingMessageIdRef.current = pid;
        setMessages((current) => [...current, placeholder]);

        await runAgentLoop(label, text);
        pendingMessageIdRef.current = null;
        return;
      }

      nonTauriPid = `assistant-${crypto.randomUUID()}`;
      const placeholder: ChatMessage = {
        id: nonTauriPid,
        role: "assistant",
        text: "",
        thinking: [],
        _pending: true,
        _startedAt: Date.now(),
      };
      setMessages((current) => [...current, placeholder]);

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMsg = `请求失败 (${response.status})`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* keep status message */ }
        throw new Error(errorMsg);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      const streamDeadline = Date.now() + 120000;

      while (true) {
        const remaining = streamDeadline - Date.now();
        if (remaining <= 0) {
          throw new Error("任务处理超时，请重试。");
        }

        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) =>
          setTimeout(() => reject(new Error("任务处理超时，请重试。")), Math.min(remaining, 15000)),
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "thinking") {
                updateNonTauriPlaceholder((m) => ({
                  ...m,
                  thinking: [...(m.thinking || []), data],
                }));
              } else if (currentEvent === "result") {
                updateNonTauriPlaceholder((m) => ({
                  ...m,
                  text: data.message,
                  _pending: false,
                }));
              } else if (currentEvent === "error") {
                throw new Error(data.error);
              }
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) continue;
              throw parseErr;
            }
          }
        }
      }
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : String(cause || "Agent 执行失败。");
      setError(message);
      if (nonTauriPid) {
        updateNonTauriPlaceholder((m) => ({
          ...m,
          text: message,
          _pending: false,
        }));
      } else {
        setMessages((current) => [...current, newMessage("assistant", message)]);
      }
    } finally {
      setBusy(false);
      setAgentTrace([]);
    }
  }

  async function runAgentLoop(label: string, text: string) {
    const history: AgentStepHistory[] = [];
    const replies: string[] = [];
    localTraceRef.current = [];
    let consecutiveFailures = 0;
    let shouldStop = false;

    for (let step = 1; step <= maxAgentSteps && !shouldStop; step += 1) {
      const observation = await invoke<BrowserObservationEnvelope>("browser_agent_observe", {
        label,
        forceFull: step === 1 || consecutiveFailures > 0,
      });
      const state = observation.snapshot;
      appendTrace({
        step,
        phase: "observe",
        title: observation.kind === "patch" ? "增量观察" : "观察页面",
        detail: summarizeObservation(observation),
      });
      appendTrace({
        step,
        phase: "plan",
        title: "请求规划",
        detail: "正在生成任务状态和页面观察结果，再交给 DeepSeek 规划下一步。",
      });
      let plan: BrowserAgentPlan;
      try {
        plan = await api<BrowserAgentPlan>("/api/agent/plan", {
          method: "POST",
          timeoutMs: 120000,
          body: JSON.stringify({
            message: text,
            progress: {
              step,
              maxSteps: maxAgentSteps,
              history,
            },
            state,
            observation: {
              kind: observation.kind,
              sequence: observation.sequence,
              patch: observation.patch || null,
            },
          }),
        });
      } catch (cause) {
        appendTrace({
          step,
          phase: "error",
          title: "规划失败",
          detail: errorMessage(cause, "规划失败"),
        });
        throw cause;
      }
      appendTrace({
        step,
        phase: "plan",
        title: "规划下一步",
        detail: `${plan.message || "模型没有补充说明"}\n${describeActions(planActions(plan))}${describePlanDebug(plan.debug)}`,
      });

      if (plan.message) {
        replies.push(plan.message);
      }

      const actions = planActions(plan).filter((action) => action?.type && action.type !== "none");
      if (!actions.length || plan.done || plan.decision?.done) {
        appendTrace({
          step,
          phase: "result",
          title: "任务暂停",
          detail: plan.done || plan.decision?.done
            ? "模型判断任务已完成或需要停止。"
            : "模型判断当前不需要继续执行浏览器动作。",
        });
        break;
      }

      appendTrace({
        step,
        phase: "action",
        title: "执行动作",
        detail: describeActions(actions),
      });

      const results: BrowserAgentResult[] = await executePlannedActions(label, actions, state).catch((cause) => {
        const message =
          cause instanceof Error ? cause.message : String(cause || "执行失败");
        return [{
          ok: false,
          action: actions[0]?.type || "none",
          reply: "动作执行失败。",
          error: message,
        } satisfies BrowserAgentResult] as BrowserAgentResult[];
      });

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const action = actions[index] || actions[actions.length - 1];

        if (result.url) {
          setAddress(result.url);
        }

        if (result.ok === false) {
          consecutiveFailures += 1;
          const message = result.error || result.reply || "动作执行失败。";
          appendTrace({
            step,
            phase: "error",
            title: "执行失败",
            detail: `${describeAction(action)}\n${message}`,
          });
          history.push(historyItemFromAction({
            action,
            ok: false,
            error: message,
            plan,
            result,
            state,
          }));

          if (consecutiveFailures >= maxAgentFailures) {
            const finalMessage = `连续 ${consecutiveFailures} 次动作失败，任务已停止：${message}`;
            replies.push(finalMessage);
            shouldStop = true;
          }
          break;
        }

        consecutiveFailures = 0;
        if (result.reply) {
          replies.push(result.reply);
        }
        appendTrace({
          step,
          phase: "result",
          title: "执行结果",
          detail: result.reply || "动作执行完成。",
        });
        history.push(historyItemFromAction({
          action,
          ok: true,
          plan,
          result,
          state,
        }));

        await sleep(postActionObservationDelay(action, text));

        if (action.type === "navigate") {
          break;
        }
      }

      if (step === maxAgentSteps) {
        replies.push("已到最大步骤，先停下。");
      }
    }

    if (pendingMessageIdRef.current) {
      setMessages((current) =>
        current.map((m) =>
          m.id === pendingMessageIdRef.current
            ? { ...m, text: compactReplies(replies), _pending: false }
            : m,
        ),
      );
    } else {
      setMessages((current) => [
        ...current,
        newMessage("assistant", compactReplies(replies), localTraceRef.current),
      ]);
    }
  }

  function appendTrace(item: Omit<AgentTraceItem, "id">) {
    const entry = {
      ...item,
      id: `${item.phase}-${item.step}-${crypto.randomUUID()}`,
    };
    localTraceRef.current.push(entry);
    setAgentTrace((current) => [
      ...current,
      entry,
    ]);
    if (pendingMessageIdRef.current) {
      setMessages((current) =>
        current.map((m) =>
          m.id === pendingMessageIdRef.current
            ? { ...m, thinking: [...(m.thinking || []), entry] }
            : m,
        ),
      );
    }
  }

  function postActionObservationDelay(action: BrowserAgentAction, request: string) {
    if (action.type === "navigate") {
      return 900;
    }

    if (
      action.type === "click" &&
      /comment|reply|type|input|send|post|publish|评论|回复|输入|发送|发表|发布|留言/i.test(request)
    ) {
      return 900;
    }

    if (action.type === "type") {
      return 900;
    }

    if (action.type === "scroll") {
      return 650;
    }

    return 450;
  }

  function historyItemFromAction({
    action,
    error = "",
    ok,
    plan,
    result,
    state,
  }: {
    action: BrowserAgentAction;
    error?: string;
    ok: boolean;
    plan: BrowserAgentPlan;
    result: BrowserAgentResult;
    state: BrowserAgentSnapshot;
  }): AgentStepHistory {
    return {
      action: action.type,
      ok,
      error,
      goal: plan.nextGoal || plan.decision?.nextGoal || plan.debug?.decision?.nextGoal || plan.message || "",
      reply: result.reply || plan.message || "",
      target: result.target?.label || action.targetId || action.url || "",
      targetId: action.targetId || result.target?.id || "",
      text: action.type === "type" ? action.text || "" : "",
      submitted: action.type === "type" && Boolean(action.submit),
      url: result.url || state.url,
    };
  }

  async function executePlannedActions(
    label: string,
    actions: BrowserAgentAction[],
    state: BrowserAgentSnapshot,
  ) {
    const limitedActions = actions
      .filter(isExecutableBrowserAction)
      .slice(0, maxActionsPerStep);
    if (!limitedActions.length) {
      return [{
        ok: false,
        action: "none",
        reply: "动作执行失败。",
        error: "planner returned no executable browser action",
      } satisfies BrowserAgentResult];
    }

    if (agentDriver === "playwright") {
      const results: BrowserAgentResult[] = [];
      for (const action of limitedActions) {
        const result = await api<BrowserAgentResult>("/api/webview-cdp/execute", {
          method: "POST",
          body: JSON.stringify({
            action,
            state,
          }),
        });
        results.push(result);

        if (result.ok === false || action.type === "navigate") {
          break;
        }
      }

      return results;
    }

    const results: BrowserAgentResult[] = [];
    for (const action of limitedActions) {
      const result = await invoke<BrowserAgentResult>("browser_agent_execute", {
        label,
        action,
      });
      results.push(result);

      if (result.ok === false || action.type === "navigate") {
        break;
      }
    }

    return results;
  }

  function isExecutableBrowserAction(action: BrowserAgentAction | undefined) {
    if (!action || action.type === "none") {
      return false;
    }

    if (action.type === "navigate") {
      return Boolean(action.url);
    }

    if (action.type === "click") {
      return Boolean(action.targetId);
    }

    if (action.type === "type") {
      return Boolean(action.targetId) && typeof action.text === "string";
    }

    return action.type === "scroll";
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function replaceNativeWebview(url: string) {
    const dock = browserDock.current;
    if (!dock) {
      return;
    }

    const resolvedUrl = normalizeBrowserAddress(url);
    const bounds = browserDockBounds(dock);
    if (!bounds) {
      return;
    }

    setBusy(true);
    setError("");
    setNativeBrowserReady(false);
    setNativeBrowserError("");
    clearCreationTimeout();

    if (nativeWebview.current) {
      await closeNativeWebview(nativeWebview.current);
      nativeWebview.current = null;
    }

    const label = `browser-${nativeWebviewGeneration.current++}`;
    nativeWebview.current = label;
    setAddress(resolvedUrl);

    try {
      await invoke("browser_create_webview", {
        label,
        url: resolvedUrl,
        ...bounds,
      });

      creationTimeout.current = window.setTimeout(() => {
        if (nativeWebview.current === label && !nativeBrowserReady) {
          setNativeBrowserError("WebView 创建超时。");
          setBusy(false);
        }
      }, 8000);
    } catch (cause) {
      nativeWebview.current = null;
      setNativeBrowserError(
        cause instanceof Error ? cause.message : "WebView 创建失败。",
      );
      setBusy(false);
    }
  }

  async function syncNativeWebviewBounds() {
    const dock = browserDock.current;
    const label = nativeWebview.current;
    if (!dock || !label) {
      return;
    }

    const bounds = browserDockBounds(dock);
    if (!bounds) {
      return;
    }

    await invoke("browser_set_webview_bounds", {
      label,
      ...bounds,
    }).catch((cause) => {
      setNativeBrowserError(
        cause instanceof Error ? cause.message : "WebView 布局失败。",
      );
    });
  }

  async function closeNativeWebview(label: string) {
    await invoke("browser_close_webview", { label }).catch(() => {});
  }

  function clearCreationTimeout() {
    if (creationTimeout.current !== null) {
      window.clearTimeout(creationTimeout.current);
      creationTimeout.current = null;
    }
  }

  function browserDockBounds(dock: HTMLDivElement): NativeBounds | null {
    const rect = dock.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    if (width < 80 || height < 80) {
      return null;
    }

    return {
      x: Math.floor(rect.left),
      y: Math.floor(rect.top),
      width,
      height,
    };
  }

  return (
    <main className="shell">
      <section className="browser-pane">
        <header className="browser-toolbar">
          <div className="brand" aria-label="BrowserPilot">
            <Globe2 />
            <strong>BrowserPilot</strong>
          </div>

          <div className="nav-controls" aria-label="浏览器导航">
            <button aria-label="后退" disabled={busy} type="button">
              <ChevronLeft />
            </button>
            <button aria-label="前进" disabled={busy} type="button">
              <ChevronRight />
            </button>
            <button
              aria-label="刷新"
              disabled={busy}
              onClick={() => void refresh()}
              type="button"
            >
              <RefreshCw />
            </button>
          </div>

          <form className="address-bar" onSubmit={navigate}>
            <LockKeyhole className="address-lock" />
            <input
              aria-label="地址"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://"
              value={address}
            />
            <button aria-label="打开" disabled={busy} type="submit">
              <Star />
            </button>
          </form>

          <button
            aria-label="更多"
            className="icon-button"
            disabled={busy}
            type="button"
          >
            <MoreVertical />
          </button>
        </header>

        <div className="browser-stage">
          {tauriClient ? (
            <div className="native-browser-dock" ref={browserDock}>
              {!nativeBrowserReady && !nativeBrowserError && (
                <span>启动 Tauri WebView</span>
              )}
              {nativeBrowserError && <strong>{nativeBrowserError}</strong>}
            </div>
          ) : (
            <div className="client-only-stage">
              <strong>BrowserPilot Desktop</strong>
              <span>运行 npm run desktop:tauri -- dev 打开桌面客户端。</span>
            </div>
          )}

          {tauriClient && busy && (
            <div className="busy-shade is-passive">
              <LoaderCircle />
            </div>
          )}
        </div>

        <footer className="browser-status">
          <span className={nativeBrowserReady || !tauriClient ? "is-live" : ""} />
          <strong>
            {nativeBrowserReady
              ? "页面已加载"
              : tauriClient
                ? "正在准备页面"
                : "需要桌面客户端"}
          </strong>
        </footer>
      </section>

      <aside className="chat-pane">
        <header className="chat-header">
          <div className="chat-title">
            <span className="app-icon">
              <Globe2 />
            </span>
            <div>
              <strong>BrowserPilot</strong>
              <p>你的 AI 浏览助手，帮你理解并操作网页。</p>
            </div>
          </div>
          <button
            aria-label="设置"
            className="icon-button"
            onClick={() => setSettingsOpen((current) => !current)}
            type="button"
          >
            <Settings2 />
          </button>
        </header>

        {settingsOpen && settings && (
          <SettingsDialog
            agentDriver={agentDriver}
            agentTrace={agentTrace}
            busy={settingsBusy}
            saved={settings}
            onAgentDriverChange={setAgentDriver}
            onClose={() => setSettingsOpen(false)}
            onSave={async (payload) => {
              setSettingsBusy(true);
              setError("");

              try {
                const next = await api<SettingsState>("/api/settings", {
                  method: "PUT",
                  body: JSON.stringify(payload),
                });
                setSettings(next);
                setSettingsOpen(false);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "设置保存失败。");
              } finally {
                setSettingsBusy(false);
              }
            }}
          />
        )}

        <section className="messages">
          {messages.map((message) => {
            const elapsed = message._startedAt
              ? Math.round((Date.now() - message._startedAt) / 1000)
              : 0;
            const hasThinking = message.thinking && message.thinking.length > 0;

            return (
              <article className={`message ${message.role}`} key={message.id}>
                <span>{message.role === "assistant" ? <Bot /> : "你"}</span>
                <div>
                  {message.text && <p>{message.text}</p>}
                  {hasThinking && (
                    <details className="thinking-fold" open={message._pending}>
                      <summary>思考过程 ({message.thinking!.length} 步){message._pending ? ` · ${elapsed}s` : ""}</summary>
                      <ol>
                        {message.thinking!.map((item) => (
                          <li className={`is-${item.phase}`} key={item.id}>
                            <strong>{item.title}</strong>
                            {item.detail && <p>{item.detail}</p>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <div className="quick-actions" aria-label="快捷任务">
          <button
            disabled={busy}
            onClick={() => setPrompt("提取本文的所有链接")}
            type="button"
          >
            提取本文的所有链接
          </button>
          <button
            disabled={busy}
            onClick={() => setPrompt("对比本页与竞品页的差异")}
            type="button"
          >
            对比本页与竞品页的差异
          </button>
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <Sparkles />
          <textarea
            aria-label="任务"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="询问 BrowserPilot 或输入指令..."
            rows={1}
            value={prompt}
          />
          <button aria-label="发送" disabled={busy} type="submit">
            <SendHorizontal />
          </button>
        </form>

        <footer className="chat-status">
          <span className={settings?.hasDeepSeekKey ? "is-ready" : ""}>
            BrowserPilot 已就绪
          </span>
          <Info />
          {error && <strong>{error}</strong>}
        </footer>
      </aside>
    </main>
  );
}

function normalizeBrowserAddress(value: string) {
  const next = value.trim();
  if (!next) {
    return desktopStartUrl;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(next)) {
    return next;
  }

  return `https://${next}`;
}

type SettingsDialogProps = {
  agentDriver: AgentDriver;
  agentTrace: AgentTraceItem[];
  busy: boolean;
  saved: SettingsState;
  onAgentDriverChange: (driver: AgentDriver) => void;
  onClose: () => void;
  onSave: (payload: {
    apiKey?: string;
    clearKey?: boolean;
    model: string;
  }) => Promise<void>;
};

function SettingsDialog({
  agentDriver,
  agentTrace,
  busy,
  saved,
  onAgentDriverChange,
  onClose,
  onSave,
}: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(
    agentModelOptions.includes(saved.model) ? saved.model : defaultAgentModel,
  );

  return (
    <form
      className="settings-dialog settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          apiKey: apiKey.trim() || undefined,
          model,
        });
      }}
      role="region"
    >
      <header>
        <div>
          <p>设置</p>
          <h2>DeepSeek</h2>
        </div>
        <button aria-label="关闭" onClick={onClose} type="button">
          <X />
        </button>
      </header>

      <div className="settings-body">
        <label>
          <span>API Key</span>
          <input
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={saved.hasDeepSeekKey ? "已保存，输入新 Key 可覆盖" : "sk-"}
            type="password"
            value={apiKey}
          />
        </label>

        <label>
          <span>模型</span>
          <select onChange={(event) => setModel(event.target.value)} value={model}>
            {agentModelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <section className="settings-group" aria-label="Agent 操作模式">
          <span>操作模式</span>
          <div className="driver-switch">
            <button
              className={agentDriver === "playwright" ? "is-active" : ""}
              disabled={busy}
              onClick={() => onAgentDriverChange("playwright")}
              type="button"
            >
              Playwright
            </button>
            <button
              className={agentDriver === "native" ? "is-active" : ""}
              disabled={busy}
              onClick={() => onAgentDriverChange("native")}
              type="button"
            >
              真鼠标
            </button>
          </div>
        </section>

        {agentTrace.length > 0 && (
          <section className="agent-trace" aria-label="Agent 任务轨迹">
            <header>
              <strong>任务轨迹</strong>
              <span>{agentTrace.length}</span>
            </header>
            <ol>
              {agentTrace.map((item) => (
                <li className={`is-${item.phase}`} key={item.id}>
                  <b>{item.step}</b>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <footer>
        <button
          className="quiet-button"
          disabled={busy || !saved.hasDeepSeekKey}
          onClick={() =>
            void onSave({
              clearKey: true,
              model,
            })
          }
          type="button"
        >
          清除 Key
        </button>
        <button disabled={busy} type="submit">
          保存
        </button>
      </footer>
    </form>
  );
}
