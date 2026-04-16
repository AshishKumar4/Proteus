import { cn } from "@/lib/utils";

interface Props {
	value: number;
	className?: string;
	showLabel?: boolean;
}

function ScoreBar({ value, className, showLabel = true }: Props) {
	const color = value >= 0.7 ? "bg-emerald-400" : value >= 0.4 ? "bg-amber-400" : "bg-red-400";
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
				<div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${value * 100}%` }} />
			</div>
			{showLabel && <span className="text-xs font-mono text-muted-foreground w-8 text-right">{value.toFixed(2)}</span>}
		</div>
	);
}

export { ScoreBar };
