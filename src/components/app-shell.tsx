/**
 * Responsive app shell (issue #21; PRD §27.2): desktop-first fixed sidebar
 * with the eight canonical sections; narrow widths collapse it behind a
 * hamburger in a top bar. Content renders through the <Outlet/>.
 */
import { Building2, CalendarClock, LayoutDashboard, Menu, Monitor, Bell, ArrowLeftRight, Cpu, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { Button } from "./ui/button";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "../lib/utils";

export interface NavSection {
  label: string;
  path: string;
  icon: LucideIcon;
}

/** PRD §27.2 sidebar — labels are canonical; order matters. */
export const NAV_SECTIONS: NavSection[] = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Monitors", path: "/monitors", icon: Monitor },
  { label: "Clients", path: "/clients", icon: Building2 },
  { label: "Incidents", path: "/incidents", icon: TriangleAlert },
  { label: "Maintenance", path: "/maintenance", icon: CalendarClock },
  { label: "Notifications", path: "/notifications", icon: Bell },
  { label: "Import / Export", path: "/import-export", icon: ArrowLeftRight },
  { label: "System", path: "/system", icon: Cpu },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {NAV_SECTIONS.map(({ label, path, icon: Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === "/"}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )
          }
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen">
      {/* Mobile top bar (narrow widths) */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-card px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-expanded={mobileNavOpen} aria-label="Toggle navigation" onClick={() => setMobileNavOpen((open) => !open)}>
            {mobileNavOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </Button>
          <span className="font-semibold">Morabeza Uptime</span>
        </div>
        <ThemeToggle />
      </header>
      {mobileNavOpen && (
        <div className="border-b bg-card px-4 py-3 lg:hidden">
          <NavLinks onNavigate={() => setMobileNavOpen(false)} />
        </div>
      )}

      <div className="mx-auto flex w-full max-w-7xl">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col justify-between border-r bg-card px-4 py-6 lg:flex">
          <div>
            <div className="mb-6 px-3">
              <p className="text-base font-semibold leading-tight">Morabeza Uptime</p>
              <p className="text-xs text-muted-foreground">Cloudflare-native monitoring</p>
            </div>
            <NavLinks />
          </div>
          <div className="flex items-center justify-between border-t pt-4">
            <span className="text-xs text-muted-foreground">UTC · Cape Verde</span>
            <ThemeToggle />
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
