## Directory Structure

```
server/
├── crud.js
├── handlers.js
├── security.js
├── utils.js
├── index.js
└── package.json
```

## Files

### `crud.js`

CRUD operation handlers for database operations.

**Exports:**
- `handleGet(db, state, collection, payload, opts)` - Query entities
- `handleAdd(db, state, collection, payload, opts)` - Create entities
- `handleSet(db, state, collection, payload, opts)` - Replace entities
- `handleDel(db, state, collection, payload, opts)` - Delete entities

### `handlers.js`

RPC request routing and non-CRUD operation handlers.

**Exports:**
- `handleRPC(db, ws, type, payload)` - Route and handle RPC requests

**Supported Operations:**
- `db/get/<collection>` - Query entities
- `db/add/<collection>` - Create entities
- `db/set/<collection>` - Replace entities
- `db/del/<collection>` - Delete entities
- `db/sub/<collection>` - Subscribe to changes
- `db/unsub/<collection>` - Unsubscribe
- `db/populate` - Populate entity references
- `db/save` - Save entity changes
- `db/txn/<op>` - Transaction operations (rec/fin/nop/pop/status)

### `security.js`

Access control for the WebSocket upgrade: decides who may connect before any RPC exists.

**Exports:**
- `loadSecurityConfig(env)` - Validate `HOST`, `AUTH_TOKEN`, `AUTH_REQUIRED`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`; throws (so the server refuses to start) on a non-loopback bind without a token, `AUTH_REQUIRED=true` without a token, or a token shorter than `MIN_TOKEN_LENGTH`
- `authorizeUpgrade(headers, config)` - Returns `{ ok: true, protocol }` or `{ ok: false, status, reason }`: Host (403), Origin (403), then token (401, constant-time compare)
- `isLoopbackHost(host)` - Whether a bind address is local-only
- `MIN_TOKEN_LENGTH` - Shortest accepted token (16)

### `utils.js`

Connection state management and serialization utilities.

**Exports:**
- `getState(socket)` - Get or create connection state for a WebSocket
- `deleteState(socket)` - Remove connection state on disconnect
- `toPlainObject(entity)` - Convert reactive entity to plain object for transmission

### `index.js`

Main server entry point with WebSocket setup.

**Exports:**
- `db` - Database instance
- `getState` - Re-exported from utils

**Environment Variables:**
- `PORT` - Server port (default: 3000)
- `DATA_DIR` - BRI data directory (default: /data)
- `MAX_MEMORY_MB` - Memory limit (default: 256)
- `ENCRYPTION_KEY` - Optional encryption key
- `HOST` - Bind address (default: 127.0.0.1)
- `AUTH_TOKEN` - Shared access token, at least 16 characters; always enforced when set
- `AUTH_REQUIRED` - Refuse to start without `AUTH_TOKEN` (default: false)
- `ALLOWED_HOSTS` - Accepted `Host` names (comma-separated)
- `ALLOWED_ORIGINS` - Browser origins allowed to connect (comma-separated)

### `package.json`

Server dependencies (bri).
