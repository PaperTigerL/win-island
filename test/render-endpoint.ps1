# render-endpoint.ps1 —— 把纯音**指定**渲染到某个输出端点（默认端点之外的某一个也能放）。
#
# 为什么测试需要它：频谱那条判据「抓的是我电脑上播放的媒体」要能造出「声音不在默认设备上」的场景。
# 只靠默认设备（SoundPlayer / WAV 文件）永远测不到这一档，改成一个设备都不漏抓就等于没改。
# 这里是正经的 WASAPI 共享模式渲染流，不是「假装有声」：写进 GetBuffer 的浮点采样真的会到那个设备上。
#
# 用法：
#   powershell -File test/render-endpoint.ps1 -List
#   powershell -File test/render-endpoint.ps1 -Index 1 -Tones 1000 -Amp 0.5 -HoldMs 3000
#   powershell -File test/render-endpoint.ps1 -Index 1 -Tones 1000 -Amp 0.5 -HoldMs 1200 -GateMs 1200 -Pairs 4
# 输出协议和 audio-harness.ps1 一致：真开始出声之前先打一行 "playing ..."，判据等这一行再采样
# （进程起来到真的出声中间有几秒，早期实测被这个坑过好几次，别拿启动即出声当默认）。
# 给了 -GateMs 就是明暗交替放（往这个设备写音 / 写等长静音，各打一行 "on k" / "off k"）：
# 判据要的是「每一次 on 都比紧挨着它的 off 高」，而背景声和这个门不相关 —— 环境一直有声音时
# 「比某个绝对值高」根本测不出来（2026-09-27 实测：这台机器常年有背景声，bars 常年 0.5 以上）。
# 静音段写的是真 0 采样而不是把流停掉：流一停回环就不出分析窗，那是「没抓」不是「没响」，两件事得分开。
#
# IID 全部抄本机 SDK（凭记忆写错过三次，见 src/island/audio.ps1 顶部）：
#   IMMDevice/IMMDeviceEnumerator/IMMDeviceCollection/IAudioClient/IAudioCaptureClient 同 audio.ps1
#   IAudioRenderClient  F294ACFC-3146-4483-A7BF-ADDCA7C260E2   Audioclient.idl:769
# 注意：本文件必须存成「UTF-8 带 BOM」，否则 PowerShell 5.1 按 GBK 读，中文注释会吞掉下一行代码。
param([switch]$List, [int]$Index = 1, [string]$Tail = '', [string]$Tones = '1000',
       [double]$Amp = 0.5, [int]$HoldMs = 3000, [int]$Seed = 0, [int]$GateMs = 0, [int]$Pairs = 4)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class RTDevEnumCom { }

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface RTIMMDevice {
    [PreserveSig] int Activate([In] ref Guid iid, int clsCtx, IntPtr ap, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(int stgm, out IntPtr props);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface RTIMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IntPtr device);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface RTIMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr cb);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr cb);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface RTIAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long hnsBuffer, long hnsPeriod, IntPtr pwfx, IntPtr sessionId);
    [PreserveSig] int GetBufferSize(out int frames);
    [PreserveSig] int GetStreamLatency(out long hns);
    [PreserveSig] int GetCurrentPadding(out int frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pwfx, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr ppwfx);
    [PreserveSig] int GetDevicePeriod(out long defPeriod, out long minPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr hEvent);
    [PreserveSig] int GetService([In] ref Guid iid, out IntPtr svc);
}

[ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface RTIAudioRenderClient {
    [PreserveSig] int GetBuffer(int frames, out IntPtr data);
    [PreserveSig] int ReleaseBuffer(int framesWritten, int flags);
}

public static class EndpointTone {
    const int CLSCTX = 1;
    static readonly Guid G_CLIENT = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid G_REND = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");

    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);

    static string Id(RTIMMDevice dev) {
        IntPtr p; if (dev.GetId(out p) != 0 || p == IntPtr.Zero) return "";
        string s = Marshal.PtrToStringUni(p); CoTaskMemFree(p); return s;
    }

    // 把活动输出端点按「默认在前」列出来：和 src/island/audio.ps1 的 RebuildSources 同一套定序规则，
    // 不然测试里写的 Index 和引擎里的 EP 编号对不上，判据就成了猜谜。
    // 这里必须真的排序之后再编号：EnumAudioEndpoints 的顺序不保证和「默认在前」一致（实测过默认那台
    // 排在第二个的机器），-List 打第 0 行、-Index 0 却放到了另一台上，B7 两条臂就都在测同一台设备。
    public static string List() {
        StringBuilder sb = new StringBuilder();
        var en = (RTIMMDeviceEnumerator)new RTDevEnumCom();
        string def = "";
        IntPtr d;
        if (en.GetDefaultAudioEndpoint(0, 1, out d) == 0) def = Id((RTIMMDevice)Marshal.GetTypedObjectForIUnknown(d, typeof(RTIMMDevice)));
        IntPtr coll;
        if (en.EnumAudioEndpoints(0, 1, out coll) != 0) return "EnumAudioEndpoints failed";
        var c = (RTIMMDeviceCollection)Marshal.GetTypedObjectForIUnknown(coll, typeof(RTIMMDeviceCollection));
        int n; c.GetCount(out n);
        System.Collections.Generic.List<string> ids = new System.Collections.Generic.List<string>();
        for (int i = 0; i < n; i++) {
            IntPtr dp; if (c.Item(i, out dp) != 0) continue;
            var dev = (RTIMMDevice)Marshal.GetTypedObjectForIUnknown(dp, typeof(RTIMMDevice));
            ids.Add(Id(dev));
        }
        ids.Sort(delegate (string a, string b) {
            int ra = a == def ? 0 : 1, rb = b == def ? 0 : 1;
            return ra != rb ? ra.CompareTo(rb) : string.Compare(a, b, StringComparison.Ordinal);
        });
        for (int i = 0; i < ids.Count; i++)
            sb.AppendLine(i + " " + (ids[i] == def ? "default " : "") + ids[i]);
        return sb.ToString();
    }

    static string PickId(int index, string tail) {
        var en = (RTIMMDeviceEnumerator)new RTDevEnumCom();
        string def = "";
        IntPtr d;
        if (en.GetDefaultAudioEndpoint(0, 1, out d) == 0) def = Id((RTIMMDevice)Marshal.GetTypedObjectForIUnknown(d, typeof(RTIMMDevice)));
        IntPtr coll;
        if (en.EnumAudioEndpoints(0, 1, out coll) != 0) return null;
        var c = (RTIMMDeviceCollection)Marshal.GetTypedObjectForIUnknown(coll, typeof(RTIMMDeviceCollection));
        int n; c.GetCount(out n);
        System.Collections.Generic.List<string> ids = new System.Collections.Generic.List<string>();
        for (int i = 0; i < n; i++) {
            IntPtr dp; if (c.Item(i, out dp) != 0) continue;
            var dev = (RTIMMDevice)Marshal.GetTypedObjectForIUnknown(dp, typeof(RTIMMDevice));
            ids.Add(Id(dev));
        }
        ids.Sort(delegate (string a, string b) {
            int ra = a == def ? 0 : 1, rb = b == def ? 0 : 1;
            return ra != rb ? ra.CompareTo(rb) : string.Compare(a, b, StringComparison.Ordinal);
        });
        if (tail != null && tail.Length > 0) {
            foreach (string s in ids) if (s.Contains(tail)) return s;
            return null;
        }
        return index < ids.Count ? ids[index] : null;
    }

    public static string Play(int index, string tail, int[] tones, double amp, int holdMs, int seed, int gateMs, int pairs) {
        string id = PickId(index, tail);
        if (id == null) return "no such endpoint (index=" + index + " tail=" + tail + ")";
        var en = (RTIMMDeviceEnumerator)new RTDevEnumCom();
        IntPtr d;
        if (en.GetDevice(id, out d) != 0) return "GetDevice failed";
        var dev = (RTIMMDevice)Marshal.GetTypedObjectForIUnknown(d, typeof(RTIMMDevice));
        // static readonly Guid 不能当 ref 传（CS0192），一律先落局部变量
        Guid gCli = G_CLIENT, gRend = G_REND;
        IntPtr p;
        if (dev.Activate(ref gCli, CLSCTX, IntPtr.Zero, out p) != 0) return "Activate(IAudioClient) failed";
        RTIAudioClient cli = (RTIAudioClient)Marshal.GetTypedObjectForIUnknown(p, typeof(RTIAudioClient));
        IntPtr wf;
        if (cli.GetMixFormat(out wf) != 0) return "GetMixFormat failed";
        int tag = Marshal.ReadInt16(wf, 0) & 0xFFFF;
        int chans = Marshal.ReadInt16(wf, 2);
        int rate = Marshal.ReadInt32(wf, 4);
        int blockAlign = Marshal.ReadInt16(wf, 12);
        int bits = Marshal.ReadInt16(wf, 14);
        bool isFloat = tag == 3 || (tag == 0xFFFE && bits == 32);
        if (!isFloat || blockAlign / chans != 4) return "only float32 mix supported here, tag=" + tag + " bits=" + bits;
        // 共享模式：把 GetMixFormat 的指针原样交回去，缓冲区时长给 0 让驱动定
        if (cli.Initialize(0, 0, 0, 0, wf, IntPtr.Zero) != 0) { CoTaskMemFree(wf); return "Initialize(render) failed"; }
        CoTaskMemFree(wf);
        if (cli.GetService(ref gRend, out p) != 0) return "GetService(render) failed";
        var rend = (RTIAudioRenderClient)Marshal.GetTypedObjectForIUnknown(p, typeof(RTIAudioRenderClient));
        int bufFrames;
        if (cli.GetBufferSize(out bufFrames) != 0) return "GetBufferSize failed";
        if (cli.Start() != 0) return "Start failed";

        // 每个音一个错开的相位（和 audio-harness 同一个理由：同相叠加会把峰值推到 n 倍，归一化会削平）
        double[] ph = new double[tones.Length];
        double[] inc = new double[tones.Length];
        Random rc = new Random(seed == 0 ? 12345 : seed);
        for (int i = 0; i < tones.Length; i++) {
            ph[i] = rc.NextDouble() * 2 * Math.PI;
            inc[i] = 2 * Math.PI * tones[i] / rate;
        }
        double norm = amp / tones.Length;

        var sw = System.Diagnostics.Stopwatch.StartNew();
        long frame = 0;
        float[] samp = new float[bufFrames * chans];
        int total = gateMs > 0 ? pairs * (holdMs + gateMs) : holdMs;
        // 门是从绝对时间算的，不靠「循环跑了几次」：填充节奏由驱动决定，数圈会把明暗段时长算歪
        int lastGp = -1;
        try {
            Console.WriteLine("playing " + string.Join("+", tones) + " Hz on " +
                (id.Length > 20 ? id.Substring(id.Length - 20) : id) + " for " + total + " ms" +
                (gateMs > 0 ? " gate " + holdMs + "/" + gateMs + " x" + pairs : ""));
            Console.Out.Flush();
            while (sw.ElapsedMilliseconds < total) {
                long el = sw.ElapsedMilliseconds;
                int gp = gateMs > 0 ? (int)(el / (holdMs + gateMs)) * 2 + (el % (holdMs + gateMs) < holdMs ? 0 : 1) : 0;
                if (gp != lastGp) {
                    lastGp = gp;
                    Console.WriteLine((gateMs > 0 && gp % 2 == 1 ? "off " : "on ") + (gp / 2 + 1));
                    Console.Out.Flush();
                }
                bool tone = gateMs <= 0 || gp % 2 == 0;
                int pad;
                if (cli.GetCurrentPadding(out pad) != 0) break;
                int free = bufFrames - pad;
                if (free <= 0) { Thread.Sleep(4); continue; }
                IntPtr data;
                if (rend.GetBuffer(free, out data) != 0) break;
                // GetBuffer 给的就是「这 free 帧的起点」，所以偏移按 f 算，不是按累计帧号算
                for (int f = 0; f < free; f++) {
                    double s = 0;
                    for (int i = 0; i < tones.Length; i++) { ph[i] += inc[i]; if (tone) s += Math.Sin(ph[i]); }
                    float v = (float)(s * norm);
                    for (int c = 0; c < chans; c++) samp[f * chans + c] = v;
                }
                Marshal.Copy(samp, 0, data, free * chans);
                frame += free;
                rend.ReleaseBuffer(free, 0);
                Thread.Sleep(5);
            }
        } finally {
            try { cli.Stop(); } catch { }
        }
        return "done frames=" + frame + " ms=" + sw.ElapsedMilliseconds;
    }
}
'@ -ReferencedAssemblies 'System','System.Core'

if ($List) { [EndpointTone]::List() | Write-Host; return }

$freq = @($Tones.Split(',') | ForEach-Object { [int]$_.Trim() })
$r = [EndpointTone]::Play($Index, $Tail, $freq, $Amp, $HoldMs, $Seed, $GateMs, $Pairs)
Write-Host $r
