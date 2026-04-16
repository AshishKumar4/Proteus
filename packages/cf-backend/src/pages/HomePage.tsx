import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Empty, InputArea, Loader } from "@cloudflare/kumo";
import { BrainIcon, ClockIcon, PlusIcon, TrashIcon, PaperPlaneRightIcon } from "@phosphor-icons/react";
import { useHomeConnection } from "@/hooks/use-proteus";
import { getKnownAgents, registerAgent, removeAgent, type AgentEntry } from "@/lib/agent-registry";

function AgentCard({ entry, onClick, onDelete }: {
  entry: AgentEntry; onClick: () => void; onDelete: () => void;
}) {
  return (
    <div className="p-card p-card-accent rounded-xl p-4 cursor-pointer animate-fade-in relative group">
      <button onClick={onClick} className="text-left w-full">
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold text-sm text-kumo-default">{entry.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            <ClockIcon size={12} />
            {new Date(entry.lastVisited).toLocaleDateString()}
          </span>
        </div>
        <p className="text-xs text-kumo-subtle line-clamp-2">{entry.purpose || "No purpose set"}</p>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 rounded text-kumo-inactive hover:text-red-400 transition-all"
        title="Remove from list"
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const conn = useHomeConnection();
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState("");

  useEffect(() => { setAgents(getKnownAgents()); }, []);

  const handleCreate = useCallback(async () => {
    const task = input.trim();
    if (!task) return;
    setCreating(true);
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
    const suffix = crypto.randomUUID().slice(0, 6);
    const agentId = `${slug}-${suffix}`;
    registerAgent(agentId, task.slice(0, 60), task);
    navigate(`/agent/${agentId}`, { state: { initialPrompt: task, displayName: task.slice(0, 60) } });
  }, [input, navigate]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex flex-col">
        {/* Hero with radial gradient */}
        <div className="flex flex-col items-center justify-center px-6 pt-20 pb-12 p-hero-gradient">
          <div className="flex flex-col items-center w-full max-w-2xl space-y-6">
            <BrainIcon size={56} weight="duotone" className="p-accent animate-pulse-glow" />
            <div className="text-center space-y-2">
              <h1 className="text-5xl font-extrabold tracking-tight text-kumo-default">Proteus</h1>
              <p className="text-sm text-kumo-subtle">Self-evolving AI agents with MCTS-guided exploration</p>
            </div>

            {/* Create input — accent border on focus */}
            <div className="w-full max-w-xl p-surface rounded-xl p-3 shadow-lg p-input-ring transition-all">
              <div className="flex items-end gap-3">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleCreate(); } }}
                  placeholder="Describe your agent's mission..."
                  disabled={creating}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                {creating ? (
                  <Loader size="sm" className="mb-1" />
                ) : (
                  <button
                    onClick={handleCreate}
                    disabled={!input.trim()}
                    className="p-gradient-btn rounded-lg p-2 mb-0.5 cursor-pointer"
                    aria-label="Create agent"
                  >
                    <PaperPlaneRightIcon size={18} />
                  </button>
                )}
              </div>
            </div>

            {creating && (
              <div className="flex items-center gap-2 text-xs p-accent">
                <Loader size="sm" /><span>Creating agent...</span>
              </div>
            )}

            <p className="text-xs text-kumo-inactive text-center max-w-md">
              Each agent is a Durable Object with its own scaffold, tools, memory, and MCTS search tree.
            </p>
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 px-6 pb-12">
          <div className="max-w-5xl mx-auto">
            {agents.length > 0 && (
              <>
                <h2 className="text-xs font-semibold text-kumo-subtle mb-4 uppercase tracking-widest">Recent Agents</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {agents.map(entry => (
                    <AgentCard key={entry.id} entry={entry}
                      onClick={() => { registerAgent(entry.id); navigate(`/agent/${entry.id}`); }}
                      onDelete={() => { removeAgent(entry.id); setAgents(getKnownAgents()); }}
                    />
                  ))}
                </div>
              </>
            )}
            {agents.length === 0 && (
              <Empty icon={<PlusIcon size={32} className="p-accent" />} title="No agents yet" description="Describe a mission above to create your first agent" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
