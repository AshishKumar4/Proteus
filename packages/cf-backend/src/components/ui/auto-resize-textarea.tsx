import { forwardRef, useEffect, useRef } from "react";
import type { TextareaHTMLAttributes } from "react";

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	maxHeight?: number;
}

const AutoResizeTextarea = forwardRef<HTMLTextAreaElement, Props>(
	({ maxHeight = 200, className, value, onInput, ...props }, ref) => {
		const innerRef = useRef<HTMLTextAreaElement>(null);

		const handleRef = (node: HTMLTextAreaElement | null) => {
			innerRef.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		};

		useEffect(() => {
			if (innerRef.current) {
				innerRef.current.style.height = "auto";
				innerRef.current.style.height = `${Math.min(innerRef.current.scrollHeight, maxHeight)}px`;
			}
		}, [value, maxHeight]);

		return (
			<textarea
				ref={handleRef}
				value={value}
				onInput={(e) => {
					const el = e.currentTarget;
					el.style.height = "auto";
					el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
					onInput?.(e);
				}}
				className={className}
				{...props}
			/>
		);
	},
);
AutoResizeTextarea.displayName = "AutoResizeTextarea";

export { AutoResizeTextarea };
