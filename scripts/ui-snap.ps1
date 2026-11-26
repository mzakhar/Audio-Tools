# Wrapper for ui-snap.cjs: Electron exits if given a URL argv or when run from
# inside this repo under some launchers, so copy to TEMP and retry until complete.
# Usage: powershell -File scripts/ui-snap.ps1 -Out specs/ui-baseline/<phase> [-Url http://127.0.0.1:5199/]
param([Parameter(Mandatory)][string]$Out, [string]$Url = 'http://127.0.0.1:5199/')
$repo = Split-Path $PSScriptRoot
Remove-Item Env:ELECTRON_IS_PACKAGED, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Copy-Item "$PSScriptRoot\ui-snap.cjs" "$env:TEMP\ui-snap.cjs" -Force
$env:SNAP_URL = $Url
$env:SNAP_OUT = (Join-Path $repo $Out)
for ($i = 0; $i -lt 6; $i++) {
  $p = Start-Process -FilePath "$repo\node_modules\electron\dist\electron.exe" -ArgumentList "$env:TEMP\ui-snap.cjs" -Wait -PassThru
  if ($p.ExitCode -eq 0) { break }
}
"exit $($p.ExitCode); $((Get-ChildItem $env:SNAP_OUT -Filter *.png).Count) shots in $env:SNAP_OUT"
