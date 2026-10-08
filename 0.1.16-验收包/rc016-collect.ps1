<#
  0.1.16 真机取证（Windows）—— 只读，不改任何东西。

  用法（PowerShell）：
    .\rc016-collect.ps1 before
    # ...做一步验收操作（点一次「译」/ 发一条消息）...
    .\rc016-collect.ps1 after-A01-manual-click
    .\rc016-collect.ps1 after-B09-retry

  产出：.\rc016-evidence-<电脑名>.txt（多次调用**追加**，不覆盖）

  判读重点与 macOS 版一致：
    · 装的是不是真的 0.1.16
    · 日志里有没有「翻译桥已就绪」（没有 = 桥没起来，直接回传）
    · 两条链的 [PIX_TRACE] 时间线（收口后接收链事件名已改为
      SOURCE_EXTRACTED / TRANSLATE_STARTED / TRANSLATE_SUCCEEDED /
      TARGET_RELOCATED / TRANSLATION_RENDERED）
    · open-apps.json 里 groupMode / engine / sendFrom / sendTo 与界面是否一致

  安全：绝不打印口令；proxyPass 一律 [redacted]。

  采集完把 txt 整个发我。本地可分诊：node scripts/rc-trace-triage.js <文件>
#>

param([string]$Label = 'snapshot')

$ErrorActionPreference = 'SilentlyContinue'
$appDir = Join-Path $env:APPDATA 'Hello Pix'
$out = ".\rc016-evidence-$($env:COMPUTERNAME).txt"

function Section($n, $t) { "`n---- $n. $t ----" }

$sb = New-Object System.Text.StringBuilder
function W([string]$s) { [void]$sb.AppendLine($s) }

W '================================================================'
W " 0.1.16 取证 · label=$Label"
W " 时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
W " 主机 : $env:COMPUTERNAME"
W " 系统 : $([System.Environment]::OSVersion.VersionString) / $env:PROCESSOR_ARCHITECTURE"
W '================================================================'

W (Section 1 '已安装版本（必须是 0.1.16）')
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Hello Pix\Hello Pix.exe'),
  (Join-Path ${env:ProgramFiles} 'Hello Pix\Hello Pix.exe')
)
foreach ($exe in $candidates) {
  if (Test-Path $exe) {
    W "  $exe"
    W "    版本: $((Get-Item $exe).VersionInfo.ProductVersion)"
  }
}
W '  （免安装版：请手动确认文件名是 HelloPix-0.1.16-portable.exe）'

W (Section 2 '进程')
Get-Process | Where-Object { $_.ProcessName -like '*Hello*' } |
  Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize | Out-String |
  ForEach-Object { W ($_ -replace "`r?`n$", '') }

W (Section 3 'open-apps.json：磁盘上的真实设置')
W '  判读重点：groupMode（inherit/manual/auto）、engine、sendFrom/sendTo 必须与界面一致'
$oa = Join-Path $appDir 'open-apps.json'
if (Test-Path $oa) {
  $json = Get-Content $oa -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($user in $json.byUser.PSObject.Properties) {
    $box = $user.Value
    $tabs = @($box.tabs)
    W "  账号 $($user.Name): activeId=$($box.activeId) 实例数=$($tabs.Count)"
    foreach ($t in $tabs) {
      $s = $t.settings
      W "    - id=$($t.id) platform=$($t.platform)"
      W "        groupMode=$($s.groupMode) engine=$($s.engine)"
      W "        sendFrom=$($s.sendFrom) sendTo=$($s.sendTo) recvFrom=$($s.recvFrom) recvTo=$($s.recvTo)"
      W "        showTransBar=$($s.showTransBar) transBarSilent=$($s.transBarSilent)"
      if ($s.proxyPass) { W '        proxyPass=[redacted]' }
    }
  }
} else {
  W '  （还没有 open-apps.json：没建过实例）'
}

W (Section 4 'auth.json（只报用户名，绝不打印口令）')
$au = Join-Path $appDir 'auth.json'
if (Test-Path $au) {
  $a = Get-Content $au -Raw -Encoding UTF8 | ConvertFrom-Json
  W "  username   = $($a.username)"
  W "  remember   = $($a.remember)"
  W "  autoLogin  = $($a.autoLogin)"
  W "  passwordEnc= $(if ($a.passwordEnc) { '有（内容不打印）' } else { '无' })"
} else {
  W '  （无 auth.json）'
}

W (Section 5 '多开槽位')
$part = Join-Path $appDir 'Partitions'
if (Test-Path $part) {
  Get-ChildItem $part -Name | ForEach-Object { W "  $_" }
} else {
  W '  （无 Partitions 目录）'
}

W (Section 6 '★第一证据★ 客户端日志')
W '  判读重点：'
W '    · [preload] … 翻译桥已就绪  → OK（没有这行 = 立刻停止并回传）'
W '    · [preload] … 翻译桥未启动  → BAD，同类装载问题复现，直接回传'
W '    · [PIX_TRACE] SOURCE_EXTRACTED / TRANSLATE_* / TARGET_RELOCATED / TRANSLATION_RENDERED → 链 A'
W '    · [PIX_TRACE] SEND_* / FINAL_TEXT_VALIDATED / PROGRAMMATIC_* → 链 B'
$logDir = Join-Path $appDir 'logs'
if (Test-Path $logDir) {
  $today = Join-Path $logDir "hello-pix-$(Get-Date -Format 'yyyy-MM-dd').log"
  if (Test-Path $today) {
    W '  --- 桥健康相关 ---'
    Select-String -Path $today -Pattern '\[preload\]|\[guest\]|翻译桥' |
      ForEach-Object { W "  $($_.Line)" }
    if ($Label -eq 'before') {
      W '  （before：只记行数，不贴内容）'
      W "  今日日志行数: $((Get-Content $today).Count)"
    } else {
      W '  --- 链 A（manual_click）---'
      Select-String -Path $today -Pattern 'MANUAL_|SOURCE_EXTRACTED|TARGET_RELOCATED|TRANSLATION_RENDER' |
        Select-Object -Last 70 | ForEach-Object { W "  $($_.Line)" }
      W '  --- 链 B（manual_send）---'
      Select-String -Path $today -Pattern 'SEND_|TRANSLATE_|INPUT_|DRAFT_|PROGRAMMATIC_|SOURCE_SNAPSHOTTED|FINAL_TEXT_VALIDATED' |
        Select-Object -Last 90 | ForEach-Object { W "  $($_.Line)" }
      W '  --- 最近 25 行 ---'
      Get-Content $today -Tail 25 | ForEach-Object { W "  $_" }
    }
  } else {
    W "  （今天还没有日志文件：$today）"
  }
  W '  日志文件列表:'
  Get-ChildItem $logDir -Name | ForEach-Object { W "    $_" }
} else {
  W '  （无 logs 目录）'
}

W (Section 7 '网络出口')
$ip = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 'https://api.ipify.org').Content
W "  本机直连出口: $(if ($ip) { $ip } else { '取不到' })"

W "`n=================== 采集结束 label=$Label ==================="

Add-Content -Path $out -Value $sb.ToString() -Encoding UTF8
Write-Host "已追加到：$out"
Write-Host "（把这个文件整个发我；它只读、不含口令）"
