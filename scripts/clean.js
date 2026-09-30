// Manage only this project's generated files and its own demo API process.
import { rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = resolve(root, "tmp", "server.pid");

function stopOwnServer() {
  if (!existsSync(pidFile)) return;
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      // tree-kill is unnecessary: we started the node process ourselves.
      process.kill(pid);
      console.log(`stopped project API pid ${pid}`);
    }
  } catch (e) {
    if (e.code !== "ESRCH") console.warn(`could not stop pid: ${e.message}`);
  }
}

for (const p of ["dist", "tmp", "data"]) {
  const target = resolve(root, p);
  if (!target.startsWith(root)) throw new Error(`refuse to clean outside project: ${target}`);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
stopOwnServer();
console.log("cleaned dist/, tmp/, data/ (project-owned only)");
