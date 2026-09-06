/**
 * Dark/light theme (issue #21, optional per scope): toggles the `dark` class
 * on <html> and persists the choice in localStorage. The initial theme is
 * applied in main.tsx before first paint — as a bundled module, NOT an
 * inline script (CSP-friendly, §29.11 coordination).
 */
import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";

const THEME_STORAGE_KEY = "morabeza-theme";
export type Theme = "light" | "dark";

export function applyStoredTheme(storage: Storage = localStorage): void {
  const stored = storage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    document.documentElement.classList.toggle("dark", stored === "dark");
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setTheme(next);
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
      {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </Button>
  );
}
