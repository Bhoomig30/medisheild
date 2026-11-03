
const norm = s =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['the', 'and', 'of', 'for', 'input']);

const tokens = s =>
  norm(s)
    .split(' ')
    .filter(t => t && !STOP.has(t))
    .map(t => t.replace(/s$/, ''));

const RANK = { low: 1, medium: 2, high: 3 };

const cut = (s, n) =>
  (s == null ? s : String(s).slice(0, n));

function materialOverlap(hint, material) {
  const a = new Set(tokens(hint));
  return tokens(material).some(t => a.has(t));
}

let counter = 0;

function newRiskId() {
  // Max 10 characters (NVARCHAR(10)); starts with R.
  counter = (counter + 1) % 36;

  return (
    'R' +
    Date.now().toString(36).toUpperCase().slice(-7) +
    counter.toString(36).toUpperCase()
  ).slice(0, 10);
}

function makeRisk(facts, source, f) {
  return {
    risk_id: newRiskId(),
    event: cut(facts.event, 300),
    region: cut(f.region, 60),
    affected_supplier: f.supplier.supplier_id,
    tier: f.supplier.tier,
    confidence: f.confidence,
    source: cut(source, 200),
    reason: cut(f.reason, 300),
    evidence_type: f.evidence_type,
    matched_on: cut(f.matched_on, 100)
  };
}

export function decide(facts, source, suppliers, declarations) {
  if (
    !facts ||
    !facts.is_disruption ||
    (!facts.region && !facts.supplier_name)
  ) {
    return {
      risk: null,
      note: facts?.error
        ? 'LLM error: ' + facts.error
        : 'No supply disruption detected or text too vague'
    };
  }

  if (!facts.event) {
    facts = {
      ...facts,
      event:
        'Disruption reported (' +
        (facts.region || facts.supplier_name) +
        ')'
    };
  }

  const byName = n =>
    suppliers.find(s => norm(s.name) === norm(n));

  const nameHit =
    facts.supplier_name &&
    norm(facts.supplier_name) &&
    suppliers.find(
      s =>
        norm(s.name).includes(norm(facts.supplier_name)) ||
        norm(facts.supplier_name).includes(norm(s.name))
    );

  const submitted = declarations.filter(
    d => d.status === 'submitted'
  );

  // 1. Tier-1 supplier named directly.
  if (nameHit && nameHit.tier === 1) {
    const declaredSource =
      /(?:supplier|vendor).*(?:email|notice|declaration|submission)|(?:email|notice|declaration|submission).*(?:supplier|vendor)/i
        .test(source || '');

    return {
      risk: makeRisk(facts, source, {
        supplier: nameHit,
        region: nameHit.region,
        confidence: 'high',
        evidence_type: declaredSource ? 'declared' : 'news',
        matched_on: 'supplier name',
        reason: declaredSource
          ? `Direct notice from Tier-1 supplier ${nameHit.name}`
          : `News identifies Tier-1 supplier ${nameHit.name} directly`
      })
    };
  }

  // 2. Match submitted declarations by region and material.
  const region = facts.region;

  const regionDecls = region
    ? submitted.filter(
        d => norm(d.upstream_region) === norm(region)
      )
    : [];

  const matchingDecls = facts.material_hint
    ? regionDecls.filter(
        d =>
          d.material &&
          materialOverlap(facts.material_hint, d.material)
      )
    : regionDecls;

  // Only use a declaration when exactly one match exists.
  const decl =
    matchingDecls.length === 1
      ? matchingDecls[0]
      : null;

  if (decl) {
    const up = byName(decl.upstream_name);

    const t1 = suppliers.find(
      s => s.supplier_id === decl.tier1_supplier
    );

    const supplier = up || {
      supplier_id: decl.tier1_supplier,
      tier: 2
    };

    return {
      risk: makeRisk(facts, source, {
        supplier,
        region,
        confidence: 'high',
        evidence_type: 'declared',
        matched_on:
          `declaration ${decl.declaration_id}: upstream_region=${decl.upstream_region}`,
        reason:
          `${t1?.name || decl.tier1_supplier} declared ` +
          `${decl.upstream_name} in ${decl.upstream_region} ` +
          `as upstream supplier (${decl.share_percent ?? '?'}% share)`
      })
    };
  }

  // 3. Named Tier-2/Tier-3 supplier without a declaration.
  if (nameHit) {
    return {
      risk: makeRisk(facts, source, {
        supplier: nameHit,
        region: nameHit.region,
        confidence: 'medium',
        evidence_type: 'news',
        matched_on: 'supplier name',
        reason:
          `Notice names ${nameHit.name} (Tier-${nameHit.tier}); ` +
          'no declaration confirms the link'
      })
    };
  }

  // 4. Infer supplier by region and material.
  // Inferred evidence is never high confidence.
  const candidates = region
    ? suppliers.filter(
        s => norm(s.region) === norm(region)
      )
    : [];

  const scored = candidates
    .map(s => {
      const mat =
        facts.material_hint &&
        materialOverlap(facts.material_hint, s.material);

      return {
        supplier: s,
        confidence: mat ? 'medium' : 'low',
        materialMatch: Boolean(mat)
      };
    })
    .sort(
      (a, b) =>
        RANK[b.confidence] - RANK[a.confidence] ||
        a.supplier.tier - b.supplier.tier
    );

  if (scored.length) {
    const best = scored[0];

    // Avoid selecting arbitrarily when multiple candidates
    // have the same confidence and tier.
    const equallyRanked = scored.filter(
      item =>
        item.confidence === best.confidence &&
        item.supplier.tier === best.supplier.tier
    );

    if (equallyRanked.length > 1) {
      return {
        risk: null,
        note:
          `Ambiguous supplier match in region "${region}". ` +
          'Multiple suppliers have the same matching score.'
      };
    }

    const { supplier, confidence, materialMatch } = best;

    return {
      risk: makeRisk(facts, source, {
        supplier,
        region,
        confidence,
        evidence_type: 'inferred',
        matched_on: materialMatch
          ? `region=${region}, material=${supplier.material}`
          : `region=${region}`,
        reason:
          `Inferred: ${supplier.name} (Tier-${supplier.tier}) is in ${region}` +
          (
            materialMatch
              ? ' and handles a matching material'
              : '; material not confirmed'
          ) +
          '; no declaration'
      })
    };
  }

  return {
    risk: null,
    note: `No supplier matched region "${region}"`
  };
}
