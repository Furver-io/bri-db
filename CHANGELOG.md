# Changelog

Releases before 1.2.1 have no changelog; see the GitHub Releases page for their commit lists.
The 2.0 line carries the same fixes (see its own changelog entry).

## 1.2.1 - 2026-10-14

### Security

Two vulnerabilities are fixed. Upgrade, and read "Behaviour changes" below.

**Code could run, and prototypes could change, when a database read a hostile file.**
Snapshots, WAL lines and cold-tier `.jss` files are decoded by the JSS reader whenever a
database opens or reads a document. The reader built error values by looking up the class
named in the file among the global objects, so a file naming a different global (for
example a `Worker` with a script URL, under Bun) made the process construct it. Anyone able
to place a file in a data folder (a restored backup, a shared volume, a synced directory)
could therefore run code on the next read, with no network involved. The reader also let
stored keys and pointer paths reach inherited members, so a crafted file could make a
decoded document inherit properties, or change a built-in prototype such as
`Object.prototype`, and a document with two keys that decode to the same name resolved by
last-write-wins. A very long key could also stall the process (quadratic parsing).

- JSS builds `Error` values only for the standard classes (`Error`, `TypeError`,
  `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`,
  `AggregateError`). Any other stored name becomes a plain `Error` whose `name` is that text.
- Tags, keys and pointer paths match own properties only; a `__proto__` key is an ordinary
  key; a pointer is written into the decoded object that held it.
- A key that decodes twice (`a` and `a<!M>`) and a pointer whose value is not a path string
  now throw while decoding. A snapshot that fails this way is ignored, a WAL line is skipped
  as corrupt, and a cold-tier read rejects.
- Key parsing is linear.

**The remote WebSocket server accepted every connection.** `docker/server` read
`AUTH_REQUIRED` but never enforced it, did not check `Host` or `Origin`, and listened on
every interface. Anyone who could reach the port, or any web page open in a browser on the
same machine, could read and rewrite every document.

- The server binds `127.0.0.1` by default (`HOST` changes it) and refuses to start on any
  other address without `AUTH_TOKEN`. `AUTH_REQUIRED=true` without a token, a mistyped
  `AUTH_REQUIRED`, and a token shorter than 16 characters also refuse to start.
- When `AUTH_TOKEN` is set it is always enforced at the WebSocket upgrade: a missing or wrong
  token gets `401`. The comparison is constant-time.
- The `Host` header must name this server (`ALLOWED_HOSTS`; loopback names by default on a
  loopback bind) and a browser `Origin`, when present, must be listed in `ALLOWED_ORIGINS`;
  otherwise `403`.
- Clients pass the token with `createRemoteDB(url, { token })`. It travels as a WebSocket
  sub-protocol, never in the URL. `/api/ape/ping` stays open for health checks.
- `docker-compose` now requires `AUTH_TOKEN` and publishes the port on `127.0.0.1` unless
  `BIND_ADDRESS` is set.

#### Affected versions

| Version | JSS decoder | Remote server |
|---|---|---|
| 1.0.0, 1.1.0, 1.1.1 | affected | not included |
| 1.2.0 | affected | affected |
| 1.2.1 | fixed | fixed |

Every published version below 1.2.1 (1.0.0, 1.1.0, 1.1.1, 1.2.0) is affected and should be
deprecated on npm. Until upgraded, restrict write access to data folders, and do not expose
the 1.2.0 remote server beyond a trusted machine.

#### Behaviour changes

- A custom `Error` subclass stored in a document decodes as a plain `Error` with the original
  `name` instead of an instance of the subclass.
- The remote server listens on loopback by default; set `HOST` (and `AUTH_TOKEN`) to expose it.
  The Docker image sets `HOST=0.0.0.0`, so container deployments must provide `AUTH_TOKEN`.
- Clients of a server that requires a token pass it as `createRemoteDB(url, { token })` (or
  `apiDB(url, { token })`).
