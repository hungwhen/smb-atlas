$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    )
    $nodePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $nodePath) { throw 'A local Node.js 20 or newer runtime is required. Make it available on this computer, then run the launcher again.' }
$nodeMajor = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw 'This app requires Node.js 20 or newer.' }
$port = if ($env:PORT) { $env:PORT } else { '8787' }
if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'PORT must be from 1 to 65535.' }
$address = "http://127.0.0.1:$port"
# Leave the server in this console so Ctrl+C and closing the window stop it.
# A small background job opens the browser once the app responds; it holds no credentials.
$browserJob = Start-Job -ArgumentList $address -ScriptBlock {
    param($url)
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $session = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 1
            if ($session.version -eq '1.3.0' -and $session.token) { Start-Process $url; return }
        } catch { Start-Sleep -Milliseconds 250 }
    }
}
try {
    Set-Location -LiteralPath $PSScriptRoot
    & $nodePath (Join-Path $PSScriptRoot 'server.mjs')
    $appExitCode = $LASTEXITCODE
} finally {
    Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
    Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
}
exit $appExitCode
