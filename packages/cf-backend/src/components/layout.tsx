import { useState, useCallback, useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { Brain, LayoutGrid, Settings2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
	{ to: "/", icon: LayoutGrid, label: "Agents", end: true },
	{ to: "/settings", icon: Settings2, label: "Settings" },
] as const;

export default function Layout() {
	const location = useLocation();
	const isWorkspace = location.pathname.startsWith("/agent/") || location.pathname.startsWith("/mcts/");
	const [collapsed, setCollapsed] = useState(isWorkspace);

	useEffect(() => {
		if (isWorkspace && !collapsed) setCollapsed(true);
	}, [isWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggle = useCallback(() => {
		setCollapsed((p) => {
			localStorage.setItem("proteus:sidebar", String(!p));
			return !p;
		});
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); toggle(); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle]);

	return (
		<div className="flex h-screen bg-background text-foreground">
			<aside className={cn(
				"flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
				collapsed ? "w-14" : "w-56",
			)}>
				<div className="p-3 pb-2">
					{collapsed ? (
						<div className="flex h-8 items-center justify-center">
							<button onClick={toggle} className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors" title="Expand (Cmd+B)">
								<PanelLeftOpen className="h-4 w-4" />
							</button>
						</div>
					) : (
						<div className="flex h-8 items-center justify-between">
							<div className="flex items-center gap-2">
								<Brain className="h-5 w-5 text-primary" />
								<span className="text-lg font-bold tracking-tight">Proteus</span>
							</div>
							<button onClick={toggle} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors" title="Collapse (Cmd+B)">
								<PanelLeftClose className="h-3.5 w-3.5" />
							</button>
						</div>
					)}
				</div>

				<nav className="flex-1 px-2 py-1 space-y-0.5">
					{NAV_ITEMS.map(({ to, icon: Icon, label, ...rest }) => (
						<NavLink
							key={to}
							to={to}
							end={"end" in rest}
							className={({ isActive }) => cn(
								"flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
								collapsed && "justify-center px-0",
								isActive
									? "bg-primary/15 text-primary font-medium"
									: "text-muted-foreground hover:text-foreground hover:bg-white/5",
							)}
						>
							<Icon className="h-4 w-4 shrink-0" />
							{!collapsed && <span>{label}</span>}
						</NavLink>
					))}
				</nav>

				<div className={cn("border-t border-sidebar-border p-3 text-xs text-muted-foreground", collapsed && "text-center")}>
					{collapsed ? "v0.1" : "Proteus v0.1.0"}
				</div>
			</aside>

			<main className="flex-1 overflow-hidden">
				<Outlet />
			</main>
		</div>
	);
}
