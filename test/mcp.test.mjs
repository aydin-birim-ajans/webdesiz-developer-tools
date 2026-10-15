// MCP stdio test: real child process, raw JSON-RPC. fetch is stubbed inside the child, so no network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'webdesiz.mjs');
const KEY = 'wd_live_' + 'B'.repeat(43);
const STUB = 'data:text/javascript,' + encodeURIComponent(
  "globalThis.fetch=async(u)=>new Response(JSON.stringify({data:[{id:'acc_1'}],meta:{source:'stored_snapshot',nextOffset:null,url:String(u)}}),{status:200,headers:{'content-type':'application/json'}});");

function session(env) {
  const child = spawn(process.execPath, ['--import', STUB, BIN, 'mcp'], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let id = 0; let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const n = ++id; waiters.set(n, resolve); send({ jsonrpc: '2.0', id: n, method, params });
    setTimeout(() => reject(new Error('timeout ' + method + ' ' + stderr)), 8000).unref();
  });
  return { child, send, request, stderr: () => stderr };
}

test('MCP lists three read-only tools and serves a stubbed read', async () => {
  const s = session({ WEBDESIZ_API_KEY: KEY });
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(init.result, JSON.stringify(init));
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await s.request('tools/list', {});
    const tools = list.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['webdesiz_accounts', 'webdesiz_campaigns', 'webdesiz_insights']);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
    }
    const good = await s.request('tools/call', { name: 'webdesiz_accounts', arguments: { limit: 2 } });
    assert.notEqual(good.result.isError, true, JSON.stringify(good));
    assert.equal(good.result.structuredContent.data[0].id, 'acc_1');
    const bad = await s.request('tools/call', { name: 'webdesiz_accounts', arguments: { limit: 500 } });
    assert.ok(bad.result?.isError || bad.error, JSON.stringify(bad));
    assert.doesNotMatch(s.stderr(), /wd_live_/);
  } finally { s.child.kill(); }
});

test('MCP refuses to start without a valid key and never prints the key', () => {
  const r = spawnSync(process.execPath, [BIN, 'mcp'], { env: { PATH: process.env.PATH, WEBDESIZ_API_KEY: 'wd_live_tooshortSECRET' }, input: '', encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WEBDESIZ_API_KEY/);
  assert.doesNotMatch(r.stderr + r.stdout, /SECRET/);
});

test('MCP takes no command arguments (no token or URL flags)', () => {
  const r = spawnSync(process.execPath, [BIN, 'mcp', '--url', 'https://evil'], { env: { PATH: process.env.PATH, WEBDESIZ_API_KEY: KEY }, input: '', encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no command arguments/);
});
