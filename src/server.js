// Local HTTP wrapper so P4 (or anyone) can test the Sensing Agent: POST /sense
import http from 'node:http';
import 'dotenv/config';
import { sense } from './sensing.js';
import { insertRisk, loadContext, makeExecutor } from './hana.js';

export function createServer({ extract, exec } = {}) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, agent: 'sensing', simulated: true });
      if (req.method === 'POST' && req.url === '/sense') {
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 100000) return send(413, { error: 'Body too large' }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Body must be JSON' }); }
        if (typeof body.text !== 'string' || !body.text.trim()) return send(400, { error: 'Field "text" is required' });
        const source = typeof body.source === 'string' && body.source ? body.source : 'unspecified (simulated)';
        let ctx = {};
        const useDb = process.env.USE_DB === 'true';
        let db = exec;
        if ((useDb || process.env.PERSIST_RISKS === 'true') && !db) db = await makeExecutor();
        if (useDb) ctx = await loadContext(db);
        const { risk, note } = await sense(body.text, source, extract, ctx.suppliers, ctx.declarations);
        let persisted = false;
        if (risk && process.env.PERSIST_RISKS === 'true') { await insertRisk(risk, db); persisted = true; }
        return send(200, { risk, note: note || null, persisted });
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      send(/already exists/.test(e.message) ? 409 : 500, { error: String(e.message || e) });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.P1_PORT || 3001);
  createServer().listen(port, () => console.log(`Sensing Agent on http://localhost:${port} (POST /sense)`));
}
