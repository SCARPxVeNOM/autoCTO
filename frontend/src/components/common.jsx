// Small pieces shared by the app's views.
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { GLOSSARY, ago, hue, left } from "@/lib/chain";
import { iconUrl, useIcons } from "@/lib/icons";

/** Re-render once a second, so countdowns move between chain refreshes. */
export function useTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
}
export const Ago = ({ ns }) => <time>{ago(ns)}</time>;
export const Left = ({ ns }) => <span>{left(ns)}</span>;

// The mark: a coin wearing a crown, the one that took the others over (rendered, in web/brand/).
const MARK = new URL("brand/autocto.webp", document.baseURI).href;
export const Logo = ({ className }) => (
  <img className={cn("size-[34px] flex-none select-none drop-shadow-sm", className)} src={MARK} width="34" height="34" alt="" draggable="false" />
);
export const Wordmark = () => <span className="font-pixel text-xl font-semibold leading-none">Auto<span className="text-up">CTO</span></span>;

// A coin's own icon (stored on chain at launch) is shown only if it is an image data URL or an https link.
const ownIcon = (icon) => (typeof icon === "string" && /^(data:image\/[a-z+.-]+[;,]|https:\/\/)/i.test(icon) ? icon : null);

export function Avatar({ symbol, icon, size = 38, className }) {
  useIcons();
  const src = ownIcon(icon) || iconUrl(symbol);
  const [broken, setBroken] = useState(null);
  const style = { "--h": hue(symbol || "?"), width: size, height: size, borderRadius: size * 0.31, fontSize: size * 0.39 };
  if (src && broken !== src) return <img className={cn("ava ava-img", className)} style={style} src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(src)} />;
  return <span className={cn("ava", className)} aria-hidden="true" style={style}>{String(symbol || "?").slice(0, 2)}</span>;
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

/** The top of a page: what it is for in one line, and its main action on the right. */
export const PageHead = ({ icon: Icon, title, lede, children }) => (
  <header className="flex flex-wrap items-end gap-x-6 gap-y-4 border-b border-dashed border-line px-6 pb-6 pt-7 max-sm:px-4 max-sm:pt-5">
    <div className="grid max-w-[66ch] gap-2">
      <h1 className="flex items-center gap-3 text-[28px] font-semibold leading-tight max-sm:text-2xl">
        <span className="grid size-10 flex-none place-items-center rounded-xl bg-primary/12 text-primary" aria-hidden="true"><Icon className="size-5" /></span>{title}
      </h1>
      <p className="text-[15px] text-muted-foreground">{lede}</p>
    </div>
    {children && <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0">{children}</div>}
  </header>
);

export const SectionHead = ({ title, note, children }) => (
  <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-6 max-sm:px-4">
    <h2 className="text-[22px] font-semibold">{title}</h2>
    {note && <span className="text-[12.5px] text-muted-foreground">{note}</span>}
    {children}
  </div>
);
