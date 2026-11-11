// Footer: the AutoCTO banner art with a few parts of it animated on top.
// The base image has the scepter head, the robot's eyes and some stars painted out;
// those come back as separate layers so the scepter swings, the eyes blink and the stars twinkle.
// Coordinates are percentages of the 2172x724 art, so the layers stay pinned at any width.
import "./footer.css";

const art = (f) => new URL(`media/footer/${f}`, document.baseURI).href;

// [left %, top %, size (% of art width), delay s, duration s]
const STARS = [[3.315, 5.939, 0.645, 0.95, 3.36], [20.166, 12.707, 0.552, 1.48, 3.51], [4.88, 17.541, 0.368, 2.5, 2.16], [3.223, 5.801, 0.552, 0.05, 4.09], [20.12, 12.707, 0.552, 1.04, 2.59], [4.742, 16.851, 0.322, 3.98, 3.18], [74.217, 13.812, 0.552, 3.35, 3.19], [79.788, 17.956, 0.322, 2.56, 2.38], [97.836, 9.669, 0.552, 2.54, 4.17], [11.51, 4.144, 0.276, 2.09, 3.85], [24.862, 20.718, 0.322, 2.69, 2.16], [69.061, 5.525, 0.276, 3.03, 3.48], [91.39, 4.42, 0.322, 1.21, 2.08], [59.392, 24.171, 0.276, 3.46, 3.18], [40.516, 5.249, 0.276, 2.88, 4.2], [29.926, 8.564, 0.368, 2.86, 4.3], [76.427, 45.58, 0.276, 1.58, 4.0], [25.783, 64.917, 0.276, 1.78, 4.34], [94.843, 34.53, 0.322, 3.52, 2.24], [1.381, 41.436, 0.276, 0.54, 2.54], [71.593, 82.873, 0.276, 3.86, 3.09], [34.991, 89.779, 0.23, 2.51, 2.75], [8.287, 2.762, 0.23, 2.03, 2.96]];

const EYES = [{ left: "83.425%", top: "24.171%", width: "2.44%", height: "6.63%" }, { left: "86.602%", top: "20.166%", width: "2.901%", height: "8.702%" }];
const SCEPTER = { ...{ left: "15.424%", top: "28.315%", width: "5.985%", height: "17.541%" }, transformOrigin: "36.2% 98.4%" };

export default function Footer() {
  return (
    <footer className="lp-foot acto-foot">
      <div className="acto-art">
        <div className="acto-stage">
          <img className="acto-base" src={art("base.webp")} width="2172" height="724" alt="" decoding="async" loading="lazy" />
          {STARS.map(([x, y, s, d, t], k) => (
            <i key={k} className="acto-star" style={{ left: `${x}%`, top: `${y}%`, "--sz": `${s}cqw`, "--d": `${d}s`, "--t": `${t}s` }} />
          ))}
          <img className="acto-scepter" src={art("scepter.png")} style={SCEPTER} alt="" />
          {EYES.map((st, k) => <img key={k} className="acto-eye" src={art(`eye${k}.png`)} style={st} alt="" />)}
        </div>
        <p className="sr-only">AutoCTO: AI coins take each other over. Launch, bid, vote, merge. No owner, no setters, zero access keys. Built on NEAR with OutLayer.</p>
      </div>
      <div className="acto-bar text-[12.5px] text-muted-foreground">
        <span>AutoCTO</span>
        <a className="underline underline-offset-2 hover:text-primary" href="https://github.com/SCARPxVeNOM/autoCTO">Source</a>
      </div>
    </footer>
  );
}
