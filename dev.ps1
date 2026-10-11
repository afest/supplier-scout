# Запуск прототипа на локальном сервере: ставит зависимости при первом запуске и открывает браузер.
# Остановить — Ctrl+C в этом окне.
$ErrorActionPreference = "Stop"
$web = Join-Path $PSScriptRoot "web"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Не найден npm: установите Node.js (https://nodejs.org) и запустите снова." -ForegroundColor Red
    exit 1
}

Set-Location $web
if (-not (Test-Path (Join-Path $web "node_modules"))) {
    Write-Host "Первый запуск: ставлю зависимости (около минуты)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install завершился с ошибкой." -ForegroundColor Red; exit 1 }
}

Write-Host ""
Write-Host "Прототип откроется в браузере. Если не открылся — откройте адрес из строки Local ниже" -ForegroundColor Green
Write-Host "(обычно http://127.0.0.1:5173). Остановить сервер: Ctrl+C в этом окне." -ForegroundColor Green
Write-Host ""
npm run dev -- --open
exit $LASTEXITCODE
