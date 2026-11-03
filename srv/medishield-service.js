
import cds from '@sap/cds';
import { writeAudit } from './lib/audit.js';

const { SELECT, INSERT, UPDATE } = cds.ql;

// Roles that may take decisions on recovery options.
const DECISION_ROLES = ['plant_owner', 'procurement_manager'];

// State-changing actions; these must never run unauthenticated in production.
const STATE_CHANGING_ACTIONS = [
    'createRisk',
    'approveOption',
    'rejectOption',
    'editOption',
    'createMessage',
    'sendSimulatedMessage',
    'recordSupplierReply'
];

/**
 * Who is making this request?
 * - Logged-in user: name and role come from the login (trusted).
 * - Not logged in (development only): recorded as 'anonymous' with no role.
 *   A name sent in the request body is never recorded as a verified identity.
 */
function getActor(req) {
    const user = req.user;
    const authenticated = Boolean(user && user.is('authenticated-user'));

    if (!authenticated) {
        return { authenticated: false, name: 'anonymous', role: null };
    }

    const role = DECISION_ROLES.find((r) => user.is(r)) || null;
    return { authenticated: true, name: user.id, role };
}

function isProduction() {
    return (cds.env.profiles || []).includes('production');
}

export default class MediShieldService extends cds.ApplicationService {

    async init() {
        const {
            Options,
            ApprovalRule,
            Risks,
            Suppliers,
            Messages
        } = this.entities;

        // Production safety net: no state-changing action without a login.
        this.before(STATE_CHANGING_ACTIONS, (req) => {
            if (isProduction() && !getActor(req).authenticated) {
                return req.reject(401, 'Authentication is required.');
            }
        });

        // --------------------------------------------------
        // 1. CREATE RISK
        // --------------------------------------------------
        this.on('createRisk', async (req) => {
            const risk = req.data.risk;

            if (!risk) {
                return req.reject(400, 'Risk details are required.');
            }

            const {
                risk_id,
                event,
                region,
                affected_supplier,
                tier,
                confidence,
                source,
                reason,
                evidence_type,
                matched_on
            } = risk;

            // Validate required fields
            if (
                !risk_id ||
                !event ||
                !affected_supplier ||
                tier === undefined ||
                tier === null ||
                !confidence ||
                !source ||
                !reason ||
                !evidence_type
            ) {
                return req.reject(
                    400,
                    'One or more required risk fields are missing.'
                );
            }

            // Validate tier
            if (
                !Number.isInteger(Number(tier)) ||
                ![1, 2, 3].includes(Number(tier))
            ) {
                return req.reject(400, 'Tier must be 1, 2 or 3.');
            }

            // Validate evidence type
            if (!['declared', 'inferred', 'news'].includes(evidence_type)) {
                return req.reject(
                    400,
                    'Evidence type must be declared, inferred or news.'
                );
            }

            // Validate confidence (exact lowercase values, per P2 data dictionary)
            if (!['low', 'medium', 'high'].includes(confidence)) {
                return req.reject(
                    400,
                    'Confidence must be low, medium or high.'
                );
            }

            // Inferred evidence is never high confidence (P1 matching rule)
            if (evidence_type === 'inferred' && confidence === 'high') {
                return req.reject(
                    400,
                    'Inferred evidence cannot have high confidence.'
                );
            }

            const tx = cds.tx(req);

            // Check for duplicate risk ID
            const existingRisk = await tx.run(
                SELECT.one.from(Risks).where({ risk_id })
            );

            if (existingRisk) {
                return req.reject(
                    409,
                    `Risk ID ${risk_id} already exists.`
                );
            }

            // The affected supplier must exist
            const supplier = await tx.run(
                SELECT.one.from(Suppliers).where({ supplier_id: affected_supplier })
            );

            if (!supplier) {
                return req.reject(
                    404,
                    `Affected supplier ${affected_supplier} does not exist.`
                );
            }

            // The risk tier must match the supplier's actual tier
            if (Number(supplier.tier) !== Number(tier)) {
                return req.reject(
                    400,
                    `Tier ${tier} does not match supplier ${affected_supplier} (Tier-${supplier.tier}).`
                );
            }

            // Insert risk record
            await tx.run(
                INSERT.into(Risks).entries({
                    risk_id,
                    event,
                    region: region || null,
                    affected_supplier,
                    tier: Number(tier),
                    confidence: String(confidence),
                    source,
                    reason,
                    evidence_type,
                    matched_on: matched_on || null
                })
            );

            // Record risk detection in AuditLog
            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id,
                action: 'risk_detected',
                approver_role: actor.role,
                approved_by: actor.name,
                reason,
                status: 'detected'
            });

            return {
                success: true,
                status: 'created',
                message: 'Risk created and audit entry recorded.',
                risk_id
            };
        });


        
        // --------------------------------------------------
        // 2. APPROVE RECOVERY OPTION
        // --------------------------------------------------
        this.on('approveOption', async (req) => {
            const {
                option_id,
                approver_role,
                approved_by,
                reason
            } = req.data;

            const actor = getActor(req);

            if (!option_id) {
                return req.reject(400, 'Option ID is required.');
            }

            // Not logged in (development only): the legacy request fields are still required
            if (!actor.authenticated && (!approver_role || !approved_by)) {
                return req.reject(
                    400,
                    'Option ID, approver role and approver name are required.'
                );
            }

            // Logged in without a decision role (e.g. viewer)
            if (actor.authenticated && !actor.role) {
                return req.reject(403, 'You are not authorised to approve recovery options.');
            }

            // Role used for the threshold rule: the login role when logged in;
            // the request field only for unauthenticated development calls (removed in Batch 2).
            const effectiveRole = actor.authenticated ? actor.role : approver_role;

            const tx = cds.tx(req);

            const option = await tx.run(
                SELECT.one.from(Options).where({ option_id })
            );

            if (!option) {
                return req.reject(404, 'Recovery option not found.');
            }

            // Prevent approval after a final decision
            if (
                option.approval_status === 'approved' ||
                option.approval_status === 'rejected'
            ) {
                return req.reject(
                    409,
                    `This option has already been ${option.approval_status}.`
                );
            }

            const rule = await tx.run(
                SELECT.one.from(ApprovalRule)
            );

            if (!rule) {
                return req.reject(500, 'Approval rule is not configured.');
            }

            // Plant-owner approval is required if the option costs more than the
            // threshold OR was ever escalated. Escalation is permanent: lowering
            // the cost afterwards does not remove it.
            const ownerApprovalRequired =
                Number(option.cost_estimate) > Number(rule.threshold_cost) ||
                option.approval_status === 'pending_owner';

            if (ownerApprovalRequired && effectiveRole !== 'plant_owner') {

                // Avoid creating duplicate pending-owner audit entries
                if (option.approval_status !== 'pending_owner') {
                    // Conditional update: only if the status is still what we read
                    const changed = await tx.run(
                        UPDATE(Options)
                            .set({ approval_status: 'pending_owner' })
                            .where({ option_id, approval_status: option.approval_status })
                    );

                    if (changed !== 1) {
                        return req.reject(
                            409,
                            'This option was changed by another request. Reload and try again.'
                        );
                    }

                    await writeAudit(tx, {
                        risk_id: option.risk_id,
                        option_id,
                        action: 'approve',
                        approver_role: actor.role,
                        approved_by: actor.name,
                        reason: reason || 'Plant-owner approval requested',
                        status: 'pending_owner'
                    });
                }

                return {
                    success: false,
                    status: 'pending_owner',
                    message: 'Plant-owner approval is required.',
                    option_id
                };
            }

            // Conditional update: only if the status is still what we read
            const changed = await tx.run(
                UPDATE(Options)
                    .set({ approval_status: 'approved' })
                    .where({ option_id, approval_status: option.approval_status })
            );

            if (changed !== 1) {
                return req.reject(
                    409,
                    'This option was changed by another request. Reload and try again.'
                );
            }

            // Record final approval in AuditLog
            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'approve',
                approver_role: actor.role,
                approved_by: actor.name,
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



        
        // --------------------------------------------------
        // 3. REJECT RECOVERY OPTION
        // --------------------------------------------------
        this.on('rejectOption', async (req) => {
            const {
                option_id,
                approver_role,
                approved_by,
                reason
            } = req.data;

            const actor = getActor(req);

            if (!option_id || !reason) {
                return req.reject(400, 'Option ID and rejection reason are required.');
            }

            // Not logged in (development only): the legacy request fields are still required
            if (!actor.authenticated && (!approver_role || !approved_by)) {
                return req.reject(
                    400,
                    'Option ID, role, name and rejection reason are required.'
                );
            }

            // Logged in without a decision role (e.g. viewer)
            if (actor.authenticated && !actor.role) {
                return req.reject(403, 'You are not authorised to reject recovery options.');
            }

            const tx = cds.tx(req);

            const option = await tx.run(
                SELECT.one.from(Options).where({ option_id })
            );

            if (!option) {
                return req.reject(404, 'Recovery option not found.');
            }

            if (
                option.approval_status === 'approved' ||
                option.approval_status === 'rejected'
            ) {
                return req.reject(
                    409,
                    `This option has already been ${option.approval_status}.`
                );
            }

            // Conditional update: only if the status is still what we read.
            // (Decision A: managers may reject high-cost options.)
            const changed = await tx.run(
                UPDATE(Options)
                    .set({ approval_status: 'rejected' })
                    .where({ option_id, approval_status: option.approval_status })
            );

            if (changed !== 1) {
                return req.reject(
                    409,
                    'This option was changed by another request. Reload and try again.'
                );
            }

            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'reject',
                approver_role: actor.role,
                approved_by: actor.name,
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


        
        // --------------------------------------------------
        // 4. EDIT RECOVERY OPTION
        // --------------------------------------------------
        this.on('editOption', async (req) => {
            const {
                option_id,
                option_type,
                cost_estimate,
                delay_saved_days,
                approved_by,
                reason
            } = req.data;

            const actor = getActor(req);

            if (!option_id) {
                return req.reject(400, 'Option ID is required.');
            }

            // Not logged in (development only): the legacy editor-name field is still required
            if (!actor.authenticated && !approved_by) {
                return req.reject(
                    400,
                    'Option ID and editor name are required.'
                );
            }

            // Logged in without a decision role (e.g. viewer)
            if (actor.authenticated && !actor.role) {
                return req.reject(403, 'You are not authorised to edit recovery options.');
            }

            const tx = cds.tx(req);

            const option = await tx.run(
                SELECT.one.from(Options).where({ option_id })
            );

            if (!option) {
                return req.reject(404, 'Recovery option not found.');
            }

            if (
                option.approval_status === 'approved' ||
                option.approval_status === 'rejected'
            ) {
                return req.reject(
                    409,
                    'Finalised options cannot be edited.'
                );
            }

            const changes = {};

            if (option_type !== undefined && option_type !== null) {
                changes.type = option_type;
            }

            if (cost_estimate !== undefined && cost_estimate !== null) {
                if (
                    !Number.isFinite(Number(cost_estimate)) ||
                    Number(cost_estimate) < 0
                ) {
                    return req.reject(
                        400,
                        'Cost must be a valid non-negative number.'
                    );
                }

                changes.cost_estimate = cost_estimate;
            }

            if (delay_saved_days !== undefined && delay_saved_days !== null) {
                if (
                    !Number.isInteger(Number(delay_saved_days)) ||
                    Number(delay_saved_days) < 0
                ) {
                    return req.reject(
                        400,
                        'Days saved must be a non-negative integer.'
                    );
                }

                changes.delay_saved_days = Number(delay_saved_days);
            }

            if (Object.keys(changes).length === 0) {
                return req.reject(
                    400,
                    'Provide at least one field to edit.'
                );
            }

            const rule = await tx.run(
                SELECT.one.from(ApprovalRule)
            );

            if (!rule) {
                return req.reject(500, 'Approval rule is not configured.');
            }

            // Escalation is permanent. The option stays (or becomes) pending_owner
            // if it was already escalated, or if its cost before this edit was
            // above the threshold. Otherwise an edit resets it to pending.
            const staysEscalated =
                option.approval_status === 'pending_owner' ||
                Number(option.cost_estimate) > Number(rule.threshold_cost);

            changes.approval_status = staysEscalated ? 'pending_owner' : 'pending';

            // Conditional update: only if the status is still what we read
            const changed = await tx.run(
                UPDATE(Options)
                    .set(changes)
                    .where({ option_id, approval_status: option.approval_status })
            );

            if (changed !== 1) {
                return req.reject(
                    409,
                    'This option was changed by another request. Reload and try again.'
                );
            }

            await writeAudit(tx, {
                risk_id: option.risk_id,
                option_id,
                action: 'edit',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: reason || 'Recovery option edited',
                status: 'edited'
            });

            return {
                success: true,
                status: 'edited',
                message: staysEscalated
                    ? 'Recovery option updated. It still requires plant-owner approval.'
                    : 'Recovery option updated successfully.',
                option_id
            };
        });
        
        // --------------------------------------------------
        // 5. CREATE SUPPLIER MESSAGE DRAFT
        // --------------------------------------------------
        this.on('createMessage', async (req) => {
            const {
                message_id,
                risk_id,
                to_supplier,
                body,
                language,
                body_translated
            } = req.data;

            if (!message_id || !risk_id || !to_supplier || !body) {
                return req.reject(400, 'Message ID, risk ID, supplier ID and body are required.');
            }

            if (body.length > 2000) {
                return req.reject(400, 'Message body exceeds 2000 characters.');
            }

            if (language && !['en', 'hi', 'te'].includes(language)) {
                return req.reject(400, 'Language must be en, hi or te.');
            }

            const tx = cds.tx(req);

            const existing = await tx.run(
                SELECT.one.from(Messages).where({ message_id })
            );

            if (existing) {
                return req.reject(409, 'Message ID already exists.');
            }

            const risk = await tx.run(
                SELECT.one.from(Risks).where({ risk_id })
            );

            if (!risk) {
                return req.reject(404, 'Associated risk not found.');
            }

            const affectedSupplier = await tx.run(
                SELECT.one.from(Suppliers).where({
                    supplier_id: risk.affected_supplier
                })
            );

            if (!affectedSupplier) {
                return req.reject(404, 'Affected supplier not found.');
            }

            // Resolve the Tier-1 supplier in the parent hierarchy.
            let rootSupplier = affectedSupplier;
            let depth = 0;

            while (Number(rootSupplier.tier) > 1 && depth < 3) {
                if (!rootSupplier.parent_id) {
                    return req.reject(400, 'Supplier hierarchy is incomplete.');
                }

                rootSupplier = await tx.run(
                    SELECT.one.from(Suppliers).where({
                        supplier_id: rootSupplier.parent_id
                    })
                );

                if (!rootSupplier) {
                    return req.reject(400, 'Parent supplier was not found.');
                }

                depth++;
            }

            if (Number(rootSupplier.tier) !== 1) {
                return req.reject(400, 'Could not resolve a valid Tier-1 supplier.');
            }

            if (to_supplier !== rootSupplier.supplier_id) {
                return req.reject(
                    400,
                    `This message must be routed through Tier-1 supplier ${rootSupplier.supplier_id}.`
                );
            }

            await tx.run(
                INSERT.into(Messages).entries({
                    message_id,
                    risk_id,
                    to_supplier,
                    body,
                    language: language || 'en',
                    body_translated: body_translated || null,
                    status: 'drafted',
                    reply_text: null,
                    reply_timestamp: null
                })
            );

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id,
                action: 'message_created',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: `Message ${message_id} drafted for Tier-1 supplier ${to_supplier}`,
                status: 'drafted'
            });

            return {
                success: true,
                status: 'drafted',
                message: 'Supplier message draft created and audited.',
                message_id
            };
        });


        // --------------------------------------------------
        // 6. SEND SIMULATED SUPPLIER MESSAGE
        // --------------------------------------------------
        this.on('sendSimulatedMessage', async (req) => {
            const { message_id } = req.data;

            if (!message_id) {
                return req.reject(400, 'Message ID is required.');
            }

            const tx = cds.tx(req);

            const message = await tx.run(
                SELECT.one.from(Messages).where({ message_id })
            );

            if (!message) {
                return req.reject(404, 'Message not found.');
            }

            if (message.status !== 'drafted') {
                return req.reject(
                    409,
                    'Only drafted messages can be sent. Duplicate sending is not allowed.'
                );
            }

            // Sending requires at least one approved recovery option.
            const approvedOption = await tx.run(
                SELECT.one.from(Options).where({
                    risk_id: message.risk_id,
                    approval_status: 'approved'
                })
            );

            if (!approvedOption) {
                return req.reject(
                    409,
                    'Approve a recovery option before sending the supplier message.'
                );
            }

            // Conditional update: only if the message is still a draft
            const changed = await tx.run(
                UPDATE(Messages)
                    .set({ status: 'sent_simulated' })
                    .where({ message_id, status: 'drafted' })
            );

            if (changed !== 1) {
                return req.reject(
                    409,
                    'Only drafted messages can be sent. Duplicate sending is not allowed.'
                );
            }

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id: message.risk_id,
                action: 'message_sent',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: `Message ${message_id} sent in simulation to Tier-1 supplier ${message.to_supplier}`,
                status: 'sent_simulated'
            });

            return {
                success: true,
                status: 'sent_simulated',
                message: 'Supplier message simulated successfully. No real message was sent.',
                message_id
            };
        });


        // --------------------------------------------------
        // 7. RECORD SUPPLIER REPLY
        // --------------------------------------------------
        this.on('recordSupplierReply', async (req) => {
            const { message_id, reply_text } = req.data;

            if (!message_id || !reply_text || !reply_text.trim()) {
                return req.reject(400, 'Message ID and reply text are required.');
            }

            if (reply_text.length > 1000) {
                return req.reject(400, 'Reply exceeds 1000 characters.');
            }

            const tx = cds.tx(req);

            const message = await tx.run(
                SELECT.one.from(Messages).where({ message_id })
            );

            if (!message) {
                return req.reject(404, 'Message not found.');
            }

            if (message.status === 'reply_received') {
                return req.reject(409, 'A reply has already been recorded.');
            }

            if (message.status !== 'sent_simulated') {
                return req.reject(
                    409,
                    'A reply can only be recorded after simulated sending.'
                );
            }

            if (message.reply_text) {
                return req.reject(409, 'A reply has already been recorded.');
            }

            // Conditional update: only if still sent and not yet replied to.
            // Recording the reply also moves the message to reply_received.
            const changed = await tx.run(
                UPDATE(Messages)
                    .set({
                        status: 'reply_received',
                        reply_text: reply_text.trim(),
                        reply_timestamp: new Date().toISOString()
                    })
                    .where({ message_id, status: 'sent_simulated', reply_text: null })
            );

            if (changed !== 1) {
                return req.reject(409, 'A reply has already been recorded.');
            }

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id: message.risk_id,
                action: 'supplier_reply',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: `Reply recorded for message ${message_id}`,
                status: 'reply_received'
            });

            return {
                success: true,
                status: 'reply_received',
                message: 'Supplier reply recorded and audited.',
                message_id
            };
        });

        return super.init();
    }
}

