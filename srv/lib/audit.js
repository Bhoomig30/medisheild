import cds from '@sap/cds';

const { INSERT } = cds.ql;

/**
 * Writes an action to the MediShield AuditLog.
 *
 * @param {object} tx - Current CAP transaction
 * @param {object} entry - Audit information
 */
export async function writeAudit(tx, entry) {
    const {
        risk_id,
        option_id = null,
        message_id = null,
        action,
        approver_role = null,
        approved_by = null,
        reason = null,
        status
    } = entry;

    if (!risk_id || !action || !status) {
        throw new Error(
            'AuditLog requires risk_id, action and status.'
        );
    }

    await tx.run(
        INSERT.into('AuditLog').entries({
            risk_id,
            option_id,
            message_id,
            action,
            approver_role,
            approved_by,
            reason,
            status
        })
    );
}
