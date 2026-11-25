# Purpose: finds Node 22.15+ and jq, then calls scripts/install.mjs to install, update or remove the setup on Windows.
#   It runs on PowerShell 5.1+ or 7, from any folder. install.mjs is the one installer logic of the Claude Code setup; its header
#   lists the flags. It stops when jq is missing, except for -Uninstall, which merges nothing.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Update [-To <tag>]] [-Uninstall] [-DryRun] [-NoPlugins]
#          [-NoTools] [-ClaudeVersion <x.y.z>]
# Invariants: holds no install step of its own; it passes the PowerShell profile path ($PROFILE.CurrentUserAllHosts), which only
#   PowerShell knows, so install.mjs can add the claude-as start-up line there. The exit code is install.mjs's.
# NOT VERIFIED: written on a Mac; the owner's Windows run (phase 7 r9-windows) is its first run.
param([switch]$Update, [string]$To = '', [switch]$Uninstall, [switch]$DryRun, [switch]$NoPlugins, [switch]$NoTools,
  [string]$ClaudeVersion = '')
$ErrorActionPreference = 'Stop'
# The one Node floor (major.minor), the same in install.sh: the tests' import hooks (tests/no-ps-hook.mjs, used by the
# long-run lock and account-switch tests) need module.registerHooks, which Node has from 22.15.
$NODE_FLOOR = [version]'22.15'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "missing required tool: node $NODE_FLOOR+ (winget install OpenJS.NodeJS.LTS)"; exit 1 }
# Parsed here from `node --version` (vX.Y.Z): an argument holding `"` (a `node -p` script) loses its quotes on PowerShell 5.1.
$nodeVersion = [string](& node --version)
if (-not ($nodeVersion -match '^v(\d+)\.(\d+)\.')) { Write-Error "node --version printed '$nodeVersion', not vX.Y.Z"; exit 1 }
if ([version]"$($Matches[1]).$($Matches[2])" -lt $NODE_FLOOR) { Write-Error "node $nodeVersion found; the setup needs node $NODE_FLOOR+"; exit 1 }
# jq merges the settings layers (scripts/install/settings.mjs); checked here so a missing jq stops the run before any link moves.
# -Uninstall merges nothing.
if (-not $Uninstall -and -not (Get-Command jq -ErrorAction SilentlyContinue)) {
  Write-Error 'missing required tool: jq (winget install jqlang.jq)'; exit 1
}

$Repo = Split-Path -Parent $PSScriptRoot
$argList = @((Join-Path $Repo 'scripts\install.mjs'))
if ($Update) { $argList += '--update' }
if ($To) { $argList += @('--to', $To) }
if ($Uninstall) { $argList += '--uninstall' }
if ($DryRun) { $argList += '--dry-run' }
if ($NoPlugins) { $argList += '--no-plugins' }
if ($NoTools) { $argList += '--no-tools' }
if ($ClaudeVersion) { $argList += @('--claude-version', $ClaudeVersion) }
$argList += @('--ps-profile', $PROFILE.CurrentUserAllHosts)
& node @argList
exit $LASTEXITCODE
