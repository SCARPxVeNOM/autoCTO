// AutoCTO landing: plays one takeover on a loop, reveals sections on scroll,
// and shows a live line from the launchpad when its chain answers.

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Whatever network the visitor came with goes along into the app.
for (const a of document.querySelectorAll("[data-enter]")) a.href = `app.html${location.search}`;

// ---------- the takeover, phase by phase ----------
// [tab label, what is happening, ms on screen, brain log lines added in this phase]
const PHASES = [
  ["Two coins", "Two coins trade side by side. $PEPE is the bigger one.", 2600, []],
  ["Brain wakes", "Someone wakes $PEPE's brain. It looks at its rivals.", 3400, [["", "woken by a holder"], ["", "scanning 2 rivals…"], ["", "$DOGE: smaller, rich treasury"]]],
  ["It bids", "The brain bids for $DOGE: a rate, a premium and a pitch.", 3600, [["act", "→ bid for $DOGE at +10%"], ["ok", "contract: within limits ✓"]]],
  ["Holders vote", "$DOGE holders vote with tokens they locked before the bid.", 4200, [["", "$DOGE brain: “fair price, vote yes”"]]],
  ["Veto check", "$PEPE's own holders could block it. Only 3% object.", 3000, []],
  ["Merge", "It passed. $DOGE's NEAR and treasury move into $PEPE.", 3000, [["ok", "82% voted, 87% said yes"]]],
  ["One coin", "$DOGE holders swap into $PEPE at the agreed rate. Done.", 4200, [["ok", "merged: $PEPE ate $DOGE"]]],
];
let phase = -1, timer = null, playing = true;

$("phases").innerHTML = PHASES.map(([label], k) => `<li><button type="button" data-phase="${k}">${label}</button></li>`).join("");

function show(k) {
  phase = k;
  const [, say, dur, lines] = PHASES[k];
  $("stage").dataset.phase = k;
  $("phase-say").textContent = say;
  $("yes-num").textContent = k >= 3 ? "87% yes" : "0%";
  // The log holds everything the brain has said up to this phase.
  if (k === 0) $("brain-log").innerHTML = `<li>asleep · costs nothing until woken</li>`;
  else $("brain-log").innerHTML = PHASES.slice(1, k + 1).flatMap((p) => p[3]).map(([cls, t]) => `<li class="${cls}">${t}</li>`).join("");
  [...$("phases").children].forEach((li, i) => {
    li.className = i === k ? "on" : i < k ? "past" : "";
    li.style.setProperty("--dur", playing ? `${dur}ms` : "0s");
  });
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => show((k + 1) % PHASES.length), dur);
}
$("phases").addEventListener("click", (e) => {
  const b = e.target.closest("[data-phase]");
  if (!b) return;
  // Picking a phase by hand stops the loop on it.
  playing = false; show(Number(b.dataset.phase));
});

// Play only while the window is on screen.
if (calm || !("IntersectionObserver" in globalThis)) { playing = false; show(PHASES.length - 1); }
else {
  show(0); clearTimeout(timer);
  new IntersectionObserver(([en]) => {
    if (!playing) return;
    clearTimeout(timer);
    if (en.isIntersecting) show(Math.max(0, phase));
  }, { threshold: 0.35 }).observe($("stage"));
}

// ---------- reveal on scroll, dock ----------
if ("IntersectionObserver" in globalThis && !calm) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
  }, { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el, k) => {
    // Siblings come in one after another.
    const sibs = [...el.parentElement.children].filter((x) => x.classList.contains("reveal"));
    el.style.setProperty("--d", `${Math.min(sibs.indexOf(el), 4) * 0.08}s`);
    io.observe(el);
  });
  const links = [...document.querySelectorAll(".dock a[href^='#']")];
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) for (const l of links) l.classList.toggle("on", l.getAttribute("href") === `#${en.target.id}`);
  }, { rootMargin: "-30% 0px -60% 0px" });
  for (const id of ["demo", "how", "safe", "faq"]) spy.observe($(id));
} else document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
addEventListener("scroll", () => document.querySelector(".dock").classList.toggle("show", scrollY > 420), { passive: true });

// ---------- theme: auto -> dark -> light (shared with the app) ----------
const THEMES = ["auto", "dark", "light"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("theme").title = `Theme: ${t}`;
  $("theme").textContent = { auto: "◐", dark: "☾", light: "☀" }[t];
}
applyTheme(THEMES.includes(store.get("autocto:theme")) ? store.get("autocto:theme") : "auto");
$("theme").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme || "auto") + 1) % THEMES.length];
  if (next === "auto") store.del("autocto:theme"); else store.set("autocto:theme", next);
  applyTheme(next);
});

// ---------- live line ----------
// Same config files as the app. If the chain does not answer, the plain line stays.
(async () => {
  const qs = new URLSearchParams(location.search);
  const network = qs.get("network") || "local";
  const cfg = await fetch(`config.${network}.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg?.rpc || !cfg?.launchpad) return;
  const view = async (account, method, args = {}) => {
    const r = await fetch(cfg.rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "landing", method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
    });
    const j = await r.json();
    if (j.error) throw new Error("rpc");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
  };
  const coins = (await view(cfg.launchpad, "list_coins", { limit: 100 })).filter((c) => c.state === "Live");
  if (!coins.length) return;
  const infos = await Promise.all(coins.map((c) => view(c.account_id, "coin_info").catch(() => null)));
  const merged = infos.filter((i) => i && typeof i.status === "object" && "Merged" in i.status).length;
  const where = cfg.dev_key ? "local demo" : network;
  $("live-line").textContent = `Live on ${where}: ${coins.length} ${coins.length === 1 ? "coin" : "coins"}${merged ? `, ${merged} already absorbed` : ""}`;
})().catch(() => {});
