import assert from "node:assert/strict";

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const cases: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

export async function run(): Promise<void> {
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      process.stdout.write(`  ok - ${c.name}\n`);
    } catch (error) {
      failures.push({ name: c.name, error });
      process.stdout.write(`  FAIL - ${c.name}\n`);
    }
  }
  process.stdout.write(`\n${passed}/${cases.length} passed\n`);
  if (failures.length) {
    for (const f of failures) {
      process.stdout.write(`\n--- FAIL: ${f.name}\n`);
      process.stdout.write(`${(f.error as Error)?.stack ?? String(f.error)}\n`);
    }
    process.exitCode = 1;
  }
}

export const approx = (actual: number, expected: number, tol = 1e-6, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ~${expected}, got ${actual}`);

export { assert };
