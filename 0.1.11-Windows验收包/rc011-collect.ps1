# RC-03 Windows 验收 · 客户端取证脚本（只读）
#
# 用途：把客户端的真实状态采集下来发给开发，用于远程核对。
#
# 特点：
#   - **只读**：不修改、不删除任何文件，不动注册表
#   - **自动脱敏**：auth.json 里的加密口令只报"有没有"，不打印内容
#   - 快照式：每次运行追加一条记录，方便对比"操作前 / 操作后"
#
# 用法（在 PowerShell 里，不需要管理员）：
#   cd 到本脚本所在目录
#   powershell -ExecutionPolicy Bypass -File .\rc011-collect.ps1 -Label before
#   ... 做操作 ...
#   powershell -ExecutionPolicy Bypass -File .\rc011-collect.ps1 -Label after-open-A
#
# 产出：同目录下 rc011-evidence-<电脑名>.txt，把它发回即可。

param(
    [string]$Label = "snapshot",
    [string]$AppDir = "$env:APPDATA\Hello Pix"
)

$ErrorActionPreference = "Continue"
$outFile = Join-Path $PSScriptRoot ("rc011-evidence-{0}.txt" -f $env:COMPUTERNAME)

function W([string]$text) {
    Write-Host $text
    Add-Content -Path $outFile -Value $text -Encoding UTF8
}

function Section([string]$title) {
    W ""
    W ("=" * 70)
    W ("  " + $title)
    W ("=" * 70)
}

# 每次运行追加一个带时间戳的分节，方便前后对比
Section ("快照 [" + $Label + "]  " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))

# ---------------------------------------------------------------- 系统环境
Section "1. Windows 环境"
W ("  时间            " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"))
W ("  计算机名        " + $env:COMPUTERNAME)
W ("  用户名          " + $env:USERNAME)
try {
    $os = Get-CimInstance Win32_OperatingSystem
    W ("  系统            " + $os.Caption + "  Build " + $os.BuildNumber + " (" + $os.OSArchitecture + ")")
    W ("  内存总量        " + [math]::Round($os.TotalVisibleMemorySize / 1MB, 2) + " GB")
    W ("  可用内存        " + [math]::Round($os.FreePhysicalMemory / 1MB, 2) + " GB")
} catch { W "  (取系统信息失败: $_)" }

# ------------------------------------------------------------ 客户端进程
Section "2. Hello Pix 进程"
try {
    $procs = Get-Process -Name "Hello Pix" -ErrorAction SilentlyContinue
    if (-not $procs) {
        W "  (没有正在运行的 Hello Pix 进程)"
    } else {
        W ("  进程数          " + @($procs).Count + "    ← 多开时应 >= 2")
        W ""
        W ("  {0,-8} {1,-20} {2,10} {3,12} {4,12}" -f "PID", "启动时间", "CPU(s)", "内存(MB)", "线程数")
        foreach ($p in $procs) {
            $cpu = if ($p.CPU) { [math]::Round($p.CPU, 1) } else { 0 }
            W ("  {0,-8} {1,-20} {2,10} {3,12} {4,12}" -f `
                $p.Id, $p.StartTime.ToString("MM-dd HH:mm:ss"), $cpu, `
                [math]::Round($p.WorkingSet64 / 1MB, 1), $p.Threads.Count)
        }
        W ""
        W "  --- 按进程细分（含 GPU / 渲染进程，白屏和 Renderer 崩溃看这里）---"
        foreach ($p in $procs) {
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue
            $n = if ($children) { @($children).Count } else { 0 }
            W ("  PID {0}: 子进程 {1} 个" -f $p.Id, $n)
        }
    }
} catch { W "  (取进程失败: $_)" }

# --------------------------------------------------- 用户数据目录总览
Section "3. 用户数据目录"
W ("  路径            " + $AppDir)
if (-not (Test-Path $AppDir)) {
    W "  !! 目录不存在 —— 客户端可能还没登录过，或安装的是免安装版且换了位置"
} else {
    W ""
    W "  --- 文件列表 ---"
    Get-ChildItem $AppDir -File -ErrorAction SilentlyContinue | ForEach-Object {
        W ("    {0,-28} {1,10} 字节  {2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString("MM-dd HH:mm:ss"))
    }
    W ""
    W "  --- 子目录 ---"
    Get-ChildItem $AppDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $n = (Get-ChildItem $_.FullName -ErrorAction SilentlyContinue | Measure-Object).Count
        W ("    {0,-28} {1,6} 项     {2}" -f $_.Name, $n, $_.LastWriteTime.ToString("MM-dd HH:mm:ss"))
    }
}

# ------------------------------------------- 分区目录（多开隔离的关键证据）
Section "4. Partitions 分区目录  ★多开隔离的关键证据★"
$partDir = Join-Path $AppDir "Partitions"
if (-not (Test-Path $partDir)) {
    W "  (还没有任何分区目录 —— 尚未打开过任何平台网页)"
} else {
    $dirs = Get-ChildItem $partDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
    W ("  分区总数        " + @($dirs).Count)
    W ""
    W ("  {0,-46} {1,-18} {2}" -f "分区目录名", "最后写入", "内含项数")
    foreach ($d in $dirs) {
        $n = (Get-ChildItem $d.FullName -ErrorAction SilentlyContinue | Measure-Object).Count
        W ("  {0,-46} {1,-18} {2}" -f $d.Name, $d.LastWriteTime.ToString("MM-dd HH:mm:ss"), $n)
    }
    W ""
    W "  【怎么判读】"
    W "    分区命名规则 = pix-<PIXS用户名>-<平台ID>-<序号>"
    W "    如果两个客户端进程各开一个 Telegram，却只出现同一个"
    W "    pix-...-telegram-z-<同一个序号> 目录 → 两个实例共用了分区（隔离失败）"
    W "    如果出现 telegram-z-1 和 telegram-z-2 两个不同目录 → 隔离正常"
}

# --------------------------------------------------- 各状态文件（脱敏）
Section "5. 客户端状态文件（口令已脱敏）"
function DumpJson([string]$name, [string]$path) {
    W ""
    W ("  --- " + $name + " ---")
    if (-not (Test-Path $path)) { W "    (不存在)"; return }
    try {
        $raw = Get-Content $path -Raw -ErrorAction Stop
        # auth.json 含加密口令，只报存在性
        if ($name -eq "auth.json") {
            $o = $raw | ConvertFrom-Json
            W ("    remember            " + $o.remember)
            W ("    autoLogin           " + $o.autoLogin)
            W ("    username            " + $o.username)
            W ("    passwordEnc 存在    " + [bool]$o.passwordEnc + "   (内容不打印)")
        } else {
            if ($raw.Length -gt 4000) { W ("    (过长，只打印前 4000 字符)") ; $raw = $raw.Substring(0, 4000) }
            W ("    " + $raw)
        }
    } catch { W ("    (读取失败: " + $_) + ")") }
}

DumpJson "auth.json"           (Join-Path $AppDir "auth.json")
DumpJson "open-apps.json"      (Join-Path $AppDir "open-apps.json")
DumpJson "config.json"         (Join-Path $AppDir "config.json")
DumpJson "device-id"           (Join-Path $AppDir "device-id")
DumpJson "proxy-ip-history.json" (Join-Path $AppDir "proxy-ip-history.json")

# ---------------------------------------------------------- 网络连接
Section "6. 客户端当前网络连接（代理是否生效）"
try {
    $procs = Get-Process -Name "Hello Pix" -ErrorAction SilentlyContinue
    if ($procs) {
        $ids = @($procs | ForEach-Object { $_.Id })
        $conns = Get-NetTCPConnection -ErrorAction SilentlyContinue |
                 Where-Object { $ids -contains $_.OwningProcess -and $_.State -eq "Established" }
        if (-not $conns) {
            W "  (没有已建立的连接)"
        } else {
            W ("  {0,-22} {1,-22} {2}" -f "本地", "远端", "PID")
            $conns | Select-Object -First 60 | ForEach-Object {
                W ("  {0,-22} {1,-22} {2}" -f `
                    ($_.LocalAddress + ":" + $_.LocalPort), `
                    ($_.RemoteAddress + ":" + $_.RemotePort), $_.OwningProcess)
            }
            W ""
            W "  【怎么判读】用了代理时，远端地址应是代理服务器 IP，"
            W "  而不是 web.telegram.org / web.whatsapp.com 的真实 IP。"
        }
    } else {
        W "  (客户端未运行)"
    }
} catch { W "  (取连接失败: $_)" }

# ------------------------------------------------------------- 安装包指纹
Section "7. 安装包 SHA-256（如果你手上有安装包）"
$candidates = @(
    "$env:USERPROFILE\Downloads\HelloPix-Setup-0.1.11.exe",
    "$env:USERPROFILE\Desktop\HelloPix-Setup-0.1.11.exe",
    "$env:USERPROFILE\Downloads\Hello Pix 0.1.11.exe",
    "$env:USERPROFILE\Desktop\Hello Pix 0.1.11.exe",
    "$PSScriptRoot\HelloPix-Setup-0.1.11.exe"
)
$found = $false
foreach ($c in $candidates) {
    if (Test-Path $c) {
        $found = $true
        $h = (Get-FileHash $c -Algorithm SHA256).Hash.ToLower()
        W ("  " + $c)
        W ("    SHA-256  " + $h)
    }
}
if (-not $found) {
    W "  (在 Downloads / Desktop / 本脚本目录下没找到 0.1.11 安装包)"
    W "  你可以手动跑： Get-FileHash <安装包路径> -Algorithm SHA256"
}

Section "快照结束"
W ""
W ("  已写入：" + $outFile)
W "  把这个文件发回给开发即可。"
