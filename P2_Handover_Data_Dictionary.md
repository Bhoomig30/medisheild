# MediShield P2 Handover: Data Dictionary

All data is simulated. Database: SAP HANA Cloud instance Hackfest-DB, schema HACKFEST0368. These names and types match what was actually created and verified. Do not rename any table or field without posting in the group chat first.

## 1. Files
- medishield_setup.sql: table definitions (Part 1), INSERT statements (Part 2), helper views (Part 3). Parts 1 and 2 are already loaded in HACKFEST0368; run them only in a different database or schema.
- reset.sql: demo reset. Deletes test data. Run only before a rehearsal or the showcase, after telling the team.
- MediShield_Master_Prompt.md: shared formats and the full plan.

## 2. Tables, exact field names and data types

| Table | Key | Fields (type) |
|---|---|---|
| Suppliers | supplier_id | supplier_id NVARCHAR(10), name NVARCHAR(100), tier INTEGER, parent_id NVARCHAR(10), material NVARCHAR(60), region NVARCHAR(60), country NVARCHAR(40), simulated BOOLEAN default TRUE |
| Stock | material | material NVARCHAR(60), unit NVARCHAR(10), stock_units INTEGER, daily_usage INTEGER, lead_time_days INTEGER |
| SupplierDeclarations | declaration_id | declaration_id NVARCHAR(10), tier1_supplier NVARCHAR(10), material NVARCHAR(60), upstream_name NVARCHAR(100), upstream_region NVARCHAR(60), share_percent INTEGER, backup_available BOOLEAN, lead_time_days INTEGER, status NVARCHAR(15) (requested/submitted), submitted_at TIMESTAMP |
| Risks | risk_id | risk_id NVARCHAR(10), event NVARCHAR(300), region NVARCHAR(60), affected_supplier NVARCHAR(10), tier INTEGER, confidence NVARCHAR(10) (low/medium/high), source NVARCHAR(200), reason NVARCHAR(300), evidence_type NVARCHAR(15) (declared/inferred/news), matched_on NVARCHAR(100) |
| Impacts | risk_id | risk_id NVARCHAR(10), delay_days INTEGER, days_of_stock INTEGER, production_at_risk NVARCHAR(100) |
| Options | option_id | option_id NVARCHAR(10), risk_id NVARCHAR(10), type NVARCHAR(30), cost_estimate DECIMAL(12,2), delay_saved_days INTEGER, option_rank INTEGER |
| Messages | message_id | message_id NVARCHAR(10), risk_id NVARCHAR(10), to_supplier NVARCHAR(10), body NVARCHAR(2000), language NVARCHAR(5), body_translated NVARCHAR(2000), status NVARCHAR(20) (drafted/approved/sent_simulated), reply_text NVARCHAR(1000), reply_timestamp TIMESTAMP |
| ApprovalRule | rule_id | rule_id NVARCHAR(10), threshold_cost DECIMAL(12,2), approver_role NVARCHAR(30) |
| Simulation | sim_id | sim_id NVARCHAR(10), scenario_type NVARCHAR(30), duration_days INTEGER, region NVARCHAR(60), impact NVARCHAR(500), options NVARCHAR(1000) |
| AuditLog | audit_id | audit_id INTEGER auto-generated (identity), risk_id NVARCHAR(10), option_id NVARCHAR(10), action NVARCHAR(30), approver_role NVARCHAR(30), approved_by NVARCHAR(50), reason NVARCHAR(300), status NVARCHAR(20), created_at TIMESTAMP default CURRENT_TIMESTAMP |

Name changes from the original master-prompt formats: rank is option_rank; Options has risk_id; Impact is stored in table Impacts; Decision is stored in AuditLog with created_at instead of timestamp (timestamp and rank are reserved words).

## 3. Views (read-only helpers)
- V_SupplierChain: supplier plus parent_name.
- V_Tier1Root: any Tier-1/2/3 supplier with tier1_id (the Tier-1 supplier behind it).
- V_StockDays: stock with days_of_stock = stock_units / daily_usage.

## 4. Shared message formats (JSON between agents and UI)
- Risk {risk_id, event, region, affected_supplier, tier, confidence, source, reason, evidence_type, matched_on}
- Impact {risk_id, delay_days, days_of_stock, production_at_risk}
- Option {option_id, risk_id, type, cost_estimate, delay_saved_days, option_rank}
- Message {message_id, risk_id, to_supplier, body, language, body_translated, status, reply_text, reply_timestamp}
- Decision {risk_id, option_id, decision, approver_role, approved_by, reason, created_at, status}
- SupplierDeclaration, ApprovalRule, Simulation: same fields as their tables.

## 5. Reserved test IDs
Never use these in real data; delete any rows that use them after a test: TEST1, RA1, TO1, TO2, TM1.

## 6. Sample data (simulated)
- Suppliers: S1 Sharma Traders (T1, Mumbai), S2 Deccan Pharma Chem (T1, Hyderabad), S3 Zhejiang API Works (T2, parent S1, China), S4 Gujarat Intermediates (T2, parent S2, India), S5 Jiangsu Raw Chemicals (T3, parent S3, China).
- Stock: Paracetamol API, 4500 kg, 500 kg per day (9 days), lead time 14 days.
- ApprovalRule R1: threshold 200000, approver_role plant_owner.
- SupplierDeclarations: D1 (S1, submitted, upstream Zhejiang API Works, 60 percent, no backup, 21 days), D2 (S2, requested).
- Risks: RB1 (Tier-1 delay notice from S2, 10 days, scenario B).
- Demo scenario A: port closure in Zhejiang, affecting Tier-2 S3, behind Tier-1 S1.

## 7. Notes for the CAP project (not tested in CAP by P2)
- Suggested type mapping: NVARCHAR(n) to String(n), INTEGER to Integer, BOOLEAN to Boolean, TIMESTAMP to Timestamp, DECIMAL(12,2) to Decimal(12,2).
- audit_id is an auto-generated integer in HANA; in CAP, generate it in the service or use another key, but keep the field name.
- Fields named type, language, options and status may need quoting or a check; they worked in HANA SQL.
- Keep the exact field names above so P1, P3 and P5 can build to the same formats.
