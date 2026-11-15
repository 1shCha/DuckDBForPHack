import { openDatabase } from "./database.js";

type Database = Awaited<ReturnType<typeof openDatabase>>;

export class DatabaseUnavailableError extends Error {
  constructor() {
    super("Database is not ready");
  }
}

export async function createDatabaseService(path: string | undefined, setupMode: boolean) {
  if (!path?.trim()) throw new Error("Set DUCKDB_PATH to the database file path.");
  let database: Database | undefined;
  let opening: Promise<Database> | undefined;
  let closed = false;

  async function ensureOpen() {
    if (closed) throw new DatabaseUnavailableError();
    if (database) return database;
    opening ??= openDatabase(path);
    try {
      database = await opening;
      return database;
    } finally {
      opening = undefined;
    }
  }

  try {
    await ensureOpen();
  } catch (error) {
    // Setup mode tolerates only an absent file. Invalid files/configuration still fail startup.
    if (!setupMode || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    console.log("Database setup mode: waiting for the database upload. /health/db returns 503 until ready.");
  }

  async function ready() {
    try {
      return await ensureOpen();
    } catch {
      throw new DatabaseUnavailableError();
    }
  }

  return {
    check: async () => (await ready()).check(),
    query: async (...args: Parameters<Database["query"]>) => (await ready()).query(...args),
    close: () => { closed = true; database?.close(); },
  };
}
