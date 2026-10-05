import type { ExchangeBalance } from "./types";

/**
 * Zero balances share the response with funded ones; only funded assets are
 * useful downstream. The sum is filtering only — the original decimal strings
 * are preserved on the returned objects.
 */
export function hasPositiveBalance(balance: ExchangeBalance): boolean {
  return Number(balance.free) + Number(balance.locked) > 0;
}
