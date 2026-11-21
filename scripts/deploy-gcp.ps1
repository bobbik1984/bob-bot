[CmdletBinding()]
param(
    [string]$SshAlias,
    [string]$PublicOrigin,
    [int]$GatewayPort,
    [string]$RepoRoot
)
$ErrorActionPreference = 'Stop'
$arguments = @('-X', 'utf8', (Join-Path $PSScriptRoot 'deploy-gcp.py'), 'deploy')
if ($SshAlias) { $arguments += @('--host', $SshAlias) }
if ($PublicOrigin) { $arguments += @('--url', $PublicOrigin) }
if ($GatewayPort) { $arguments += @('--port', "$GatewayPort") }
if ($RepoRoot) { $arguments += @('--repo', $RepoRoot) }
& python @arguments
exit $LASTEXITCODE
