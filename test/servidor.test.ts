import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("arquivo inexistente devolve 404 e o servidor continua no ar", async (t) => {
  const porta = "4611";
  const filho = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/servidor.ts"], {
    env: { ...process.env, PORTA: porta, BANCO: join(mkdtempSync(join(tmpdir(), "pedidos-")), "t.db") },
    stdio: "ignore",
  });
  t.after(() => filho.kill());
  const base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/painel`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 404);
  assert.equal((await fetch(`${base}/api/painel`)).status, 200);
});
