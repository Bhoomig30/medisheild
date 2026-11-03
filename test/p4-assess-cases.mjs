// =====================================================================
// MediShield P4 - assessRisk data-condition tests (Batch 3b)
//
// These cases need test data that the API cannot create (all entities are
// read-only): missing stock, zero daily usage, wrong/duplicate declarations,
// broken supplier chains. The backend is started IN-PROCESS with its own
// fresh in-memory SQLite database; test rows are inserted directly there.
// Nothing touches your cds watch database, HANA or P2's HACKFEST0368.
//
// Run from the project root:  node test/p4-assess-cases.mjs
// Called automatically by test/p4-regression.sh (Group 12).
// Output lines start with PASS / FAIL; exit code 1 if anything failed.
// =====================================================================
import cds from '@sap/cds';

cds.root = process.cwd();
cds.log.levels = { cds: 'error', sqlite: 'error', db: 'error', deploy: 'error' };

const { SELECT, INSERT, UPDATE } = cds.ql;
await cds.serve('all', { in_memory: true });
await cds.deploy('*').to(await cds.connect.to('db'));
const srv = await cds.connect.to('MediShieldService');
const manager = new cds.User({ id: 'manager', roles: ['procurement_manager'] });

let pass = 0;
let fail = 0;
const failed = [];

function check(id, desc, ok, detail = '') {
    if (ok) { pass++; console.log(`PASS  ${id.padEnd(5)} ${desc}`); }
    else { fail++; failed.push(id); console.log(`FAIL  ${id.padEnd(5)} ${desc}\n      ${detail}`); }
}

async function assess(risk_id) {
    try {
        const r = await srv.tx({ user: manager }, (tx) => tx.send('assessRisk', { risk_id }));
        return { status: 200, r };
    } catch (e) {
        return { status: Number(e.status ?? e.statusCode ?? e.code ?? 500), msg: e.message };
    }
}

async function nothingStored(risk_id) {
    const impacts = await SELECT.from('Impacts').where({ risk_id });
    const options = await SELECT.from('Options').where({ risk_id });
    const audits = await SELECT.from('AuditLog').where({ risk_id });
    return impacts.length === 0 && options.length === 0 && audits.length === 0;
}

const risk = (risk_id, affected_supplier, tier) => ({
    risk_id, event: 'Disruption (simulated) 15 days', region: 'Test', affected_supplier, tier,
    confidence: 'medium', source: 'test', reason: 'test', evidence_type: 'news', matched_on: 'test'
});

// ---------- test data (inserted directly into this test database only) ----------
await INSERT.into('Suppliers').entries([
    { supplier_id: 'S7', name: 'No Stock Pharma', tier: 1, material: 'Ibuprofen API', region: 'Pune', country: 'India' },
    { supplier_id: 'S8', name: 'Zero Usage Pharma', tier: 1, material: 'Zero API', region: 'Pune', country: 'India' },
    { supplier_id: 'S9', name: 'Tier Jump Chem', tier: 3, parent_id: 'S1', material: 'x', region: 'x', country: 'x' },
    { supplier_id: 'S10', name: 'Orphan Works', tier: 2, parent_id: null, material: 'x', region: 'x', country: 'x' }
]);
await INSERT.into('Stock').entries({ material: 'Zero API', unit: 'kg', stock_units: 100, daily_usage: 0, lead_time_days: 7 });
await INSERT.into('Risks').entries([
    risk('RX1', 'S7', 1), risk('RX2', 'S8', 1), risk('RX3', 'S9', 3), risk('RX4', 'S10', 2),
    risk('RX5', 'S3', 2), risk('RX6', 'S3', 2), risk('RX7', 'S3', 2), risk('RX8', 'S3', 2),
    risk('RX9', 'S5', 3), risk('RY1', 'S4', 2), risk('RY2', 'S3', 2), risk('RY3', 'S3', 1),
    risk('RZ1', 'S4', 2)
]);

// ---------- stock ----------
let res = await assess('RX1');
check('12.01', 'Missing Stock row -> 422', res.status === 422 && /No stock data/.test(res.msg), JSON.stringify(res));
check('12.02', 'Missing Stock row -> nothing stored, no audit row', await nothingStored('RX1'));

res = await assess('RX2');
check('12.03', 'Zero daily usage -> 422', res.status === 422 && /greater than zero/.test(res.msg), JSON.stringify(res));
check('12.04', 'Zero daily usage -> nothing stored, no audit row', await nothingStored('RX2'));

// ---------- supplier chain ----------
res = await assess('RX3');
check('12.05', 'Tier-3 supplier whose parent is Tier-1 (skips Tier-2) -> 422', res.status === 422 && /inconsistent/.test(res.msg), JSON.stringify(res));
res = await assess('RX4');
check('12.06', 'Tier-2 supplier without parent -> 422', res.status === 422 && /incomplete/.test(res.msg), JSON.stringify(res));
check('12.07', 'Broken chains -> nothing stored', await nothingStored('RX3') && await nothingStored('RX4'));
res = await assess('RY3');
check('12.08', 'Risk tier 1 on Tier-2 supplier S3 (legacy bad data) -> 422', res.status === 422 && /does not match/.test(res.msg), JSON.stringify(res));

// ---------- declarations ----------
res = await assess('RX5');
check('12.09', 'Tier-2 risk on S3 uses D1 (S1, Zhejiang API Works, Paracetamol API, submitted)', res.status === 200 && res.r.declaration_id === 'D1', JSON.stringify(res));

await INSERT.into('SupplierDeclarations').entries({
    declaration_id: 'D7', tier1_supplier: 'S1', material: 'Other API', upstream_name: 'Zhejiang API Works',
    upstream_region: 'Zhejiang', share_percent: 10, backup_available: true, lead_time_days: 5, status: 'submitted'
});
res = await assess('RX6');
check('12.10', 'Declaration with wrong material (D7) is not selected', res.status === 200 && res.r.declaration_id === 'D1', JSON.stringify(res));

await UPDATE('SupplierDeclarations').set({ status: 'requested' }).where({ declaration_id: 'D1' });
res = await assess('RX7');
check('12.11', 'D1 not submitted + only wrong-material D7 -> no declaration (not D7)', res.status === 200 && res.r.declaration_id === null, JSON.stringify(res));
await UPDATE('SupplierDeclarations').set({ status: 'submitted' }).where({ declaration_id: 'D1' });

await INSERT.into('SupplierDeclarations').entries({
    declaration_id: 'D8', tier1_supplier: 'S2', material: 'Paracetamol API', upstream_name: 'Zhejiang API Works',
    upstream_region: 'Zhejiang', share_percent: 90, backup_available: true, lead_time_days: 5, status: 'submitted'
});
res = await assess('RX8');
check('12.12', "Another Tier-1's declaration (D8 by S2) is not selected for S1's chain", res.status === 200 && res.r.declaration_id === 'D1', JSON.stringify(res));

await INSERT.into('SupplierDeclarations').entries({
    declaration_id: 'D9', tier1_supplier: 'S1', material: 'Paracetamol API', upstream_name: 'Jiangsu Raw Chemicals',
    upstream_region: 'Jiangsu', share_percent: 5, backup_available: true, lead_time_days: 5, status: 'submitted'
});
res = await assess('RX9');
check('12.13', 'Tier-3 risk on S5: chain S5 -> S3 -> S1 validated, uses D1 (names Tier-2 S3), not D9 (names Tier-3)',
    res.status === 200 && res.r.declaration_id === 'D1' && res.r.material === 'Paracetamol API', JSON.stringify(res));

res = await assess('RY1');
check('12.14', 'Tier-2 risk on S4 (parent S2): D2 is only requested -> no declaration; D1/D8 not used',
    res.status === 200 && res.r.declaration_id === null, JSON.stringify(res));

await INSERT.into('SupplierDeclarations').entries({
    declaration_id: 'D10', tier1_supplier: 'S1', material: 'Paracetamol API', upstream_name: 'Zhejiang API Works',
    upstream_region: 'Zhejiang', share_percent: 30, backup_available: true, lead_time_days: 5, status: 'submitted'
});
res = await assess('RY2');
check('12.15', 'Two matching submitted declarations (D1, D10) -> 422, none picked', res.status === 422 && /D1, D10|D10, D1/.test(res.msg), JSON.stringify(res));
check('12.16', 'Ambiguous declarations -> nothing stored', await nothingStored('RY2'));

// ---------- audit rows are never changed by assessment errors ----------
let auditCount = (await SELECT.one.from('AuditLog').columns('count(*) as n')).n;
const assessed = (await SELECT.from('AuditLog').where({ action: { in: ['risk_assessed', 'risk_reassessed'] } })).length;
check('12.17', `Audit: exactly one row per successful assessment (6) and no rows for failed ones (${assessed} of ${auditCount})`, assessed === 6 && auditCount === 6);

// ---------- first vs. repeated assessment status ----------
// An Impact row that exists WITHOUT a previous assessment (e.g. seeded data)
// must not make the first assessment count as a reassessment.
await INSERT.into('Impacts').entries({ risk_id: 'RZ1', delay_days: 1, days_of_stock: 1, production_at_risk: 'pre-loaded (test)' });
res = await assess('RZ1');
check('12.18', 'Pre-loaded Impact but no previous assessment -> first result is "assessed"', res.status === 200 && res.r.status === 'assessed', JSON.stringify(res));
const rz1Impact = await SELECT.one.from('Impacts').where({ risk_id: 'RZ1' });
check('12.19', 'Pre-loaded Impact row updated with the calculated values (not duplicated)',
    rz1Impact && rz1Impact.delay_days === 15 && (await SELECT.from('Impacts').where({ risk_id: 'RZ1' })).length === 1, JSON.stringify(rz1Impact));
res = await assess('RZ1');
check('12.20', 'Second assessment of RZ1 -> "reassessed"', res.status === 200 && res.r.status === 'reassessed', JSON.stringify(res));
const rz1Audit = await SELECT.from('AuditLog').columns('action').where({ risk_id: 'RZ1' }).orderBy('audit_id');
check('12.21', 'RZ1 audit: risk_assessed then risk_reassessed, both kept',
    rz1Audit.map((a) => a.action).join(',') === 'risk_assessed,risk_reassessed', JSON.stringify(rz1Audit));

console.log(`NODE_RESULT ${pass} ${fail}`);
process.exit(fail > 0 ? 1 : 0);
