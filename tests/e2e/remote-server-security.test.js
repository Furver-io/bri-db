/**
 * @file Security stories for the remote WebSocket server (`docker/server`).
 *
 * Domain context: the server exposes the whole database over WebSocket RPC. These
 * stories are what an operator and a client experience: the server refuses to start
 * in an unsafe shape, listens on loopback by default, and when a token is required it
 * turns away connections without it, with a foreign `Host`, or from a foreign web page
 * (`Origin`) before any RPC runs.
 *
 * Technical context: the access rules live in `docker/server/security.js` (pure, unit
 * tested below for the branch coverage gate). The end-to-end stories start the real
 * server under Bun on a loopback port and talk to it with real HTTP upgrades and the
 * public client (`createRemoteDB(url, { token })`); they are skipped, loudly, when `bun`
 * is not installed (the published CI image has none).
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRemoteDB } from '../../index.js';
import {
  authorizeUpgrade,
  isLoopbackHost,
  loadSecurityConfig
} from '../../docker/server/security.js';
import {
  offeredProtocols,
  tokenFromProtocols,
  tokenSubprotocols
} from '../../remote/auth-protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'correct-horse-battery-staple';
const hasBun = spawnSync('bun', ['--version']).status === 0;
const bunDescribe = hasBun ? describe : describe.skip;
if (!hasBun) console.warn('remote-server-security: bun not found, end-to-end server stories skipped');

/**
 * Header lookup shaped like `Headers`, for the pure access rules.
 * @param {Record<string, string>} values - Header values by lower-case name
 * @returns {{get: function(string): (string|null)}} Headers-like object
 */
const headers = (values) => ({ get: (name) => values[name] ?? null });

describe('An operator starts the server', () => {
  test('with no settings it binds loopback only and needs no token', () => {
    const config = loadSecurityConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.token).toBeNull();
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(config.allowedOrigins).toEqual([]);
  });

  test.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'binding %s is loopback',
    (host) => expect(isLoopbackHost(host)).toBe(true)
  );

  test.each(['0.0.0.0', '192.168.1.5', '::', 'example.com', '127.0.0'])(
    'binding %s is not loopback',
    (host) => expect(isLoopbackHost(host)).toBe(false)
  );

  test('the server refuses to listen beyond loopback without a token', () => {
    expect(() => loadSecurityConfig({ HOST: '0.0.0.0' })).toThrow(/Refusing to listen on 0\.0\.0\.0 without AUTH_TOKEN/);
  });

  test('AUTH_REQUIRED=true without a token is refused, even on loopback', () => {
    expect(() => loadSecurityConfig({ AUTH_REQUIRED: 'true' })).toThrow(/AUTH_REQUIRED=true needs AUTH_TOKEN/);
  });

  test('a mistyped AUTH_REQUIRED is refused rather than read as false', () => {
    expect(() => loadSecurityConfig({ AUTH_REQUIRED: 'yes' })).toThrow(/AUTH_REQUIRED must be "true" or "false"/);
  });

  test('a short token is refused', () => {
    expect(() => loadSecurityConfig({ AUTH_TOKEN: 'secret' })).toThrow(/at least 16 characters/);
  });

  test('beyond loopback with a token it starts and checks Host only when told to', () => {
    const open = loadSecurityConfig({ HOST: '0.0.0.0', AUTH_TOKEN: TOKEN });
    expect(open.token).toBe(TOKEN);
    expect(open.allowedHosts).toBeNull();
    const pinned = loadSecurityConfig({
      HOST: '0.0.0.0',
      AUTH_TOKEN: TOKEN,
      AUTH_REQUIRED: 'true',
      ALLOWED_HOSTS: ' DB.example.com:3000, [::1]:3000 ',
      ALLOWED_ORIGINS: 'https://app.example.com/, HTTPS://admin.example.com'
    });
    expect(pinned.allowedHosts).toEqual(['db.example.com', '[::1]']);
    expect(pinned.allowedOrigins).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });
});

describe('A connection arrives at the upgrade', () => {
  const open = loadSecurityConfig({});
  const guarded = loadSecurityConfig({ HOST: '0.0.0.0', AUTH_TOKEN: TOKEN, ALLOWED_ORIGINS: 'https://app.example.com' });
  const [, tokenProtocol] = tokenSubprotocols(TOKEN);

  test('a local client with no Origin is accepted and offered the bri protocol', () => {
    expect(authorizeUpgrade(headers({ host: 'localhost:3000', 'sec-websocket-protocol': 'bri' }), open))
      .toEqual({ ok: true, protocol: 'bri' });
    expect(authorizeUpgrade(headers({ host: '127.0.0.1:3000' }), open)).toEqual({ ok: true, protocol: null });
    expect(authorizeUpgrade(headers({ host: '[::1]:3000' }), open).ok).toBe(true);
  });

  test('a foreign or missing Host is refused with 403 (DNS rebinding)', () => {
    expect(authorizeUpgrade(headers({ host: 'evil.example:3000' }), open))
      .toEqual({ ok: false, status: 403, reason: 'Host not allowed' });
    expect(authorizeUpgrade(headers({}), open).status).toBe(403);
  });

  test('a web page from another site is refused with 403, whatever its token', () => {
    expect(authorizeUpgrade(headers({ host: 'localhost:3000', origin: 'http://evil.example' }), open))
      .toEqual({ ok: false, status: 403, reason: 'Origin not allowed' });
    expect(authorizeUpgrade(headers({ host: 'localhost:3000', origin: 'null' }), open).status).toBe(403);
    expect(authorizeUpgrade(headers({ origin: 'https://other.example', 'sec-websocket-protocol': `bri, ${tokenProtocol}` }), guarded).status)
      .toBe(403);
  });

  test('a listed Origin passes (case and trailing slash do not matter)', () => {
    const verdict = authorizeUpgrade(
      headers({ origin: 'HTTPS://App.example.com/', 'sec-websocket-protocol': `bri, ${tokenProtocol}` }),
      guarded
    );
    expect(verdict).toEqual({ ok: true, protocol: 'bri' });
  });

  test('without the token, or with a wrong one, the answer is 401', () => {
    expect(authorizeUpgrade(headers({}), guarded)).toEqual({ ok: false, status: 401, reason: 'Unauthorized' });
    const wrong = tokenSubprotocols('wrong-wrong-wrong-wrong')[1];
    expect(authorizeUpgrade(headers({ 'sec-websocket-protocol': `bri, ${wrong}` }), guarded).status).toBe(401);
    expect(authorizeUpgrade(headers({ authorization: 'Bearer nope' }), guarded).status).toBe(401);
    expect(authorizeUpgrade(headers({ authorization: `Basic ${TOKEN}` }), guarded).status).toBe(401);
    expect(authorizeUpgrade(headers({ 'sec-websocket-protocol': 'bri, bri-token.***' }), guarded).status).toBe(401);
  });

  test('the token is accepted from the sub-protocol or a Bearer header', () => {
    expect(authorizeUpgrade(headers({ 'sec-websocket-protocol': `bri, ${tokenProtocol}` }), guarded).ok).toBe(true);
    expect(authorizeUpgrade(headers({ authorization: `Bearer ${TOKEN}` }), guarded))
      .toEqual({ ok: true, protocol: null });
  });
});

describe('The token travels as a WebSocket sub-protocol', () => {
  test('it round-trips, including non-ASCII text, and is not the plain token', () => {
    for (const token of [TOKEN, 'pässwörd-日本語-🚀', 'a'.repeat(300)]) {
      const protocols = tokenSubprotocols(token);
      expect(protocols[0]).toBe('bri');
      expect(protocols[1]).toMatch(/^bri-token\.[A-Za-z0-9_-]+$/);
      expect(tokenFromProtocols(protocols)).toBe(token);
    }
  });

  test('only a non-empty string is a token', () => {
    for (const bad of ['', undefined, null, 5, {}]) {
      expect(() => tokenSubprotocols(bad)).toThrow(TypeError);
    }
  });

  test('the offered list is read from the header and bad tokens read as absent', () => {
    expect(offeredProtocols(' bri , bri-token.abc ,, ')).toEqual(['bri', 'bri-token.abc']);
    expect(offeredProtocols(null)).toEqual([]);
    expect(offeredProtocols(undefined)).toEqual([]);
    expect(tokenFromProtocols(['bri'])).toBeNull();
    expect(tokenFromProtocols(['bri-token.not valid!'])).toBeNull();
    expect(tokenFromProtocols(['bri-token.a'])).toBeNull();
    expect(tokenFromProtocols(['bri-token._w'])).toBeNull();
  });
});

/**
 * Start the real server under Bun on a free loopback-friendly port.
 * @param {Record<string, string>} env - Server settings
 * @returns {Promise<{port: number, host: string, output: function(): string, exited: Promise<number>, stop: function(): Promise<void>}>} Handle
 */
async function startServer(env) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bri-remote-security-'));
  const child = spawn('bun', ['docker/server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, MAX_MEMORY_MB: '64', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let text = '';
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  const listening = new Promise((resolve) => {
    const onData = (chunk) => {
      text += chunk;
      const match = /Listening on http:\/\/(\S+):(\d+)/.exec(text);
      if (match) resolve({ host: match[1], port: Number(match[2]) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { text += chunk; });
    exited.then(() => resolve(null));
  });
  const where = await listening;
  return {
    ...(where ?? { host: '', port: 0 }),
    output: () => text,
    exited,
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * Attempt a WebSocket upgrade with raw HTTP so every header is under test control.
 * @param {number} port - Server port
 * @param {Record<string, string>} extra - Request headers (override the defaults)
 * @returns {Promise<{status: number, protocol: string|undefined}>} Handshake outcome
 */
function upgrade(port, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/ape',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...extra
      }
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, protocol: res.headers['sec-websocket-protocol'] });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode, protocol: res.headers['sec-websocket-protocol'] });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * First non-internal IPv4 address of this machine, when it has one.
 * @returns {string|undefined} Address
 */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) if (nic.family === 'IPv4' && !nic.internal) return nic.address;
  }
  return undefined;
}

/**
 * Try a plain TCP connect.
 * @param {number} port - Port
 * @param {string} host - Address
 * @returns {Promise<string>} `connected`, the error code, or `timeout` when nothing answers in 2 s
 */
function tcp(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => { socket.destroy(); resolve('connected'); });
    socket.setTimeout(2000, () => { socket.destroy(); resolve('timeout'); });
    socket.on('error', (err) => resolve(err.code));
  });
}

const BEARER = { Authorization: `Bearer ${TOKEN}` };
const WITH_TOKEN = { 'Sec-WebSocket-Protocol': `bri, ${tokenSubprotocols(TOKEN)[1]}` };

bunDescribe('The real server, started with no settings (local development)', () => {
  let server;
  beforeAll(async () => { server = await startServer({}); }, 30000);
  afterAll(async () => { await server.stop(); });

  test('listens on loopback only and says so', async () => {
    expect(server.host).toBe('127.0.0.1');
    const lan = lanAddress();
    if (lan) expect(await tcp(server.port, lan)).not.toBe('connected');
  });

  test('a local client with no token still works end to end', async () => {
    const db = await createRemoteDB(`ws://127.0.0.1:${server.port}`);
    const added = await db.add.pal({ name: 'Ada' });
    expect((await db.get.pal(added.$ID)).name).toBe('Ada');
    await db.disconnect();
  });

  test('a web page on another site is refused before any RPC', async () => {
    expect((await upgrade(server.port, { Origin: 'http://evil.example' })).status).toBe(403);
  });

  test('a request for another Host (DNS rebinding) is refused', async () => {
    expect((await upgrade(server.port, { Host: 'evil.example' })).status).toBe(403);
  });

  test('the health check stays open and carries nothing private', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/ape/ping`);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['ok', 'timestamp']);
  });
});

bunDescribe('The real server, started with a token on a non-loopback bind', () => {
  let server;
  beforeAll(async () => {
    server = await startServer({
      HOST: '0.0.0.0',
      AUTH_TOKEN: TOKEN,
      AUTH_REQUIRED: 'true',
      ALLOWED_ORIGINS: 'https://app.example.com'
    });
  }, 30000);
  afterAll(async () => { await server.stop(); });

  test('a client with no token gets 401 and never reaches the database', async () => {
    const refused = await upgrade(server.port);
    expect(refused.status).toBe(401);
    await expect(createRemoteDB(`ws://127.0.0.1:${server.port}`, { timeout: 2000 })).rejects.toThrow();
  });

  test('a wrong token gets 401', async () => {
    const wrong = tokenSubprotocols('wrong-wrong-wrong-wrong')[1];
    expect((await upgrade(server.port, { 'Sec-WebSocket-Protocol': `bri, ${wrong}` })).status).toBe(401);
    await expect(
      createRemoteDB(`ws://127.0.0.1:${server.port}`, { token: 'wrong-wrong-wrong-wrong', timeout: 2000 })
    ).rejects.toThrow();
  });

  test('the right token connects, never comes back to the client, and the full RPC works', async () => {
    const accepted = await upgrade(server.port, WITH_TOKEN);
    expect(accepted).toEqual({ status: 101, protocol: 'bri' });
    expect((await upgrade(server.port, BEARER)).status).toBe(101);

    const db = await createRemoteDB(`ws://127.0.0.1:${server.port}`, { token: TOKEN });
    const added = await db.add.pal({ name: 'Grace' });
    expect((await db.get.pal(added.$ID)).name).toBe('Grace');
    await db.disconnect();
  });

  test('a listed web page needs the token too; an unlisted one is refused first', async () => {
    expect((await upgrade(server.port, { ...WITH_TOKEN, Origin: 'https://app.example.com' })).status).toBe(101);
    expect((await upgrade(server.port, { Origin: 'https://app.example.com' })).status).toBe(401);
    expect((await upgrade(server.port, { ...WITH_TOKEN, Origin: 'https://evil.example' })).status).toBe(403);
  });
});

bunDescribe('The real server refuses to start unsafely', () => {
  test.each([
    ['a non-loopback bind with no token', { HOST: '0.0.0.0' }, /Refusing to listen on 0\.0\.0\.0 without AUTH_TOKEN/],
    ['AUTH_REQUIRED=true with no token', { AUTH_REQUIRED: 'true' }, /AUTH_REQUIRED=true needs AUTH_TOKEN/],
    ['a short token', { AUTH_TOKEN: 'short' }, /at least 16 characters/]
  ])('%s', async (_name, env, message) => {
    const server = await startServer(env);
    try {
      expect(server.port).toBe(0);
      expect(await server.exited).not.toBe(0);
      expect(server.output()).toMatch(message);
      expect(server.output()).not.toMatch(/Listening/);
    } finally {
      await server.stop();
    }
  }, 30000);
});
