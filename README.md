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

Normal startup requires a readable, existing database with populated `property_coverage`.
The API opens it read-only and fails startup for missing or incompatible files.
For the first cloud upload, the explicit setup mode below permits an absent file.
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
health check path after the initial upload. See the first-upload procedure below.

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

## First upload to Render

The initial persistent disk is empty. For this first deployment only:

1. Ensure the paid service has a disk mounted at `/var/data`.
2. Set `DATABASE_SETUP_MODE=true` in Render's environment settings. Keep
   `DUCKDB_PATH=/var/data/commercial_clean.duckdb` and your private `API_KEY`.
3. Set the health check path to `/health` in the service settings, and deploy the
   latest commit. The server will run while `/health/db` and authenticated data
   routes return 503 until the database is available.
4. Configure an SSH public key in your Render account, and obtain the service's
   SSH destination from **Connect → SSH**. Render documents this at
   https://render.com/docs/ssh. Upload to the running service (not an ephemeral
   shell, which does not share the persistent disk).
5. Close any local database writer before copying. From your Mac, upload the file
   to a temporary filename so the API cannot open a partial upload. Replace
   `USER@HOST` below with the destination from Render's SSH command:

   ```sh
   scp "/Users/ishaanchakraborty/Desktop/CostarRelated/costar-hackathon-kit/consolidated-db/processed/commercial_clean.duckdb" USER@HOST:/var/data/commercial_clean.duckdb.upload
   ```

6. In the service's dashboard Shell, run:

   ```sh
   mv /var/data/commercial_clean.duckdb.upload /var/data/commercial_clean.duckdb
   ```

7. Visit `/health/db`. It should return HTTP 200 with `database: "ok"`; the next
   database request automatically opens the completed file read-only.
8. Set `DATABASE_SETUP_MODE=false`, restore the deployment health check to
   `/health/db`, and redeploy. Subsequent restarts require the existing database.

`render.yaml` enables first-upload setup mode and uses `/health` initially. A
service created manually in the dashboard needs these settings applied manually.
Setup mode never creates an empty database, exposes SQL, or bypasses API keys.
Invalid existing databases still fail the initial startup check.

## Next.js database tools

The Next.js app now uses these authenticated, fixed operations via POST:

- `/tools/find_properties`: `{query, city?, state?, limit?, offset?}`
- `/tools/find_suites`: `{property_id, suite?, property_floor_id?, limit?, offset?}`
- `/tools/get_tenant_history`: `{suite_id}`
- `/tools/get_spatial_context`: `{property_id, suite_id?}`
- `/tools/database_health`: `{}`

Use `X-API-Key` on every operation. Responses preserve the app's existing
property/suite pagination, supported vs. candidate history, issues, and source
references. No arbitrary SQL endpoint is provided. Property/floor IDs in these
tools are decimal BIGINT strings; suite IDs are 64-character hexadecimal strings.
Bodies are limited to 16 KB, strings to 300 characters, list limits to 100, and
pagination offsets to 100000. Unknown fields/operations and invalid input are
rejected. Tools share the same authenticated rate/concurrency budget as the
property routes. The app's backend client applies a 20-second timeout.

The Next.js server reads `BACKEND_API_URL` and `BACKEND_API_KEY` directly. When
configured it uses these operations and does not fall back to local data on an
API error. Local DuckDB is only used by its tools when both backend settings are
absent. No environment changes are needed for an app already configured with
this service's URL and matching key.

The target app branch's tenant search also uses `/tools/search_candidates`
with `{sqft_min?, sqft_max?, city?}`. It preserves the original 15% size slack,
rent/history joins, and suite scan associations. The app keeps its own business
profile scoring, saved inspection data, result ordering, and UI. Size bounds
must be finite nonnegative numbers no greater than 1e9; results are bounded to
10000 candidates and broad oversized requests are rejected instead of truncated.
