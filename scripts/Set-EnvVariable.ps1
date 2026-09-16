<#
.SYNOPSIS
    Sets or adds KEY=value in one env file, keeping order and comments.
.EXAMPLE
    ./scripts/Set-EnvVariable.ps1 -Repo "MyRepo" -File .env.local -Key API_URL -Value http://localhost:3000
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$File,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value
)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$path" -Headers $headers -TimeoutSec 300 }
function Post-Api($path, $payload) { Invoke-RestMethod -Uri "$CadenceApi$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 300 }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
function Out-Json($o, $d = 6) { ConvertTo-Json -InputObject $o -Depth $d }
Post-Api "/api/plugins/env-manager/repos/$(Esc $Repo)/set" @{ file = $File; key = $Key; value = $Value } | ConvertTo-Json
