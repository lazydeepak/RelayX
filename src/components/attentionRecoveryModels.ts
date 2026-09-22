import { UIAttentionItem } from '../types/ui.ts';

/**
 * Resolves the argument the recovery button passes to `resolveAmbiguousDelivery`.
 * That API requires a delivery ID (the engine looks the delivery up by ID and
 * throws NOT_FOUND for an assignment ID). Returns '' when the item is not an
 * ambiguous delivery or when no delivery reference is attached, so the caller
 * refuses to fire a resolution with a wrong or empty ID instead of silently
 * resending/marking anything.
 */
export function recoveryDeliveryArgument(item: UIAttentionItem): string {
  return item.type === 'ambiguous_delivery' ? (item.deliveryId ?? '') : '';
}

/**
 * Returns a clear reason when recovery controls must be withheld for an
 * ambiguous-delivery item: the assignment has TWO OR MORE ambiguous
 * deliveries. The service deliberately exposes no delivery ID in that state
 * (it must not pick the first), so the operator has to select or reconcile
 * a delivery explicitly before recovery can act. Returns '' for
 * single-ambiguous or non-delivery items, where existing rules stand.
 */
export function recoveryUnavailabilityReason(item: UIAttentionItem): string {
  if (item.type !== 'ambiguous_delivery') return '';
  const count = item.ambiguousDeliveryCount ?? 0;
  if (count > 1) {
    return `Recovery unavailable: ${count} ambiguous deliveries for this assignment — select or reconcile a delivery explicitly.`;
  }
  return '';
}