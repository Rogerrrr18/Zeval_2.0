/**
 * @fileoverview Eval Chat console.
 *
 * Single-pane chat:
 *  - Top: transcript (user / agent / plan / tool / result / final cards)
 *  - Bottom: input + sample-data button + scenario picker
 *  - Streams events from /api/copilot/chat (SSE)
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/shell";
import styles from "./copilotConsole.module.css";

type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "plan"; plan: string[] }
  | { kind: "tool_call"; tool: string; args: unknown; iteration: number }
  | {
      kind: "tool_result";
      tool: string;
      ok: boolean;
      summary: string;
      data?: unknown;
      iteration: number;
    }
  | {
      kind: "final";
      message: string;
      next_actions?: Array<{ label: string; skill?: string; args?: unknown }>;
    }
  | { kind: "error"; message: string };

type ChatChannel = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
  inputDraft: string;
  scenarioId: string;
  attachedRows: unknown[] | null;
  attachedFileName: string | null;
};

type ChatViewMode = "producer" | "engineer";

const CHAT_STORAGE_KEY = "zeval.chat.channels.v1";
const CHAT_ACTIVE_STORAGE_KEY = "zeval.chat.activeChannel.v1";
const CHAT_VIEW_MODE_STORAGE_KEY = "zeval.chat.viewMode.v1";
const LEGACY_CHAT_STORAGE_KEY = "zerore.chat.channels.v1";
const LEGACY_CHAT_ACTIVE_STORAGE_KEY = "zerore.chat.activeChannel.v1";
const DEFAULT_CHANNEL_TITLE = "New channel";
const EMPTY_TURNS: ChatTurn[] = [];
const SAMPLE_PROMPT_BUILT_IN =
  "我有一份客服对话日志，请帮我跑评估，告诉我哪里需要优化。";

/**
 * Render the Eval Chat console.
 *
 * @returns The console element.
 */
export function CopilotConsole() {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState("");
  const [viewMode, setViewMode] = useState<ChatViewMode>("producer");
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? channels[0] ?? null;
  const turns = activeChannel?.turns ?? EMPTY_TURNS;
  const input = activeChannel?.inputDraft ?? "";
  const scenarioId = activeChannel?.scenarioId ?? "toB-customer-support";
  const attachedRows = activeChannel?.attachedRows ?? null;
  const attachedFileName = activeChannel?.attachedFileName ?? null;
  const visibleTurns = filterTurnsForViewMode(turns, viewMode);

  // Load saved channels once on mount.
  useEffect(() => {
    const storedChannels = readStoredChannels();
    const nextChannels = storedChannels.length > 0 ? storedChannels : [createChatChannel()];
    const storedActiveId =
      window.localStorage.getItem(CHAT_ACTIVE_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_CHAT_ACTIVE_STORAGE_KEY);
    const nextActiveId = nextChannels.some((channel) => channel.id === storedActiveId)
      ? storedActiveId ?? nextChannels[0].id
      : nextChannels[0].id;
    const storedViewMode = window.localStorage.getItem(CHAT_VIEW_MODE_STORAGE_KEY);
    setChannels(nextChannels);
    setActiveChannelId(nextActiveId);
    setViewMode(storedViewMode === "engineer" ? "engineer" : "producer");
    setHydrated(true);
  }, []);

  // Auto-save chat history and active channel.
  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(channels));
    window.localStorage.setItem(CHAT_ACTIVE_STORAGE_KEY, activeChannelId);
  }, [activeChannelId, channels, hydrated]);

  // Persist the transcript verbosity mode.
  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(CHAT_VIEW_MODE_STORAGE_KEY, viewMode);
  }, [hydrated, viewMode]);

  // Auto-scroll on new turn.
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  /**
   * Patch a channel and refresh its updated timestamp.
   * @param channelId Target channel id.
   * @param patcher Channel patch callback.
   */
  const patchChannel = useCallback((channelId: string, patcher: (channel: ChatChannel) => ChatChannel) => {
    setChannels((prev) =>
      prev.map((channel) =>
        channel.id === channelId
          ? { ...patcher(channel), updatedAt: new Date().toISOString() }
          : channel,
      ),
    );
  }, []);

  /**
   * Append one streamed turn to a channel.
   * @param channelId Target channel id.
   * @param turn Turn to append.
   */
  const appendTurn = useCallback(
    (channelId: string, turn: ChatTurn) => {
      patchChannel(channelId, (channel) => ({ ...channel, turns: [...channel.turns, turn] }));
    },
    [patchChannel],
  );

  /**
   * Create and select a new chat channel.
   */
  const createChannel = useCallback(() => {
    const channel = createChatChannel();
    setChannels((prev) => [channel, ...prev]);
    setActiveChannelId(channel.id);
  }, []);

  /**
   * Delete a channel while keeping at least one channel available.
   * @param channelId Channel id to delete.
   */
  const deleteChannel = useCallback(
    (channelId: string) => {
      setChannels((prev) => {
        if (prev.length <= 1) {
          const replacement = createChatChannel();
          setActiveChannelId(replacement.id);
          return [replacement];
        }
        const remaining = prev.filter((channel) => channel.id !== channelId);
        if (channelId === activeChannelId) {
          setActiveChannelId(remaining[0].id);
        }
        return remaining;
      });
    },
    [activeChannelId],
  );

  /**
   * Update the current channel input draft.
   * @param value Input value.
   */
  const updateInput = useCallback(
    (value: string) => {
      if (!activeChannel) return;
      patchChannel(activeChannel.id, (channel) => ({ ...channel, inputDraft: value }));
    },
    [activeChannel, patchChannel],
  );

  /**
   * Submit one user turn to Chat.
   */
  const send = useCallback(
    async (textOverride?: string, presetRows?: unknown[]) => {
      const text = (textOverride ?? input).trim();
      if (!text || running || !activeChannel) return;
      const channelId = activeChannel.id;
      const userTurn: ChatTurn = { kind: "user", text };
      const nextTurns = [...turns, userTurn];
      const rows = presetRows ?? activeChannel.attachedRows ?? undefined;
      patchChannel(channelId, (channel) => ({
        ...channel,
        title: channel.title === DEFAULT_CHANNEL_TITLE ? buildChannelTitle(text) : channel.title,
        turns: nextTurns,
        inputDraft: "",
        attachedRows: rows ?? channel.attachedRows,
      }));
      setRunning(true);

      try {
        const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
        for (const t of nextTurns) {
          if (t.kind === "user") {
            messages.push({ role: "user", content: t.text });
          } else if (t.kind === "final") {
            messages.push({ role: "assistant", content: t.message });
          }
        }

        const res = await fetch("/api/copilot/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages,
            attachments: rows
              ? {
                  rawRows: rows,
                  scenarioId: activeChannel.scenarioId,
                  sourceFileName: activeChannel.attachedFileName ?? undefined,
                }
              : { scenarioId: activeChannel.scenarioId },
          }),
        });

        if (!res.ok || !res.body) {
          const err = await res.text().catch(() => "");
          appendTurn(channelId, { kind: "error", message: `请求失败 (${res.status}) ${err.slice(0, 200)}` });
          return;
        }

        // SSE consumer
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const ln of lines) {
            if (!ln.startsWith("data: ")) continue;
            const payload = ln.slice(6);
            if (payload === "[DONE]") break;
            try {
              const event = JSON.parse(payload);
              appendTurn(channelId, mapEventToTurn(event));
            } catch {
              /* ignore malformed line */
            }
          }
        }
      } catch (e) {
        appendTurn(channelId, { kind: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        setRunning(false);
      }
    },
    [activeChannel, appendTurn, input, patchChannel, running, turns],
  );

  /**
   * Load the bundled e-commerce sample as attached rows.
   */
  const loadBuiltInSample = useCallback(async (): Promise<unknown[] | null> => {
    try {
      const res = await fetch("/sample-data/ecommerce-angry-escalation.csv");
      if (!res.ok) throw new Error("示例文件未找到");
      const text = await res.text();
      const rows = parseCsvToRawRows(text);
      if (activeChannel) {
        patchChannel(activeChannel.id, (channel) => ({
          ...channel,
          attachedRows: rows,
          attachedFileName: "ecommerce-angry-escalation.csv",
        }));
      }
      return rows;
    } catch (e) {
      if (activeChannel) {
        appendTurn(activeChannel.id, { kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return null;
    }
  }, [activeChannel, appendTurn, patchChannel]);

  /**
   * Handle a user file upload (CSV/JSON).
   */
  const onFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const rows = f.name.endsWith(".json") || f.name.endsWith(".jsonl")
        ? parseJsonlToRawRows(text)
        : parseCsvToRawRows(text);
      if (activeChannel) {
        patchChannel(activeChannel.id, (channel) => ({
          ...channel,
          attachedRows: rows,
          attachedFileName: f.name,
        }));
      }
    } catch (err) {
      if (activeChannel) {
        appendTurn(activeChannel.id, {
          kind: "error",
          message: `文件解析失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }, [activeChannel, appendTurn, patchChannel]);

  /**
   * Trigger a one-tap "next action" button from a final turn.
   */
  const triggerNextAction = useCallback(
    (action: { label: string; skill?: string; args?: unknown }) => {
      const text = action.skill
        ? `请执行 ${action.skill}${action.args ? ` (args=${JSON.stringify(action.args)})` : ""}`
        : action.label;
      void send(text);
    },
    [send],
  );

  if (!hydrated || !activeChannel) {
    return (
      <AppShell>
        <div className={styles.loadingShell}>Loading Chat...</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className={styles.layout}>
        <aside className={styles.channelRail} aria-label="chat channels">
          <div className={styles.channelHeader}>
            <div>
              <p className={styles.channelEyebrow}>Chat</p>
              <h1 className={styles.channelTitle}>Channels</h1>
            </div>
            <button className={styles.newChannelBtn} onClick={createChannel} title="New channel">
              +
            </button>
          </div>
          <div className={styles.channelList}>
            {channels.map((channel) => {
              const active = channel.id === activeChannel.id;
              return (
                <div
                  key={channel.id}
                  role="button"
                  tabIndex={0}
                  className={`${styles.channelItem} ${active ? styles.channelItemActive : ""}`}
                  onClick={() => setActiveChannelId(channel.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setActiveChannelId(channel.id);
                    }
                  }}
                >
                  <span className={styles.channelItemTitle}>{channel.title}</span>
                  <span className={styles.channelItemMeta}>
                    {channel.turns.length} turns · {formatChannelTime(channel.updatedAt)}
                  </span>
                  <button
                    type="button"
                    className={styles.channelDelete}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteChannel(channel.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteChannel(channel.id);
                      }
                    }}
                    aria-label={`Delete ${channel.title}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <div className={styles.chatPanel}>
          <header className={styles.header}>
            <div>
              <p className={styles.headerKicker}>Zeval Chat</p>
              <h2 className={styles.title}>{activeChannel.title}</h2>
              <p className={styles.sub}>
                {turns.length} turns · {attachedFileName ? `attached ${attachedRows?.length ?? 0} rows` : "no attachment"}
              </p>
            </div>
            <div className={styles.modeToggle} aria-label="chat view mode">
              <button
                type="button"
                className={viewMode === "producer" ? styles.modeActive : ""}
                onClick={() => setViewMode("producer")}
              >
                Producer
              </button>
              <button
                type="button"
                className={viewMode === "engineer" ? styles.modeActive : ""}
                onClick={() => setViewMode("engineer")}
              >
                Engineer
              </button>
            </div>
          </header>

          <section className={styles.transcript} ref={transcriptRef}>
            {turns.length === 0 ? (
              <div className={styles.welcome}>
                <strong>开始一个 channel</strong>
                <p>问产品、跑评估、沉淀调优包都可以在这里继续。</p>
                <div className={styles.suggest}>
                  <button onClick={() => void send("你好，你能做什么？")}>
                    你好，你能做什么？
                  </button>
                  <button onClick={() => void send("帮我看下这周客服 agent 的表现")}>
                    帮我看下这周客服 agent 的表现
                  </button>
                  <button
                    onClick={() => {
                      void loadBuiltInSample().then((rows) => {
                        if (rows) {
                          void send(SAMPLE_PROMPT_BUILT_IN, rows);
                        }
                      });
                    }}
                  >
                    一键 Demo（加载示例日志并跑评估）
                  </button>
                </div>
              </div>
            ) : null}

            {visibleTurns.map((t, i) => (
              <TurnView key={`${activeChannel.id}-${i}`} turn={t} viewMode={viewMode} onAction={triggerNextAction} />
            ))}

            {running ? <LoadingDot /> : null}
          </section>

          <footer className={styles.composer}>
            <div className={styles.composerMeta}>
              <label className={styles.scenarioLabel}>
                场景：
                <select
                  className={styles.scenarioSelect}
                  value={scenarioId}
                  onChange={(event) => {
                    patchChannel(activeChannel.id, (channel) => ({
                      ...channel,
                      scenarioId: event.target.value,
                    }));
                  }}
                >
                  <option value="toB-customer-support">ToB 客服</option>
                  <option value="">通用</option>
                </select>
              </label>
              <label className={styles.attachLabel}>
                <input
                  type="file"
                  accept=".csv,.json,.jsonl"
                  onChange={onFile}
                  className={styles.attachInput}
                />
                附加日志
              </label>
              {attachedFileName ? (
                <span className={styles.attached}>
                  已附加：{attachedFileName}（{attachedRows?.length ?? 0} 行）
                  <button
                    className={styles.attachedClear}
                    onClick={() => {
                      patchChannel(activeChannel.id, (channel) => ({
                        ...channel,
                        attachedRows: null,
                        attachedFileName: null,
                      }));
                    }}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <button className={styles.sampleBtn} onClick={() => void loadBuiltInSample()}>
                  使用内置示例日志
                </button>
              )}
            </div>
            <div className={styles.composerRow}>
              <textarea
                className={styles.input}
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                placeholder="例如：跑评估并告诉我 top 3 风险"
                rows={2}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                disabled={running}
              />
              <button
                className={styles.sendBtn}
                disabled={!input.trim() || running}
                onClick={() => void send()}
              >
                {running ? "运行中..." : "发送"}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </AppShell>
  );
}

// ---- Helpers ----

/**
 * Create a new empty chat channel.
 * @returns New channel state.
 */
function createChatChannel(): ChatChannel {
  const now = new Date().toISOString();
  return {
    id: `channel_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    title: DEFAULT_CHANNEL_TITLE,
    createdAt: now,
    updatedAt: now,
    turns: [],
    inputDraft: "",
    scenarioId: "toB-customer-support",
    attachedRows: null,
    attachedFileName: null,
  };
}

/**
 * Read saved chat channels from localStorage.
 * @returns Valid stored channels.
 */
function readStoredChannels(): ChatChannel[] {
  try {
    const raw =
      window.localStorage.getItem(CHAT_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const channel = item as Partial<ChatChannel>;
      if (typeof channel.id !== "string" || !Array.isArray(channel.turns)) {
        return [];
      }
      return [
        {
          id: channel.id,
          title: typeof channel.title === "string" && channel.title.trim() ? channel.title : DEFAULT_CHANNEL_TITLE,
          createdAt: typeof channel.createdAt === "string" ? channel.createdAt : new Date().toISOString(),
          updatedAt: typeof channel.updatedAt === "string" ? channel.updatedAt : new Date().toISOString(),
          turns: channel.turns,
          inputDraft: typeof channel.inputDraft === "string" ? channel.inputDraft : "",
          scenarioId: typeof channel.scenarioId === "string" ? channel.scenarioId : "toB-customer-support",
          attachedRows: Array.isArray(channel.attachedRows) ? channel.attachedRows : null,
          attachedFileName: typeof channel.attachedFileName === "string" ? channel.attachedFileName : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Build a compact channel title from the first user message.
 * @param text User message.
 * @returns Channel title.
 */
function buildChannelTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 20 ? `${normalized.slice(0, 20)}...` : normalized || DEFAULT_CHANNEL_TITLE;
}

/**
 * Format a channel updated timestamp for compact display.
 * @param value ISO timestamp.
 * @returns Display time.
 */
function formatChannelTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Convert one server-sent event into a chat turn (1:1 mapping).
 *
 * @param event Server event.
 * @returns Chat turn.
 */
function mapEventToTurn(event: { type: string } & Record<string, unknown>): ChatTurn {
  switch (event.type) {
    case "plan":
      return { kind: "plan", plan: (event.plan as string[]) ?? [] };
    case "tool_call":
      return {
        kind: "tool_call",
        tool: String(event.tool ?? ""),
        args: event.args,
        iteration: Number(event.iteration ?? 0),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        tool: String(event.tool ?? ""),
        ok: Boolean(event.ok),
        summary: String(event.summary ?? ""),
        data: event.data,
        iteration: Number(event.iteration ?? 0),
      };
    case "final":
      return {
        kind: "final",
        message: String(event.message ?? ""),
        next_actions: Array.isArray(event.next_actions)
          ? (event.next_actions as Array<{ label: string; skill?: string; args?: unknown }>)
          : undefined,
      };
    case "error":
    default:
      return { kind: "error", message: String(event.message ?? "未知错误") };
  }
}

/**
 * Filter transcript events for the selected product/engineering view.
 *
 * @param turns Full stored transcript.
 * @param viewMode Current view mode.
 * @returns Turns visible in the transcript.
 */
function filterTurnsForViewMode(turns: ChatTurn[], viewMode: ChatViewMode): ChatTurn[] {
  if (viewMode === "engineer") {
    return turns;
  }
  return turns.filter((turn) => turn.kind === "user" || turn.kind === "final" || turn.kind === "plan" || turn.kind === "error");
}

/**
 * Render a single chat turn.
 *
 * @param props Turn props.
 * @returns The turn element.
 */
function TurnView(props: {
  turn: ChatTurn;
  viewMode: ChatViewMode;
  onAction: (a: { label: string; skill?: string; args?: unknown }) => void;
}) {
  const { turn, viewMode, onAction } = props;
  switch (turn.kind) {
    case "user":
      return (
        <div className={`${styles.bubble} ${styles.bubbleUser}`}>
          <div className={styles.bubbleRole}>你</div>
          <div className={styles.bubbleBody}>{turn.text}</div>
        </div>
      );
    case "plan":
      if (viewMode === "producer") {
        return (
          <div className={styles.compactPlan}>
            <span className={styles.compactPlanDot} />
            正在分析评估结果…
          </div>
        );
      }
      return (
        <div className={`${styles.bubble} ${styles.bubbleAgent}`}>
          <div className={styles.bubbleRole}>Chat · 计划</div>
          <ol className={styles.planList}>
            {turn.plan.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </div>
      );
    case "tool_call":
      return (
        <div className={styles.toolCall}>
          <span className={styles.toolBadge}>调用</span>
          <code>{turn.tool}</code>
          <span className={styles.toolIter}>iter {turn.iteration}</span>
        </div>
      );
    case "tool_result":
      return (
        <div className={`${styles.toolResult} ${turn.ok ? styles.toolOk : styles.toolFail}`}>
          <span className={styles.toolBadge}>{turn.ok ? "✓" : "✗"}</span>
          <code>{turn.tool}</code>
          <span className={styles.toolSummary}>{turn.summary}</span>
        </div>
      );
    case "final":
      return (
        <div className={`${styles.bubble} ${styles.bubbleAgent}`}>
          <div className={styles.bubbleRole}>Chat</div>
          <div className={styles.bubbleBody}>{turn.message}</div>
          {turn.next_actions && turn.next_actions.length > 0 ? (
            <div className={styles.nextActions}>
              {turn.next_actions.map((a, i) => (
                <button key={i} onClick={() => onAction(a)}>
                  {a.label} →
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
    case "error":
      return <div className={styles.errorRow}>⚠ {turn.message}</div>;
  }
}

/**
 * Animated three-dot loader.
 *
 * @returns Loader element.
 */
function LoadingDot() {
  return (
    <div className={styles.loader} aria-label="思考中">
      <span /> <span /> <span />
    </div>
  );
}

/**
 * Naive CSV → rawRows parser. Expects header row with sessionId/timestamp/role/content.
 *
 * @param text CSV text.
 * @returns RawRow array.
 */
function parseCsvToRawRows(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = cols[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Split a CSV line, supporting quoted fields with commas inside.
 *
 * @param line One CSV line.
 * @returns Field array.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
    } else if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse JSON or JSONL into raw rows.
 *
 * @param text JSON / JSONL text.
 * @returns Array of objects.
 */
function parseJsonlToRawRows(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray((parsed as { rawRows?: unknown[] }).rawRows)) {
      return (parsed as { rawRows: unknown[] }).rawRows;
    }
    return [];
  }
  return trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}
