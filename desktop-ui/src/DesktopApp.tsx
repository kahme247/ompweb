import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
};

type SessionState = "idle" | "starting" | "ready" | "running" | "exited";

type RpcFrame = {
  type: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function DesktopApp() {
  const [home, setHome] = useState("");
  const [cwd, setCwd] = useState("");
  const [session, setSession] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const streaming = useRef<ChatMessage | null>(null);

  useEffect(() => {
    invoke<string>("omp_home")
      .then((h) => {
        setHome(h);
        setCwd((c) => c || h);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<RpcFrame>("omp-frame", (event) => {
        const frame = event.payload;
        switch (frame.type) {
          case "message_start": {
            const role = frame.message?.role;
            if (role === "user") {
              const text = contentText(frame.message?.content);
              if (text) setMessages((m) => [...m, { role: "user", text }]);
            } else if (role === "assistant") {
              streaming.current = { role: "assistant", text: "", thinking: "" };
            }
            break;
          }
          case "message_update": {
            const ev = frame.assistantMessageEvent;
            const cur = streaming.current;
            if (!ev || !cur) break;
            if (ev.type === "thinking_delta" && ev.delta) {
              cur.thinking += ev.delta;
            } else if (ev.type === "text_delta" && ev.delta) {
              cur.text += ev.delta;
            }
            // Re-render the in-progress message.
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.role === "assistant" && last.text === "" && last.thinking === "") {
                return [...m.slice(0, -1), { ...cur }];
              }
              return [...m, { ...cur }];
            });
            break;
          }
          case "message_end": {
            if (streaming.current) {
              const done = { ...streaming.current };
              setMessages((m) => {
                const last = m[m.length - 1];
                if (last?.role === "assistant") return [...m.slice(0, -1), done];
                return [...m, done];
              });
              streaming.current = null;
            }
            break;
          }
          case "agent_start":
            setSession("running");
            break;
          case "agent_end":
            if (session !== "exited") setSession("ready");
            break;
        }
      }),
      listen<{ code: number | null }>("omp-exit", () => {
        setSession("exited");
        streaming.current = null;
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
    // session only read for the exit guard; keep handler identity stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    setSession("starting");
    setError("");
    setMessages([]);
    streaming.current = null;
    try {
      await invoke("omp_start", { cwd });
      setSession("ready");
    } catch (err) {
      setError(String(err));
      setSession("idle");
    }
  }, [cwd]);

  const stop = useCallback(async () => {
    await invoke("omp_stop").catch(() => {});
    setSession("idle");
  }, []);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || session !== "ready") return;
    setInput("");
    setSession("running");
    try {
      await invoke("omp_send", { command: { type: "prompt", message } });
      setSession("ready");
    } catch (err) {
      setError(String(err));
      setSession("ready");
    }
  }, [input, session]);

  const busy = session === "starting" || session === "running";
  const started = session !== "idle" && session !== "exited";
  const emptyHint: Record<SessionState, string> = {
    idle: "Open a session to start chatting with omp.",
    starting: "Starting omp…",
    ready: "Session ready — type a prompt below.",
    running: "Working…",
    exited: "omp exited. Open a new session.",
  };

  return (
    <div className="desktop-app">
      <header className="desktop-toolbar">
        <input
          className="desktop-cwd"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder={home || "working directory"}
          disabled={started}
          spellCheck={false}
        />
        <button
          className={started ? "desktop-btn" : "desktop-btn desktop-btn-primary"}
          onClick={started ? stop : start}
          disabled={started ? false : !cwd.trim() || busy}
        >
          {started ? "Stop" : busy ? "Starting…" : "Open session"}
        </button>
      </header>

      {error && <div className="desktop-error">{error}</div>}

      <main className="desktop-transcript">
        {messages.length === 0 && <div className="desktop-empty">{emptyHint[session]}</div>}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="desktop-msg desktop-msg-user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="desktop-msg desktop-msg-assistant">
              {m.thinking && <details className="desktop-thinking"><summary>Thinking</summary><pre>{m.thinking}</pre></details>}
              <div className="desktop-msg-text">{m.text}</div>
            </div>
          ),
        )}
        {session === "running" && <div className="desktop-cursor" aria-hidden />}
      </main>

      <footer className="desktop-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={started ? "Type a prompt… (Enter to send)" : "Open a session first"}
          disabled={!started || busy}
          rows={2}
        />
        <button
          className="desktop-btn desktop-btn-primary"
          onClick={() => void send()}
          disabled={!started || busy || !input.trim()}
        >
          Send
        </button>
      </footer>
    </div>
  );
}
