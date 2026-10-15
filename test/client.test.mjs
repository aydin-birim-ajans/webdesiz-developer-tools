// Client safety tests. The network is never used: globalThis.fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readResource, validateKey, querySchema } from '../lib/client.mjs';

const KEY = 'wd_live_' + 'A'.repeat(43);
const realFetch = globalThis.fetch;
let calls = [];
function stub(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
}
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status: init.status ?? 200, headers: { 'content-type': init.type ?? 'application/json', ...(init.headers || {}) },
});
const ok = { data: [{ id: 'acc_1', accountName: 'Shop' }], meta: { source: 'stored_snapshot', nextOffset: null } };
test.afterEach(() => { globalThis.fetch = realFetch; });

test('key format is enforced', () => {
  assert.equal(validateKey(KEY), KEY);
  for (const bad of [undefined, '', 'wd_live_short', 'sk_live_' + 'A'.repeat(43), KEY + 'x']) assert.throws(() => validateKey(bad), /WEBDESIZ_API_KEY/);
});

test('query schema rejects out-of-range and unknown input', () => {
  assert.ok(querySchema.safeParse({ limit: 100, offset: 10000, accountId: 'a_b-1', from: '2026-10-01', to: '2026-10-04' }).success);
  for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: 10001 }, { accountId: '../x' }, { from: '01-10-2026' }, { url: 'https://evil' }]) {
    assert.equal(querySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('reads go only to the fixed webdesiz.com endpoint with a Bearer header and no redirects', async () => {
  stub(() => json(ok));
  const r = await readResource('campaigns', { accountId: 'acc_1', limit: 5 }, KEY);
  assert.deepEqual(r, ok);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://webdesiz.com/api/v1/developer/campaigns');
  assert.equal(u.searchParams.get('accountId'), 'acc_1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  assert.match(calls[0].init.headers['User-Agent'], /^webdesiz-cli\//);
});

test('only the three read-only resources exist', async () => {
  stub(() => json(ok));
  await assert.rejects(readResource('keys', {}, KEY), /Unknown read-only resource/);
  assert.equal(calls.length, 0);
});

test('HTTP errors, wrong content type, bad schema and oversized bodies are rejected', async () => {
  stub(() => json({ message: 'nope' }, { status: 401 }));
  await assert.rejects(readResource('accounts', {}, KEY), /HTTP 401/);
  stub(() => json('<html>', { type: 'text/html' }));
  await assert.rejects(readResource('accounts', {}, KEY), /Unexpected API response type/);
  stub(() => json({ data: [], meta: { source: 'live' } }));
  await assert.rejects(readResource('accounts', {}, KEY), /Unexpected API response schema/);
  stub(() => json('x'.repeat(10), { headers: { 'content-length': String(3 * 1024 * 1024) } }));
  await assert.rejects(readResource('accounts', {}, KEY), /too large/);
});

test('a response that echoes the key is refused', async () => {
  stub(() => json({ data: [{ note: KEY }], meta: { source: 'stored_snapshot' } }));
  await assert.rejects(readResource('accounts', {}, KEY), /Unexpected secret/);
});
