# Purpose: install the portable Claude Code setup on Windows (PowerShell 5.1+ or 7).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-NoPlugins] [-NoTools]
# Invariants: never deletes; replaced items go to ~\.claude-backup-<stamp>\. Symlinks need Developer Mode;
# otherwise items are copied and a warning is printed. Mirrors scripts/install.sh.
param([switch]$DryRun, [switch]$NoPlugins, [switch]$NoTools)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$ClaudeDir = Join-Path $HOME '.claude'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $HOME ".claude-backup-$Stamp"
$Links = @('CLAUDE.md', 'rules', 'skills', 'agents', 'standards', 'hooks', 'tools', 'statusline.mjs')
$Done = New-Object System.Collections.Generic.List[string]

function Note($msg) { $Done.Add($msg); Write-Host "  $msg" }

function Backup($target) {
  if (-not (Test-Path $target)) { return }
  if ($DryRun) { Write-Host "[dry-run] backup $target"; return }
  New-Item -ItemType Directory -Force $BackupDir | Out-Null
  Move-Item $target (Join-Path $BackupDir (Split-Path $target -Leaf))
  Note "backed up $(Split-Path $target -Leaf) -> $BackupDir"
}

function Link-Item($name) {
  $src = Join-Path $Repo "home\$name"
  $dst = Join-Path $ClaudeDir $name
  $existing = Get-Item $dst -Force -ErrorAction SilentlyContinue
  if ($existing -and $existing.LinkType -eq 'SymbolicLink' -and $existing.Target -eq $src) { Note "ok $name"; return }
  Backup $dst
  if ($DryRun) { Write-Host "[dry-run] link $name"; return }
  try {
    New-Item -ItemType SymbolicLink -Path $dst -Target $src | Out-Null
    Note "linked $name"
  } catch {
    Write-Warning "symlink failed for $name (enable Developer Mode); copying instead"
    Copy-Item $src $dst -Recurse
    Note "copied $name (not live-linked)"
  }
}

# Deep merge b into a (b wins); hashtables recurse, everything else is replaced.
function Merge-Json($a, $b) {
  foreach ($key in $b.Keys) {
    if ($a.ContainsKey($key) -and $a[$key] -is [hashtable] -and $b[$key] -is [hashtable]) {
      $a[$key] = Merge-Json $a[$key] $b[$key]
    } else { $a[$key] = $b[$key] }
  }
  return $a
}

function Read-Json($path) { Get-Content $path -Raw | ConvertFrom-Json -AsHashtable }

function Build-Settings {
  $merged = Read-Json (Join-Path $Repo 'settings\base.json')
  foreach ($f in @('windows.json', 'local.json')) {
    $p = Join-Path $Repo "settings\$f"
    if (Test-Path $p) { $merged = Merge-Json $merged (Read-Json $p) }
  }
  $json = $merged | ConvertTo-Json -Depth 20
  $json = $json.Replace('{{CLAUDE_HOME}}', ($ClaudeDir -replace '\\', '/'))
  $out = Join-Path $ClaudeDir 'settings.json'
  if ($DryRun) { Write-Host "[dry-run] would write $out"; return }
  Backup $out
  Set-Content -Path $out -Value $json -Encoding UTF8
  Note 'wrote settings.json'
}

# Install ui-check's dependencies from its lockfile; plain install when there is none yet.
function Install-ToolDeps {
  $dir = Join-Path $ClaudeDir 'tools\ui-check'
  $src = Join-Path $Repo 'home\tools\ui-check'
  if ($DryRun) { Write-Host "[dry-run] install ui-check dependencies in $dir"; return }
  if (-not (Test-Path $dir)) { Write-Warning "skip ui-check deps: $dir not found"; return }
  if ((Test-Path (Join-Path $src 'pnpm-lock.yaml')) -and (Get-Command pnpm -ErrorAction SilentlyContinue)) { pnpm --dir $dir install --frozen-lockfile }
  elseif (Test-Path (Join-Path $src 'package-lock.json')) { npm ci --prefix $dir }
  else { npm install --prefix $dir --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw 'ui-check dependency install failed' }
  Note 'ui-check dependencies'
}

function Install-Plugins {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) { Write-Host 'claude CLI not found. Manual: run /plugin and add the items in plugins\plugins.json.'; return }
  $m = Read-Json (Join-Path $Repo 'plugins\plugins.json')
  foreach ($mk in $m.marketplaces) {
    if ($mk.source -like 'github:*') {
      if (-not $DryRun) { claude plugin marketplace add ($mk.source -replace '^github:', '') }
      Note "marketplace $($mk.name)"
    }
  }
  foreach ($id in ($m.enabled + $m.disabled)) {
    if ($id -like '*@gitkraken') { continue }
    if (-not $DryRun) { claude plugin install $id }
    Note "plugin $id"
  }
}

try {
  if (-not $DryRun) { New-Item -ItemType Directory -Force $ClaudeDir | Out-Null }
  foreach ($n in $Links) { Link-Item $n }
  Build-Settings
  if (Test-Path (Join-Path $Repo '.git')) {
    if (-not $DryRun) { git -C $Repo config core.hooksPath .githooks }
    Note 'git hooksPath = .githooks'
  }
  if (-not $NoTools) { Install-ToolDeps }
  if (-not $NoPlugins) { Install-Plugins }
} catch {
  Write-Error "FAILED: $_`nAlready done:`n  $($Done -join "`n  ")"
  exit 1
}
Write-Host "Completed:`n  $($Done -join "`n  ")"
