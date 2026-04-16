import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Surface, Empty, InputArea, Loader } from "@cloudflare/kumo";
import { BrainIcon, ClockIcon, PlusIcon, TrashIcon, PaperPlaneRightIcon } from "@phosphor-icons/react";
import { useHomeConnection } from "@/hooks/use-proteus";
import { getKnownAgents, registerAgent, removeAgent, type AgentEntry } from "@/lib/agent-registry";

function AgentCard({ entry, onClick, onDelete }: {
  entry: AgentEntry; onClick: () => void; onDelete: () => void;
}) {
  return (
    <Surface className="relative group rounded-xl ring ring-kumo-line p-4 transition-all hover:ring-kumo-accent/30 cursor-pointer animate-fade-in">
      <button onClick={onClick} className="text-left w-full">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-sm text-kumo-default">{entry.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            <ClockIcon size={12} />
            {new Date(entry.lastVisited).toLocaleDateString()}
          </span>
        </div>
        <span className="text-xs text-kumo-subtle line-clamp-2 block">{entry.purpose || "No purpose set"}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 rounded text-kumo-inactive hover:text-kumo-danger transition-all"
        title="Remove from list"
      >
        <TrashIcon size={12} />
      </button>
    </Surface>
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
        <div className="flex flex-col items-center justify-center px-6 pt-20 pb-12">
          <div className="flex flex-col items-center w-full max-w-2xl space-y-6">
            <BrainIcon size={48} weight="duotone" className="text-kumo-accent" />
            <div className="text-center space-y-2">
              <h1 className="text-4xl font-bold tracking-tight text-kumo-default">Proteus</h1>
              <p className="text-sm text-kumo-subtle">Self-evolving AI agents with MCTS-guided exploration</p>
            </div>
            <Surface className="w-full max-w-xl rounded-xl ring ring-kumo-line p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring transition-shadow">
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
                  <Button variant="primary" shape="square" onClick={handleCreate} disabled={!input.trim()} icon={<PaperPlaneRightIcon size={18} />} aria-label="Create agent" className="mb-0.5" />
                )}
              </div>
            </Surface>
            {creating && (
              <div className="flex items-center gap-2 text-xs text-kumo-accent">
                <Loader size="sm" /><span>Creating agent...</span>
              </div>
            )}
            <p className="text-xs text-kumo-inactive text-center max-w-md">
              Each agent is a Durable Object with its own scaffold, tools, memory, and MCTS search tree.
            </p>
          </div>
        </div>
        <div className="flex-1 px-6 pb-12">
          <div className="max-w-5xl mx-auto">
            {agents.length > 0 && (
              <>
                <h2 className="text-sm font-medium text-kumo-subtle mb-4 uppercase tracking-wider">Recent Agents</h2>
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
              <Empty icon={<PlusIcon size={32} />} title="No agents yet" description="Describe a mission above to create your first agent" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
