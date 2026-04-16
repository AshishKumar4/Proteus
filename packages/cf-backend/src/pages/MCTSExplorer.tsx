import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { Button, Badge, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, TreeStructureIcon, ArrowsOutIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon } from "@phosphor-icons/react";
import { MCTSTree } from "@/components/mcts-tree";
import { useProteus } from "@/hooks/use-proteus";
import type { MCTSNode } from "@/lib/protocol";

function countNodes(node: MCTSNode): number { return 1 + node.children.reduce((s, c) => s + countNodes(c), 0); }
function maxDepth(node: MCTSNode): number { return node.children.length === 0 ? node.depth : Math.max(...node.children.map(maxDepth)); }
function findWinner(node: MCTSNode): MCTSNode {
  let best = node;
  for (const child of node.children) { const cb = findWinner(child); if (cb.value > best.value) best = cb; }
  return best;
}

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const state = useProteus(agentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  const [selected, setSelected] = useState<MCTSNode | null>(null);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const tree = state.mctsTree;
  const total = tree ? countNodes(tree) : 0;
  const depth = tree ? maxDepth(tree) : 0;
  const winner = tree ? findWinner(tree) : null;

  return (
    <div className="h-full flex flex-col bg-kumo-elevated">
      <div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line" style={{ background: "color-mix(in oklch, var(--color-kumo-base) 100%, black 3%)" }}>
        <div className="flex items-center gap-3">
          <Link to={`/agent/${agentId}`}><Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button></Link>
          <div className="h-4 w-px bg-kumo-line" />
          <TreeStructureIcon size={16} className="p-accent" />
          <span className="font-semibold text-sm text-kumo-default">MCTS Explorer</span>
          {state.agentStatus && <span className="text-xs text-kumo-subtle">- {state.agentStatus.name}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" shape="square" size="sm" icon={<MagnifyingGlassMinusIcon size={16} />} aria-label="Zoom out" />
          <Button variant="ghost" shape="square" size="sm" icon={<MagnifyingGlassPlusIcon size={16} />} aria-label="Zoom in" />
          <Button variant="ghost" shape="square" size="sm" icon={<ArrowsOutIcon size={16} />} aria-label="Fit" />
        </div>
      </div>
      <div className="flex items-center gap-4 px-4 py-2 border-b border-kumo-line text-xs text-kumo-subtle bg-kumo-base">
        <span className="font-medium text-kumo-default">Legend:</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full bg-green-500" />High</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full bg-amber-400" />Medium</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full bg-red-400" />Low</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full bg-gray-500 opacity-40" />Pruned</span>
        <span className="ml-auto text-kumo-inactive">Node size = visit count</span>
      </div>
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {!tree ? (
          <div className="flex items-center justify-center h-full"><div className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size="sm" />Loading tree...</div></div>
        ) : dims.w > 0 && <MCTSTree root={tree} width={dims.w} height={dims.h} onNodeClick={setSelected} />}
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-kumo-line" style={{ background: "color-mix(in oklch, var(--color-kumo-base) 100%, black 3%)" }}>
        <div className="flex items-center gap-6 text-xs">
          <span className="text-kumo-subtle">Nodes: <span className="text-kumo-default font-medium">{total}</span></span>
          <span className="text-kumo-subtle">Depth: <span className="text-kumo-default font-medium">{depth}</span></span>
          {winner && (
            <>
              <span className="text-kumo-subtle">Winner: <span className="text-green-400 font-medium">{winner.value.toFixed(3)}</span></span>
              <span className={`flex items-center gap-1 ${winner.status === "terminal" ? "text-green-400" : "text-amber-400"}`}>
                <span className="size-1.5 rounded-full bg-current animate-pulse" />
                {winner.status === "terminal" ? "Converged" : "Searching..."}
              </span>
            </>
          )}
        </div>
        {selected && (
          <div className="flex items-center gap-4 text-xs animate-fade-in">
            <span className="text-kumo-subtle">Selected:</span>
            <span className="font-mono text-kumo-default">{selected.action}</span>
            <span className="text-kumo-subtle">v={selected.value.toFixed(3)} n={selected.visits}</span>
          </div>
        )}
      </div>
    </div>
  );
}
