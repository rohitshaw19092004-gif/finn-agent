import { useState } from "react";
import { useSnap, searchCompanies, apiBase } from "../data";
import { useNav } from "../nav";
import { cls, pct, tone } from "../util";
import { dayChange } from "../alerts";

export function Research() {
  const snap = useSnap();
  const nav = useNav();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ name: string; symbol: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(t: string) {
    const x = t.trim();
    if (!x) return;
    const local = snap.holdings.find((h) => h.symbol === x.toUpperCase() || (h.name ?? "").toLowerCase().includes(x.toLowerCase()));
    if (local) { nav.company(local.symbol); return; }
    if (!apiBase) { setHits([]); return; }
    setBusy(true);
    const r = await searchCompanies(x);
    setBusy(false);
    if (r.length === 1) nav.company(r[0].symbol); else setHits(r);
  }
  return (
    <div className="screen ask">
      <header className="top">
        <div className="eyebrow">Pull · any NSE company · primary sources only</div>
        <h1 className="headline">Research a company.</h1>
        <div className="sub-head">Statements, trajectory, balance sheet, cash quality, and what management promised vs delivered — from its own filings and earnings calls.</div>
      </header>
      <form className="askbar" onSubmit={(e) => { e.preventDefault(); run(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company name or NSE symbol — e.g. Bajaj Auto, TMPV" aria-label="Company" />
        <button type="submit" className="go" aria-label="Search">{busy ? "…" : "→"}</button>
      </form>
      {hits && <section className="answer">
        {hits.length ? <><h2 className="section">Companies matching “{q}”</h2>
          <ul className="list">{hits.map((h) => <li key={h.symbol}><button className="link" onClick={() => nav.company(h.symbol)}>{h.name} <span className="dim">{h.symbol}</span></button></li>)}</ul></>
          : <p className="dim">Nothing matched. {apiBase ? "Try the NSE symbol." : "In this preview the live engine is off — pick a company below."}</p>}
      </section>}
      <section className="block">
        <h2 className="section">Research list</h2>
        <CompanyGrid syms={snap.holdings.filter((h) => !h.held).map((h) => h.symbol)} />
        <h2 className="section">Portfolio</h2>
        <CompanyGrid syms={snap.holdings.filter((h) => h.held).map((h) => h.symbol)} />
        <p className="small dim">{apiBase ? "Any other NSE symbol works too: FINN reads its statements and last five earnings calls on demand (a minute or two the first time)." : "Pre-built dossiers shown; the live engine adds any NSE symbol."}</p>
      </section>
    </div>
  );
}

function CompanyGrid({ syms }: { syms: string[] }) {
  const snap = useSnap();
  const nav = useNav();
  return <div className="cgrid">{syms.map((s) => {
    const h = snap.holdings.find((x) => x.symbol === s)!;
    const ch = dayChange(h);
    return <button key={s} className="ctile" onClick={() => nav.company(s)}>
      <b>{s}</b><span className={cls("small num", tone(ch))}>{ch != null ? pct(ch * 100, 1) : ""}</span>
      <span className="tiny dim">{h.industry ?? h.sector}</span>
    </button>;
  })}</div>;
}
