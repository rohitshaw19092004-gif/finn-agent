/* Copilot — the interaction-model experiment. One box (type or speak) for the whole product:
   "what changed today", "latest Tata Motors revenue", "did Asian Paints deliver on margin guidance",
   "why did Bajaj Finance jump". Answers are cards built from the same deterministic numbers and
   verified quotes as the dossier; open-ended questions go to a grounded model call that may only use
   the company's own facts and must cite them. Nothing is answered from model memory. */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiBase, loadDossier, searchCompanies, useSnap } from "../data";
import { useNav } from "../nav";
import { canListen, listen, speak } from "../speech";
import { Chip, Icon, Verdict } from "../ui/kit";
import { Num } from "../ui/charts";
import { CAT_LABEL, ago, cls, crore, fq, pct, tone, chg, chgTone, hasText } from "../util";
import { dayChange, moves } from "../alerts";
import type { Dossier, Rules } from "../types";

type Ans =
  | { kind: "loading"; steps: string[]; text: string }
  | { kind: "metric"; d: Dossier; metric: string; text: string }
  | { kind: "card"; d: Dossier; text: string }
  | { kind: "section"; d: Dossier; section: "promises" | "debate" | "mix" | "balance" | "cash" | "trajectory" | "valuation"; text: string }
  | { kind: "grounded"; d: Dossier; answer: string; cites: string[]; partial?: boolean; model?: string; text: string }
  | { kind: "facts"; d: Dossier; facts: string[]; text: string }
  | { kind: "brief"; text: string }
  | { kind: "moves"; sym?: string; text: string }
  | { kind: "mgmt"; sym?: string; text: string }
  | { kind: "pick"; hits: { name: string; symbol: string }[]; q: string; text: string }
  | { kind: "none"; text: string };
interface Turn { id: number; q: string; a: Ans }

const STARTERS = ["What needs my attention today?", "Latest Tata Motors revenue", "Did Asian Paints deliver on its margin guidance?",
  "Why did Bajaj Finance move?", "Bull and bear on Clean Science", "Who is HDFC Bank's new CEO?", "How much debt does Reliance have?"];

const METRICS: [RegExp, string][] = [
  [/\b(revenue|sales|top ?line|turnover)\b/, "Revenue"], [/\b(ebitda|operating profit)\b/, "EBITDA"],
  [/\b(pbt|profit before tax)\b/, "PBT"], [/\b(pat|net profit|profit|earnings|bottom ?line|net income)\b/, "PAT"],
  [/\bmargins?\b/, "margin"], [/\b(nii|net interest)\b/, "NII"],
];
const STOP = new Set("what is the of a an for on in to me show tell latest last recent current update updates about how much did does do has have its it's whats what's give quarter quarterly q1 q2 q3 q4 fy results result numbers number revenue sales profit pat ebitda margin margins debt cash guidance promise promises bull bear case why move moved fall fell rise rose jump jumped drop dropped new ceo cfo md chairman who doing and vs versus compare with deliver delivered on growth trend business valuation price share stock".split(" "));

export function Copilot({ rules, initial }: { rules: Rules; initial?: { q: string; n: number } }) {
  const snap = useSnap();
  const nav = useNav();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [mic, setMic] = useState<null | (() => void)>(null);
  const [talk, setTalk] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const names = useMemo(() => {
    const m = new Map<string, string[]>();
    snap.holdings.forEach((h) => m.set(h.symbol, [h.symbol, h.name ?? ""]));
    Object.values(snap.registry.orgs).forEach((o) => { if (o.ticker) m.set(o.ticker, [...(m.get(o.ticker) ?? [o.ticker]), o.name, ...o.aliases]); });
    return m;
  }, [snap]);

  useEffect(() => { if (initial?.q.trim()) ask(initial.q.trim()); }, [initial]); // eslint-disable-line
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns]);

  function localCompany(text: string): string | null {
    const t = " " + text.toLowerCase().replace(/[^a-z0-9& ]/g, " ").replace(/\s+/g, " ") + " ";
    let best: [string, number] | null = null;
    for (const [sym, ns] of names) for (const n of ns) {
      const k = n.toLowerCase().replace(/\b(ltd|limited|industries|international|company|technology|corporation)\b/g, "").replace(/[^a-z0-9& ]/g, " ").replace(/\s+/g, " ").trim();
      if (k.length >= 3 && t.includes(" " + k + " ") && (!best || k.length > best[1])) best = [sym, k.length];
    }
    return best?.[0] ?? null;
  }

  /** Company named anywhere in a sentence: local names first, then phrases from the sentence against NSE search. */
  async function findCompany(text: string): Promise<{ sym?: string; hits?: { name: string; symbol: string }[] }> {
    const loc = localCompany(text);
    if (loc) return { sym: loc };
    if (!apiBase) return {};
    const words = text.replace(/[’']s\b/g, "").replace(/[^A-Za-z0-9& ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
    const tried = new Set<string>();
    for (let n = Math.min(3, words.length); n >= 1; n--) for (let i = 0; i + n <= words.length; i++) {
      const ph = words.slice(i, i + n).join(" ");
      if (ph.length < 3 || tried.has(ph.toLowerCase())) continue;
      tried.add(ph.toLowerCase());
      const hits = await searchCompanies(ph);
      if (hits.length === 1 || (hits.length && hits[0].symbol.toUpperCase() === ph.toUpperCase())) return { sym: hits[0].symbol };
      if (hits.length > 1) return { hits: hits.slice(0, 5) };
      if (tried.size >= 6) return {};
    }
    return {};
  }

  const put = (id: number, a: Ans) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, a } : t)));

  async function ask(text: string, forcedSym?: string) {
    const t = text.trim();
    if (!t) return;
    const id = ++seq.current;
    setTurns((ts) => [...ts, { id, q: t, a: { kind: "loading", steps: [], text: "" } }]);
    setQ("");
    const low = t.toLowerCase();
    let ans: Ans;
    try {
      if (!forcedSym && /\b(today|need(s)? (my )?attention|what changed|what's new|whats new|brief|digest|anything (new|important))\b/.test(low)) {
        ans = { kind: "brief", text: briefText() };
      } else {
        const found = forcedSym ? { sym: forcedSym } : await findCompany(t);
        if (found.hits) ans = { kind: "pick", hits: found.hits, q: t, text: `Which company did you mean?` };
        else if (/\b(why did|why is|move[ds]?|jump(ed)?|fell|fall|drop(ped)?|rall(y|ied)|spike|volume)\b/.test(low) && (!found.sym || snap.holdings.some((h) => h.symbol === found.sym))) {
          ans = { kind: "moves", sym: found.sym, text: movesText(found.sym) };
        } else if (/\b(ceo|cfo|md|chairman|chairperson|director|management change|appoint|resign|new (head|boss))\b/.test(low) && (!found.sym || snap.holdings.some((h) => h.symbol === found.sym))) {
          ans = { kind: "mgmt", sym: found.sym, text: mgmtText(found.sym) };
        } else if (!found.sym) {
          ans = { kind: "none", text: apiBase ? `I couldn't find a listed company in “${t}”. Try its name or NSE symbol.` : `I couldn't find a company in “${t}”. In this preview the live engine is off, so ask about one of your holdings.` };
        } else {
          const d = await loadDossier(found.sym, (m) => setTurns((ts) => ts.map((x) => (x.id === id && x.a.kind === "loading" ? { ...x, a: { ...x.a, steps: [...x.a.steps, m] } } : x))));
          ans = await answerFor(d, low, t);
        }
      }
    } catch (e) {
      ans = { kind: "none", text: String((e as Error).message) === "offline" ? "That company isn't pre-built and the live research engine isn't connected in this preview." : `Couldn't research that: ${(e as Error).message}` };
    }
    put(id, ans);
    if (talk && ans.text) speak([ans.text]);
  }

  async function answerFor(d: Dossier, low: string, raw: string): Promise<Ans> {
    const name = shortName(d.name);
    if (/\b(guid\w*|promis\w*|deliver\w*|targets?|outlook|said they would|kept their word)\b/.test(low)) return { kind: "section", d, section: "promises", text: `${name}: ${d.promises?.credibility ?? "no guidance check available"}` };
    const metric = METRICS.find(([re]) => re.test(low))?.[1];
    if (metric) return { kind: "metric", d, metric, text: metricText(d, metric) };
    if (/\b(bull|bear|risk|case for|case against|should i|thesis)\b/.test(low)) return { kind: "section", d, section: "debate", text: `${name}, bull case: ${d.bull_bear?.bull?.[0] ?? "—"} Bear case: ${d.bull_bear?.bear?.[0] ?? "—"}` };
    if (/\b(what does|business|segments?|mix|do they do|make)\b/.test(low)) return { kind: "section", d, section: "mix", text: d.business_mix?.what_it_does ?? d.snapshot.about ?? name };
    if (/\b(debt|leverage|borrow|balance sheet|working capital)\b/.test(low)) return { kind: "section", d, section: "balance", text: d.balance_sheet.notes.map((n) => n.text).join(". ") };
    if (/\b(cash|fcf|cash flow|conversion)\b/.test(low)) return { kind: "section", d, section: "cash", text: d.cash.notes.map((n) => n.text).join(". ") };
    if (/\b(growth|grow|trajectory|trend|cagr)\b/.test(low)) return { kind: "section", d, section: "trajectory", text: d.trajectory.notes.map((n) => n.text).join(". ") };
    if (/\b(valuation|p\/?e|price|market cap|mcap|expensive|cheap|share)\b/.test(low)) return { kind: "section", d, section: "valuation", text: `${name} trades at ₹${d.snapshot.price ?? "—"}, P/E ${d.snapshot.pe ?? "—"}, market cap ${crore(d.snapshot.mcap_cr)}.` };
    // short query = just a company: give the card
    const rest = low.replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w) && !d.name.toLowerCase().includes(w) && w !== d.symbol.toLowerCase());
    if (rest.length === 0) return { kind: "card", d, text: `${name}. ${d.snapshot.latest_quarter ? fq(d.snapshot.latest_quarter.period) + ": " + d.snapshot.latest_quarter.headline : ""}` };
    // open question: grounded model answer over this company's own facts (falls back to matching facts)
    if (apiBase) {
      try {
        const r = await fetch(`${apiBase}/api/ask?symbol=${encodeURIComponent(d.symbol)}&q=${encodeURIComponent(raw)}`);
        if (r.ok) {
          const j = await r.json();
          if (j.status === "ok" && j.answer) return { kind: "grounded", d, answer: j.answer, cites: j.cites ?? [], partial: !!j.partial, model: j.model, text: j.answer };
        }
      } catch { /* fall through */ }
    }
    const facts = factsFor(d).filter((f) => rest.some((w) => w.length > 3 && f.toLowerCase().includes(w))).slice(0, 6);
    return { kind: "facts", d, facts, text: facts.length ? facts.join(". ") : `Nothing in ${name}'s filings or calls matches that directly.` };
  }

  function briefText() {
    const act = snap.stories.filter((s) => s.tier === "act" && (snap.asOf.getTime() - new Date(s.latest.slice(0, 10)).getTime()) / 864e5 <= 3);
    return act.length ? `${act.length} thing${act.length > 1 ? "s" : ""} need you: ` + act.slice(0, 4).map((s) => `${shortName(name(s.symbol))}, ${(snap.byId.get(s.lead)?.summary ?? CAT_LABEL[s.category] ?? "").replace(/\.$/, "")}`).join(". ") + "."
      : "Nothing in the last three days needs you. The routine filings are filed away in the Brief.";
  }
  function movesText(sym?: string) {
    const since = new Date(snap.asOf.getTime() - 14 * 864e5).toISOString().slice(0, 10);
    const mv = moves(snap.holdings.filter((h) => !sym || h.symbol === sym), { ...rules, pricePct: sym ? 0 : rules.pricePct }, since)
      .sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret)).slice(0, sym ? 3 : 5);
    if (!mv.length) return sym ? `${shortName(name(sym))} hasn't made an unusual move in the last two weeks.` : "No unusual moves in the last two weeks.";
    const why = (m: typeof mv[number]) => {
      const t = new Date(m.date).getTime();
      const near = snap.stories.filter((s) => s.symbol === m.symbol && Math.abs(t - new Date(s.latest.slice(0, 10)).getTime()) <= 3 * 864e5)
        .sort((x, y) => Number(y.category === "results") - Number(x.category === "results") || y.score - x.score);
      const st = near[0];
      if (!st) return " — no company filing within 3 days, so likely market or sector flow";
      const f = snap.byId.get(st.lead);
      return ` — nearest filing: ${f?.results ? fq(f.results.period) + " results (" + f.results.headline + ")" : (f?.summary ?? CAT_LABEL[st.category] ?? "a filing").replace(/\.$/, "")}`;
    };
    return mv.map((m) => `${shortName(name(m.symbol))} ${pct(m.ret * 100, 1)} on ${new Date(m.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}${m.volMult ? ` (volume ${m.volMult.toFixed(1)}× normal)` : ""}${why(m)}`).join(". ") + ".";
  }
  function mgmtText(sym?: string) {
    const ps = snap.people.filter((p) => !sym || p.symbol === sym);
    if (!ps.length) return sym ? `No management change at ${shortName(name(sym))} in the filings I track (last ${snap.meta.window_days} days).` : "No management changes in the filings window.";
    return ps.slice(0, 3).map((p) => `${p.name}, ${p.event.role} at ${shortName(name(p.symbol))}, ${p.event.change}. ${p.summary ?? ""}`).join(" ");
  }
  const name = (sym: string) => snap.holdings.find((h) => h.symbol === sym)?.name ?? sym;

  const voice = () => {
    if (mic) { mic(); setMic(null); return; }
    const stop = listen((txt, fin) => { setQ(txt); if (fin) { setMic(null); ask(txt); } }, () => setMic(null));
    setMic(() => stop);
  };

  return (
    <div className="screen copilot">
      <header className="top">
        <div className="eyebrow">Copilot · primary sources only</div>
        <h1 className="headline">Ask FINN anything about your book — or any NSE company.</h1>
        <div className="sub-head">Answers come from filings, statements and earnings calls, with the numbers and quotes shown. Type or tap the mic.</div>
      </header>

      <div className="thread">
        {turns.length === 0 && <div className="starters">
          {STARTERS.map((s) => <Chip key={s} onClick={() => ask(s)}>{s}</Chip>)}
        </div>}
        {turns.map((t) => <div key={t.id} className="turn">
          <div className="bubble me">{t.q}</div>
          <AnswerView a={t.a} onPick={(sym) => ask(t.q, sym)} onAsk={ask} onSpeak={() => speak([t.a.text])} />
        </div>)}
        <div ref={endRef} />
      </div>

      <form className="askbar copilot-bar" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Latest Tata Motors revenue · did Titan deliver?" aria-label="Ask FINN" />
        <button type="button" className={cls("mic", talk && "on-soft")} onClick={() => setTalk(!talk)} title={talk ? "Spoken answers on" : "Read answers aloud"} aria-label="Read answers aloud"><Icon name="play" size={13} /></button>
        {canListen() && <button type="button" className={cls("mic", mic && "on")} onClick={voice} aria-label="Speak">{mic ? "●" : "🎙"}</button>}
        <button type="submit" className="go" aria-label="Ask">→</button>
      </form>
      {turns.length === 0 && <p className="small dim center">{apiBase ? "Any NSE company works — the first question about a new one takes a minute or two while FINN reads its filings and calls." : "Preview mode: questions about your holdings and research list work offline."}</p>}
      <button className="link small center-btn" onClick={() => nav.tab("brief")}>← Back to the Brief</button>
    </div>
  );
}

const shortName = (n?: string | null) => (n ?? "").replace(/ (Ltd|Limited)\.?$/i, "").replace(/ (Industries|International|Technology|Company|Corporation)$/i, "").replace(/\s*&$/, "");

function metricText(d: Dossier, metric: string) {
  const lq = d.snapshot.latest_quarter;
  const name = shortName(d.name);
  if (!lq) return `No quarterly results for ${name} yet.`;
  if (metric === "margin") return lq.margin ? `${name} ${fq(lq.period)}: EBITDA margin ${lq.margin.now.toFixed(1)}% (${pp(lq.margin.qoq_pp)} QoQ, ${pp(lq.margin.yoy_pp)} YoY).` : `${name} ${fq(lq.period)}: ${lq.headline}.`;
  const m = lq.metrics.find((x) => x.label.toLowerCase() === metric.toLowerCase()) ?? (metric === "EBITDA" ? lq.metrics.find((x) => /nii|financing/i.test(x.label)) : undefined);
  if (!m) return `${name} ${fq(lq.period)}: ${lq.headline}.`;
  return `${name} ${m.label}, ${fq(lq.period)} (${lq.period}): ${crore(m.value)}, ${chg(m, "qoq")} QoQ, ${chg(m, "yoy")} YoY.`;
}
const pp = (n: number | null) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n}pp`);

function factsFor(d: Dossier): string[] {
  return [
    ...d.trajectory.notes.map((n) => n.text), ...d.balance_sheet.notes.map((n) => n.text), ...d.cash.notes.map((n) => n.text),
    ...d.red_flags.map((n) => n.text), ...d.guidance.map((g) => `[${g.said_in} call] ${g.statement} — “${g.quote}”`),
    ...(d.promises?.promises ?? []).map((p) => `[${p.said_in}] ${p.promise} → ${p.verdict}: ${p.outcome}`),
  ];
}

function AnswerView({ a, onPick, onAsk, onSpeak }: { a: Ans; onPick: (sym: string) => void; onAsk: (q: string) => void; onSpeak: () => void }) {
  const snap = useSnap();
  const nav = useNav();
  if (a.kind === "loading") return <div className="bubble bot loading-b"><span className="dots"><i /><i /><i /></span>
    {a.steps.length > 0 && <ol className="steps">{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}</div>;
  const follow = (d: Dossier) => <div className="chips wrap follow">
    {["Revenue", "Margin", "Guidance vs delivery", "Bull and bear", "Debt", "Cash flow"].map((x) =>
      <Chip key={x} onClick={() => onAsk(`${x} ${shortName(d.name)}`)}>{x}</Chip>)}
    <Chip onClick={() => nav.company(d.symbol)}>Full research →</Chip>
  </div>;
  const head = (d: Dossier) => {
    const h = snap.holdings.find((x) => x.symbol === d.symbol);
    const ch = h ? dayChange(h) : null;
    return <div className="ans-head"><span className="sym">{d.symbol}</span><b>{shortName(d.name)}</b>
      <span className={cls("small num", tone(ch))}>{ch != null ? pct(ch * 100, 2) : ""}</span>
      <button className="speak" onClick={onSpeak} title="Read aloud"><Icon name="play" size={11} /></button></div>;
  };
  const src = (d: Dossier) => <div className="tiny dim">Source: {d.generated_by.numbers}{d.analysis ? ` · commentary ${d.analysis.coverage}` : ""}</div>;

  switch (a.kind) {
    case "none": return <div className="bubble bot">{a.text}</div>;
    case "pick": return <div className="bubble bot">{a.text}<div className="chips wrap follow">{a.hits.map((h) => <Chip key={h.symbol} onClick={() => onPick(h.symbol)}>{h.name} <span className="dim">{h.symbol}</span></Chip>)}</div></div>;
    case "brief": {
      const act = snap.stories.filter((s) => s.tier === "act" && (snap.asOf.getTime() - new Date(s.latest.slice(0, 10)).getTime()) / 864e5 <= 3);
      return <div className="bubble bot">
        <div className="ans-big"><Num value={act.length} /> <span className="small dim">thing{act.length === 1 ? "" : "s"} need you · last 3 days</span></div>
        <ul className="ans-list">{act.slice(0, 5).map((s) => { const f = snap.byId.get(s.lead)!; return <li key={s.id}><button onClick={() => nav.company(s.symbol)}>
          <span className="sym">{s.symbol}</span> <span className="cat">{CAT_LABEL[s.category]}</span> {f.results?.headline ? `${fq(f.results.period)}: ${f.results.headline}` : f.summary ?? f.headline} <span className="dim tiny">{ago(s.latest, snap.asOf)}</span></button></li>; })}</ul>
        <button className="link small" onClick={() => nav.tab("brief")}>Open the Brief →</button>
      </div>;
    }
    case "moves": case "mgmt": return <div className="bubble bot"><p>{a.text}</p>
      {a.sym && <button className="link small" onClick={() => nav.company(a.sym!)}>Open {a.sym} →</button>}</div>;
    case "metric": {
      const lq = a.d.snapshot.latest_quarter;
      return <div className="bubble bot">{head(a.d)}
        {lq ? <>
          <div className="ans-title">{a.metric === "margin" ? "EBITDA margin" : a.metric} · {fq(lq.period)} <span className="dim">({lq.period})</span></div>
          {a.metric === "margin" && lq.margin ? <div className="ans-big"><Num value={lq.margin.now} dp={1} suffix="%" />
            <span className={cls("pill", (lq.margin.qoq_pp ?? 0) >= 0 ? "up" : "down")}>{pp(lq.margin.qoq_pp)} QoQ</span><span className={cls("pill", (lq.margin.yoy_pp ?? 0) >= 0 ? "up" : "down")}>{pp(lq.margin.yoy_pp)} YoY</span></div>
            : (() => { const m = lq.metrics.find((x) => x.label.toLowerCase() === a.metric.toLowerCase()) ?? lq.metrics[0];
              return <div className="ans-big"><Num value={m.value} prefix="₹" suffix=" Cr" />
                <span className={cls("pill", chgTone(m, "qoq") || "up")}>{chg(m, "qoq")} QoQ</span><span className={cls("pill", chgTone(m, "yoy") || "up")}>{chg(m, "yoy")} YoY</span></div>; })()}
          <table className="rt"><tbody>{lq.metrics.map((m) => <tr key={m.label} className={m.label.toLowerCase() === a.metric.toLowerCase() ? "hl" : ""}><td>{m.label}</td><td className="num">{crore(m.value)}</td>
            <td className={cls("num", chgTone(m, "qoq"))}>{chg(m, "qoq")}</td><td className={cls("num", chgTone(m, "yoy"))}>{chg(m, "yoy")}</td></tr>)}</tbody></table>
          {lq.flags.map((f) => <div key={f} className="flag">⚑ {f}</div>)}
        </> : <p>{a.text}</p>}
        {src(a.d)}{follow(a.d)}
      </div>;
    }
    case "card": return <div className="bubble bot">{head(a.d)}
      <p className="small">{a.d.business_mix?.what_it_does ?? a.d.snapshot.about}</p>
      {a.d.snapshot.latest_quarter && <div className="ans-title">{fq(a.d.snapshot.latest_quarter.period)} · <span className="dim">{a.d.snapshot.latest_quarter.headline}</span></div>}
      <div className="d-stats"><div><span className="k">Mkt cap</span><span className="v num">{crore(a.d.snapshot.mcap_cr)}</span></div><div><span className="k">P/E</span><span className="v num">{a.d.snapshot.pe ?? "—"}</span></div>
        <div><span className="k">{a.d.snapshot.lender ? "ROE" : "ROCE"}</span><span className="v num">{(a.d.snapshot.lender ? a.d.snapshot.roe : a.d.snapshot.roce) ?? "—"}%</span></div><div><span className="k">Promises</span><span className="v num">{a.d.promises?.promises.length ?? 0}</span></div></div>
      {src(a.d)}{follow(a.d)}</div>;
    case "section": {
      const d = a.d;
      return <div className="bubble bot">{head(d)}
        {a.section === "promises" && (d.promises ? <><p className="small">{d.promises.credibility}</p>
          <ul className="promises">{d.promises.promises.slice(0, 5).map((p, i) => <li key={i}><div className="row between"><span className="small dim">{p.said_in} · {p.metric}</span><Verdict v={p.verdict} /></div>
            <div className="p-promise">“{p.promise}”</div><div className="p-outcome">{p.outcome}</div>{hasText(p.evidence) && <div className="tiny dim">{p.evidence}</div>}</li>)}</ul></>
          : <p className="small dim">No checked guidance for {shortName(d.name)} yet{d.analysis ? ` (${d.analysis.coverage})` : ""}.</p>)}
        {a.section === "debate" && (d.bull_bear ? <div className="debate"><div className="bull"><h3>Bull</h3><ul>{d.bull_bear.bull.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          <div className="bear"><h3>Bear</h3><ul>{d.bull_bear.bear.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div> : <p className="small dim">No bull/bear yet.</p>)}
        {a.section === "mix" && <><p>{d.business_mix?.what_it_does ?? d.snapshot.about}</p>
          {d.business_mix?.segments?.length ? <ul className="ans-list">{d.business_mix.segments.map((s) => <li key={s.name}><b>{s.name}</b>{s.share_pct != null ? ` ${s.share_pct}%` : ""}{s.note ? <span className="dim"> — {s.note}</span> : null}</li>)}</ul> : null}</>}
        {(a.section === "balance" || a.section === "cash" || a.section === "trajectory") && <ul className="notes">{(a.section === "balance" ? d.balance_sheet.notes : a.section === "cash" ? d.cash.notes : d.trajectory.notes).map((n, i) => <li key={i} className={n.tone}>{n.text}</li>)}</ul>}
        {a.section === "valuation" && <div className="d-stats"><div><span className="k">Price</span><span className="v num">₹{d.snapshot.price ?? "—"}</span></div><div><span className="k">P/E</span><span className="v num">{d.snapshot.pe ?? "—"}</span></div>
          <div><span className="k">Mkt cap</span><span className="v num">{crore(d.snapshot.mcap_cr)}</span></div><div><span className="k">Div. yield</span><span className="v num">{d.snapshot.div_yield ?? "—"}%</span></div></div>}
        {src(d)}{follow(d)}</div>;
    }
    case "grounded": return <div className="bubble bot">{head(a.d)}
      {a.partial && <span className="chip warn">Partly answered — the filings only cover some of this</span>}
      <p>{a.answer}</p>
      {a.cites.length > 0 && <ol className="cites">{a.cites.map((c, i) => <li key={i} className="small">{c}</li>)}</ol>}
      <div className="tiny dim">{a.cites.length ? <>Answered by {a.model ?? "the model"} using only {shortName(a.d.name)}'s own filings, statements and verified call quotes — every claim cites one.</> : <>Checked against {shortName(a.d.name)}'s own filings, statements and verified call quotes.</>}</div>
      {follow(a.d)}</div>;
    case "facts": return <div className="bubble bot">{head(a.d)}
      {a.facts.length ? <><p className="small dim">What {shortName(a.d.name)}'s own filings and calls say:</p><ul className="notes">{a.facts.map((f, i) => <li key={i}>{f}</li>)}</ul></> : <p>{a.text}</p>}
      {follow(a.d)}</div>;
  }
}
