export function buildMessages(text, regions) {
  const system = `You extract facts from supply-chain news or supplier notices. Do NOT judge which supplier is affected.
Reply with ONE JSON object only, no markdown, with keys:
is_disruption (boolean: true only if the text describes a supply disruption, delay, closure, tariff or ban),
event (short summary, max 150 chars, or null),
region (the region of the event; if it maps to one of the KNOWN REGIONS use that exact spelling, e.g. a port in Ningbo -> Zhejiang; else the place named; or null),
supplier_name (a company name exactly as written in the text, or null),
material_hint (the material or product mentioned, or null),
delay_days (integer or null).
If the text is unrelated or too vague, set is_disruption false and the rest null.`;
  const user = `KNOWN REGIONS: ${regions.join(', ')}\n\nTEXT:\n${text}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
