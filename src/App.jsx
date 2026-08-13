import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, LineChart, Line,
} from "recharts";
import {
  TrendingUp, TrendingDown, Wallet, Layers, Coins, ShieldAlert, ChevronRight,
  Plus, Trash2, RefreshCw, AlertTriangle, Search, Eye,
} from "lucide-react";
import {
  scoreBreakdown, simulateMonthsToGoal, solveRequiredContribution,
  solveDeltaForEarlierMonths, monthsBetweenDates, addMonthsToToday,
  computeMilestones, computeRebalanceDeviations, computeSystemHealth,
} from "../lib/financialMath.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const GOLD = "#C9A34E";
const GREEN = "#3FBF83";
const RED = "#E5615A";
const AMBER = "#E5A93A";
const NAVY_BG = "#0A0E17";
const PANEL = "#11172A";
const LINE = "#232B45";
const TXT = "#E8EAF2";
const MUTE = "#8A93B0";

const fmt$ = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt$2 = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const fmtPct1 = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtBig = (v) => {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return fmt$2(v);
};

async function sb(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer ${table} de Supabase`);
  return res.json();
}

async function fetchMarketData(items) {
  if (!items.length) return { data: {}, errors: [], updatedAt: null };
  const res = await fetch("/api/market-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("No se pudieron obtener datos de mercado");
  return res.json();
}

async function searchAssets(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("Busqueda fallo");
  return res.json();
}

async function callManage(resource, payload) {
  const res = await fetch("/api/manage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function managePosition(payload) { return callManage("positions", payload); }
async function manageWatchlist(payload) { return callManage("watchlist", payload); }
async function manageThesis(payload) { return callManage("thesis", payload); }
async function manageCash(payload) { return callManage("cash", payload); }
async function manageGoal(payload) { return callManage("goal", payload); }
async function manageDecisions(payload) { return callManage("decisions", payload); }
async function manageRebalance(payload) { return callManage("rebalance", payload); }
async function manageJournal(payload) { return callManage("journal", payload); }

// Debe coincidir con PROMPT_VERSION en api/ai.js -- si sube, el hash del
// Daily Brief cambia solo y el frontend sabe que hay que regenerar.
const PROMPT_VERSION_FRONTEND = "1.1.1";

async function callAI(resource, payload) {
  const res = await fetch("/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function generateInsight(payload) { return callAI("generate_insight", payload); }

async function fetchMarketPulse() {
  const res = await fetch("/api/market-pulse");
  if (!res.ok) return null;
  return res.json();
}

// Opportunity Score, simulacion de metas, salud del sistema, etc. --
// TODAS estas formulas viven en lib/financialMath.js, importadas abajo.
// Es la MISMA libreria que usan las tools de Moni AI (revision critica
// pre-Sprint-1, punto 5: "una sola fuente de formulas", cero drift
// matematico entre lo que ves en pantalla y lo que Moni AI interpreta).

const STARS = ["", "★", "★★", "★★★", "★★★★", "★★★★★"];

export default function Dashboard() {
  const [positions, setPositions] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [thesis, setThesis] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [cashMovements, setCashMovements] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [goals, setGoals] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [rebalanceTargets, setRebalanceTargets] = useState([]);
  const [aiInsights, setAiInsights] = useState([]);
  const [marketPulse, setMarketPulse] = useState(null);
  const [marketData, setMarketData] = useState({});
  const [marketErrors, setMarketErrors] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState("resumen");
  const [assetDetail, setAssetDetail] = useState(null); // { ticker, type, name, coingeckoId } | null

  function openAsset(meta) { setAssetDetail(meta); }
  function closeAsset() { setAssetDetail(null); }
  const [showAdd, setShowAdd] = useState(false);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [pos, wl, th, snaps, cm, tx, goalsData, journal, decisionsData, rebalanceData, insightsData] = await Promise.all([
        sb("positions"),
        sb("watchlist").catch(() => []),
        sb("thesis").catch(() => []),
        sb("snapshots").catch(() => []),
        sb("cash_movements").catch(() => []),
        sb("transactions").catch(() => []),
        sb("goals").catch(() => []),
        sb("journal_entries").catch(() => []),
        sb("decisions").catch(() => []),
        sb("rebalance_targets").catch(() => []),
        sb("ai_insights").catch(() => []),
      ]);
      setPositions(pos);
      setWatchlist(wl);
      setThesis(th);
      setSnapshots([...snaps].sort((a, b) => (a.date < b.date ? -1 : 1)));
      setCashMovements([...cm].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setTransactions([...tx].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setGoals(goalsData || []);
      setJournalEntries([...journal].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setDecisions(decisionsData || []);
      setRebalanceTargets(rebalanceData || []);
      setAiInsights([...(insightsData || [])].filter((i) => i.scope === "today").sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1)));

      fetchMarketPulse().then(setMarketPulse).catch(() => setMarketPulse(null));

      const items = [];
      const seen = new Set();
      [...pos.filter((p) => p.type !== "cash"), ...wl].forEach((p) => {
        const key = `${p.ticker}-${p.type}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ ticker: p.ticker, type: p.type, coingeckoId: p.coingecko_id || undefined });
      });

      const { data, errors, updatedAt: ts } = await fetchMarketData(items);
      setMarketData(data);
      setMarketErrors(errors || []);
      setUpdatedAt(ts);
    } catch (e) {
      setLoadError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 60000);
    return () => clearInterval(interval);
  }, []);

  const thesisByTicker = useMemo(() => {
    const m = {};
    thesis.forEach((t) => { m[t.ticker] = t; });
    return m;
  }, [thesis]);

  const enriched = useMemo(() => positions.map((p) => {
    const cost = Number(p.cost_basis);
    let value = null, md = null;
    if (p.type === "cash") {
      value = cost;
    } else {
      md = marketData[p.ticker];
      if (md) value = Number(p.shares) * md.price;
    }
    const gain = value != null ? value - cost : null;
    const pct = value != null && cost ? gain / cost : null;
    return { ...p, value, gain, pct, market: md || null, thesis: thesisByTicker[p.ticker] || null };
  }), [positions, marketData, thesisByTicker]);

  const watchlistEnriched = useMemo(() => watchlist.map((w) => ({
    ...w, market: marketData[w.ticker] || null,
  })), [watchlist, marketData]);

  const withValue = enriched.filter((p) => p.value != null);
  const missing = enriched.filter((p) => p.value == null);

  const stocksValue = withValue.filter((p) => p.type === "stock").reduce((a, p) => a + p.value, 0);
  const cryptoValue = withValue.filter((p) => p.type === "crypto").reduce((a, p) => a + p.value, 0);
  const cashValue = cashMovements.reduce((a, m) => a + (m.type === "deposito" ? Number(m.amount) : -Number(m.amount)), 0);

  const patrimonio = withValue.reduce((a, p) => a + p.value, 0) + cashValue;

  // Hash de frescura del Daily Brief: cambia si sube PROMPT_VERSION, si
  // cambia de dia, o si el patrimonio se movio de forma material. No
  // necesita ser criptografico -- solo distinguir "sigue vigente" de
  // "hay que regenerar".
  const todayISO = new Date().toISOString().slice(0, 10);
  const dailyBriefHash = `${PROMPT_VERSION_FRONTEND}::${todayISO}::${Math.round(patrimonio / 10) * 10}`;
  const latestInsight = aiInsights.find((i) => i.scope === "today") || null;
  const insightIsFresh = latestInsight?.based_on_hash === dailyBriefHash;
  const invested = withValue.reduce((a, p) => a + Number(p.cost_basis), 0) + cashValue;
  const totalGain = patrimonio - invested;
  const totalPct = invested ? totalGain / invested : 0;

  const snapshotPosted = useRef(false);
  useEffect(() => {
    // Solo se guarda si TODOS los tickers resolvieron precio -- un snapshot
    // parcial (por un fallo de rate limit, por ejemplo) mostraría un
    // patrimonio artificialmente bajo y ensuciaría Performance para siempre.
    if (!snapshotPosted.current && patrimonio > 0 && missing.length === 0) {
      snapshotPosted.current = true;
      fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patrimonio, invested, stocksValue, cryptoValue, cashValue }),
      }).catch(() => {});
    }
  }, [patrimonio, invested, stocksValue, cryptoValue, cashValue, missing.length]);

  const top5 = [...withValue].sort((a, b) => b.value - a.value).slice(0, 5);
  const top1Pct = patrimonio ? (top5[0]?.value || 0) / patrimonio : 0;
  const top3Pct = patrimonio ? top5.slice(0, 3).reduce((a, p) => a + p.value, 0) / patrimonio : 0;

  const allocType = [
    { name: "Acciones", value: stocksValue, color: GOLD },
    { name: "Cripto", value: cryptoValue, color: "#7C8CF8" },
    { name: "Efectivo", value: cashValue, color: MUTE },
  ].filter((a) => a.value > 0);

  const concColor = top1Pct > 0.35 ? RED : top1Pct > 0.2 ? AMBER : GREEN;

  // Oportunidades con Opportunity Score, dentro y fuera de cartera
  const scoredOpportunities = useMemo(() => {
    const fromPortfolio = withValue
      .filter((p) => p.type !== "cash" && p.market)
      .map((p) => {
        const b = scoreBreakdown({
          price: p.market.price, low: p.market.low, high: p.market.high,
          changePct: p.market.changePct, conviction: p.thesis?.conviction || 0,
        });
        return { ticker: p.ticker, name: p.name, type: p.type, coingeckoId: p.coingecko_id, source: "cartera", conviction: p.thesis?.conviction || 0, market: p.market, breakdown: b, score: b.total };
      });
    const fromWatchlist = watchlist
      .filter((w) => marketData[w.ticker])
      .map((w) => {
        const md = marketData[w.ticker];
        const b = scoreBreakdown({ price: md.price, low: md.low, high: md.high, changePct: md.changePct, conviction: 0 });
        const hitTarget = w.target_price != null && md.price <= Number(w.target_price);
        const total = Math.min(100, b.total + (hitTarget ? 20 : 0));
        return { ticker: w.ticker, name: w.name, type: w.type, coingeckoId: w.coingecko_id, source: "watchlist", conviction: 0, market: md, breakdown: { ...b, total }, score: total, hitTarget };
      });
    return [...fromPortfolio, ...fromWatchlist]
      .filter((o) => o.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [withValue, watchlist, marketData]);

  // Estado de Hoy: motor de reglas, riesgo > oportunidad > default. Moni AI solo narra esto, nunca lo decide.
  const estadoDeHoy = useMemo(() => {
    if (patrimonio === 0) return { emoji: "🟢", label: "Sin datos suficientes", detail: "" };
    if (top1Pct > 0.35) {
      const top = top5[0];
      return {
        emoji: "🔴", label: `Revisar concentración en ${top?.ticker || ""}`,
        detail: `Tu posición #1 pesa ${(top1Pct * 100).toFixed(1)}% de tu patrimonio.`,
      };
    }
    if (scoredOpportunities.length && scoredOpportunities[0].score >= 80) {
      const o = scoredOpportunities[0];
      return {
        emoji: "🟡", label: `Revisar ${o.ticker}${o.source === "watchlist" ? " en watchlist" : ""}`,
        detail: o.source === "cartera"
          ? `Posición ${o.conviction}★ con Opportunity Score ${o.score}.`
          : `En watchlist, Opportunity Score ${o.score}.`,
      };
    }
    return { emoji: "🟢", label: "Mantener estrategia", detail: "Ninguna señal relevante hoy." };
  }, [patrimonio, top1Pct, top5, scoredOpportunities]);

  // Estado de la Estrategia: reglas sobre datos ya calculados, sin opinión de IA
  const estadoEstrategia = useMemo(() => {
    if (patrimonio === 0) return [];
    const badges = [];
    if (top1Pct > 0.35) badges.push({ text: "Concentración elevada", color: RED });
    else if (top1Pct > 0.2) badges.push({ text: "Concentración moderada", color: AMBER });
    else badges.push({ text: "Diversificación correcta", color: GREEN });

    if (cashValue / patrimonio < 0.05) badges.push({ text: "Liquidez baja", color: AMBER });

    const iaTemas = ["IA / Cloud", "IA / Software", "Semiconductores IA", "Infraestructura IA"];
    const iaValue = withValue.filter((p) => iaTemas.includes(p.tema)).reduce((a, p) => a + p.value, 0);
    const iaPct = iaValue / patrimonio;
    if (iaPct > 0.55) badges.push({ text: `Sobrepeso IA (${(iaPct * 100).toFixed(0)}%)`, color: AMBER });

    if (badges.length === 1 && badges[0].text === "Diversificación correcta") {
      badges.push({ text: "Estrategia alineada", color: GREEN });
    }
    return badges;
  }, [patrimonio, top1Pct, cashValue, withValue]);

  // Qué cambió desde tu última visita: resta simple contra el snapshot anterior, ya existente en la tabla snapshots
  const cambiosRecientes = useMemo(() => {
    if (snapshots.length < 2) return null;
    const baseline = snapshots[snapshots.length - 2];
    const deltaPatrimonio = patrimonio - Number(baseline.patrimonio);
    const deltaPct = Number(baseline.patrimonio) ? deltaPatrimonio / Number(baseline.patrimonio) : 0;
    const movers = [...withValue]
      .filter((p) => p.type !== "cash" && p.market?.changePct != null)
      .sort((a, b) => Math.abs(b.market.changePct) - Math.abs(a.market.changePct))
      .slice(0, 2);
    return { baselineDate: baseline.date, deltaPatrimonio, deltaPct, movers };
  }, [snapshots, patrimonio, withValue]);

  const primaryGoal = goals.find((g) => g.is_primary) || goals[0] || null;
  const goalPct = primaryGoal?.target_amount ? Math.min(100, (patrimonio / Number(primaryGoal.target_amount)) * 100) : null;

  return (
    <div style={{ background: NAVY_BG, minHeight: "100vh", color: TXT, fontFamily: "'IBM Plex Sans','Inter',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .num { font-family: 'IBM Plex Mono', monospace; }
        .display { font-family: 'Fraunces', serif; }
        input, select { font-family: inherit; }
      `}</style>

      <div style={{ borderBottom: `1px solid ${LINE}`, overflow: "hidden", whiteSpace: "nowrap", background: PANEL, padding: "8px 0" }}>
        <div style={{ display: "inline-flex", gap: 28, padding: "0 16px" }}>
          {enriched.length === 0 && <span style={{ color: MUTE, fontSize: 12 }}>Cargando posiciones…</span>}
          {enriched.map((p) => (
            <span key={p.id} className="num" style={{ fontSize: 12, color: MUTE }}>
              <b style={{ color: TXT }}>{p.ticker}</b>{" "}
              {p.value != null ? fmt$(p.value) : <span style={{ color: AMBER }}>sin dato</span>}
            </span>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 24px 80px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 3, color: GOLD, fontWeight: 600, marginBottom: 6 }}>FAMILY OFFICE DIGITAL</div>
            <h1 className="display" style={{ fontSize: 40, fontWeight: 600, margin: 0, letterSpacing: -0.5 }}>Moni Capital</h1>
          </div>
          <div style={{ textAlign: "right", color: MUTE, fontSize: 12 }}>
            <button onClick={loadAll} disabled={loading} style={{
              background: PANEL, border: `1px solid ${LINE}`, color: TXT, borderRadius: 8,
              padding: "6px 12px", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 6,
            }}>
              <RefreshCw size={12} /> {loading ? "Actualizando…" : "Actualizar precios"}
            </button>
            <div>{updatedAt ? `Precios: ${new Date(updatedAt).toLocaleTimeString("es-MX")}` : "—"}</div>
          </div>
        </div>

        {loadError && (
          <Banner color={RED} icon={AlertTriangle}>
            No se pudo cargar el portafolio: {loadError}.
          </Banner>
        )}
        {missing.length > 0 && !loadError && (
          <Banner color={AMBER}>
            Sin precio en vivo por ahora: {missing.map((m) => m.ticker).join(", ")}. No se inventa su valor.
          </Banner>
        )}

        <div style={{ background: `linear-gradient(135deg, ${PANEL} 0%, #151C33 100%)`, border: `1px solid ${LINE}`, borderRadius: 14, padding: "32px 36px", marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: MUTE, letterSpacing: 1.5, marginBottom: 8 }}>PATRIMONIO TOTAL (con dato en vivo)</div>
          <div className="display num" style={{ fontSize: "clamp(32px, 8vw, 56px)", fontWeight: 700, letterSpacing: -1, lineHeight: 1 }}>
            {fmt$2(patrimonio)}
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
            <Metric label="Capital invertido" value={fmt$2(invested)} />
            <Metric label="Ganancia / Pérdida" value={fmt$2(totalGain)} color={totalGain >= 0 ? GREEN : RED} icon={totalGain >= 0 ? TrendingUp : TrendingDown} />
            <Metric label="Rendimiento" value={fmtPct(totalPct)} color={totalGain >= 0 ? GREEN : RED} />
          </div>
          <GoalBar goal={primaryGoal} patrimonio={patrimonio} goalPct={goalPct} onNavigate={setTab} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 28 }}>
          <KpiCard icon={Wallet} label="Efectivo" value={fmt$2(cashValue)} />
          <KpiCard icon={Layers} label="Valor en acciones" value={fmt$2(stocksValue)} />
          <KpiCard icon={Coins} label="Valor en cripto" value={fmt$2(cryptoValue)} />
          <KpiCard icon={Eye} label="En watchlist" value={`${watchlist.length}`} />
        </div>

        {!assetDetail && (
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${LINE}`, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
          {[["command", "Command Center"], ["resumen", "Resumen"], ["performance", "Performance"], ["posiciones", "Top Posiciones"], ["tesis", "Tesis"], ["wealth", "Wealth"], ["goals", "Goals"], ["historial", "Historial"], ["dividendos", "Dividendos"], ["journal", "Investment Journal"], ["discover", "Discover"], ["watchlist", "Watchlist"], ["efectivo", "Efectivo"], ["gestionar", "Gestionar"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              background: "none", border: "none", color: tab === key ? GOLD : MUTE, fontWeight: 600,
              fontSize: 13, padding: "10px 16px", cursor: "pointer",
              borderBottom: tab === key ? `2px solid ${GOLD}` : "2px solid transparent", marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>
        )}

        {assetDetail && (
          <AssetDetailScreen
            meta={assetDetail}
            positions={enriched}
            watchlist={watchlistEnriched}
            transactions={transactions}
            journalEntries={journalEntries}
            patrimonio={patrimonio}
            onBack={closeAsset}
            onSaved={loadAll}
            onOpenAsset={openAsset}
          />
        )}

        {!assetDetail && (
        <>

        {tab === "command" && (
          <CommandCenterTab
            estadoDeHoy={estadoDeHoy} scoredOpportunities={scoredOpportunities}
            withValue={withValue} cashValue={cashValue} patrimonio={patrimonio} top1Pct={top1Pct}
            enriched={enriched} primaryGoal={primaryGoal}
            decisions={decisions} rebalanceTargets={rebalanceTargets}
            onOpenAsset={openAsset} onChanged={loadAll}
          />
        )}

        {tab === "resumen" && (
          <div style={{ display: "grid", gap: 14 }}>
            <TodayStatusCard estado={estadoDeHoy} onNavigate={setTab} />

            <DailyBriefCard
              latestInsight={latestInsight} insightIsFresh={insightIsFresh} hash={dailyBriefHash}
              history={aiInsights} onGenerated={loadAll}
            />

            <MarketPulseRow pulse={marketPulse} />

            <Panel title="Oportunidades — dentro y fuera de tu cartera">
              <ScoredOpportunities rows={scoredOpportunities} />
              <CtaLink label="Ver Top Posiciones" onClick={() => setTab("posiciones")} />
            </Panel>

            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 14 }}>
              <Panel title="Dónde está tu dinero">
                {allocType.length === 0 ? <Empty /> : (
                  <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                    <ResponsiveContainer width={140} height={140}>
                      <PieChart>
                        <Pie data={allocType} dataKey="value" innerRadius={38} outerRadius={62} paddingAngle={2}>
                          {allocType.map((e, i) => <Cell key={i} fill={e.color} stroke="none" />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {allocType.map((e, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                          <span style={{ width: 10, height: 10, borderRadius: "50%", background: e.color, display: "inline-block" }} />
                          <span style={{ color: MUTE }}>{e.name}</span>
                          <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{patrimonio ? ((e.value / patrimonio) * 100).toFixed(1) : "0.0"}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <CtaLink label="Ver Allocation" onClick={() => setTab("allocation")} />
              </Panel>

              <Panel title="Estado de la estrategia">
                {estadoEstrategia.length === 0 ? <Empty /> : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {estadoEstrategia.map((b, i) => (
                      <span key={i} style={{
                        background: `${b.color}1A`, color: b.color, border: `1px solid ${b.color}`,
                        borderRadius: 999, padding: "4px 12px", fontSize: 11, fontWeight: 700,
                      }}>{b.text}</span>
                    ))}
                  </div>
                )}
                <CtaLink label="Analizar riesgo" onClick={() => setTab("resumen")} />
              </Panel>
            </div>

            <Panel title="Qué cambió desde tu última visita">
              {!cambiosRecientes ? (
                <div style={{ color: MUTE, fontSize: 13 }}>Aún no hay suficiente historial para comparar — vuelve mañana.</div>
              ) : (
                <div style={{ fontSize: 12, color: MUTE, lineHeight: 2 }}>
                  <div>Desde {cambiosRecientes.baselineDate}:</div>
                  <div>
                    Patrimonio <b style={{ color: cambiosRecientes.deltaPatrimonio >= 0 ? GREEN : RED }}>
                      {cambiosRecientes.deltaPatrimonio >= 0 ? "+" : ""}{fmt$2(cambiosRecientes.deltaPatrimonio)} ({fmtPct(cambiosRecientes.deltaPct)})
                    </b>
                  </div>
                  {cambiosRecientes.movers.map((m) => (
                    <div key={m.id}>{m.ticker} <b style={{ color: (m.market.changePct || 0) >= 0 ? GREEN : RED }}>{fmtPct1(m.market.changePct)}</b></div>
                  ))}
                </div>
              )}
              <CtaLink label="Ver Performance" onClick={() => setTab("performance")} />
            </Panel>

            <Panel title="Riesgo">
              {patrimonio === 0 ? <Empty /> : (
                <>
                  <SemRow label="Peso de la posición #1" value={top1Pct} color={concColor} />
                  <SemRow label="Peso combinado Top 3" value={top3Pct} color={top3Pct > 0.55 ? RED : top3Pct > 0.35 ? AMBER : GREEN} />
                  <SemRow label="Efectivo / Patrimonio" value={patrimonio ? cashValue / patrimonio : 0} color={GOLD} />
                </>
              )}
            </Panel>
          </div>
        )}

        {tab === "performance" && (
          <Panel title="Performance — evolución de tu patrimonio">
            <PerformanceTab snapshots={snapshots} />
          </Panel>
        )}

        {tab === "posiciones" && (
          <Panel title="Top Posiciones — con contexto de rango">
            <RichPositionsTable rows={[...withValue].sort((a, b) => b.value - a.value)} patrimonio={patrimonio} onOpenAsset={openAsset} />
          </Panel>
        )}

        {tab === "tesis" && (
          <Panel title="Investment Thesis — por qué tienes cada posición">
            <ThesisTab rows={enriched.filter((p) => p.type !== "cash")} onSaved={loadAll} onOpenAsset={openAsset} />
          </Panel>
        )}

        {tab === "wealth" && (
          <WealthTab
            patrimonio={patrimonio} invested={invested} totalGain={totalGain} totalPct={totalPct}
            stocksValue={stocksValue} cryptoValue={cryptoValue} cashValue={cashValue}
            withValue={withValue} top5={top5} top1Pct={top1Pct} top3Pct={top3Pct} concColor={concColor}
            allocType={allocType} snapshots={snapshots} goal={primaryGoal} goalPct={goalPct}
            transactions={transactions} cashMovements={cashMovements}
            onOpenAsset={openAsset}
          />
        )}

        {tab === "goals" && (
          <GoalsTab goals={goals} patrimonio={patrimonio} snapshots={snapshots} onChanged={loadAll} />
        )}

        {tab === "historial" && (
          <Panel title="Historial de transacciones">
            <HistorialTab rows={transactions} />
          </Panel>
        )}

        {tab === "dividendos" && (
          <Panel title="Dividendos">
            <DividendosTab rows={transactions} />
          </Panel>
        )}

        {tab === "journal" && <JournalTab entries={journalEntries} onChanged={loadAll} />}

        {tab === "discover" && <DiscoverTab onWatchlistAdded={loadAll} onOpenAsset={openAsset} dailyOpportunities={scoredOpportunities} positions={enriched} />}

        {tab === "watchlist" && (
          <Panel title="Watchlist">
            <WatchlistTable rows={watchlistEnriched} onDeleted={loadAll} onOpenAsset={openAsset} />
          </Panel>
        )}

        {tab === "efectivo" && (
          <Panel title="Efectivo — depósitos y retiros">
            <CashTab movements={cashMovements} balance={cashValue} onChanged={loadAll} />
          </Panel>
        )}

        {tab === "gestionar" && (
          <Panel title="Gestionar posiciones">
            <button onClick={() => setShowAdd((s) => !s)} style={{
              background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px",
              fontWeight: 700, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 20,
            }}>
              <Plus size={16} /> Agregar activo
            </button>
            {showAdd && <AddForm onDone={() => { setShowAdd(false); loadAll(); }} existingPositions={enriched} />}
            <ManageTable rows={enriched} onDeleted={loadAll} />
          </Panel>
        )}
        </>
        )}

        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 8, color: MUTE, fontSize: 12 }}>
          <ChevronRight size={14} />
          Precios de acciones vía Finnhub, cripto vía CoinGecko. Rango de referencia: 52 semanas (acciones) / histórico ATH-ATL (cripto). Informativo, no es asesoría de inversión.
        </div>
      </div>
    </div>
  );
}

function Banner({ color, icon: Icon = AlertTriangle, children }) {
  return (
    <div style={{ background: "#1A1710", border: `1px solid ${color}`, borderRadius: 10, padding: "12px 18px", marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13 }}>
      <Icon size={16} color={color} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

function Metric({ label, value, color, icon: Icon }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: MUTE, marginBottom: 2 }}>{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 600, color: color || TXT, display: "flex", alignItems: "center", gap: 6 }}>
        {Icon && <Icon size={16} />}{value}
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value }) {
  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: MUTE, fontSize: 12, marginBottom: 8 }}>
        <Icon size={14} color={GOLD} /> {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Panel({ title, children, span }) {
  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: 24, gridColumn: span ? `span ${span}` : undefined }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: TXT, marginBottom: 18, letterSpacing: 0.3 }}>{title}</div>
      {children}
    </div>
  );
}

function SemRow({ label, value, color }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: MUTE }}>{label}</span>
        <span className="num" style={{ fontWeight: 700, color }}>{(value * 100).toFixed(1)}%</span>
      </div>
      <div style={{ height: 6, background: LINE, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(value * 100, 100)}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function Empty() {
  return <div style={{ color: MUTE, fontSize: 13 }}>Sin datos suficientes todavía.</div>;
}

const TX_TYPE_LABEL = {
  compra: "COMPRA", venta: "VENTA", dividendo: "DIVIDENDO", split: "SPLIT", evento: "EVENTO",
};
const TX_TYPE_COLOR = {
  compra: RED, venta: GREEN, dividendo: GOLD, split: "#7C8CF8", evento: MUTE,
};

function HistorialTab({ rows }) {
  const [filter, setFilter] = useState("todos");

  const filtered = filter === "todos" ? rows : rows.filter((t) => t.type === filter);
  const filterOptions = [
    ["todos", "Todos"], ["compra", "Compras"], ["venta", "Ventas"],
    ["dividendo", "Dividendos"], ["split", "Splits"],
  ];

  if (rows.length === 0) return <div style={{ color: MUTE, fontSize: 13 }}>Sin historial cargado todavía.</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {filterOptions.map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            background: filter === key ? GOLD : "none", color: filter === key ? "#1A1305" : MUTE,
            border: `1px solid ${filter === key ? GOLD : LINE}`, borderRadius: 999, padding: "5px 14px",
            fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>{label}</button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
              <th style={{ padding: "8px 6px" }}>Fecha</th>
              <th style={{ padding: "8px 6px" }}>Ticker</th>
              <th style={{ padding: "8px 6px" }}>Tipo</th>
              <th style={{ padding: "8px 6px", textAlign: "right" }}>Monto</th>
              <th style={{ padding: "8px 6px", textAlign: "right" }}>Cantidad</th>
              <th style={{ padding: "8px 6px" }}>Notas</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                <td style={{ padding: "10px 6px", color: MUTE }}>{t.date}</td>
                <td style={{ padding: "10px 6px" }}><b>{t.ticker}</b></td>
                <td style={{ padding: "10px 6px" }}>
                  <span style={{
                    color: TX_TYPE_COLOR[t.type] || MUTE, border: `1px solid ${TX_TYPE_COLOR[t.type] || MUTE}`,
                    borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                  }}>{TX_TYPE_LABEL[t.type] || t.type?.toUpperCase()}</span>
                </td>
                <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: Number(t.amount) > 0 ? GREEN : (Number(t.amount) < 0 ? RED : MUTE) }}>
                  {t.amount != null ? fmt$2(Number(t.amount)) : "—"}
                </td>
                <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: MUTE }}>
                  {t.quantity != null ? Number(t.quantity).toFixed(4) : "—"}
                </td>
                <td style={{ padding: "10px 6px", color: MUTE, fontSize: 12 }}>{t.notes || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: MUTE, marginTop: 10 }}>
        {filtered.length} {filtered.length === 1 ? "movimiento" : "movimientos"}. Los depósitos/retiros de efectivo viven en la pestaña "Efectivo", no aquí.
      </div>
    </div>
  );
}

function DividendosTab({ rows }) {
  const dividendos = rows.filter((t) => t.type === "dividendo");
  const total = dividendos.reduce((a, t) => a + Number(t.amount || 0), 0);

  const byTicker = {};
  dividendos.forEach((t) => {
    byTicker[t.ticker] = (byTicker[t.ticker] || 0) + Number(t.amount || 0);
  });
  const chartData = Object.entries(byTicker).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));

  if (dividendos.length === 0) {
    return <div style={{ color: MUTE, fontSize: 13 }}>Sin dividendos registrados todavía.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 24 }}>
        <Metric label="Total recibido en dividendos" value={fmt$2(total)} color={GOLD} />
        <Metric label="Empresas que pagaron" value={`${chartData.length}`} />
        <Metric label="Pagos registrados" value={`${dividendos.length}`} />
      </div>

      <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 34)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
          <XAxis type="number" tickFormatter={fmt$2} stroke={MUTE} fontSize={11} />
          <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={11} width={70} />
          <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
          <Bar dataKey="value" fill={GOLD} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>

      <div style={{ marginTop: 24, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 400 }}>
          <thead>
            <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
              <th style={{ padding: "8px 6px" }}>Fecha</th>
              <th style={{ padding: "8px 6px" }}>Ticker</th>
              <th style={{ padding: "8px 6px", textAlign: "right" }}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {dividendos.map((t) => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                <td style={{ padding: "8px 6px", color: MUTE }}>{t.date}</td>
                <td style={{ padding: "8px 6px" }}><b>{t.ticker}</b></td>
                <td className="num" style={{ padding: "8px 6px", textAlign: "right", color: GOLD }}>{fmt$2(Number(t.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CtaLink({ label, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: "none", border: "none", color: GOLD, fontSize: 11, fontWeight: 700,
      cursor: "pointer", padding: 0, marginTop: 10, display: "block",
    }}>{label} →</button>
  );
}

function TodayStatusCard({ estado, onNavigate }) {
  const borderColor = estado.emoji === "🔴" ? RED : estado.emoji === "🟡" ? AMBER : GREEN;
  return (
    <div style={{ background: "#151129", border: `1.5px solid ${borderColor}`, borderRadius: 12, padding: "18px 22px" }}>
      <div style={{ fontSize: 10, color: MUTE, letterSpacing: 1, marginBottom: 6 }}>¿NECESITO HACER ALGO HOY?</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18 }}>{estado.emoji}</span>
        <div className="display" style={{ fontSize: 22, fontWeight: 700 }}>{estado.label}</div>
      </div>
      {estado.detail && <div style={{ fontSize: 12, color: MUTE, marginTop: 6 }}>{estado.detail}</div>}
      <CtaLink label="Abrir tesis" onClick={() => onNavigate("tesis")} />
    </div>
  );
}

function BriefSection({ label, text }) {
  if (!text) return null;
  return (
    <div>
      <div style={{ fontSize: 9, color: MUTE, letterSpacing: 0.5, marginBottom: 2 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 13 }}>{text}</div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "hace un momento";
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

function DailyBriefCard({ latestInsight, insightIsFresh, hash, history, onGenerated }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showPinInput, setShowPinInput] = useState(false);

  async function handleGenerate() {
    if (!pin) return;
    setBusy(true); setErr(null);
    try {
      await generateInsight({ pin, scope: "today", hash });
      setShowPinInput(false);
      setPin("");
      onGenerated(); // async, no bloquea el resto de TODAY -- solo esta tarjeta muestra su propio spinner
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const content = latestInsight?.content || null;
  const confidence = latestInsight?.confidence;
  const confidenceColor = confidence == null ? MUTE : confidence >= 80 ? GREEN : confidence >= 50 ? AMBER : RED;

  return (
    <div style={{ background: "#151129", border: `1px solid ${GOLD}`, borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: content ? 12 : 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: GOLD, letterSpacing: 1, fontWeight: 700 }}>MONI AI — DAILY BRIEF</span>
          {content && <span style={{ fontSize: 10, color: MUTE }}>{timeAgo(latestInsight.generated_at)}</span>}
        </div>
        {confidence != null && content && (
          <span style={{ fontSize: 10, color: confidenceColor, border: `1px solid ${confidenceColor}`, borderRadius: 4, padding: "2px 8px" }}>
            Confidence {confidence}%
          </span>
        )}
      </div>

      {!content ? (
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 12 }}>Todavía no se ha generado el Daily Brief de hoy.</div>
      ) : (
        <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
          <BriefSection label="Estado General" text={content.estado_general} />
          <BriefSection label="Prioridad del Día" text={content.prioridad_del_dia} />
          <BriefSection label="Lo que cambió" text={content.que_cambio} />
          <BriefSection label="Acción sugerida" text={content.accion_sugerida} />
        </div>
      )}

      {content && !insightIsFresh && (
        <div style={{ fontSize: 10, color: AMBER, marginBottom: 10 }}>Esto podría estar desactualizado — tus datos cambiaron desde que se generó.</div>
      )}

      {showPinInput ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="password" placeholder="Tu PIN" value={pin} onChange={(e) => setPin(e.target.value)}
            style={{ background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "6px 10px", fontSize: 12, width: 120 }} />
          <button onClick={handleGenerate} disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "6px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            {busy ? "Generando…" : "Confirmar"}
          </button>
          <button onClick={() => setShowPinInput(false)} style={{ background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>Cancelar</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={() => setShowPinInput(true)} style={{
            background: content ? "none" : GOLD, color: content ? GOLD : "#1A1305", border: `1px solid ${GOLD}`,
            borderRadius: 6, padding: "8px 16px", fontWeight: 700, fontSize: 12, cursor: "pointer",
          }}>
            {content ? "Actualizar" : "Generar Daily Brief"}
          </button>
          {history.length > 1 && (
            <button onClick={() => setShowHistory((s) => !s)} style={{ background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>
              {showHistory ? "Ocultar historial" : `Ver historial (${history.length})`}
            </button>
          )}
        </div>
      )}
      {err && <div style={{ color: RED, fontSize: 11, marginTop: 8 }}>{err}</div>}

      {showHistory && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${LINE}`, display: "grid", gap: 8, maxHeight: 260, overflowY: "auto" }}>
          {history.slice(1, 30).map((h) => (
            <div key={h.id} style={{ fontSize: 11, color: MUTE }}>
              <b style={{ color: TXT }}>{new Date(h.generated_at).toLocaleString("es-MX")}</b>
              {h.confidence != null && <span> ({h.confidence}% confianza)</span>}
              <div style={{ marginTop: 2 }}>{h.content?.estado_general || "Sin contenido registrado."}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MarketPulseRow({ pulse }) {
  if (!pulse) return null;
  const item = (label, value, color) => (
    <div style={{ fontSize: 11 }}><span style={{ color: MUTE }}>{label}</span> <b style={{ color: color || TXT }}>{value}</b></div>
  );
  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 16px", display: "flex", gap: 20, flexWrap: "wrap" }}>
      {item("Fear & Greed (cripto)", pulse.fearGreed != null ? pulse.fearGreed : "sin dato", AMBER)}
      {item("VIX", pulse.vix != null ? pulse.vix.toFixed(1) : "sin dato", pulse.vix != null && pulse.vix > 20 ? RED : GREEN)}
      {item("NASDAQ (QQQ)", pulse.nasdaqChangePct != null ? fmtPct1(pulse.nasdaqChangePct) : "sin dato", (pulse.nasdaqChangePct || 0) >= 0 ? GREEN : RED)}
      {item("BTC", pulse.btcChangePct != null ? fmtPct1(pulse.btcChangePct) : "sin dato", (pulse.btcChangePct || 0) >= 0 ? GREEN : RED)}
    </div>
  );
}

function ScoredOpportunities({ rows }) {
  const [expanded, setExpanded] = useState(null);
  if (rows.length === 0) {
    return <div style={{ color: MUTE, fontSize: 13 }}>Sin oportunidades con Opportunity Score ≥ 50 ahora mismo.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((o) => {
        const scoreColor = o.score >= 80 ? GREEN : o.score >= 65 ? "#7FCF9E" : AMBER;
        const isOpen = expanded === o.ticker;
        return (
          <div key={o.ticker} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12 }}>
                <b>{o.ticker}</b> <span style={{ color: MUTE, fontSize: 11 }}>{o.name}</span>
                <span style={{ color: MUTE, fontSize: 10 }}> · {o.source === "cartera" ? `${"★".repeat(o.conviction)} en cartera` : "watchlist"}{o.hitTarget ? " · en tu precio objetivo" : ""}</span>
              </div>
              <button onClick={() => setExpanded(isOpen ? null : o.ticker)} style={{
                background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
              }}>
                <span className="num" style={{ color: scoreColor, fontWeight: 700, fontSize: 14 }}>{o.score}</span>
                <span style={{ width: 14, height: 14, borderRadius: "50%", border: `1px solid ${MUTE}`, fontSize: 9, color: MUTE, display: "flex", alignItems: "center", justifyContent: "center" }}>i</span>
              </button>
            </div>
            {isOpen && (
              <div style={{ background: NAVY_BG, border: `1px dashed ${LINE}`, borderRadius: 6, padding: "8px 10px", marginTop: 8, fontSize: 10, color: MUTE }}>
                Convicción → {o.breakdown.convictionPts} pts · Rango → {o.breakdown.rangePts} pts · Momentum → {o.breakdown.momentumPts} pts
                {o.hitTarget && " · Precio objetivo alcanzado → +20 pts"} &nbsp;=&nbsp; <b style={{ color: TXT }}>{o.score}</b>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GoalBar({ goal, patrimonio, goalPct, onNavigate }) {
  if (!goal) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <button onClick={() => onNavigate("goals")} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>
          + Definir meta patrimonial
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: MUTE, marginBottom: 4 }}>
        <span>{(goal.name || "META PATRIMONIAL").toUpperCase()} · {fmt$2(Number(goal.target_amount))} <span onClick={() => onNavigate("goals")} style={{ color: GOLD, cursor: "pointer", marginLeft: 6 }}>ver plan →</span></span>
        <span style={{ color: GOLD, fontWeight: 700 }}>{goalPct != null ? goalPct.toFixed(1) : "0.0"}%</span>
      </div>
      <div style={{ height: 5, background: LINE, borderRadius: 3 }}>
        <div style={{ height: "100%", width: `${goalPct || 0}%`, background: GOLD, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function CashTab({ movements, balance, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function handleDelete(m) {
    const pin = window.prompt("Ingresa tu PIN para borrar este movimiento:");
    if (!pin) return;
    setBusyId(m.id);
    try {
      await manageCash({ pin, action: "delete", id: m.id });
      onChanged();
    } catch (e) { alert("No se pudo borrar: " + e.message); }
    finally { setBusyId(null); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <Metric label="Balance de efectivo actual" value={fmt$2(balance)} icon={Wallet} />
        <button onClick={() => setShowForm((s) => !s)} style={{
          background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px",
          fontWeight: 700, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
        }}>
          <Plus size={16} /> {showForm ? "Cancelar" : "Registrar movimiento"}
        </button>
      </div>

      {showForm && <CashMovementForm onDone={() => { setShowForm(false); onChanged(); }} />}

      {movements.length === 0 ? (
        <div style={{ color: MUTE, fontSize: 13 }}>Sin movimientos registrados todavía.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
              <th style={{ padding: "8px 6px" }}>Fecha</th>
              <th style={{ padding: "8px 6px" }}>Tipo</th>
              <th style={{ padding: "8px 6px", textAlign: "right" }}>Monto</th>
              <th style={{ padding: "8px 6px" }}>Nota / Para qué</th>
              <th style={{ padding: "8px 6px" }}></th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                <td style={{ padding: "10px 6px", color: MUTE }}>{m.date}</td>
                <td style={{ padding: "10px 6px" }}>
                  <span style={{
                    color: m.type === "deposito" ? GREEN : RED, border: `1px solid ${m.type === "deposito" ? GREEN : RED}`,
                    borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700,
                  }}>{m.type === "deposito" ? "DEPÓSITO" : "RETIRO"}</span>
                </td>
                <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: m.type === "deposito" ? GREEN : RED }}>
                  {m.type === "deposito" ? "+" : "-"}{fmt$2(Number(m.amount))}
                </td>
                <td style={{ padding: "10px 6px", color: m.note ? TXT : MUTE, fontStyle: m.note ? "normal" : "italic" }}>
                  {m.note || "Sin nota"}
                </td>
                <td style={{ padding: "10px 6px", textAlign: "right" }}>
                  <button onClick={() => handleDelete(m)} disabled={busyId === m.id} style={{
                    background: "none", border: `1px solid ${RED}`, color: RED, borderRadius: 6, padding: "4px 8px",
                    cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4,
                  }}><Trash2 size={12} /> {busyId === m.id ? "…" : "Borrar"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function CashMovementForm({ onDone }) {
  const [type, setType] = useState("deposito");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const inputStyle = { background: PANEL, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!amount || Number(amount) <= 0) { setErr("Pon un monto válido."); return; }
    setBusy(true);
    try {
      await manageCash({
        pin, action: "add",
        movement: { type, amount: Number(amount), date, note: note || null },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginBottom: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Tipo *</label>
        <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="deposito">Depósito (entra dinero)</option>
          <option value="retiro">Retiro (sale dinero)</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Monto ($) *</label><input style={inputStyle} type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Fecha *</label><input style={inputStyle} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div style={{ gridColumn: "span 2" }}>
        <label style={{ fontSize: 11, color: MUTE }}>{type === "retiro" ? "¿Para qué usaste este dinero?" : "¿De dónde vino? (opcional)"}</label>
        <input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === "retiro" ? "Ej. gasto personal, comisión, transferencia..." : "Ej. depósito de nómina, ahorro mensual..."} />
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", width: "100%" }}>
          {busy ? "Guardando…" : "Guardar movimiento"}
        </button>
      </div>
      {err && <div style={{ gridColumn: "1 / -1", color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}

function PerformanceTab({ snapshots }) {
  if (!snapshots || snapshots.length === 0) {
    return <div style={{ color: MUTE, fontSize: 13 }}>Aún no hay historial — vuelve mañana. Cada día que abras el sitio se guarda una "foto" de tu patrimonio.</div>;
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const change = last.patrimonio - first.patrimonio;
  const changePct = first.patrimonio ? change / first.patrimonio : 0;

  const chartData = snapshots.map((s) => ({
    date: s.date,
    Patrimonio: Number(s.patrimonio),
    Invertido: Number(s.invested),
  }));

  return (
    <div>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 24 }}>
        <Metric label={`Primer registro (${first.date})`} value={fmt$2(Number(first.patrimonio))} />
        <Metric label={`Hoy (${last.date})`} value={fmt$2(Number(last.patrimonio))} />
        <Metric label="Cambio del período" value={fmt$2(change)} color={change >= 0 ? GREEN : RED} icon={change >= 0 ? TrendingUp : TrendingDown} />
        <Metric label="Rendimiento del período" value={fmtPct(changePct)} color={change >= 0 ? GREEN : RED} />
      </div>

      {snapshots.length < 3 ? (
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 12 }}>
          Con solo {snapshots.length} {snapshots.length === 1 ? "registro" : "registros"} la gráfica todavía no dice mucho — entre más días abras el sitio, más útil se vuelve esta vista.
        </div>
      ) : null}

      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={chartData} margin={{ left: 10, right: 20, top: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
          <XAxis dataKey="date" stroke={MUTE} fontSize={11} />
          <YAxis stroke={MUTE} fontSize={11} tickFormatter={fmt$} width={70} />
          <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
          <Line type="monotone" dataKey="Patrimonio" stroke={GOLD} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Invertido" stroke={MUTE} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, color: MUTE, marginTop: 10 }}>
        Se guarda un registro por día (la primera vez que abres el sitio ese día). Línea dorada = patrimonio total, línea punteada = capital invertido.
      </div>
    </div>
  );
}

// Barra que ubica el precio actual dentro de su rango de referencia
function RangeBar({ price, low, high, label, compact }) {
  if (low == null || high == null || high <= low || price == null) {
    return <div style={{ fontSize: 11, color: MUTE }}>Sin rango disponible</div>;
  }
  const pct = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  const color = pct < 25 ? GREEN : pct > 75 ? RED : AMBER;
  const tag = pct < 25 ? "cerca del mínimo" : pct > 75 ? "cerca del máximo" : "rango medio";
  return (
    <div style={{ minWidth: compact ? 120 : 180 }}>
      {!compact && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: MUTE, marginBottom: 3 }}>
          <span>Rango {label}</span><span style={{ color, fontWeight: 700 }}>{tag}</span>
        </div>
      )}
      <div style={{ position: "relative", height: 6, background: LINE, borderRadius: 3 }}>
        <div style={{ position: "absolute", left: `${pct}%`, top: -2, width: 10, height: 10, borderRadius: "50%", background: color, transform: "translateX(-50%)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: MUTE, marginTop: 3 }}>
        <span>{fmt$2(low)}</span><span>{fmt$2(high)}</span>
      </div>
    </div>
  );
}

function RichPositionsTable({ rows, patrimonio, onOpenAsset }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
        <thead>
          <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
            <th style={{ padding: "8px 6px" }}>#</th>
            <th style={{ padding: "8px 6px" }}>Activo</th>
            <th style={{ padding: "8px 6px" }}>Convicción</th>
            <th style={{ padding: "8px 6px", textAlign: "right" }}>Valor</th>
            <th style={{ padding: "8px 6px", textAlign: "right" }}>Ganancia</th>
            <th style={{ padding: "8px 6px", textAlign: "right" }}>Día</th>
            <th style={{ padding: "8px 6px", textAlign: "right" }}>Cap. Mercado</th>
            <th style={{ padding: "8px 6px" }}>Rango</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id} style={{ borderBottom: `1px solid ${LINE}` }}>
              <td style={{ padding: "10px 6px", color: MUTE }}>{i + 1}</td>
              <td style={{ padding: "10px 6px" }}>
                <button onClick={() => onOpenAsset({ ticker: p.ticker, type: p.type, name: p.name, coingeckoId: p.coingecko_id })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                  <b style={{ color: GOLD }}>{p.ticker}</b> <span style={{ color: MUTE, fontSize: 12 }}>{p.name}</span>
                </button>
              </td>
              <td style={{ padding: "10px 6px" }}><ConvictionStars value={p.thesis?.conviction} /></td>
              <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{fmt$2(p.value)}</td>
              <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: p.gain >= 0 ? GREEN : RED }}>
                {p.gain != null ? fmt$2(p.gain) : "—"}
              </td>
              <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: (p.market?.changePct || 0) >= 0 ? GREEN : RED }}>
                {p.market?.changePct != null ? fmtPct1(p.market.changePct) : "—"}
              </td>
              <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{fmtBig(p.market?.marketCap)}</td>
              <td style={{ padding: "10px 6px" }}>
                {p.market ? <RangeBar price={p.market.price} low={p.market.low} high={p.market.high} label={p.market.rangeLabel} compact /> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManageTable({ rows, onDeleted }) {
  const [busyId, setBusyId] = useState(null);
  async function handleDelete(row) {
    const pin = window.prompt(`Ingresa tu PIN para eliminar ${row.ticker}:`);
    if (!pin) return;
    setBusyId(row.id);
    try {
      await managePosition({ pin, action: "delete", id: row.id });
      onDeleted();
    } catch (e) { alert("No se pudo eliminar: " + e.message); }
    finally { setBusyId(null); }
  }
  async function handleRoleChange(row, newRole) {
    const pin = window.prompt(`Ingresa tu PIN para actualizar el rol estratégico de ${row.ticker}:`);
    if (!pin) return;
    setBusyId(row.id);
    try {
      await managePosition({ pin, action: "update", id: row.id, position: { strategic_role: newRole || null } });
      onDeleted();
    } catch (e) { alert("No se pudo actualizar: " + e.message); }
    finally { setBusyId(null); }
  }
  return (
    <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10, minWidth: 700 }}>
      <thead>
        <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
          <th style={{ padding: "8px 6px" }}>Ticker</th><th style={{ padding: "8px 6px" }}>Nombre</th>
          <th style={{ padding: "8px 6px" }}>Tipo</th><th style={{ padding: "8px 6px", textAlign: "right" }}>Acciones/Unid.</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Costo</th>
          <th style={{ padding: "8px 6px" }}>Rol estratégico</th>
          <th style={{ padding: "8px 6px" }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} style={{ borderBottom: `1px solid ${LINE}` }}>
            <td style={{ padding: "10px 6px" }}><b>{p.ticker}</b></td>
            <td style={{ padding: "10px 6px", color: MUTE }}>{p.name}</td>
            <td style={{ padding: "10px 6px", color: MUTE }}>{p.type}</td>
            <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{p.shares}</td>
            <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{fmt$2(Number(p.cost_basis))}</td>
            <td style={{ padding: "10px 6px" }}>
              <select
                value={p.strategic_role || ""} disabled={busyId === p.id}
                onChange={(e) => handleRoleChange(p, e.target.value)}
                style={{ background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "4px 6px", fontSize: 11 }}
              >
                <option value="">Sin clasificar</option>
                {STRATEGIC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </td>
            <td style={{ padding: "10px 6px", textAlign: "right" }}>
              <button onClick={() => handleDelete(p)} disabled={busyId === p.id} style={{
                background: "none", border: `1px solid ${RED}`, color: RED, borderRadius: 6, padding: "4px 8px",
                cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4,
              }}><Trash2 size={12} /> {busyId === p.id ? "…" : "Eliminar"}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

const WATCHLIST_STATUSES = [
  ["investigando", "Investigando"],
  ["vigilando", "Vigilando"],
  ["listo", "Lista para comprar"],
];

function WatchlistTable({ rows, onDeleted, onOpenAsset }) {
  const [busyId, setBusyId] = useState(null);

  async function handleDelete(row) {
    const pin = window.prompt(`Ingresa tu PIN para quitar ${row.ticker} de la watchlist:`);
    if (!pin) return;
    setBusyId(row.id);
    try {
      await manageWatchlist({ pin, action: "delete", id: row.id });
      onDeleted();
    } catch (e) { alert("No se pudo eliminar: " + e.message); }
    finally { setBusyId(null); }
  }

  async function handleStatusChange(row, newStatus) {
    const pin = window.prompt(`Ingresa tu PIN para mover ${row.ticker} a "${WATCHLIST_STATUSES.find(([k]) => k === newStatus)[1]}":`);
    if (!pin) return;
    setBusyId(row.id);
    try {
      await manageWatchlist({ pin, action: "update", id: row.id, item: { status: newStatus } });
      onDeleted();
    } catch (e) { alert("No se pudo mover: " + e.message); }
    finally { setBusyId(null); }
  }

  if (rows.length === 0) return <div style={{ color: MUTE, fontSize: 13 }}>Tu watchlist está vacía. Agrega activos desde "Discover".</div>;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {WATCHLIST_STATUSES.map(([statusKey, statusLabel]) => {
        const group = rows.filter((w) => (w.status || "investigando") === statusKey);
        return (
          <div key={statusKey}>
            <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 8, letterSpacing: 0.5 }}>
              {statusLabel} <span style={{ color: MUTE, fontWeight: 400 }}>({group.length})</span>
            </div>
            {group.length === 0 ? (
              <div style={{ color: MUTE, fontSize: 12, fontStyle: "italic", marginBottom: 4 }}>Nada aquí todavía.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 780 }}>
                  <thead>
                    <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
                      <th style={{ padding: "8px 6px" }}>Activo</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>Precio</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>Día</th>
                      <th style={{ padding: "8px 6px" }}>Rango</th>
                      <th style={{ padding: "8px 6px", textAlign: "right" }}>Precio objetivo</th>
                      <th style={{ padding: "8px 6px" }}>Mover a</th>
                      <th style={{ padding: "8px 6px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.map((w) => {
                      const hitTarget = w.target_price != null && w.market?.price != null && w.market.price <= Number(w.target_price);
                      return (
                        <tr key={w.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                          <td style={{ padding: "10px 6px" }}>
                            <button onClick={() => onOpenAsset({ ticker: w.ticker, type: w.type, name: w.name, coingeckoId: w.coingecko_id })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                              <b style={{ color: GOLD }}>{w.ticker}</b> <span style={{ color: MUTE, fontSize: 12 }}>{w.name}</span>
                            </button>
                          </td>
                          <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{w.market ? fmt$2(w.market.price) : "sin dato"}</td>
                          <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: (w.market?.changePct || 0) >= 0 ? GREEN : RED }}>
                            {w.market?.changePct != null ? fmtPct1(w.market.changePct) : "—"}
                          </td>
                          <td style={{ padding: "10px 6px" }}>{w.market ? <RangeBar price={w.market.price} low={w.market.low} high={w.market.high} label={w.market.rangeLabel} compact /> : "—"}</td>
                          <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: hitTarget ? GREEN : TXT }}>
                            {w.target_price != null ? fmt$2(Number(w.target_price)) : "—"}{hitTarget && " ✓"}
                          </td>
                          <td style={{ padding: "10px 6px" }}>
                            <select
                              value={statusKey} disabled={busyId === w.id}
                              onChange={(e) => handleStatusChange(w, e.target.value)}
                              style={{ background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "4px 6px", fontSize: 11 }}
                            >
                              {WATCHLIST_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                            </select>
                          </td>
                          <td style={{ padding: "10px 6px", textAlign: "right" }}>
                            <button onClick={() => handleDelete(w)} disabled={busyId === w.id} style={{
                              background: "none", border: `1px solid ${RED}`, color: RED, borderRadius: 6, padding: "4px 8px",
                              cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4,
                            }}><Trash2 size={12} /> {busyId === w.id ? "…" : "Quitar"}</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const JOURNAL_TYPES = ["Compra", "Venta", "Reflexión", "Lección", "General"];
const CONFIDENCE_STATES = [["muy_convencido", "Muy convencido"], ["conviccion_media", "Convicción media"], ["muchas_dudas", "Muchas dudas"]];
const OUTCOME_RESULTS = [["confirmada", "Confirmada", GREEN], ["invalidada", "Invalidada", RED], ["parcial", "Parcial", AMBER]];

const STRATEGIC_ROLES = ["Core Holding", "High Conviction", "Growth", "Speculative", "Defensive", "Cash"];

function computeVolatility(snapshots) {
  if (!snapshots || snapshots.length < 10) return null;
  const values = snapshots.map((s) => Number(s.patrimonio));
  const returns = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  if (returns.length < 9) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function aggregateForLongTerm(snapshots) {
  const clean = snapshots.map((s) => ({ date: s.date, Patrimonio: Number(s.patrimonio) }));
  if (clean.length <= 60) return clean;
  const byWeek = {};
  clean.forEach((s) => {
    const d = new Date(s.date);
    const firstJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - firstJan) / 86400000 + firstJan.getUTCDay() + 1) / 7);
    byWeek[`${d.getUTCFullYear()}-W${week}`] = s; // se queda el ultimo snapshot de esa semana
  });
  return Object.values(byWeek);
}

// Compartida entre GoalsTab y CommandCenterTab -- misma logica, un solo lugar.
// Devuelve {title, detail}[] en vez de texto plano para poder usarse tanto
// como mensajes de Goal Coach como senales trackeables en Command Center.
// Usa las formulas importadas de financialMath.js (simulateMonthsToGoal,
// solveRequiredContribution, solveDeltaForEarlierMonths, monthsBetweenDates).
function computeGoalCoachSignals(goal, patrimonio, contribution, annualReturn) {
  if (!goal?.target_amount) return [];
  const target = Number(goal.target_amount);
  const monthsToGoal = simulateMonthsToGoal(patrimonio, target, contribution, annualReturn);
  const signals = [];
  if (monthsToGoal == null) {
    signals.push({ title: "Meta no alcanzable con supuestos actuales", detail: "Con tus supuestos actuales no alcanzarías la meta en un plazo razonable. Necesitas aumentar tu aportación o tu rendimiento esperado." });
    return signals;
  }
  if (goal.target_date) {
    const monthsToTargetDate = monthsBetweenDates(new Date(), new Date(goal.target_date));
    const required = solveRequiredContribution(patrimonio, target, monthsToTargetDate, annualReturn);
    if (required != null) {
      if (required > contribution + 1) {
        signals.push({ title: "Ajustar aportación mensual", detail: `Con tus supuestos actuales no llegarás en la fecha deseada. Necesitas aportar ${fmt$2(required)}/mes en vez de ${fmt$2(contribution)}/mes.` });
      } else if (required < contribution - 1) {
        signals.push({ title: "Puedes reducir tu aportación", detail: `Con ${fmt$2(required)}/mes mantienes tu fecha objetivo.` });
      }
    }
  }
  const delta = solveDeltaForEarlierMonths(patrimonio, target, contribution, annualReturn, 12);
  if (delta != null && delta > 1) {
    signals.push({ title: "Puedes acelerar tu meta", detail: `Aumenta tu aportación ${fmt$2(delta)}/mes para llegar un año antes.` });
  }
  return signals;
}

function fmtDateShort(d) {
  return d.toLocaleDateString("es-MX", { year: "numeric", month: "short" });
}

const PRIORITY_ORDER = { alta: 0, media: 1, baja: 2 };
const PRIORITY_COLOR = { alta: RED, media: AMBER, baja: MUTE };

function CommandCenterTab({
  estadoDeHoy, scoredOpportunities, withValue, cashValue, patrimonio, top1Pct,
  enriched, primaryGoal, decisions, rebalanceTargets, onOpenAsset, onChanged,
}) {
  const [syncing, setSyncing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRebalanceForm, setShowRebalanceForm] = useState(false);

  const rebalanceDeviations = useMemo(
    () => computeRebalanceDeviations(rebalanceTargets, withValue, cashValue, patrimonio),
    [rebalanceTargets, withValue, cashValue, patrimonio]
  );

  const openDecisions = decisions.filter((d) => d.status === "abierta");
  const historyDecisions = decisions.filter((d) => d.status !== "abierta");

  const health = useMemo(
    () => computeSystemHealth({ positionsWithThesis: enriched, top1Pct, cashValue, patrimonio, primaryGoal, rebalanceDeviations, openDecisionsCount: openDecisions.length }),
    [enriched, top1Pct, cashValue, patrimonio, primaryGoal, rebalanceDeviations, openDecisions.length]
  );

  const exitThesisList = enriched.filter((p) => p.type !== "cash" && p.thesis?.sell_trigger);

  function buildLiveSignals() {
    const signals = [];
    if (estadoDeHoy && estadoDeHoy.emoji !== "🟢") {
      signals.push({ type: "estado_hoy", ticker: null, priority: estadoDeHoy.emoji === "🔴" ? "alta" : "media", title: estadoDeHoy.label, detail: estadoDeHoy.detail });
    }
    scoredOpportunities.filter((o) => o.score >= 80).forEach((o) => {
      signals.push({ type: "oportunidad", ticker: o.ticker, priority: o.score >= 90 ? "alta" : "media", title: `Oportunidad: ${o.ticker}`, detail: `Opportunity Score ${o.score}.` });
    });
    rebalanceDeviations.forEach((d) => {
      signals.push({ type: "rebalanceo", ticker: null, priority: "media", title: `Rebalanceo: ${d.label}`, detail: `${d.actualPct.toFixed(1)}% actual vs ${Number(d.target_pct).toFixed(0)}% objetivo.` });
    });
    if (primaryGoal) {
      computeGoalCoachSignals(primaryGoal, patrimonio, Number(primaryGoal.monthly_contribution || 0), Number(primaryGoal.expected_annual_return || 0))
        .forEach((s) => signals.push({ type: "goal_coach", ticker: null, priority: "baja", title: s.title, detail: s.detail }));
    }
    return signals;
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const signals = buildLiveSignals();
      await manageDecisions({ action: "sync", signals });
      onChanged();
    } catch (e) { alert("No se pudo sincronizar: " + e.message); }
    finally { setSyncing(false); }
  }

  async function handleResolve(id, status) {
    const pin = window.prompt(`Ingresa tu PIN para marcar esta decisión como "${status}":`);
    if (!pin) return;
    try {
      await manageDecisions({ pin, action: "resolve", id, status });
      onChanged();
    } catch (e) { alert("No se pudo actualizar: " + e.message); }
  }

  async function handleDeleteTarget(id) {
    const pin = window.prompt("Ingresa tu PIN para eliminar este objetivo de rebalanceo:");
    if (!pin) return;
    try {
      await manageRebalance({ pin, action: "delete", id });
      onChanged();
    } catch (e) { alert("No se pudo eliminar: " + e.message); }
  }

  const sortedQueue = [...openDecisions].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel title="System Health">
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <div className="num" style={{ fontSize: 40, fontWeight: 700, color: health.score >= 80 ? GREEN : health.score >= 55 ? AMBER : RED }}>
            {health.score}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ height: 8, background: LINE, borderRadius: 4 }}>
              <div style={{ height: "100%", width: `${health.score}%`, background: health.score >= 80 ? GREEN : health.score >= 55 ? AMBER : RED, borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 10, color: MUTE, marginTop: 4 }}>Claridad del sistema — no es una métrica financiera, mide qué tan alineado y al día está todo Moni Capital.</div>
          </div>
        </div>
        {health.factors.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
            {health.factors.map((f, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTE }}>
                <span>{f.label}</span><span>-{f.penalty}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Decision Queue">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: MUTE }}>Ordenada por prioridad, no por fecha.</div>
          <button onClick={handleSync} disabled={syncing} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>
            {syncing ? "Sincronizando…" : "Actualizar Decision Queue"}
          </button>
        </div>
        {sortedQueue.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13 }}>Sin decisiones abiertas. Dale a "Actualizar" para revisar señales nuevas.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {sortedQueue.map((d) => (
              <div key={d.id} style={{ background: NAVY_BG, border: `1px solid ${PRIORITY_COLOR[d.priority] || LINE}`, borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontSize: 9, color: PRIORITY_COLOR[d.priority] || MUTE, border: `1px solid ${PRIORITY_COLOR[d.priority] || MUTE}`, borderRadius: 4, padding: "2px 6px", fontWeight: 700, marginRight: 6 }}>
                      {(d.priority || "media").toUpperCase()}
                    </span>
                    <b>{d.title}</b>
                    {d.detail && <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>{d.detail}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {d.ticker && (
                      <button onClick={() => onOpenAsset({ ticker: d.ticker })} style={{ background: "none", border: `1px solid ${LINE}`, color: GOLD, borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>Ver</button>
                    )}
                    <button onClick={() => handleResolve(d.id, "revisada")} style={{ background: "none", border: `1px solid ${GREEN}`, color: GREEN, borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>Revisada</button>
                    <button onClick={() => handleResolve(d.id, "ignorada")} style={{ background: "none", border: `1px solid ${MUTE}`, color: MUTE, borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>Ignorar</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Rebalanceo">
        {rebalanceTargets.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13, marginBottom: 14 }}>Sin objetivos definidos. Define un % objetivo por tema o rol para que el sistema te avise cuando te salgas de rango (±10 puntos).</div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            {rebalanceTargets.map((t) => {
              const dev = rebalanceDeviations.find((d) => d.id === t.id);
              const map = t.dimension === "tema"
                ? withValue.filter((p) => p.type !== "cash").reduce((a, p) => (p.tema === t.label ? a + p.value : a), 0) + (t.label === "Efectivo" ? cashValue : 0)
                : withValue.filter((p) => p.type !== "cash").reduce((a, p) => (p.strategic_role === t.label ? a + p.value : a), 0) + (t.label === "Cash" ? cashValue : 0);
              const actualPct = patrimonio ? (map / patrimonio) * 100 : 0;
              return (
                <div key={t.id} style={{ background: NAVY_BG, border: `1px solid ${dev ? AMBER : LINE}`, borderRadius: 8, padding: "10px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span><b>{t.label}</b> <span style={{ color: MUTE, fontSize: 10 }}>({t.dimension})</span></span>
                    <span className="num">{actualPct.toFixed(1)}% actual · {Number(t.target_pct).toFixed(0)}% objetivo</span>
                  </div>
                  {dev && <div style={{ fontSize: 10, color: AMBER, marginTop: 4 }}>Fuera de rango por {Math.abs(dev.diff).toFixed(1)} puntos</div>}
                  <button onClick={() => handleDeleteTarget(t.id)} style={{ background: "none", border: "none", color: MUTE, fontSize: 10, cursor: "pointer", marginTop: 6 }}>Eliminar objetivo</button>
                </div>
              );
            })}
          </div>
        )}
        {!showRebalanceForm ? (
          <button onClick={() => setShowRebalanceForm(true)} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            + Nuevo objetivo
          </button>
        ) : (
          <RebalanceTargetForm onDone={() => { setShowRebalanceForm(false); onChanged(); }} onCancel={() => setShowRebalanceForm(false)} />
        )}
      </Panel>

      <Panel title="Exit Thesis — recordatorios de tu propio criterio de salida">
        {exitThesisList.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13 }}>Ninguna posición tiene un criterio de salida definido todavía. Se define en la Tesis de cada activo.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {exitThesisList.map((p) => (
              <button key={p.id} onClick={() => onOpenAsset({ ticker: p.ticker, type: p.type, name: p.name, coingeckoId: p.coingecko_id })} style={{
                background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 14px", textAlign: "left", cursor: "pointer", width: "100%",
              }}>
                <div style={{ fontSize: 12 }}><b style={{ color: GOLD }}>{p.ticker}</b></div>
                <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>{p.thesis.sell_trigger}</div>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Decision History">
        <button onClick={() => setShowHistory((s) => !s)} style={{ background: "none", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer", marginBottom: 14 }}>
          {showHistory ? "Ocultar historial" : `Ver historial (${historyDecisions.length})`}
        </button>
        {showHistory && (
          historyDecisions.length === 0 ? (
            <div style={{ color: MUTE, fontSize: 13 }}>Sin decisiones resueltas todavía.</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {historyDecisions.map((d) => (
                <div key={d.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "8px 0", borderBottom: `1px solid ${LINE}` }}>
                  <span><b style={{ color: d.status === "revisada" ? GREEN : MUTE }}>{d.status?.toUpperCase()}</b> · {d.title}</span>
                  <span style={{ color: MUTE }}>{d.resolved_at ? String(d.resolved_at).slice(0, 10) : ""}</span>
                </div>
              ))}
            </div>
          )
        )}
      </Panel>
    </div>
  );
}

function RebalanceTargetForm({ onDone, onCancel }) {
  const [dimension, setDimension] = useState("tema");
  const [label, setLabel] = useState("");
  const [targetPct, setTargetPct] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!label || !targetPct) { setErr("Falta la etiqueta o el % objetivo."); return; }
    setBusy(true);
    try {
      await manageRebalance({ pin, action: "add", target: { dimension, label, target_pct: Number(targetPct) } });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10, marginTop: 12, background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: 14 }}>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Dimensión</label>
        <select style={inputStyle} value={dimension} onChange={(e) => setDimension(e.target.value)}>
          <option value="tema">Tema</option>
          <option value="role">Rol estratégico</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Etiqueta (ej. "IA / Cloud" o "Core Holding")</label><input style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>% objetivo</label><input style={inputStyle} type="number" step="any" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
          {busy ? "…" : "Guardar"}
        </button>
        <button type="button" onClick={onCancel} style={{ background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>Cancelar</button>
      </div>
      {err && <div style={{ gridColumn: "1/-1", color: RED, fontSize: 11 }}>{err}</div>}
    </form>
  );
}

function WealthTab({
  patrimonio, invested, totalGain, totalPct, stocksValue, cryptoValue, cashValue,
  withValue, top5, top1Pct, top3Pct, concColor, allocType, snapshots, goal, goalPct,
  transactions, cashMovements, onOpenAsset,
}) {
  const bySector = useMemo(() => {
    const map = {};
    withValue.filter((p) => p.type === "stock").forEach((p) => {
      const key = p.sector || "Sin sector";
      map[key] = (map[key] || 0) + p.value;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [withValue]);

  const byTema = useMemo(() => {
    const map = {};
    withValue.filter((p) => p.type !== "cash").forEach((p) => {
      const key = p.tema || "Sin clasificar";
      map[key] = (map[key] || 0) + p.value;
    });
    if (cashValue > 0) map["Efectivo"] = (map["Efectivo"] || 0) + cashValue;
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [withValue, cashValue]);

  const byRole = useMemo(() => {
    const map = {};
    withValue.filter((p) => p.type !== "cash").forEach((p) => {
      const key = p.strategic_role || "Sin clasificar";
      map[key] = (map[key] || 0) + p.value;
    });
    if (cashValue > 0) map["Cash"] = (map["Cash"] || 0) + cashValue;
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [withValue, cashValue]);

  const costoVigente = withValue.reduce((a, p) => a + Number(p.cost_basis), 0);
  const valorActual = stocksValue + cryptoValue;
  const gananciaPosiciones = valorActual - costoVigente;
  const dividendosTotal = (transactions || []).filter((t) => t.type === "dividendo").reduce((a, t) => a + Number(t.amount || 0), 0);
  const retirosTotal = (cashMovements || []).filter((m) => m.type === "retiro").reduce((a, m) => a + Number(m.amount || 0), 0);

  const volatilidad = useMemo(() => computeVolatility(snapshots), [snapshots]);
  const longTermData = useMemo(() => aggregateForLongTerm(snapshots), [snapshots]);

  const goalHistoryData = useMemo(() => {
    if (!goal?.target_amount) return [];
    return snapshots.map((s) => ({ date: s.date, "% de meta": Math.min(100, (Number(s.patrimonio) / Number(goal.target_amount)) * 100) }));
  }, [snapshots, goal]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel title="1. Patrimonio Total">
        <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
          <Metric label="Patrimonio actual" value={fmt$2(patrimonio)} />
          <Metric label="Rendimiento total" value={fmtPct(totalPct)} color={totalGain >= 0 ? GREEN : RED} />
          <Metric label="Ganancia/Pérdida total" value={fmt$2(totalGain)} color={totalGain >= 0 ? GREEN : RED} />
        </div>
        {snapshots.length < 5 && (
          <div style={{ fontSize: 11, color: MUTE, marginTop: 10 }}>El historial de largo plazo apenas empieza a acumularse — se vuelve más útil con cada semana que pasa.</div>
        )}
      </Panel>

      <Panel title="2. Allocation">
        {allocType.length === 0 ? <Empty /> : (
          <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <ResponsiveContainer width={160} height={160}>
              <PieChart>
                <Pie data={allocType} dataKey="value" innerRadius={45} outerRadius={70} paddingAngle={2}>
                  {allocType.map((e, i) => <Cell key={i} fill={e.color} stroke="none" />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {allocType.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: e.color, display: "inline-block" }} />
                  <span style={{ color: MUTE }}>{e.name}</span>
                  <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{patrimonio ? ((e.value / patrimonio) * 100).toFixed(1) : "0.0"}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="3. Diversificación">
        <div style={{ display: "grid", gap: 22 }}>
          {[["Por sector (acciones)", bySector], ["Por tema de inversión", byTema], ["Por rol estratégico", byRole]].map(([label, data]) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: MUTE, marginBottom: 8, fontWeight: 600 }}>{label}</div>
              {data.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={Math.max(80, data.length * 32)}>
                  <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                    <XAxis type="number" tickFormatter={fmt$} stroke={MUTE} fontSize={10} />
                    <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={10} width={140} />
                    <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                    <Bar dataKey="value" fill="#7C8CF8" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="4. Concentración">
        <SemRow label="Peso de la posición #1" value={top1Pct} color={concColor} />
        <SemRow label="Peso combinado Top 3" value={top3Pct} color={top3Pct > 0.55 ? RED : top3Pct > 0.35 ? AMBER : GREEN} />
        <div style={{ marginTop: 14 }}>
          {top5.map((p, i) => (
            <button key={p.id} onClick={() => onOpenAsset({ ticker: p.ticker, type: p.type, name: p.name, coingeckoId: p.coingecko_id })} style={{
              display: "flex", justifyContent: "space-between", width: "100%", background: "none", border: "none",
              borderBottom: `1px solid ${LINE}`, padding: "8px 0", cursor: "pointer", color: TXT, fontSize: 12, textAlign: "left",
            }}>
              <span>{i + 1}. <b style={{ color: GOLD }}>{p.ticker}</b></span>
              <span className="num">{fmt$2(p.value)} · {patrimonio ? ((p.value / patrimonio) * 100).toFixed(1) : "0.0"}%</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="5. Evolución del Patrimonio">
        {longTermData.length < 2 ? (
          <div style={{ color: MUTE, fontSize: 13 }}>Necesitas más historial para ver una evolución de largo plazo.</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={longTermData} margin={{ left: 10, right: 20, top: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
                <XAxis dataKey="date" stroke={MUTE} fontSize={11} />
                <YAxis stroke={MUTE} fontSize={11} tickFormatter={fmt$} width={70} />
                <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                <Line type="monotone" dataKey="Patrimonio" stroke={GOLD} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            {snapshots.length > 60 && <div style={{ fontSize: 10, color: MUTE, marginTop: 8 }}>Agrupado por semana para que la tendencia de largo plazo se vea clara.</div>}
          </>
        )}
      </Panel>

      <Panel title="6. Flujo de Capital">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 16 }}>
          <Metric label="Aportes netos (Efectivo)" value={fmt$2(cashValue)} />
          <Metric label="Costo vigente de posiciones" value={fmt$2(costoVigente)} />
          <Metric label="Valor actual de posiciones" value={fmt$2(valorActual)} />
          <Metric label="Ganancia/Pérdida (posiciones)" value={fmt$2(gananciaPosiciones)} color={gananciaPosiciones >= 0 ? GREEN : RED} />
          <Metric label="Dividendos recibidos" value={fmt$2(dividendosTotal)} color={GOLD} />
          <Metric label="Retiros" value={fmt$2(retirosTotal)} />
          <Metric label="Intereses" value="No tengo ese dato registrado todavía." />
        </div>
        <div style={{ fontSize: 10, color: MUTE, marginTop: 14 }}>
          "Aportes netos" y "Costo vigente de posiciones" hoy se registran por separado — no están conectados automáticamente entre sí en Moni Capital.
        </div>
      </Panel>

      <Panel title="7. Riesgo">
        <SemRow label="Liquidez (Efectivo / Patrimonio)" value={patrimonio ? cashValue / patrimonio : 0} color={GOLD} />
        <SemRow label="Concentración (Top 1)" value={top1Pct} color={concColor} />
        <div style={{ fontSize: 12, color: MUTE, marginTop: 10 }}>
          Diversificación: {byTema.length} tema{byTema.length === 1 ? "" : "s"} distintos representados.
        </div>
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 11, color: MUTE, marginBottom: 4 }}>Volatilidad (variación diaria del patrimonio)</div>
          {volatilidad == null ? (
            <div style={{ fontSize: 13, color: MUTE, fontStyle: "italic" }}>Necesitas más historial para calcular esta métrica.</div>
          ) : (
            <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>{volatilidad.toFixed(2)}%</div>
          )}
        </div>
      </Panel>

      <Panel title="8. Metas">
        {!goal?.target_amount ? (
          <div style={{ color: MUTE, fontSize: 13 }}>No has definido una meta patrimonial todavía — hazlo desde el Hero en Resumen.</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 16 }}>
              <Metric label="Meta patrimonial" value={fmt$2(Number(goal.target_amount))} />
              <Metric label="Progreso actual" value={`${goalPct != null ? goalPct.toFixed(1) : "0.0"}%`} color={GOLD} />
            </div>
            {goalHistoryData.length >= 2 && (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={goalHistoryData} margin={{ left: 10, right: 20, top: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
                  <XAxis dataKey="date" stroke={MUTE} fontSize={10} />
                  <YAxis stroke={MUTE} fontSize={10} tickFormatter={(v) => `${v}%`} width={50} domain={[0, 100]} />
                  <Tooltip formatter={(v) => `${v.toFixed(1)}%`} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                  <Line type="monotone" dataKey="% de meta" stroke={GOLD} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: 10, color: MUTE, marginTop: 8 }}>El progreso histórico aplica tu meta de hoy retroactivamente — no guardamos metas anteriores.</div>
          </>
        )}
      </Panel>

      <Panel title="Wealth DNA">
        <div style={{ display: "grid", gap: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: MUTE, marginBottom: 8, fontWeight: 600 }}>Por tema</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {byTema.map((t, i) => (
                <span key={i} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 999, padding: "5px 12px", fontSize: 11 }}>
                  {t.name} <b style={{ color: GOLD }}>{patrimonio ? ((t.value / patrimonio) * 100).toFixed(0) : 0}%</b>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: MUTE, marginBottom: 8, fontWeight: 600 }}>Por rol estratégico</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {byRole.map((t, i) => (
                <span key={i} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 999, padding: "5px 12px", fontSize: 11 }}>
                  {t.name} <b style={{ color: GOLD }}>{patrimonio ? ((t.value / patrimonio) * 100).toFixed(0) : 0}%</b>
                </span>
              ))}
            </div>
            <div style={{ fontSize: 10, color: MUTE, marginTop: 8 }}>
              El rol estratégico lo defines tú por posición (en Gestionar o Asset Detail) — nunca se infiere solo.
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function GoalsTab({ goals, patrimonio, snapshots, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState(null);
  const [openMilestone, setOpenMilestone] = useState(null);
  const [plannerContribution, setPlannerContribution] = useState(null);
  const [plannerReturn, setPlannerReturn] = useState(null);

  const primary = goals.find((g) => g.is_primary) || goals[0] || null;

  const contribution = plannerContribution != null ? plannerContribution : Number(primary?.monthly_contribution || 0);
  const annualReturn = plannerReturn != null ? plannerReturn : Number(primary?.expected_annual_return || 0);

  if (!primary) {
    return (
      <Panel title="Goals — planificación patrimonial">
        <div style={{ color: MUTE, fontSize: 13, marginBottom: 16 }}>
          Aún no tienes ninguna meta. Goals responde "¿a dónde quiero llegar?" — crea tu primera meta para empezar a planificar.
        </div>
        {!showForm ? (
          <button onClick={() => setShowForm(true)} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            + Nueva meta
          </button>
        ) : (
          <GoalForm onDone={() => { setShowForm(false); onChanged(); }} makesPrimary />
        )}
      </Panel>
    );
  }

  const goalPct = primary.target_amount ? Math.min(100, (patrimonio / Number(primary.target_amount)) * 100) : 0;
  const monthsToGoal = simulateMonthsToGoal(patrimonio, Number(primary.target_amount), contribution, annualReturn);
  const estimatedDate = monthsToGoal != null ? addMonthsToToday(monthsToGoal) : null;

  let requiredContribution = null, planStatus = null, monthsToTargetDate = null;
  if (primary.target_date) {
    monthsToTargetDate = monthsBetweenDates(new Date(), new Date(primary.target_date));
    requiredContribution = solveRequiredContribution(patrimonio, Number(primary.target_amount), monthsToTargetDate, annualReturn);
    if (monthsToGoal != null) {
      if (monthsToGoal < monthsToTargetDate - 1) planStatus = { label: "Adelantado", color: GREEN };
      else if (monthsToGoal > monthsToTargetDate + 1) planStatus = { label: "Retrasado", color: RED };
      else planStatus = { label: "En línea", color: AMBER };
    }
  }

  const coachMessages = computeGoalCoachSignals(primary, patrimonio, contribution, annualReturn).map((s) => s.detail);

  const milestones = computeMilestones(snapshots, patrimonio);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel title="1-2. Meta principal y Progreso">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: MUTE }}>{primary.name || "Meta principal"}</div>
            <div className="display" style={{ fontSize: 26, fontWeight: 700 }}>{fmt$2(Number(primary.target_amount))}</div>
          </div>
          <button onClick={() => { setEditingGoal(primary); setShowForm(true); }} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>Editar</button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTE, marginBottom: 4 }}>
          <span>{fmt$2(patrimonio)} de {fmt$2(Number(primary.target_amount))}</span>
          <span style={{ color: GOLD, fontWeight: 700 }}>{goalPct.toFixed(1)}%</span>
        </div>
        <div style={{ height: 6, background: LINE, borderRadius: 3 }}>
          <div style={{ height: "100%", width: `${goalPct}%`, background: GOLD, borderRadius: 3 }} />
        </div>
      </Panel>

      <Panel title="3. Fecha estimada">
        {monthsToGoal == null ? (
          <div style={{ color: RED, fontSize: 13 }}>Con tus supuestos actuales, no hay una fecha estimada alcanzable.</div>
        ) : monthsToGoal === 0 ? (
          <div style={{ color: GREEN, fontSize: 15, fontWeight: 700 }}>¡Ya alcanzaste esta meta!</div>
        ) : (
          <>
            <div className="display" style={{ fontSize: 22, fontWeight: 700, color: GOLD }}>{fmtDateShort(estimatedDate)}</div>
            <div style={{ fontSize: 11, color: MUTE, marginTop: 6 }}>
              Con {fmt$2(contribution)}/mes de aportación y {annualReturn}% de rendimiento anual esperado — tus supuestos, no una promesa del sistema.
            </div>
          </>
        )}
      </Panel>

      {primary.target_date && (
        <Panel title="4-5. Plan de acción y Estado del plan">
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 12 }}>
            <Metric label="Fecha objetivo" value={fmtDateShort(new Date(primary.target_date))} />
            <Metric label="Aportación necesaria" value={requiredContribution != null ? `${fmt$2(requiredContribution)}/mes` : "—"} />
            {planStatus && <Metric label="Estado del plan" value={planStatus.label} color={planStatus.color} />}
          </div>
        </Panel>
      )}

      <Panel title="Goal Coach">
        <div style={{ fontSize: 10, color: MUTE, marginBottom: 10 }}>Determinístico — cálculos, nunca interpretación.</div>
        {coachMessages.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13 }}>Sin recomendaciones por ahora.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {coachMessages.map((m, i) => (
              <div key={i} style={{ background: "#1A1710", border: `1px solid ${GOLD}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>{m}</div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="6. Milestones">
        <div style={{ display: "grid", gap: 8 }}>
          {milestones.map((m) => (
            <div key={m.threshold} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 13 }}>
                  {m.reached ? "✅" : "⬜"} <b>{fmtBig(m.threshold)}</b>
                  {m.reached && m.date && <span style={{ color: MUTE, fontSize: 11 }}> · {m.date}</span>}
                </div>
                {m.reached && m.snapshot && (
                  <button onClick={() => setOpenMilestone(openMilestone === m.threshold ? null : m.threshold)} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>
                    Ver cómo llegué
                  </button>
                )}
              </div>
              {openMilestone === m.threshold && m.snapshot && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}`, fontSize: 11, color: MUTE, display: "grid", gap: 4 }}>
                  <div>Fotografía real de ese día (resumen agregado, no posición por posición):</div>
                  <div>Patrimonio: <b style={{ color: TXT }}>{fmt$2(Number(m.snapshot.patrimonio))}</b></div>
                  <div>Invertido: <b style={{ color: TXT }}>{fmt$2(Number(m.snapshot.invested))}</b></div>
                  <div>Acciones: {fmt$2(Number(m.snapshot.stocks_value || 0))} · Cripto: {fmt$2(Number(m.snapshot.crypto_value || 0))} · Efectivo: {fmt$2(Number(m.snapshot.cash_value || 0))}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="7. Planner">
        <div style={{ fontSize: 11, color: MUTE, marginBottom: 14 }}>Ajusta y ve cómo cambia tu fecha estimada — sin guardar nada.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 16 }}>
          <div>
            <label style={{ fontSize: 11, color: MUTE }}>Aportación mensual ($)</label>
            <input type="number" step="any" value={contribution} onChange={(e) => setPlannerContribution(Number(e.target.value))}
              style={{ background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: MUTE }}>Rendimiento anual esperado (%)</label>
            <input type="number" step="any" value={annualReturn} onChange={(e) => setPlannerReturn(Number(e.target.value))}
              style={{ background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
          </div>
        </div>
        {(plannerContribution != null || plannerReturn != null) && (
          <button onClick={() => { setPlannerContribution(null); setPlannerReturn(null); }} style={{ marginTop: 12, background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>
            Restablecer a mis supuestos guardados
          </button>
        )}
      </Panel>

      <Panel title="8. Metas múltiples">
        <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
          {goals.map((g) => (
            <div key={g.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", background: NAVY_BG,
              border: `1px solid ${g.is_primary ? GOLD : LINE}`, borderRadius: 8, padding: "10px 14px", fontSize: 12,
            }}>
              <span>{g.is_primary && "⭐ "}<b>{g.name}</b> <span style={{ color: MUTE }}>{fmt$2(Number(g.target_amount))}</span></span>
              <button onClick={() => { setEditingGoal(g); setShowForm(true); }} style={{ background: "none", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Editar</button>
            </div>
          ))}
        </div>
        {!showForm ? (
          <button onClick={() => { setEditingGoal(null); setShowForm(true); }} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            + Nueva meta
          </button>
        ) : (
          <GoalForm current={editingGoal} onDone={() => { setShowForm(false); setEditingGoal(null); onChanged(); }} onCancel={() => { setShowForm(false); setEditingGoal(null); }} />
        )}
      </Panel>
    </div>
  );
}

function GoalForm({ current, onDone, onCancel, makesPrimary }) {
  const [name, setName] = useState(current?.name || "");
  const [targetAmount, setTargetAmount] = useState(current?.target_amount || "");
  const [targetDate, setTargetDate] = useState(current?.target_date || "");
  const [monthlyContribution, setMonthlyContribution] = useState(current?.monthly_contribution || "");
  const [expectedReturn, setExpectedReturn] = useState(current?.expected_annual_return || "");
  const [isPrimary, setIsPrimary] = useState(current?.is_primary ?? !!makesPrimary);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!name || !targetAmount) { setErr("Nombre y monto objetivo son obligatorios."); return; }
    setBusy(true);
    try {
      const goalPayload = {
        name, target_amount: Number(targetAmount),
        target_date: targetDate || null,
        monthly_contribution: monthlyContribution ? Number(monthlyContribution) : null,
        expected_annual_return: expectedReturn ? Number(expectedReturn) : null,
        is_primary: isPrimary,
      };
      if (current) {
        await manageGoal({ pin, action: "update", id: current.id, goal: goalPayload });
      } else {
        await manageGoal({ pin, action: "add", goal: goalPayload });
      }
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginTop: 14, display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12 }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Nombre *</label><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Patrimonio principal, Retiro, Casa" /></div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Monto objetivo ($) *</label><input style={inputStyle} type="number" step="any" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} /></div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Fecha objetivo (opcional)</label><input style={inputStyle} type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12 }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Aportación mensual asumida ($)</label><input style={inputStyle} type="number" step="any" value={monthlyContribution} onChange={(e) => setMonthlyContribution(e.target.value)} /></div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Rendimiento anual esperado (%)</label><input style={inputStyle} type="number" step="any" value={expectedReturn} onChange={(e) => setExpectedReturn(e.target.value)} /></div>
      </div>
      <label style={{ fontSize: 12, color: MUTE, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Meta principal (aparece en TODAY y Wealth)
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "flex-end" }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {onCancel && <button type="button" onClick={onCancel} style={{ background: "none", border: "none", color: MUTE, fontSize: 12, cursor: "pointer" }}>Cancelar</button>}
      </div>
      {err && <div style={{ color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}

function JournalTab({ entries, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const visible = entries.filter((e) => showArchived || !e.archived);
  const stats = {
    entradas: entries.filter((e) => !e.archived).length,
    lecciones: entries.filter((e) => e.outcome_lesson).length,
    confirmadas: entries.filter((e) => e.outcome_result === "confirmada").length,
    invalidadas: entries.filter((e) => e.outcome_result === "invalidada").length,
  };

  return (
    <Panel title="Investment Journal — tu bitácora de decisiones">
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 20 }}>
        <Metric label="Entradas" value={`${stats.entradas}`} />
        <Metric label="Lecciones aprendidas" value={`${stats.lecciones}`} color={GOLD} />
        <Metric label="Tesis confirmadas" value={`${stats.confirmadas}`} color={GREEN} />
        <Metric label="Tesis invalidadas" value={`${stats.invalidadas}`} color={RED} />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setShowForm((s) => !s)} style={{
          background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px",
          fontWeight: 700, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
        }}><Plus size={16} /> {showForm ? "Cancelar" : "Nueva entrada"}</button>
        <label style={{ fontSize: 12, color: MUTE, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Ver archivadas
        </label>
      </div>

      {showForm && <JournalEntryForm onDone={() => { setShowForm(false); onChanged(); }} />}

      {visible.length === 0 ? (
        <div style={{ color: MUTE, fontSize: 13 }}>Sin entradas todavía. Registra tu primera decisión con "+ Nueva entrada".</div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {visible.map((e) => <JournalEntryCard key={e.id} entry={e} onChanged={onChanged} />)}
        </div>
      )}
    </Panel>
  );
}

function JournalEntryCard({ entry, onChanged }) {
  const [showOutcomeForm, setShowOutcomeForm] = useState(false);

  async function handleArchive() {
    const pin = window.prompt(`Ingresa tu PIN para archivar esta entrada:`);
    if (!pin) return;
    try {
      await manageJournal({ pin, action: "archive", id: entry.id });
      onChanged();
    } catch (e) { alert("No se pudo archivar: " + e.message); }
  }

  const outcomeInfo = OUTCOME_RESULTS.find(([k]) => k === entry.outcome_result);

  return (
    <div style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 12, padding: 18, opacity: entry.archived ? 0.55 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: GOLD, border: `1px solid ${GOLD}`, borderRadius: 4, padding: "2px 6px", fontWeight: 700 }}>{entry.type?.toUpperCase()}</span>
            {entry.ticker && <b style={{ color: GOLD }}>{entry.ticker}</b>}
            {entry.archived && <span style={{ fontSize: 10, color: MUTE }}>(archivada)</span>}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6 }}>{entry.title}</div>
          <div style={{ fontSize: 11, color: MUTE, marginTop: 2 }}>{entry.date}</div>
        </div>
        {!entry.archived && (
          <button onClick={handleArchive} style={{ background: "none", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>
            Archivar
          </button>
        )}
      </div>

      <div style={{ fontSize: 13, marginTop: 10, whiteSpace: "pre-wrap" }}>{entry.content}</div>

      <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 11, color: MUTE, flexWrap: "wrap" }}>
        {entry.conviction_at_time && <span>Convicción al escribir: <ConvictionStars value={entry.conviction_at_time} /></span>}
        {entry.confidence_state && <span>Estado: {CONFIDENCE_STATES.find(([k]) => k === entry.confidence_state)?.[1] || entry.confidence_state}</span>}
      </div>

      {entry.invalidation_criteria && (
        <div style={{ marginTop: 10, fontSize: 11, color: MUTE, fontStyle: "italic" }}>
          ¿Qué demostraría que estaba equivocado? {entry.invalidation_criteria}
        </div>
      )}

      {entry.outcome_result ? (
        <div style={{ marginTop: 14, background: "#0F1730", border: `1px solid ${outcomeInfo?.[2] || LINE}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: outcomeInfo?.[2] || MUTE, fontWeight: 700, letterSpacing: 0.5 }}>
            RESULTADO — {outcomeInfo?.[1] || entry.outcome_result} {entry.outcome_date && `(${entry.outcome_date})`}
          </div>
          {entry.outcome_lesson && <div style={{ fontSize: 12, marginTop: 6 }}>{entry.outcome_lesson}</div>}
        </div>
      ) : (
        !entry.archived && (
          <div style={{ marginTop: 12 }}>
            {!showOutcomeForm ? (
              <button onClick={() => setShowOutcomeForm(true)} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>
                + Agregar resultado
              </button>
            ) : (
              <JournalOutcomeForm entryId={entry.id} onDone={() => { setShowOutcomeForm(false); onChanged(); }} />
            )}
          </div>
        )
      )}
    </div>
  );
}

function JournalOutcomeForm({ entryId, onDone }) {
  const [result, setResult] = useState("");
  const [lesson, setLesson] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputStyle = { background: PANEL, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!result) { setErr("Elige un resultado."); return; }
    setBusy(true);
    try {
      await manageJournal({ pin, action: "add_outcome", id: entryId, outcome: { outcome_result: result, outcome_lesson: lesson || null } });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10, marginTop: 8, background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: 14 }}>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Resultado *</label>
        <select style={inputStyle} value={result} onChange={(e) => setResult(e.target.value)}>
          <option value="">Elige uno…</option>
          {OUTCOME_RESULTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Lección aprendida</label><textarea style={inputStyle} rows={2} value={lesson} onChange={(e) => setLesson(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
        {busy ? "Guardando…" : "Guardar resultado"}
      </button>
      {err && <div style={{ color: RED, fontSize: 11 }}>{err}</div>}
    </form>
  );
}

function JournalEntryForm({ onDone, presetTicker }) {
  const [ticker, setTicker] = useState(presetTicker || "");
  const [type, setType] = useState("Reflexión");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [conviction, setConviction] = useState("");
  const [confidenceState, setConfidenceState] = useState("");
  const [invalidation, setInvalidation] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!title || !content) { setErr("Título y contenido son obligatorios."); return; }
    setBusy(true);
    try {
      await manageJournal({
        pin, action: "add",
        entry: {
          ticker: ticker ? ticker.toUpperCase() : null, type, title, content, date,
          conviction_at_time: conviction ? Number(conviction) : null,
          confidence_state: confidenceState || null,
          invalidation_criteria: invalidation || null,
        },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginBottom: 20, display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 12 }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Ticker (opcional)</label><TickerSearchInput value={ticker} onChange={setTicker} onPick={(r) => setTicker(r.ticker)} placeholder="Ej. Oracle, ORCL…" /></div>
        <div>
          <label style={{ fontSize: 11, color: MUTE }}>Tipo</label>
          <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value)}>
            {JOURNAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Fecha</label><input style={inputStyle} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Título *</label><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Por qué aumenté Oracle hoy" /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Contenido *</label><textarea style={inputStyle} rows={4} value={content} onChange={(e) => setContent(e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12 }}>
        <div>
          <label style={{ fontSize: 11, color: MUTE }}>Convicción al escribir</label>
          <select style={inputStyle} value={conviction} onChange={(e) => setConviction(e.target.value)}>
            <option value="">Sin definir</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: MUTE }}>Estado al escribir</label>
          <select style={inputStyle} value={confidenceState} onChange={(e) => setConfidenceState(e.target.value)}>
            <option value="">Sin definir</option>
            {CONFIDENCE_STATES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>¿Qué tendría que pasar para demostrar que estaba equivocado? (opcional)</label><textarea style={inputStyle} rows={2} value={invalidation} onChange={(e) => setInvalidation(e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "flex-end" }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {busy ? "Guardando…" : "Guardar entrada"}
        </button>
      </div>
      {err && <div style={{ color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}

function DiscoverTab({ onWatchlistAdded, onOpenAsset, dailyOpportunities, positions }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [enriched, setEnriched] = useState({});
  const [quickAddFor, setQuickAddFor] = useState(null);
  const debounceRef = useRef(null);

  const top3 = (dailyOpportunities || []).slice(0, 3);

  function onChange(v) {
    setQ(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 1) { setResults([]); setEnriched({}); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { results: found } = await searchAssets(v.trim());
        setResults(found || []);
        const toEnrich = (found || []).slice(0, 6).map((r) => ({ ticker: r.ticker, type: r.type, coingeckoId: r.coingeckoId }));
        if (toEnrich.length) {
          const { data } = await fetchMarketData(toEnrich);
          setEnriched(data || {});
        } else {
          setEnriched({});
        }
      } catch (e) { setResults([]); setEnriched({}); }
      finally { setSearching(false); }
    }, 400);
  }

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 8, padding: "10px 12px", fontSize: 14, width: "100%" };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel title="Oportunidades del día">
        {top3.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13 }}>Sin oportunidades con Opportunity Score alto ahora mismo.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {top3.map((o) => (
              <button key={o.ticker} onClick={() => onOpenAsset({ ticker: o.ticker, type: o.type || "stock", name: o.name, coingeckoId: o.coingeckoId })} style={{
                background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left", width: "100%",
              }}>
                <span><b style={{ color: GOLD }}>{o.ticker}</b> <span style={{ color: MUTE, fontSize: 12 }}>{o.source === "cartera" ? "en cartera" : "watchlist"}</span></span>
                <span className="num" style={{ color: o.score >= 80 ? GREEN : AMBER, fontWeight: 700 }}>{o.score}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Descubrir — ticker, nombre o tema (IA, Cloud, Energía, Semiconductores, Fintech, Cripto…)">
        <div style={{ position: "relative", marginBottom: 16 }}>
          <Search size={16} color={MUTE} style={{ position: "absolute", left: 12, top: 12 }} />
          <input style={{ ...inputStyle, paddingLeft: 36 }} value={q} onChange={(e) => onChange(e.target.value)} placeholder="Ej. Tesla, TSLA, IA, Energía…" />
        </div>

        {searching && <div style={{ color: MUTE, fontSize: 12, marginBottom: 12 }}>Buscando…</div>}

        {results.length > 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            {results.map((r, i) => {
              const md = enriched[r.ticker];
              const owned = positions.find((p) => p.ticker === r.ticker);
              let score = null, rangePct = null;
              const reasons = [];
              if (md) {
                const b = scoreBreakdown({ price: md.price, low: md.low, high: md.high, changePct: md.changePct, conviction: owned?.thesis?.conviction || 0 });
                score = b.total;
                if (md.low != null && md.high != null && md.high > md.low) rangePct = ((md.price - md.low) / (md.high - md.low)) * 100;
                if (owned?.thesis?.conviction >= 4) reasons.push("Convicción alta");
                if (rangePct != null && rangePct < 25) reasons.push("Cerca de su mínimo");
                if (r.fromConcept) reasons.push(`Tema: ${q.trim()}`);
                if (md.changePct != null && md.changePct < -3) reasons.push("Momentum negativo reciente");
              }
              return (
                <div key={i} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={() => onOpenAsset(r)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", flex: 1, minWidth: 160 }}>
                      <div><b style={{ color: GOLD }}>{r.ticker}</b> <span style={{ color: MUTE, fontSize: 12 }}>{r.name}</span></div>
                      {md && (
                        <div className="num" style={{ fontSize: 13, marginTop: 4 }}>
                          {fmt$2(md.price)} <span style={{ color: (md.changePct || 0) >= 0 ? GREEN : RED, fontSize: 11 }}>{md.changePct != null ? fmtPct1(md.changePct) : ""}</span>
                        </div>
                      )}
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {score != null && <span className="num" style={{ color: score >= 80 ? GREEN : score >= 65 ? "#7FCF9E" : AMBER, fontWeight: 700 }}>{score}</span>}
                      <button onClick={() => setQuickAddFor(quickAddFor === r.ticker ? null : r.ticker)} style={{
                        background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontWeight: 700,
                      }}>+</button>
                    </div>
                  </div>
                  {md && rangePct != null && <div style={{ marginTop: 8 }}><RangeBar price={md.price} low={md.low} high={md.high} label={md.rangeLabel} compact /></div>}
                  {reasons.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 10, color: MUTE }}>¿Por qué? {reasons.join(" · ")}</div>
                  )}
                  {quickAddFor === r.ticker && (
                    <WatchlistAddForm result={r} onDone={() => { setQuickAddFor(null); onWatchlistAdded(); }} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {q.trim().length > 0 && !searching && results.length === 0 && (
          <div style={{ color: MUTE, fontSize: 13 }}>Sin resultados para "{q}".</div>
        )}
      </Panel>
    </div>
  );
}

function WatchlistAddForm({ result, onDone }) {
  const [targetPrice, setTargetPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const inputStyle = { background: PANEL, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await manageWatchlist({
        pin, action: "add",
        item: {
          ticker: result.ticker, name: result.name, type: result.type,
          coingecko_id: result.coingeckoId || null,
          target_price: targetPrice ? Number(targetPrice) : null,
          notes: notes || null,
        },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10, marginTop: 10 }}>
      <div><label style={{ fontSize: 11, color: MUTE }}>Precio objetivo (opcional)</label><input style={inputStyle} type="number" step="any" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Notas (opcional)</label><input style={inputStyle} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", width: "100%" }}>
          {busy ? "Guardando…" : "Guardar en Watchlist"}
        </button>
      </div>
      {err && <div style={{ gridColumn: "1/-1", color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}

function AssetDetailScreen({ meta, positions, watchlist, transactions, journalEntries, patrimonio, onBack, onSaved, onOpenAsset }) {
  const [market, setMarket] = useState(null);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [showThesisEdit, setShowThesisEdit] = useState(false);
  const [showWlForm, setShowWlForm] = useState(false);

  const position = positions.find((p) => p.ticker === meta.ticker);
  const watchlistItem = watchlist.find((w) => w.ticker === meta.ticker);
  const thesis = position?.thesis || null;

  useEffect(() => {
    if (position?.market) { setMarket(position.market); return; }
    if (watchlistItem?.market) { setMarket(watchlistItem.market); return; }
    setLoadingMarket(true);
    fetchMarketData([{ ticker: meta.ticker, type: meta.type, coingeckoId: meta.coingeckoId }])
      .then(({ data }) => setMarket(data[meta.ticker] || null))
      .catch(() => setMarket(null))
      .finally(() => setLoadingMarket(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.ticker]);

  const ranking = useMemo(() => {
    const withValue = positions.filter((p) => p.value != null && p.type !== "cash");
    const sorted = [...withValue].sort((a, b) => b.value - a.value);
    const idx = sorted.findIndex((p) => p.ticker === meta.ticker);
    return idx >= 0 ? { pos: idx + 1, total: sorted.length } : null;
  }, [positions, meta.ticker]);

  const pctPatrimonio = position?.value != null && patrimonio ? (position.value / patrimonio) * 100 : null;

  const scoreData = useMemo(() => {
    if (!market) return null;
    return scoreBreakdown({ price: market.price, low: market.low, high: market.high, changePct: market.changePct, conviction: thesis?.conviction || 0 });
  }, [market, thesis]);

  const decision = useMemo(() => {
    if (!position || !market) return { emoji: "⚪", label: "Sin posición propia", detail: "Este activo no es parte de tu portafolio todavía." };
    if (pctPatrimonio != null && pctPatrimonio > 35) return { emoji: "🔴", label: "Revisar concentración", detail: `Pesa ${pctPatrimonio.toFixed(1)}% de tu patrimonio.` };
    if (scoreData && scoreData.total >= 80) return { emoji: "🟡", label: "Revisar", detail: `Opportunity Score ${scoreData.total}.` };
    return { emoji: "🟢", label: "Mantener", detail: "Sin señales relevantes ahora mismo." };
  }, [position, market, pctPatrimonio, scoreData]);

  const timelineEvents = useMemo(() => {
    const txEvents = (transactions || [])
      .filter((t) => t.ticker === meta.ticker)
      .map((t) => ({ date: t.date, label: TX_TYPE_LABEL[t.type] || (t.type || "").toUpperCase(), amount: t.amount, notes: t.notes }));
    const thesisEvent = thesis?.updated_at
      ? [{ date: String(thesis.updated_at).slice(0, 10), label: "TESIS ACTUALIZADA", amount: null, notes: null }]
      : [];
    const journalEvents = (journalEntries || [])
      .filter((j) => j.ticker === meta.ticker && !j.archived)
      .map((j) => ({ date: j.date, label: `JOURNAL — ${j.title}`, amount: null, notes: j.outcome_result ? `Resultado: ${j.outcome_result}` : null }));
    return [...txEvents, ...thesisEvent, ...journalEvents].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [transactions, meta.ticker, thesis, journalEntries]);

  const dividendos = useMemo(
    () => (transactions || []).filter((t) => t.ticker === meta.ticker && t.type === "dividendo"),
    [transactions, meta.ticker]
  );
  const totalDividendos = dividendos.reduce((a, t) => a + Number(t.amount || 0), 0);

  const reviewDays = thesis?.updated_at ? Math.floor((Date.now() - new Date(thesis.updated_at).getTime()) / 86400000) : null;
  const decisionColor = decision.emoji === "🔴" ? RED : decision.emoji === "🟡" ? AMBER : decision.emoji === "🟢" ? GREEN : LINE;

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", color: MUTE, cursor: "pointer", fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>
        <ChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Volver
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="display" style={{ fontSize: 28, fontWeight: 700 }}>{meta.ticker}</div>
          <div style={{ color: MUTE, fontSize: 14 }}>{meta.name}</div>
        </div>
        {market && (
          <div style={{ textAlign: "right" }}>
            <div className="num" style={{ fontSize: 26, fontWeight: 700 }}>{fmt$2(market.price)}</div>
            <div className="num" style={{ fontSize: 13, color: (market.changePct || 0) >= 0 ? GREEN : RED }}>
              {market.changePct != null ? fmtPct1(market.changePct) : "—"} hoy
            </div>
          </div>
        )}
      </div>

      {loadingMarket && <div style={{ color: MUTE, fontSize: 13, marginBottom: 16 }}>Cargando datos reales…</div>}
      {market && (
        <div style={{ marginBottom: 20 }}>
          <RangeBar price={market.price} low={market.low} high={market.high} label={market.rangeLabel} />
          <div style={{ display: "flex", gap: 20, marginTop: 8, fontSize: 11, color: MUTE }}>
            <span>Cap. mercado: {fmtBig(market.marketCap)}</span>
            {market.peRatio != null && <span>P/E: {market.peRatio.toFixed(1)}</span>}
          </div>
        </div>
      )}

      <div style={{ background: "#151129", border: `1.5px solid ${decisionColor}`, borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: MUTE, letterSpacing: 1, marginBottom: 6 }}>DECISION BOX</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 16 }}>{decision.emoji}</span>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{decision.label}</div>
        </div>
        <div style={{ fontSize: 12, color: MUTE }}>{decision.detail}</div>
        <div style={{ display: "flex", gap: 20, marginTop: 10, fontSize: 11, color: MUTE, flexWrap: "wrap" }}>
          <span>Convicción: <ConvictionStars value={thesis?.conviction} /></span>
          <span>Última revisión: {reviewDays != null ? `hace ${reviewDays} día${reviewDays === 1 ? "" : "s"}` : "sin registrar"}</span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        {position ? (
          <Panel title="Tu posición">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 14 }}>
              <Metric label="Acciones/Unidades" value={`${position.shares}`} />
              <Metric label="Costo base" value={fmt$2(Number(position.cost_basis))} />
              <Metric label="Valor actual" value={position.value != null ? fmt$2(position.value) : "—"} />
              <Metric label="Ganancia" value={position.gain != null ? fmt$2(position.gain) : "—"} color={position.gain >= 0 ? GREEN : RED} />
            </div>
          </Panel>
        ) : (
          <Panel title={watchlistItem ? "En tu Watchlist" : "Descubrimiento"}>
            {watchlistItem ? (
              <div style={{ fontSize: 13, color: MUTE }}>
                Precio objetivo: {watchlistItem.target_price != null ? fmt$2(Number(watchlistItem.target_price)) : "sin definir"}<br />
                {watchlistItem.notes && <>Notas: {watchlistItem.notes}<br /></>}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: MUTE }}>No la tienes ni la vigilas todavía.</div>
            )}
            {!watchlistItem && !showWlForm && (
              <button onClick={() => setShowWlForm(true)} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer", marginTop: 12 }}>
                + Agregar a Watchlist
              </button>
            )}
            {showWlForm && (
              <WatchlistAddForm
                result={{ ticker: meta.ticker, name: meta.name, type: meta.type, coingeckoId: meta.coingeckoId }}
                onDone={() => { setShowWlForm(false); onSaved(); }}
              />
            )}
          </Panel>
        )}

        {position && (
          <Panel title="Portfolio Impact">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 14 }}>
              <Metric label="Peso actual" value={pctPatrimonio != null ? `${pctPatrimonio.toFixed(2)}%` : "—"} />
              <Metric label="Ranking" value={ranking ? `#${ranking.pos} de ${ranking.total}` : "—"} />
              <Metric label="Sector" value={position.sector || "Sin definir"} />
              <Metric label="Tema" value={position.tema || "Sin definir"} />
              <Metric label="Tipo de activo" value={position.strategic_role || "Sin clasificar"} />
            </div>
          </Panel>
        )}

        {position && (
          <Panel title="Investment Thesis">
            {!showThesisEdit ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 12, fontSize: 13, marginBottom: 14 }}>
                  <ThesisField label="¿Por qué la compré?" value={thesis?.why_bought} />
                  <ThesisField label="¿Qué tiene de especial?" value={thesis?.what_special} />
                  <ThesisField label="Exit Thesis (criterio de salida)" value={thesis?.sell_trigger} />
                  <ThesisField label="Horizonte" value={thesis?.horizon} />
                  <ThesisField label="Riesgos" value={thesis?.risks} />
                </div>
                <button onClick={() => setShowThesisEdit(true)} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
                  {thesis ? "Revisar tesis" : "Definir tesis"}
                </button>
              </>
            ) : (
              <ThesisEditForm ticker={meta.ticker} current={thesis} onDone={() => { setShowThesisEdit(false); onSaved(); }} />
            )}
          </Panel>
        )}

        {scoreData && (
          <Panel title="Opportunity Score">
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div className="num" style={{ fontSize: 28, fontWeight: 700, color: scoreData.total >= 80 ? GREEN : scoreData.total >= 65 ? "#7FCF9E" : AMBER }}>
                {scoreData.total}
              </div>
              <div style={{ fontSize: 11, color: MUTE }}>
                Convicción {scoreData.convictionPts} pts · Rango {scoreData.rangePts} pts · Momentum {scoreData.momentumPts} pts
              </div>
            </div>
          </Panel>
        )}

        <Panel title="Timeline">
          {timelineEvents.length === 0 ? <Empty /> : (
            <div style={{ display: "grid", gap: 8 }}>
              {timelineEvents.map((e, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${LINE}`, fontSize: 12, flexWrap: "wrap", gap: 6 }}>
                  <div><span style={{ color: MUTE }}>{e.date}</span> — <b>{e.label}</b> {e.notes && <span style={{ color: MUTE }}>({e.notes})</span>}</div>
                  {e.amount != null && <div className="num">{fmt$2(Number(e.amount))}</div>}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: MUTE, marginTop: 8 }}>Incluye compras, ventas, dividendos, cambios de tesis y entradas del Investment Journal de este ticker.</div>
        </Panel>

        <Panel title="Dividendos de este activo">
          {dividendos.length === 0 ? (
            <div style={{ color: MUTE, fontSize: 13 }}>Sin dividendos registrados de {meta.ticker}.</div>
          ) : (
            <>
              <Metric label="Total recibido" value={fmt$2(totalDividendos)} color={GOLD} />
              <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                {dividendos.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: MUTE }}>{d.date}</span>
                    <span className="num" style={{ color: GOLD }}>{fmt$2(Number(d.amount))}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function TickerSearchInput({ value, onChange, onPick, placeholder }) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const debounceRef = useRef(null);

  function handleChange(v) {
    onChange(v.toUpperCase());
    setShowResults(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 1) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { results: found } = await searchAssets(v.trim());
        setResults(found || []);
      } catch (e) { setResults([]); }
      finally { setSearching(false); }
    }, 350);
  }

  function pick(r) {
    onPick(r);
    setResults([]);
    setShowResults(false);
  }

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  return (
    <div style={{ position: "relative" }}>
      <input
        style={inputStyle} value={value} autoComplete="off"
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setShowResults(true)}
        onBlur={() => setTimeout(() => setShowResults(false), 150)}
        placeholder={placeholder || "Ej. Apple, AAPL, Solana…"}
      />
      {showResults && (searching || results.length > 0) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, background: PANEL, border: `1px solid ${LINE}`,
          borderRadius: 8, marginTop: 4, zIndex: 20, maxHeight: 220, overflowY: "auto",
        }}>
          {searching && <div style={{ padding: 10, fontSize: 12, color: MUTE }}>Buscando…</div>}
          {results.map((r, i) => (
            <button key={i} type="button" onMouseDown={() => pick(r)} style={{
              display: "flex", justifyContent: "space-between", width: "100%", background: "none", border: "none",
              padding: "8px 10px", textAlign: "left", cursor: "pointer", color: TXT, fontSize: 12, borderBottom: `1px solid ${LINE}`,
            }}>
              <span><b>{r.ticker}</b> <span style={{ color: MUTE }}>{r.name}</span></span>
              <span style={{ color: GOLD, fontSize: 9 }}>{r.type === "stock" ? "ACCIÓN" : "CRIPTO"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddForm({ onDone, existingPositions }) {
  const [form, setForm] = useState({ ticker: "", name: "", type: "stock", sector: "", tema: "", strategic_role: "", shares: "", cost_basis: "", coingecko_id: "" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [duplicateMatch, setDuplicateMatch] = useState(null); // posicion existente encontrada, en espera de confirmacion
  const [confirmedMerge, setConfirmedMerge] = useState(false);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); setDuplicateMatch(null); setConfirmedMerge(false); }

  function pickResult(r) {
    setForm((f) => ({ ...f, ticker: r.ticker, name: r.name, type: r.type, coingecko_id: r.coingeckoId || "" }));
    setDuplicateMatch(null); setConfirmedMerge(false);
  }

  async function doSubmit(mergeInto) {
    setBusy(true);
    try {
      if (mergeInto) {
        // Suma esta compra a la posicion existente -- el servidor hace la
        // matematica, nunca el navegador (evita el bug de posiciones
        // duplicadas que ya limpiamos en Supabase).
        await managePosition({
          pin, action: "merge_buy", id: mergeInto.id,
          position: { shares: Number(form.shares), cost_basis: Number(form.cost_basis) },
        });
      } else {
        await managePosition({
          pin, action: "add",
          position: {
            ticker: form.ticker.toUpperCase(), name: form.name, type: form.type,
            sector: form.sector || null, tema: form.tema || null, strategic_role: form.strategic_role || null,
            shares: Number(form.shares), cost_basis: Number(form.cost_basis),
            coingecko_id: form.coingecko_id || null,
          },
        });
      }
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!form.ticker || !form.name || !form.shares || !form.cost_basis) {
      setErr("Faltan campos obligatorios."); return;
    }
    if (!pin) { setErr("Falta tu PIN."); return; }

    // Si ya confirmaste el merge en el paso anterior, procede directo.
    if (confirmedMerge && duplicateMatch) { doSubmit(duplicateMatch); return; }

    // Primera pasada: ¿ya tienes este ticker? No sometas nada todavia --
    // muestra la vista previa y pide confirmacion explicita.
    const match = (existingPositions || []).find((p) => p.ticker.toUpperCase() === form.ticker.toUpperCase() && p.type !== "cash");
    if (match) { setDuplicateMatch(match); return; }

    doSubmit(null);
  }

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  if (duplicateMatch && !confirmedMerge) {
    const newShares = Number(duplicateMatch.shares) + Number(form.shares);
    const newCost = Number(duplicateMatch.cost_basis) + Number(form.cost_basis);
    return (
      <div style={{ background: NAVY_BG, border: `1px solid ${GOLD}`, borderRadius: 10, padding: 18, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10 }}>Ya tienes {duplicateMatch.ticker} — ¿es una compra adicional?</div>
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 14 }}>
          Ya tienes <b style={{ color: TXT }}>{duplicateMatch.shares}</b> unidades con costo de <b style={{ color: TXT }}>{fmt$2(Number(duplicateMatch.cost_basis))}</b>.
          Con esta compra nueva ({form.shares} unidades, {fmt$2(Number(form.cost_basis))}), quedaría en:
          <br /><b style={{ color: GOLD }}>{newShares}</b> unidades, costo total <b style={{ color: GOLD }}>{fmt$2(newCost)}</b>.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setConfirmedMerge(true)} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            Sí, sumar a mi posición existente
          </button>
          <button type="button" onClick={() => { setDuplicateMatch(null); }} style={{ background: "none", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 6, padding: "8px 14px", fontSize: 12, cursor: "pointer" }}>
            No, es un error / cancelar
          </button>
        </div>
      </div>
    );
  }

  if (confirmedMerge && duplicateMatch) {
    return (
      <div style={{ background: NAVY_BG, border: `1px solid ${GOLD}`, borderRadius: 10, padding: 18, marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 12 }}>Confirmado — sumando a tu posición existente de {duplicateMatch.ticker}.</div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button onClick={() => doSubmit(duplicateMatch)} disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            {busy ? "Guardando…" : "Confirmar y guardar"}
          </button>
          <button type="button" onClick={() => { setConfirmedMerge(false); setDuplicateMatch(null); }} style={{ background: "none", border: `1px solid ${LINE}`, color: MUTE, borderRadius: 6, padding: "8px 14px", fontSize: 12, cursor: "pointer" }}>
            Cancelar
          </button>
        </div>
        {err && <div style={{ color: RED, fontSize: 12, marginTop: 10 }}>{err}</div>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginBottom: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Ticker * (busca por nombre o símbolo)</label>
        <TickerSearchInput value={form.ticker} onChange={(v) => set("ticker", v)} onPick={pickResult} />
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Nombre *</label><input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Apple Inc" /></div>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Tipo *</label>
        <select style={inputStyle} value={form.type} onChange={(e) => set("type", e.target.value)}>
          <option value="stock">Acción</option><option value="crypto">Cripto</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Sector</label><input style={inputStyle} value={form.sector} onChange={(e) => set("sector", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tema estratégico</label><input style={inputStyle} value={form.tema} onChange={(e) => set("tema", e.target.value)} /></div>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Rol estratégico</label>
        <select style={inputStyle} value={form.strategic_role} onChange={(e) => set("strategic_role", e.target.value)}>
          <option value="">Sin clasificar</option>
          {STRATEGIC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Acciones/Unidades *</label><input style={inputStyle} type="number" step="any" value={form.shares} onChange={(e) => set("shares", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Costo total ($) *</label><input style={inputStyle} type="number" step="any" value={form.cost_basis} onChange={(e) => set("cost_basis", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", width: "100%" }}>
          {busy ? "Guardando…" : "Guardar"}
        </button>
      </div>
      {err && <div style={{ gridColumn: "1 / -1", color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}

function ConvictionStars({ value }) {
  if (!value) return <span style={{ color: MUTE, fontSize: 12 }}>Sin definir</span>;
  const stars = "★".repeat(value) + "☆".repeat(5 - value);
  const color = value >= 4 ? GOLD : value >= 3 ? TXT : MUTE;
  return <span style={{ color, letterSpacing: 1 }}>{stars}</span>;
}

function ThesisTab({ rows, onSaved, onOpenAsset }) {
  const [editing, setEditing] = useState(null);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {rows.length === 0 && <Empty />}
      {rows.map((p) => {
        const isEditing = editing === p.ticker;
        const rangePct = p.market && p.market.low != null && p.market.high != null && p.market.high > p.market.low
          ? ((p.market.price - p.market.low) / (p.market.high - p.market.low)) * 100
          : null;
        const contextNote = p.thesis?.conviction >= 4 && rangePct != null && rangePct < 25
          ? `Es una posición de tu mayor convicción (${p.thesis.conviction}★) y hoy está cerca del mínimo de su ${p.market.rangeLabel}.`
          : null;

        return (
          <div key={p.id} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 12, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <button onClick={() => onOpenAsset({ ticker: p.ticker, type: p.type, name: p.name, coingeckoId: p.coingecko_id })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: GOLD }}>{p.ticker} <span style={{ color: MUTE, fontSize: 13, fontWeight: 400 }}>{p.name}</span></div>
                <div style={{ marginTop: 4 }}><ConvictionStars value={p.thesis?.conviction} /></div>
              </button>
              <button onClick={() => setEditing(isEditing ? null : p.ticker)} style={{
                background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6,
                padding: "6px 12px", fontSize: 12, cursor: "pointer",
              }}>{isEditing ? "Cancelar" : (p.thesis ? "Editar" : "Definir tesis")}</button>
            </div>

            {contextNote && (
              <div style={{ marginTop: 10, fontSize: 12, color: GREEN, background: "#0F2A1D", border: `1px solid ${GREEN}`, borderRadius: 6, padding: "8px 10px" }}>
                {contextNote}
              </div>
            )}

            {!isEditing ? (
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 12, fontSize: 13 }}>
                <ThesisField label="¿Por qué la compré?" value={p.thesis?.why_bought} />
                <ThesisField label="¿Qué tiene de especial?" value={p.thesis?.what_special} />
                <ThesisField label="Exit Thesis (criterio de salida)" value={p.thesis?.sell_trigger} />
                <ThesisField label="Horizonte" value={p.thesis?.horizon} />
                <ThesisField label="Riesgos" value={p.thesis?.risks} />
              </div>
            ) : (
              <ThesisEditForm ticker={p.ticker} current={p.thesis} onDone={() => { setEditing(null); onSaved(); }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ThesisField({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: MUTE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ color: value ? TXT : MUTE, fontStyle: value ? "normal" : "italic" }}>{value || "Pendiente — sin definir"}</div>
    </div>
  );
}

function ThesisEditForm({ ticker, current, onDone }) {
  const [conviction, setConviction] = useState(current?.conviction || "");
  const [whyBought, setWhyBought] = useState(current?.why_bought || "");
  const [whatSpecial, setWhatSpecial] = useState(current?.what_special || "");
  const [sellTrigger, setSellTrigger] = useState(current?.sell_trigger || "");
  const [horizon, setHorizon] = useState(current?.horizon || "");
  const [risks, setRisks] = useState(current?.risks || "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const inputStyle = { background: PANEL, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%", resize: "vertical" };

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await manageThesis({
        pin, ticker,
        fields: {
          conviction: conviction ? Number(conviction) : null,
          why_bought: whyBought || null,
          what_special: whatSpecial || null,
          sell_trigger: sellTrigger || null,
          horizon: horizon || null,
          risks: risks || null,
        },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14, display: "grid", gap: 10 }}>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Convicción</label>
        <select style={inputStyle} value={conviction} onChange={(e) => setConviction(e.target.value)}>
          <option value="">Sin definir</option>
          <option value="1">★ (1) Sin interés</option>
          <option value="2">★★ (2) Especulativa</option>
          <option value="3">★★★ (3) Buena empresa, mantener</option>
          <option value="4">★★★★ (4) Excelente, comprar en correcciones</option>
          <option value="5">★★★★★ (5) Posición núcleo</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>¿Por qué la compré?</label><textarea style={inputStyle} rows={2} value={whyBought} onChange={(e) => setWhyBought(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>¿Qué tiene de especial?</label><textarea style={inputStyle} rows={2} value={whatSpecial} onChange={(e) => setWhatSpecial(e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Exit Thesis — ¿qué tendría que pasar para vender? (tu criterio de salida)</label><textarea style={inputStyle} rows={2} value={sellTrigger} onChange={(e) => setSellTrigger(e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div><label style={{ fontSize: 11, color: MUTE }}>Horizonte</label><input style={inputStyle} value={horizon} onChange={(e) => setHorizon(e.target.value)} placeholder="Ej. 10+ años" /></div>
        <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Riesgos principales</label><textarea style={inputStyle} rows={2} value={risks} onChange={(e) => setRisks(e.target.value)} /></div>
      <button type="submit" disabled={busy} style={{
        background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 16px",
        fontWeight: 700, fontSize: 13, cursor: "pointer",
      }}>{busy ? "Guardando…" : "Guardar tesis"}</button>
      {err && <div style={{ color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}
