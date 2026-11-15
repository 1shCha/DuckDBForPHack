# DuckDB API

TypeScript and Express backend for the consolidated commercial DuckDB database.

## Local development

Use Node.js 22 or later. Run `npm ci`, copy `.env.example` to `.env`, and set
`DUCKDB_PATH` to the existing `commercial_clean.duckdb` file. Relative paths are
resolved from the working directory; run commands from this repository root.
The database and `.env` are ignored by Git.

Set `API_KEY` in `.env` to a secret of at least 32 characters (generate one with
`openssl rand -hex 32`). Startup fails if this secret is missing.

Run `npm run dev`. The default port is 3001; override it with `PORT`.

- `GET /health` returns `{"status":"ok"}` for server liveness.
- `GET /health/db` returns `{"status":"ok","database":"ok"}` after querying
  the expected `property_coverage` view, or HTTP 503 if the check fails.

Startup requires a readable, existing database with populated `property_coverage`.
The API opens it read-only and fails startup for missing or incompatible files.
Close any other DuckDB client holding a writer connection before starting the API.
Stop the API before rebuilding or replacing the database; restart it afterward.
The health routes do not return property records.

## Build and run

Run `npm run build`, then `npm start`.

## Render configuration

Deploy as a Web Service. Use `npm ci && npm run build` as the build command and
`npm start` as the start command. Attach a persistent disk at `/var/data`, transfer
the database to `/var/data/commercial_clean.duckdb`, and set `DUCKDB_PATH` to that
path in the service environment. Render supplies `PORT`. Use `/health/db` as the
health check path. The disk must contain the database before the API can start.

## Data endpoints

All data routes require the `X-API-Key` header, matching the server's `API_KEY`.
Health routes remain public for service monitoring.

- `GET /properties/:id` returns property details and coverage counts as `{data: {...}}`.
- `GET /properties/:id/tenants?limit=50&offset=0` returns tenant records.
- `GET /properties/:id/deals?limit=50&offset=0` returns rent and lease evidence.

Property IDs must be positive safe integers. Lists accept `limit` from 1 to 100
(default 50) and `offset` from 0 to 100000 (default 0). Unknown query parameters
are rejected. Lists return `{data: [...], pagination: {limit, offset, has_more,
next_offset}}`. Missing properties return 404; existing properties with no matching
records return an empty list. Invalid input returns 400, a missing/incorrect key
returns 401, and database errors return a generic 500 response.

BIGINT values are serialized as decimal strings by the DuckDB JSON converter.
Tenant records retain their snapshot `as_of_date`, status, and review reasons;
they do not establish real-time occupancy. Deals include asking and other rent
kinds as well as recorded lease evidence: check `rent_kind`, `is_usable`, currency,
and normalization fields before comparisons. Do not count evidence rows as unique
lease deals; retain `lease_deal_key` and `counting_basis` when aggregating.

Authenticated data requests have a shared, process-wide budget of 120 requests
per minute and at most 4 concurrent requests (HTTP 429 with Retry-After). This
budget is shared by all callers using the service and resets on restart.
There is no endpoint for executing arbitrary SQL.

### Calling from Next.js

Set `BACKEND_API_URL` and `BACKEND_API_KEY` in your Next.js server environment.
Use the same secret for `BACKEND_API_KEY` and this service's `API_KEY`. Never
prefix the key with `NEXT_PUBLIC_` or send it to the browser.

```ts
// In a server component or server route only.
const response = await fetch(
  `${process.env.BACKEND_API_URL}/properties/23296/tenants?limit=25`,
  {
    headers: { "X-API-Key": process.env.BACKEND_API_KEY! },
    cache: "no-store",
  },
);
if (!response.ok) throw new Error("Could not retrieve tenants");
const result = await response.json();
```

Configure `API_KEY` in Render's environment as well as `DUCKDB_PATH` before
starting the service. The local `.env` contains a generated development key;
use a separate generated secret for production.

## Verification

Run `npm test` for build, authentication, input validation, pagination, rate-limit,
and error-response checks. Tests use an injected database stub and no private
source data. The endpoints have also been manually checked against the local
commercial DuckDB database.
