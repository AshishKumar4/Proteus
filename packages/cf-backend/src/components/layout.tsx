import { useState, useCallback, useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { PoweredByCloudflare } from "@cloudflare/kumo";
import { BrainIcon, SquaresFourIcon, SidebarSimpleIcon, GearSixIcon } from "@phosphor-icons/react";
import { ModeToggle } from "./mode-toggle";

const NAV = [
  { to: "/", icon: SquaresFourIcon, label: "Agents", end: true },
] as const;

export default function Layout() {
  const location = useLocation();
  const isWorkspace = location.pathname.startsWith("/agent/") || location.pathname.startsWith("/mcts/") || location.pathname.startsWith("/settings/");
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem("proteus:sidebar");
    return saved ? saved === "true" : isWorkspace;
  });

  const toggle = useCallback(() => {
    setCollapsed(p => { const next = !p; localStorage.setItem("proteus:sidebar", String(next)); return next; });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className="flex h-screen p-bg p-text">
      <aside
        className={`flex flex-col border-r transition-[width] duration-200 ease-out p-sidebar ${collapsed ? "w-[52px]" : "w-[200px]"}`}
        style={{ borderColor: "var(--c-border)" }}
      >
        {/* Brand */}
        <div className={`flex items-center h-14 ${collapsed ? "justify-center px-0" : "px-4 gap-2.5"}`}>
          <button onClick={toggle} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity" title={collapsed ? "Expand (Cmd+B)" : "Collapse (Cmd+B)"}>
            {collapsed ? (
              <BrainIcon size={22} weight="duotone" className="p-accent" />
            ) : (
              <>
                <BrainIcon size={20} weight="duotone" className="p-accent" />
                <span className="text-sm font-semibold tracking-tight p-text">Proteus</span>
              </>
            )}
          </button>
          {!collapsed && (
            <button onClick={toggle} className="ml-auto p-text-3 hover:p-text-2 transition-colors" title="Collapse (Cmd+B)">
              <SidebarSimpleIcon size={14} />
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className={`flex-1 ${collapsed ? "px-1.5" : "px-2.5"} py-1`}>
          {NAV.map(({ to, icon: Icon, label, ...rest }) => (
            <NavLink key={to} to={to} end={"end" in rest}
              className={({ isActive }) => {
                const base = "flex items-center rounded-md transition-colors text-[13px]";
                const layout = collapsed ? "justify-center p-2" : "gap-2.5 px-2.5 py-[7px]";
                const state = isActive
                  ? "p-nav-active font-medium"
                  : "p-text-2 hover:p-text hover:bg-[var(--c-surface)]";
                return `${base} ${layout} ${state}`;
              }}
            >
              <Icon size={collapsed ? 18 : 15} weight="bold" className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className={`border-t py-2.5 ${collapsed ? "px-1.5 flex flex-col items-center gap-1.5" : "px-3 space-y-2"}`} style={{ borderColor: "var(--c-border)" }}>
          <div className={collapsed ? "" : "flex items-center justify-between"}>
            <ModeToggle />
            {!collapsed && <span className="text-[10px] p-text-3 font-mono">v0.1</span>}
          </div>
          {!collapsed && (
            <div className="flex justify-center opacity-60 hover:opacity-100 transition-opacity">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden p-bg">
        <Outlet />
      </main>
    </div>
  );
}
