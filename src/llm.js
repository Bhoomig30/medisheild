import 'dotenv/config';
import { buildMessages } from './prompt.js';

// Provider switch: LLM_PROVIDER=gemini (default, works with a free Google AI Studio key)
//                  LLM_PROVIDER=sap    (SAP Generative AI Hub via AI Core, if access arrives later)
const provider = () => (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

export function parseFacts(raw) {
  const clean = String(raw).replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  return JSON.parse(start >= 0 ? clean.slice(start, end + 1) : clean);
}

// ---------- Gemini (REST, no SDK needed) ----------
export async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');
  if (!model) throw new Error('GEMINI_MODEL not set in .env');
  const system = messages.find(m => m.role === 'system')?.content || '';
  const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no text (blocked or empty response)');
  return text;
}

// ---------- SAP Generative AI Hub (optional) ----------
let sapClient;
async function callSap(messages) {
  if (!sapClient) {
    if (!process.env.GENAI_MODEL) throw new Error('GENAI_MODEL not set in .env');
    const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
    sapClient = new OrchestrationClient({ llm: { model_name: process.env.GENAI_MODEL } });
  }
  const res = await sapClient.chatCompletion({ messages });
  return res.getContent();
}

export async function callLLM(messages) {
  return provider() === 'sap' ? callSap(messages) : callGemini(messages);
}

export async function extractWithLLM(text, suppliers) {
  const regions = [...new Set(suppliers.map(s => s.region))];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return parseFacts(await callLLM(buildMessages(text, regions)));
    } catch (e) { lastErr = e; }
  }
  return { is_disruption: false, error: String(lastErr?.message || lastErr) };
}
