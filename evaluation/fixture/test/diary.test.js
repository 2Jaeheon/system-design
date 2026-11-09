import test from 'node:test';
import assert from 'node:assert/strict';
import { postDiary } from '../src/routes.js';

test('generation failure saves FAILED and returns 503', async () => {
  const writes = [];
  const repo = { create: async data => { writes.push(data); return { id: 7 }; },
    update: async (id, data) => writes.push({ id, ...data }) };
  const provider = { generate: async () => { throw new Error('offline'); } };
  const response = await postDiary({ text: 'example' }, provider, repo);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'GENERATION_FAILED');
  assert.deepEqual(writes.map(x => x.state), ['PENDING', 'FAILED']);
});
