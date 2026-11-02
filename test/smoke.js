// Phase 0 check: one real LLM call that returns Risk JSON (uses LLM_PROVIDER from .env).
import 'dotenv/config';
import { readFileSync } from 'fs';
import { sense } from '../src/sensing.js';
const samples = JSON.parse(readFileSync(new URL('../samples/samples.json', import.meta.url)));
const s = samples[0];
console.log('Provider:', process.env.LLM_PROVIDER || 'gemini');
const { risk, note } = await sense(s.text, s.source);
console.log('RISK JSON:', JSON.stringify(risk ?? note, null, 2));
process.exit(risk ? 0 : 1);
