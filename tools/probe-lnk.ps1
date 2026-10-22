# 调试用：把匹配到的开始菜单快捷方式的全部属性键倒出来，看 AUMID 到底登记在哪、读得到读不到。
#   powershell -File probe-lnk.ps1 -Match Qoder
param([string]$Match = 'Qoder')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aumid-map.ps1')
$roots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
$hits = Get-ChildItem -Path $roots -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match $Match -or $_.Directory.Name -match $Match }
"匹配 /$Match/ 的快捷方式：$($hits.Count) 个"
foreach ($f in ($hits | Select-Object -First 3)) {
  "=== $($f.FullName) ==="
  "  AppUserModelId() => [" + [AumidMapNative]::AppUserModelId($f.FullName) + "]"
  foreach ($l in [AumidMapNative]::Dump($f.FullName)) { "   $l" }
}
