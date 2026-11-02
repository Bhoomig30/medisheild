import { readFileSync } from 'fs';
import { extractWithLLM } from './llm.js';
import { decide } from './match.js';

const load = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
export const suppliers = load('../data/suppliers.json');
export const declarations = load('../data/declarations.json');

// extract is injectable so matching can be tested without the LLM
export async function sense(text, source, extract = extractWithLLM, s = suppliers, d = declarations) {
  const facts = await extract(text, s);
  return decide(facts, source, s, d);
}
