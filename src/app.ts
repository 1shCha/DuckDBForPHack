import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import type { openDatabase } from "./database.js";

type Database = Awaited<ReturnType<typeof openDatabase>>;

export function createApp(database: Database, apiKey: string) {
  if (apiKey.length < 32) throw new Error("API_KEY must contain at least 32 characters.");
  const expectedKey = createHash("sha256").update(apiKey).digest();
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/health/db", async (_request, response) => {
    try {
      await database.check();
      response.json({ status: "ok", database: "ok" });
    } catch {
      response.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  // One shared server-to-server key; apply a bounded, process-wide request budget.
  let windowStart = Date.now();
  let requests = 0;
  let active = 0;
  app.use("/properties", (request, response, next) => {
    const provided = createHash("sha256").update(request.get("X-API-Key") ?? "").digest();
    if (!timingSafeEqual(expectedKey, provided)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
    if (++requests > 120 || active >= 4) {
      response.set("Retry-After", "60").status(429).json({ error: "Too many requests" });
      return;
    }
    active++;
    // Keep the slot until the handler finishes, even if the client disconnects.
    response.locals.release = () => { active--; };
    next();
  });

  function integer(value: unknown, fallback: number, max: number) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number <= max ? number : null;
  }

  const propertySql = `SELECT p.property_id, p.building_name, p.property_type_label,
    p.address, p.city, p.state, p.postal_code, p.latitude, p.longitude,
    p.gross_building_area_sqft, p.rentable_building_area_sqft, p.num_stories,
    p.source_dataset, p.source_line, c.occupancy_count, c.listing_count,
    c.linked_scan_count FROM properties p
    LEFT JOIN property_coverage c USING (property_id) WHERE p.property_id = ?`;
  const tenantSql = `SELECT occupancy_id, property_id, company_location_id,
    company_name, resolved_industry_label, industry_source, as_of_date,
    tenant_status, requires_review, review_reasons, occupied_sqft, size_status,
    num_employees, business_status_label, occupancy_start_date, occupancy_end_date,
    lease_expiration_date_local, days_until_lease_expiration, suite_associations,
    source_dataset, source_line FROM tenants_current WHERE property_id = ?
    ORDER BY occupancy_id, source_dataset, source_line LIMIT ? OFFSET ?`;
  const dealSql = `SELECT evidence_id, property_id, occupancy_id, listing_id,
    rent_kind, amount_low, amount_high, currency_label, period_label,
    measurement_label, service_type_label, is_usable, normalization_status,
    normalization_reason, annual_rent_per_sqft_low, annual_rent_per_sqft_high,
    is_usd_comparable, signed_date, signing_year, free_months,
    ti_allowance_per_sqft, term_quality_issues, lease_deal_key, counting_basis,
    source_dataset, source_line, field_path FROM deals_normalized
    WHERE property_id = ? ORDER BY evidence_id LIMIT ? OFFSET ?`;

  function route(kind: "property" | "tenants" | "deals") {
    return async (request: Request, response: express.Response) => {
      try {
        const id = integer(request.params.id, 0, Number.MAX_SAFE_INTEGER);
        const limit = integer(request.query.limit, 50, 100);
        const offset = integer(request.query.offset, 0, 100_000);
        const allowed = kind === "property" ? [] : ["limit", "offset"];
        if (!id || limit === null || limit < 1 || offset === null ||
            Object.keys(request.query).some(key => !allowed.includes(key))) {
          response.status(400).json({ error: "Use a positive integer property ID, limit 1–100, and offset 0–100000; no other query parameters are supported." });
          return;
        }
        const property = await database.query(propertySql, [id]);
        if (!property.length) {
          response.status(404).json({ error: "Property not found" });
          return;
        }
        if (kind === "property") {
          response.json({ data: property[0] });
          return;
        }
        const rows = await database.query(kind === "tenants" ? tenantSql : dealSql, [id, limit + 1, offset]);
        const hasMore = rows.length > limit;
        response.json({
          data: rows.slice(0, limit),
          pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null },
        });
      } finally {
        response.locals.release();
      }
    };
  }
  app.get("/properties/:id", route("property"));
  app.get("/properties/:id/tenants", route("tenants"));
  app.get("/properties/:id/deals", route("deals"));
  // Release slots for authenticated requests that matched no route.
  app.use("/properties", (_request, response) => {
    response.locals.release?.();
    response.status(404).json({ error: "Route not found" });
  });
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error("API query failed:", error instanceof Error ? error.message : "Unknown error");
    response.status(500).json({ error: "Unable to retrieve data" });
  };
  app.use(handleError);
  return app;
}
