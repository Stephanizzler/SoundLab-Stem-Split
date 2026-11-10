import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { color, radius, space } from "@soundlab/design";
import { App } from "./ui/App.tsx";
import "./styles.css";

// The shared SoundLab Pro tokens become CSS variables, so the look follows SoundLab-Core.
const root = document.documentElement.style;
for (const [k, v] of Object.entries(color)) root.setProperty(`--${k}`, v);
for (const [k, v] of Object.entries(radius)) root.setProperty(`--radius-${k}`, `${v}px`);
for (const [k, v] of Object.entries(space)) root.setProperty(`--space-${k}`, `${v}px`);

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
