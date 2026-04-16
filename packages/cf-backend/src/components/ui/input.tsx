import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
	({ className, ...props }, ref) => (
		<input
			ref={ref}
			className={cn(
				"flex h-9 w-full rounded-lg border border-white/10 bg-input px-3 py-1 text-sm text-foreground transition-colors",
				"placeholder:text-muted-foreground/50",
				"focus-visible:outline-none focus-visible:border-primary/40",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);
Input.displayName = "Input";

export { Input };
