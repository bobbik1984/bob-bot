[CmdletBinding()]
param(
    [string]$SshAlias = 'contabo',
    [string]$PublicUrl = 'https://ry.bobbik.org',
    [switch]$NpmInstall
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProtoDir = Join-Path $RepoRoot 'prototype'

Write-Host "Deploying bob-bot full prototype to $SshAlias ($PublicUrl)..."

$remoteCmd = if ($NpmInstall) {
    'mkdir -p ~/bob-bot ~/bob-bot/data/skills ~/bob-bot/data/workspace/uploads ~/bob-bot/data/workspace/outputs && tar -xzf - -C ~/bob-bot && cp -rf ~/bob-bot/skills-presets/* ~/bob-bot/data/skills/ && cd ~/bob-bot && npm install --omit=dev && systemctl --user restart bobbot && sleep 2 && systemctl --user is-active bobbot'
} else {
    'mkdir -p ~/bob-bot ~/bob-bot/data/skills ~/bob-bot/data/workspace/uploads ~/bob-bot/data/workspace/outputs && tar -xzf - -C ~/bob-bot && cp -rf ~/bob-bot/skills-presets/* ~/bob-bot/data/skills/ && systemctl --user restart bobbot && sleep 2 && systemctl --user is-active bobbot'
}

python -X utf8 -c @"
import io, subprocess, sys, tarfile
from pathlib import Path
src = Path(sys.argv[1])
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    for p in src.rglob('*'):
        rel = p.relative_to(src)
        if any(part in ('node_modules', 'data', '.git', '__pycache__') for part in rel.parts) or p.suffix == '.pyc':
            continue
        tar.add(p, arcname=rel.as_posix(), recursive=False)
subprocess.run(['ssh', '-o', 'BatchMode=yes', sys.argv[2], sys.argv[3]], input=buf.getvalue(), check=True)
"@ "$ProtoDir" "$SshAlias" "$remoteCmd"

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$code = '000'
for ($i = 0; $i -lt 6; $i++) {
    $code = (& curl.exe -s -o NUL -w '%{http_code}' "$PublicUrl/")
    if ($code -eq '200') { break }
    Start-Sleep -Seconds 2
}
if ($code -ne '200') {
    Write-Error "Public health check failed: $PublicUrl/ returned HTTP $code"
    exit 1
}
Write-Host "Verified VPS3 full prototype live at $PublicUrl (HTTP $code)"
