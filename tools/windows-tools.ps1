# Purpose: install the CLI tools the Claude Code setup uses via winget (Windows 10+).
# Usage: powershell -ExecutionPolicy Bypass -File tools\windows-tools.ps1
$ErrorActionPreference = 'Stop'
$ids = @('jqlang.jq', 'BurntSushi.ripgrep.MSVC', 'Gitleaks.Gitleaks', 'GitHub.cli', 'Volta.Volta')
foreach ($id in $ids) {
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
}
# ast-grep: no winget id verified, so install from npm (needs node on PATH).
npm i -g @ast-grep/cli
Write-Host 'Done. Then run: volta install node@22'
