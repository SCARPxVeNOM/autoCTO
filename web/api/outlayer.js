// OutLayer's recent record, so the page can tell visitors whether a brain is likely to answer now.
// The browser cannot read OutLayer's job list itself (no CORS), so this passes on a summary:
// how many OutLayer runs from the last 10 minutes answered, and how many came back too late
// (after NEAR had closed the request). Cached for a minute at the edge.
const UPSTREAM = {
  testnet: "https://testnet-api.outlayer.ai/public/jobs?limit=100&offset=0&source=near",
  mainnet: "https://api.outlayer.ai/public/jobs?limit=100&offset=0&source=near",
};
const MINUTES = 10;

export default async function handler(req, res) {
  const network = req.query?.network === "mainnet" ? "mainnet" : "testnet";
  try {
    const r = await fetch(UPSTREAM[network], { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`OutLayer answered ${r.status}`);
    const j = await r.json();
    const since = Date.now() - MINUTES * 60_000;
    const recent = (Array.isArray(j) ? j : j.jobs || []).filter((x) => Date.parse(x.created_at) >= since);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json({
      network,
      minutes: MINUTES,
      runs: recent.length,
      answered: recent.filter((x) => x.success).length,
      late: recent.filter((x) => /request not found/i.test(x.error_details || "")).length,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: String(e.message || e).slice(0, 160) });
  }
}
