
import cds from '@sap/cds';
import { writeAudit } from './lib/audit.js';

const { SELECT, UPDATE } = cds.ql;

export default class MediShieldService extends cds.ApplicationService {

    async init() {
        const { Options, ApprovalRule } = this.entities;

        this.on('approveOption', async (req) => {
            const { option_id, approver_role, approved_by, reason } = req.data;

            if (!option_id || !approver_role || !approved_by) {
                return req.reject(400, 'Option ID, approver role and approver name are required.');
            }

            const tx = cds.tx(req);
            const option = await tx.run(SELECT.one.from(Options).where({ option_id }));

            if (!option) return req.reject(404, 'Recovery option not found.');

            const rule = await tx.run(SELECT.one.from(ApprovalRule));

            if (!rule) return req.reject(500, 'Approval rule is not configured.');

            if (
                Number(option.cost_estimate) > Number(rule.threshold_cost) &&
                approver_role !== 'plant_owner'
            ) {
                await writeAudit(tx, {
                    risk_id: option.risk_id,
                    option_id,
                    action: 'approve',
                    approver_role,
                    approved_by,
                    reason: reason || 'Approval requested',
                    status: 'pending_owner'
                });

                return {
                    success: false,
                    status: 'pending_owner',
                    message: 'Plant-owner approval is required.',
                    option_id
                };
            }

            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'approve',
                approver_role,
                approved_by,
                reason: reason || 'Option approved',
                status: 'approved'
            });

            return {
                success: true,
                status: 'approved',
                message: 'Recovery option approved successfully.',
                option_id
            };
        });

        this.on('rejectOption', async (req) => {
            const { option_id, approver_role, approved_by, reason } = req.data;

            if (!option_id || !approver_role || !approved_by || !reason) {
                return req.reject(400, 'Option ID, role, name and rejection reason are required.');
            }

            const tx = cds.tx(req);
            const option = await tx.run(SELECT.one.from(Options).where({ option_id }));

            if (!option) return req.reject(404, 'Recovery option not found.');

            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'reject',
                approver_role,
                approved_by,
                reason,
                status: 'rejected'
            });

            return {
                success: true,
                status: 'rejected',
                message: 'Recovery option rejected and recorded.',
                option_id
            };
        });

        this.on('editOption', async (req) => {
            const {
                option_id,
                option_type,
                cost_estimate,
                delay_saved_days,
                approved_by,
                reason
            } = req.data;

            if (!option_id || !approved_by) {
                return req.reject(400, 'Option ID and editor name are required.');
            }

            const tx = cds.tx(req);
            const option = await tx.run(SELECT.one.from(Options).where({ option_id }));

            if (!option) return req.reject(404, 'Recovery option not found.');

            const changes = {};

            if (option_type !== undefined && option_type !== null) {
                changes.type = option_type;
            }

            if (cost_estimate !== undefined && cost_estimate !== null) {
                if (Number(cost_estimate) < 0) {
                    return req.reject(400, 'Cost cannot be negative.');
                }
                changes.cost_estimate = cost_estimate;
            }

            if (delay_saved_days !== undefined && delay_saved_days !== null) {
                if (!Number.isInteger(Number(delay_saved_days)) || Number(delay_saved_days) < 0) {
                    return req.reject(400, 'Days saved must be a non-negative integer.');
                }
                changes.delay_saved_days = delay_saved_days;
            }

            if (Object.keys(changes).length === 0) {
                return req.reject(400, 'Provide at least one field to edit.');
            }

            await tx.run(UPDATE(Options).set(changes).where({ option_id }));

            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'edit',
                approved_by,
                reason: reason || 'Recovery option edited',
                status: 'edited'
            });

            return {
                success: true,
                status: 'edited',
                message: 'Recovery option updated successfully.',
                option_id
            };
        });

        return super.init();
    }
}
