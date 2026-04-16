import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "destructive" | "outline" | "ghost";
type Size = "default" | "sm" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
	default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
	secondary: "bg-muted text-foreground shadow-sm hover:bg-muted/80",
	destructive: "bg-destructive text-white shadow-sm hover:bg-destructive/90",
	outline: "border border-white/10 bg-transparent hover:bg-white/5",
	ghost: "hover:bg-white/5",
};

const SIZES: Record<Size, string> = {
	default: "h-9 px-4 py-2",
	sm: "h-8 px-3 text-xs",
	lg: "h-10 px-6",
	icon: "h-8 w-8",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
}

const Button = forwardRef<HTMLButtonElement, Props>(
	({ className, variant = "default", size = "default", ...props }, ref) => (
		<button
			ref={ref}
			className={cn(
				"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				VARIANTS[variant], SIZES[size], className,
			)}
			{...props}
		/>
	),
);
Button.displayName = "Button";

export { Button, type Props as ButtonProps };
