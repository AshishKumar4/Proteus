import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("animate-pulse rounded-lg bg-white/[0.06]", className)}
			{...props}
		/>
	);
}

export { Skeleton };
