-- MediShield demo reset. WARNING: deletes teammates' test data. Run only before a rehearsal or the showcase, and tell the team first.
DELETE FROM AuditLog;
DELETE FROM Messages;
DELETE FROM Options;
DELETE FROM Impacts;
DELETE FROM Simulation;
DELETE FROM Risks WHERE risk_id <> 'RB1';
UPDATE SupplierDeclarations SET status='submitted' WHERE declaration_id='D1';
UPDATE SupplierDeclarations SET status='requested', submitted_at=NULL, upstream_name=NULL, upstream_region=NULL, share_percent=NULL, backup_available=NULL, lead_time_days=NULL WHERE declaration_id='D2';
