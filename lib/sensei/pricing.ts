/**
 * Gemini and OpenAI paid-tier prices (USD per 1M tokens), from ai.google.dev/gemini-api/docs/pricing,
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
  // OpenAI (openai.com/api/pricing, checked 2026-09-24).
  [/gpt-5\.6-luna/, { input: 1, output: 6 }],
  [/gpt-5\.6-terra/, { input: 2.5, output: 15 }],
  [/gpt-5\.6/, { input: 5, output: 30 }], // Sol
  // Gemini 3.8 Flash at its standard rate (it's half price until 2026-12-31; never under-count).
  [/gemini-3\.8-flash/, { input: 1.5, audioInput: 3, output: 7.5 }],
  [/gemini-3\.1-pro/, { input: 2, output: 12 }], // audio billed at the text rate
  [/gemini-3\.5-flash-lite/, { input: 0.3, output: 2.5 }],
  [/gemini-3\.5-flash/, { input: 1.5, output: 9 }],
  [/gemini-3-flash/, { input: 0.5, audioInput: 1, output: 3 }],
  [/gemini-2\.5-flash-lite/, { input: 0.1, audioInput: 0.3, output: 0.4 }],
  [/gemini-2\.5-flash/, { input: 0.3, audioInput: 1, output: 2.5 }],
  [/gemini-2\.5-pro/, { input: 1.25, output: 10 }],
];

/** Highest known rates (GPT-5.6 Sol), so an unknown model is never under-counted. */
export const FALLBACK_PRICE: Price = { input: 5, output: 30 };

export function priceFor(modelId: string): { price: Price; known: boolean } {
  const hit = PRICES.find(([re]) => re.test(modelId));
  return hit ? { price: hit[1], known: true } : { price: FALLBACK_PRICE, known: false };
}

export function callCost(modelId: string, inputTokens: number, outputTokens: number, audio = false): number {
  const { price } = priceFor(modelId);
  const inRate = audio ? (price.audioInput ?? price.input) : price.input;
  return (inputTokens * inRate + outputTokens * price.output) / 1_000_000;
}
