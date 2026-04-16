import { useState, useCallback, useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { Button, PoweredByCloudflare } from "@cloudflare/kumo";
import { BrainIcon, SquaresFourIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { ModeToggle } from "./mode-toggle";

const NAV_ITEMS = [
  { to: "/", icon: SquaresFourIcon, label: "Agents", end: true },
] as const;

export default function Layout() {
  const location = useLocation();
  const isWorkspace = location.pathname.startsWith("/agent/") || location.pathname.startsWith("/mcts/");
  const [collapsed, setCollapsed] = useState(isWorkspace);

  useEffect(() => {
    if (isWorkspace && !collapsed) setCollapsed(true);
  }, [isWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(() => {
    setCollapsed(p => { localStorage.setItem("proteus:sidebar", String(!p)); return !p; });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className="flex h-screen bg-kumo-elevated text-kumo-default">
      <aside
        className={`flex flex-col border-r p-divider transition-all duration-200 ${collapsed ? "w-[52px]" : "w-56"}`}
        style={{ background: "color-mix(in oklch, var(--color-kumo-base) 95%, black 5%)" }}
      >
        {/* Brand */}
        <div className="p-3 pb-1">
          {collapsed ? (
            <div className="flex items-center justify-center py-1">
              <button onClick={toggle} className="p-1.5 rounded-lg text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated transition-colors" title="Expand (Cmd+B)">
                <BrainIcon size={22} weight="duotone" className="p-accent" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <BrainIcon size={20} weight="duotone" className="p-accent" />
                <span className="text-base font-semibold tracking-tight">Proteus</span>
              </div>
              <Button variant="ghost" shape="square" size="sm" onClick={toggle} icon={<SidebarSimpleIcon size={14} />} aria-label="Collapse" />
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-2 space-y-1">
          {NAV_ITEMS.map(({ to, icon: Icon, label, ...rest }) => (
            <NavLink key={to} to={to} end={"end" in rest}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${collapsed ? "justify-center px-0" : ""} ${
                  isActive
                    ? "bg-kumo-elevated text-kumo-default font-medium"
                    : "text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated/60"
                }`
              }
            >
              <Icon size={collapsed ? 20 : 16} weight="bold" className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className={`border-t p-divider p-2 flex flex-col gap-1.5 ${collapsed ? "items-center" : ""}`}>
          <ModeToggle />
          {!collapsed && (
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-kumo-inactive">v0.1</span>
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-hidden"><Outlet /></main>
    </div>
  );
}
