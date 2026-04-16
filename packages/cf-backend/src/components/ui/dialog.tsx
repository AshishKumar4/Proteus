import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { ReactNode, HTMLAttributes, MouseEvent } from "react";

interface DialogProps {
	open: boolean;
	onClose: () => void;
	children: ReactNode;
	className?: string;
}

function Dialog({ open, onClose, children, className }: DialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const onCloseRef = useRef(onClose);
	useEffect(() => { onCloseRef.current = onClose; });

	useEffect(() => {
		const el = dialogRef.current;
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	}, [open]);

	useEffect(() => {
		const el = dialogRef.current;
		if (!el) return;
		const handler = (e: Event) => { e.preventDefault(); onCloseRef.current(); };
		el.addEventListener("cancel", handler);
		return () => el.removeEventListener("cancel", handler);
	}, []);

	const handleBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
		if (e.target === dialogRef.current) onClose();
	};

	if (!open) return null;

	return createPortal(
		<dialog
			ref={dialogRef}
			onClick={handleBackdrop}
			className="backdrop:bg-black/60 backdrop:backdrop-blur-[1px] fixed inset-0 z-50 m-0 flex h-dvh w-dvw items-center justify-center bg-transparent p-4"
		>
			<div className={cn("w-full max-w-lg rounded-xl bg-card p-6 shadow-xl ring-1 ring-white/10 animate-scale-in", className)}>
				{children}
			</div>
		</dialog>,
		document.body,
	);
}

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("mb-4", className)} {...props} />;
}

function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
	return <h2 className={cn("text-lg font-semibold", className)} {...props} />;
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}

export { Dialog, DialogHeader, DialogTitle, DialogFooter };
