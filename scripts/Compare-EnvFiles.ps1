<#
.SYNOPSIS
    Two env files of a repository side by side: same, different, only-left, only-right (secrets masked by the route).
.EXAMPLE
    ./scripts/Compare-EnvFiles.ps1 -Repo "MyRepo" -Left .env.development -Right .env.production
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$Left,
    [Parameter(Mandatory)][string]$Right
)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$path" -Headers $headers -TimeoutSec 300 }
function Post-Api($path, $payload) { Invoke-RestMethod -Uri "$CadenceApi$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 300 }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
function Out-Json($o, $d = 6) { ConvertTo-Json -InputObject $o -Depth $d }
Get-Api "/api/plugins/env-manager/repos/$(Esc $Repo)/diff?file1=$(Esc $Left)&file2=$(Esc $Right)" | ConvertTo-Json -Depth 5
