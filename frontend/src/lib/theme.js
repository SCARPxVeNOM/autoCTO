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

/** Whether the page is dark right now, following applyTheme. */
export function useDark() {
  const html = document.documentElement;
  const [dark, setDark] = useState(() => html.classList.contains("dark"));
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(html.classList.contains("dark")));
    mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}
