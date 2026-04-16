import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, TreePine, Maximize2, ZoomIn, ZoomOut, Loader2 } from "lucide-react";
import { MCTSTree } from "@/components/mcts-tree";
import { useProteus } from "@/hooks/use-proteus";
import { cn } from "@/lib/utils";
import type { MCTSNode } from "@/lib/protocol";

function countNodes(node: MCTSNode): number {
	return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function maxDepth(node: MCTSNode): number {
	if (node.children.length === 0) return node.depth;
	return Math.max(...node.children.map(maxDepth));
}

function findWinner(node: MCTSNode): MCTSNode {
	let best = node;
	for (const child of node.children) {
		const childBest = findWinner(child);
		if (childBest.value > best.value) best = childBest;
	}
	return best;
}

export default function MCTSExplorer() {
	const { agentId } = useParams();
	const state = useProteus(agentId);
	const containerRef = useRef<HTMLDivElement>(null);
	const [dims, setDims] = useState({ w: 1200, h: 700 });
	const [selected, setSelected] = useState<MCTSNode | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		setDims({ w: el.clientWidth, h: el.clientHeight });
		return () => ro.disconnect();
	}, []);

	const tree = state.mctsTree;
	const totalNodes = tree ? countNodes(tree) : 0;
	const depth = tree ? maxDepth(tree) : 0;
	const winner = tree ? findWinner(tree) : null;

	return (
		<div className="h-full flex flex-col bg-background">
			<div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
				<div className="flex items-center gap-3">
					<Link to={`/agent/${agentId}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
						<ArrowLeft className="h-4 w-4" />Back
					</Link>
					<div className="h-4 w-px bg-white/10" />
					<TreePine className="h-4 w-4 text-primary" />
					<span className="font-medium text-sm">MCTS Explorer</span>
					{state.agentStatus && <span className="text-xs text-muted-foreground">— {state.agentStatus.name}</span>}
				</div>
				<div className="flex items-center gap-2">
					<button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5"><ZoomOut className="h-4 w-4" /></button>
					<button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5"><ZoomIn className="h-4 w-4" /></button>
					<button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5"><Maximize2 className="h-4 w-4" /></button>
				</div>
			</div>

			<div className="flex items-center gap-6 px-4 py-2 border-b border-white/5 text-xs text-muted-foreground">
				<span className="font-medium text-foreground/70">Legend:</span>
				<span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-emerald-500" />High (0.7+)</span>
				<span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-amber-400" />Medium</span>
				<span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-red-400" />Low</span>
				<span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-zinc-600 opacity-40" />Pruned</span>
				<span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-emerald-400/50" />Terminal</span>
				<span className="ml-auto">Node size = visit count</span>
			</div>

			<div ref={containerRef} className="flex-1 relative overflow-hidden">
				{!tree ? (
					<div className="flex items-center justify-center h-full">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />Loading tree...
						</div>
					</div>
				) : dims.w > 0 && (
					<MCTSTree root={tree} width={dims.w} height={dims.h} onNodeClick={setSelected} />
				)}
			</div>

			<div className="flex items-center justify-between px-4 py-2.5 border-t border-white/5 bg-card/50">
				<div className="flex items-center gap-6 text-xs">
					<span className="text-muted-foreground">Nodes: <span className="text-foreground font-medium">{totalNodes}</span></span>
					<span className="text-muted-foreground">Max Depth: <span className="text-foreground font-medium">{depth}</span></span>
					{winner && (
						<>
							<span className="text-muted-foreground">Winner: <span className="text-emerald-400 font-medium">{winner.value.toFixed(3)}</span></span>
							<span className={cn("flex items-center gap-1", winner.status === "terminal" ? "text-emerald-400" : "text-amber-400")}>
								<span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
								{winner.status === "terminal" ? "Converged" : "Searching..."}
							</span>
						</>
					)}
				</div>
				{selected && (
					<div className="flex items-center gap-4 text-xs animate-fade-in">
						<span className="text-muted-foreground">Selected:</span>
						<span className="font-mono text-foreground">{selected.action}</span>
						<span className="text-muted-foreground">v={selected.value.toFixed(3)} n={selected.visits}</span>
					</div>
				)}
			</div>
		</div>
	);
}
