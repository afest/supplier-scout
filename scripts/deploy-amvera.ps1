# Выкладка серверной части на Amvera: собирает чистую копию нужных файлов и отправляет её в git Amvera.
# История репозитория туда не уходит — только текущие файлы одним коммитом. Amvera пересобирает проект сама (~2 минуты).
# Запуск: powershell -File scripts\deploy-amvera.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$remote = "https://git.msk1.amvera.ru/afest/supplier-scout-api"
$out = Join-Path $env:TEMP "supplier-scout-amvera"

# Что едет на сервер. Набор data/suppliers.json — ниже, отдельным шагом.
$files = @("amvera.yaml", "requirements.txt", "data\categories.json")
$dirs = @("api", "pipeline")

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory $out | Out-Null
foreach ($f in $files) {
    $dst = Join-Path $out $f
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    Copy-Item (Join-Path $repo $f) $dst
}
foreach ($d in $dirs) {
    robocopy (Join-Path $repo $d) (Join-Path $out $d) /E /XD __pycache__ .cache /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "Не скопировалась папка $d (robocopy $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

# Набор: живому сбору он нужен для оценок ◇, отзывам — как список поставщиков. Пока ПДн ИП не вычищены (T-535) — без ИП.
$py = Join-Path $repo ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "C:\Users\1\AppData\Local\Programs\Python\Python312\python.exe" }
& $py (Join-Path $PSScriptRoot "server_set.py") (Join-Path $repo "data\suppliers.json") (Join-Path $out "data\suppliers.json")
if ($LASTEXITCODE -ne 0) { Write-Host "Набор для сервера не собрался." -ForegroundColor Red; exit 1 }

$src = git -C $repo rev-parse --short HEAD
$dirty = if (git -C $repo status --porcelain) { " + незакоммиченные правки" } else { "" }
git -C $out init -q -b master
git -C $out add -A
git -C $out -c user.name=afest -c user.email=afest@users.noreply.github.com commit -q -m "deploy: supplier-scout $src$dirty, $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
git -C $out push --force $remote master
if ($LASTEXITCODE -ne 0) { Write-Host "Отправка в Amvera не прошла." -ForegroundColor Red; exit 1 }
Write-Host "Отправлено. Сборка идёт в кабинете Amvera: supplier-scout-api → Логи сборки." -ForegroundColor Green
