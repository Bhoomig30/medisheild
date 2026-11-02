# P1 Sensing Agent (MediShield, SAP Hackfest 2026) - all data simulated

Input: text + source label. Output: Risk JSON in the shared format, or `null` with a note.

## Flow
1. An LLM extracts facts only (default: Google Gemini API; optional: SAP Generative AI Hub via `LLM_PROVIDER=sap`): is_disruption, event, region, supplier_name, material_hint, delay_days.
2. `src/match.js` decides tier, confidence and evidence in plain code (transparent, testable):
   1. Tier-1 named directly -> tier 1, high, evidence `news`, matched_on `supplier name`
   2. Submitted declaration with matching upstream region -> high, `declared`
   3. Tier-2/3 named without declaration -> medium, `news`
   4. Region (+ material) match in Suppliers -> medium or low, `inferred` (never high)
   5. Otherwise `null` with a note

Risk fields: risk_id, event, region, affected_supplier (the matched supplier's own ID; V_Tier1Root resolves it to Tier-1), tier, confidence, source, reason, evidence_type, matched_on.

## Setup
    npm install
    cp .env.example .env     # fill GEMINI_API_KEY and GEMINI_MODEL (free key: Google AI Studio)
    npm test                 # offline, no credentials needed
    npm run smoke            # Phase 0: one real LLM call returning Risk JSON
    npm run live             # real LLM on all 5 samples

## Rules
- Reserved test IDs never used: TEST1, RA1, TO1, TO2, TM1.
- Phase 1 does not write to HANA (P4 consumes the JSON in Phase 2). Data in `data/` mirrors Suppliers and SupplierDeclarations in HACKFEST0368.
- No real SAP credentials or endpoints are included; use placeholders in `.env`.

## Honesty note (for docs and slides)
The LLM here is Google Gemini, NOT SAP Generative AI Hub, because SAP AI Core access was unavailable. Do not claim Generative AI Hub use for this part unless `LLM_PROVIDER=sap` was actually run. The code keeps the SAP path so it can be switched back.
