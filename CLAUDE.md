# Open Wearables

Health data aggregation platform. Connects to wearable devices (Garmin, Whoop, Oura, Polar, Strava, Fitbit, Apple, Samsung, Google, Ultrahuman), normalizes data, exposes via REST API with webhook notifications.

## Stack

**Backend:** FastAPI (Python 3.13), SQLAlchemy 2.0, PostgreSQL 18, Celery + Redis, Svix (webhooks), Sentry
**Frontend:** React 19, TanStack Start/Router/Query, Tailwind CSS 4, shadcn/ui, Vite
**Package managers:** uv (Python), pnpm (Node.js)

## Services

| Service | Container | Port |
|---------|-----------|------|
| Backend API | `backend__open-wearables` | 8001→8000 |
| Frontend | `frontend__open-wearables` | 3001→3000 |
| Celery Worker | `celery-worker__open-wearables` | — |
| Celery Beat | `celery-beat__open-wearables` | — |
| Flower (monitoring) | `flower__open-wearables` | 5556→5555 |
| PostgreSQL | `postgres__open-wearables` | 5433→5432 |
| Redis | `redis__open-wearables` | 6379 |
| Svix (webhooks) | `svix-server__open-wearables` | 8072→8071 |

## Commands

```bash
# Dev
docker compose up -d              # Start all services
make watch                        # Hot-reload mode
make stop / make down             # Stop / remove

# Backend
make test                         # Run backend tests
make migrate                      # Apply migrations
make create_migration m="desc"    # New migration
make seed                         # Seed sample data
cd backend && uv run pytest -v --cov=app

# Frontend
cd frontend && pnpm run dev       # Dev server
cd frontend && pnpm run build     # Production build
cd frontend && pnpm run lint:fix  # Lint + fix
cd frontend && pnpm run test      # Tests
```

## Deploy

```bash
cd /home/hermes/projects/open-wearables
docker compose -f docker-compose.prod.yml up -d --build
```

## Structure

```
backend/
├── app/
│   ├── api/routes/v1/        # REST endpoints (auth, users, connections, etc.)
│   ├── models/               # 23 SQLAlchemy models
│   ├── repositories/         # Data access layer
│   ├── schemas/              # Pydantic schemas
│   ├── services/
│   │   ├── providers/        # Garmin, Polar, Suunto, Whoop, Oura, Strava, Fitbit, etc.
│   │   ├── outgoing_webhooks/# Svix webhook management
│   │   └── scores/           # Health score calculation
│   └── integrations/celery/  # 17+ async tasks + beat scheduler
├── migrations/               # Alembic
└── tests/

frontend/
├── src/
│   ├── routes/               # File-based TanStack routes
│   ├── components/           # shadcn/ui + features
│   ├── lib/                  # Utilities
│   └── hooks/                # Custom hooks

docs/                         # Mintlify documentation site
mcp/                          # MCP server for AI assistants
```

## Celery Beat Schedule

- Periodic sync — every `SYNC_INTERVAL_SECONDS` (default 1h)
- Sleep finalization — marks stale sleep sessions complete
- Garmin backfill GC — every 3 minutes
- Daily archival — 03:00 UTC
- Fill missing sleep/resilience scores — every 10 min
- Renew Oura webhooks — monthly

## Conventions

- API routes: `/api/v1/*`
- Provider dirs: lowercase (`garmin/`, `polar/`, etc.)
- Task files: `*_task.py` suffix
- Models: PascalCase (SQLAlchemy), auto-exported in `models/__init__.py`
- Repositories pattern for data access
- Alembic for migrations (`migrations/versions/`)

## Env vars

Config in `backend/config/.env`. Key vars:
```
ENVIRONMENT, API_PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
REDIS_HOST, REDIS_PORT, SECRET_KEY, ADMIN_EMAIL, ADMIN_PASSWORD,
RESEND_API_KEY, SVIX_SERVER_URL, SENTRY_DSN,
SUUNTO_*, POLAR_*, GARMIN_*, WHOOP_*, OURA_*, STRAVA_*, FITBIT_*, ULTRAHUMAN_*
```
