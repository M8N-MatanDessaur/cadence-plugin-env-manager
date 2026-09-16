<#
.SYNOPSIS
    Where the real env files and the .env.example disagree, per repository.
.EXAMPLE
    ./scripts/Get-EnvDrift.ps1
#>
[CmdletBinding()]
param(

)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$path" -Headers $headers -TimeoutSec 300 }
function Post-Api($path, $payload) { Invoke-RestMethod -Uri "$CadenceApi$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 300 }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
function Out-Json($o, $d = 6) { ConvertTo-Json -InputObject $o -Depth $d }
$ov = Get-Api '/api/plugins/env-manager/overview'
Out-Json @($ov.repos | Where-Object { $_.hasEnv } | ForEach-Object { [pscustomobject]@{ repo = $_.name; hasTemplate = $_.hasTemplate; template = $_.drift.template; missingFromTemplate = $_.drift.missingFromTemplate; onlyInTemplate = $_.drift.onlyInTemplate } }) 4
