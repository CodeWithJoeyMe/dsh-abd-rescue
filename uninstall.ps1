#Requires -Version 7.0
<#
.SYNOPSIS
    从指定 dsh profile 卸载 dsh-abd-rescue（profile 目录里留备份）。
#>
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$Profile = 'desktop'
)
$ErrorActionPreference = 'Stop'
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$link = Join-Path $profileDir 'node_modules\dsh-abd-rescue'
$src = Join-Path $DshHome 'plugins\dsh-abd-rescue'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'

if (Test-Path $pkgPath) {
    Copy-Item $pkgPath "$pkgPath.bak-abd-uninstall-$stamp" -Force
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if ($pkg.dependencies.PSObject.Properties['dsh-abd-rescue']) {
        $pkg.dependencies | Remove-Member -Name 'dsh-abd-rescue'
    }
    if ($pkg.dsh.PSObject.Properties['profile']) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-abd-rescue' }
    }
    $pkg | ConvertTo-Json -Depth 40 | Set-Content -Path $pkgPath -Encoding utf8 -NoNewline
    Write-Host "已移除依赖 + bundle 登记（原文件备份为 package.json.bak-abd-uninstall-$stamp）" -ForegroundColor Green
}
if (Test-Path $link) {
    $info = Get-Item $link -Force
    if ($info.LinkType -in @('Junction', 'SymbolicLink')) {
        Remove-Item $link -Force
        Write-Host "已移除 node_modules 联接" -ForegroundColor Green
    }
    else {
        # 真实目录（pnpm/npm 装的）：不带 -Recurse 删会中途抛错造成半卸载，
        # 这里对齐 install 的口径——只警告，留给人工决定怎么更新。
        Write-Host "注意：$link 是真实目录（不是联接，可能是 pnpm 装的），未删除。请跑 pnpm install 或 dsh plugin rm 处理。" -ForegroundColor Yellow
    }
}
if (Test-Path $src) {
    Move-Item $src "$src.bak-$stamp" -Force
    Write-Host "插件文件移到 $src.bak-$stamp（日志目录 $DshHome\abd-rescue 保留，手工删）" -ForegroundColor Green
}
Write-Host "完成。重启 DeepSeek Harness 生效。" -ForegroundColor Cyan
