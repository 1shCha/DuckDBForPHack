import type { openDatabase } from "./database.js";
import { ToolValidationError } from "./costar-tools.js";

export function createSearchCandidates(query: Awaited<ReturnType<typeof openDatabase>>["query"]) {
  return async (input: { sqft_min?: number | null; sqft_max?: number | null; city?: string | null }) => {
    for (const value of [input.sqft_min, input.sqft_max]) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9)) {
        throw new ToolValidationError("Square-foot bounds must be finite numbers from 0 to 1000000000.");
      }
    }
    if (input.sqft_min != null && input.sqft_max != null && input.sqft_min > input.sqft_max) {
      throw new ToolValidationError("Minimum size cannot exceed maximum size.");
    }
    if (input.city != null && (typeof input.city !== "string" || !input.city.trim() || input.city.length > 100)) {
      throw new ToolValidationError("city must be a nonempty string of at most 100 characters.");
    }
    const lo = input.sqft_min != null ? input.sqft_min * 0.85 : 0;
    const hi = input.sqft_max != null ? input.sqft_max * 1.15 : 1e9;
    const city = input.city ?? null;
    const rows = await query(`
    WITH listed AS (
      SELECT suite_id, max(coalesce(square_feet_max, square_feet_min)) AS sqft
      FROM suite_listing_links GROUP BY suite_id),
    picked AS (
      SELECT s.suite_id, s.suite_normalized AS suite, s.city, l.sqft, s.property_id, p.building_name, p.property_type_label AS property_type,
        p.latitude, p.longitude,
        trim(concat_ws(' ', json_extract_string(p.address, '$.streetNumber'), json_extract_string(p.address, '$.streetDirection'),
          json_extract_string(p.address, '$.streetName'), json_extract_string(p.address, '$.streetType'))) AS street
      FROM listed l JOIN suites s USING (suite_id) JOIN properties p USING (property_id)
      WHERE l.sqft BETWEEN ? AND ? AND (?::VARCHAR IS NULL OR lower(s.city) = lower(?::VARCHAR))),
    scan AS (
      SELECT pk.suite_id, list(DISTINCT m.model_id ORDER BY m.model_id) AS model_ids
      FROM picked pk JOIN property_models pm ON pm.property_id = pk.property_id JOIN matterport_models m USING (model_id)
      WHERE normalize_suite(m.name) = pk.suite AND m.room_count > 1 GROUP BY pk.suite_id),
    asking AS (
      SELECT dl.suite_id, median(r.annual_per_sqft_low) AS asking
      FROM suite_deal_links dl JOIN rent_evidence r USING (evidence_id)
      WHERE dl.match_status = 'supported' AND r.rent_kind = 'asking' AND r.is_usable AND r.period_label = 'Yearly'
      GROUP BY dl.suite_id),
    signed AS (
      SELECT property_id, median(annual_per_sqft_low) AS signed, count(*) AS n_signed FROM rent_evidence
      WHERE rent_kind = 'actual' AND is_usable AND period_label = 'Yearly' GROUP BY property_id),
    past AS (
      SELECT suite_id, list({company: company_name, industry: resolved_industry_label,
        "from": strftime(timeline_start, '%Y-%m-%d'), "to": strftime(to_date, '%Y-%m-%d')} ORDER BY timeline_start) AS past
      FROM suite_history GROUP BY suite_id)
    SELECT pk.suite_id, pk.property_id, pk.suite, pk.city, pk.sqft, pk.building_name, pk.street, pk.property_type, pk.latitude, pk.longitude,
      sc.model_ids, a.asking, sg.signed, sg.n_signed, ps.past
    FROM picked pk LEFT JOIN scan sc USING (suite_id) LEFT JOIN asking a USING (suite_id)
      LEFT JOIN signed sg ON sg.property_id = pk.property_id LEFT JOIN past ps USING (suite_id)
    ORDER BY pk.suite_id LIMIT 10001`, [lo, hi, city, city]);
    if (rows.length > 10000) throw new ToolValidationError("Search is too broad; narrow the city or size range.");
    return rows;
  };
}
