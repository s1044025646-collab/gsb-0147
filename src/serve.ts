// Server entry point. Data and the listening socket stay inside this project;
// the server binds only to 127.0.0.1 on an OS-assigned free port and writes the
// port to data/server.port for local tooling.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, createRepo } from "./db.ts";
import { createService } from "./service.ts";
import { createApp, listenLocal } from "./api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const dbPath = process.env.CTM_DB ?? join(projectRoot, "data", "ctm.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const service = createService(createRepo(db));
const server = createApp({ service });

const preferred = process.env.CTM_PORT ? Number(process.env.CTM_PORT) : 0;
const { port, close } = await listenLocal(server, preferred);
writeFileSync(join(projectRoot, "data", "server.port"), String(port), "utf-8");
console.log(`CTM API listening on http://127.0.0.1:${port} (db: ${dbPath})`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`received ${signal}, shutting down ...`);
  await close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
