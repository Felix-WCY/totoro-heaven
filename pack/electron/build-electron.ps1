# Build the totoro-heaven Electron desktop app as a SINGLE-FILE portable EXE.
#
# Usage: .\pack\electron\build-electron.ps1
#        .\pack\electron\build-electron.ps1 -SkipPrepare   (reuse the current .output as-is)
#
# Output: dist\electron\totoro-heaven-<version>-portable.exe
#
# Pipeline:
#   [1/2] prepare .output with the SAME rules as the SEA build: it reuses
#         pack\sea\build-sea.ps1 -PrepareOnly (clean/stale checks, version-art trim, strip *.map).
#         This keeps ONE source of truth for "what may be packaged" (see package.json build.extraResources:
#         .output is copied OUTSIDE the asar to resources\output, because Electron's ESM loader cannot
#         import() from inside an asar).
#   [2/2] electron-builder --win portable --x64
#         -> one self-contained .exe (no installer, no side files). Electron itself is taken from the
#            already-installed node_modules\electron\dist (build.electronDist), so packaging does not
#            depend on downloading Electron again.
#
# NOTE: keep this file pure ASCII: Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI and can
# mangle non-ASCII comments (project rule / ERROR.md E3, E14).
#
# Electron version is pinned to 44.7.0 in package.json ON PURPOSE: Electron 45.0.0 crashes at startup
# on Windows 11 26H2 (0xc0000005 inside electron.exe, measured 2026-10-27), while 44.7.0 is the
# version the existing DeepSeek Harness desktop app runs on this machine. Do not bump without testing.
param(
    [switch]$SkipPrepare
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# electron-builder talks to GitHub by default. On networks where github.com is unreachable the
# npmmirror mirror works; keep any explicitly configured mirror untouched.
if (-not $env:ELECTRON_MIRROR) {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

if (-not $SkipPrepare) {
    Write-Host '[1/3] preparing .output (same rules as npm run sea)...'
    $prepare = Join-Path $root 'pack\sea\build-sea.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $prepare -PrepareOnly
    if ($LASTEXITCODE -ne 0) { throw "[1/3] prepare step failed (exit $LASTEXITCODE)" }
} else {
    Write-Host '[1/3] -SkipPrepare: reusing the current .output unchanged.'
}

# electron-builder's nsis.include is ignored for the portable target, so patch its portable.nsi
# template to set ELECTRON_DISABLE_SANDBOX=1 before launching the inner app (see the script header).
Write-Host '[2/3] patching electron-builder portable.nsi (sandbox compat)...'
& node (Join-Path $root 'pack\electron\patch-portable-nsis.mjs')
if ($LASTEXITCODE -ne 0) { throw "[2/3] portable.nsi patch failed (exit $LASTEXITCODE)" }

Write-Host '[3/3] electron-builder -> single-file portable exe...'
$builder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path $builder)) {
    throw "[3/3] electron-builder not found at $builder - run 'npm install' first."
}
& $builder --win portable --x64
if ($LASTEXITCODE -ne 0) { throw "[3/3] electron-builder failed (exit $LASTEXITCODE)" }

$outDir = Join-Path $root 'dist\electron'
$exe = Get-ChildItem $outDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $exe) { throw "[done] no portable exe produced under $outDir" }

$mb = [math]::Round($exe.Length / 1MB, 1)
Write-Host "[done] $($exe.FullName) ($mb MB)"
Write-Host '[done] This single .exe is the desktop build; the SEA browser build stays available via: npm run sea'
