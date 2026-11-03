
import cds from '@sap/cds';
import { randomInt } from 'node:crypto';
import { writeAudit } from './lib/audit.js';
// P3's code, copied unchanged (Batch 3b). P4 wraps it with validation,
// authorisation, persistence and audit; it does not change P3's calculations.
import p3Rules from './lib/rules.cjs';
import p3Draft from './lib/draftMessage.cjs';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

// Roles that may take decisions on recovery options.
const DECISION_ROLES = ['plant_owner', 'procurement_manager'];

// State-changing actions; these must never run without a login and a decision role.
const STATE_CHANGING_ACTIONS = [
    'createRisk',
    'approveOption',
    'rejectOption',
    'editOption',
    'createMessage',
    'approveMessage',
    'rejectMessage',
    'sendSimulatedMessage',
    'recordSupplierReply',
    'assessRisk',
    'generateMessageDraft'
];

// Official option types (owned by P3; agreed with P2 and P5).
const OPTION_TYPES = ['alternate_supplier', 'expedite_shipment', 'buffer_top_up'];

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** Small error type so helpers can stop a request with an HTTP status. */
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/**
 * Walks the supplier chain from the affected supplier up to its Tier-1 root,
 * checking every link: each parent must exist and be exactly one tier higher
 * (Tier-3 -> Tier-2 -> Tier-1). Returns [affected, ..., root].
 */
async function resolveSupplierChain(tx, supplierId) {
    const chain = [];
    let current = await tx.run(SELECT.one.from('Suppliers').where({ supplier_id: supplierId }));

    if (!current) {
        throw new HttpError(404, `Affected supplier ${supplierId} does not exist.`);
    }

    if (![1, 2, 3].includes(Number(current.tier))) {
        throw new HttpError(422, `Supplier ${supplierId} has an invalid tier (${current.tier}).`);
    }

    chain.push(current);

    while (Number(current.tier) > 1) {
        if (!current.parent_id) {
            throw new HttpError(422, `Supplier chain is incomplete: ${current.supplier_id} (Tier-${current.tier}) has no parent.`);
        }

        const parent = await tx.run(SELECT.one.from('Suppliers').where({ supplier_id: current.parent_id }));

        if (!parent) {
            throw new HttpError(422, `Supplier chain is incomplete: parent ${current.parent_id} of ${current.supplier_id} was not found.`);
        }

        if (Number(parent.tier) !== Number(current.tier) - 1) {
            throw new HttpError(
                422,
                `Supplier chain is inconsistent: ${current.supplier_id} (Tier-${current.tier}) has parent ${parent.supplier_id} (Tier-${parent.tier}).`
            );
        }

        chain.push(parent);
        current = parent;
    }

    return chain;
}

// Database table for messages. The service entity 'Messages' is a read-only
// join (it adds about_supplier), so handlers read and write the table itself.
const MESSAGES_TABLE = 'Messages';

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generates a 10-character ID: prefix letter + 9 random characters (agreed
 * with P2/P3: O + 9 for options, M + 9 for messages). Checks uniqueness.
 */
async function generateId(tx, table, keyField, prefix) {
    for (let attempt = 0; attempt < 5; attempt++) {
        let id = prefix;
        for (let i = 0; i < 9; i++) id += ID_CHARS[randomInt(ID_CHARS.length)];
        const clash = await tx.run(SELECT.one.from(table).columns(keyField).where({ [keyField]: id }));
        if (!clash) return id;
    }
    throw new Error(`Could not generate a unique ${keyField}.`);
}

/**
 * Who is making this request?
 * Name and role come ONLY from the login (req.user). Values sent in the
 * request body (approver_role, approved_by) are never used for identity.
 * The 'anonymous' branch is a defensive fallback: since Batch 2 the service
 * requires a login, so unauthenticated calls are rejected before any handler.
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

export default class MediShieldService extends cds.ApplicationService {

    async init() {
        const {
            Options,
            ApprovalRule,
            Risks,
            Suppliers
        } = this.entities;

        // Second line of defence behind the @requires annotations in
        // medishield-service.cds: a login and a decision role are required
        // for every state-changing action, in every profile.
        this.before(STATE_CHANGING_ACTIONS, (req) => {
            const actor = getActor(req);

            if (!actor.authenticated) {
                return req.reject(401, 'Authentication is required.');
            }

            if (!actor.role) {
                return req.reject(403, 'You are not authorised to perform this action.');
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
            // approver_role / approved_by are DEPRECATED request fields:
            // accepted for backward compatibility but deliberately ignored.
            const { option_id, reason } = req.data;

            const actor = getActor(req);

            if (!option_id) {
                return req.reject(400, 'Option ID is required.');
            }

            // Logged in without a decision role (e.g. viewer)
            if (!actor.authenticated || !actor.role) {
                return req.reject(403, 'You are not authorised to approve recovery options.');
            }

            // Role used for the threshold rule: always the login role
            const effectiveRole = actor.role;

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
            // approver_role / approved_by are DEPRECATED request fields:
            // accepted for backward compatibility but deliberately ignored.
            const { option_id, reason } = req.data;

            const actor = getActor(req);

            if (!option_id || !reason) {
                return req.reject(400, 'Option ID and rejection reason are required.');
            }

            // Logged in without a decision role (e.g. viewer)
            if (!actor.authenticated || !actor.role) {
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
                reason
            } = req.data;
            // approved_by is a DEPRECATED request field: accepted but ignored.

            const actor = getActor(req);

            if (!option_id) {
                return req.reject(400, 'Option ID is required.');
            }

            // Logged in without a decision role (e.g. viewer)
            if (!actor.authenticated || !actor.role) {
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
                if (!OPTION_TYPES.includes(option_type)) {
                    return req.reject(
                        400,
                        `Option type must be one of: ${OPTION_TYPES.join(', ')}.`
                    );
                }
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
                risk_id,
                option_id,
                to_supplier,
                body,
                language,
                body_translated
            } = req.data;
            let { message_id } = req.data;   // optional since Batch 3a

            if (!risk_id || !option_id || !to_supplier || !body) {
                return req.reject(400, 'Risk ID, option ID, supplier ID and body are required.');
            }

            if (body.length > 2000) {
                return req.reject(400, 'Message body exceeds 2000 characters.');
            }

            if (language && !['en', 'hi', 'te'].includes(language)) {
                return req.reject(400, 'Language must be en, hi or te.');
            }

            const tx = cds.tx(req);

            if (message_id) {
                const existing = await tx.run(
                    SELECT.one.from(MESSAGES_TABLE).where({ message_id })
                );

                if (existing) {
                    return req.reject(409, 'Message ID already exists.');
                }
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

            // The message must be linked to a recovery option of the same risk
            // that has not been rejected (decision G).
            const option = await tx.run(
                SELECT.one.from(Options).where({ option_id })
            );

            if (!option) {
                return req.reject(404, 'Recovery option not found.');
            }

            if (option.risk_id !== risk_id) {
                return req.reject(
                    400,
                    `Option ${option_id} belongs to risk ${option.risk_id}, not ${risk_id}.`
                );
            }

            if (option.approval_status === 'rejected') {
                return req.reject(409, 'A message cannot be linked to a rejected option.');
            }

            if (!message_id) {
                message_id = await generateId(tx, MESSAGES_TABLE, 'message_id', 'M');
            }

            await tx.run(
                INSERT.into(MESSAGES_TABLE).entries({
                    message_id,
                    risk_id,
                    option_id,
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
                option_id,
                message_id,
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
                message_id,
                option_id
            };
        });


        // --------------------------------------------------
        // 5a. APPROVE SUPPLIER MESSAGE (Batch 3a)
        // --------------------------------------------------
        this.on('approveMessage', async (req) => {
            const { message_id, reason } = req.data;

            if (!message_id) {
                return req.reject(400, 'Message ID is required.');
            }

            const tx = cds.tx(req);

            const message = await tx.run(
                SELECT.one.from(MESSAGES_TABLE).where({ message_id })
            );

            if (!message) {
                return req.reject(404, 'Message not found.');
            }

            if (message.status !== 'drafted') {
                return req.reject(
                    409,
                    `Only drafted messages can be approved. This message is ${message.status}.`
                );
            }

            // The message's OWN option must be approved (not any option of the risk)
            const option = message.option_id && await tx.run(
                SELECT.one.from(Options).where({ option_id: message.option_id })
            );

            if (!option || option.approval_status !== 'approved') {
                return req.reject(
                    409,
                    `Approve the linked recovery option ${message.option_id || '(none)'} before approving this message.`
                );
            }

            // Conditional update: only if the message is still a draft
            const changed = await tx.run(
                UPDATE(MESSAGES_TABLE)
                    .set({ status: 'approved' })
                    .where({ message_id, status: 'drafted' })
            );

            if (changed !== 1) {
                return req.reject(409, 'This message was changed by another request. Reload and try again.');
            }

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id: message.risk_id,
                option_id: message.option_id,
                message_id,
                action: 'message_approved',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: reason || `Message ${message_id} approved for simulated sending`,
                status: 'approved'
            });

            return {
                success: true,
                status: 'approved',
                message: 'Supplier message approved. It can now be sent (simulated).',
                message_id,
                option_id: message.option_id
            };
        });


        // --------------------------------------------------
        // 5b. REJECT SUPPLIER MESSAGE (Batch 3a)
        // --------------------------------------------------
        this.on('rejectMessage', async (req) => {
            const { message_id, reason } = req.data;

            if (!message_id || !reason || !reason.trim()) {
                return req.reject(400, 'Message ID and rejection reason are required.');
            }

            const tx = cds.tx(req);

            const message = await tx.run(
                SELECT.one.from(MESSAGES_TABLE).where({ message_id })
            );

            if (!message) {
                return req.reject(404, 'Message not found.');
            }

            if (message.status !== 'drafted') {
                return req.reject(
                    409,
                    `Only drafted messages can be rejected. This message is ${message.status}.`
                );
            }

            // Conditional update. A rejected message is final (decision I):
            // a corrected message needs a new draft with a new ID.
            const changed = await tx.run(
                UPDATE(MESSAGES_TABLE)
                    .set({ status: 'rejected' })
                    .where({ message_id, status: 'drafted' })
            );

            if (changed !== 1) {
                return req.reject(409, 'This message was changed by another request. Reload and try again.');
            }

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id: message.risk_id,
                option_id: message.option_id,
                message_id,
                action: 'message_rejected',
                approver_role: actor.role,
                approved_by: actor.name,
                reason: reason.trim(),
                status: 'rejected'
            });

            return {
                success: true,
                status: 'rejected',
                message: 'Supplier message rejected and recorded. Create a new draft to correct it.',
                message_id,
                option_id: message.option_id
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
                SELECT.one.from(MESSAGES_TABLE).where({ message_id })
            );

            if (!message) {
                return req.reject(404, 'Message not found.');
            }

            // Since Batch 3a a message must be approved by a human before sending
            if (message.status === 'drafted') {
                return req.reject(409, 'Approve the message before sending it.');
            }

            if (message.status !== 'approved') {
                return req.reject(
                    409,
                    `Only approved messages can be sent. This message is ${message.status}; duplicate sending is not allowed.`
                );
            }

            // Sending requires the message's OWN linked option to be approved
            // (previously: any approved option of the same risk).
            const option = message.option_id && await tx.run(
                SELECT.one.from(Options).where({ option_id: message.option_id })
            );

            if (!option || option.approval_status !== 'approved') {
                return req.reject(
                    409,
                    `The linked recovery option ${message.option_id || '(none)'} is not approved.`
                );
            }

            // Conditional update: only if the message is still approved (not yet sent)
            const changed = await tx.run(
                UPDATE(MESSAGES_TABLE)
                    .set({ status: 'sent_simulated' })
                    .where({ message_id, status: 'approved' })
            );

            if (changed !== 1) {
                return req.reject(
                    409,
                    'Only approved messages can be sent. Duplicate sending is not allowed.'
                );
            }

            const actor = getActor(req);

            await writeAudit(tx, {
                risk_id: message.risk_id,
                option_id: message.option_id,
                message_id,
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
                message_id,
                option_id: message.option_id
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
                SELECT.one.from(MESSAGES_TABLE).where({ message_id })
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
                UPDATE(MESSAGES_TABLE)
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
                option_id: message.option_id,
                message_id,
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
                message_id,
                option_id: message.option_id
            };
        });

        // --------------------------------------------------
        // 8. ASSESS RISK (Batch 3b: runs P3's impact and option rules)
        // --------------------------------------------------
        this.on('assessRisk', async (req) => {
            const { risk_id } = req.data;

            if (!risk_id) {
                return req.reject(400, 'Risk ID is required.');
            }

            const tx = cds.tx(req);

            try {
                const risk = await tx.run(SELECT.one.from('Risks').where({ risk_id }));

                if (!risk) {
                    return req.reject(404, 'Risk not found.');
                }

                // 1. Supplier chain: affected -> (Tier-2) -> Tier-1 root, fully validated
                const chain = await resolveSupplierChain(tx, risk.affected_supplier);
                const affected = chain[0];
                const root = chain[chain.length - 1];

                if (Number(risk.tier) !== Number(affected.tier)) {
                    throw new HttpError(422, `Risk tier ${risk.tier} does not match supplier ${affected.supplier_id} (Tier-${affected.tier}).`);
                }

                // 2. Stock: the Tier-1 root supplier's material (what we buy and hold)
                const material = root.material;
                const stock = material && await tx.run(SELECT.one.from('Stock').where({ material }));

                if (!stock) {
                    throw new HttpError(422, `No stock data for material '${material}' (Tier-1 supplier ${root.supplier_id}). Assessment not possible.`);
                }

                if (!isNonNegInt(stock.stock_units) || !isNonNegInt(stock.lead_time_days)) {
                    throw new HttpError(422, `Stock data for '${material}' is incomplete or invalid.`);
                }

                if (!Number.isInteger(stock.daily_usage) || stock.daily_usage <= 0) {
                    throw new HttpError(422, `Daily usage for '${material}' must be greater than zero. Days of stock cannot be calculated.`);
                }

                // 3. Declaration (Tier-2/3 only): the Tier-1 root's SUBMITTED declaration
                //    naming the upstream supplier directly below the root (the affected
                //    supplier for Tier-2, its Tier-2 parent for Tier-3) for the same material.
                let declaration = null;

                if (chain.length > 1) {
                    const upstream = chain[chain.length - 2];
                    const submitted = await tx.run(
                        SELECT.from('SupplierDeclarations').where({ tier1_supplier: root.supplier_id, status: 'submitted' })
                    );
                    const matches = submitted.filter((d) =>
                        norm(d.upstream_name) === norm(upstream.name) && norm(d.material) === norm(material)
                    );

                    if (matches.length > 1) {
                        throw new HttpError(
                            422,
                            `More than one submitted declaration matches ${upstream.name} / ${material} (${matches.map((d) => d.declaration_id).join(', ')}). Resolve the duplicate first.`
                        );
                    }

                    declaration = matches[0] || null;
                }

                // 4. Alternate source: another Tier-1 supplier with the same material
                const alternates = await tx.run(
                    SELECT.from('Suppliers').columns('supplier_id').where({ tier: 1, material })
                );
                const hasAlternate = alternates.some((a) => a.supplier_id !== root.supplier_id);

                // 5. P3's calculation (unchanged code)
                const { impact, calc } = p3Rules.calcImpactCore({ risk, stock, declaration });
                const ranked = p3Rules.rankOptionsCore({ risk, impact, calc, stock, declaration, hasAlternate });

                // 6. Validate P3's output before anything is stored
                if (!isNonNegInt(impact.delay_days) || !isNonNegInt(impact.days_of_stock) ||
                    typeof impact.production_at_risk !== 'string' || impact.production_at_risk.length > 100) {
                    throw new HttpError(422, 'The impact calculation produced invalid values. Nothing was stored.');
                }

                if (!Array.isArray(ranked) || ranked.length === 0) {
                    throw new HttpError(422, 'The option ranking produced no options. Nothing was stored.');
                }

                for (const o of ranked) {
                    const cost = Number(o.cost_estimate);
                    if (!OPTION_TYPES.includes(o.type) || !Number.isFinite(cost) || cost < 0 || cost > 9999999999.99 ||
                        !isNonNegInt(o.delay_saved_days) || !Number.isInteger(o.option_rank) || o.option_rank < 1) {
                        throw new HttpError(422, `The option ranking produced an invalid option (${o.type}). Nothing was stored.`);
                    }
                }

                // 7. Reassessment rules: only while every option is pending and no message exists
                const existingMessages = await tx.run(
                    SELECT.from('Messages').columns('message_id').where({ risk_id })
                );

                if (existingMessages.length > 0) {
                    throw new HttpError(409, `Risk ${risk_id} cannot be reassessed: a supplier message already exists for it.`);
                }

                const existingOptions = await tx.run(
                    SELECT.from('Options').columns('option_id', 'approval_status').where({ risk_id })
                );
                const decided = existingOptions.filter((o) => o.approval_status !== 'pending');

                if (decided.length > 0) {
                    throw new HttpError(
                        409,
                        `Risk ${risk_id} cannot be reassessed: option(s) ${decided.map((o) => `${o.option_id} (${o.approval_status})`).join(', ')} already decided or escalated.`
                    );
                }

                const existingImpact = await tx.run(SELECT.one.from('Impacts').where({ risk_id }));

                // 'reassessed' only if this risk was assessed before. The audit trail is
                // the record of previous assessments; replaced seed options or a
                // pre-loaded Impact row alone do not count as an assessment.
                const previousAssessment = await tx.run(
                    SELECT.one.from('AuditLog').columns('audit_id')
                        .where({ risk_id, action: { in: ['risk_assessed', 'risk_reassessed'] } })
                );
                const isReassessment = Boolean(previousAssessment);

                // Replace pending options (conditional: all must still be pending)
                if (existingOptions.length > 0) {
                    const removed = await tx.run(
                        DELETE.from('Options').where({ risk_id, approval_status: 'pending' })
                    );

                    if (removed !== existingOptions.length) {
                        throw new HttpError(409, 'Options of this risk were changed by another request. Reload and try again.');
                    }
                }

                const impactRow = {
                    delay_days: impact.delay_days,
                    days_of_stock: impact.days_of_stock,
                    production_at_risk: impact.production_at_risk
                };

                if (existingImpact) {
                    await tx.run(UPDATE('Impacts').set(impactRow).where({ risk_id }));
                } else {
                    await tx.run(INSERT.into('Impacts').entries({ risk_id, ...impactRow }));
                }

                // Store options with P4-generated IDs (P3's own IDs are ignored)
                const stored = [];
                for (const o of ranked) {
                    const option_id = await generateId(tx, 'Options', 'option_id', 'O');
                    const row = {
                        option_id,
                        risk_id,
                        type: o.type,
                        cost_estimate: o.cost_estimate,
                        delay_saved_days: o.delay_saved_days,
                        option_rank: o.option_rank,
                        approval_status: 'pending'
                    };
                    await tx.run(INSERT.into('Options').entries(row));
                    stored.push(row);
                }

                // Audit (new row; existing audit rows are never changed or deleted)
                const actor = getActor(req);
                const summary =
                    `${isReassessment ? 'Reassessed' : 'Assessed'}: delay ${impact.delay_days}d, stock ${impact.days_of_stock}d; ` +
                    `declaration ${declaration ? declaration.declaration_id : 'none'}; alternate ${hasAlternate ? 'yes' : 'no'}; ` +
                    `options ${stored.map((o) => `${o.option_id}=${o.type}`).join(', ')}` +
                    (existingOptions.length ? `; replaced ${existingOptions.map((o) => o.option_id).join(', ')}` : '');

                await writeAudit(tx, {
                    risk_id,
                    action: isReassessment ? 'risk_reassessed' : 'risk_assessed',
                    approver_role: actor.role,
                    approved_by: actor.name,
                    reason: summary.slice(0, 300),
                    status: 'assessed'
                });

                return {
                    success: true,
                    status: isReassessment ? 'reassessed' : 'assessed',
                    message: `Impact and ${stored.length} ranked options stored (simulated rule-based assessment).`,
                    risk_id,
                    material,
                    declaration_id: declaration ? declaration.declaration_id : null,
                    has_alternate: hasAlternate,
                    delay_days: impact.delay_days,
                    days_of_stock: impact.days_of_stock,
                    production_at_risk: impact.production_at_risk,
                    options: stored.map(({ risk_id: _r, ...o }) => o)
                };
            } catch (e) {
                if (e instanceof HttpError) return req.reject(e.status, e.message);
                throw e;   // database or unexpected errors are not disguised (500, rolled back)
            }
        });


        // --------------------------------------------------
        // 9. GENERATE MESSAGE DRAFT (Batch 3b: P3's rule-based template)
        // --------------------------------------------------
        this.on('generateMessageDraft', async (req) => {
            const { option_id, message_id } = req.data;

            if (!option_id) {
                return req.reject(400, 'Option ID is required.');
            }

            const tx = cds.tx(req);

            try {
                const option = await tx.run(SELECT.one.from('Options').where({ option_id }));

                if (!option) {
                    return req.reject(404, 'Recovery option not found.');
                }

                if (option.approval_status === 'rejected') {
                    return req.reject(409, 'A message cannot be drafted for a rejected option.');
                }

                const risk = await tx.run(SELECT.one.from('Risks').where({ risk_id: option.risk_id }));
                const impact = await tx.run(SELECT.one.from('Impacts').where({ risk_id: option.risk_id }));

                if (!risk) {
                    return req.reject(404, 'Associated risk not found.');
                }

                if (!impact) {
                    return req.reject(409, `Assess risk ${option.risk_id} first (assessRisk) so the draft can state the impact.`);
                }

                const chain = await resolveSupplierChain(tx, risk.affected_supplier);
                const root = chain[chain.length - 1];

                // P3's draft (unchanged code). P4 only supplies the material as input.
                const draft = await p3Draft.draftMessage({
                    risk: { ...risk, material: root.material },
                    impact,
                    tier1: root
                });
                const draftSource = draft._source === 'genai_hub' ? 'genai_hub' : 'template';

                if (typeof draft.body !== 'string' || draft.body.length === 0 || draft.body.length > 2000) {
                    return req.reject(422, 'The generated draft is empty or longer than 2000 characters.');
                }

                // Store it through createMessage, so every createMessage rule applies
                // (Tier-1 routing, option checks, duplicate ID, generated ID, audit).
                const created = await this.send('createMessage', {
                    message_id: message_id || undefined,
                    risk_id: risk.risk_id,
                    option_id,
                    to_supplier: root.supplier_id,
                    body: draft.body,
                    language: 'en'
                });

                return {
                    success: true,
                    status: created.status,
                    message: draftSource === 'template'
                        ? 'Draft created from the rule-based template (not AI). Review it before approval.'
                        : 'Draft created using SAP Generative AI Hub. Review it before approval.',
                    message_id: created.message_id,
                    option_id,
                    to_supplier: root.supplier_id,
                    about_supplier: risk.affected_supplier,
                    draft_source: draftSource
                };
            } catch (e) {
                if (e instanceof HttpError) return req.reject(e.status, e.message);
                throw e;
            }
        });

        return super.init();
    }
}

