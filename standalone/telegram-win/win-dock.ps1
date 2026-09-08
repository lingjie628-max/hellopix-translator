param(
  [int]$PidHint = 0,
  [string]$Mode = "bounds",
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PixWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
function Find-Tg {
  if ($PidHint -gt 0) {
    $p = Get-Process -Id $PidHint -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { return $p }
  }
  Get-Process -Name Telegram -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
}
$p = Find-Tg
if (-not $p) { Write-Output '{"ok":false}'; exit 0 }
$hwnd = $p.MainWindowHandle
if ($Mode -eq "move" -and $W -gt 0 -and $H -gt 0) {
  [void][PixWin]::MoveWindow($hwnd, $X, $Y, $W, $H, $true)
}
if ($Mode -eq "focus") {
  [void][PixWin]::SetForegroundWindow($hwnd)
}
$r = New-Object PixWin+RECT
[void][PixWin]::GetWindowRect($hwnd, [ref]$r)
Write-Output (@{
  ok = $true
  pid = $p.Id
  x = $r.Left
  y = $r.Top
  w = ($r.Right - $r.Left)
  h = ($r.Bottom - $r.Top)
} | ConvertTo-Json -Compress)
