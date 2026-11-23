#Requires -Version 7.0
<#
.SYNOPSIS
    把 dsh-abd-rescue 装进指定的 dsh profile。

.DESCRIPTION
    做三件事（与 dsh-unstuck 的 install.ps1 同款机制）：
      1. 把插件文件复制到 <DSH_HOME>\plugins\dsh-abd-rescue
      2. 在 profile 的 package.json 里登记依赖 + 加入 dsh.profile.bundles
      3. 在 profile 的 node_modules 里建一个目录联接，让 dsh 能 require 到它
         （这样不依赖 pnpm，也不用联网）

    改之前都会备份 package.json。

.PARAMETER DshHome
    dsh 的家目录，默认 $env:DSH_HOME，没有就用 ~\.dsh

.PARAMETER Profile
    profile 名，默认 desktop（本机 DeepSeek Harness 桌面版用的就是它）

.EXAMPLE
    pwsh -File .\install.ps1
    pwsh -File .\install.ps1 -Profile desktop -DshHome C:\Users\me\.dsh
#>
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$Profile = 'desktop',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'lib\index.js'))) {
    throw "这个脚本要放在插件根目录里跑（找不到 lib\index.js）。"
}

$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$dst = Join-Path $DshHome 'plugins\dsh-abd-rescue'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'

Write-Step "目标"
Write-Ok "DSH_HOME = $DshHome"
Write-Ok "profile  = $Profile"

if (-not (Test-Path $pkgPath)) {
    throw "找不到 $pkgPath。请先打开一次 DeepSeek Harness 桌面版让它初始化 profile，然后完全退出再装。"
}

# ---------------------------------------------------------------- 1. 复制文件
Write-Step "复制插件文件"
if (Test-Path $dst) {
    if (-not $Force) {
        $bak = "$dst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Move-Item $dst $bak -Force
        Write-Ok "已存在的旧版本移到 $bak"
    }
    else {
        Remove-Item $dst -Recurse -Force
    }
}
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$manifest = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
foreach ($item in @('package.json') + @($manifest.files)) {
    $from = Join-Path $src $item
    if (Test-Path $from) {
        Copy-Item $from -Destination $dst -Recurse -Force
    }
    else {
        Write-Warn2 "package.json 里列了 $item，但源码目录里没有，跳过"
    }
}
Write-Ok "已复制到 $dst"

# ---------------------------------------------------------------- 2. 登记到 profile
Write-Step "登记到 profile"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-abd-$stamp" -Force
Write-Ok "备份 package.json → package.json.bak-abd-$stamp"

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$fileSpec = 'file:' + ($dst -replace '\\', '/')

if (-not $pkg.PSObject.Properties['dependencies']) {
    $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}
if ($pkg.dependencies.PSObject.Properties['dsh-abd-rescue']) {
    $pkg.dependencies.'dsh-abd-rescue' = $fileSpec
}
else {
    $pkg.dependencies | Add-Member -NotePropertyName 'dsh-abd-rescue' -NotePropertyValue $fileSpec
}
Write-Ok "依赖: dsh-abd-rescue = $fileSpec"

if (-not $pkg.PSObject.Properties['dsh']) {
    $pkg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) -Force
}
if (-not $pkg.dsh.PSObject.Properties['profile']) {
    $pkg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{ bundles = @() }) -Force
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-abd-rescue') {
    $bundles = @($bundles) + 'dsh-abd-rescue'
    $pkg.dsh.profile.bundles = $bundles
    Write-Ok "bundles 里加入 dsh-abd-rescue（共 $($bundles.Count) 个）"
}
else {
    Write-Ok "bundles 里已经有 dsh-abd-rescue"
}

$pkg | ConvertTo-Json -Depth 40 | Set-Content -Path $pkgPath -Encoding utf8 -NoNewline
Write-Ok "已写回 $pkgPath"

# ---------------------------------------------------------------- 3. 建 node_modules 联接
Write-Step "建立 node_modules 联接"
$nm = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = Join-Path $nm 'dsh-abd-rescue'
if (Test-Path $link) {
    $info = Get-Item $link -Force
    if ($info.LinkType -in @('Junction', 'SymbolicLink')) {
        Remove-Item $link -Force
        New-Item -ItemType Junction -Path $link -Target $dst | Out-Null
        Write-Ok "已刷新联接 → $dst"
    }
    else {
        Write-Warn2 "$link 已存在且不是联接（可能是 pnpm 装的），保持不动。"
        Write-Warn2 "如果是旧版本，跑一次 pnpm install 或 dsh plugin add 更新。"
    }
}
else {
    New-Item -ItemType Junction -Path $link -Target $dst | Out-Null
    Write-Ok "已创建联接 $link → $dst"
}

# ---------------------------------------------------------------- 完成
Write-Step "完成"
Write-Host @"

接下来：
  1. 完全退出 DeepSeek Harness（含托盘图标），重新打开
  2. 随便跑一个会被守卫拦下的会话，然后看日志确认它活着：
       Get-Content "$DshHome\abd-rescue\abd-rescue.jsonl" -Tail 20
     看到 {"event":"boot"} 就是装好了；每次补发会记一条 rescue-sent
  3. 想调参：把 $dst\abd-rescue.config.example.json
     复制成 $DshHome\abd-rescue\config.json 再改，重启生效

卸载：
  pwsh -File "$src\uninstall.ps1"

"@ -ForegroundColor Gray
