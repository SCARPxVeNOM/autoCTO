// The live 3D arena at the top of the landing: the latest takeover on the launchpad, replayed from the
// chain. The page draws the words (labels, the brain's bubble, the caption, the steps); arena3d.js
// draws the coins with three.js and moves the words over them.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDark } from "@/lib/theme";
import { iconUrl, useIcons } from "@/lib/icons";

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STEP = { lock: "Lock", think: "Brain wakes", offer: "Bid", late: "Late lock", stance: "Rival's brain", vote: "Vote", passed: "Passed", merge: "Merge", swap: "Swap" };
const fmtCap = (n) => `${n.toLocaleString("en", { maximumFractionDigits: n < 1 ? 3 : 2 })} Ⓝ`;

/** Whether this browser can draw the arena at all. */
export const canArena = (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })();

// The scene takes the page's own colours, so it follows the theme.
function palette(el) {
  const s = getComputedStyle(el), get = (n) => s.getPropertyValue(n).trim();
  return { primary: get("--primary"), up: get("--up"), down: get("--down"), muted: get("--muted-foreground"), fg: get("--foreground") };
}

/** Holds the arena's place while the chain is read. */
export const ArenaWait = () => <div className="arena wait"><p>Reading the latest takeover from the chain…</p></div>;

export default function Arena({ replay, where, recorded, launchpad, app, onFail }) {
  const host = useRef(null), bubble = useRef(null), labels = useRef(new Map()), api = useRef(null);
  const B = replay.beats;
  const iMerge = B.findIndex((b) => b.kind === "merge");
  const [k, setK] = useState(calm ? Math.max(0, B.findIndex((b) => b.kind === "offer")) : 0);
  const [playing, setPlaying] = useState(!calm);
  const [ready, setReady] = useState(false);
  const dark = useDark();
  const icons = useIcons();
  const beat = B[k];
  const sym = (id) => `$${replay.coins.find((c) => c.id === id)?.symbol}`;
  // Opening a coin: the app shows whichever coin was picked last.
  const remember = (id) => { try { localStorage.setItem(`autocto:coin:${launchpad}`, id); } catch (_) {} };

  useEffect(() => {
    let made = null, dead = false, seen = false;
    const io = new IntersectionObserver(([en]) => { seen = en.isIntersecting; made?.setVisible(seen); });
    io.observe(host.current);
    import("./arena3d.js").then(({ createArena }) => {
      if (dead) return;
      made = createArena(host.current, replay, {
        calm, start: k, labels: labels.current, bubble: bubble.current, onBeat: setK, iconOf: iconUrl,
        onPick: (id) => { remember(id); location.href = `${app}#trade`; },
        theme: { colors: palette(host.current), dark: document.documentElement.classList.contains("dark") },
      });
      api.current = made;
      made.setVisible(seen);
      setReady(true);
    }).catch((e) => { console.warn("arena", e); if (!dead) onFail?.(); });
    return () => { dead = true; io.disconnect(); made?.dispose(); api.current = null; };
  }, [replay]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.current?.setTheme({ colors: palette(host.current), dark }); }, [dark]);
  useEffect(() => { api.current?.setPlaying(playing); }, [playing, ready]);
  useEffect(() => { api.current?.loadIcons(); }, [icons, ready]);

  return (
    <div className={cn("arena", ready && "ready")} ref={host} role="region" aria-label={`A replay of the latest takeover on ${where}`}>
      <canvas aria-hidden="true" />
      <div className="ar-top">
        <span className="ar-live"><i /><span>{recorded ? `Recorded from ${where}` : <>Replayed from {where}<span className="ar-when">, read just now</span></>}</span></span>
        <span className="ar-size">coin size = market cap</span>
        <button type="button" className="ar-play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause the replay" : "Play the replay"} hidden={calm}>
          {playing ? <Pause /> : <Play />}
        </button>
      </div>
      {replay.coins.map((c) => {
        // The winner shows its size from before the merge until it happens; the target, its size before it went.
        const won = c.id === replay.winner && iMerge >= 0 && k >= iMerge;
        const cap = c.id === replay.target || (c.id === replay.winner && !won) ? c.before : c.cap;
        return (
          <a key={c.id} className="ar-label" href={`${app}#trade`} onClick={() => remember(c.id)} ref={(el) => (el ? labels.current.set(c.id, el) : labels.current.delete(c.id))}>
            <b>${c.symbol}</b><small>{fmtCap(cap)}</small>
            {won && <em>ate {sym(replay.target)}</em>}
          </a>
        );
      })}
      <figure className={cn("ar-bubble", beat.quote && "on", beat.no && "no")} ref={bubble} aria-hidden={!beat.quote}>
        {beat.quote && <><figcaption>{beat.by}</figcaption><blockquote>“{beat.quote}”</blockquote></>}
      </figure>
      <div className="ar-cap">
        <span className="ar-n">{String(k + 1).padStart(2, "0")} / {String(B.length).padStart(2, "0")} · {STEP[beat.kind]}</span>
        <p>{beat.text}</p>
        <a href="#receipts">Every transaction<ArrowDown /></a>
      </div>
      <ol className="ar-steps">
        {B.map((b, n) => (
          <li key={n} className={n === k ? "on" : n < k ? "past" : ""}>
            <button type="button" aria-label={`Step ${n + 1}: ${STEP[b.kind]}`} aria-current={n === k ? "step" : undefined}
              onClick={() => { setPlaying(false); api.current?.setBeat(n); }}><span>{STEP[b.kind]}</span></button>
          </li>
        ))}
      </ol>
    </div>
  );
}
