import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { sense, suppliers, declarations } from '../src/sensing.js';
import { parseFacts } from '../src/llm.js';
import { decide } from '../src/match.js';

const samples = JSON.parse(readFileSync(new URL('../samples/samples.json', import.meta.url)));
const FIELDS = ['risk_id','event','region','affected_supplier','tier','confidence','source','reason','evidence_type','matched_on'];
const RESERVED = ['TEST1','RA1','TO1','TO2','TM1'];

for (const s of samples) {
  test(`sample ${s.id}`, async () => {
    const { risk, note } = await sense(s.text, s.source, async () => s.facts);
    if (!s.expected) { assert.equal(risk, null); assert.ok(note); return; }
    for (const k of Object.keys(s.expected)) assert.equal(risk[k], s.expected[k], k);
    for (const k of FIELDS) assert.ok(risk[k] !== undefined && risk[k] !== null && risk[k] !== '', `missing ${k}`);
    assert.deepEqual(Object.keys(risk).sort(), [...FIELDS].sort());
    assert.ok(risk.risk_id.length <= 10);
    assert.ok(!RESERVED.includes(risk.risk_id));
    assert.ok(['low','medium','high'].includes(risk.confidence));
    assert.ok(['declared','inferred','news'].includes(risk.evidence_type));
    assert.ok([1,2,3].includes(risk.tier));
  });
}

test('malformed/failed LLM output returns null, no crash', async () => {
  const { risk, note } = await sense('x', 'x', async () => ({ is_disruption: false, error: 'bad json' }));
  assert.equal(risk, null);
  assert.match(note, /LLM error/);
});

test('inferred evidence is never high confidence', async () => {
  for (const s of samples.filter(x => x.expected)) {
    const { risk } = await sense(s.text, s.source, async () => s.facts);
    if (risk.evidence_type === 'inferred') assert.notEqual(risk.confidence, 'high');
  }
});

test('requested (unsubmitted) declaration is not used as evidence', () => {
  const facts = { is_disruption: true, event: 'e', region: 'Gujarat', supplier_name: null, material_hint: null };
  const decl = [...declarations, { declaration_id:'D9', tier1_supplier:'S2', upstream_name:'Gujarat Intermediates', upstream_region:'Gujarat', status:'requested' }];
  const { risk } = decide(facts, 'src', suppliers, decl);
  assert.equal(risk.evidence_type, 'inferred');
});

test('unknown region returns null with a note', () => {
  const { risk, note } = decide({ is_disruption: true, event: 'e', region: 'Atlantis' }, 'src', suppliers, declarations);
  assert.equal(risk, null); assert.match(note, /Atlantis/);
});

test('long text is truncated to column limits', () => {
  const long = 'x'.repeat(500);
  const { risk } = decide({ is_disruption: true, event: long, region: 'Zhejiang' }, long, suppliers, declarations);
  assert.ok(risk.event.length <= 300 && risk.source.length <= 200 && risk.reason.length <= 300 && risk.matched_on.length <= 100);
});

test('risk ids are unique across rapid calls', () => {
  const ids = new Set();
  for (let i = 0; i < 30; i++) ids.add(decide({ is_disruption: true, event: 'e', region: 'Zhejiang' }, 's', suppliers, declarations).risk.risk_id);
  assert.equal(ids.size, 30);
});

test('parseFacts handles markdown fences and chatter', () => {
  assert.equal(parseFacts('```json\n{"is_disruption":true}\n```').is_disruption, true);
  assert.equal(parseFacts('Here you go: {"is_disruption":false} thanks').is_disruption, false);
  assert.throws(() => parseFacts('not json at all'));
});

test('Tier-1 matching tolerates case and partial names', () => {
  const { risk } = decide({ is_disruption: true, event: 'e', region: null, supplier_name: 'deccan pharma' }, 's', suppliers, declarations);
  assert.equal(risk.affected_supplier, 'S2'); assert.equal(risk.tier, 1);
});

// ---- Gemini provider (fetch is mocked; no network or key needed) ----
import { callGemini, extractWithLLM } from '../src/llm.js';

function mockFetch(handler) { const orig = globalThis.fetch; globalThis.fetch = handler; return () => { globalThis.fetch = orig; }; }

test('gemini: sends correct request and parses response', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.GEMINI_MODEL = 'm'; process.env.LLM_PROVIDER = 'gemini';
  let seen;
  const restore = mockFetch(async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"is_disruption":true,"region":"Zhejiang","event":"e"}' }] } }] }) };
  });
  try {
    const facts = await extractWithLLM('port closed', suppliers);
    assert.equal(facts.region, 'Zhejiang');
    assert.match(seen.url, /models\/m:generateContent$/);
    assert.equal(seen.opts.headers['x-goog-api-key'], 'k');
    assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
    assert.ok(seen.body.systemInstruction.parts[0].text.length > 0);
    assert.match(seen.body.contents[0].parts[0].text, /KNOWN REGIONS: .*Zhejiang/);
  } finally { restore(); }
});

test('gemini: HTTP error becomes graceful null risk', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.GEMINI_MODEL = 'm';
  const restore = mockFetch(async () => ({ ok: false, status: 429, text: async () => 'quota' }));
  try {
    const { risk, note } = await sense('x', 'x');
    assert.equal(risk, null); assert.match(note, /LLM error.*429/);
  } finally { restore(); }
});

test('gemini: blocked/empty response is handled', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.GEMINI_MODEL = 'm';
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ candidates: [] }) }));
  try { await assert.rejects(() => callGemini([{ role: 'user', content: 'x' }]), /no text/); } finally { restore(); }
});

test('gemini: missing key gives a clear error', async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(() => callGemini([{ role: 'user', content: 'x' }]), /GEMINI_API_KEY/);
});

test('gemini: retries once on bad JSON then succeeds', async () => {
  process.env.GEMINI_API_KEY = 'k'; process.env.GEMINI_MODEL = 'm';
  let n = 0;
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: n++ === 0 ? 'oops' : '{"is_disruption":false}' }] } }] }) }));
  try { const f = await extractWithLLM('x', suppliers); assert.equal(f.is_disruption, false); assert.equal(n, 2); } finally { restore(); }
});
test('declaration matching uses material when multiple suppliers share a region', () => {
  const facts = {
    is_disruption: true,
    event: 'API shortage',
    region: 'Zhejiang',
    supplier_name: null,
    material_hint: 'Paracetamol API'
  };

  const declarations = [
    {
      declaration_id: 'D1',
      tier1_supplier: 'S1',
      upstream_name: 'Zhejiang API Works',
      upstream_region: 'Zhejiang',
      material: 'Paracetamol API',
      share_percent: 60,
      status: 'submitted'
    },
    {
      declaration_id: 'D2',
      tier1_supplier: 'S2',
      upstream_name: 'Other Chemical Works',
      upstream_region: 'Zhejiang',
      material: 'Raw chemical input',
      share_percent: 40,
      status: 'submitted'
    }
  ];

  const { risk } = decide(facts, 'News', suppliers, declarations);

  assert.equal(risk.affected_supplier, 'S3');
  assert.equal(risk.tier, 2);
  assert.equal(risk.evidence_type, 'declared');
});

test('ambiguous region-only declarations are not arbitrarily selected', () => {
  const facts = {
    is_disruption: true,
    event: 'Regional disruption',
    region: 'Zhejiang',
    supplier_name: null,
    material_hint: null
  };

  const declarations = [
    {
      declaration_id: 'D1',
      tier1_supplier: 'S1',
      upstream_name: 'Zhejiang API Works',
      upstream_region: 'Zhejiang',
      material: 'Paracetamol API',
      status: 'submitted'
    },
    {
      declaration_id: 'D2',
      tier1_supplier: 'S2',
      upstream_name: 'Other Chemical Works',
      upstream_region: 'Zhejiang',
      material: 'Raw chemical input',
      status: 'submitted'
    }
  ];

  const { risk } = decide(facts, 'News', suppliers, declarations);

  assert.notEqual(risk?.evidence_type, 'declared');
});
