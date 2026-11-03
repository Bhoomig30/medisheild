import 'dotenv/config';

const DEFAULT_ENDPOINT =
  'http://localhost:4004/odata/v4/medi-shield/createRisk';

export async function publishRiskToCap(risk) {
  const enabled =
    String(process.env.PERSIST_RISKS || 'false').toLowerCase() === 'true';

  if (!enabled) {
    return {
      status: 'disabled',
      persisted: false,
      reason: 'PERSIST_RISKS is not true'
    };
  }

  if (!risk || typeof risk !== 'object' || !risk.risk_id) {
    throw new TypeError('A Risk object with risk_id is required');
  }

  const endpoint =
    process.env.CAP_RISK_ENDPOINT || DEFAULT_ENDPOINT;

  const timeoutMs = Number(
    process.env.CAP_REQUEST_TIMEOUT_MS || 10000
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ risk }),
      signal: controller.signal
    });

    const raw = await response.text();
    let body = {};

    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }

    if (response.status === 409) {
      return {
        status: 'duplicate',
        persisted: false,
        duplicate: true,
        risk_id: risk.risk_id,
        http_status: 409
      };
    }

    if (!response.ok) {
      const error = new Error(
        `CAP createRisk failed: HTTP ${response.status}`
      );
      error.status = response.status;
      throw error;
    }

    if (body.success !== true || body.status !== 'created') {
      throw new Error('CAP did not confirm successful Risk creation');
    }

    return {
      status: 'created',
      persisted: true,
      risk_id: body.risk_id || risk.risk_id,
      http_status: response.status
    };
  } finally {
    clearTimeout(timer);
  }
}