# P1 -> P4 handoff: Sensing Agent (all data simulated)

## Contract
Input: `text` (string, required), `source` (string label, e.g. "Supplier email (simulated)").
Output: `{ "risk": <Risk|null>, "note": <string|null> }`
Risk = { risk_id, event, region, affected_supplier, tier (1/2/3), confidence (low/medium/high),
         source, reason, evidence_type (declared/inferred/news), matched_on }
- `affected_supplier` is the matched supplier's own ID (S3 for a Tier-2 hit). Use V_Tier1Root to get the Tier-1 root (S1).
- `risk: null` means "no disruption / no supplier matched / LLM failed" (see `note`). The orchestration must stop that run cleanly and log it, not crash.
- risk_id starts with "R" (max 10 chars); never uses TEST1, RA1, TO1, TO2, TM1.

Example (Scenario A, Tier-2 declared):
{"risk":{"risk_id":"R1A2B3C4D","event":"Port closure in Zhejiang for 7 days","region":"Zhejiang","affected_supplier":"S3","tier":2,"confidence":"high","source":"News (simulated)","reason":"Sharma Traders declared Zhejiang API Works in Zhejiang as upstream supplier (60% share)","evidence_type":"declared","matched_on":"declaration D1: upstream_region=Zhejiang"},"note":null}

## Option A (recommended): import into CAP, no extra service
Copy the `src/` and `data/` folders into the CAP repo (e.g. `srv/sensing/`), set env vars in BTP, then in the CAP service handler:

    // srv/sensing-service.js  (adapt names to your CDS service)
    const cds = require('@sap/cds');
    module.exports = cds.service.impl(async function () {
      this.on('runSensing', async (req) => {
        const { sense } = await import('./sensing/src/sensing.js');
        const db = await cds.connect.to('db');
        const suppliers = await db.run(SELECT.from('Suppliers'));
        const declarations = await db.run(SELECT.from('SupplierDeclarations'));
        const { risk, note } = await sense(req.data.text, req.data.source, undefined, suppliers, declarations);
        if (!risk) return { risk: null, note };
        await db.run(INSERT.into('Risks').entries(risk));   // P4 owns writes + AuditLog
        return { risk, note: null };
      });
    });
Check: column names must be lower-case keys (supplier_id ...). If CAP returns another case, lower-case them.
Env needed by the agent: LLM_PROVIDER, GEMINI_API_KEY, GEMINI_MODEL (the Gemini key must be set as a BTP env var, never committed).

## Option B: HTTP service (local testing)
    npm run serve
    curl localhost:3001/health
    curl -s -X POST localhost:3001/sense -H "Content-Type: application/json" \
      -d '{"text":"Ningbo-Zhoushan port in Zhejiang province suspended for 7 days","source":"News (simulated)"}'
Env flags (default off): USE_DB=true reads Suppliers/SupplierDeclarations from HANA; PERSIST_RISKS=true inserts the Risk into HACKFEST0368.Risks.
Needs HANA_HOST, HANA_USER, HANA_PASSWORD, `npm i @sap/hana-client`. Use ONLY the database P4 and the lead agreed on.

## Questions P4 must answer
1. Does CAP use HACKFEST0368 or its own tables? (decides whether P1 may write Risks)
2. Who inserts the Risk and writes the AuditLog "risk_detected" row? Default here: P4.
3. What is the CDS action/endpoint name P5 will call?

## Failure paths to include in Phase 3 tests
LLM down or quota (risk null + note starts "LLM error"), unrelated text, unknown region, duplicate risk_id (409), empty text (400).
