/**
 * Gemini paid-tier prices (USD per 1M tokens), from ai.google.dev/gemini-api/docs/pricing,
 * checked 2026-09-23. Output includes thinking tokens (the Google provider reports
 * candidates + thoughts as outputTokens). Unknown models are priced at the highest known
 * rate so the budget never under-counts.
 */
export interface Price {
  input: number;
  audioInput?: number;
  output: number;
}

export const PRICES: [RegExp, Price][] = [
  [/gemini-3\.1-pro/, { input: 2, output: 12 }], // audio billed at the text rate
  [/gemini-3\.5-flash-lite/, { input: 0.3, output: 2.5 }],
  [/gemini-3\.5-flash/, { input: 1.5, output: 9 }],
  [/gemini-3-flash/, { input: 0.5, audioInput: 1, output: 3 }],
  [/gemini-2\.5-flash-lite/, { input: 0.1, audioInput: 0.3, output: 0.4 }],
  [/gemini-2\.5-flash/, { input: 0.3, audioInput: 1, output: 2.5 }],
  [/gemini-2\.5-pro/, { input: 1.25, output: 10 }],
];

/** Highest known rates (3.1 Pro, prompts over 200k tokens). */
export const FALLBACK_PRICE: Price = { input: 4, output: 18 };

export function priceFor(modelId: string): { price: Price; known: boolean } {
  const hit = PRICES.find(([re]) => re.test(modelId));
  return hit ? { price: hit[1], known: true } : { price: FALLBACK_PRICE, known: false };
}

export function callCost(modelId: string, inputTokens: number, outputTokens: number, audio = false): number {
  const { price } = priceFor(modelId);
  const inRate = audio ? (price.audioInput ?? price.input) : price.input;
  return (inputTokens * inRate + outputTokens * price.output) / 1_000_000;
}
