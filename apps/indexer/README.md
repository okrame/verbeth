# Indexer

Rust-based event indexer. Listens to on-chain events via WebSocket and persists them in SQLite with stable sequence counters for APSI integration.

## Features

- WebSocket subscription to Verbeth contract events
- Historical backfill on startup
- SQLite persistence with WAL mode
- Atomic sequence counters per topic/recipient
- Health endpoint for monitoring
- Graceful shutdown

## Quick Start

```bash
cp .env.example .env

vim .env

cargo run
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_WS_URL` | Yes | - | WebSocket RPC endpoint |
| `RPC_HTTP_URL` | No | derived from WS | HTTP RPC for backfill |
| `CONTRACT_ADDRESS` | No | Verbeth proxy | Contract to index |
| `CREATION_BLOCK` | No | 37097547 | Block to start backfill from |
| `DATABASE_PATH` | No | ./data/indexer.db | SQLite file location |
| `SERVER_PORT` | No | 3002 | HTTP server port |
| `BACKFILL_DAYS` | No | 7 | Days to backfill on empty DB |
| `RUST_LOG` | No | info | Log level |

## API Endpoints

### GET /health

Returns indexer status:

```json
{
  "status": "ok",
  "last_block": 12345678,
  "uptime_seconds": 3600,
  "counts": {
    "messages": 150,
    "handshakes": 42,
    "handshake_responses": 38
  }
}
```

## Deployment

### Docker

```bash
docker build -t indexer .
docker run -v indexer-data:/data -e RPC_WS_URL=wss://... indexer
```

### Fly.io

```bash
fly launch --no-deploy
fly secrets set RPC_WS_URL=wss://...
fly volume create indexer_data --size 1
fly deploy
```

## Database Schema

Events are stored with stable `seq` counters:

- `messages(topic, seq)` - MessageSent events
- `handshakes(recipient_hash, seq)` - Handshake events
- `handshake_responses(global_seq)` - HandshakeResponse events

These counters enable deterministic item identifiers for APSI queries.
