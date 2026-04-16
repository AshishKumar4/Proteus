import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Variant = "default" | "secondary" | "destructive" | "success" | "warning" | "outline";

const VARIANTS: Record<Variant, string> = {
	default: "bg-primary/15 text-primary ring-primary/25",
	secondary: "bg-muted text-foreground ring-white/10",
	destructive: "bg-destructive/15 text-red-300 ring-red-500/20",
	success: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25",
	warning: "bg-amber-500/15 text-amber-300 ring-amber-500/25",
	outline: "bg-transparent text-muted-foreground ring-white/10",
};

interface Props extends HTMLAttributes<HTMLSpanElement> {
	variant?: Variant;
}

function Badge({ className, variant = "default", ...props }: Props) {
	return (
		<span
			className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", VARIANTS[variant], className)}
			{...props}
		/>
	);
}

export { Badge, type Props as BadgeProps };
