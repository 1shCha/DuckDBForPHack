import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DuckDBValue } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";

export async function openDatabase(configuredPath: string | undefined) {
  if (!configuredPath?.trim()) {
    throw new Error("Set DUCKDB_PATH to an existing DuckDB file in .env or the server environment.");
  }

  const path = resolve(configuredPath);
  const file = await stat(path);
  if (!file.isFile()) {
    throw new Error("DUCKDB_PATH must point to a database file.");
  }

  // Never create an empty database or modify the supplied data.
  const instance = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });

  async function check() {
    const connection = await instance.connect();
    try {
      // Check the expected dataset, rather than only the SQL engine.
      const result = await connection.runAndReadAll(
        "SELECT property_id FROM property_coverage LIMIT 1",
      );
      try {
        if (result.getRowObjectsJson().length === 0) {
          throw new Error("The property_coverage view contains no properties.");
        }
      } finally {
        result.closeSync();
      }
    } finally {
      connection.closeSync();
    }
  }

  try {
    await check();
  } catch (error) {
    instance.closeSync();
    throw error;
  }

  async function query(sql: string, values: DuckDBValue[] = []) {
    const connection = await instance.connect();
    try {
      const result = await connection.runAndReadAll(sql, values);
      try {
        return result.getRowObjectsJson();
      } finally {
        result.closeSync();
      }
    } finally {
      connection.closeSync();
    }
  }

  return { check, query, close: () => instance.closeSync() };
}
