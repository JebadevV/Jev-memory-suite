# Logon task for the memory suite. The HKCU Run entry written by `jev-memory autostart install` runs this script.
# Starts the upstream gateway router first, then the default profile (memory + dashboard).
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $env:LOCALAPPDATA 'jev-autostart.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)
# Node writes UTF-8; without this PowerShell decodes its output with the OEM code page and the log gets mojibake.
try { [Console]::OutputEncoding = $utf8 } catch { }
$maxBytes = 1MB
$keepBytes = 200KB

# Windows PowerShell 5.1 writes UTF-16 with *>>, so the log is appended through .NET as UTF-8 without a BOM.
function Write-Log([string]$text) {
  [System.IO.File]::AppendAllText($logPath, $text + "`r`n", $utf8)
}

if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt $maxBytes) {
  $bytes = [System.IO.File]::ReadAllBytes($logPath)
  $start = $bytes.Length - $keepBytes
  # Start at a line boundary so the first kept line is whole.
  $newline = [Array]::IndexOf($bytes, [byte]10, $start)
  if ($newline -ge 0) { $start = $newline + 1 }
  if ($start -lt $bytes.Length) {
    $tail = New-Object byte[] ($bytes.Length - $start)
    [Array]::Copy($bytes, $start, $tail, 0, $tail.Length)
    [System.IO.File]::WriteAllBytes($logPath, $tail)
  }
}

Write-Log ('=== ' + (Get-Date).ToString('o') + ' autostart')

$node = 'C:\Program Files\nodejs\node.exe'
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $node = $found.Source }

function Invoke-Step([string]$label, [string[]]$arguments) {
  Write-Log ('--- ' + $label)
  try {
    $output = @(& $node @arguments 2>&1 | ForEach-Object { "$_" })
    if ($output.Count -gt 0) { Write-Log ($output -join "`r`n") }
    Write-Log ('exit ' + $LASTEXITCODE)
  } catch {
    Write-Log ('error: ' + $_.Exception.Message)
  }
}

# Each step is independent: a failed gateway start must not stop the memory profile.
Invoke-Step 'jev-memory-codex --start' @((Join-Path $root 'bin\jev-memory-codex.mjs'), '--start')
Invoke-Step 'jev-memory start' @((Join-Path $root 'bin\jev-memory.mjs'), 'start')
