# Operational Runbook

## Quick Diagnostics

### Check service health

```bash
# All services
docker compose ps

# Health endpoint
curl http://localhost:3000/healthz

# Logs
docker compose logs -f ingress
docker compose logs -f worker
```

### Check queue status

```bash
docker compose exec postgres psql -U relay -d relay -c "
  SELECT name, state, COUNT(*) 
  FROM pgboss.job 
  GROUP BY name, state 
  ORDER BY name, state;
"
```

### Check post status

```bash
docker compose exec postgres psql -U relay -d relay -c "
  SELECT status, COUNT(*) 
  FROM posts 
  GROUP BY status 
  ORDER BY status;
"
```

## Common Issues

### 1. Webhook Signature Verification Failed (403)

**Symptoms:**
- Ingress logs show "Invalid webhook signature"
- Facebook webhook test fails

**Causes:**
- Wrong `META_APP_SECRET`
- Raw body not preserved (middleware issue)

**Fix:**
1. Verify `META_APP_SECRET` matches your Facebook App's secret
2. Check Fastify is configured with raw body parser

```bash
# Verify app secret
echo $META_APP_SECRET
# Compare with: Facebook App Dashboard → Settings → Basic → App Secret
```

### 2. Token Expired

**Symptoms:**
- Worker logs show "OAuthException" or error code 190
- Posts stuck in `fetching` state

**Fix:**
1. Generate a new Page Access Token
2. Update `META_PAGE_ACCESS_TOKEN` in `.env`
3. Restart services: `docker compose restart`

**For long-lived tokens:**
```bash
# Exchange short-lived for long-lived (60 days)
curl "https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token}"
```

### 3. Missing Permissions

**Symptoms:**
- Graph API returns error code 200 or 10
- "Permissions error" in logs

**Required permissions:**
- `pages_read_engagement` — Read page posts
- `pages_manage_metadata` — Subscribe to webhooks

**Fix:**
1. Re-authenticate and grant missing permissions
2. Generate new Page Access Token
3. Re-run `npm run subscribe`

### 4. Discord Rate Limited (429)

**Symptoms:**
- Worker logs show "Rate limited"
- Posts stuck in `sending` state with retries

**Resolution:**
- Automatic: Worker backs off and retries
- If persistent, check for runaway loop

```bash
# Check retry counts
docker compose exec postgres psql -U relay -d relay -c "
  SELECT fb_post_id, retry_count, last_error, status 
  FROM posts 
  WHERE retry_count > 3;
"
```

### 5. Posts in `needs_review` State

**Symptoms:**
- Posts marked `needs_review` in database
- Logs show "Delivery status unknown"

**Cause:**
Discord request timed out after sending — we don't know if it was delivered.

**Resolution:**
1. Check Discord channel manually
2. If delivered, mark as delivered:
   ```sql
   UPDATE posts 
   SET status = 'delivered', discord_msg_id = 'manual-check' 
   WHERE fb_post_id = 'xxx';
   ```
3. If not delivered, reset for retry:
   ```sql
   UPDATE posts SET status = 'received' WHERE fb_post_id = 'xxx';
   ```

### 6. Webhooks Not Arriving

**Symptoms:**
- No requests hitting ingress
- Facebook test webhook works but real posts don't trigger

**Debug:**
1. Verify subscription:
   ```bash
   npm run subscribe -- --verify
   ```
2. Check Facebook webhook settings — ensure subscribed to `feed`
3. Verify page is linked to app
4. Check firewall/ingress allows Facebook IPs

### 7. Database Connection Issues

**Symptoms:**
- Health check returns 503
- "ECONNREFUSED" in logs

**Fix:**
```bash
# Check Postgres is running
docker compose ps postgres

# Check connection
docker compose exec postgres pg_isready -U relay -d relay

# Restart Postgres
docker compose restart postgres
```

## Rotating Credentials

### Rotate Page Access Token

1. Generate new token in Graph API Explorer
2. Update `.env`: `META_PAGE_ACCESS_TOKEN=new-token`
3. Restart: `docker compose restart ingress worker`
4. Verify: `npm run subscribe -- --verify`

### Rotate Discord Webhook

1. Create new webhook in Discord
2. Update `.env`: `DISCORD_WEBHOOK_URL=new-url`
3. Restart: `docker compose restart worker`
4. Test with a post

### Rotate App Secret

⚠️ This invalidates all webhook signatures until deployed.

1. Regenerate secret in Facebook App Dashboard
2. Update `.env`: `META_APP_SECRET=new-secret`
3. Deploy immediately: `docker compose up -d --build`
4. Re-configure webhook in Facebook (callback verification)

## Kill Switch

To disable alerts without stopping services:

```bash
# In .env
ALERTS_ENABLED=false

# Restart worker
docker compose restart worker
```

Posts will still be logged but not sent to Discord.

## Maintenance

### Clean up old records

Records older than 30 days in terminal states:

```sql
DELETE FROM posts 
WHERE status IN ('delivered', 'ignored') 
AND received_at < NOW() - INTERVAL '30 days';
```

### Vacuum database

```bash
docker compose exec postgres psql -U relay -d relay -c "VACUUM ANALYZE;"
```

### View delivery stats

```sql
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE success) as success,
  AVG(latency_ms) FILTER (WHERE success) as avg_latency_ms
FROM delivery_logs
GROUP BY DATE(created_at)
ORDER BY date DESC
LIMIT 7;
```

## Backup & Recovery

### Backup database

```bash
docker compose exec postgres pg_dump -U relay relay > backup.sql
```

### Restore database

```bash
cat backup.sql | docker compose exec -T postgres psql -U relay relay
```

## Scaling

For higher throughput:
1. Increase `teamSize` in worker (concurrent jobs)
2. Add more worker replicas in docker-compose
3. Consider read replicas for database if needed

Current defaults handle ~100 posts/minute safely.
