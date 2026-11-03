using {
    Suppliers as SuppliersEntity,
    Stock as StockEntity,
    SupplierDeclarations as DeclarationsEntity,
    Risks as RisksEntity,
    Impacts as ImpactsEntity,
    Options as OptionsEntity,
    Messages as MessagesEntity,
    ApprovalRule as ApprovalRuleEntity,
    Simulation as SimulationEntity,
    AuditLog as AuditLogEntity
} from '../db/schema';

// Authorisation (Batch 2):
// - Every request needs a login (401 without one).
// - All ten entities are read-only for every user (direct POST/PATCH/DELETE -> 405).
//   Data changes only through the actions below; their handlers write internally.
// - Actions need the procurement_manager or plant_owner role (403 otherwise).
//   Business rules (e.g. plant-owner approval above the threshold) stay in
//   medishield-service.js; these annotations are an additional layer.
@requires: 'authenticated-user'
service MediShieldService {

    @readonly entity Suppliers as projection on SuppliersEntity;
    @readonly entity Stock as projection on StockEntity;
    @readonly entity SupplierDeclarations as projection on DeclarationsEntity;
    @readonly entity Risks as projection on RisksEntity;
    @readonly entity Impacts as projection on ImpactsEntity;
    @readonly entity Options as projection on OptionsEntity;
    // Messages plus about_supplier: the Tier-2/3 (or Tier-1) supplier the message
    // is about, derived from the linked Risk. Not stored, so it cannot drift.
    @readonly entity Messages as select from MessagesEntity as m
        left join RisksEntity as r on m.risk_id = r.risk_id {
            key m.message_id,
                m.risk_id,
                m.option_id,
                m.to_supplier,
                r.affected_supplier as about_supplier : String(10),
                m.body,
                m.language,
                m.body_translated,
                m.status,
                m.reply_text,
                m.reply_timestamp
        };
    @readonly entity ApprovalRule as projection on ApprovalRuleEntity;
    @readonly entity Simulation as projection on SimulationEntity;
    @readonly entity AuditLog as projection on AuditLogEntity;
        type ActionResult {
        success   : Boolean;
        status    : String(30);
        message   : String(300);
        option_id : String(10);
    }

    @requires: ['procurement_manager', 'plant_owner']
    action approveOption(
        option_id     : String(10),
        approver_role : String(30),   // DEPRECATED: ignored; role comes from the login
        approved_by   : String(50),   // DEPRECATED: ignored; name comes from the login
        reason        : String(300)
    ) returns ActionResult;

    @requires: ['procurement_manager', 'plant_owner']
    action rejectOption(
        option_id     : String(10),
        approver_role : String(30),   // DEPRECATED: ignored; role comes from the login
        approved_by   : String(50),   // DEPRECATED: ignored; name comes from the login
        reason        : String(300)
    ) returns ActionResult;

    @requires: ['procurement_manager', 'plant_owner']
    action editOption(
        option_id        : String(10),
        option_type      : String(30),
        cost_estimate    : Decimal(12,2),
        delay_saved_days : Integer,
        approved_by      : String(50),   // DEPRECATED: ignored; name comes from the login
        reason           : String(300)
    ) returns ActionResult;

    type RiskInput {
        risk_id           : String(10);
        event             : String(300);
        region            : String(60);
        affected_supplier : String(10);
        tier              : Integer;
        confidence        : String(10);
        source            : String(200);
        reason            : String(300);
        evidence_type     : String(15);
        matched_on        : String(100);
    }

    type RiskCreationResult {
        success : Boolean;
        status  : String(30);
        message : String(300);
        risk_id : String(10);
    }
    @requires: ['procurement_manager', 'plant_owner']
    action createRisk(
        risk : RiskInput
    ) returns RiskCreationResult;

    
    type MessageResult {
        success     : Boolean;
        status      : String(30);
        message     : String(300);
        message_id  : String(10);
        option_id   : String(10);   // Batch 3a (added field)
    }

    @requires: ['procurement_manager', 'plant_owner']
    action createMessage(
        message_id      : String(10),   // optional since Batch 3a: generated as M + 9 characters if omitted
        risk_id         : String(10),
        option_id       : String(10),   // required since Batch 3a: the recovery option this message communicates
        to_supplier     : String(10),
        body            : String(2000),
        language        : String(5),
        body_translated : String(2000)
    ) returns MessageResult;

    // Batch 3a: human decision on a drafted message
    @requires: ['procurement_manager', 'plant_owner']
    action approveMessage(
        message_id : String(10),
        reason     : String(300)
    ) returns MessageResult;

    @requires: ['procurement_manager', 'plant_owner']
    action rejectMessage(
        message_id : String(10),
        reason     : String(300)        // required
    ) returns MessageResult;

    @requires: ['procurement_manager', 'plant_owner']
    action sendSimulatedMessage(
        message_id : String(10)
    ) returns MessageResult;

    @requires: ['procurement_manager', 'plant_owner']
    action recordSupplierReply(
        message_id : String(10),
        reply_text : String(1000)
    ) returns MessageResult;

}