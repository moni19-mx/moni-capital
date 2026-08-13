// lib/financialMath.js
// UNICA fuente de verdad para formulas financieras compartidas (revision
// critica pre-Sprint-1, punto 5: "una sola fuente de formulas"). Antes
// existian copias de estas funciones en src/App.jsx -- ya se eliminaron
// de ahi, App.jsx ahora importa directamente de este archivo. Frontend,
// Command Center y Moni AI consumen exactamente la misma logica. Cero
// drift matematico entre pantallas y lo que Moni AI interpreta.

export function scoreBreakdown({ price, low, high, changePct, conviction }) {
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

export function simulateMonthsToGoal(current, target, monthlyContribution, annualReturnPct) {
  if (current >= target) return 0;
  const monthlyRate = (annualReturnPct || 0) / 100 / 12;
  let amount = current;
  for (let m = 1; m <= 1200; m++) {
    amount = amount * (1 + monthlyRate) + (monthlyContribution || 0);
    if (amount >= target) return m;
  }
  return null;
}

export function solveRequiredContribution(current, target, months, annualReturnPct) {
  if (current >= target) return 0;
  if (months <= 0) return null;
  let lo = 0, hi = Math.max(target, 1_000_000);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const reached = simulateMonthsToGoal(current, target, mid, annualReturnPct);
    if (reached != null && reached <= months) hi = mid; else lo = mid;
  }
  return Math.round(hi);
}

// Busqueda binaria: cuanto hay que aumentar la aportacion para llegar
// "monthsEarlier" meses antes que con la aportacion actual.
export function solveDeltaForEarlierMonths(current, target, contribution, annualReturnPct, monthsEarlier) {
  const baseMonths = simulateMonthsToGoal(current, target, contribution, annualReturnPct);
  if (baseMonths == null || baseMonths <= 0) return null;
  const desiredMonths = Math.max(0, baseMonths - monthsEarlier);
  const requiredTotal = solveRequiredContribution(current, target, desiredMonths, annualReturnPct);
  if (requiredTotal == null) return null;
  return Math.max(0, requiredTotal - contribution);
}

export function monthsBetweenDates(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export function addMonthsToToday(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
}

const MILESTONES = [100000, 250000, 500000, 1000000, 2000000, 5000000];

export function computeMilestones(snapshots, patrimonio) {
  return MILESTONES.map((threshold) => {
    const hit = snapshots.find((s) => Number(s.patrimonio) >= threshold);
    return {
      threshold,
      reached: !!hit || patrimonio >= threshold,
      date: hit ? hit.date : null,
      snapshot: hit || null,
    };
  });
}

export function computeRebalanceDeviations(targets, positionsWithValue, cashValue, patrimonio) {
  if (!patrimonio) return [];
  const byTema = {}, byRole = {};
  positionsWithValue.filter((p) => p.type !== "cash").forEach((p) => {
    const t = p.tema || "Sin clasificar"; byTema[t] = (byTema[t] || 0) + p.value;
    const r = p.strategic_role || "Sin clasificar"; byRole[r] = (byRole[r] || 0) + p.value;
  });
  if (cashValue > 0) { byTema["Efectivo"] = (byTema["Efectivo"] || 0) + cashValue; byRole["Cash"] = (byRole["Cash"] || 0) + cashValue; }

  return (targets || []).map((t) => {
    const map = t.dimension === "tema" ? byTema : byRole;
    const actualValue = map[t.label] || 0;
    const actualPct = (actualValue / patrimonio) * 100;
    return { ...t, actualPct, diff: actualPct - Number(t.target_pct) };
  }).filter((d) => Math.abs(d.diff) > 10);
}

export function computeSystemHealth({ positionsWithThesis, top1Pct, cashValue, patrimonio, primaryGoal, rebalanceDeviations, openDecisionsCount }) {
  let health = 100;
  const factors = [];

  const staleCount = positionsWithThesis.filter((p) => p.type !== "cash").filter((p) => {
    if (!p.thesis?.updated_at) return true;
    return (Date.now() - new Date(p.thesis.updated_at).getTime()) / 86400000 > 180;
  }).length;
  if (staleCount > 0) {
    const penalty = Math.min(30, staleCount * 5);
    health -= penalty; factors.push({ label: `${staleCount} tesis desactualizada${staleCount === 1 ? "" : "s"} o sin definir`, penalty });
  }
  if (!primaryGoal?.target_amount) {
    health -= 15; factors.push({ label: "Sin meta principal definida", penalty: 15 });
  }
  if (top1Pct > 0.35) {
    health -= 15; factors.push({ label: "Concentración elevada", penalty: 15 });
  }
  if (rebalanceDeviations.length > 0) {
    const penalty = Math.min(20, rebalanceDeviations.length * 10);
    health -= penalty; factors.push({ label: `${rebalanceDeviations.length} desviación${rebalanceDeviations.length === 1 ? "" : "es"} de rebalanceo`, penalty });
  }
  if (patrimonio && cashValue / patrimonio < 0.05) {
    health -= 10; factors.push({ label: "Liquidez baja", penalty: 10 });
  }
  if (openDecisionsCount > 0) {
    const penalty = Math.min(20, openDecisionsCount * 5);
    health -= penalty; factors.push({ label: `${openDecisionsCount} decisión${openDecisionsCount === 1 ? "" : "es"} abierta${openDecisionsCount === 1 ? "" : "s"} sin revisar`, penalty });
  }

  return { score: Math.max(0, Math.min(100, Math.round(health))), factors };
}
