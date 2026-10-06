import type { TokenUsage } from './types.js';

/** USD per million tokens. Anthropic list prices as of 2026-09; update when they change. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** 5-minute cache writes cost 1.25x the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimated cost of the recorded usage, or null for models without a known price (so a
 * missing price never shows up as a misleading $0). Output tokens include thinking tokens.
 */
export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number | null {
  const price = model ? PRICES[model] : undefined;
  if (!price) return null;
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER;
  return cost / 1_000_000;
}
