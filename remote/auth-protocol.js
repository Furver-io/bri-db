/**
 * @file WebSocket sub-protocol codec that carries the BRI remote access token.
 *
 * Domain context: the remote server can require a shared token. Browsers and the
 * runtimes BRI supports (Bun, Node with `ws`, Node 22+ `WebSocket`) cannot all set an
 * `Authorization` header on a WebSocket handshake, but every one of them can offer
 * sub-protocols, and the header is not part of the URL (so it stays out of access logs,
 * browser history and `Referer`). The client therefore offers two sub-protocols,
 * `bri` and `bri-token.<base64url(token)>`; the server reads the token from the second,
 * answers with `bri` only, and never echoes the token back.
 *
 * Technical context: pure functions over `btoa`/`atob` and `TextEncoder`/`TextDecoder`
 * (present in browsers, Bun and Node 16+), shared by the client (`src/remote`) and the
 * reference server (`docker/server`) so both sides agree on the encoding.
 */

/** Sub-protocol the server selects for every accepted connection. */
export const WS_SUBPROTOCOL = 'bri';

/** Prefix of the sub-protocol that carries the encoded token. */
export const TOKEN_PROTOCOL_PREFIX = 'bri-token.';

/**
 * Encode a token as the sub-protocol list a client offers on connect.
 *
 * @param {string} token - Shared access token (non-empty text)
 * @returns {string[]} `['bri', 'bri-token.<base64url>']`
 * @throws {TypeError} When the token is not a non-empty string
 */
export function tokenSubprotocols(token) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('bri remote: token must be a non-empty string');
  }
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [WS_SUBPROTOCOL, TOKEN_PROTOCOL_PREFIX + encoded];
}

/**
 * Split a `Sec-WebSocket-Protocol` request header into its offered protocols.
 *
 * @param {string|null|undefined} header - Raw header value
 * @returns {string[]} Offered protocol names, trimmed, empty entries dropped
 */
export function offeredProtocols(header) {
  return String(header ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * Read the token a client offered in its sub-protocol list.
 *
 * @param {string[]} protocols - Result of {@link offeredProtocols}
 * @returns {string|null} Decoded token, or null when none was offered or it is not valid base64url
 */
export function tokenFromProtocols(protocols) {
  const offered = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX));
  if (offered === undefined) return null;
  const encoded = offered.slice(TOKEN_PROTOCOL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
