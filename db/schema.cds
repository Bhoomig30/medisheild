// MediShield – persistence model (all data is simulated)
// Source of truth: medishield_setup.sql (PART 1: TABLES)
//
// No namespace is used on purpose: with CAP's default "plain" SQL mapping,
// entity Suppliers -> table SUPPLIERS, which matches the tables already
// created in the HANA schema by medishield_setup.sql.

entity Suppliers {
  key supplier_id : String(10);
      name        : String(100);
      tier        : Integer;
      parent_id   : String(10);
      material    : String(60);
      region      : String(60);
      country     : String(40);
      simulated   : Boolean default true;
}

entity Stock {
  key material       : String(60);
      unit           : String(10);
      stock_units    : Integer;
      daily_usage    : Integer;
      lead_time_days : Integer;
}

entity SupplierDeclarations {
  key declaration_id   : String(10);
      tier1_supplier   : String(10);
      material         : String(60);
      upstream_name    : String(100);
      upstream_region  : String(60);
      share_percent    : Integer;
      backup_available : Boolean;
      lead_time_days   : Integer;
      status           : String(15);
      submitted_at     : Timestamp;
}

entity Risks {
  key risk_id           : String(10);
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

entity Impacts {
  key risk_id            : String(10);
      delay_days         : Integer;
      days_of_stock      : Integer;
      production_at_risk : String(100);
}

entity Options {
  key option_id        : String(10);
      risk_id          : String(10);
      type             : String(30);
      cost_estimate    : Decimal(12, 2);
      delay_saved_days : Integer;
      option_rank      : Integer;
      approval_status  : String(20) default 'pending';
}

entity Messages {
  key message_id      : String(10);
      risk_id         : String(10);
      to_supplier     : String(10);
      body            : String(2000);
      language        : String(5);
      body_translated : String(2000);
      status          : String(20);
      reply_text      : String(1000);
      reply_timestamp : Timestamp;
}

entity ApprovalRule {
  key rule_id        : String(10);
      threshold_cost : Decimal(12, 2);
      approver_role  : String(30);
}

entity Simulation {
  key sim_id        : String(10);
      scenario_type : String(30);
      duration_days : Integer;
      region        : String(60);
      impact        : String(500);
      options       : String(1000);
}

entity AuditLog {
  key audit_id      : Integer;
      risk_id       : String(10);
      option_id     : String(10);
      action        : String(30);
      approver_role : String(30);
      approved_by   : String(50);
      reason        : String(300);
      status        : String(20);
      created_at    : Timestamp default $now;
}
