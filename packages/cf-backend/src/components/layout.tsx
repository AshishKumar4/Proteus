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
    setCollapsed(p => {
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
    <div className="flex h-screen bg-kumo-elevated text-kumo-default">
      <aside className={`flex flex-col border-r border-kumo-line bg-kumo-base transition-all duration-200 ${collapsed ? "w-14" : "w-56"}`}>
        <div className="p-3 pb-2">
          {collapsed ? (
            <div className="flex h-8 items-center justify-center">
              <Button variant="ghost" shape="square" onClick={toggle} icon={<SidebarSimpleIcon size={16} />} aria-label="Expand sidebar" />
            </div>
          ) : (
            <div className="flex h-8 items-center justify-between">
              <div className="flex items-center gap-2">
                <BrainIcon size={20} weight="duotone" className="text-kumo-accent" />
                <span className="text-lg font-bold tracking-tight">Proteus</span>
              </div>
              <Button variant="ghost" shape="square" size="sm" onClick={toggle} icon={<SidebarSimpleIcon size={14} />} aria-label="Collapse sidebar" />
            </div>
          )}
        </div>
        <nav className="flex-1 px-2 py-1 space-y-0.5">
          {NAV_ITEMS.map(({ to, icon: Icon, label, ...rest }) => (
            <NavLink key={to} to={to} end={"end" in rest}
              className={({ isActive }) => `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${collapsed ? "justify-center px-0" : ""} ${isActive ? "bg-kumo-accent/15 text-kumo-accent font-medium" : "text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated"}`}
            >
              <Icon size={16} weight="bold" className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className={`border-t border-kumo-line p-2 flex flex-col gap-2 ${collapsed ? "items-center" : ""}`}>
          <div className={collapsed ? "" : "flex items-center justify-between"}>
            <ModeToggle />
            {!collapsed && <span className="text-xs text-kumo-inactive">v0.1</span>}
          </div>
          {!collapsed && (
            <div className="flex justify-center">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
