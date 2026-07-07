import React, { useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Layers, Coins, ShieldAlert, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------
// DATA — snapshot manual (acciones 07-Jul-2026 / cripto 01-Jul-2026)
// ---------------------------------------------------------------
const STOCKS = [
  { t: "MSFT", n: "Microsoft Corp", sector: "Cloud / Software", tema: "IA / Cloud", shares: 13.208151, cost: 5609.37, price: 385.20 },
  { t: "ORCL", n: "Oracle Corp", sector: "Cloud / Software", tema: "IA / Cloud", shares: 20.921569, cost: 4124.29, price: 144.09 },
  { t: "AMZN", n: "Amazon.com Inc", sector: "Cloud / E-commerce", tema: "IA / Cloud", shares: 10.783564, cost: 2757.70, price: 242.08 },
  { t: "SPY", n: "SPDR S&P 500 ETF", sector: "ETF / Índice", tema: "Diversificado", shares: 2.986149, cost: 2100.00, price: 747.10 },
  { t: "ALAB", n: "Astera Labs Inc", sector: "Semis / Infra IA", tema: "Infraestructura IA", shares: 4.443522, cost: 1500.00, price: 440.23 },
  { t: "GOOGL", n: "Alphabet Class A", sector: "Cloud / IA", tema: "IA / Cloud", shares: 3.563214, cost: 1200.00, price: 360.45 },
  { t: "GOOG", n: "Alphabet Class C", sector: "Cloud / IA", tema: "IA / Cloud", shares: 1.991375, cost: 700.00, price: 357.64 },
  { t: "NBIS", n: "Nebius Group N.V.", sector: "Infra IA / Cloud", tema: "Infraestructura IA", shares: 6.609955, cost: 1496.95, price: 234.09 },
  { t: "VRT", n: "Vertiv Holdings Co", sector: "Infra Centros de Datos", tema: "Infraestructura IA", shares: 3.635924, cost: 1154.75, price: 312.30 },
  { t: "META", n: "Meta Platforms Inc", sector: "Software / IA", tema: "IA / Software", shares: 1.758366, cost: 1100.00, price: 616.37 },
  { t: "AMD", n: "Advanced Micro Devices", sector: "Semiconductores", tema: "Semiconductores IA", shares: 2.029489, cost: 600.00, price: 545.78 },
  { t: "NVDA", n: "Nvidia Corp", sector: "Semis / IA", tema: "Semiconductores IA", shares: 4.917282, cost: 950.00, price: 198.81 },
  { t: "FRVO", n: "Fervo Energy Co", sector: "Energía", tema: "Energía", shares: 33.907098, cost: 1302.62, price: 29.27 },
  { t: "XOM", n: "Exxon Mobil Corp", sector: "Energía", tema: "Energía", shares: 5.409389, cost: 829.07, price: 136.08 },
  { t: "CLSK", n: "CleanSpark Inc", sector: "Minería Bitcoin", tema: "Cripto-adyacente", shares: 58.378384, cost: 900.00, price: 13.71 },
  { t: "PLTR", n: "Palantir Technologies", sector: "Software / IA", tema: "IA / Software", shares: 4.768131, cost: 731.46, price: 126.89 },
  { t: "AAOI", n: "Applied Optoelectronics", sector: "Semis / Infra IA", tema: "Infraestructura IA", shares: 5.557410, cost: 655.83, price: 114.15 },
  { t: "CVX", n: "Chevron Corp", sector: "Energía", tema: "Energía", shares: 2.896564, cost: 550.00, price: 165.72 },
  { t: "CRWD", n: "CrowdStrike Holdings", sector: "Ciberseguridad", tema: "Ciberseguridad", shares: 2.583936, cost: 392.10, price: 192.70 },
  { t: "AAPL", n: "Apple Inc", sector: "Hardware / Tech", tema: "Hardware / Tech", shares: 1.160138, cost: 300.00, price: 294.27 },
  { t: "BRK.B", n: "Berkshire Hathaway B", sector: "Holding", tema: "Diversificado", shares: 0.606858, cost: 300.00, price: 502.29 },
  { t: "OXY", n: "Occidental Petroleum", sector: "Energía", tema: "Energía", shares: 5.845033, cost: 350.00, price: 48.04 },
  { t: "QCOM", n: "Qualcomm Inc", sector: "Semiconductores", tema: "Semiconductores IA", shares: 1.267009, cost: 314.17, price: 183.19 },
  { t: "TSLA", n: "Tesla Inc", sector: "Autos / Energía", tema: "Autos / Energía", shares: 0.555556, cost: 250.00, price: 426.74 },
];
const CASH_ARQ = 700;

const CRYPTO = [
  { t: "BTC", n: "Bitcoin", units: 0.45828642, cost: 30644.68, value: 29239.59 },
  { t: "ETH", n: "Ethereum", units: 1.00054778, cost: 1576.45, value: 1791.28 },
  { t: "SOL", n: "Solana", units: 9.99, cost: 813.68, value: 812.98 },
  { t: "LINK", n: "Chainlink", units: 76.78858609, cost: 573.53, value: 608.62 },
];
const USDT = 5000.55;

const GOLD = "#C9A34E";
const GREEN = "#3FBF83";
const RED = "#E5615A";
const NAVY_BG = "#0A0E17";
const PANEL = "#11172A";
const LINE = "#232B45";
const TXT = "#E8EAF2";
const MUTE = "#8A93B0";

const fmt$ = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt$2 = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export default function Dashboard() {
  const [tab, setTab] = useState("resumen");

  const stocksCalc = useMemo(() => STOCKS.map(s => {
    const value = s.shares * s.price;
    const gain = value - s.cost;
    return { ...s, value, gain, pct: gain / s.cost };
  }), []);

  const cryptoCalc = useMemo(() => CRYPTO.map(c => ({ ...c, gain: c.value - c.cost, pct: (c.value - c.cost) / c.cost })), []);

  const stocksValue = stocksCalc.reduce((a, s) => a + s.value, 0);
  const stocksCost = stocksCalc.reduce((a, s) => a + s.cost, 0);
  const cryptoValue = cryptoCalc.reduce((a, c) => a + c.value, 0);
  const cryptoCost = cryptoCalc.reduce((a, c) => a + c.cost, 0);
  const liquidity = CASH_ARQ + USDT;
  const patrimonio = stocksValue + cryptoValue + liquidity;
  const invested = stocksCost + cryptoCost + liquidity;
  const totalGain = patrimonio - invested;
  const totalPct = totalGain / invested;

  const allPositions = [
    ...stocksCalc.map(s => ({ label: s.t, name: s.n, value: s.value })),
    ...cryptoCalc.map(c => ({ label: c.t, name: c.n, value: c.value })),
  ].sort((a, b) => b.value - a.value);
  const top5 = allPositions.slice(0, 5);
  const top1Pct = top5[0].value / patrimonio;
  const top3Pct = top5.slice(0, 3).reduce((a, p) => a + p.value, 0) / patrimonio;

  const allocType = [
    { name: "Acciones", value: stocksValue, color: GOLD },
    { name: "Cripto", value: cryptoValue, color: "#7C8CF8" },
    { name: "Efectivo", value: liquidity, color: MUTE },
  ];

  const temaMap = {};
  stocksCalc.forEach(s => { temaMap[s.tema] = (temaMap[s.tema] || 0) + s.value; });
  const temaData = Object.entries(temaMap).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));

  const concColor = top1Pct > 0.35 ? RED : top1Pct > 0.2 ? "#E5A93A" : GREEN;

  return (
    <div style={{ background: NAVY_BG, minHeight: "100vh", color: TXT, fontFamily: "'IBM Plex Sans', 'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .num { font-family: 'IBM Plex Mono', monospace; }
        .display { font-family: 'Fraunces', serif; font-optical-sizing: auto; }
        ::-webkit-scrollbar { height: 6px; }
        ::-webkit-scrollbar-thumb { background: ${LINE}; border-radius: 3px; }
      `}</style>

      {/* Ticker tape */}
      <div style={{ borderBottom: `1px solid ${LINE}`, overflow: "hidden", whiteSpace: "nowrap", background: PANEL, padding: "8px 0" }}>
        <div style={{ display: "inline-block", animation: "scroll 40s linear infinite" }}>
          <style>{`@keyframes scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
          <div style={{ display: "inline-flex", gap: 28 }}>
            {[...allPositions, ...allPositions].map((p, i) => (
              <span key={i} className="num" style={{ fontSize: 12, color: MUTE }}>
                <b style={{ color: TXT }}>{p.label}</b> {fmt$(p.value)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "40px 24px 80px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 36, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 3, color: GOLD, fontWeight: 600, marginBottom: 6 }}>FAMILY OFFICE DIGITAL</div>
            <h1 className="display" style={{ fontSize: 40, fontWeight: 600, margin: 0, letterSpacing: -0.5 }}>Moni Capital</h1>
          </div>
          <div style={{ textAlign: "right", color: MUTE, fontSize: 12 }}>
            Snapshot manual · Acciones 07-Jul-2026 · Cripto 01-Jul-2026<br/>
            No es un feed en vivo
          </div>
        </div>

        {/* Hero patrimonio */}
        <div style={{ background: `linear-gradient(135deg, ${PANEL} 0%, #151C33 100%)`, border: `1px solid ${LINE}`, borderRadius: 14, padding: "32px 36px", marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: MUTE, letterSpacing: 1.5, marginBottom: 8 }}>PATRIMONIO TOTAL</div>
          <div className="display num" style={{ fontSize: 56, fontWeight: 700, letterSpacing: -1, lineHeight: 1 }}>
            {fmt$2(patrimonio)}
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
            <Metric label="Capital invertido" value={fmt$2(invested)} />
            <Metric label="Ganancia / Pérdida" value={fmt$2(totalGain)} color={totalGain >= 0 ? GREEN : RED} icon={totalGain >= 0 ? TrendingUp : TrendingDown} />
            <Metric label="Rendimiento" value={fmtPct(totalPct)} color={totalGain >= 0 ? GREEN : RED} />
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 28 }}>
          <KpiCard icon={Wallet} label="Liquidez (efectivo + USDT)" value={fmt$2(liquidity)} />
          <KpiCard icon={Layers} label="Valor en acciones" value={fmt$2(stocksValue)} />
          <KpiCard icon={Coins} label="Valor en cripto" value={fmt$2(cryptoValue)} />
          <KpiCard icon={ShieldAlert} label="Posiciones activas" value={`${STOCKS.length + CRYPTO.length}`} />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${LINE}`, marginBottom: 24 }}>
          {[["resumen", "Resumen"], ["posiciones", "Top Posiciones"], ["allocation", "Allocation"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              background: "none", border: "none", color: tab === key ? GOLD : MUTE, fontWeight: 600,
              fontSize: 13, padding: "10px 18px", cursor: "pointer",
              borderBottom: tab === key ? `2px solid ${GOLD}` : "2px solid transparent", marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        {tab === "resumen" && (
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 20 }}>
            <Panel title="Allocation por Tipo de Activo">
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
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
                      <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{((e.value / patrimonio) * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            <Panel title="Concentración y Semáforos">
              <SemRow label="Peso de la posición #1" value={top1Pct} color={concColor} />
              <SemRow label="Peso combinado Top 3" value={top3Pct} color={top3Pct > 0.55 ? RED : top3Pct > 0.35 ? "#E5A93A" : GREEN} />
              <SemRow label="Liquidez / Patrimonio" value={liquidity / patrimonio} color={GOLD} />
              <div style={{ fontSize: 11, color: MUTE, marginTop: 14, lineHeight: 1.5 }}>
                Referencia informativa: &gt;20% en una sola posición = alta concentración. Sin recomendación automática de compra/venta.
              </div>
            </Panel>

            <Panel title="Exposición Temática" span={2}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={temaData} layout="vertical" margin={{ left: 20, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                  <XAxis type="number" tickFormatter={fmt$} stroke={MUTE} fontSize={11} />
                  <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={11} width={140} />
                  <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                  <Bar dataKey="value" fill={GOLD} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}

        {tab === "posiciones" && (
          <Panel title="Top Posiciones (todo el patrimonio)">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
                  <th style={{ padding: "8px 6px", fontWeight: 500 }}>#</th>
                  <th style={{ padding: "8px 6px", fontWeight: 500 }}>Activo</th>
                  <th style={{ padding: "8px 6px", fontWeight: 500, textAlign: "right" }}>Valor</th>
                  <th style={{ padding: "8px 6px", fontWeight: 500, textAlign: "right" }}>% del Patrimonio</th>
                </tr>
              </thead>
              <tbody>
                {allPositions.map((p, i) => (
                  <tr key={p.label} style={{ borderBottom: `1px solid ${LINE}` }}>
                    <td style={{ padding: "10px 6px", color: MUTE }}>{i + 1}</td>
                    <td style={{ padding: "10px 6px" }}>
                      <b>{p.label}</b> <span style={{ color: MUTE, fontSize: 12 }}>{p.name}</span>
                    </td>
                    <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{fmt$2(p.value)}</td>
                    <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: GOLD }}>{((p.value / patrimonio) * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {tab === "allocation" && (
          <Panel title="Sector / Categoría (solo acciones)">
            <ResponsiveContainer width="100%" height={480}>
              <BarChart data={Object.entries(stocksCalc.reduce((acc, s) => { acc[s.sector] = (acc[s.sector] || 0) + s.value; return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))} layout="vertical" margin={{ left: 20, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                <XAxis type="number" tickFormatter={fmt$} stroke={MUTE} fontSize={11} />
                <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={11} width={170} />
                <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                <Bar dataKey="value" fill="#7C8CF8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}

        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 8, color: MUTE, fontSize: 12 }}>
          <ChevronRight size={14} />
          Este dashboard es un snapshot manual construido desde capturas de pantalla de ARQ y del exchange cripto. No sustituye el estado de cuenta oficial.
        </div>
      </div>
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
