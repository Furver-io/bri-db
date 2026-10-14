# Changelog

Releases before 1.2.1 have no changelog; see the GitHub Releases page for their commit lists.
The 2.0 line carries the same fixes (see its own changelog entry).

## 1.2.1 - 2026-10-14

### Security

Three vulnerabilities are fixed, with some hardening around them. Upgrade, and read
"Behaviour changes" below.

**Code could run, and prototypes could change, when a database read hostile data.**
Snapshots, WAL lines and cold-tier `.jss` files are decoded by the JSS reader whenever a
database opens or reads a document. The reader built error values by looking up the class
named in the data among the global objects, so data naming a different global (for example a
`Worker` with a script URL, under Bun) made the process construct it. Two routes reach it:

- Anyone able to place a file in a data folder (a restored backup, a shared volume, a synced
  directory) gets code run on the next read, with no network involved.
- On a remote server, any WebSocket client could do the same through an ordinary write: a
  document field whose name ends in a type tag (`name<!E>`) was stored as written and decoded
  as a tagged value on the next read. On 1.2.0 that is unauthenticated remote code execution
  under Bun.

The reader also let stored keys and pointer paths reach inherited members, so crafted data
could make a decoded document inherit properties, or change a built-in prototype such as
`Object.prototype`, and a document with two keys that decode to the same name resolved by
last-write-wins. A very long key could stall the process (quadratic parsing).

- JSS builds `Error` values only for the standard classes (`Error`, `TypeError`,
  `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`,
  `AggregateError`). Any other stored name becomes a plain `Error` whose `name` is that text.
- Tags, keys and pointer paths match own properties only; a `__proto__` key is an ordinary
  key; a pointer is written into the decoded object that held it.
- A key that decodes twice (`a` and `a<!M>`) and a pointer whose value is not a path string
  throw while decoding. A snapshot that fails this way is ignored, a WAL entry whose own keys
  fail is skipped as corrupt, and a cold-tier read rejects. A document body inside a WAL `SET`
  that fails is reported when that document is read or when recovery needs to parse it, so a
  hostile data folder can make opening it fail loudly; it cannot make it run anything.
- Writing a field whose name ends in a type tag (`name<!X>`) is refused (`JSS encode: key ...
  ends in a type tag`) before anything is persisted. Without this, such a document could be
  written but never read, snapshotted or deleted again.
- Key parsing is linear.

**A writer could change `Object.prototype` through field names (all versions).** Saving an
entity turned the changed field paths into an object by walking them with plain property
lookups, so a field named `__proto__` or `constructor` (for example in JSON received from a
user, or sent by a remote client with `db/save`) wrote into `Object.prototype` or a built-in
constructor. Polluting `toString` made every later request on a server fail until restart.
Field paths are now matched against own properties only and keys are set without touching
prototypes; saving a document no longer uses `Object.assign`, which would treat an own
`__proto__` key as a prototype.

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
- Clients pass the token with `createRemoteDB(url, { token })` (or `apiDB(url, { token })`). It travels as a WebSocket
  sub-protocol, never in the URL. A client that offers sub-protocols without `bri` gets `400`
  (the runtime would otherwise echo the offered list, token included). `/api/ape/ping` stays
  open for health checks.
- The server no longer answers a malformed request with Bun's development error page, which
  embedded the server source and absolute paths before any check ran.
- `docker-compose` now requires `AUTH_TOKEN` and publishes the port on `127.0.0.1` unless
  `BIND_ADDRESS` is set.

Not covered by this release: the server has no rate limiting, no per-client authorisation
(every holder of the token can read and write everything), and no TLS; use `wss://` behind a
reverse proxy for any connection that leaves the machine.

#### Affected versions

| Version | JSS decoder | Prototype pollution on save | Remote server |
|---|---|---|---|
| 1.0.0, 1.1.0, 1.1.1 | affected | affected | not included |
| 1.2.0 | affected | affected | affected |
| 1.2.1 | fixed | fixed | fixed |

Every published version below 1.2.1 (1.0.0, 1.1.0, 1.1.1, 1.2.0) is affected and should be
deprecated on npm. Until upgraded, restrict write access to data folders, and do not expose
the 1.2.0 remote server beyond a trusted machine.

The Docker image build on this line (`docker/Dockerfile`, which copies only `docker/server/`)
does not run, in 1.2.0 or in 1.2.1: the server imports `../../index.js`, which is not in the
image. Run the server from a checkout (`bun docker/server/index.js`) or use the 2.0 line.

#### Behaviour changes

- A custom `Error` subclass stored in a document decodes as a plain `Error` with the original
  `name` instead of an instance of the subclass.
- A field name ending in `<!tag>` can no longer be written (it never round-tripped).
- The remote server listens on loopback by default; set `HOST` (and `AUTH_TOKEN`) to expose it.
  The Docker image sets `HOST=0.0.0.0`, so container deployments must provide `AUTH_TOKEN`.
- Clients of a server that requires a token pass it as `createRemoteDB(url, { token })` (or `apiDB(url, { token })`).
