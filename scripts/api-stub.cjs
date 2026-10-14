// Запуск сервера-заглушки (scripts/api-stub.py) из проверки в браузере — в том же процессе, что и браузер.
// Сайт для проверки собирается с адресом заглушки: VITE_API_URL=http://127.0.0.1:8765 npm --prefix web run build
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8765;

function python() {
  if (process.env.API_STUB_PYTHON) return process.env.API_STUB_PYTHON;
  const venv = path.join(ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return fs.existsSync(venv) ? venv : "python";
}

async function startApiStub() {
  const proc = spawn(python(), [path.join(ROOT, "scripts", "api-stub.py"), String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return { url, stop: () => proc.kill() };
    } catch { /* ещё поднимается */ }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`заглушка API не поднялась:\n${out}`);
}

module.exports = { startApiStub };
