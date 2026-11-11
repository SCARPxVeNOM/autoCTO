// Notes written in the margin by hand: a line of handwriting and an arrow that draw themselves in
// the first time they come into view. They repeat what the page already says, so screen readers skip them.
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

function useSeen() {
  const ref = useRef(null);
  const [seen, setSeen] = useState(calm);
  useEffect(() => {
    if (seen) return;
    if (!("IntersectionObserver" in globalThis)) { setSeen(true); return; }
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "0px 0px -12% 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

// The two strokes of an arrowhead at `tip`, for a line travelling at `deg` (0 = right, 90 = down).
const head = ([x, y], deg, len = 10) => [deg + 150, deg - 150]
  .map((a) => `M${x} ${y} l${(Math.cos((a * Math.PI) / 180) * len).toFixed(1)} ${(Math.sin((a * Math.PI) / 180) * len).toFixed(1)}`)
  .join(" ");

// Arrow shapes, each drawn once by hand: [width, height, path, tip, direction at the tip].
export const ARROWS = {
  left: [62, 36, "M58 25 C 46 33, 25 31, 15 21 C 11 17, 8 13, 6 10", [6, 10], 220],
  up: [52, 48, "M48 42 C 33 45, 16 37, 12 24 C 10 17, 11 11, 13 5", [13, 5], 285],
  down: [50, 54, "M4 8 C 22 1, 39 10, 42 25 C 44 34, 41 42, 39 49", [39, 49], 100],
};

export function Note({ arrow, className, children }) {
  const [ref, seen] = useSeen();
  const [w, h, d, tip, dir] = ARROWS[arrow];
  return (
    <span ref={ref} className={cn("pen", seen && "in", className)} aria-hidden="true">
      <svg className="pen-arrow" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none">
        <path pathLength="1" d={d} />
        <path pathLength="1" className="pen-head" d={head(tip, dir)} />
      </svg>
      <span className="pen-text">{children}</span>
    </span>
  );
}

// A double pen stroke under a word, drawn in on first sight.
export function Underline({ children }) {
  const [ref, seen] = useSeen();
  return (
    <span ref={ref} className={cn("pen-mark", seen && "in")}>
      {children}
      <svg className="pen-under" viewBox="0 0 200 26" fill="none" aria-hidden="true">
        <path pathLength="1" d="M4 15 C 46 8, 118 5, 196 10" />
        <path pathLength="1" d="M22 22 C 74 16, 134 14, 184 18" />
      </svg>
    </span>
  );
}
