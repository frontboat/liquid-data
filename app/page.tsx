"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  SPEC_DATA_PART,
  SPEC_DATA_PART_TYPE,
  type SpecDataPart,
} from "@json-render/core";
import { useJsonRenderMessage } from "@json-render/react";
import { ExplorerRenderer } from "@/lib/render/renderer";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Loader2,
  LogOut,
  Sparkles,
  Upload,
  Database,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// =============================================================================
// Types
// =============================================================================

type AppDataParts = { [SPEC_DATA_PART]: SpecDataPart };
type AppMessage = UIMessage<unknown, AppDataParts>;

interface DatasetInfo {
  filename: string;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
  sampleRows: Array<Record<string, unknown>>;
}

// =============================================================================
// Transport
// =============================================================================

const transport = new DefaultChatTransport({ api: "/api/generate" });

// =============================================================================
// Tool Call Display
// =============================================================================

const TOOL_LABELS: Record<string, [string, string]> = {
  queryData: ["Querying data", "Queried data"],
  getSchema: ["Examining schema", "Examined schema"],
};

function ToolCallDisplay({
  toolName,
  state,
  result,
}: {
  toolName: string;
  state: string;
  result: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLoading = state !== "output-available" && state !== "output-error" && state !== "output-denied";
  const labels = TOOL_LABELS[toolName];
  const label = labels ? (isLoading ? labels[0] : labels[1]) : toolName;

  return (
    <div className="text-sm group">
      <button type="button" className="flex items-center gap-1.5" onClick={() => setExpanded((e) => !e)}>
        <span className={`text-muted-foreground ${isLoading ? "animate-shimmer" : ""}`}>{label}</span>
        {!isLoading && (
          <ChevronRight className={`h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground transition-all ${expanded ? "rotate-90" : ""}`} />
        )}
      </button>
      {expanded && !isLoading && result != null && (
        <div className="mt-1 max-h-64 overflow-auto">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
            {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Message Bubble
// =============================================================================

function MessageBubble({
  message,
  isLast,
  isStreaming,
}: {
  message: AppMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";
  const { spec, text, hasSpec } = useJsonRenderMessage(message.parts);

  const segments: Array<
    | { kind: "text"; text: string }
    | { kind: "tools"; tools: Array<{ toolCallId: string; toolName: string; state: string; output?: unknown }> }
    | { kind: "spec" }
  > = [];

  let specInserted = false;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (!part.text.trim()) continue;
      const last = segments[segments.length - 1];
      if (last?.kind === "text") last.text += part.text;
      else segments.push({ kind: "text", text: part.text });
    } else if (part.type.startsWith("tool-")) {
      const tp = part as { type: string; toolCallId: string; state: string; output?: unknown };
      const last = segments[segments.length - 1];
      if (last?.kind === "tools") {
        last.tools.push({ toolCallId: tp.toolCallId, toolName: tp.type.replace(/^tool-/, ""), state: tp.state, output: tp.output });
      } else {
        segments.push({ kind: "tools", tools: [{ toolCallId: tp.toolCallId, toolName: tp.type.replace(/^tool-/, ""), state: tp.state, output: tp.output }] });
      }
    } else if (part.type === SPEC_DATA_PART_TYPE && !specInserted) {
      segments.push({ kind: "spec" });
      specInserted = true;
    }
  }

  const hasAnything = segments.length > 0 || hasSpec;
  const showLoader = isLast && isStreaming && message.role === "assistant" && !hasAnything;

  if (isUser) {
    return (
      <div className="flex justify-end">
        {text && (
          <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-primary text-primary-foreground rounded-tr-md">
            {text}
          </div>
        )}
      </div>
    );
  }

  const showSpecAtEnd = hasSpec && !specInserted;

  return (
    <div className="w-full flex flex-col gap-3">
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          const isLastSegment = i === segments.length - 1;
          return (
            <div key={`text-${i}`} className="text-sm leading-relaxed [&_p+p]:mt-3">
              <Streamdown plugins={{ code }} animated={isLast && isStreaming && isLastSegment}>{seg.text}</Streamdown>
            </div>
          );
        }
        if (seg.kind === "spec") {
          if (!hasSpec) return null;
          return <div key="spec" className="w-full"><ExplorerRenderer spec={spec} loading={isLast && isStreaming} /></div>;
        }
        return (
          <div key={`tools-${i}`} className="flex flex-col gap-1">
            {seg.tools.map((t) => <ToolCallDisplay key={t.toolCallId} toolName={t.toolName} state={t.state} result={t.output} />)}
          </div>
        );
      })}
      {showLoader && <div className="text-sm text-muted-foreground animate-shimmer">Thinking...</div>}
      {showSpecAtEnd && <div className="w-full"><ExplorerRenderer spec={spec} loading={isLast && isStreaming} /></div>}
    </div>
  );
}

// =============================================================================
// Upload Zone
// =============================================================================

function UploadZone({ onUpload }: { onUpload: (info: DatasetInfo) => void }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(csv|tsv|json|parquet|xlsx)$/i)) {
      setError("Please upload a CSV, JSON, Parquet, or Excel file");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (res.status === 401) { window.location.href = "/login"; return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      onUpload({
        filename: data.filename,
        rowCount: data.rowCount,
        columns: data.columns,
        sampleRows: data.sampleRows,
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setUploading(false);
    }
  }, [onUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-xl w-full space-y-6">
        <div className="text-center space-y-2">
          <Database className="h-12 w-12 mx-auto text-muted-foreground" />
          <h2 className="text-2xl font-semibold tracking-tight">Liquid Data</h2>
        </div>

        <div
          className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center transition-colors cursor-pointer ${
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading data...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Drop a file here, or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">Supports CSV, TSV, JSON, Parquet, and Excel files</p>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.json,.parquet,.xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Suggestions
// =============================================================================

const SUGGESTIONS = [
  { label: "Overview", prompt: "Give me an overview of this dataset — key stats, distributions, and any interesting patterns" },
  { label: "Top values", prompt: "What are the top 10 most common values in each column?" },
  { label: "Summary stats", prompt: "Show me summary statistics (min, max, mean, median) for all numeric columns" },
  { label: "Correlations", prompt: "Are there any interesting correlations or relationships between columns?" },
];

// =============================================================================
// Page
// =============================================================================

export default function DataExplorerPage() {
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, setMessages, status, error } = useChat<AppMessage>({ transport });
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const THRESHOLD = 80;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollTop + clientHeight >= scrollHeight - THRESHOLD;
      if (isAutoScrolling.current) { if (atBottom) isAutoScrolling.current = false; return; }
      isStickToBottom.current = atBottom;
      setShowScrollButton(!atBottom);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isStickToBottom.current) return;
    isAutoScrolling.current = true;
    container.scrollTop = container.scrollHeight;
    requestAnimationFrame(() => { isAutoScrolling.current = false; });
  }, [messages, isStreaming]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isStickToBottom.current = true;
    setShowScrollButton(false);
    isAutoScrolling.current = true;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, []);

  const handleSubmit = useCallback(async (text?: string) => {
    const message = text || input;
    if (!message.trim() || isStreaming) return;
    setInput("");
    await sendMessage({ text: message.trim() });
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }, [handleSubmit]);

  const handleReset = useCallback(() => {
    setDataset(null);
    setMessages([]);
    setInput("");
  }, [setMessages]);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }, []);

  if (!dataset) {
    return (
      <div className="h-dvh flex flex-col overflow-hidden">
        <header className="border-b px-6 py-3 flex items-center justify-between flex-shrink-0">
          <h1 className="text-lg font-semibold">Liquid Data</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
            <ThemeToggle />
          </div>
        </header>
        <UploadZone onUpload={setDataset} />
      </div>
    );
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Liquid Data</h1>
          <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>{dataset.filename}</span>
            <span>·</span>
            <span>{dataset.rowCount.toLocaleString()} rows</span>
            <span>·</span>
            <span>{dataset.columns.length} columns</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center gap-1.5"
          >
            <X className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New Dataset</span>
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center gap-1.5"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Logout</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* Messages area */}
      <main ref={scrollContainerRef} className="flex-1 overflow-auto">
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center px-6 py-12">
            <div className="max-w-2xl w-full space-y-8">
              <div className="text-center space-y-2">
                <h2 className="text-2xl font-semibold tracking-tight">What would you like to know?</h2>
                <p className="text-muted-foreground">
                  Ask questions about <strong>{dataset.filename}</strong> — the AI will query your data and build interactive visualizations.
                </p>
              </div>

              {/* Column pills */}
              <div className="flex flex-wrap gap-1.5 justify-center">
                {dataset.columns.map((col) => (
                  <span key={col.name} className="inline-flex items-center px-2 py-0.5 rounded-md bg-muted text-xs text-muted-foreground">
                    {col.name} <span className="ml-1 opacity-50">{col.type}</span>
                  </span>
                ))}
              </div>

              {/* Suggestions */}
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => handleSubmit(s.prompt)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Sparkles className="h-3 w-3" />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto px-4 sm:px-10 py-6 space-y-6">
            {messages.map((message, index) => (
              <MessageBubble key={message.id} message={message} isLast={index === messages.length - 1} isStreaming={isStreaming} />
            ))}
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error.message}</div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input bar */}
      <div className="px-6 pb-3 flex-shrink-0 bg-background relative">
        {showScrollButton && !isEmpty && (
          <button onClick={scrollToBottom} className="absolute left-1/2 -translate-x-1/2 -top-10 z-10 h-8 w-8 rounded-full border border-border bg-background text-muted-foreground shadow-md flex items-center justify-center hover:text-foreground hover:bg-accent transition-colors" aria-label="Scroll to bottom">
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        <div className="max-w-4xl mx-auto relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isEmpty ? "e.g., Show me the distribution of values in the first column..." : "Ask a follow-up..."}
            rows={2}
            className="w-full resize-none rounded-xl border border-input bg-card px-4 py-3 pr-12 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            autoFocus
          />
          <button
            onClick={() => handleSubmit()}
            disabled={!input.trim() || isStreaming}
            className="absolute right-3 bottom-3 h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
