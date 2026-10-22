# 只读诊断：列出某个 pid 的全部顶层窗口（含不可见的），用来判断岛屿窗口到底存不存在，
# 以及 activate.ps1 的筛选条件为什么把窗口全滤掉了。
#   powershell -File probe-windows.ps1 -ProcId 7740
#   powershell -File probe-windows.ps1            # 不带 pid 则列出所有有标题的顶层窗口
param([int]$ProcId = 0)
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rr, B; }
  const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  const int GW_OWNER = 4, GA_ROOTOWNER = 2, GA_PARENT = 1;

  public static string Line(IntPtr h, uint pid) {
    var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
    R r; GetWindowRect(h, out r);
    int ex = unchecked((int)GetWindowLongW(h, GWL_EXSTYLE));
    IntPtr own = GetWindow(h, GW_OWNER);
    IntPtr root = GetAncestor(h, GA_ROOTOWNER);
    IntPtr par = GetAncestor(h, GA_PARENT);
    return "hwnd=" + h + " pid=" + pid + " vis=" + (IsWindowVisible(h) ? 1 : 0) +
      " iconic=" + (IsIconic(h) ? 1 : 0) +
      " tool=" + (((ex & WS_EX_TOOLWINDOW) != 0) ? 1 : 0) +
      " noact=" + (((ex & WS_EX_NOACTIVATE) != 0) ? 1 : 0) +
      " owner=" + own + " rootSelf=" + (root == h ? 1 : 0) + " parSelf=" + (par == h ? 1 : 0) +
      " rect=" + r.L + "," + r.T + " " + (r.Rr - r.L) + "x" + (r.B - r.T) +
      " title=[" + sb + "]";
  }

  public static System.Collections.Generic.List<string> Find(uint want) {
    var outp = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (want == 0 || pid == want) {
        var sb = new StringBuilder(8); if (GetWindowTextW(h, sb, 8) > 0 || want != 0) outp.Add(Line(h, pid));
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$found = [W]::Find([uint32]$ProcId)
if (-not $found) { "pid $ProcId 没有任何符合条件的顶层窗口" } else { $found }
