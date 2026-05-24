import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Bot,
  Globe2,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  SendHorizontal,
  Settings2,
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
  type: "navigate" | "click" | "type" | "none";
  targetId?: string;
  url?: string;
  text?: string;
  submit?: boolean;
};

type BrowserAgentPlan = {
  message: string;
  action: BrowserAgentAction;
};

type BrowserAgentSnapshot = {
  title: string;
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  targets: Array<{
    id: string;
    label: string;
    tag: string;
    type: string;
    context?: string;
    risk?: {
      level: string;
      reason: string;
    } | null;
  }>;
  content?: Array<{
    id: string;
    role: string;
    text: string;
    targetIds?: string[];
  }>;
};

type BrowserAgentResult = {
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
};

const desktopStartUrl = "https://www.baidu.com";

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "任务已就绪。",
  },
];

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || "请求失败。");
  }

  return payload;
}

function newMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `${role}-${crypto.randomUUID()}`,
    role,
    text,
  };
}

export function App() {
  const tauriClient = isTauri();
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [address, setAddress] = useState(tauriClient ? desktopStartUrl : "");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(tauriClient);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState("");
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
    setBusy(true);
    setMessages((current) => [...current, newMessage("user", text)]);

    try {
      if (tauriClient) {
        const label = nativeWebview.current;
        if (!label) {
          throw new Error("浏览器 WebView 还没有准备好。");
        }

        const state = await invoke<BrowserAgentSnapshot>("browser_agent_snapshot", {
          label,
        });
        const plan = await api<BrowserAgentPlan>("/api/agent/plan", {
          method: "POST",
          body: JSON.stringify({
            message: text,
            state,
          }),
        });

        let assistantText = plan.message || "收到。";
        if (plan.action?.type && plan.action.type !== "none") {
          const result = await invoke<BrowserAgentResult>("browser_agent_execute", {
            label,
            action: plan.action,
          });

          if (result.url) {
            setAddress(result.url);
          }

          if (result.reply) {
            assistantText = `${assistantText}\n${result.reply}`;
          }
        }

        setMessages((current) => [
          ...current,
          newMessage("assistant", assistantText),
        ]);
        return;
      }

      const result = await api<{ message: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });

      setMessages((current) => [
        ...current,
        newMessage("assistant", result.message),
      ]);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : String(cause || "Agent 执行失败。");
      setError(message);
      setMessages((current) => [...current, newMessage("assistant", message)]);
    } finally {
      setBusy(false);
    }
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

          <form className="address-bar" onSubmit={navigate}>
            <input
              aria-label="地址"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://"
              value={address}
            />
            <button aria-label="打开" disabled={busy} type="submit">
              <ArrowRight />
            </button>
          </form>

          <button
            aria-label="刷新"
            className="icon-button"
            disabled={busy}
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw />
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
          <span>{tauriClient ? "Tauri WebView" : "Desktop client required"}</span>
          <em className={tauriClient ? "is-live" : ""}>
            {tauriClient ? "客户端" : "Web 调试页"}
          </em>
          <code title={address}>
            {tauriClient ? address : "npm run desktop:tauri -- dev"}
          </code>
        </footer>
      </section>

      <aside className="chat-pane">
        <header className="chat-header">
          <div>
            <p>浏览器领航员</p>
            <strong>任务对话</strong>
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
            busy={settingsBusy}
            saved={settings}
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
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === "assistant" ? <Bot /> : "你"}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            aria-label="任务"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="例如：搜索 BrowserPilot，点击 新闻，打开 example.com"
            rows={3}
            value={prompt}
          />
          <button aria-label="发送" disabled={busy} type="submit">
            <SendHorizontal />
          </button>
        </form>

        <footer className="chat-status">
          <span className={settings?.hasDeepSeekKey ? "is-ready" : ""}>
            <KeyRound />
            DeepSeek
          </span>
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
  busy: boolean;
  saved: SettingsState;
  onClose: () => void;
  onSave: (payload: {
    apiKey?: string;
    clearKey?: boolean;
    model: string;
  }) => Promise<void>;
};

function SettingsDialog({
  busy,
  saved,
  onClose,
  onSave,
}: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(saved.model);

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
          <option value="deepseek-v4-flash">deepseek-v4-flash</option>
          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
          <option value="deepseek-chat">deepseek-chat</option>
          <option value="deepseek-reasoner">deepseek-reasoner</option>
        </select>
      </label>

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
