import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { createServer } from '../src/server.js';
import { normalizeRow, buildInsert, insertRisk, loadContext, RISK_COLS } from '../src/hana.js';
import { suppliers, declarations } from '../src/sensing.js';

const samples = JSON.parse(readFileSync(new URL('../samples/samples.json', import.meta.url)));

async function withServer(opts, fn) {
  const srv = createServer(opts);
  await new Promise(r => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}
const post = (base, body) => fetch(base + '/sense', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('HTTP: /health', async () => {
  await withServer({}, async base => { const r = await (await fetch(base + '/health')).json(); assert.equal(r.ok, true); });
});

test('HTTP: /sense returns Risk JSON for sample s1', async () => {
  const s = samples[0];
  await withServer({ extract: async () => s.facts }, async base => {
    const r = await post(base, { text: s.text, source: s.source });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.risk.affected_supplier, 'S3'); assert.equal(j.persisted, false);
  });
});

test('HTTP: unrelated text returns risk null with a note', async () => {
  const s = samples[4];
  await withServer({ extract: async () => s.facts }, async base => {
    const j = await (await post(base, { text: s.text })).json();
    assert.equal(j.risk, null); assert.ok(j.note);
  });
});

test('HTTP: bad input gives 400, unknown route 404', async () => {
  await withServer({}, async base => {
    assert.equal((await post(base, { text: '' })).status, 400);
    assert.equal((await post(base, 'not json')).status, 400);
    assert.equal((await post(base, { nope: 1 })).status, 400);
    assert.equal((await fetch(base + '/x')).status, 404);
  });
});

test('HTTP: LLM failure still returns 200 with note (flow must not crash)', async () => {
  await withServer({ extract: async () => ({ is_disruption: false, error: 'quota' }) }, async base => {
    const r = await post(base, { text: 'x' }); assert.equal(r.status, 200);
    assert.match((await r.json()).note, /LLM error/);
  });
});

test('HTTP: persists only when PERSIST_RISKS=true, using Risks columns in order', async () => {
  const s = samples[1]; const calls = [];
  const exec = async (sql, params) => { calls.push({ sql, params }); return []; };
  process.env.PERSIST_RISKS = 'true';
  try {
    await withServer({ extract: async () => s.facts, exec }, async base => {
      const j = await (await post(base, { text: s.text, source: s.source })).json();
      assert.equal(j.persisted, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /^INSERT INTO HACKFEST0368\.Risks \(risk_id, event, region, affected_supplier, tier, confidence, source, reason, evidence_type, matched_on\) VALUES \(\?(, \?){9}\)$/);
      assert.equal(calls[0].params[3], 'S2');
    });
  } finally { delete process.env.PERSIST_RISKS; }
});

test('HTTP: duplicate risk_id gives 409', async () => {
  const s = samples[1];
  const exec = async () => { throw new Error('unique constraint violated'); };
  process.env.PERSIST_RISKS = 'true';
  try {
    await withServer({ extract: async () => s.facts, exec }, async base => {
      assert.equal((await post(base, { text: s.text })).status, 409);
    });
  } finally { delete process.env.PERSIST_RISKS; }
});

test('HANA: normalizeRow lower-cases upper-case column names', () => {
  assert.deepEqual(normalizeRow({ SUPPLIER_ID: 'S1', NAME: 'x' }), { supplier_id: 'S1', name: 'x' });
});

test('HANA: loadContext maps upper-case rows into what the agent expects', async () => {
  const exec = async sql => /Suppliers/.test(sql)
    ? [{ SUPPLIER_ID: 'S3', NAME: 'Zhejiang API Works', TIER: 2, PARENT_ID: 'S1', MATERIAL: 'Paracetamol API', REGION: 'Zhejiang' }]
    : [{ DECLARATION_ID: 'D1', TIER1_SUPPLIER: 'S1', UPSTREAM_NAME: 'Zhejiang API Works', UPSTREAM_REGION: 'Zhejiang', STATUS: 'submitted', SHARE_PERCENT: 60 }];
  const ctx = await loadContext(exec);
  assert.equal(ctx.suppliers[0].supplier_id, 'S3'); assert.equal(ctx.declarations[0].status, 'submitted');
});

test('HANA: schema name is validated (no SQL injection via env)', () => {
  process.env.HANA_SCHEMA = 'X; DROP TABLE Risks';
  try { assert.throws(() => buildInsert(), /Invalid HANA_SCHEMA/); } finally { delete process.env.HANA_SCHEMA; }
});

test('HANA: insertRisk passes all 10 columns', async () => {
  let seen; await insertRisk(Object.fromEntries(RISK_COLS.map((c, i) => [c, i])), async (sql, p) => { seen = p; });
  assert.equal(seen.length, 10);
});

test('Context from DB shape gives the same result as fixtures (declared Tier-2)', async () => {
  const { sense } = await import('../src/sensing.js');
  const s = samples[0];
  const a = await sense(s.text, s.source, async () => s.facts, suppliers, declarations);
  const b = await sense(s.text, s.source, async () => s.facts, suppliers.map(x => ({ ...x })), declarations.map(x => ({ ...x })));
  assert.equal(a.risk.affected_supplier, b.risk.affected_supplier);
});
