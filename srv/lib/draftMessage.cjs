function draftMessage({ risk, impact, tier1, message_id }) {

    const supplierName = tier1.name || "Supplier";
    const event = risk.event || "reported disruption";

    let body;

    // Case 1: Direct Tier-1 supplier disruption
    if (Number(risk.tier) === 1) {

        body = `
Dear ${supplierName},

We understand that there is a supply disruption:

${event}.

Our available stock covers ${impact.days_of_stock} days,
while the expected delay is ${impact.delay_days} days.

Kindly confirm:

1. The revised expected delivery date.
2. Whether partial shipment is possible.
3. Any alternative arrangements available.

Your prompt response will help us plan our production.

Regards,
Procurement Team
`;

    } else {

        // Case 2: Upstream Tier-2 or Tier-3 disruption
        body = `
Dear ${supplierName},

We have identified an upstream supply disruption:

${event}.

Our available stock covers ${impact.days_of_stock} days,
and the expected disruption period is ${impact.delay_days} days.

Kindly confirm:

1. Whether this disruption affects your supply to us.
2. The expected impact on delivery.
3. Whether an alternative source or backup arrangement
   is available.

Please share an updated supply status at the earliest.

Regards,
Procurement Team
`;
    }

    return {
        message_id: message_id,
        risk_id: risk.risk_id,
        to_supplier: tier1.supplier_id,
        body: `[SIMULATED DRAFT - TEMPLATE, NOT AI] ${body.trim()}`,
        language: "en",
        body_translated: null,
        status: "drafted",
        reply_text: null,
        reply_timestamp: null
    };
}

module.exports = { draftMessage };