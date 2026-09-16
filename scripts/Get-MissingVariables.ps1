<#
.SYNOPSIS
    Variables the code reads that no env file defines (one repository, or every repository with -All).
.EXAMPLE
    ./scripts/Get-MissingVariables.ps1 -Repo "MyRepo"
#>
[CmdletBinding()]
param(
    [string]$Repo = '',
    [switch]$All
)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$path" -Headers $headers -TimeoutSec 300 }
function Post-Api($path, $payload) { Invoke-RestMethod -Uri "$CadenceApi$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 300 }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
function Out-Json($o, $d = 6) { ConvertTo-Json -InputObject $o -Depth $d }
if ($All -or -not $Repo) {
  $ov = Get-Api '/api/plugins/env-manager/overview'
  Out-Json @($ov.repos | Where-Object { $_.missing.Count -gt 0 } | ForEach-Object { [pscustomobject]@{ repo = $_.name; missing = $_.missing; unused = $_.unused } }) 4
} else {
  $d = Get-Api "/api/plugins/env-manager/repos/$(Esc $Repo)/detail"
  [pscustomobject]@{ repo = $Repo; missing = @($d.missing); unused = @($d.unused) } | ConvertTo-Json -Depth 5
}
