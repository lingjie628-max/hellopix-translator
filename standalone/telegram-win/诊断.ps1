# 诊断.ps1 — Hello Pix Telegram 链路诊断
#
# 为什么需要它：这条链路上每一段失败都是【静默的】——
#   Provider 失败就不写译文、不弹错；启动器只在登录层报错；服务端只回状态码。
#   于是"气泡没出译文"这一个现象，可能是桥接文件没写对、通道没接通、cookie 过期、
#   余额不足、限流…… 光看界面分不出来。
#
# 这个脚本按链路顺序逐段验，把"哪一段断了"直接打出来：
#   1. 桥接文件在哪、内容是什么
#   2. 后台通不通
#   3. 带桥接里的 cookie 能不能取到通道列表（验登录态有没有过期）
#   4. 按桥接里的通道真发一次翻译（验通道、余额、限流）
#
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行
#         powershell -ExecutionPolicy Bypass -File .\诊断.ps1
#
# 它只读不写，不会改动你的电报数据或账号设置。

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Continue'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Bad($text)  { Write-Host "  [FAIL] $text" -ForegroundColor Red }
function Warn($text) { Write-Host "  [WARN] $text" -ForegroundColor Yellow }

Say "=== Hello Pix Telegram 链路诊断 ===" Cyan
Say ""

# ---- 1. 找桥接文件 -----------------------------------------------------------
$root = Join-Path $env:APPDATA 'Hello Pix Telegram'
Say "[1/4] 桥接文件" Cyan
Say "      查找: $root\tdata\*\hello-pix-bridge.json"

if (-not (Test-Path $root)) {
    Bad "找不到 $root"
    Say "      说明启动器从未成功登录过，或者安装包不在当前用户下运行。" White
    Say "      先确认：双击的是 HelloPixTelegram.exe、并且登录成功了。" White
    Say ""
    Read-Host "按回车退出"
    exit 1
}

$bridges = @(Get-ChildItem -Path (Join-Path $root 'tdata') -Filter 'hello-pix-bridge.json' -Recurse -ErrorAction SilentlyContinue)
if ($bridges.Count -eq 0) {
    Bad "tdata 下没有任何 hello-pix-bridge.json"
    Say "      桥接文件在【登录成功】和【打开电报】时写入。先完成一次登录。" White
    Say ""
    Read-Host "按回车退出"
    exit 1
}

$usable = @()
foreach ($file in $bridges) {
    $instance = Split-Path $file.DirectoryName -Leaf
    Say ""
    Say "  --- 实例 [$instance] ---" White
    Say "      $($file.FullName)"
    try {
        $bridge = Get-Content -Raw -Encoding UTF8 $file.FullName | ConvertFrom-Json
    } catch {
        Bad "JSON 解析失败：$($_.Exception.Message)"
        continue
    }
    $apiBase = ("$($bridge.apiBase)" -replace '/+$', '')
    Say "      apiBase   = $apiBase"
    Say "      engine    = '$($bridge.engine)'"
    Say "      lang      = $($bridge.lang)"
    Say "      开关       = 接收:$($bridge.transRecv) 发送:$($bridge.transSend) 群:$($bridge.transGroup)"
    Say "      deviceId  = $(if ($bridge.deviceId) { $bridge.deviceId } else { '(空)' })"
    $cookieNames = @($bridge.cookies.PSObject.Properties.Name)
    Say "      cookies   = [$($cookieNames -join ', ')]"

    $problems = @()
    if (-not $apiBase) { $problems += "apiBase 为空 —— 启动器没拿到后台地址" }
    if (-not $bridge.deviceId) { $problems += "deviceId 为空" }
    if ($cookieNames -notcontains 'pix_csrf' -and $cookieNames -notcontains '__Host-pix_csrf') {
        $problems += "cookies 里没有 CSRF —— 服务端 CSRF 中间件会直接 403"
    }
    if (-not $bridge.transRecv -and -not $bridge.transSend) {
        $problems += "接收与发送翻译都关着 —— 按设计此时 Hello Pix 不接管翻译（会退回电报自带翻译）"
    }
    if ($problems.Count -gt 0) { foreach ($p in $problems) { Warn $p } }
    else { Ok "字段看起来齐全" }

    $usable += [pscustomobject]@{ Instance = $instance; Bridge = $bridge; ApiBase = $apiBase; Cookies = $cookieNames }
}

if ($usable.Count -eq 0) { Say ""; Read-Host "按回车退出"; exit 1 }

$target = $usable[0]
Say ""
Say "用实例 [$($target.Instance)] 继续走后面的检查" Cyan
Say ""

# ---- 2. 后台通不通 -----------------------------------------------------------
Say "[2/4] 后台连通性" Cyan
try {
    $health = Invoke-RestMethod -Uri "$($target.ApiBase)/health" -TimeoutSec 8 -ErrorAction Stop
    Ok "GET /health -> ok=$($health.ok) backend=$($health.backend)"
} catch {
    Bad "连不上 $($target.ApiBase)/health"
    Say "      $($_.Exception.Message)" White
    Say "      如果后台在这台电脑：先启动后台服务，确认端口对（本机开发是 3000）。" White
    Say "      如果后台在另一台机器：把「服务器」填成那台的局域网 IP，并确认防火墙放行。" White
    Say ""
    Read-Host "按回车退出"
    exit 1
}

# 照 C++ ReadBridge() 的取值方式拼 Cookie 头与 CSRF
$cookieParts = @()
$csrf = ''
foreach ($name in $target.Cookies) {
    $value = "$($target.Bridge.cookies.$name)"
    if (-not $value) { continue }
    $cookieParts += "$name=$value"
    if ($name -match 'csrf') { $csrf = [System.Uri]::UnescapeDataString($value) }
}
$cookieHeader = $cookieParts -join '; '

function Invoke-Api {
    param([string]$Path, [string]$Method = 'Get', $Form = $null, [string]$Idem)
    $headers = @{
        'Accept'       = 'application/json'
        'X-Pix-Device' = "$($target.Bridge.deviceId)"
        'Cookie'       = $cookieHeader
    }
    if ($csrf) { $headers['X-CSRF-Token'] = $csrf }
    $reqArgs = @{
        Uri         = "$($target.ApiBase)$Path"
        Method      = $Method
        Headers     = $headers
        TimeoutSec  = 15
        ErrorAction = 'Stop'
    }
    if ($Form) {
        $headers['Content-Type'] = 'application/x-www-form-urlencoded'
        $reqArgs['Body'] = ($Form.GetEnumerator() | ForEach-Object {
            "$([System.Uri]::EscapeDataString($_.Key))=$([System.Uri]::EscapeDataString("$($_.Value)"))"
        }) -join '&'
    }
    if ($Idem) { $headers['Idempotency-Key'] = $Idem }
    try {
        $response = Invoke-WebRequest @reqArgs -UseBasicParsing
        return [pscustomobject]@{ Status = $response.StatusCode; Body = ($response.Content | ConvertFrom-Json) }
    } catch {
        $code = 0; $body = $null
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $body = $reader.ReadToEnd() | ConvertFrom-Json
            } catch { }
        }
        return [pscustomobject]@{ Status = $code; Body = $body }
    }
}

# ---- 3. 登录态与通道 ---------------------------------------------------------
Say ""
Say "[3/4] 登录态与翻译通道（用桥接文件里的 cookie）" Cyan
$engines = Invoke-Api -Path '/apis/translate/engines'
if ($engines.Status -eq 200) {
    $wired = @($engines.Body.rows | Where-Object { $_.wired -and $_.enabled } | ForEach-Object { $_.id })
    Ok "取到通道列表；已接通 = [$($wired -join ', ')]"
    Say "      账号当前通道(activeEngine) = $($engines.Body.activeEngine)"
    if ($wired.Count -eq 0) {
        Bad "这个账号的套餐里没有任何已接通的通道 —— 气泡不会出译文"
        Say "      去后台「翻译通道」页填好厂商凭据并设为使用中。" White
    } elseif ($wired -notcontains "$($target.Bridge.engine)") {
        Bad "桥接文件里的通道 '$($target.Bridge.engine)' 不在已接通列表里"
        Say "      打开侧栏「翻译设置」重新选一次通道并保存，然后重开电报。" White
    } else {
        Ok "桥接文件里的通道 '$($target.Bridge.engine)' 已接通"
    }
} elseif ($engines.Status -eq 401 -or $engines.Status -eq 403) {
    Bad "HTTP $($engines.Status) —— 登录态无效或已过期"
    Say "      $($engines.Body.msg)" White
    Say "      在启动器里退出登录再登一次，桥接文件会被重写。" White
} else {
    Bad "HTTP $($engines.Status) $($engines.Body.msg)"
}

# ---- 4. 真发一次翻译 ---------------------------------------------------------
Say ""
Say "[4/4] 真发一次翻译（会消耗少量字符）" Cyan
$text = 'Good morning, the meeting starts at nine.'
$idem = "diag:$($target.Instance):$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$run = Invoke-Api -Path '/apis/translate/run' -Method Post -Idem $idem -Form ([ordered]@{
    text   = $text
    from   = 'auto'
    to     = "$($target.Bridge.lang)"
    engine = "$($target.Bridge.engine)"
})
if ($run.Status -eq 200 -and $run.Body.success) {
    Ok "服务端返回译文：$($run.Body.translation)"
    Say "      engine=$($run.Body.engine) wired=$($run.Body.wired) chars=$($run.Body.chars) remain=$($run.Body.remain)"
    Say ""
    Say "  => 服务端这一段是通的。如果电报气泡里仍然没有 [译文]，问题在电报侧：" Cyan
    Say "     · 电报是不是用启动器打开的（启动器会传 -workdir 并先写桥接文件）" White
    Say "     · 包里的 Telegram.exe 是不是魔改版（对照验收文档里的 SHA256）" White
    Say "     · 「接收翻译」开关是否开着；改完设置要重开一次电报窗口" White
} else {
    Bad "HTTP $($run.Status) $($run.Body.code) $($run.Body.msg)"
    switch ("$($run.Body.code)") {
        'ENGINE_NOT_CONFIGURED' { Say "      通道没接通：后台「翻译通道」页填凭据并设为使用中。" White }
        'INSUFFICIENT_CHARS'    { Say "      字符余额不足：侧栏「用户信息」看余额。" White }
        'REQUEST_IN_PROGRESS'   { Say "      相同请求正在处理（重复点太快），稍等再试。" White }
        'IDEMPOTENCY_KEY_REUSED'{ Say "      幂等键撞车，换个时间再试即可（脚本每次用新键）。" White }
        default                 {
            if ($run.Status -eq 429) { Say "      撞限流了：等一分钟再试；群里消息多时会这样。" White }
            if ($run.Status -eq 403) { Say "      CSRF/登录态问题：重新登录一次启动器。" White }
        }
    }
}

Say ""
Say "=== 诊断结束 ===" Cyan
Say "把上面整段输出发给开发者即可定位。" Gray
Read-Host "按回车退出"
