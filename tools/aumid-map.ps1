# AUMID -> 可执行文件 的反查表。
# 通知库里只有 AUMID，形态不统一：商店包是 Microsoft.WindowsCalculator_...!App，Win32 有的登记成
# QQ / WorkBuddy.WorkBuddy 这种开始菜单注册名，有的干脆就是一个 exe 路径。要点开「发这条通知的程序」，
# 光靠 shell:AppsFolder 只覆盖前两种，com.qoder.app / com.bilibili.bilibiliPC 这类就不在 AppsFolder 里。
# 系统自己认的方式是：开始菜单快捷方式上登记了 PKEY_AppUserModel_ID 属性，
# 所以扫两个开始菜单目录建一张 (AUMID -> 快捷方式 -> 目标 exe) 的表就能反查。
# 直接跑这个文件 = 打印整张表；被 island.ps1 点源化时只定义函数。
if (-not ('AumidMapNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AumidMapNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PropertyKey pKey);
    int GetValue(ref PropertyKey key, out PropVariant pv);
    int SetValue(ref PropertyKey key, ref PropVariant pv);
    int Commit();
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  public static extern void SHGetPropertyStoreFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc, int flags,
    ref Guid riid, out IPropertyStore store);

  [DllImport("ole32.dll")]
  public static extern int PropVariantClear(ref PropVariant pvar);

  public static string StringOf(IPropertyStore ps, Guid fmtid, uint pid) {
    PropertyKey k; k.fmtid = fmtid; k.pid = pid;
    PropVariant pv;
    if (ps.GetValue(ref k, out pv) != 0) return null;
    string s = null;
    try { if (pv.vt == 31 && pv.pointerValue != IntPtr.Zero) s = Marshal.PtrToStringUni(pv.pointerValue); }
    finally { PropVariantClear(ref pv); }   // 不清的话扫上千个快捷方式会一路漏
    return s;
  }

  public static string AppUserModelId(string lnkPath) {
    try {
      IPropertyStore ps = Store(lnkPath);
      return StringOf(ps, new Guid("9F4C2855-2F9F-45A2-8F6D-1C8E39D44D7A"), 10);
    } catch { return null; }
  }

  public static IPropertyStore Store(string lnkPath) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IPropertyStore ps;
    SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 0, ref iid, out ps);
    return ps;
  }

  // 调试用：把某个文件属性存储里全部键倒出来，别再靠猜 property key
  public static string[] Dump(string lnkPath) {
    try {
      IPropertyStore ps = Store(lnkPath);
      uint n;
      if (ps.GetCount(out n) != 0) return new string[] { "GetCount 失败" };
      string[] all = new string[n];
      for (uint i = 0; i < n; i++) {
        PropertyKey k;
        if (ps.GetAt(i, out k) != 0) { all[i] = i + " GetAt 失败"; continue; }
        PropVariant pv;
        int hr = ps.GetValue(ref k, out pv);
        string v = "";
        if (hr == 0 && pv.vt == 31 && pv.pointerValue != IntPtr.Zero) v = Marshal.PtrToStringUni(pv.pointerValue);
        all[i] = string.Format("{0} {1} pid={2} vt={3} {4}", i, k.fmtid, k.pid, pv.vt, v);
        if (hr == 0) PropVariantClear(ref pv);
      }
      return all;
    } catch (Exception e) { return new string[] { "异常: " + e.Message }; }
  }
}
'@ -Language CSharp
}

function Resolve-AumidExe {
  param([string]$Aumid)
  $map = Get-AumidExeMap
  if (-not $Aumid) { return $null }
  $k = $Aumid.ToLowerInvariant()
  if ($map.ContainsKey($k)) { return $map[$k].Exe }
  # 商店包的 AUMID 带 !App 后缀，注册名有时大小写/后缀对不上，再去掉后缀试一次
  $bare = ($k -replace '!.*$', '')
  if ($map.ContainsKey($bare)) { return $map[$bare].Exe }
  return $null
}

function Get-AumidExeMap {
  param([switch]$Force)
  if ($script:AumidExeMap -and -not $Force) { return $script:AumidExeMap }
  $map = @{}
  $roots = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'),
             [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
  $ws = New-Object -ComObject WScript.Shell
  foreach ($root in ($roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
    foreach ($f in (Get-ChildItem -Path $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
      $id = [AumidMapNative]::AppUserModelId($f.FullName)
      if (-not $id) { continue }
      $k = $id.ToLowerInvariant()
      if ($map.ContainsKey($k)) { continue }
      $exe = ''
      try { $exe = $ws.CreateShortcut($f.FullName).TargetPath } catch {}
      $map[$k] = [pscustomobject]@{ Aumid = $id; Lnk = $f.FullName; Exe = $exe }
    }
  }
  $script:AumidExeMap = $map
  return $map
}

if ($MyInvocation.InvocationName -eq '.') { return }

$map = Get-AumidExeMap -Force
"开始菜单里登记了 AUMID 的快捷方式： $($map.Count) 条"
foreach ($q in $args) {
  $hit = $map[$q.ToLowerInvariant()]
  if ($hit) { "  {0}  ->  {1}   （快捷方式 {2}）" -f $q, $hit.Exe, $hit.Lnk }
  else { "  {0}  ->  查不到" -f $q }
}
"全部："
foreach ($e in ($map.Values | Sort-Object Aumid)) { "  {0,-62} {1}" -f $e.Aumid, $e.Exe }
