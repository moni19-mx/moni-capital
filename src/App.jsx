import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, LineChart, Line,
} from "recharts";
import {
  TrendingUp, TrendingDown, Wallet, Layers, Coins, ShieldAlert, ChevronRight,
  Plus, Trash2, RefreshCw, AlertTriangle, Search, Eye,
} from "lucide-react";

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

async function managePosition(payload) {
  const res = await fetch("/api/manage-positions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function manageWatchlist(payload) {
  const res = await fetch("/api/manage-watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function manageThesis(payload) {
  const res = await fetch("/api/manage-thesis", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function manageCash(payload) {
  const res = await fetch("/api/manage-cash", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function manageGoal(payload) {
  const res = await fetch("/api/manage-goal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

async function fetchMarketPulse() {
  const res = await fetch("/api/market-pulse");
  if (!res.ok) return null;
  return res.json();
}

// Opportunity Score (0-100), explicable: convicción + cercanía al mínimo + momentum reciente.
// Cada pieza es un número real ya calculado en otra parte -- esto solo los combina.
function scoreBreakdown({ price, low, high, changePct, conviction }) {
  const convictionPts = conviction ? Math.round((conviction / 5) * 40) : 0;
  let rangePts = 0;
  if (low != null && high != null && high > low && price != null) {
    const rangePct = ((price - low) / (high - low)) * 100;
    rangePts = Math.round((100 - rangePct) * 0.4);
  }
  const momentumPts = changePct != null
    ? Math.max(0, Math.min(20, Math.round(10 - changePct * 2)))
    : 10;
  const total = Math.max(0, Math.min(100, convictionPts + rangePts + momentumPts));
  return { convictionPts, rangePts, momentumPts, total };
}

const STARS = ["", "★", "★★", "★★★", "★★★★", "★★★★★"];

export default function Dashboard() {
  const [positions, setPositions] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [thesis, setThesis] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [cashMovements, setCashMovements] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [goal, setGoal] = useState(null);
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
      const [pos, wl, th, snaps, cm, tx, goals] = await Promise.all([
        sb("positions"),
        sb("watchlist").catch(() => []),
        sb("thesis").catch(() => []),
        sb("snapshots").catch(() => []),
        sb("cash_movements").catch(() => []),
        sb("transactions").catch(() => []),
        sb("goals").catch(() => []),
      ]);
      setPositions(pos);
      setWatchlist(wl);
      setThesis(th);
      setSnapshots([...snaps].sort((a, b) => (a.date < b.date ? -1 : 1)));
      setCashMovements([...cm].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setTransactions([...tx].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setGoal(goals && goals.length ? goals[0] : null);

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

  const goalPct = goal?.target_amount ? Math.min(100, (patrimonio / Number(goal.target_amount)) * 100) : null;

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
          <GoalBar goal={goal} patrimonio={patrimonio} goalPct={goalPct} onSaved={loadAll} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 28 }}>
          <KpiCard icon={Wallet} label="Efectivo" value={fmt$2(cashValue)} />
          <KpiCard icon={Layers} label="Valor en acciones" value={fmt$2(stocksValue)} />
          <KpiCard icon={Coins} label="Valor en cripto" value={fmt$2(cryptoValue)} />
          <KpiCard icon={Eye} label="En watchlist" value={`${watchlist.length}`} />
        </div>

        {!assetDetail && (
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${LINE}`, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
          {[["resumen", "Resumen"], ["performance", "Performance"], ["posiciones", "Top Posiciones"], ["tesis", "Tesis"], ["allocation", "Allocation"], ["historial", "Historial"], ["dividendos", "Dividendos"], ["discover", "Discover"], ["watchlist", "Watchlist"], ["efectivo", "Efectivo"], ["gestionar", "Gestionar"]].map(([key, label]) => (
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
            patrimonio={patrimonio}
            onBack={closeAsset}
            onSaved={loadAll}
            onOpenAsset={openAsset}
          />
        )}

        {!assetDetail && (
        <>

        {tab === "resumen" && (
          <div style={{ display: "grid", gap: 14 }}>
            <TodayStatusCard estado={estadoDeHoy} onNavigate={setTab} />

            <MoniAIBanner estado={estadoDeHoy} estrategia={estadoEstrategia} onNavigate={setTab} />

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

        {tab === "allocation" && (
          <Panel title="Sector / Categoría (solo acciones)">
            <ResponsiveContainer width="100%" height={480}>
              <BarChart
                data={Object.entries(
                  withValue.filter((p) => p.type === "stock").reduce((acc, p) => {
                    const key = p.sector || "Sin sector";
                    acc[key] = (acc[key] || 0) + p.value;
                    return acc;
                  }, {})
                ).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))}
                layout="vertical" margin={{ left: 20, right: 30 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                <XAxis type="number" tickFormatter={fmt$} stroke={MUTE} fontSize={11} />
                <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={11} width={170} />
                <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                <Bar dataKey="value" fill="#7C8CF8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
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
            {showAdd && <AddForm onDone={() => { setShowAdd(false); loadAll(); }} />}
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

function MoniAIBanner({ estado, estrategia, onNavigate }) {
  // Vista previa determinística (Capa 1) con el mismo tono que tendrá Moni AI real
  // cuando conectemos ese módulo. Ningún texto aquí lo genera un modelo todavía.
  let text;
  if (estado.emoji === "🔴") text = `Concentración elevada en ${estado.label.replace("Revisar concentración en ", "")}.`;
  else if (estado.emoji === "🟡") text = `Oportunidad detectada. ${estado.label}.`;
  else text = "Sin razones para modificar la estrategia.";
  return (
    <div style={{ background: "#1A1710", border: `1px solid ${GOLD}`, borderRadius: 10, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <div style={{ fontSize: 12 }}><b style={{ color: GOLD }}>Moni AI —</b> {text}</div>
      <button onClick={() => onNavigate("resumen")} style={{ background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>Continuar con Moni AI →</button>
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

function GoalBar({ goal, patrimonio, goalPct, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(goal?.target_amount || "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!amount || Number(amount) <= 0) { setErr("Pon un monto válido."); return; }
    setBusy(true);
    try {
      await manageGoal({ pin, target_amount: Number(amount) });
      setEditing(false);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!goal && !editing) {
    return (
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
        <button onClick={() => setEditing(true)} style={{ background: "none", border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>
          + Definir meta patrimonial
        </button>
      </div>
    );
  }

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "6px 8px", fontSize: 12, width: 120 };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}` }}>
      {!editing ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: MUTE, marginBottom: 4 }}>
            <span>META PATRIMONIAL · {fmt$2(Number(goal.target_amount))} <span onClick={() => { setAmount(goal.target_amount); setEditing(true); }} style={{ color: GOLD, cursor: "pointer", marginLeft: 6 }}>editar</span></span>
            <span style={{ color: GOLD, fontWeight: 700 }}>{goalPct != null ? goalPct.toFixed(1) : "0.0"}%</span>
          </div>
          <div style={{ height: 5, background: LINE, borderRadius: 3 }}>
            <div style={{ height: "100%", width: `${goalPct || 0}%`, background: GOLD, borderRadius: 3 }} />
          </div>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={inputStyle} type="number" step="any" placeholder="Meta ($)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input style={inputStyle} type="password" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button type="submit" disabled={busy} style={{ background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            {busy ? "..." : "Guardar"}
          </button>
          <button type="button" onClick={() => setEditing(false)} style={{ background: "none", border: "none", color: MUTE, fontSize: 11, cursor: "pointer" }}>Cancelar</button>
          {err && <div style={{ color: RED, fontSize: 10, width: "100%" }}>{err}</div>}
        </form>
      )}
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
  return (
    <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10, minWidth: 600 }}>
      <thead>
        <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
          <th style={{ padding: "8px 6px" }}>Ticker</th><th style={{ padding: "8px 6px" }}>Nombre</th>
          <th style={{ padding: "8px 6px" }}>Tipo</th><th style={{ padding: "8px 6px", textAlign: "right" }}>Acciones/Unid.</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Costo</th><th style={{ padding: "8px 6px" }}></th>
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

function AssetDetailScreen({ meta, positions, watchlist, transactions, patrimonio, onBack, onSaved, onOpenAsset }) {
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

  const assetType = useMemo(() => {
    const c = thesis?.conviction;
    if (c === 5) return "Core Holding";
    if (c === 4) return "High Conviction";
    if (c === 3) return "Growth";
    if (c === 2) return "Especulativa";
    return "Sin clasificar";
  }, [thesis]);

  const timelineEvents = useMemo(() => {
    const txEvents = (transactions || [])
      .filter((t) => t.ticker === meta.ticker)
      .map((t) => ({ date: t.date, label: TX_TYPE_LABEL[t.type] || (t.type || "").toUpperCase(), amount: t.amount, notes: t.notes }));
    const thesisEvent = thesis?.updated_at
      ? [{ date: String(thesis.updated_at).slice(0, 10), label: "TESIS ACTUALIZADA", amount: null, notes: null }]
      : [];
    return [...txEvents, ...thesisEvent].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [transactions, meta.ticker, thesis]);

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
              <Metric label="Tipo de activo" value={assetType} />
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
                  <ThesisField label="¿Qué la haría vender?" value={thesis?.sell_trigger} />
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
          <div style={{ fontSize: 10, color: MUTE, marginTop: 8 }}>Resultados y notas de Journal aparecerán aquí cuando ese módulo exista.</div>
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

function AddForm({ onDone }) {
  const [form, setForm] = useState({ ticker: "", name: "", type: "stock", sector: "", tema: "", shares: "", cost_basis: "", coingecko_id: "" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const debounceRef = useRef(null);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function onTickerChange(v) {
    setForm((f) => ({ ...f, ticker: v.toUpperCase(), coingecko_id: "" }));
    setShowResults(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 1) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { results } = await searchAssets(v.trim());
        setResults(results || []);
      } catch (e) { setResults([]); }
      finally { setSearching(false); }
    }, 350);
  }

  function pickResult(r) {
    setForm((f) => ({ ...f, ticker: r.ticker, name: r.name, type: r.type, coingecko_id: r.coingeckoId || "" }));
    setResults([]);
    setShowResults(false);
  }

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!form.ticker || !form.name || !form.shares || !form.cost_basis) {
      setErr("Faltan campos obligatorios."); return;
    }
    setBusy(true);
    try {
      await managePosition({
        pin, action: "add",
        position: {
          ticker: form.ticker.toUpperCase(), name: form.name, type: form.type,
          sector: form.sector || null, tema: form.tema || null,
          shares: Number(form.shares), cost_basis: Number(form.cost_basis),
          coingecko_id: form.coingecko_id || null,
        },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };
  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginBottom: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
      <div style={{ position: "relative" }}>
        <label style={{ fontSize: 11, color: MUTE }}>Ticker * (busca por nombre o símbolo)</label>
        <input
          style={inputStyle} value={form.ticker} autoComplete="off"
          onChange={(e) => onTickerChange(e.target.value)}
          onFocus={() => setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 150)}
          placeholder="Ej. Apple, AAPL, Solana…"
        />
        {showResults && (searching || results.length > 0) && (
          <div style={{
            position: "absolute", top: "100%", left: 0, right: 0, background: PANEL, border: `1px solid ${LINE}`,
            borderRadius: 8, marginTop: 4, zIndex: 20, maxHeight: 220, overflowY: "auto",
          }}>
            {searching && <div style={{ padding: 10, fontSize: 12, color: MUTE }}>Buscando…</div>}
            {results.map((r, i) => (
              <button key={i} type="button" onMouseDown={() => pickResult(r)} style={{
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
      <div><label style={{ fontSize: 11, color: MUTE }}>Nombre *</label><input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Apple Inc" /></div>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Tipo *</label>
        <select style={inputStyle} value={form.type} onChange={(e) => set("type", e.target.value)}>
          <option value="stock">Acción</option><option value="crypto">Cripto</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Sector</label><input style={inputStyle} value={form.sector} onChange={(e) => set("sector", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tema estratégico</label><input style={inputStyle} value={form.tema} onChange={(e) => set("tema", e.target.value)} /></div>
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
                <ThesisField label="¿Qué la haría vender?" value={p.thesis?.sell_trigger} />
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
      <div><label style={{ fontSize: 11, color: MUTE }}>¿Qué tendría que pasar para venderla?</label><textarea style={inputStyle} rows={2} value={sellTrigger} onChange={(e) => setSellTrigger(e.target.value)} /></div>
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
