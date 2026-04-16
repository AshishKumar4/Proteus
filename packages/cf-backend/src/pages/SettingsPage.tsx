import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Save, Brain, TreePine, Check, Loader2 } from "lucide-react";
import { useProteus } from "@/hooks/use-proteus";
import { cn } from "@/lib/utils";

function Card({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/5 bg-card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="font-medium text-sm">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-white/10 bg-input px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/40 placeholder:text-muted-foreground/40 transition-colors";

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  const [modelName, setModelName] = useState("@cf/moonshotai/kimi-k2.5");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (state.agentStatus?.model) {
      setModelName(state.agentStatus.model);
    }
  }, [state.agentStatus]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      state.setModel(modelName);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [state, modelName]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure agent: {agentId ?? "default"}
          </p>
        </div>

        <Card title="Model Configuration" icon={Brain}>
          <div className="space-y-4">
            <Field label="Model">
              <select value={modelName} onChange={e => setModelName(e.target.value)} className={inputCls}>
                <option value="@cf/moonshotai/kimi-k2.5">Kimi K2.5 (reasoning, slow)</option>
                <option value="@cf/meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout (fast)</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card title="Agent Info" icon={TreePine}>
          <div className="space-y-2 text-sm">
            {state.agentStatus ? (
              <>
                <div className="flex justify-between py-1.5 border-b border-white/5">
                  <span className="text-muted-foreground">Name</span>
                  <span>{state.agentStatus.name}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-white/5">
                  <span className="text-muted-foreground">Scaffold</span>
                  <span>v{state.agentStatus.scaffoldVersion}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-white/5">
                  <span className="text-muted-foreground">MCTS Nodes</span>
                  <span>{state.agentStatus.searchNodeCount}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-white/5">
                  <span className="text-muted-foreground">Crafted Tools</span>
                  <span>{state.agentStatus.craftedToolCount}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-muted-foreground">Messages</span>
                  <span>{state.agentStatus.messageCount}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Loading...</p>
            )}
          </div>
        </Card>

        <button
          onClick={handleSave}
          disabled={saving || state.connectionStatus !== "connected"}
          className={cn(
            "flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground",
            "hover:bg-primary/90 transition-colors disabled:opacity-50",
          )}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saving ? "Saving..." : saved ? "Saved" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
