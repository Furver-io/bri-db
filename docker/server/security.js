/**
 * @file Access control for the BRI WebSocket RPC server: who may connect.
 *
 * Domain context: the RPC surface (`get`/`add`/`set`/`del`/`sub`/`txn`) is the whole
 * database. Anyone who can open a WebSocket to it can read and rewrite every document,
 * and a web page in a browser on the same machine can open one too. This module decides
 * at the HTTP upgrade, before any RPC exists:
 *
 * 1. the server only starts in a safe shape (loopback, or non-loopback with a token);
 * 2. the `Host` header names this server (stops DNS rebinding to a loopback server);
 * 3. a browser `Origin`, when present, is on an explicit list (stops cross-site
 *    WebSocket hijacking; clients that are not browsers send no `Origin`);
 * 4. when a token is configured, the connection presents it.
 *
 * Technical context: pure functions over environment values and a `Headers`-like
 * object, so the rules are unit-tested without a socket; `index.js` applies them in the
 * Bun `fetch` handler. The token is compared in constant time (SHA-256 digests of both
 * sides through `timingSafeEqual`) so a wrong token leaks no prefix length.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { WS_SUBPROTOCOL, offeredProtocols, tokenFromProtocols } from '../../remote/auth-protocol.js';

/** Shortest token accepted: 16 characters, so a typo or placeholder cannot guard a database. */
export const MIN_TOKEN_LENGTH = 16;

const LOOPBACK_DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether a bind address only accepts connections from the same machine.
 *
 * @param {string} host - Value of the `HOST` setting
 * @returns {boolean} True for `localhost`, `127.0.0.0/8` and `::1`
 */
export function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Split a comma-separated environment list.
 *
 * @param {string|undefined} value - Raw environment value
 * @returns {string[]} Trimmed, lower-cased, non-empty entries
 */
function listOf(value) {
  return String(value ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

/**
 * Reduce a `Host` header (or an allow-list entry) to its host name, dropping any port.
 *
 * @param {string} hostHeader - `example.com:3000`, `[::1]:3000` or `localhost`
 * @returns {string} Lower-cased host name; IPv6 keeps its brackets
 */
function hostnameOf(hostHeader) {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Read and validate the access-control settings. Throws instead of starting unsafe.
 *
 * Settings: `HOST` (bind address, default `127.0.0.1`), `AUTH_TOKEN` (shared secret,
 * at least 16 characters; when set it is always enforced), `AUTH_REQUIRED` (`true`
 * refuses to start without a token), `ALLOWED_HOSTS` and `ALLOWED_ORIGINS`
 * (comma-separated allow-lists).
 *
 * @param {Record<string, string|undefined>} env - Environment (usually `process.env`)
 * @returns {{host: string, token: string|null, allowedHosts: string[]|null, allowedOrigins: string[]}} Settings
 * @throws {Error} When the settings would leave the database reachable without access control
 */
export function loadSecurityConfig(env) {
  const host = (env.HOST || '127.0.0.1').trim();
  const token = env.AUTH_TOKEN ? env.AUTH_TOKEN : null;
  const required = env.AUTH_REQUIRED ?? 'false';
  if (required !== 'true' && required !== 'false') {
    throw new Error(`AUTH_REQUIRED must be "true" or "false", got "${required}"`);
  }
  if (token !== null && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (required === 'true' && token === null) {
    throw new Error('AUTH_REQUIRED=true needs AUTH_TOKEN to be set');
  }
  const loopback = isLoopbackHost(host);
  if (!loopback && token === null) {
    throw new Error(`Refusing to listen on ${host} without AUTH_TOKEN: set AUTH_TOKEN, or bind HOST=127.0.0.1`);
  }
  const hosts = listOf(env.ALLOWED_HOSTS).map(hostnameOf);
  return {
    host,
    token,
    allowedHosts: hosts.length > 0 ? hosts : loopback ? LOOPBACK_DEFAULT_HOSTS : null,
    allowedOrigins: listOf(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, ''))
  };
}

/**
 * SHA-256 digest, so two secrets of any length compare as equal-length buffers.
 *
 * @param {string} value - Text to digest
 * @returns {Buffer} 32-byte digest
 */
function digest(value) {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time equality of two strings of any length.
 *
 * @param {string} presented - Value the client sent
 * @param {string} expected - Configured token
 * @returns {boolean} True when equal
 */
function sameToken(presented, expected) {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The token a client presented: `Authorization: Bearer ...` or the `bri-token.` sub-protocol.
 *
 * @param {Object} headers - Request headers (`Headers`-like: `get(name)` returns the value or null)
 * @param {string[]} protocols - Offered sub-protocols
 * @returns {string|null} Presented token, or null when none
 */
function presentedToken(headers, protocols) {
  const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '');
  return bearer ? bearer[1] : tokenFromProtocols(protocols);
}

/**
 * Decide whether a WebSocket upgrade request may proceed.
 *
 * @param {Object} headers - Request headers (`Headers`-like: `get(name)` returns the value or null)
 * @param {{token: string|null, allowedHosts: string[]|null, allowedOrigins: string[]}} config - From {@link loadSecurityConfig}
 * @returns {{ok: true, protocol: string|null} | {ok: false, status: number, reason: string}} Verdict; `protocol` is the sub-protocol to answer with
 */
export function authorizeUpgrade(headers, config) {
  if (config.allowedHosts !== null && !config.allowedHosts.includes(hostnameOf(headers.get('host') ?? ''))) {
    return { ok: false, status: 403, reason: 'Host not allowed' };
  }
  const origin = headers.get('origin');
  if (origin !== null && !config.allowedOrigins.includes(origin.toLowerCase().replace(/\/+$/, ''))) {
    return { ok: false, status: 403, reason: 'Origin not allowed' };
  }
  const protocols = offeredProtocols(headers.get('sec-websocket-protocol'));
  if (config.token !== null) {
    const presented = presentedToken(headers, protocols);
    if (presented === null || !sameToken(presented, config.token)) {
      return { ok: false, status: 401, reason: 'Unauthorized' };
    }
  }
  return { ok: true, protocol: protocols.includes(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : null };
}
