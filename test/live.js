// Real Generative AI Hub run on all 5 samples. Needs .env (see .env.example).
import { readFileSync } from 'fs';
import { sense } from '../src/sensing.js';
const samples = JSON.parse(readFileSync(new URL('../samples/samples.json', import.meta.url)));
let fails = 0;
for (const s of samples) {
  const { risk, note } = await sense(s.text, s.source);
  const llmError = note && note.startsWith('LLM error');
  const ok = !llmError && (s.expected ? risk && Object.entries(s.expected).every(([k, v]) => risk[k] === v) : risk === null);
  if (!ok) fails++;
  console.log(ok ? 'PASS' : 'FAIL', s.id, JSON.stringify(risk ?? note));
}
process.exit(fails ? 1 : 0);
