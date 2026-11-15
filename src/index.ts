import "dotenv/config";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const apiKey = process.env.API_KEY ?? "";
if (apiKey.length < 32) throw new Error("Set API_KEY to a secret with at least 32 characters.");

const database = await openDatabase(process.env.DUCKDB_PATH);

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
