import { readFileSync } from 'fs';
import { extractWithLLM } from './llm.js';
import { decide } from './match.js';
import { publishRiskToCap } from './cap-client.js';

const load = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));

export const suppliers = load('../data/suppliers.json');
export const declarations = load('../data/declarations.json');

// extract is injectable so matching can be tested without the LLM.
export async function sense(
  text,
  source,
  extract = extractWithLLM,
  s = suppliers,
  d = declarations
) {
  const facts = await extract(text, s);
  const result = decide(facts, source, s, d);

  // Publish detected risks to CAP only when persistence is enabled.
  if (result.risk) {
    try {
      result.cap = await publishRiskToCap(result.risk);
    } catch (error) {
      result.cap = {
        status: 'error',
        persisted: false,
        error: error.message
      };
    }
  }

  return result;
}