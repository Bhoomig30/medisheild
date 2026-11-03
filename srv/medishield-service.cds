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

service MediShieldService {

    entity Suppliers as projection on SuppliersEntity;
    entity Stock as projection on StockEntity;
    entity SupplierDeclarations as projection on DeclarationsEntity;
    entity Risks as projection on RisksEntity;
    entity Impacts as projection on ImpactsEntity;
    entity Options as projection on OptionsEntity;
    entity Messages as projection on MessagesEntity;
    entity ApprovalRule as projection on ApprovalRuleEntity;
    entity Simulation as projection on SimulationEntity;
    entity AuditLog as projection on AuditLogEntity;
        type ActionResult {
        success   : Boolean;
        status    : String(30);
        message   : String(300);
        option_id : String(10);
    }

    action approveOption(
        option_id     : String(10),
        approver_role : String(30),
        approved_by   : String(50),
        reason        : String(300)
    ) returns ActionResult;

    action rejectOption(
        option_id     : String(10),
        approver_role : String(30),
        approved_by   : String(50),
        reason        : String(300)
    ) returns ActionResult;

    action editOption(
        option_id        : String(10),
        option_type      : String(30),
        cost_estimate    : Decimal(12,2),
        delay_saved_days : Integer,
        approved_by      : String(50),
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
    action createRisk(
        risk : RiskInput
    ) returns RiskCreationResult;

    
    type MessageResult {
        success     : Boolean;
        status      : String(30);
        message     : String(300);
        message_id  : String(10);
    }

    action createMessage(
        message_id      : String(10),
        risk_id         : String(10),
        to_supplier     : String(10),
        body            : String(2000),
        language        : String(5),
        body_translated : String(2000)
    ) returns MessageResult;

    action sendSimulatedMessage(
        message_id : String(10)
    ) returns MessageResult;

    action recordSupplierReply(
        message_id : String(10),
        reply_text : String(1000)
    ) returns MessageResult;

}