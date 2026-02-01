# Facebook → Discord Relay

Realtime push-based relay for forwarding Facebook Page posts to Discord.

**Use case:** Stock trading alerts. When the Page owner includes `#discord` in a post, it's forwarded to Discord within seconds.

## Features

- **Push-based** (Facebook Webhooks, not polling) — ~1-5 second latency
- **Idempotent** — Duplicate webhooks don't cause duplicate alerts
- **State machine** — Posts tracked through the delivery pipeline
- **Kill switch** — Disable alerts without stopping the service
- **Audit trail** — Full event log for debugging

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- A Facebook App with webhooks configured
- A Facebook Page you manage
- A Discord webhook URL

### 1. Clone and setup

```bash
git clone <this-repo>
cd fb-discord-relay
cp .env.example .env
# Edit .env with your credentials (see Configuration below)
```

### 2. Create Facebook App & Webhooks

1. Go to [developers.facebook.com](https://developers.facebook.com) and create an app
2. Add the **Webhooks** product
3. Add the **Facebook Login** product (needed for page tokens)
4. In Webhooks settings:
   - Select "Page" subscription
   - Callback URL: `https://your-domain.com/meta/webhook`
   - Verify Token: Your `META_VERIFY_TOKEN` from `.env`
   - Subscribe to: `feed`

### 3. Get Page Access Token

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select your app
3. Click "Get Token" → "Get Page Access Token"
4. Grant `pages_read_engagement` and `pages_manage_metadata` permissions
5. Select your page
6. Copy the token to `META_PAGE_ACCESS_TOKEN` in `.env`

**For long-lived tokens:** Exchange the short-lived token for a long-lived one, or set up a Page Access Token that doesn't expire.

### 4. Get Discord Webhook URL

1. In Discord, go to channel settings → Integrations → Webhooks
2. Create a webhook
3. Copy the URL to `DISCORD_WEBHOOK_URL` in `.env`

### 5. Start the services

```bash
# Development (with hot reload)
docker compose -f docker-compose.dev.yml up -d  # Start Postgres only
npm install
npm run db:generate
npm run db:migrate:dev
npm run dev:ingress  # Terminal 1
npm run dev:worker   # Terminal 2

# Production
docker compose up -d --build
```

### 6. Subscribe your page

```bash
npm run subscribe

# Verify subscription
npm run subscribe -- --verify
```

### 7. Test it!

1. Make sure your webhook URL is publicly accessible (use ngrok for local dev)
2. Post to your Facebook Page with `#discord` in the message
3. Check Discord for the alert!

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Ingress server port | `3000` |
| `PUBLIC_BASE_URL` | Public URL for debugging links | — |
| `META_VERIFY_TOKEN` | Random string for webhook verification | — |
| `META_APP_SECRET` | Facebook App secret (for signature verification) | — |
| `META_GRAPH_VERSION` | Graph API version | `v21.0` |
| `META_PAGE_ID` | Facebook Page ID | — |
| `META_PAGE_ACCESS_TOKEN` | Page access token with required permissions | — |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL | — |
| `DISCORD_WEBHOOK_WAIT` | Wait for message ID from Discord | `true` |
| `DISCORD_DISCLAIMER` | Disclaimer text below alerts | `Not financial advice...` |
| `DISCORD_MENTION_ROLE_ID` | Role ID to mention on each alert | — |
| `ALERTS_ENABLED` | Kill switch for alerts | `true` |
| `TRIGGER_TAG` | Tag required in posts | `#discord` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `LOG_LEVEL` | Logging level | `info` |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Facebook      │────▶│   Ingress       │────▶│   pg-boss       │
│   Webhooks      │     │   (Fastify)     │     │   (Postgres)    │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Discord       │◀────│   Worker        │◀────│   Graph API     │
│   Webhook       │     │   (pg-boss)     │     │   (fetch post)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Post State Machine

```
received → fetching → eligible → sending → delivered
                   ↘ ignored (no tag)
                            ↘ failed / needs_review
```

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Database migrations
npm run db:migrate:dev -- --name <migration-name>
```

## Deployment

### Single VM (recommended for small scale)

1. Set up a VM with Docker
2. Point your domain to the VM
3. Use Caddy for automatic HTTPS (uncomment in docker-compose.yml)
4. `docker compose up -d`

### Caddy configuration (if using)

Create `Caddyfile`:

```caddyfile
your-domain.com {
    reverse_proxy ingress:3000
}
```

## Monitoring

- **Health check:** `GET /healthz`
- **Readiness:** `GET /readyz`
- **Logs:** `docker compose logs -f`

Posts that fail delivery are marked `failed` or `needs_review` in the database. Query:

```sql
SELECT * FROM posts WHERE status IN ('failed', 'needs_review');
```

## Troubleshooting

See [RUNBOOK.md](./RUNBOOK.md) for common issues and solutions.

## License

MIT
