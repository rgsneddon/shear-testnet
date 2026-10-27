# Parse every tracked .ps1 with this PowerShell and fail on any parse error.
# Run it under Windows PowerShell 5.1 (powershell.exe): Flutter's Windows
# CMake target runs wallet/native/build-shear-v3.ps1 with it, and a parse
# error there fails the whole wallet build with only "exited with code 1".
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
$files = & git -C $Root ls-files '*.ps1'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$bad = 0
foreach ($rel in $files) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $rel), [ref]$tokens, [ref]$errors)
  foreach ($e in $errors) {
    Write-Host "${rel}:$($e.Extent.StartLineNumber): $($e.Message)"
    $bad += 1
  }
}
Write-Host "ps1_parse_check: $($files.Count) file(s), $bad error(s), PowerShell $($PSVersionTable.PSVersion)"
if ($bad -gt 0) { exit 1 }
