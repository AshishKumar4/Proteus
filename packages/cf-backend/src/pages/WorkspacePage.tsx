import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  Send, Square, Wrench, Sparkles, ChevronDown, ChevronRight, Search,
  ExternalLink, Fingerprint, Package, Database, TreePine, Clock, Loader2,
  WifiOff, RefreshCw, Brain, FolderOpen, GitBranch, CheckCircle2,
  Terminal, Wifi, WifiOff as WifiOffIcon, Trash2, MessageSquare, Copy,
} from "lucide-react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { useProteus, type AgentStatus, type EvolutionEventRow, type LogEntry } from "@/hooks/use-proteus";
import { registerAgent } from "@/lib/agent-registry";
import { MCTSTree } from "@/components/mcts-tree";
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea";
import { ScoreBar } from "@/components/ui/score-bar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { MCTSNode } from "@/lib/protocol";


const TABS = ["Identity", "Tools", "Memory", "MCTS Tree", "Evolution", "Logs"] as const;
type Tab = (typeof TABS)[number];

const MODELS = [
  { id: "@cf/moonshotai/kimi-k2.5", label: "Kimi K2.5 (reasoning)" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (fast)" },
  { id: "@cf/meta/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
];

// ── Code block with copy button ──────────────────────────────────

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";

  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1 rounded-t-lg bg-[oklch(0.14_0.005_285)] border border-b-0 border-white/5 text-[10px] text-muted-foreground/50">
        <span>{lang || "code"}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="rounded-b-lg bg-[oklch(0.12_0.005_285)] border border-t-0 border-white/5 p-3 overflow-x-auto text-xs font-mono text-foreground/80">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return <code className="bg-muted/50 px-1.5 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
          }
          return <CodeBlock className={className}>{children}</CodeBlock>;
        },
        a({ href, children }) {
          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{children}</a>;
        },
        table({ children }) {
          return <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>;
        },
        th({ children }) {
          return <th className="border border-white/10 px-2 py-1 text-left font-medium bg-muted/30">{children}</th>;
        },
        td({ children }) {
          return <td className="border border-white/10 px-2 py-1">{children}</td>;
        },
        pre({ children }) {
          return <>{children}</>;
        },
      }}
    >
      {content}
    </Markdown>
  );
}

// ── Message rendering (uses raw UIMessage directly) ──────────────

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter(p => p.type === "text")
    .map(p => (p as { type: "text"; text: string }).text)
    .join("");
}

function MessageView({ message, isLast, isStreaming }: {
  message: UIMessage; isLast: boolean; isStreaming: boolean;
}) {
  const isUser = message.role === "user";
  const isLive = isLast && isStreaming && !isUser;

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[80%] rounded-xl bg-primary/15 border border-primary/20 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {getMessageText(message)}
        </div>
      </div>
    );
  }

  // Assistant — render parts chronologically
  const hasContent = message.parts.some(p =>
    (p.type === "text" && (p as { text: string }).text) ||
    (p.type === "reasoning" && (p as { text?: string }).text) ||
    isToolUIPart(p)
  );

  if (isLive && !hasContent) {
    return (
      <div className="flex items-center gap-2 animate-fade-in py-1">
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
        </div>
        <span className="text-xs text-muted-foreground">Thinking...</span>
      </div>
    );
  }

  return (
    <div className="space-y-1 animate-fade-in">
      {message.parts.map((part, i) => {
        // Reasoning / thinking
        if (part.type === "reasoning") {
          const text = (part as { text?: string }).text;
          if (!text) return null;
          return (
            <ReasoningBlock key={i} text={text} />
          );
        }

        // Text — render as markdown
        if (part.type === "text") {
          const text = (part as { text: string }).text;
          if (!text) return null;
          const isLastText = message.parts.slice(i + 1).every(p => p.type !== "text");
          return (
            <div key={i} className="prose-chat text-foreground/90">
              <MarkdownContent content={text} />
              {isLive && isLastText && (
                <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 -mb-0.5 rounded-sm" />
              )}
            </div>
          );
        }

        // Tool call
        if (isToolUIPart(part)) {
          const toolName = getToolName(part);
          const toolInput = part.input as Record<string, unknown> | undefined;
          const isRunning = part.state === "input-available" || part.state === "input-streaming";
          const isDone = part.state === "output-available";
          const isError = part.state === "output-error";
          return (
            <ToolCallBlock
              key={part.toolCallId}
              toolName={toolName}
              input={toolInput}
              output={isDone ? (part as { output?: unknown }).output : undefined}
              isRunning={isRunning}
              isError={isError}
            />
          );
        }

        return null;
      })}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
  return (
    <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 px-3 py-2 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-purple-400 w-full text-left"
      >
        <Brain className="h-3 w-3 shrink-0" />
        <span className="font-medium">Thinking</span>
        {expanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      <div className={cn("mt-1 text-xs text-purple-300/70 whitespace-pre-wrap", !expanded && "line-clamp-2")}>
        {expanded ? text : preview}
      </div>
    </div>
  );
}

function ToolCallBlock({ toolName, input, output, isRunning, isError }: {
  toolName: string; input?: Record<string, unknown>; output?: unknown;
  isRunning: boolean; isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
        {isRunning ? (
          <Loader2 className="h-3 w-3 text-amber-400 animate-spin" />
        ) : isError ? (
          <Wrench className="h-3 w-3 text-red-400" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        )}
        <span className="font-mono">{toolName}</span>
        {isRunning && <span className="text-amber-400/70">running...</span>}
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-1 animate-scale-in">
          {input != null && (
            <pre className="rounded-lg bg-muted/50 border border-white/5 p-2.5 text-xs font-mono text-muted-foreground max-h-32 overflow-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          {output != null && (
            <pre className="rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-2.5 text-xs font-mono text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
              {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sidebar components ────────────────────────────────────────────

const EVOLUTION_COLORS: Record<string, string> = {
  craft_discovered: "bg-emerald-400",
  mcts_complete: "bg-emerald-400",
  reflection: "bg-blue-400",
  consolidation: "bg-amber-400",
  scaffold_proposed: "bg-purple-400",
  mcts_started: "bg-gray-400",
};
const EVOLUTION_ICONS: Record<string, string> = {
  craft_discovered: "🔧", mcts_complete: "✓", reflection: "💡",
  consolidation: "🧹", scaffold_proposed: "🧬", mcts_started: "🔍",
};

function EvolutionItem({ event }: { event: EvolutionEventRow }) {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="flex flex-col items-center">
        <div className={cn("h-2 w-2 rounded-full mt-1.5", EVOLUTION_COLORS[event.type] ?? "bg-muted-foreground")} />
        <div className="flex-1 w-px bg-white/10" />
      </div>
      <div className="pb-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-0.5">
          <span>{EVOLUTION_ICONS[event.type] ?? "•"}</span>
          <span className="font-mono">{new Date(event.created_at).toLocaleTimeString()}</span>
          <span className="text-muted-foreground/50">{event.type}</span>
        </div>
        <p className="text-sm text-foreground/80">{event.message}</p>
      </div>
    </div>
  );
}

function EmptyTabState({ icon: Icon, text }: { icon: typeof Brain; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/30 mb-3" />
      <p className="text-sm text-muted-foreground/50">{text}</p>
    </div>
  );
}

// ── MCTS Tree tab with node detail panel ──────────────────────────

function MCTSTreeTab({ mctsTree }: { mctsTree: MCTSNode | null }) {
  const [selectedNode, setSelectedNode] = useState<MCTSNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 400 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) });
    return () => ro.disconnect();
  }, [selectedNode]);

  if (!mctsTree) return <EmptyTabState icon={GitBranch} text="No exploration history — use the explore tool or run evolution" />;

  function countNodes(n: MCTSNode): number { return 1 + n.children.reduce((s, c) => s + countNodes(c), 0); }
  function maxDepth(n: MCTSNode): number { return n.children.length === 0 ? n.depth : Math.max(...n.children.map(maxDepth)); }
  const total = countNodes(mctsTree);
  const depth = maxDepth(mctsTree);

  return (
    <div ref={containerRef} className="animate-fade-in h-full flex flex-col">
      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-2 text-xs text-muted-foreground">
        <span>Nodes: <span className="text-foreground font-mono">{total}</span></span>
        <span>Depth: <span className="text-foreground font-mono">{depth}</span></span>
        <span>Root score: <span className="text-foreground font-mono">{mctsTree.value.toFixed(3)}</span></span>
      </div>

      {/* Tree visualization */}
      <div className="flex-1 min-h-0">
        {dims.w > 0 && (
          <MCTSTree root={mctsTree} width={dims.w} height={dims.h} onNodeClick={setSelectedNode} selectedNode={selectedNode} />
        )}
      </div>

      {/* Selected node detail panel */}
      {selectedNode && (
        <div className="border-t border-white/5 pt-3 mt-2 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-foreground">Node Details</span>
            <button onClick={() => setSelectedNode(null)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Action</span>
            <span className="text-foreground">{selectedNode.action || "(root)"}</span>
            <span className="text-muted-foreground">Value</span>
            <span className="text-foreground font-mono">{selectedNode.value.toFixed(4)}</span>
            <span className="text-muted-foreground">Visits</span>
            <span className="text-foreground font-mono">{selectedNode.visits}</span>
            <span className="text-muted-foreground">Status</span>
            <span className={cn(
              "font-medium",
              selectedNode.status === "terminal" ? "text-emerald-400" :
              selectedNode.status === "pruned" ? "text-zinc-500" :
              selectedNode.status === "failed" ? "text-red-400" :
              "text-foreground",
            )}>{selectedNode.status}</span>
            <span className="text-muted-foreground">Depth</span>
            <span className="text-foreground font-mono">{selectedNode.depth}</span>
            <span className="text-muted-foreground">Children</span>
            <span className="text-foreground font-mono">{selectedNode.children.length}</span>
          </div>
          {selectedNode.observation && (
            <div className="mt-2 rounded-lg bg-muted/30 border border-white/5 p-2 text-xs text-muted-foreground max-h-24 overflow-y-auto">
              {selectedNode.observation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Model selector ────────────────────────────────────────────────

function ModelSelector({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs bg-card border border-white/10 rounded-md px-2 py-1 text-muted-foreground focus:outline-none focus:border-primary/40"
    >
      {MODELS.map(m => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export default function WorkspacePage() {
  const { agentId } = useParams();
  const location = useLocation();
  const state = useProteus(agentId);
  const [activeTab, setActiveTab] = useState<Tab>("Identity");
  const [chatInput, setChatInput] = useState("");
  const [memorySearch, setMemorySearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialPromptSent = useRef(false);

  // Register this agent in localStorage on visit
  useEffect(() => {
    if (agentId) registerAgent(agentId);
  }, [agentId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // Auto-send initial prompt + set display name from HomePage navigation state
  useEffect(() => {
    if (initialPromptSent.current) return;
    const navState = location.state as { initialPrompt?: string; displayName?: string } | null;
    if (!navState?.initialPrompt || state.connectionStatus !== "connected") return;
    initialPromptSent.current = true;
    // Set the friendly display name on the DO
    if (navState.displayName) {
      state.rpc("setDisplayName", [navState.displayName]).catch(() => {});
    }
    setTimeout(() => state.sendChat(navState.initialPrompt!), 300);
  }, [state.connectionStatus, location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const text = chatInput.trim();
    if (!text || state.isStreaming) return;
    state.sendChat(text);
    setChatInput("");
  }, [chatInput, state]);

  if (state.connectionStatus === "error") {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <WifiOff className="h-8 w-8 text-red-400/50" />
          <div className="text-sm text-red-400">Connection lost</div>
        </div>
      </div>
    );
  }

  if (state.connectionStatus === "connecting" && !state.agentStatus) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />Connecting...
        </div>
      </div>
    );
  }

  const as = state.agentStatus;

  return (
    <div className="h-full flex flex-col">
      <PanelGroup className="flex-1">
        {/* Chat Panel */}
        <Panel minSize={30} defaultSize={42}>
          <div className="flex flex-col h-full border-r border-white/5">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "h-2 w-2 rounded-full",
                  state.connectionStatus === "connected" ? "bg-green-500" :
                  state.connectionStatus === "connecting" ? "bg-yellow-500 animate-pulse" :
                  "bg-red-500"
                )} title={state.connectionStatus} />
                <span className="font-medium text-sm">{as?.displayName || agentId}</span>
                {state.isStreaming && (
                  <Badge variant="warning" className="ml-1">streaming</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {state.messages.length > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="h-3 w-3" />{state.messages.length}
                  </span>
                )}
                <ModelSelector
                  current={as?.model ?? MODELS[0]!.id}
                  onChange={state.setModel}
                />
                {state.messages.length > 0 && (
                  <button onClick={state.clearHistory} className="text-xs text-muted-foreground hover:text-red-400 transition-colors p-1" title="Clear chat">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
                <Link to={`/mcts/${agentId}`} className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors">
                  <TreePine className="h-3 w-3" />MCTS<ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>

            {/* Messages — render raw UIMessages with reasoning/tool support */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {state.messages.length === 0 && !state.isStreaming && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <Brain className="h-8 w-8 text-muted-foreground/20 mb-3" />
                  <p className="text-sm text-muted-foreground/50">Send a message to start</p>
                </div>
              )}
              {state.messages.map((msg, i) => (
                <MessageView
                  key={msg.id}
                  message={msg}
                  isLast={i === state.messages.length - 1}
                  isStreaming={state.isStreaming}
                />
              ))}
              {/* Thinking indicator already handled inside MessageView for the
                  case where the assistant message exists but has no content.
                  No extra indicator needed here — MessageView shows bouncing dots
                  when isLive && !hasContent (lines 61-71). */}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 border-t border-white/5">
              {state.error && (
                <div className="mb-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">
                  {state.error}
                </div>
              )}
              <div className="relative border border-white/10 rounded-lg bg-card focus-within:border-primary/40 transition-colors">
                <AutoResizeTextarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Send a message..."
                  rows={1}
                  maxHeight={120}
                  disabled={state.connectionStatus !== "connected"}
                  className="w-full resize-none bg-transparent text-sm py-2.5 pl-3 pr-12 focus:outline-none placeholder:text-muted-foreground/40 disabled:opacity-50"
                />
                {state.isStreaming ? (
                  <button onClick={state.abortChat} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-red-400 hover:bg-red-500/10 transition-colors" title="Stop">
                    <Square className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!chatInput.trim() || state.connectionStatus !== "connected"}
                    className={cn(
                      "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 transition-colors",
                      chatInput.trim() && state.connectionStatus === "connected" ? "text-primary hover:bg-primary/10" : "text-muted-foreground/30",
                    )}
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="w-[3px] bg-white/[0.03] hover:bg-primary/30 transition-colors cursor-col-resize" />

        {/* Right Panel */}
        <Panel minSize={25} defaultSize={58}>
          <div className="flex flex-col h-full">
            <div className="flex items-center border-b border-white/5 px-1">
              {TABS.map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)} className={cn(
                  "px-3 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px",
                  activeTab === tab ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground",
                )}>
                  {tab}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {activeTab === "Identity" && (
                as ? (
                  <div className="space-y-4 animate-fade-in">
                    <div className="flex items-center gap-3 mb-6">
                      <div className="h-12 w-12 rounded-xl bg-primary/15 flex items-center justify-center">
                        <Fingerprint className="h-6 w-6 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium">{as.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">{as.id.slice(0, 16)}...</div>
                      </div>
                    </div>
                    <div className="space-y-0">
                      {([
                        ["Purpose", as.purpose],
                        ["Model", MODELS.find(m => m.id === as.model)?.label ?? as.model],
                        ["Scaffold", `v${as.scaffoldVersion}`],
                        ["MCTS Nodes", as.searchNodeCount],
                        ["Crafted Tools", as.craftedToolCount],
                        ["Messages", as.messageCount],
                        ["Created", new Date(as.createdAt).toLocaleString()],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="flex items-center justify-between py-2.5 border-b border-white/5">
                          <span className="text-sm text-muted-foreground">{label}</span>
                          <span className="text-sm font-medium max-w-[60%] text-right">{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Skeleton className="h-12 w-48" />
                    {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-8 w-full" />)}
                  </div>
                )
              )}

              {activeTab === "Tools" && (
                <div className="space-y-2 animate-fade-in">
                  {state.tools.length === 0 ? (
                    <EmptyTabState icon={Package} text="No tools discovered yet" />
                  ) : state.tools.map(tool => (
                    <div key={tool.name} className="rounded-lg border border-white/5 bg-muted/30 p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Package className="h-3.5 w-3.5 text-primary/70" />
                        <span className="text-sm font-medium font-mono">{tool.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{tool.description}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "Memory" && (
                <div className="space-y-3 animate-fade-in">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                    <input value={memorySearch} onChange={e => { setMemorySearch(e.target.value); state.searchMemory(e.target.value); }} placeholder="Search memory..." className="w-full rounded-lg border border-white/10 bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary/40 placeholder:text-muted-foreground/40" />
                  </div>
                  {!memorySearch && state.memoryContent ? (
                    // Show raw MEMORY.md when not searching
                    <div className="rounded-lg border border-white/5 bg-muted/30 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Database className="h-3.5 w-3.5 text-primary/70" />
                        <span className="text-xs font-mono text-primary/70">memory/MEMORY.md</span>
                        <span className="text-xs text-muted-foreground ml-auto">{state.memoryContent.length} chars</span>
                      </div>
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-96 overflow-y-auto">{state.memoryContent}</pre>
                    </div>
                  ) : !memorySearch ? (
                    <EmptyTabState icon={FolderOpen} text="No memories yet — use save_note to store information" />
                  ) : state.memory.length === 0 ? (
                    <EmptyTabState icon={FolderOpen} text="No results matching your search" />
                  ) : state.memory.map((entry, i) => (
                    <div key={i} className="rounded-lg border border-white/5 bg-muted/30 p-3">
                      <span className="text-xs font-mono text-primary/70">{entry.updatedAt}</span>
                      <p className="text-xs text-muted-foreground line-clamp-4 whitespace-pre-wrap mt-1">{entry.content}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "MCTS Tree" && (
                <MCTSTreeTab mctsTree={state.mctsTree} />
              )}

              {activeTab === "Evolution" && (
                <div className="animate-fade-in">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Evolution Timeline</span>
                      {state.evolutionEvents.length > 0 && (
                        <span className="text-xs text-muted-foreground">({state.evolutionEvents.length} events)</span>
                      )}
                    </div>
                    <button onClick={state.refreshEvolution} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 border border-white/10 rounded">
                      Refresh
                    </button>
                  </div>
                  {state.evolutionEvents.length === 0 ? (
                    <EmptyTabState icon={Sparkles} text="No evolution events yet — send a message to start" />
                  ) : (
                    state.evolutionEvents.map(event => (
                      <EvolutionItem key={event.id} event={event} />
                    ))
                  )}
                </div>
              )}

              {activeTab === "Logs" && (
                <LogsTab logs={state.logs} connectionStatus={state.connectionStatus} />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function LogsTab({ logs, connectionStatus }: { logs: LogEntry[]; connectionStatus: string }) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="animate-fade-in space-y-1">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Activity Log</span>
          <span className="text-xs text-muted-foreground">({logs.length})</span>
        </div>
        <span className={cn("flex items-center gap-1 text-xs", connectionStatus === "connected" ? "text-green-400" : "text-red-400")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", connectionStatus === "connected" ? "bg-green-500" : "bg-red-500")} />
          {connectionStatus}
        </span>
      </div>
      {logs.length === 0 ? (
        <EmptyTabState icon={Terminal} text="No activity yet" />
      ) : (
        <div className="space-y-1 max-h-[calc(100vh-200px)] overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="rounded border border-white/5 bg-muted/30 px-2.5 py-1.5 text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  log.type === "connection" ? "bg-blue-500" :
                  log.type === "tool" ? "bg-amber-500" :
                  log.type === "evolution" ? "bg-purple-500" :
                  log.type === "error" ? "bg-red-500" : "bg-gray-500"
                )} />
                <span className="text-muted-foreground/40">{new Date(log.time).toLocaleTimeString()}</span>
                <span className={cn(
                  log.type === "error" ? "text-red-400" :
                  log.type === "tool" ? "text-amber-400" :
                  log.type === "evolution" ? "text-purple-400" :
                  log.type === "connection" ? "text-blue-400" :
                  "text-muted-foreground",
                )}>{log.message}</span>
              </div>
              {log.detail && <p className="mt-0.5 ml-4 text-muted-foreground/40">{log.detail}</p>}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}
