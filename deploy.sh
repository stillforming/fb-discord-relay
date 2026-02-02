#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  FB-Discord Relay - Deployment Script ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if running as root (needed for Docker on fresh servers)
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Running as root. Consider creating a non-root user for production.${NC}"
fi

# Check for Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker not found. Installing...${NC}"
    curl -fsSL https://get.docker.com | sh
    sudo systemctl enable docker
    sudo systemctl start docker
    echo -e "${GREEN}Docker installed!${NC}"
fi

# Check for Docker Compose
if ! docker compose version &> /dev/null; then
    echo -e "${RED}Docker Compose not found. Please install Docker Compose v2.${NC}"
    exit 1
fi

# Check for .env.prod
if [ ! -f .env.prod ]; then
    echo -e "${YELLOW}No .env.prod found. Creating from example...${NC}"
    if [ -f .env.prod.example ]; then
        cp .env.prod.example .env.prod
        echo -e "${RED}⚠️  Please edit .env.prod with your actual values before continuing!${NC}"
        echo -e "${YELLOW}Run: nano .env.prod${NC}"
        exit 1
    else
        echo -e "${RED}.env.prod.example not found!${NC}"
        exit 1
    fi
fi

# Load environment variables for DOMAIN check
source .env.prod

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "relay.yourdomain.com" ]; then
    echo -e "${RED}⚠️  Please set DOMAIN in .env.prod to your actual domain!${NC}"
    exit 1
fi

if [ "$POSTGRES_PASSWORD" = "CHANGE_ME_TO_STRONG_PASSWORD" ]; then
    echo -e "${RED}⚠️  Please change POSTGRES_PASSWORD in .env.prod!${NC}"
    exit 1
fi

echo -e "${GREEN}Configuration looks good!${NC}"
echo ""

# Export DOMAIN for Caddyfile
export DOMAIN

# Build and start services
echo -e "${YELLOW}Building and starting services...${NC}"
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# Wait for services to be healthy
echo -e "${YELLOW}Waiting for services to start...${NC}"
sleep 10

# Run database migrations
echo -e "${YELLOW}Running database migrations...${NC}"
docker compose -f docker-compose.prod.yml exec -T ingress npx prisma migrate deploy

# Check health
echo ""
echo -e "${YELLOW}Checking service health...${NC}"
if curl -sf http://localhost:3000/healthz > /dev/null; then
    echo -e "${GREEN}✅ Ingress is healthy${NC}"
else
    echo -e "${RED}❌ Ingress health check failed${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Your relay is now running at: ${GREEN}https://${DOMAIN}${NC}"
echo ""
echo -e "Webhook URL for Facebook: ${GREEN}https://${DOMAIN}/meta/webhook${NC}"
echo ""
echo -e "Useful commands:"
echo -e "  ${YELLOW}docker compose -f docker-compose.prod.yml logs -f${NC}        # View logs"
echo -e "  ${YELLOW}docker compose -f docker-compose.prod.yml restart${NC}        # Restart services"
echo -e "  ${YELLOW}docker compose -f docker-compose.prod.yml down${NC}           # Stop services"
echo -e "  ${YELLOW}docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d --build${NC}  # Update"
echo ""
