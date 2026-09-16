<#
.SYNOPSIS
    Writes .env.example for a repository from its real files, secrets left blank (or -Content to write your own).
.EXAMPLE
    ./scripts/New-EnvTemplate.ps1 -Repo "MyRepo"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [string]$Content = '',
    [string]$File = '.env.example'
)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$path" -Headers $headers -TimeoutSec 300 }
function Post-Api($path, $payload) { Invoke-RestMethod -Uri "$CadenceApi$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 300 }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
function Out-Json($o, $d = 6) { ConvertTo-Json -InputObject $o -Depth $d }
$payload = @{ file = $File }
if ($Content) { $payload.content = $Content }
Post-Api "/api/plugins/env-manager/repos/$(Esc $Repo)/write-template" $payload | ConvertTo-Json
