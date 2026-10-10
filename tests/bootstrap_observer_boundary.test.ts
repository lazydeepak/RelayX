import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PlannerObserverClient } from '../src/relay/providers/plannerObserverClient.ts';

it('bootstrap observation scopes exact arms and retains retired boundaries without creating Deliveries', async () => {
  let arms: any[] = [];
  let observations: any[] = [];
  let posted: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/arm') {
      posted = JSON.parse(Buffer.concat(chunks).toString());
      arms.push({ ...posted, armId: 'bootstrap-arm', completed: false });
      res.end(JSON.stringify({ ok: true, armId: 'bootstrap-arm' }));
    } else if (req.url === '/health') {
      res.end(JSON.stringify({ allArms: arms }));
    } else {
      res.end(JSON.stringify({ observations }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const client = new PlannerObserverClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const arm = await client.ensureBootstrapArmed('conversation', 'ingress');
    assert.strictEqual(posted.ingressId, 'ingress');
    assert.strictEqual(posted.deliveryId, undefined, 'a bootstrap arm must not claim a Delivery');
    observations = [
      { state: 'finished', conversationId: 'conversation', armId: 'old-arm', latestCompletedResponse: 'history' },
      { state: 'finished', conversationId: 'other', armId: arm.armId, latestCompletedResponse: 'wrong session' },
    ];
    assert.strictEqual((await client.bootstrapStatus('conversation', arm.armId)).completion, null);
    arms[0].completed = true;
    const reused = await client.ensureBootstrapArmed('conversation', 'ingress');
    assert.strictEqual(reused.armId, arm.armId);
    assert.strictEqual(reused.reused, true, 'retirement must not replace the boundary');
    observations.push({ state: 'finished', conversationId: 'conversation', armId: arm.armId,
      latestCompletedResponse: 'new work', completedTurnKey: 'new-turn', responseHash: 'hash', responseLength: 8 });
    arms = []; // bridge ledger loss cannot change the persisted arm match
    const completion = (await client.bootstrapStatus('conversation', arm.armId)).completion;
    assert.strictEqual(completion?.responseText, 'new work');
    assert.strictEqual(completion?.completedTurnKey, 'new-turn');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
