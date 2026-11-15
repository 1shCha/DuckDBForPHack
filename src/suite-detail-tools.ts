import type { openDatabase } from "./database.js";
import { ToolValidationError } from "./costar-tools.js";

type Query = Awaited<ReturnType<typeof openDatabase>>["query"];

// Street address from the properties.address JSON, e.g. "6655 Travis St".
const STREET = `trim(concat_ws(' ', json_extract_string(p.address, '$.streetNumber'), json_extract_string(p.address, '$.streetDirection'),
  json_extract_string(p.address, '$.streetName'), json_extract_string(p.address, '$.streetType')))`;
// Great-circle distance in miles between (?, ?) and the property.
const MILES = `3958.8 * 2 * asin(sqrt(power(sin(radians(p.latitude - ?) / 2), 2) +
  cos(radians(?)) * cos(radians(p.latitude)) * power(sin(radians(p.longitude - ?) / 2), 2)))`;

function propertyId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value)) throw new ToolValidationError("property_id must be a positive integer string.");
  return value;
}

function coordinate(value: unknown, name: string, limit: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new ToolValidationError(`${name} must be a finite number between -${limit} and ${limit}.`);
  }
  return value;
}

function optionalSqft(value: unknown, name: string) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e7) {
    throw new ToolValidationError(`${name} must be a number from 0 to 10000000.`);
  }
  return value;
}

export function createSuiteDetailTools(query: Query) {
  return {
    /** Current tenants of one building (who the neighbors would be). */
    get_building_tenants: async (input: { property_id?: unknown }) => {
      const id = propertyId(input.property_id);
      const rows = await query(`
        SELECT t.company_name, t.resolved_industry_label AS industry, t.company_suite AS suite,
          t.occupied_sqft, t.num_employees, t.tenant_status, t.lease_expiration_date_local AS lease_expiration,
          t.days_until_lease_expiration, t.source_dataset, t.source_line
        FROM tenants_current t
        WHERE t.property_id = ?::BIGINT AND t.company_name IS NOT NULL
        ORDER BY t.occupied_sqft DESC NULLS LAST, t.company_name
        LIMIT 101`, [id]);
      return { property_id: id, truncated: rows.length > 100, tenants: rows.slice(0, 100) };
    },

    /** Usable asking and signed rents in one building, newest first, plus signed deals nearby. */
    get_rent_comps: async (input: { property_id?: unknown; radius_miles?: unknown }) => {
      const id = propertyId(input.property_id);
      const radius = input.radius_miles == null ? 2 : coordinate(input.radius_miles, "radius_miles", 10);
      if (radius <= 0) throw new ToolValidationError("radius_miles must be greater than 0.");
      const building = await query(`
        SELECT d.rent_kind, d.annual_rent_per_sqft_low AS rent_psf_yr, d.service_type_label AS service_type,
          strftime(d.signed_date, '%Y-%m-%d') AS signed_date, d.free_months, d.ti_allowance_per_sqft AS ti_psf,
          d.source_dataset, d.source_line
        FROM deals_normalized d
        WHERE d.property_id = ?::BIGINT AND d.is_usable AND d.is_usd_comparable
          AND d.normalization_status = 'normalized' AND d.rent_kind IN ('asking', 'actual')
          AND d.annual_rent_per_sqft_low IS NOT NULL
        ORDER BY d.signed_date DESC NULLS LAST
        LIMIT 30`, [id]);
      const nearby = await query(`
        WITH here AS (SELECT latitude AS lat, longitude AS lon FROM properties WHERE property_id = ?::BIGINT),
        near AS (
        SELECT ${STREET} AS address, p.building_name, d.annual_rent_per_sqft_low AS rent_psf_yr,
          d.service_type_label AS service_type, strftime(d.signed_date, '%Y-%m-%d') AS signed_date,
          d.free_months, d.ti_allowance_per_sqft AS ti_psf, d.source_dataset, d.source_line,
          round(3958.8 * 2 * asin(sqrt(power(sin(radians(p.latitude - h.lat) / 2), 2) +
            cos(radians(h.lat)) * cos(radians(p.latitude)) * power(sin(radians(p.longitude - h.lon) / 2), 2))), 2) AS distance_mi
        FROM deals_normalized d JOIN properties p USING (property_id), here h
        WHERE d.property_id <> ?::BIGINT AND d.rent_kind = 'actual' AND d.is_usable AND d.is_usd_comparable
          AND d.normalization_status = 'normalized' AND d.annual_rent_per_sqft_low IS NOT NULL
          AND p.latitude BETWEEN h.lat - ? / 69.0 AND h.lat + ? / 69.0)
        SELECT * FROM near WHERE distance_mi <= ?
        ORDER BY signed_date DESC NULLS LAST
        LIMIT 15`, [id, id, radius, radius, radius]);
      return { property_id: id, building, nearby };
    },

    /** Companies nearby in the given industries whose leases end within the next 24 months. */
    find_expiring_leases: async (input: {
      latitude?: unknown; longitude?: unknown; industries?: unknown; sqft_min?: unknown; sqft_max?: unknown; radius_miles?: unknown;
    }) => {
      const lat = coordinate(input.latitude, "latitude", 85);
      const lon = coordinate(input.longitude, "longitude", 180);
      const radius = input.radius_miles == null ? 5 : coordinate(input.radius_miles, "radius_miles", 25);
      if (radius <= 0) throw new ToolValidationError("radius_miles must be greater than 0.");
      const industries = input.industries ?? [];
      if (!Array.isArray(industries) || industries.length > 10 ||
          industries.some((v) => typeof v !== "string" || !v.trim() || v.length > 80)) {
        throw new ToolValidationError("industries must be up to 10 short strings.");
      }
      if (industries.some((v: string) => v.includes("|"))) throw new ToolValidationError("industries cannot contain '|'.");
      const joined = (industries as string[]).join("|");
      const lo = optionalSqft(input.sqft_min, "sqft_min");
      const hi = optionalSqft(input.sqft_max, "sqft_max");
      if (lo !== null && hi !== null && lo > hi) throw new ToolValidationError("sqft_min cannot exceed sqft_max.");
      const rows = await query(`
        WITH near AS (
        SELECT t.company_name, t.resolved_industry_label AS industry, t.occupied_sqft, t.num_employees,
          t.lease_expiration_date_local AS lease_expiration, t.days_until_lease_expiration,
          ${STREET} AS address, p.building_name, p.city,
          round(${MILES}, 2) AS distance_mi, t.source_dataset, t.source_line
        FROM tenants_current t JOIN properties p USING (property_id)
        WHERE t.company_name IS NOT NULL
          AND t.days_until_lease_expiration BETWEEN 0 AND 730
          AND p.latitude BETWEEN ? - ? / 69.0 AND ? + ? / 69.0
          AND (?::VARCHAR = '' OR list_contains(string_split(?::VARCHAR, '|'), t.resolved_industry_label))
          AND (?::DOUBLE IS NULL OR t.occupied_sqft >= ?::DOUBLE * 0.7)
          AND (?::DOUBLE IS NULL OR t.occupied_sqft <= ?::DOUBLE * 1.4))
        SELECT * FROM near WHERE distance_mi <= ?
        ORDER BY days_until_lease_expiration, distance_mi
        LIMIT 15`,
        [lat, lat, lon, lat, radius, lat, radius, joined, joined, lo, lo, hi, hi, radius]);
      return { radius_miles: radius, companies: rows };
    },
  };
}
