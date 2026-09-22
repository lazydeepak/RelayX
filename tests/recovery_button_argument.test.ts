/**
 * Focused regression for the recovery button's wrong-ID argument.
 *
 * The recovery button must pass the AMBIGUOUS DELIVERY's ID to
 * resolveAmbiguousDelivery (engine looks the delivery up by ID and throws
 * NOT_FOUND for an assignment ID). Reported case: the button previously
 * forwarded the assignment ID `asgn_muc5v0fi_bbz87ycx` instead of the
 * delivery ID `deliv_muc5v0fm_qmmpn5t8`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { recoveryDeliveryArgument } from '../src/components/attentionRecoveryModels.ts';
import type { UIAttentionItem } from '../src/types/ui.ts';

const reportedAmbiguousItem: UIAttentionItem = {
  id: 'att_item_1',
  pairId: 'pair_mubf4vj9_36l1m02t',
  assignmentId: 'asgn_muc5v0fi_bbz87ycx',
  deliveryId: 'deliv_muc5v0fm_qmmpn5t8',
  severity: 'critical',
  status: 'open',
  type: 'ambiguous_delivery',
  title: 'Ambiguous Delivery Pending Resolution',
  message: 'Delivery deliv_muc5v0fm_qmmpn5t8 is ambiguous. Operator intervention or recovery is required.',
  suggestedAction: 'Inspect worker composer or window, reconcile state, and either confirm delivery or reset attempt.',
  suggestedTier: 'tier_1_deterministic',
  createdAt: Date.now(),
};

describe('recovery button argument (assignment vs delivery ID)', () => {
  it('passes the ambiguous delivery ID, never the assignment ID', () => {
    const arg = recoveryDeliveryArgument(reportedAmbiguousItem);

    // Passes with the delivery ID...
    assert.strictEqual(arg, 'deliv_muc5v0fm_qmmpn5t8');
    // ...and would fail with the assignment ID.
    assert.notStrictEqual(arg, 'asgn_muc5v0fi_bbz87ycx');
  });

  it('yields an empty argument when the delivery reference is missing (no silent API call)', () => {
    const { deliveryId: _dropped, ...withoutDelivery } = reportedAmbiguousItem;
    assert.strictEqual(recoveryDeliveryArgument(withoutDelivery as UIAttentionItem), '');
  });
});