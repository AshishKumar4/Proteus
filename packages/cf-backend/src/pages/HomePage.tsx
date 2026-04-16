import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, Clock, Plus, Loader2, Trash2 } from "lucide-react";
import { PromptInput } from "@/components/prompt-input";
import { useHomeConnection } from "@/hooks/use-proteus";
import { getKnownAgents, registerAgent, removeAgent, type AgentEntry } from "@/lib/agent-registry";
import { cn } from "@/lib/utils";

function AgentCard({ entry, onClick, onDelete }: {
  entry: AgentEntry; onClick: () => void; onDelete: () => void;
}) {
  return (
    <div className={cn(
      "relative group rounded-xl border border-white/5 bg-card p-4 transition-all",
      "hover:border-white/10 hover:bg-card/80 cursor-pointer animate-fade-in",
    )}>
      <button onClick={onClick} className="text-left w-full">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-sm">{entry.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {new Date(entry.lastVisited).toLocaleDateString()}
          </span>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {entry.purpose || "No purpose set"}
        </p>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground/50 hover:text-red-400 hover:bg-red-400/10 transition-all"
        title="Remove from list"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const conn = useHomeConnection();
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setAgents(getKnownAgents());
  }, []);

  const handleCreate = useCallback(async (task: string) => {
    setCreating(true);
    // Unique ID: slug + random suffix to prevent collisions
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
    const suffix = crypto.randomUUID().slice(0, 6);
    const agentId = `${slug}-${suffix}`;
    // Store the user's original text as the friendly display name
    const displayName = task.slice(0, 60);
    registerAgent(agentId, displayName, task);
    navigate(`/agent/${agentId}`, { state: { initialPrompt: task, displayName } });
  }, [navigate]);

  const handleDelete = useCallback((id: string) => {
    removeAgent(id);
    setAgents(getKnownAgents());
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex flex-col">
        {/* Hero */}
        <div className="flex flex-col items-center justify-center px-6 pt-20 pb-12">
          <div className="flex flex-col items-center w-full max-w-2xl space-y-6">
            <Brain className="h-12 w-12 text-primary animate-pulse-glow rounded-full" />
            <div className="text-center space-y-2">
              <h1 className="text-4xl font-bold tracking-tight">Proteus</h1>
              <p className="text-sm text-muted-foreground">Self-evolving AI agents with MCTS-guided exploration</p>
            </div>
            <div className="w-full max-w-xl">
              <PromptInput
                onSubmit={handleCreate}
                disabled={creating}
                placeholder="Describe your agent's mission..."
              />
            </div>
            {creating && (
              <div className="flex items-center gap-2 text-xs text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />Creating agent...
              </div>
            )}
            <p className="text-xs text-muted-foreground/40 text-center max-w-md">
              Each agent is a Durable Object with its own scaffold, tools, memory, and MCTS search tree.
            </p>
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 px-6 pb-12">
          <div className="max-w-5xl mx-auto">
            {agents.length > 0 && (
              <>
                <h2 className="text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
                  Recent Agents
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {agents.map((entry) => (
                    <AgentCard
                      key={entry.id}
                      entry={entry}
                      onClick={() => {
                        registerAgent(entry.id);
                        navigate(`/agent/${entry.id}`);
                      }}
                      onDelete={() => handleDelete(entry.id)}
                    />
                  ))}
                </div>
              </>
            )}
            {agents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                  <Plus className="h-8 w-8 text-primary/50" />
                </div>
                <p className="text-sm text-muted-foreground mb-1">No agents yet</p>
                <p className="text-xs text-muted-foreground/60">Describe a mission above to create your first agent</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
