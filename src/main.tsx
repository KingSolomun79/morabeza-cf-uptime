import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyStoredTheme } from "./components/theme-toggle";
import "./index.css";

// Apply the persisted theme BEFORE first render — a bundled module, not an
// inline script (CSP-friendly, issue #21 / §29.11 coordination).
applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
