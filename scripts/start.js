// Start THIS project's API bound to loopback on an OS-assigned free port,
// record its pid under tmp/, and print the chosen URL. Manages only the child
// node process it spawns.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = resolve(root, "tmp");
mkdirSync(tmp, { recursive: true });
const pidFile = resolve(tmp, "server.pid");
const portFile = resolve(tmp, "server.port");

if (existsSync(pidFile)) {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0);
    console.error("API already running (see tmp/server.pid). Stop it with: npm run stop");
    process.exit(1);
  } catch {}
}

const dbPath = resolve(root, "data", "app.db");
const child = spawn(
  process.execPath,
  ["--no-warnings=ExperimentalWarning", resolve(root, "dist", "api", "server.js")],
  {
    cwd: root,
    env: { ...process.env, CTM_DB: dbPath },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
writeFileSync(pidFile, String(child.pid));
child.stdout.on("data", (buf) => {
  const text = buf.toString();
  process.stdout.write(text);
  const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (m) writeFileSync(portFile, m[1]);
});
child.on("exit", (code) => process.exit(code ?? 0));
