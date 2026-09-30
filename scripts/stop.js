// Stop only the project API whose pid we recorded in tmp/server.pid.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = resolve(root, "tmp", "server.pid");
if (!existsSync(pidFile)) {
  console.log("no recorded project API process");
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, "utf8").trim());
try {
  process.kill(pid);
  console.log(`stopped project API pid ${pid}`);
} catch (e) {
  if (e.code !== "ESRCH") throw e;
  console.log(`pid ${pid} already stopped`);
} finally {
  rmSync(pidFile, { force: true });
}
