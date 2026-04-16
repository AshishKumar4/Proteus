import { useState, useCallback } from "react";
import { Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
	placeholder?: string;
	onSubmit?: (text: string) => void;
	compact?: boolean;
	disabled?: boolean;
}

export function PromptInput({ placeholder, onSubmit, compact, disabled }: Props) {
	const [input, setInput] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const isDisabled = disabled || submitting;

	const handleSubmit = useCallback(() => {
		const text = input.trim();
		if (!text || isDisabled) return;
		setSubmitting(true);
		onSubmit?.(text);
		setTimeout(() => { setInput(""); setSubmitting(false); }, 500);
	}, [input, isDisabled, onSubmit]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
	}, [handleSubmit]);

	return (
		<div className={cn(
			"relative border border-white/10 bg-card transition-colors focus-within:border-primary/40",
			compact ? "rounded-lg" : "rounded-xl shadow-lg ring-1 ring-white/5",
			isDisabled && "opacity-60",
		)}>
			<textarea
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={placeholder ?? "Describe your agent's mission..."}
				disabled={isDisabled}
				rows={compact ? 1 : 3}
				className={cn(
					"w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50",
					compact ? "text-xs py-2.5 pl-3 pr-16" : "text-sm pl-5 py-4 pr-20",
				)}
			/>
			<div className={cn("absolute right-3 flex items-center", compact ? "top-1/2 -translate-y-1/2" : "bottom-3")}>
				{submitting ? (
					<Loader2 className="h-4 w-4 animate-spin text-primary/60" />
				) : (
					<button
						onClick={handleSubmit}
						disabled={!input.trim() || isDisabled}
						className={cn(
							"rounded-md p-1.5 transition-colors",
							input.trim() && !isDisabled ? "text-primary hover:bg-primary/10" : "text-muted-foreground/30",
						)}
					>
						<Send className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
					</button>
				)}
			</div>
		</div>
	);
}
