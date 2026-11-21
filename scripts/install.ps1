# Purpose: install the portable Claude Code setup on Windows (PowerShell 5.1+ or 7).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-NoPlugins] [-NoTools] [-ProjectWorkflows <repo> [-Copy]]
# Invariants: never deletes; replaced items go to ~\.claude-backup-<stamp>\. Symlinks need Developer Mode;
# otherwise items are copied and a warning is printed. Mirrors scripts/install.sh.
param([switch]$DryRun, [switch]$NoPlugins, [switch]$NoTools, [string]$ProjectWorkflows = '', [switch]$Copy)
$ErrorActionPreference = 'Stop'
if ($Copy -and -not $ProjectWorkflows) { Write-Error '-Copy needs -ProjectWorkflows <repo>'; exit 2 }

$Repo = Split-Path -Parent $PSScriptRoot
$ClaudeDir = Join-Path $HOME '.claude'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $HOME ".claude-backup-$Stamp"
$Links = @('CLAUDE.md', 'rules', 'skills', 'agents', 'standards', 'hooks', 'tools', 'project-notes', 'modes', 'workflows', 'statusline.mjs')
# home/bin/ccm.ps1 is the PowerShell launcher and ccm.cmd its shim; Install-Launcher puts ccm.cmd in ~\.claude\bin
# (the PATH folder) and ccm.ps1 in ~\.claude\bin\ps so PowerShell cannot resolve it before the shim
# (home/bin/ccm is the bash one).
$Done = New-Object System.Collections.Generic.List[string]
$Failures = New-Object System.Collections.Generic.List[string]

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

# PowerShell 5.1 has no ConvertFrom-Json -AsHashtable: turn parsed PSCustomObjects into ordered tables / arrays.
# [ordered] keeps key order (and so the serialized JSON) stable on 5.1 and 7; OrderedDictionary has .Contains, not .ContainsKey.
function ConvertTo-Hashtable($node) {
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    $table = [ordered]@{}
    foreach ($prop in $node.PSObject.Properties) { $table[$prop.Name] = ConvertTo-Hashtable $prop.Value }
    return $table
  }
  if ($node -is [System.Array]) { return , @($node | ForEach-Object { ConvertTo-Hashtable $_ }) }
  return $node
}

# Same semantics as scripts/merge-settings.jq: objects deep-merge (b wins), `hooks` lists append per event,
# permissions allow/deny/ask/additionalDirectories are a de-duplicated union (base, os, local); other arrays replace.
# A null or non-object top-level permissions is treated as {}.
$UnionKeys = @('allow', 'deny', 'ask', 'additionalDirectories')
function Merge-Json($a, $b, $key = '') {
  foreach ($k in @($b.Keys)) {
    if ($key -eq '' -and $k -eq 'permissions') {
      if ($a[$k] -isnot [System.Collections.IDictionary]) { $a[$k] = [ordered]@{} }
      if ($b[$k] -isnot [System.Collections.IDictionary]) { $b[$k] = [ordered]@{} }
    }
    if (-not $a.Contains($k)) { $a[$k] = $b[$k]; continue }
    if ($a[$k] -is [System.Collections.IDictionary] -and $b[$k] -is [System.Collections.IDictionary]) { $a[$k] = Merge-Json $a[$k] $b[$k] $k }
    elseif ($key -eq 'hooks') { $a[$k] = @(@($a[$k]) + @($b[$k])) }
    elseif ($key -eq 'permissions' -and $UnionKeys -contains $k) { $a[$k] = @(@($a[$k]) + @($b[$k]) | Select-Object -Unique) }
    else { $a[$k] = $b[$k] }
  }
  return $a
}

function Read-Json($path) { ConvertTo-Hashtable (Get-Content $path -Raw | ConvertFrom-Json) }

function Build-Settings {
  $merged = Read-Json (Join-Path $Repo 'settings\base.json')
  foreach ($f in @('windows.json', 'local.json')) {
    $p = Join-Path $Repo "settings\$f"
    if (Test-Path $p) { $merged = Merge-Json $merged (Read-Json $p) }
  }
  $out = Join-Path $ClaudeDir 'settings.json'
  $json = $merged | ConvertTo-Json -Depth 20
  $json = $json.Replace('{{CLAUDE_HOME}}', ($ClaudeDir -replace '\\', '/'))
  if ($DryRun) { Write-Host "[dry-run] would write $out"; return }
  $current = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { $null }
  if ($current -ceq $json) { Note 'ok settings.json'; return }
  Backup $out
  [IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding $false))
  Note 'wrote settings.json'
}

# Install one tool's dependencies from its lockfile; plain install when there is none yet.
function Install-OneToolDeps($Name) {
  $dir = Join-Path $ClaudeDir "tools\$Name"
  $src = Join-Path $Repo "home\tools\$Name"
  if ($DryRun) { Write-Host "[dry-run] install $Name dependencies in $dir"; return }
  if (-not (Test-Path $dir)) { Write-Warning "skip $Name deps: $dir not found"; return }
  # npm ci --prefix through a symlinked folder reports a false lockfile mismatch: run inside the folder instead.
  Push-Location $dir
  if ((Test-Path (Join-Path $src 'pnpm-lock.yaml')) -and (Get-Command pnpm -ErrorAction SilentlyContinue)) { pnpm install --frozen-lockfile }
  elseif (Test-Path (Join-Path $src 'package-lock.json')) { npm ci }
  else { npm install --no-audit --no-fund }
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw "$Name dependency install failed" }
  Note "$Name dependencies"
}

# The tools with npm dependencies: ui-check (odiff-bin, pngjs) and env-names (yaml). Same list as TOOLS_WITH_DEPS in install.sh.
function Install-ToolDeps {
  Install-OneToolDeps 'ui-check'
  Install-OneToolDeps 'env-names'
}

# Copy (or link) one launcher file from home\bin into $dir. Idempotent.
function Install-LauncherFile($dir, $file) {
  $src = Join-Path $Repo "home\bin\$file"
  $dst = Join-Path $dir $file
  $existing = Get-Item $dst -Force -ErrorAction SilentlyContinue
  if ($existing -and $existing.LinkType -eq 'SymbolicLink' -and $existing.Target -eq $src) { Note "ok $file"; return }
  if ($existing -and -not $existing.LinkType -and ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)) { Note "ok $file (copy)"; return }
  Backup $dst
  try { New-Item -ItemType SymbolicLink -Path $dst -Target $src | Out-Null; Note "linked $file" }
  catch { Copy-Item $src $dst; Note "copied $file (not live-linked)" }
}

# An older install put ccm.ps1 straight into the PATH folder, where PowerShell resolves it before ccm.cmd.
# Move it to the backup folder when it is ours (a link to the repo file, or a ccm.ps1 launcher).
function Remove-StaleLauncher($binDir) {
  $stale = Join-Path $binDir 'ccm.ps1'
  $existing = Get-Item $stale -Force -ErrorAction SilentlyContinue
  if (-not $existing) { return }
  $isOurLink = $existing.LinkType -eq 'SymbolicLink' -and $existing.Target -eq (Join-Path $Repo 'home\bin\ccm.ps1')
  $isOurCopy = -not $existing.LinkType -and (Select-String -Path $stale -Pattern 'Usage: ccm\.ps1' -Quiet)
  if ($isOurLink -or $isOurCopy) { Backup $stale }
}

# Tell running programs the user environment changed (a dummy variable set and removed broadcasts
# WM_SETTINGCHANGE), so new terminals see the PATH written to the registry.
function Update-EnvBroadcast {
  [Environment]::SetEnvironmentVariable('CLAUDE_SETUP_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('CLAUDE_SETUP_PATH_REFRESH', $null, 'User')
}

# Install ccm.cmd into ~\.claude\bin (the PATH folder) and ccm.ps1 into ~\.claude\bin\ps, which the shim calls.
# The PATH value is read raw (no %VAR% expansion) and written back as ExpandString so existing %VAR% entries survive.
function Install-Launcher {
  $binDir = Join-Path $ClaudeDir 'bin'
  $psDir = Join-Path $binDir 'ps'
  if ($DryRun) { Write-Host "[dry-run] install ccm.cmd into $binDir, ccm.ps1 into $psDir, and add $binDir to the user PATH"; return }
  New-Item -ItemType Directory -Force $psDir | Out-Null
  Remove-StaleLauncher $binDir
  Install-LauncherFile $psDir 'ccm.ps1'
  Install-LauncherFile $binDir 'ccm.cmd'
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $userPath = $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $entries = @(($userPath -split ';') | Where-Object { $_ })
    if ($entries -notcontains $binDir) {
      $envKey.SetValue('Path', (($entries + $binDir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      Update-EnvBroadcast
      Note "added $binDir to the user PATH"
    }
  } finally { $envKey.Close() }
  if (@($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
}

# Optional, default off: make the workflow scripts usable by name (/<name>) in one project. A link stays personal (hidden by
# .git\info\exclude); -Copy copies the scripts so the team can commit them (a link into ~\.claude would break for them).
function Install-ProjectWorkflows($ProjectRepo) {
  if (-not (Test-Path (Join-Path $ProjectRepo '.git'))) { throw "$ProjectRepo is not a git repository" }
  $target = Join-Path $ProjectRepo '.claude\workflows'
  $src = Join-Path $Repo 'home\workflows'
  if ($DryRun) { Write-Host "[dry-run] workflows into $target"; return }
  New-Item -ItemType Directory -Force (Join-Path $ProjectRepo '.claude') | Out-Null
  $existing = Get-Item $target -Force -ErrorAction SilentlyContinue
  if ($Copy) {
    if ($existing -and $existing.LinkType) { Backup $target }
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item (Join-Path $src '*.js') $target -Force
    Note "copied workflows into $target"
    return
  }
  if ($existing -and $existing.LinkType -eq 'SymbolicLink' -and $existing.Target -eq $src) { Note 'ok project workflows link' }
  else {
    Backup $target
    try { New-Item -ItemType SymbolicLink -Path $target -Target $src | Out-Null; Note "linked $target" }
    catch { throw "could not link $target (enable Developer Mode, or use -Copy)" }
  }
  $exclude = git -C $ProjectRepo rev-parse --git-path info/exclude
  if (-not [IO.Path]::IsPathRooted($exclude)) { $exclude = Join-Path $ProjectRepo $exclude }
  New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
  if (-not (Test-Path $exclude) -or -not (Select-String -Path $exclude -Pattern '^\.claude/workflows$' -Quiet)) {
    Add-Content -Path $exclude -Value '.claude/workflows'
    Note "hid .claude/workflows in $exclude"
  }
}

# The line that gives every new PowerShell the claude-as function (spec-accounts.md "Start-up line"): it dot-sources
# home\shell\claude-as.ps1 from this repo and holds no token and no account name. It goes into $PROFILE.CurrentUserAllHosts
# (Documents\PowerShell\profile.ps1, or Documents\WindowsPowerShell\profile.ps1 on 5.1, where scripts/doctor-accounts.mjs
# looks) and is found again by its mark, so a second run adds no second line; a marked line that differs is left and named.
$StartupMark = '# claude-setup: claude-as'
function Add-StartupLine {
  $snippet = Join-Path $Repo 'home\shell\claude-as.ps1'
  if ($snippet.Contains("'")) { Write-Warning 'the repo path holds a quote; no claude-as start-up line written'; return }
  $profilePath = $PROFILE.CurrentUserAllHosts
  $line = "if (Test-Path -LiteralPath '$snippet') { . '$snippet' } $StartupMark"
  $raw = if (Test-Path -LiteralPath $profilePath) { Get-Content -LiteralPath $profilePath -Raw } else { '' }
  if (-not $raw) { $raw = '' }
  $lines = $raw -split "\r?\n"
  if ($lines -contains $line) { Note "ok claude-as start-up line in $profilePath"; return }
  if ($raw.Contains($StartupMark)) { Write-Warning "$profilePath has a claude-as start-up line for another path; left as it is (replace it with: $line)"; return }
  if ($DryRun) { Write-Host "[dry-run] would add the claude-as start-up line to $profilePath"; return }
  New-Item -ItemType Directory -Force (Split-Path -Parent $profilePath) | Out-Null
  if ($raw -and -not $raw.EndsWith("`n")) { $line = "`r`n$line" } # the file did not end with a newline
  Add-Content -LiteralPath $profilePath -Value $line
  Note "added the claude-as start-up line to $profilePath"
}

function Install-Plugins {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) { Write-Host 'claude CLI not found. Manual: run /plugin and add the items in plugins\plugins.json.'; return }
  $m = Read-Json (Join-Path $Repo 'plugins\plugins.json')
  # A failing plugin command must not abort the install (native commands do not throw): warn and go on.
  foreach ($mk in $m.marketplaces) {
    if ($mk.source -like 'github:*') {
      if (-not $DryRun) {
        claude plugin marketplace add ($mk.source -replace '^github:', '')
        if ($LASTEXITCODE -ne 0) { $Failures.Add("marketplace $($mk.name) (exit $LASTEXITCODE)"); Write-Warning "marketplace $($mk.name) failed (exit $LASTEXITCODE)"; continue }
      }
      Note "marketplace $($mk.name)"
    }
  }
  foreach ($id in ($m.enabled + $m.disabled)) {
    if ($id -like '*@gitkraken') { continue }
    if (-not $DryRun) {
      claude plugin install $id
      if ($LASTEXITCODE -ne 0) { $Failures.Add("plugin $id (exit $LASTEXITCODE)"); Write-Warning "plugin $id failed (exit $LASTEXITCODE)"; continue }
    }
    Note "plugin $id"
  }
}

try {
  if (-not $DryRun) { New-Item -ItemType Directory -Force $ClaudeDir | Out-Null }
  foreach ($n in $Links) { Link-Item $n }
  $commands = Join-Path $Repo 'home\commands'
  if ((Test-Path $commands) -and (Get-ChildItem $commands -Force | Select-Object -First 1)) { Link-Item 'commands' }
  Install-Launcher
  Add-StartupLine
  if ($ProjectWorkflows) { Install-ProjectWorkflows $ProjectWorkflows }
  if (Test-Path (Join-Path $Repo '.git')) {
    if (-not $DryRun) { git -C $Repo config core.hooksPath .githooks }
    Note 'git hooksPath = .githooks'
  }
  if (-not $NoPlugins) { Install-Plugins }
  # Settings after plugins: `claude plugin install` re-enables plugins in settings.json; the merged repo settings must
  # win. Tool deps after settings, so a failed tool dependency install cannot leave settings.json stale.
  Build-Settings
  if (-not $NoTools) { Install-ToolDeps }
} catch {
  Write-Error "FAILED: $_`nAlready done:`n  $($Done -join "`n  ")"
  exit 1
}
Write-Host "Completed:`n  $($Done -join "`n  ")"
if ($Failures.Count -gt 0) {
  Write-Host "Plugin failures:`n  $($Failures -join "`n  ")"
  exit 1
}
