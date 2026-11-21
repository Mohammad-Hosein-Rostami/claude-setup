# Purpose: `claude-as <name>` for PowerShell: this terminal, and only this one, uses the Claude account stored under
# that name. Dot-source this file from the PowerShell profile; nothing else is written there.
#   claude-as <name> | claude-as (pick from a list) | claude-as -Once | claude-as -Off
#   claude-account list | remove <name> | check [name] | default [<name>|none] | plan <name> <plan> | credits-off <name>
# Defines: claude-as, claude-account.
# NOT VERIFIED: written on a Mac with no PowerShell at hand; no test runs this file. Probe ACC-5 (the Windows store) and
# a first run of this file belong to the first step of phase 7 (r9-windows). Until then treat it as a draft.
# Invariants it is written to keep (the same as claude-as.sh): the token reaches the account tool on a pipe (stdin), never
# as an argument; the paste is read with hidden input; an argument shaped like a token is refused; the token is set in
# this process's environment only ($env:), never in the user or machine environment.

$script:ClaudeAsTools = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools'
$script:ClaudeAsTokenShape = 'sk-ant-[A-Za-z0-9_-]{10,}'
$script:ClaudeAsNoSuchAccount = 3

# $input: a native command inside a function does not get the function's pipeline input by itself, so the paste piped
# into `claude-account add` / `once` is passed on explicitly (review 1, R5); with no pipeline input stdin is empty.
function claude-account {
  $input | node (Join-Path $script:ClaudeAsTools 'account/account.mjs') @args
}

# Reads one hidden line from the console and returns it as plain text (kept in this process only).
function Read-ClaudeAsPaste([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Set-ClaudeAsAccount([string]$Name) {
  $token = claude-account token $Name
  if ($LASTEXITCODE -eq $script:ClaudeAsNoSuchAccount) {
    Read-ClaudeAsPaste "Paste the token for $Name (input is hidden)" | claude-account add $Name
    if ($LASTEXITCODE -ne 0) { return }
    $token = claude-account token $Name
  }
  if ($LASTEXITCODE -ne 0 -or -not $token) { return }
  $env:CLAUDE_CODE_OAUTH_TOKEN = $token
  $env:CLAUDE_ACCOUNT = $Name
  Write-Host "this terminal now uses account $Name"
}

function claude-as {
  param([string]$Name, [switch]$Once, [switch]$Off)
  if ("$Name $args" -match $script:ClaudeAsTokenShape) {
    Write-Error 'claude-as: an argument looks like a token; nothing was set. Remove that line from the history (Clear-History, and the file (Get-PSReadLineOption).HistorySavePath) and treat that token as shown. Then run claude-as <name> and paste at the hidden prompt.'
    return
  }
  if ($Off) {
    Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN, Env:CLAUDE_ACCOUNT -ErrorAction SilentlyContinue
    Write-Host 'this terminal has no account'
    return
  }
  if ($Once) {
    $token = Read-ClaudeAsPaste 'Paste the token for this terminal only (input is hidden, nothing is stored)' | claude-account once
    if ($LASTEXITCODE -ne 0 -or -not $token) { return }
    $env:CLAUDE_CODE_OAUTH_TOKEN = $token
    $env:CLAUDE_ACCOUNT = '-'
    Write-Host 'this terminal now uses a token that is not stored'
    return
  }
  if (-not $Name) {
    $names = @(claude-account names)
    if ($names.Count -eq 0) { Write-Host 'no accounts stored. Add one: claude-as <name>'; return }
    for ($i = 0; $i -lt $names.Count; $i++) { Write-Host "$($i + 1)) $($names[$i])" }
    $answer = Read-Host -Prompt 'Number'
    $index = 0
    # Enter alone, or anything that is not one of the numbers, picks nothing.
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $names.Count) { Write-Host 'claude-as: no account picked'; return }
    $Name = $names[$index - 1]
  }
  Set-ClaudeAsAccount $Name
}

# At the start of a session that has no token yet and is not a Claude session: use the default account when the owner
# set one, else say how to pick (as claude-as.sh does). The tool reads accounts.json with its own file checks.
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN -and -not $env:CLAUDECODE) {
  $script:ClaudeAsDefault = claude-account default
  if ($LASTEXITCODE -eq 0 -and $script:ClaudeAsDefault) { claude-as $script:ClaudeAsDefault }
  else { Write-Host 'pick an account: claude-as <name>' }
}
