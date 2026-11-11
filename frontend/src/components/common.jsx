// Small pieces shared by the app's views.
import { useEffect, useState } from "react";
import { ChevronDown, Swords } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { GLOSSARY, ago, hue, left } from "@/lib/chain";

/** Re-render once a second, so countdowns move between chain refreshes. */
export function useTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
}
export const Ago = ({ ns }) => <time>{ago(ns)}</time>;
export const Left = ({ ns }) => <span>{left(ns)}</span>;

export function Logo({ className }) {
  return (
    <span className={cn("grid size-[34px] place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-sm", className)} aria-hidden="true">
      <Swords className="size-[18px]" />
    </span>
  );
}
export const Wordmark = () => <span className="font-pixel text-xl font-semibold leading-none">AutoCTO</span>;

export function Avatar({ symbol, size = 38, className }) {
  return (
    <span className={cn("ava", className)} aria-hidden="true"
      style={{ "--h": hue(symbol || "?"), width: size, height: size, borderRadius: size * 0.31, fontSize: size * 0.39 }}>
      {String(symbol || "?").slice(0, 2)}
    </span>
  );
}

const TONES = {
  up: "bg-up/15 text-up", down: "bg-down/15 text-down", warn: "bg-warn/15 text-warn",
  brand: "bg-primary/15 text-primary", muted: "bg-muted text-muted-foreground",
};
/** Secondary detail, folded away until asked for. */
export function More({ label = "Details", className, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("grid gap-3", className)}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 justify-self-start text-[13px] text-muted-foreground hover:text-foreground">
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />{open ? "Less" : label}
      </button>
      {open && children}
    </div>
  );
}

/** A status pill: green, red, amber, brand or grey. */
export const Pill = ({ tone = "muted", className, ...props }) => (
  <Badge variant="secondary" className={cn("border-transparent font-semibold", TONES[tone], className)} {...props} />
);

/** A word with a plain explanation on hover, focus or tap. */
export function Term({ k, children, className }) {
  const text = GLOSSARY[k];
  if (!text) return children ?? k;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("cursor-help underline decoration-muted-foreground/60 decoration-dotted underline-offset-[3px]", className)}>{children ?? k}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-[13px] leading-snug">
        <b className="mb-0.5 block font-mono text-[11px] uppercase tracking-wide opacity-70">{k}</b>{text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A thin bar with stacked segments (percent widths) and an optional threshold tick. */
export function Meter({ parts, mark }) {
  let at = 0;
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
      {parts.map(([pct, cls], k) => {
        const el = <div key={k} className={cn("absolute inset-y-0 transition-all duration-500", cls)} style={{ left: `${at}%`, width: `${pct}%` }} />;
        at += pct;
        return el;
      })}
      {mark != null && <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${mark}%` }} />}
    </div>
  );
}

export const SectionHead = ({ title, note, children }) => (
  <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-6 max-sm:px-4">
    <h2 className="text-[22px] font-semibold">{title}</h2>
    {note && <span className="text-[12.5px] text-muted-foreground">{note}</span>}
    {children}
  </div>
);
