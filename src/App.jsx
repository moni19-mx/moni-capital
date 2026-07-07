import React, { useEffect, useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from "recharts";
import {
  TrendingUp, TrendingDown, Wallet, Layers, Coins, ShieldAlert, ChevronRight,
  Plus, Trash2, RefreshCw, AlertTriangle,
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

async function fetchPositions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/positions?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error("No se pudo leer Supabase (revisa RLS / anon key)");
  return res.json();
}

async function fetchPrices(stockTickers, cryptoTickers) {
  const qs = new URLSearchParams({ stocks: stockTickers.join(","), cryptos: cryptoTickers.join(",") });
  const res = await fetch(`/api/prices?${qs.toString()}`);
  if (!res.ok) throw new Error("No se pudieron obtener precios en vivo");
  return res.json();
}

async function managePosition(payload) {
  const res = await fetch("/api/manage-positions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error === "invalid_pin" ? "PIN incorrecto" : (data.detail || data.error || "Error"));
  return data;
}

export default function Dashboard() {
  const [positions, setPositions] = useState([]);
  const [prices, setPrices] = useState({});
  const [priceErrors, setPriceErrors] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState("resumen");
  const [showAdd, setShowAdd] = useState(false);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const pos = await fetchPositions();
      setPositions(pos);
      const stockTickers = pos.filter((p) => p.type === "stock").map((p) => p.ticker);
      const cryptoTickers = pos.filter((p) => p.type === "crypto").map((p) => p.ticker);
      const { prices: live, errors, updatedAt: ts } = await fetchPrices(stockTickers, cryptoTickers);
      setPrices(live);
      setPriceErrors(errors || []);
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

  const enriched = useMemo(() => positions.map((p) => {
    const cost = Number(p.cost_basis);
    let value = null;
    let price = null;
    if (p.type === "cash") {
      value = cost;
      price = 1;
    } else {
      price = prices[p.ticker];
      if (price != null) value = Number(p.shares) * price;
    }
    const gain = value != null ? value - cost : null;
    const pct = value != null && cost ? gain / cost : null;
    return { ...p, price, value, gain, pct };
  }), [positions, prices]);

  const withValue = enriched.filter((p) => p.value != null);
  const missing = enriched.filter((p) => p.value == null);

  const patrimonio = withValue.reduce((a, p) => a + p.value, 0);
  const invested = withValue.reduce((a, p) => a + Number(p.cost_basis), 0);
  const totalGain = patrimonio - invested;
  const totalPct = invested ? totalGain / invested : 0;

  const stocksValue = withValue.filter((p) => p.type === "stock").reduce((a, p) => a + p.value, 0);
  const cryptoValue = withValue.filter((p) => p.type === "crypto").reduce((a, p) => a + p.value, 0);
  const cashValue = withValue.filter((p) => p.type === "cash").reduce((a, p) => a + p.value, 0);

  const top5 = [...withValue].sort((a, b) => b.value - a.value).slice(0, 5);
  const top1Pct = patrimonio ? (top5[0]?.value || 0) / patrimonio : 0;
  const top3Pct = patrimonio ? top5.slice(0, 3).reduce((a, p) => a + p.value, 0) / patrimonio : 0;

  const allocType = [
    { name: "Acciones", value: stocksValue, color: GOLD },
    { name: "Cripto", value: cryptoValue, color: "#7C8CF8" },
    { name: "Efectivo", value: cashValue, color: MUTE },
  ].filter((a) => a.value > 0);

  const temaMap = {};
  withValue.filter((p) => p.type !== "cash").forEach((p) => {
    const key = p.tema || "Sin clasificar";
    temaMap[key] = (temaMap[key] || 0) + p.value;
  });
  const temaData = Object.entries(temaMap).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));

  const concColor = top1Pct > 0.35 ? RED : top1Pct > 0.2 ? AMBER : GREEN;

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

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "40px 24px 80px" }}>
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
          <div style={{ background: "#2A1518", border: `1px solid ${RED}`, borderRadius: 10, padding: "14px 18px", marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AlertTriangle size={18} color={RED} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: TXT }}>
              No se pudo cargar el portafolio: {loadError}. Revisa que las variables de entorno VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY estén bien puestas en Vercel.
            </div>
          </div>
        )}

        {missing.length > 0 && !loadError && (
          <div style={{ background: "#2A2413", border: `1px solid ${AMBER}`, borderRadius: 10, padding: "12px 18px", marginBottom: 20, fontSize: 13, color: TXT }}>
            Sin precio en vivo por ahora: {missing.map((m) => m.ticker).join(", ")}. No se inventa su valor — no cuentan en los totales hasta que haya dato real.
          </div>
        )}

        <div style={{ background: `linear-gradient(135deg, ${PANEL} 0%, #151C33 100%)`, border: `1px solid ${LINE}`, borderRadius: 14, padding: "32px 36px", marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: MUTE, letterSpacing: 1.5, marginBottom: 8 }}>PATRIMONIO TOTAL (con dato en vivo)</div>
          <div className="display num" style={{ fontSize: 56, fontWeight: 700, letterSpacing: -1, lineHeight: 1 }}>
            {fmt$2(patrimonio)}
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
            <Metric label="Capital invertido" value={fmt$2(invested)} />
            <Metric label="Ganancia / Pérdida" value={fmt$2(totalGain)} color={totalGain >= 0 ? GREEN : RED} icon={totalGain >= 0 ? TrendingUp : TrendingDown} />
            <Metric label="Rendimiento" value={fmtPct(totalPct)} color={totalGain >= 0 ? GREEN : RED} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 28 }}>
          <KpiCard icon={Wallet} label="Efectivo" value={fmt$2(cashValue)} />
          <KpiCard icon={Layers} label="Valor en acciones" value={fmt$2(stocksValue)} />
          <KpiCard icon={Coins} label="Valor en cripto" value={fmt$2(cryptoValue)} />
          <KpiCard icon={ShieldAlert} label="Posiciones" value={`${positions.length}`} />
        </div>

        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${LINE}`, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
          {[["resumen", "Resumen"], ["posiciones", "Top Posiciones"], ["allocation", "Allocation"], ["gestionar", "Gestionar"]].map(([key, label]) => (
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
              {allocType.length === 0 ? <Empty /> : (
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
                        <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{patrimonio ? ((e.value / patrimonio) * 100).toFixed(1) : "0.0"}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>

            <Panel title="Concentración y Semáforos">
              {patrimonio === 0 ? <Empty /> : (
                <>
                  <SemRow label="Peso de la posición #1" value={top1Pct} color={concColor} />
                  <SemRow label="Peso combinado Top 3" value={top3Pct} color={top3Pct > 0.55 ? RED : top3Pct > 0.35 ? AMBER : GREEN} />
                  <SemRow label="Efectivo / Patrimonio" value={patrimonio ? cashValue / patrimonio : 0} color={GOLD} />
                  <div style={{ fontSize: 11, color: MUTE, marginTop: 14, lineHeight: 1.5 }}>
                    Referencia informativa: &gt;20% en una sola posición = alta concentración. Sin recomendación automática.
                  </div>
                </>
              )}
            </Panel>

            <Panel title="Exposición Temática" span={2}>
              {temaData.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={temaData} layout="vertical" margin={{ left: 20, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                    <XAxis type="number" tickFormatter={fmt$} stroke={MUTE} fontSize={11} />
                    <YAxis type="category" dataKey="name" stroke={MUTE} fontSize={11} width={140} />
                    <Tooltip formatter={(v) => fmt$2(v)} contentStyle={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8 }} />
                    <Bar dataKey="value" fill={GOLD} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>
        )}

        {tab === "posiciones" && (
          <Panel title="Top Posiciones">
            <PositionsTable rows={[...withValue].sort((a, b) => b.value - a.value)} patrimonio={patrimonio} />
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

        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 8, color: MUTE, fontSize: 12 }}>
          <ChevronRight size={14} />
          Precios de acciones vía Finnhub, cripto vía CoinGecko. Se refrescan solos cada 60s. No sustituye tu estado de cuenta oficial.
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

function Empty() {
  return <div style={{ color: MUTE, fontSize: 13 }}>Sin datos suficientes todavía.</div>;
}

function PositionsTable({ rows, patrimonio }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
          <th style={{ padding: "8px 6px" }}>#</th>
          <th style={{ padding: "8px 6px" }}>Activo</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Valor</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Ganancia</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>% Patrimonio</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => (
          <tr key={p.id} style={{ borderBottom: `1px solid ${LINE}` }}>
            <td style={{ padding: "10px 6px", color: MUTE }}>{i + 1}</td>
            <td style={{ padding: "10px 6px" }}><b>{p.ticker}</b> <span style={{ color: MUTE, fontSize: 12 }}>{p.name}</span></td>
            <td className="num" style={{ padding: "10px 6px", textAlign: "right" }}>{fmt$2(p.value)}</td>
            <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: p.gain >= 0 ? GREEN : RED }}>
              {p.gain != null ? fmt$2(p.gain) : "—"}
            </td>
            <td className="num" style={{ padding: "10px 6px", textAlign: "right", color: GOLD }}>
              {patrimonio ? ((p.value / patrimonio) * 100).toFixed(2) : "0.00"}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
    } catch (e) {
      alert("No se pudo eliminar: " + e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
      <thead>
        <tr style={{ color: MUTE, textAlign: "left", borderBottom: `1px solid ${LINE}` }}>
          <th style={{ padding: "8px 6px" }}>Ticker</th>
          <th style={{ padding: "8px 6px" }}>Nombre</th>
          <th style={{ padding: "8px 6px" }}>Tipo</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Acciones/Unid.</th>
          <th style={{ padding: "8px 6px", textAlign: "right" }}>Costo</th>
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
            <td style={{ padding: "10px 6px", textAlign: "right" }}>
              <button onClick={() => handleDelete(p)} disabled={busyId === p.id} style={{
                background: "none", border: `1px solid ${RED}`, color: RED, borderRadius: 6,
                padding: "4px 8px", cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4,
              }}>
                <Trash2 size={12} /> {busyId === p.id ? "…" : "Eliminar"}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddForm({ onDone }) {
  const [form, setForm] = useState({ ticker: "", name: "", type: "stock", sector: "", tema: "", shares: "", cost_basis: "" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (!form.ticker || !form.name || !form.shares || !form.cost_basis) {
      setErr("Faltan campos obligatorios (ticker, nombre, acciones/unidades, costo).");
      return;
    }
    setBusy(true);
    try {
      await managePosition({
        pin, action: "add",
        position: {
          ticker: form.ticker.toUpperCase(), name: form.name, type: form.type,
          sector: form.sector || null, tema: form.tema || null,
          shares: Number(form.shares), cost_basis: Number(form.cost_basis),
        },
      });
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = { background: NAVY_BG, border: `1px solid ${LINE}`, color: TXT, borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" };

  return (
    <form onSubmit={submit} style={{ background: NAVY_BG, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, marginBottom: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
      <div><label style={{ fontSize: 11, color: MUTE }}>Ticker *</label><input style={inputStyle} value={form.ticker} onChange={(e) => set("ticker", e.target.value)} placeholder="AAPL" /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Nombre *</label><input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Apple Inc" /></div>
      <div>
        <label style={{ fontSize: 11, color: MUTE }}>Tipo *</label>
        <select style={inputStyle} value={form.type} onChange={(e) => set("type", e.target.value)}>
          <option value="stock">Acción</option>
          <option value="crypto">Cripto</option>
          <option value="cash">Efectivo</option>
        </select>
      </div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Sector</label><input style={inputStyle} value={form.sector} onChange={(e) => set("sector", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tema estratégico</label><input style={inputStyle} value={form.tema} onChange={(e) => set("tema", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Acciones/Unidades *</label><input style={inputStyle} type="number" step="any" value={form.shares} onChange={(e) => set("shares", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Costo total ($) *</label><input style={inputStyle} type="number" step="any" value={form.cost_basis} onChange={(e) => set("cost_basis", e.target.value)} /></div>
      <div><label style={{ fontSize: 11, color: MUTE }}>Tu PIN *</label><input style={inputStyle} type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <button type="submit" disabled={busy} style={{
          background: GOLD, color: "#1A1305", border: "none", borderRadius: 6, padding: "10px 16px",
          fontWeight: 700, fontSize: 13, cursor: "pointer", width: "100%",
        }}>{busy ? "Guardando…" : "Guardar"}</button>
      </div>
      {err && <div style={{ gridColumn: "1 / -1", color: RED, fontSize: 12 }}>{err}</div>}
    </form>
  );
}
