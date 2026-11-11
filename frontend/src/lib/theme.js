// Theme: auto -> dark -> light. "auto" follows the system; the choice is shared by both pages.
import { useEffect, useState } from "react";

const THEMES = ["auto", "dark", "light"];
const read = () => { try { const t = localStorage.getItem("autocto:theme"); return THEMES.includes(t) ? t : "auto"; } catch (_) { return "auto"; } };
const media = matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(t = read()) {
  document.documentElement.classList.toggle("dark", t === "dark" || (t === "auto" && media.matches));
}

export function useTheme() {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    applyTheme(theme);
    const onChange = () => applyTheme(theme);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  const cycle = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { if (next === "auto") localStorage.removeItem("autocto:theme"); else localStorage.setItem("autocto:theme", next); } catch (_) {}
    setTheme(next);
  };
  return [theme, cycle];
}
