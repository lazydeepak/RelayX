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