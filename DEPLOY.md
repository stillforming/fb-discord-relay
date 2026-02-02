# Deployment Guide

This guide walks you through deploying the FB-Discord Relay to a production server.

## Prerequisites

- A VPS with at least 1GB RAM (DigitalOcean, Vultr, Hetzner, etc.)
- A domain name pointed to your server's IP
- SSH access to your server

## Recommended Providers

| Provider | Smallest Plan | Monthly Cost |
|----------|---------------|--------------|
| [DigitalOcean](https://digitalocean.com) | 1GB RAM, 1 vCPU | $6 |
| [Vultr](https://vultr.com) | 1GB RAM, 1 vCPU | $6 |
| [Hetzner](https://hetzner.com) | 2GB RAM, 2 vCPU | €4.50 |
| [Linode](https://linode.com) | 1GB RAM, 1 vCPU | $5 |

## Step 1: Create Your Server

1. Create a new server with **Ubuntu 22.04 LTS**
2. Choose the smallest plan (1GB RAM is plenty)
3. Add your SSH key for secure access
4. Note the server's IP address

## Step 2: Point Your Domain

Add an A record pointing your domain to your server's IP:

```
Type: A
Name: relay (or @ for root domain)
Value: YOUR_SERVER_IP
TTL: 300
```

Wait for DNS propagation (usually 5-15 minutes).

## Step 3: Connect to Your Server

```bash
ssh root@YOUR_SERVER_IP
```

## Step 4: Clone the Repository

```bash
cd /opt
git clone https://github.com/stillforming/fb-discord-relay.git
cd fb-discord-relay
```

## Step 5: Configure Environment

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

Fill in all the required values:

| Variable | Description |
|----------|-------------|
| `DOMAIN` | Your domain (e.g., `relay.example.com`) |
| `POSTGRES_PASSWORD` | Strong random password for database |
| `META_VERIFY_TOKEN` | Random string for Facebook webhook verification |
| `META_APP_SECRET` | From Facebook App Dashboard → Settings → Basic |
| `META_PAGE_ID` | Your Facebook Page ID |
| `META_PAGE_ACCESS_TOKEN` | Long-lived Page Access Token |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL |
| `DISCORD_MENTION_ROLE_ID` | Role ID to ping (optional) |
| `TRIGGER_TAG` | Tag to trigger relay (e.g., `"#nofomo"`) |

## Step 6: Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will:
1. Install Docker if needed
2. Build and start all services
3. Run database migrations
4. Set up automatic HTTPS via Caddy

## Step 7: Update Facebook Webhook

1. Go to [Facebook Developer Dashboard](https://developers.facebook.com)
2. Select your app → Webhooks
3. Update the callback URL to: `https://YOUR_DOMAIN/meta/webhook`
4. Use your `META_VERIFY_TOKEN` as the verify token

## Step 8: Subscribe Your Page

```bash
docker compose -f docker-compose.prod.yml exec ingress node -e "
const https = require('https');
const url = 'https://graph.facebook.com/v24.0/${META_PAGE_ID}/subscribed_apps?subscribed_fields=feed&access_token=${META_PAGE_ACCESS_TOKEN}';
https.request(url, { method: 'POST' }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
}).end();
"
```

Or use the Graph API Explorer to POST to `/{page-id}/subscribed_apps` with `subscribed_fields=feed`.

## Maintenance

### View Logs

```bash
# All logs
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f worker
```

### Restart Services

```bash
docker compose -f docker-compose.prod.yml restart
```

### Update to Latest Version

```bash
cd /opt/fb-discord-relay
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

### Database Backup

```bash
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U relay relay > backup.sql
```

## Troubleshooting

### Services won't start

Check logs:
```bash
docker compose -f docker-compose.prod.yml logs
```

### HTTPS not working

Make sure:
1. Your domain points to the server IP
2. Ports 80 and 443 are open in firewall
3. Caddy can reach Let's Encrypt (no firewall blocking outbound)

### Webhooks not arriving

1. Check Facebook webhook status in App Dashboard
2. Verify the callback URL is correct
3. Check ingress logs for incoming requests

### Posts not forwarding

1. Check worker logs for errors
2. Verify Facebook page token is valid
3. Confirm trigger tag is in the post

## Security Notes

- Change `POSTGRES_PASSWORD` to a strong random value
- Consider setting up a firewall (ufw)
- Keep your server updated: `apt update && apt upgrade`
- The relay runs as non-root user inside containers
