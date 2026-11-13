import { useSnap } from "../data";
import { Avatar, Chip, Sheet } from "../ui/kit";
import type { Rules, Stint } from "../types";
import { CAT_LABEL, shortDate } from "../util";

const yr = (s: Stint) => `${s.from ? s.from.slice(0, 4) : "?"}–${s.to ? s.to.slice(0, 4) : s.from ? "now" : "?"}${s.approx ? " (approx.)" : ""}`;

function Timeline({ career }: { career: Stint[] }) {
  return <ol className="timeline">{[...career].reverse().map((s, i) => (
    <li key={i}><span className="t-when">{yr(s)}</span><span className="t-what"><b>{s.org}</b><span className="small">{s.title}</span>{s.source && <span className="tiny dim"> · {s.source}</span>}</span></li>
  ))}</ol>;
}

export function FiledPersonSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const snap = useSnap();
    const p = id ? snap.peopleById.get(id) : undefined;
  if (!p) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const filingName = p.event.filing.split(":").pop();
  return (
    <Sheet open onClose={onClose} title={<span className="row gap"><Avatar name={p.name} size={36} /><span><b>{p.name}</b><br /><span className="small dim">{p.event.role} · {p.symbol}</span></span></span>}>
      <p className="lede">{p.summary}</p>
      <div className="kv"><span>Change</span><span>{p.event.change}</span><span>Effective</span><span>{p.event.effective ? shortDate(p.event.effective) : "—"}</span>
        <span>Source</span><span><a className="link" href={p.event.filing.startsWith("NSE:") ? `https://nsearchives.nseindia.com/corporate/${filingName}` : `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${filingName}`} target="_blank" rel="noreferrer">{p.source} ↗</a></span></div>
      {p.career.length > 0 && <><h3 className="sub">Career (from the filing)</h3><Timeline career={p.career} /></>}
      {p.education.length > 0 && <div className="small">{p.education.map((e) => [e.degree, e.school].filter(Boolean).join(", ")).join(" · ")}</div>}
      {p.track_record && <><h3 className="sub">Worth asking about</h3><ul className="list">{p.track_record.map((t) => <li key={t} className="small">{t}</li>)}</ul></>}
    </Sheet>
  );
}

const CATS = ["results", "management_change", "M&A", "litigation", "fund_raise", "capex", "credit_rating", "pledging", "insider_trading", "press_release", "dividend", "earnings_call", "investor_meetings"];

export function RulesSheet({ open, onClose, rules, setRules }: { open: boolean; onClose: () => void; rules: Rules; setRules: (r: Rules) => void }) {
  const toggle = (k: "boost" | "mute", c: string) => {
    const other = k === "boost" ? "mute" : "boost";
    const has = rules[k].includes(c);
    setRules({ ...rules, [k]: has ? rules[k].filter((x) => x !== c) : [...rules[k], c], [other]: rules[other].filter((x) => x !== c) });
  };
  return (
    <Sheet open={open} onClose={onClose} title={<b>Watch rules</b>}>
      <p className="small dim">You decide what “unusual” means. Alerts re-evaluate instantly on your device.</p>
      <h3 className="sub">Price move</h3>
      <div className="chips"><Chip active={rules.priceMode === "pct"} onClick={() => setRules({ ...rules, priceMode: "pct" })}>Fixed %</Chip>
        <Chip active={rules.priceMode === "sigma"} onClick={() => setRules({ ...rules, priceMode: "sigma" })}>Unusual for this stock (σ)</Chip></div>
      {rules.priceMode === "pct"
        ? <label className="slider"><span>Alert beyond ±{rules.pricePct}% in a day</span><input type="range" min={1} max={10} step={0.5} value={rules.pricePct} onChange={(e) => setRules({ ...rules, pricePct: +e.target.value })} /></label>
        : <label className="slider"><span>Alert beyond {rules.sigma}σ of its own 60-day moves</span><input type="range" min={1.5} max={4} step={0.25} value={rules.sigma} onChange={(e) => setRules({ ...rules, sigma: +e.target.value })} /></label>}
      <h3 className="sub">Volume</h3>
      <label className="slider"><span>Alert when volume ≥ {rules.volMult}× its 20-day average</span><input type="range" min={1.5} max={5} step={0.25} value={rules.volMult} onChange={(e) => setRules({ ...rules, volMult: +e.target.value })} /></label>
      <h3 className="sub">Filing types</h3>
      <p className="small dim">Tap once to always surface, twice to mute.</p>
      <div className="chips wrap">{CATS.map((c) => {
        const st = rules.boost.includes(c) ? "on" : rules.mute.includes(c) ? "muted" : "";
        return <Chip key={c} active={!!st} tone={st === "muted" ? "mutechip" : ""} onClick={() => st === "on" ? toggle("mute", c) : st === "muted" ? setRules({ ...rules, mute: rules.mute.filter((x) => x !== c) }) : toggle("boost", c)}>
          {st === "on" ? "★ " : st === "muted" ? "⊘ " : ""}{CAT_LABEL[c]}</Chip>;
      })}</div>
    </Sheet>
  );
}
