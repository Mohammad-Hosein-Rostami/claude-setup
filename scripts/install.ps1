# Purpose: install, update or remove the Claude Code setup on Windows (PowerShell 5.1+ or 7): find Node and run
#   scripts/install.mjs, the one installer logic (its header lists the flags). Run it from any folder.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Update [-To <tag>]] [-Uninstall] [-DryRun] [-NoPlugins]
#          [-NoTools] [-ProjectWorkflows <repo> [-Copy]] [-ClaudeVersion <x.y.z>]
# Invariants: holds no install step of its own; it passes the PowerShell profile path ($PROFILE.CurrentUserAllHosts), which only
#   PowerShell knows, so install.mjs can add the claude-as start-up line there. The exit code is install.mjs's.
# NOT VERIFIED: written on a Mac; the owner's Windows run (phase 7 r9-windows) is its first run.
param([switch]$Update, [string]$To = '', [switch]$Uninstall, [switch]$DryRun, [switch]$NoPlugins, [switch]$NoTools,
  [string]$ProjectWorkflows = '', [switch]$Copy, [string]$ClaudeVersion = '')
$ErrorActionPreference = 'Stop'
$NodeMajorMin = 22 # the Node the tools and hooks are written for

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "missing required tool: node $NodeMajorMin+ (winget install OpenJS.NodeJS.LTS)"; exit 1 }
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt $NodeMajorMin) { Write-Error "node $major found; the setup needs node $NodeMajorMin+"; exit 1 }

$Repo = Split-Path -Parent $PSScriptRoot
$argList = @((Join-Path $Repo 'scripts\install.mjs'))
if ($Update) { $argList += '--update' }
if ($To) { $argList += @('--to', $To) }
if ($Uninstall) { $argList += '--uninstall' }
if ($DryRun) { $argList += '--dry-run' }
if ($NoPlugins) { $argList += '--no-plugins' }
if ($NoTools) { $argList += '--no-tools' }
if ($ProjectWorkflows) { $argList += @('--project-workflows', $ProjectWorkflows) }
if ($Copy) { $argList += '--copy' }
if ($ClaudeVersion) { $argList += @('--claude-version', $ClaudeVersion) }
$argList += @('--ps-profile', $PROFILE.CurrentUserAllHosts)
& node @argList
exit $LASTEXITCODE
