# Purpose: PowerShell port of home/bin/ccm - launch Claude Code in a setup mode
# (normal | medium | high | extra-high | ultra-high). extra-high and ultra-high also set the lead at launch
# (`--model opus --effort max` / `--model fable --effort high`), because a hook cannot change the lead.
# CCM_LEAD_EFFORT=low|medium|high|xhigh|max overrides that effort for extra-high / ultra-high only (any other value is
# a usage error, exit 2); normal/medium/high ignore it.
# Usage: ccm.ps1 [normal|medium|high|extra-high|ultra-high] [claude args...]   (no mode word: CLAUDE_MODE is removed
# for the child, so a new session starts in medium and a resumed one keeps its saved mode)
# Invariants: sets CLAUDE_MODE only for the child process (restored afterwards), writes no files, passes no --settings.
# Set CCM_DRY_RUN=1 to print the command line instead of running it. Usage error exits 2.
$ExitUsage = 2
$Modes = @('normal', 'medium', 'high', 'extra-high', 'ultra-high')
$Efforts = @('low', 'medium', 'high', 'xhigh', 'max')

# Lead flags per mode; CCM_LEAD_EFFORT replaces the default effort of the two lead modes (invalid value: exit 2).
function Get-LeadArgs([string]$mode) {
  if ($mode -ne 'extra-high' -and $mode -ne 'ultra-high') { return @() }
  $effort = $env:CCM_LEAD_EFFORT
  if ($effort -and $Efforts -cnotcontains $effort) {
    [Console]::Error.WriteLine("ccm: CCM_LEAD_EFFORT must be low|medium|high|xhigh|max (got: $effort)")
    exit $ExitUsage
  }
  if ($mode -eq 'extra-high') { return @('--model', 'opus', '--effort', $(if ($effort) { $effort } else { 'max' })) }
  return @('--model', 'fable', '--effort', $(if ($effort) { $effort } else { 'high' }))
}

$rest = @($args)
$mode = ''
if ($rest.Count -gt 0 -and $rest[0]) {
  $word = ([string]$rest[0]).ToLowerInvariant()
  if ($Modes -contains $word) { $mode = $word; $rest = @($rest | Select-Object -Skip 1) }
  elseif (-not $word.StartsWith('-')) {
    [Console]::Error.WriteLine('usage: ccm [normal|medium|high|extra-high|ultra-high] [claude args...]')
    exit $ExitUsage
  }
}

$claudeArgs = @((Get-LeadArgs $mode) + $rest)
$prefix = if ($mode) { "env CLAUDE_MODE=$mode claude" } else { 'env -u CLAUDE_MODE claude' }

if ($env:CCM_DRY_RUN -eq '1') {
  Write-Output (($prefix, ($claudeArgs -join ' ')).Where({ $_ }) -join ' ')
  exit 0
}

$previous = $env:CLAUDE_MODE
try {
  if ($mode) { $env:CLAUDE_MODE = $mode } else { Remove-Item Env:CLAUDE_MODE -ErrorAction SilentlyContinue }
  & claude @claudeArgs
  exit $LASTEXITCODE
} finally {
  if ($null -ne $previous) { $env:CLAUDE_MODE = $previous } else { Remove-Item Env:CLAUDE_MODE -ErrorAction SilentlyContinue }
}
