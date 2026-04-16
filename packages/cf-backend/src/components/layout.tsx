import { Outlet, NavLink } from "react-router-dom";
import { PoweredByCloudflare } from "@cloudflare/kumo";
import { BrainIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { ModeToggle } from "./mode-toggle";

const NAV = [
  { to: "/", icon: SquaresFourIcon, label: "Agents", end: true },
] as const;

export default function Layout() {
  return (
    <div className="flex h-screen p-bg p-text">
      {/* Sidebar — always expanded with icon + label */}
      <aside className="flex flex-col w-52 border-r p-sidebar" style={{ borderColor: "var(--c-border)" }}>
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 py-4">
          <BrainIcon size={22} weight="duotone" className="p-accent" />
          <span className="text-[15px] font-semibold tracking-tight">Proteus</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 space-y-0.5">
          {NAV.map(({ to, icon: Icon, label, ...rest }) => (
            <NavLink key={to} to={to} end={"end" in rest}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                  isActive
                    ? "p-nav-active font-medium"
                    : "p-text-2 hover:p-text hover:bg-[var(--c-accent-subtle)]"
                }`
              }
            >
              <Icon size={16} weight="bold" className="shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 space-y-2 border-t" style={{ borderColor: "var(--c-border)" }}>
          <div className="flex items-center justify-between">
            <ModeToggle />
            <span className="text-[10px] p-text-3">v0.1</span>
          </div>
          <div className="flex justify-center">
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden p-bg">
        <Outlet />
      </main>
    </div>
  );
}
