// The live 3D arena at the top of the landing: the latest takeover on the launchpad, replayed from the
// chain. The page draws the words (labels, the brain's bubble, the beat's readout, the caption, the steps);
// arena3d.js films the coins with three.js and moves the words over them. The arena is always dark.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { iconUrl, useIcons } from "@/lib/icons";
import { durationOf } from "./replay";

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STEP = { lock: "Lock", think: "Brain wakes", offer: "Bid", late: "Late lock", stance: "Rival's brain", vote: "Vote", passed: "Passed", merge: "Merge", swap: "Swap" };
const fmtCap = (n) => `${n.toLocaleString("en", { maximumFractionDigits: n < 1 ? 3 : 2 })} Ⓝ`;
const pct = (x) => `${+(x * 100).toFixed(1)}%`;

/** Whether this browser can draw the arena at all. */
export const canArena = (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })();

// The scene takes the page's own colours (the dark set, as the arena is dark).
function palette(el) {
  const s = getComputedStyle(el), get = (n) => s.getPropertyValue(n).trim();
  return { primary: get("--primary"), up: get("--up"), down: get("--down"), warn: get("--warn"), muted: get("--muted-foreground"), fg: get("--foreground"), bg: get("--background") };
}

/** Holds the arena's place while the chain is read. */
export const ArenaWait = () => <div className="arena dark wait"><p>Reading the latest takeover from the chain…</p></div>;

const Row = ({ k, children }) => <div className="hud-row"><span>{k}</span><b>{children}</b></div>;

// The beat's readout: its numbers from the chain, set beside whatever the camera is on.
// `locked` is what the lock beat locked, which the late beat sets against the late lock.
function Readout({ beat: b, W, T, locked }) {
  switch (b.kind) {
    case "lock": return <>
      <p className="hud-k">Locked</p><p className="hud-v">{b.amount} {T}</p>
      <p className="hud-note">Can vote on any bid made after this</p>
    </>;
    case "think": return <>
      <p className="hud-k">{W}'s brain</p>
      {b.fee && <Row k="wake fee">{b.fee}</Row>}
      <Row k="runs in">OutLayer TEE</Row>
      <Row k="answer">signed, checked on chain</Row>
    </>;
    case "offer": return <>
      <p className="hud-k">Bid</p><p className="hud-v">{b.rate.toFixed(4)} <small>{W} per {T}</small></p>
      <Row k="vs fair rate">{b.bps >= 0 ? "+" : "−"}{(Math.abs(b.bps) / 100).toFixed(1)}%</Row>
    </>;
    case "late": return <>
      <p className="hud-k">What counts</p>
      <ol className="hud-time">
        <li className="yes"><Check /><span>Lock</span><b>{locked}</b></li>
        <li><i /><span>Bid</span></li>
        <li className="no"><X /><span>Late lock</span><b>{b.amount}</b></li>
        <li><i /><span>Vote</span></li>
      </ol>
      <p className="hud-note">Only tokens locked before the bid vote on it</p>
    </>;
    case "stance": return <>
      <p className="hud-k">{T}'s brain weighs</p>
      <ul className="hud-opts">
        <li data-o="accept">Vote YES</li>
        <li data-o="counter">Counter-offer</li>
        <li data-o="reject">Vote NO</li>
      </ul>
      <p className="hud-note">Advice to its holders. They decide.</p>
    </>;
    case "vote": return <>
      <p className="hud-k">Vote</p>
      <div className="hud-bars" style={{ "--yes": b.yesShare, "--need": b.approval ?? 0.5 }}>
        <div className="yes"><span>YES</span><i /><b>{b.yesTokens}</b></div>
        <div className="no"><span>NO</span><i /><b>{b.noTokens}</b></div>
      </div>
      {b.approval != null && <Row k="needs">{pct(b.approval)} YES</Row>}
      <Row k="voted">{b.voters} holder{b.voters === 1 ? "" : "s"}</Row>
    </>;
    case "passed": return <>
      <p className="hud-k">Result</p><p className="hud-v up"><Check />Passed</p>
      <p className="hud-note">Anyone can carry it out now</p>
    </>;
    case "merge": return <>
      <p className="hud-k">Merged</p><p className="hud-v">{b.near} <small>NEAR in</small></p>
      <Row k="from">{T}'s curve + treasury</Row>
      <Row k="next">{T} holders can swap</Row>
    </>;
    case "swap": return <>
      <p className="hud-k">Swapped</p><p className="hud-v">{b.amount} <small>{T} → {W}</small></p>
      <Row k="at">{b.rate}</Row>
      <Row k="by">{b.count} holder{b.count === 1 ? "" : "s"}</Row>
    </>;
    default: return null;
  }
}
export default function Arena({ replay, where, recorded, launchpad, app, onFail }) {
  const host = useRef(null), bubble = useRef(null), hud = useRef(null), labels = useRef(new Map()), api = useRef(null);
  const B = replay.beats;
  const iMerge = B.findIndex((b) => b.kind === "merge");
  const [k, setK] = useState(0);
  // Nothing plays until the visitor asks: a still of the coins and a play button, which comes back at the end.
  const [started, setStarted] = useState(false), [ended, setEnded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const icons = useIcons();
  const beat = B[k];
  const sym = (id) => `$${replay.coins.find((c) => c.id === id)?.symbol}`;
  const secs = Math.round(B.reduce((s, b, n) => s + durationOf(b, n === B.length - 1), 0) / 1000);
  // Opening a coin: the app shows whichever coin was picked last.
  const remember = (id) => { try { localStorage.setItem(`autocto:coin:${launchpad}`, id); } catch (_) {} };
  const go = (n) => { setStarted(true); setPlaying(false); api.current?.setBeat((n + B.length) % B.length); };
  // Before it has started, the arrows start it at the first step.
  const step = (d) => go(started ? k + d : 0);
  const play = () => { api.current?.setBeat(0); setStarted(true); setPlaying(!calm); };
  const toggle = () => (started ? setPlaying(!playing) : play());
  const keys = (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === " " && e.target === e.currentTarget && !(calm && started)) { e.preventDefault(); toggle(); }
  };

  useEffect(() => {
    let made = null, dead = false, seen = false;
    const io = new IntersectionObserver(([en]) => { seen = en.isIntersecting; made?.setVisible(seen); });
    io.observe(host.current);
    import("./arena3d.js")
      .then(({ createArena }) => (dead ? null : createArena(host.current, replay, {
        calm, start: 0, intro: true, labels: labels.current, bubble: bubble.current, hud: hud.current, onBeat: setK, iconOf: iconUrl,
        onEnd: () => { setStarted(false); setPlaying(false); setEnded(true); },
        onPick: (id) => { remember(id); location.href = `${app}#trade`; },
        theme: { colors: palette(host.current) },
      })))
      .then((m) => {
        if (!m) return;
        if (dead) { m.dispose(); return; }
        made = api.current = m;
        made.setVisible(seen);
        setReady(true);
      })
      .catch((e) => { console.warn("arena", e); if (!dead) onFail?.(); });
    return () => { dead = true; io.disconnect(); made?.dispose(); api.current = null; };
  }, [replay]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.current?.setPlaying(playing); }, [playing, ready]);
  useEffect(() => { api.current?.loadIcons(); }, [icons, ready]);

  return (
    <div className={cn("arena dark", ready && "ready", started && "started")} ref={host} role="region" tabIndex={0} onKeyDown={keys}
      aria-label={`A replay of the latest takeover on ${where}. Left and right arrows step through it.`}>
      <canvas aria-hidden="true" />
      <div className="ar-top">
        <span className="ar-live"><i /><span>{recorded ? `Recorded from ${where}` : <>Replayed from {where}<span className="ar-when">, read just now</span></>}</span></span>
        <span className="ar-size">coin size = market cap</span>
        <div className="ar-nav">
          <button type="button" onClick={() => step(-1)} aria-label="Previous step"><ChevronLeft /></button>
          {!calm && <button type="button" onClick={toggle} aria-label={playing ? "Pause the replay" : "Play the replay"}>{playing ? <Pause /> : <Play />}</button>}
          <button type="button" onClick={() => step(1)} aria-label="Next step"><ChevronRight /></button>
          <button type="button" onClick={play} aria-label="Replay from the start"><RotateCcw /></button>
        </div>
      </div>
      {!started && (
        <button type="button" className="ar-play" onClick={play}>
          <span className="ar-play-ic" aria-hidden="true"><Play /></span>
          <b>{ended ? "Watch it again" : `Watch ${sym(replay.winner)} take over ${sym(replay.target)}`}</b>
          <small>{calm ? `${B.length} steps, at your own pace` : `${B.length} steps · about ${secs} seconds`}</small>
        </button>
      )}
      {replay.coins.map((c) => {
        // The target shows its size before it went. The winner shows its size from before the merge until the
        // target lands in it (arena3d.js marks that moment with .landed), then its size after.
        const won = c.id === replay.winner && iMerge >= 0;
        return (
          <a key={c.id} className="ar-label" href={`${app}#trade`} onClick={() => remember(c.id)} ref={(el) => (el ? labels.current.set(c.id, el) : labels.current.delete(c.id))}>
            <b>${c.symbol}</b>
            {won
              ? <><small className="was">{fmtCap(c.before)}</small><small className="now">{fmtCap(c.cap)}</small><em>ate {sym(replay.target)}</em></>
              : <small>{fmtCap(c.id === replay.target ? c.before : c.cap)}</small>}
          </a>
        );
      })}
      <figure className={cn("ar-bubble", started && beat.quote && "on", beat.no && "no")} ref={bubble} aria-hidden={!started || !beat.quote}>
        {started && beat.quote && <><figcaption>{beat.by}</figcaption><blockquote>“{beat.quote}”</blockquote></>}
      </figure>
      <div className="ar-hud" ref={hud} data-kind={beat.kind}>
        <Readout key={k} beat={beat} W={sym(replay.winner)} T={sym(replay.target)} locked={B.find((b) => b.kind === "lock")?.amount} />
      </div>
      <div className="ar-cap">
        <span className="ar-n">{String(k + 1).padStart(2, "0")} / {String(B.length).padStart(2, "0")} · {STEP[beat.kind]}</span>
        <p>{beat.text}</p>
        <a href="#receipts">Every transaction<ArrowDown /></a>
      </div>
      <ol className="ar-steps">
        {B.map((b, n) => (
          <li key={n} className={!started ? "" : n === k ? "on" : n < k ? "past" : ""}>
            <button type="button" aria-label={`Step ${n + 1}: ${STEP[b.kind]}`} aria-current={started && n === k ? "step" : undefined}
              onClick={() => go(n)}><span>{STEP[b.kind]}</span></button>
          </li>
        ))}
      </ol>
    </div>
  );
}
