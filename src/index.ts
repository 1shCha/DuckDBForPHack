import "dotenv/config";
import { createApp } from "./app.js";
import { createDatabaseService } from "./database-service.js";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const apiKey = process.env.API_KEY ?? "";
if (apiKey.length < 32) throw new Error("Set API_KEY to a secret with at least 32 characters.");

const setupValue = process.env.DATABASE_SETUP_MODE ?? "false";
if (setupValue !== "true" && setupValue !== "false") {
  throw new Error("DATABASE_SETUP_MODE must be true or false.");
}
const database = await createDatabaseService(process.env.DUCKDB_PATH, setupValue === "true");

const app = createApp(database, apiKey);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`API listening on port ${port}`);
});

server.on("error", (error) => {
  database.close();
  console.error("API failed to start:", error.message);
  process.exitCode = 1;
});

function shutdown() {
  server.close((error) => {
    database.close();
    if (error) {
      console.error("API failed to shut down:", error.message);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
