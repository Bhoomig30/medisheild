// All numbers are simulated assumptions.
const C = { DEFAULT_DELAY: 14, EXPEDITE_SAVE: 5, EXPEDITE_RATE: 80,
            ALT_RATE: 90, ALT_SETUP: 25000, BUFFER_SAVE: 2, BUFFER_RATE: 30 };

function parseDelayDays(event, fallback = C.DEFAULT_DELAY) {
  const m = /(\d+)\s*days?/i.exec(event || '');
  return m ? Number(m[1]) : fallback;
}

function calcImpactCore({ risk, stock, declaration, delayDays }) {
  const delay = delayDays ?? parseDelayDays(risk.event);
  const daysOfStock = Math.floor(stock.stock_units / stock.daily_usage);
  const share = (risk.tier === 1 || !declaration || declaration.share_percent == null)
    ? 100 : declaration.share_percent;
  const gap = Math.max(0, delay - daysOfStock);
  const shortfallKg = Math.round(gap * stock.daily_usage * share / 100);
  const text = gap === 0
    ? `None: stock covers the ${delay}-day delay (simulated)`
    : `${stock.material}: ~${shortfallKg} ${stock.unit} short, ${gap} day(s) without stock (simulated)`;
  return {
    impact: { risk_id: risk.risk_id, delay_days: delay, days_of_stock: daysOfStock,
              production_at_risk: text.slice(0, 100) },
    calc: { gap, shortfallKg, share }
  };
}

function rankOptionsCore({ risk, impact, calc, stock, declaration, hasAlternate }) {
  const d = impact.delay_days, kg = calc.shortfallKg;
  const upstreamBlocked = risk.tier > 1 && declaration && declaration.backup_available === false;
  const opts = [{ type: 'expedite_shipment', cost_estimate: kg * C.EXPEDITE_RATE,
    delay_saved_days: Math.min(d, upstreamBlocked ? Math.floor(C.EXPEDITE_SAVE / 2) : C.EXPEDITE_SAVE) }];
  if (hasAlternate) opts.push({ type: 'alternate_supplier',
    cost_estimate: kg * C.ALT_RATE + C.ALT_SETUP,
    delay_saved_days: Math.max(0, d - Math.max(0, stock.lead_time_days - impact.days_of_stock)) });
  opts.push({ type: 'buffer_top_up',
    cost_estimate: stock.daily_usage * C.BUFFER_SAVE * C.BUFFER_RATE,
    delay_saved_days: Math.min(d, C.BUFFER_SAVE) });
  opts.sort((a, b) => b.delay_saved_days - a.delay_saved_days || a.cost_estimate - b.cost_estimate);
  return opts.map((o, i) => ({ option_id: `${risk.risk_id}-O${i + 1}`, risk_id: risk.risk_id,
                               ...o, option_rank: i + 1 }));
}

module.exports = { C, parseDelayDays, calcImpactCore, rankOptionsCore };