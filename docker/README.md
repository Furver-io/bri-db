# BRI Docker Server

A plug-and-play Docker container that exposes BRI database operations via WebSocket RPC. Clients can interact with BRI remotely using the **exact same API** as local BRI.

## Quick Start

```bash
# Clone and enter the docker directory
cd docker

# Choose an access token (the server refuses to start without one)
export AUTH_TOKEN=$(openssl rand -hex 32)

# Start the server
docker-compose up -d

# The server is now running at ws://localhost:3000/api/ape (this machine only)
```

## Client Usage

```javascript
import { createRemoteDB } from 'bri/remote';

// Connect to the server
const db = await createRemoteDB('ws://localhost:3000', {
  token: process.env.AUTH_TOKEN   // the server's AUTH_TOKEN
});

// Now use the SAME API as local BRI!

// Create
const user = await db.add.user({ name: 'Alice', email: 'alice@example.com' });
console.log(user.$ID); // USER_abc1234

// Read
const alice = await db.get.user(user.$ID);
const allUsers = await db.get.userS();
const admins = await db.get.userS({ role: 'admin' });

// Update (reactive)
alice.name = 'Alice Smith';
const updated = await alice.save();

// Population chaining
const post = await db.get.post(postId);
const withAuthor = await post.and.author;
const withComments = await withAuthor.and.comments;

// Subscriptions
const unsubscribe = await db.sub.user((change) => {
  console.log('User changed:', change);
});

// Transactions
db.rec();
await db.add.order({ items: [...] });
await db.add.payment({ amount: 100 });
await db.fin(); // Commit both

// Disconnect
await db.disconnect();
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `DATA_DIR` | /data | Persistent storage path |
| `MAX_MEMORY_MB` | 256 | LRU cache size in MB |
| `ENCRYPTION_KEY` | (none) | AES-256-GCM encryption key (64 hex chars) |
| `HOST` | 127.0.0.1 (`0.0.0.0` in the image) | Address the server binds. Beyond loopback the server refuses to start without `AUTH_TOKEN` |
| `AUTH_TOKEN` | (none) | Shared access token, at least 16 characters. When set it is always enforced; clients pass it as `createRemoteDB(url, { token })` |
| `AUTH_REQUIRED` | false | `true` makes the server refuse to start unless `AUTH_TOKEN` is set |
| `ALLOWED_HOSTS` | loopback names (loopback bind) / unchecked (other binds) | Comma-separated host names the server answers to (`Host` header); anything else gets 403 |
| `ALLOWED_ORIGINS` | (none) | Comma-separated browser origins allowed to connect, e.g. `https://app.example.com`; a request carrying any other `Origin` gets 403. Non-browser clients send no `Origin` |

### Security

The WebSocket RPC surface is the whole database, so the server decides who may connect
before any RPC exists:

- It binds `127.0.0.1` unless `HOST` says otherwise, and **refuses to start** on any other
  address without `AUTH_TOKEN` (and when `AUTH_REQUIRED=true` without one). The Docker image
  sets `HOST=0.0.0.0` so the published port works, so `docker-compose` requires `AUTH_TOKEN`
  and publishes the port on `127.0.0.1` unless `BIND_ADDRESS` is set.
- A connection with a missing or wrong token gets `401`; a foreign `Host` or `Origin` gets
  `403`. The token is compared in constant time.
- The client sends the token as a WebSocket sub-protocol (`bri-token.<base64url>`), not in
  the URL, so it stays out of access logs and browser history. Other clients may send
  `Authorization: Bearer <token>`.
- The token is a shared secret in clear text on `ws://`; use `wss://` (terminate TLS in a
  reverse proxy) for any connection that leaves the machine.
- `/api/ape/ping` stays open for health checks and returns only `ok` and a timestamp.

### docker-compose.yml

```yaml
version: '3.8'

services:
  bri:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - bri-data:/data
    environment:
      - PORT=3000
      - DATA_DIR=/data
      - MAX_MEMORY_MB=256
      - HOST=0.0.0.0
      - AUTH_TOKEN=${AUTH_TOKEN:?set AUTH_TOKEN}
      # - ENCRYPTION_KEY=your-64-char-hex-key

volumes:
  bri-data:
```

### Generate Encryption Key

```bash
openssl rand -hex 32
```

## API Mapping

| Local BRI | Remote BRI | Description |
|-----------|------------|-------------|
| `db.get.user(id)` | `db.get.user(id)` | Get by ID |
| `db.get.userS()` | `db.get.userS()` | Get all |
| `db.get.userS({...})` | `db.get.userS({...})` | Query |
| `db.add.user(data)` | `db.add.user(data)` | Create |
| `db.set.user(data)` | `db.set.user(data)` | Replace |
| `db.del.user(id)` | `db.del.user(id)` | Delete |
| `entity.and.field` | `entity.and.field` | Populate |
| `entity.save()` | `entity.save()` | Save changes |
| `db.sub.user(fn)` | `db.sub.user(fn)` | Subscribe |
| `db.rec()` | `db.rec()` | Start transaction |
| `db.fin()` | `db.fin()` | Commit |
| `db.nop()` | `db.nop()` | Cancel |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│                                                          │
│   Bun Server (api-ape WebSocket)                        │
│   ├── BRI Database Instance                             │
│   │   ├── In-memory LRU cache                           │
│   │   ├── WAL (Write-Ahead Log)                         │
│   │   └── Cold storage (JSON files)                     │
│   │                                                      │
│   └── Volume mount: /data                               │
│                                                          │
│   Port: 3000                                             │
└─────────────────────────────────────────────────────────┘
         ↕ WebSocket (ws://host:3000/api/ape)
┌─────────────────────────────────────────────────────────┐
│              Your Application                            │
│   import { createRemoteDB } from 'bri/remote'           │
└─────────────────────────────────────────────────────────┘
```

## Health Check

The server exposes a health check endpoint:

```bash
curl http://localhost:3000/api/ape/ping
# {"ok":true,"timestamp":1234567890}
```

## Development

```bash
# Build without running
docker-compose build

# Run with logs
docker-compose up

# Run in background
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

## Persistence

Data is stored in a Docker volume (`bri-data`) at `/data` inside the container. This includes:

- **WAL files**: Write-ahead log for durability
- **Cold storage**: JSON files for persistent data
- **Snapshots**: Periodic snapshots for faster recovery

To backup:

```bash
docker run --rm -v bri-data:/data -v $(pwd):/backup alpine tar czf /backup/bri-backup.tar.gz /data
```

To restore:

```bash
docker run --rm -v bri-data:/data -v $(pwd):/backup alpine tar xzf /backup/bri-backup.tar.gz -C /
```
