import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { FloppyDiskIcon, BrainIcon, TreeStructureIcon, CheckIcon } from "@phosphor-icons/react";
import { useProteus } from "@/hooks/use-proteus";

function Card({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ size?: number; className?: string }>; children: React.ReactNode }) {
  return (
    <div className="p-card rounded-xl p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-4"><Icon size={16} className="p-accent" /><span className="text-sm font-semibold text-kumo-default">{title}</span></div>
      {children}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-2 placeholder:text-kumo-inactive transition-all";

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  const [modelName, setModelName] = useState("@cf/moonshotai/kimi-k2.5");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (state.agentStatus?.model) setModelName(state.agentStatus.model); }, [state.agentStatus]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try { state.setModel(modelName); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setSaving(false); }
  }, [state, modelName]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-kumo-default">Settings</h1>
          <p className="text-sm text-kumo-subtle mt-1">Configure agent: <span className="font-mono p-accent">{agentId ?? "default"}</span></p>
        </div>
        <Card title="Model Configuration" icon={BrainIcon}>
          <div className="space-y-1.5">
            <span className="text-xs text-kumo-subtle block font-medium">Model</span>
            <select value={modelName} onChange={e => setModelName(e.target.value)} className={inputCls}>
              <option value="@cf/moonshotai/kimi-k2.5">Kimi K2.5 (reasoning)</option>
              <option value="@cf/meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout (fast)</option>
              <option value="@cf/meta/llama-4-maverick-17b-128e-instruct">Llama 4 Maverick</option>
              <option value="@cf/qwen/qwen2.5-coder-32b-instruct">Qwen 2.5 Coder 32B</option>
            </select>
          </div>
        </Card>
        <Card title="Agent Info" icon={TreeStructureIcon}>
          <div className="space-y-2 text-sm">
            {state.agentStatus ? (
              [["Name", state.agentStatus.name], ["Scaffold", `v${state.agentStatus.scaffoldVersion}`], ["MCTS Nodes", state.agentStatus.searchNodeCount], ["Crafted Tools", state.agentStatus.craftedToolCount], ["Messages", state.agentStatus.messageCount]].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between py-1.5 border-b border-kumo-line">
                  <span className="text-kumo-subtle">{String(l)}</span><span className="text-kumo-default font-medium">{String(v)}</span>
                </div>
              ))
            ) : <div className="flex justify-center py-4"><Loader size="sm" /></div>}
          </div>
        </Card>
        <button onClick={handleSave} disabled={saving || state.connectionStatus !== "connected"}
          className="p-send-btn rounded-lg px-5 py-2.5 text-sm font-medium flex items-center gap-2 cursor-pointer">
          {saving ? <Loader size="sm" /> : saved ? <CheckIcon size={16} /> : <FloppyDiskIcon size={16} />}
          {saving ? "Saving..." : saved ? "Saved" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
