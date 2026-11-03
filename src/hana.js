// Optional HANA access for Phase 2. Nothing here runs unless you call it.
// Rule from the master prompt: never write to two different databases. Only enable
// persistence/DB reads after P4 confirms which database CAP uses.
const SCHEMA_OK = /^[A-Za-z0-9_]+$/;
const schemaName = () => {
  const s = process.env.HANA_SCHEMA || 'HACKFEST0368';
  if (!SCHEMA_OK.test(s)) throw new Error('Invalid HANA_SCHEMA');
  return s;
};

// HANA returns upper-case column names (SUPPLIER_ID); the agent expects lower-case.
export const normalizeRow = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));

export const RISK_COLS = ['risk_id', 'event', 'region', 'affected_supplier', 'tier', 'confidence', 'source', 'reason', 'evidence_type', 'matched_on'];

export function buildInsert(schema = schemaName()) {
  return `INSERT INTO ${schema}.Risks (${RISK_COLS.join(', ')}) VALUES (${RISK_COLS.map(() => '?').join(', ')})`;
}

export async function insertRisk(risk, exec) {
  try {
    await exec(buildInsert(), RISK_COLS.map(c => risk[c]));
  } catch (e) {
    if (/unique constraint|301/i.test(String(e.message || e) + (e.code || '')))
      throw new Error(`Risk ${risk.risk_id} already exists`);
    throw e;
  }
  return risk.risk_id;
}

export async function loadContext(exec) {
  const sch = schemaName();
  const suppliers = (await exec(`SELECT supplier_id, name, tier, parent_id, material, region FROM ${sch}.Suppliers`, [])).map(normalizeRow);
  const declarations = (await exec(`SELECT * FROM ${sch}.SupplierDeclarations`, [])).map(normalizeRow);
  return { suppliers, declarations };
}

// Real executor using @sap/hana-client (install it only when you get DB credentials).
export async function makeExecutor() {
  const { HANA_HOST, HANA_PORT = '443', HANA_USER, HANA_PASSWORD } = process.env;
  if (!HANA_HOST || !HANA_USER || !HANA_PASSWORD) throw new Error('Set HANA_HOST, HANA_USER, HANA_PASSWORD in .env');
  const hana = (await import('@sap/hana-client')).default;
  const conn = hana.createConnection();
  await new Promise((res, rej) => conn.connect(
    { serverNode: `${HANA_HOST}:${HANA_PORT}`, uid: HANA_USER, pwd: HANA_PASSWORD, encrypt: true }, e => (e ? rej(e) : res())));
  const exec = (sql, params) => new Promise((res, rej) => conn.exec(sql, params, (e, rows) => (e ? rej(e) : res(rows))));
  exec.close = () => conn.disconnect();
  return exec;
}
