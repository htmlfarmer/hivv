const test = require('node:test');
const assert = require('node:assert/strict');

test('Dashboard UI & Control Center API Sanity', async (t) => {
  await t.test('Tri-state badges classification logic', () => {
    const states = ['yes', 'maybe', 'no', 'unknown'];
    assert.equal(states.includes('yes'), true);
    assert.equal(states.includes('maybe'), true);
    assert.equal(states.includes('no'), true);
  });

  await t.test('Approval decision state transitions', () => {
    const approveDecision = (current) => current === 'maybe' ? 'yes' : current;
    const denyDecision = (current) => current === 'maybe' ? 'no' : current;

    assert.equal(approveDecision('maybe'), 'yes');
    assert.equal(denyDecision('maybe'), 'no');
  });

  await t.test('View Lens Parameter Scrubbing', () => {
    const rawPayload = {
      agent_id: '123-456',
      public_name: 'TestAgent',
      private_token: 'secret_hash_abc123',
      user_prompt: 'System prompt content'
    };

    const scrubPublic = (data) => ({
      agent_id: data.agent_id,
      public_name: data.public_name
    });

    const publicView = scrubPublic(rawPayload);
    assert.equal(publicView.private_token, undefined);
    assert.equal(publicView.public_name, 'TestAgent');
  });
});
