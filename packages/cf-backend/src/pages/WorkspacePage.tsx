import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Button, Badge, Surface, Empty, InputArea, Loader } from "@cloudflare/kumo";
import { Code } from "@cloudflare/kumo/components/code";
import {
  PaperPlaneRightIcon, StopIcon, WrenchIcon, SparkleIcon,
  CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon,
  FingerprintIcon, PackageIcon, DatabaseIcon, TreeStructureIcon,
  ClockIcon, WifiSlashIcon, ArrowsClockwiseIcon, BrainIcon,
  FolderOpenIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  ChatTextIcon, CopyIcon, TerminalIcon, GearIcon, ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProteus, type EvolutionEventRow, type LogEntry } from "@/hooks/use-proteus";
import { registerAgent } from "@/lib/agent-registry";
import { MCTSTree } from "@/components/mcts-tree";
import { ConnectionIndicator } from "@/components/connection-indicator";
import type { MCTSNode } from "@/lib/protocol";

const TABS = ["Identity", "Tools", "Memory", "MCTS Tree", "Evolution", "Logs"] as const;
type Tab = (typeof TABS)[number];
const MODELS = [
  { id: "@cf/moonshotai/kimi-k2.5", label: "Kimi K2.5 (reasoning)" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (fast)" },
  { id: "@cf/meta/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
];

/* ── Code block ───────────────────────────────────────────────── */

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";
  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1 rounded-t-lg bg-kumo-elevated border border-b-0 border-kumo-line text-[10px] text-kumo-inactive">
        <span>{lang || "code"}</span>
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="flex items-center gap-1 hover:text-kumo-default transition-colors">
          <CopyIcon size={12} />{copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div className="rounded-b-lg border border-t-0 border-kumo-line overflow-hidden">
        <Code language={lang || "text"} theme="auto">{code}</Code>
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      code({ className, children, ...props }) {
        if (!className) return <code className="bg-kumo-elevated px-1.5 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
        return <CodeBlock className={className}>{children}</CodeBlock>;
      },
      a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>; },
      table({ children }) { return <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border border-kumo-line px-2 py-1 text-left font-medium bg-kumo-elevated">{children}</th>; },
      td({ children }) { return <td className="border border-kumo-line px-2 py-1">{children}</td>; },
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
}

/* ── Message rendering ────────────────────────────────────────── */

function getMessageText(msg: UIMessage): string {
  return msg.parts.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg px-3 py-2 my-1 p-surface" style={{ borderLeftColor: "hsl(280 60% 50% / 0.5)", borderLeftWidth: 3 }}>
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs text-purple-400 w-full text-left">
        <GearIcon size={12} className="shrink-0" />
        <span className="font-medium">Thinking</span>
        {expanded ? <CaretDownIcon size={12} className="ml-auto" /> : <CaretRightIcon size={12} className="ml-auto" />}
      </button>
      <div className={`mt-1 text-xs text-purple-300/70 whitespace-pre-wrap ${!expanded ? "line-clamp-2" : ""}`}>
        {expanded ? text : text.length > 80 ? text.slice(0, 80) + "..." : text}
      </div>
    </div>
  );
}

function ToolCallBlock({ toolName, input, output, isRunning, isError }: {
  toolName: string; input?: Record<string, unknown>; output?: unknown; isRunning: boolean; isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs text-kumo-subtle hover:text-kumo-default transition-colors">
        {isRunning ? <Loader size="sm" /> : isError ? <WrenchIcon size={12} className="text-red-400" /> : <CheckCircleIcon size={12} className="text-green-400" />}
        <span className="font-mono">{toolName}</span>
        {isRunning && <span className="text-amber-400">running...</span>}
        {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-1 animate-scale-in">
          {input != null && <pre className="rounded-lg bg-kumo-elevated border border-kumo-line p-2.5 text-xs font-mono text-kumo-subtle max-h-32 overflow-auto">{JSON.stringify(input, null, 2)}</pre>}
          {output != null && <pre className="rounded-lg bg-kumo-elevated border border-kumo-line p-2.5 text-xs font-mono text-kumo-subtle max-h-32 overflow-auto whitespace-pre-wrap">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function MessageView({ message, isLast, isStreaming }: { message: UIMessage; isLast: boolean; isStreaming: boolean }) {
  const isUser = message.role === "user";
  const isLive = isLast && isStreaming && !isUser;

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md p-user-bubble leading-relaxed text-sm whitespace-pre-wrap shadow-md">
          {getMessageText(message)}
        </div>
      </div>
    );
  }

  const hasContent = message.parts.some(p =>
    (p.type === "text" && (p as { text: string }).text) ||
    (p.type === "reasoning" && (p as { text?: string }).text) ||
    isToolUIPart(p)
  );

  if (isLive && !hasContent) {
    return (
      <div className="flex items-center gap-2 animate-fade-in py-1">
        <div className="flex gap-1">
          <span className="size-1.5 rounded-full animate-bounce [animation-delay:0ms]" style={{ background: "hsl(var(--p-accent))" }} />
          <span className="size-1.5 rounded-full animate-bounce [animation-delay:150ms]" style={{ background: "hsl(var(--p-accent))" }} />
          <span className="size-1.5 rounded-full animate-bounce [animation-delay:300ms]" style={{ background: "hsl(var(--p-accent))" }} />
        </div>
        <span className="text-xs text-kumo-inactive">Thinking...</span>
      </div>
    );
  }

  return (
    <div className="space-y-1 animate-fade-in">
      {message.parts.map((part, i) => {
        if (part.type === "reasoning") {
          const t = (part as { text?: string }).text;
          return t ? <ReasoningBlock key={i} text={t} /> : null;
        }
        if (part.type === "text") {
          const t = (part as { text: string }).text;
          if (!t) return null;
          const isLastText = message.parts.slice(i + 1).every(p => p.type !== "text");
          return (
            <div key={i} className="prose-chat text-kumo-default">
              <MarkdownContent content={t} />
              {isLive && isLastText && <span className="inline-block w-0.5 h-[1em] ml-0.5 align-text-bottom animate-blink-cursor" style={{ background: "hsl(var(--p-accent))" }} />}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          return (
            <ToolCallBlock key={part.toolCallId} toolName={getToolName(part)}
              input={part.input as Record<string, unknown> | undefined}
              output={part.state === "output-available" ? (part as { output?: unknown }).output : undefined}
              isRunning={part.state === "input-available" || part.state === "input-streaming"}
              isError={part.state === "output-error"} />
          );
        }
        return null;
      })}
    </div>
  );
}

/* ── Sidebar tabs ─────────────────────────────────────────────── */

const EVO_COLORS: Record<string, string> = {
  craft_discovered: "bg-green-500", mcts_complete: "bg-green-500", reflection: "bg-blue-500",
  consolidation: "bg-amber-500", scaffold_proposed: "bg-purple-500", mcts_started: "bg-gray-500",
};

function EvolutionItem({ event }: { event: EvolutionEventRow }) {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="flex flex-col items-center">
        <div className={`size-2 rounded-full mt-1.5 ${EVO_COLORS[event.type] ?? "bg-kumo-inactive"}`} />
        <div className="flex-1 w-px bg-kumo-line" />
      </div>
      <div className="pb-4">
        <div className="flex items-center gap-2 text-xs text-kumo-subtle mb-0.5">
          <span className="font-mono">{new Date(event.created_at).toLocaleTimeString()}</span>
          <Badge variant="secondary">{event.type}</Badge>
        </div>
        <span className="text-sm text-kumo-default block">{event.message}</span>
      </div>
    </div>
  );
}

function EmptyTab({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <Empty icon={icon} title={text} />;
}

function MCTSTreeTab({ mctsTree }: { mctsTree: MCTSNode | null }) {
  const [selectedNode, setSelectedNode] = useState<MCTSNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 400 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) }));
    ro.observe(el); setDims({ w: el.clientWidth, h: Math.max(350, el.clientHeight - (selectedNode ? 200 : 0)) });
    return () => ro.disconnect();
  }, [selectedNode]);

  if (!mctsTree) return <EmptyTab icon={<GitBranchIcon size={32} className="p-accent" />} text="No exploration history" />;
  function countN(n: MCTSNode): number { return 1 + n.children.reduce((s, c) => s + countN(c), 0); }
  function maxD(n: MCTSNode): number { return n.children.length === 0 ? n.depth : Math.max(...n.children.map(maxD)); }
  return (
    <div ref={containerRef} className="animate-fade-in h-full flex flex-col">
      <div className="flex items-center gap-4 mb-2 text-xs text-kumo-subtle">
        <span>Nodes: <span className="text-kumo-default font-mono">{countN(mctsTree)}</span></span>
        <span>Depth: <span className="text-kumo-default font-mono">{maxD(mctsTree)}</span></span>
        <span>Root: <span className="text-kumo-default font-mono">{mctsTree.value.toFixed(3)}</span></span>
      </div>
      <div className="flex-1 min-h-0">{dims.w > 0 && <MCTSTree root={mctsTree} width={dims.w} height={dims.h} onNodeClick={setSelectedNode} selectedNode={selectedNode} />}</div>
      {selectedNode && (
        <div className="p-surface rounded-lg p-3 mt-2 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-kumo-default">Node Details</span>
            <Button variant="ghost" size="sm" onClick={() => setSelectedNode(null)}>Close</Button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {([["Action", selectedNode.action || "(root)"], ["Value", selectedNode.value.toFixed(4)], ["Visits", selectedNode.visits], ["Status", selectedNode.status], ["Depth", selectedNode.depth], ["Children", selectedNode.children.length]] as const).map(([k, v]) => (
              <div key={k} className="contents"><span className="text-kumo-subtle">{k}</span><span className="text-kumo-default font-mono">{String(v)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSelector({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  return (
    <select value={current} onChange={e => onChange(e.target.value)}
      className="text-xs bg-kumo-elevated border border-kumo-line rounded-md px-2 py-1 text-kumo-default focus:outline-none focus:ring-1" style={{ boxShadow: "none" }}>
      {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}

function LogsTab({ logs, connectionStatus }: { logs: LogEntry[]; connectionStatus: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs.length]);
  const C: Record<string, string> = { connection: "bg-blue-500", tool: "bg-amber-500", evolution: "bg-purple-500", error: "bg-red-500", info: "bg-gray-500" };
  return (
    <div className="animate-fade-in space-y-1">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TerminalIcon size={16} className="text-kumo-subtle" />
          <span className="text-sm font-medium text-kumo-default">Activity Log</span>
          <Badge variant="secondary">{logs.length}</Badge>
        </div>
        <ConnectionIndicator status={connectionStatus as "connected" | "connecting" | "disconnected" | "error"} />
      </div>
      {logs.length === 0 ? <EmptyTab icon={<TerminalIcon size={32} />} text="No activity yet" /> : (
        <div className="space-y-1 max-h-[calc(100vh-200px)] overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="rounded border border-kumo-line bg-kumo-elevated px-2.5 py-1.5 text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full shrink-0 ${C[log.type] ?? "bg-gray-500"}`} />
                <span className="text-kumo-inactive">{new Date(log.time).toLocaleTimeString()}</span>
                <span className="text-kumo-subtle">{log.message}</span>
              </div>
              {log.detail && <p className="mt-0.5 ml-4 text-kumo-inactive">{log.detail}</p>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/* ── Main page ────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { agentId } = useParams();
  const location = useLocation();
  const state = useProteus(agentId);
  const [activeTab, setActiveTab] = useState<Tab>("Identity");
  const [chatInput, setChatInput] = useState("");
  const [memorySearch, setMemorySearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialPromptSent = useRef(false);

  useEffect(() => { if (agentId) registerAgent(agentId); }, [agentId]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.messages]);

  useEffect(() => {
    if (initialPromptSent.current) return;
    const ns = location.state as { initialPrompt?: string; displayName?: string } | null;
    if (!ns?.initialPrompt || state.connectionStatus !== "connected") return;
    initialPromptSent.current = true;
    if (ns.displayName) state.rpc("setDisplayName", [ns.displayName]).catch(() => {});
    setTimeout(() => state.sendChat(ns.initialPrompt!), 300);
  }, [state.connectionStatus, location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const t = chatInput.trim(); if (!t || state.isStreaming) return;
    state.sendChat(t); setChatInput("");
  }, [chatInput, state]);

  if (state.connectionStatus === "error") return (
    <div className="h-full flex items-center justify-center">
      <Empty icon={<WifiSlashIcon size={32} className="text-red-400" />} title="Connection lost" description="Check your network or restart the server" />
    </div>
  );
  if (state.connectionStatus === "connecting" && !state.agentStatus) return (
    <div className="h-full flex items-center justify-center"><div className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" /><span>Connecting...</span></div></div>
  );

  const as = state.agentStatus;
  return (
    <div className="h-full flex flex-col">
      {state.connectionStatus === "disconnected" && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-amber-300" style={{ background: "hsl(40 80% 50% / 0.08)", borderBottom: "1px solid hsl(40 80% 50% / 0.2)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}
      <PanelGroup className="flex-1">
        {/* ── Chat Panel ──────────────────────────────────────── */}
        <Panel minSize={30} defaultSize={42}>
          <div className="flex flex-col h-full border-r border-kumo-line">
            {/* Chat header — slightly raised */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line" style={{ background: "color-mix(in oklch, var(--color-kumo-base) 100%, black 3%)" }}>
              <div className="flex items-center gap-2">
                <ConnectionIndicator status={state.connectionStatus} />
                <span className="font-semibold text-sm text-kumo-default">{as?.displayName || agentId}</span>
                {state.isStreaming && <Badge variant="primary">streaming</Badge>}
              </div>
              <div className="flex items-center gap-2">
                {state.messages.length > 0 && <span className="flex items-center gap-1 text-xs text-kumo-subtle"><ChatTextIcon size={12} />{state.messages.length}</span>}
                <ModelSelector current={as?.model ?? MODELS[0]!.id} onChange={state.setModel} />
                {state.messages.length > 0 && <Button variant="ghost" shape="square" size="sm" onClick={state.clearHistory} icon={<TrashIcon size={12} />} aria-label="Clear" />}
                <Link to={`/mcts/${agentId}`} className="flex items-center gap-1 text-xs p-accent hover:opacity-80 transition-opacity">
                  <TreeStructureIcon size={12} />MCTS<ArrowSquareOutIcon size={12} />
                </Link>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {state.messages.length === 0 && !state.isStreaming && (
                <div className="flex flex-col items-center justify-center h-full">
                  <BrainIcon size={40} className="p-accent opacity-30 mb-3" />
                  <p className="text-sm text-kumo-inactive">Send a message to start</p>
                </div>
              )}
              {state.messages.map((msg, i) => <MessageView key={msg.id} message={msg} isLast={i === state.messages.length - 1} isStreaming={state.isStreaming} />)}
              <div ref={messagesEndRef} />
            </div>

            {/* Input — accent focus ring */}
            <div className="p-3 border-t border-kumo-line" style={{ background: "color-mix(in oklch, var(--color-kumo-base) 100%, black 3%)" }}>
              {state.error && <div className="mb-2 text-xs text-red-400 p-surface rounded-lg px-3 py-1.5" style={{ borderColor: "hsl(0 60% 50% / 0.2)" }}>{state.error}</div>}
              <div className="flex items-end gap-3 rounded-xl p-surface p-3 shadow-sm p-input-ring transition-all">
                <InputArea value={chatInput} onValueChange={setChatInput}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Send a message..." disabled={state.connectionStatus !== "connected"} rows={1}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none" />
                {state.isStreaming
                  ? <Button variant="secondary" shape="square" onClick={state.abortChat} icon={<StopIcon size={18} weight="fill" />} aria-label="Stop" className="mb-0.5" />
                  : <button onClick={handleSend} disabled={!chatInput.trim() || state.connectionStatus !== "connected"} className="p-gradient-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Send"><PaperPlaneRightIcon size={18} /></button>}
              </div>
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="w-[3px] bg-kumo-line/30 hover:bg-kumo-accent/30 transition-colors cursor-col-resize" />

        {/* ── Right Panel ─────────────────────────────────────── */}
        <Panel minSize={25} defaultSize={58}>
          <div className="flex flex-col h-full">
            {/* Tabs — accent active indicator */}
            <div className="flex items-center border-b border-kumo-line px-1" style={{ background: "color-mix(in oklch, var(--color-kumo-base) 100%, black 3%)" }}>
              {TABS.map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-3 py-2.5 text-xs font-medium transition-all border-b-2 -mb-px rounded-t ${
                    activeTab === tab ? "p-tab-active" : "text-kumo-subtle border-transparent hover:text-kumo-default hover:bg-kumo-elevated/50"
                  }`}>
                  {tab}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {/* Identity */}
              {activeTab === "Identity" && (as ? (
                <div className="space-y-4 animate-fade-in">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="size-12 rounded-xl flex items-center justify-center p-accent-bg-subtle" style={{ border: "1px solid hsl(var(--p-accent) / 0.2)" }}>
                      <FingerprintIcon size={24} className="p-accent" />
                    </div>
                    <div>
                      <div className="font-semibold text-kumo-default">{as.name}</div>
                      <div className="text-xs text-kumo-subtle font-mono">{as.id.slice(0, 16)}...</div>
                    </div>
                  </div>
                  <div className="space-y-0">
                    {([["Purpose", as.purpose], ["Model", MODELS.find(m => m.id === as.model)?.label ?? as.model], ["Scaffold", `v${as.scaffoldVersion}`], ["MCTS Nodes", as.searchNodeCount], ["Crafted Tools", as.craftedToolCount], ["Messages", as.messageCount], ["Created", new Date(as.createdAt).toLocaleString()]] as const).map(([l, v]) => (
                      <div key={l} className="flex items-center justify-between py-2.5 border-b border-kumo-line">
                        <span className="text-sm text-kumo-subtle">{l}</span>
                        <span className="text-sm font-medium text-kumo-default max-w-[60%] text-right">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <div className="flex items-center justify-center h-32"><Loader /></div>)}

              {/* Tools */}
              {activeTab === "Tools" && (
                <div className="space-y-2 animate-fade-in">
                  {state.tools.length === 0 ? <EmptyTab icon={<PackageIcon size={32} className="p-accent" />} text="No tools discovered yet" /> : state.tools.map(tool => (
                    <div key={tool.name} className="p-card p-card-accent rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1.5"><PackageIcon size={14} className="p-accent" /><span className="text-sm font-medium font-mono text-kumo-default">{tool.name}</span></div>
                      <span className="text-xs text-kumo-subtle block">{tool.description}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Memory */}
              {activeTab === "Memory" && (
                <div className="space-y-3 animate-fade-in">
                  <div className="relative">
                    <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
                    <input value={memorySearch} onChange={e => { setMemorySearch(e.target.value); state.searchMemory(e.target.value); }}
                      placeholder="Search memory..." className="w-full rounded-lg border border-kumo-line bg-kumo-elevated pl-9 pr-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-2 placeholder:text-kumo-inactive transition-all" style={{ focusRingColor: "hsl(var(--p-accent) / 0.3)" }} />
                  </div>
                  {!memorySearch && state.memoryContent ? (
                    <div className="p-card p-card-accent rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <DatabaseIcon size={14} className="p-accent" /><span className="text-xs font-mono p-accent">memory/MEMORY.md</span>
                        <span className="text-xs text-kumo-inactive ml-auto">{state.memoryContent.length} chars</span>
                      </div>
                      <pre className="text-xs text-kumo-subtle whitespace-pre-wrap max-h-96 overflow-y-auto">{state.memoryContent}</pre>
                    </div>
                  ) : !memorySearch ? <EmptyTab icon={<FolderOpenIcon size={32} className="p-accent" />} text="No memories yet" />
                  : state.memory.length === 0 ? <EmptyTab icon={<MagnifyingGlassIcon size={32} />} text="No results" />
                  : state.memory.map((entry, i) => (
                    <div key={i} className="p-card rounded-lg p-3">
                      <span className="text-xs font-mono p-accent">{entry.updatedAt}</span>
                      <p className="text-xs text-kumo-subtle line-clamp-4 whitespace-pre-wrap mt-1">{entry.content}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "MCTS Tree" && <MCTSTreeTab mctsTree={state.mctsTree} />}

              {/* Evolution */}
              {activeTab === "Evolution" && (
                <div className="animate-fade-in">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2"><ClockIcon size={16} className="text-kumo-subtle" /><span className="text-sm font-semibold text-kumo-default">Evolution Timeline</span>{state.evolutionEvents.length > 0 && <Badge variant="secondary">{state.evolutionEvents.length}</Badge>}</div>
                    <Button variant="secondary" size="sm" onClick={state.refreshEvolution}>Refresh</Button>
                  </div>
                  {state.evolutionEvents.length === 0 ? <EmptyTab icon={<SparkleIcon size={32} className="p-accent" />} text="No evolution events yet" /> : state.evolutionEvents.map(e => <EvolutionItem key={e.id} event={e} />)}
                </div>
              )}

              {activeTab === "Logs" && <LogsTab logs={state.logs} connectionStatus={state.connectionStatus} />}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
