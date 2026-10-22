# audio.ps1 —— 原子岛的真实频谱引擎：WASAPI loopback 抓系统混音 -> 加窗 FFT -> 对数分频频段。
#
# 为什么不是「电平表」：IAudioMeterInformation::GetPeakValue 只有一个标量，而且这台机器实测
# 「静音播放器后音量条还有 0.33」（endpoint 音量旋钮不作用于表），拿它当频谱就是假的。
# loopback 抓的是混音后的真实采样，判据能落在频点上：放 1000Hz 纯音，谱峰必须报 996Hz 附近、
# 最响的频段必须是盖住 1000Hz 那一格 —— 见 test/audio-test.mjs。
#
# 三条实现约束（都是 probe 阶段踩出来的，别再改回去）：
#   1. IID 和 vtable 顺序按本机 SDK 抄（C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\um）：
#      mmdeviceapi.idl:396（IMMDeviceCollection）、Audioclient.h 的 IAudioClient/IAudioCaptureClient。
#      HKCR\Interface 里根本没有 WASAPI 的接口名（30637 项全扫过），凭记忆写 GUID 必炸 E_NOINTERFACE。
#      （2026-09-27 又验证了一次：凭记忆写的三个 session 接口 IID 全是错的，头文件里才是对的。）
#   2. WAVEFORMATEX 的 blockAlign 在偏移 12、bits 在 14（不是 10/12）：记错一位就把 float32 当 int16 解，
#      频谱整条歪掉而 rms 看着还挺正常，最难查。
#   3. FFT 每一级的旋转角步长是 FFT/2/len，写成 FFT/len 会让角度翻倍，谱峰跑到错误频点
#      （实测 440Hz 报 410、1000Hz 报 598、4000Hz 报 2473）。
#
# 为什么要抓「所有」活动端点，而不是只抓默认那一个（2026-09-27 的实测教训）：
# 本机 EnumAudioEndpoints(eRender, ACTIVE) 给出 2 个端点，其中一个既不是 console 也不是 multimedia
# 默认。只听默认端点时，播放器被指到另一个设备（蓝牙 dongle、HDMI、耳机切换软件、播放器自己选的输出）
# 就等于「人在放歌、柱子躺平」，而且从屏幕上完全看不出是设备不对还是引擎死了。现在每个活动端点各开
# 一条回环流、各算一份谱，对外取逐格最大值；每 3 秒重数一遍端点，插拔设备会自动重开流。
# 谁在响这件事由 {"cmd":"audio"} 的 sources 字段说清楚，不用猜。
#
# 「停音必须归零」是这套的验收线，也是它最反直觉的地方：loopback 在系统彻底安静时**不给包**
# （probe 实测 after stop 那一轮 win=0），所以频谱不是「算出 0」而是「不再更新」。这里用停顿衰减
# 把它补上：超过 stallMs 没有新分析窗，就按 (停顿-stallMs)/250ms 线性把上一窗的谱压到 0。
# 只有音频真的停了才会走到这条路径，所以它不会把正在放的歌压掉。
#
# Levels() 和 Bars() 是两件事，别混：
#   Levels() 是物理量（满幅正弦≈1.0），判据挂在它上面，改显示不该动它；
#   Bars() 是柱高 0..1，按 dB 折算（audioFloorDb 那一档=0 高，满幅=1 高）。
#   直接拿 Levels() 当高度是这次「幅度太小看不见」的根因：正常听音量的音乐每格只有 0.01~0.05，
#   17px 里长不到 1px，看着跟没开一样。
#
# 隐私边界（写进 docs/CONFIG.md）：引擎只在内存里留十几个频段能量这一份标量，不落盘、不出机器、
# 不存采样、不做识别。audio.json 里是频段能量数字，不是内容。
# 设备端点 ID 只进 %LOCALAPPDATA%\win-island\audio.json，不进仓库、不外传。
#
# 依赖：无（dot-source 后用 Start-IslandAudio / Get-IslandAudioLevels / Get-IslandAudioBars /
#         Get-IslandAudioSnapshot / Stop-IslandAudio）。
# 注意：本文件必须存成「UTF-8 带 BOM」，否则 PowerShell 5.1 按 GBK 读，中文注释会吞掉下一行代码。

# 编译放在函数里、只有真要开频谱时才编：这块 C# 有四百多行，开机自启时如果 audioOn=false，
# 不该让岛上凭空多花一秒在 Add-Type 上（而且编失败了也只是频谱没有，不是整个岛起不来）。
function Ensure-IslandAudioType {
  if ('IslandAudio' -as [type]) { return $true }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDevEnumCom { }

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate([In] ref Guid iid, int clsCtx, IntPtr ap, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(int stgm, out IntPtr props);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IntPtr device);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr cb);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr cb);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
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

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out int frames, out int flags, out long devPos, out long qpcPos);
    [PreserveSig] int ReleaseBuffer(int framesRead);
    [PreserveSig] int GetNextPacketSize(out int frames);
}

public static class IslandAudio {
    const int FFT = 4096;
    const int MAXB = 32;
    const int MAXSRC = 4;          // 最多同时回环几个输出设备：再多就是拿 CPU 换看不见的收益
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int CLSCTX_INPROC_SERVER = 1;
    const int FADEMS = 250;        // 判定「停了」之后再压多久到 0：固定值，写进 docs/CONFIG.md 的说明里

    static Thread worker;
    static volatile bool run;
    // 代数：Stop() 之后立刻 Open()（改 audioBands 就是这条路径）时，旧线程可能还在收包。
    // 只靠 run 一个布尔分不出「新旧两条线程」，旧那条会把新起的流当成自己的，屏幕上就是两条流抢一份混音。
    static volatile int gen;
    static string status = "not started";
    static string mixinfo = "";

    // 可调的只有这几项：频段数在 Open 时定（改它要重开抓取流），增益/停顿/显示下限随时改，绘制端每帧都读
    static int bandsN = 12;
    static double gain = 1.0;
    static int stallMs = 150;
    static double floorDb = 46;

    static object gate = new object();

    // 一条活动输出端点 = 一条回环流 + 一份自己的谱。只有 worker 线程写，读侧（UI 线程、快照）全部走 gate。
    class Src {
        public string id = "";
        public string label = "";
        public IAudioClient cli;
        public IAudioCaptureClient cap;
        public int chans = 2, rate = 48000, blockAlign = 8;
        public bool isFloat = true;
        public double[] acc = new double[FFT];
        public int accN;
        public double[] raw = new double[MAXB];
        public double level, peakHz;
        public long windows;
        public DateTime lastWin = DateTime.MinValue;
        public string err = "";
        public byte[] buf = new byte[65536];
    }
    static List<Src> srcs = new List<Src>();
    static string defId = "";
    static long lastScan;
    // 这批流是为哪一代（gen）开的。Stop()+Open() 会 gen++，而 srcs 里那批流的 COM 客户端已经被
    // 旧线程 Stop() 掉了 —— 少了这个判据，「端点表没变就什么都不做」的优化会把这批准死的流当成
    // 「还在跑」直接 return，status 永远停在 opening…、分析窗数冻住，屏幕上就是一排看不见的地板条
    // （2026-09-27 实测：岛里跑的就是这条死路，同一个进程单独起引擎却正常）。
    static int builtGen = -1;

    // 全设备共用的 FFT 工作台：同一时刻只有一条 worker 线程在算，不需要每端点一套
    static double[] re = new double[FFT], im = new double[FFT];
    static double[] win = new double[FFT];
    static int[] rev = new int[FFT];
    static double[,] tw = new double[FFT / 2, 2];
    static float[] mono = new float[FFT * 8];
    static double[] mag = new double[FFT / 2];
    static double[] edges = BuildEdges(12);

    static double[] BuildEdges(int n) {
        double[] e = new double[n + 1];
        for (int i = 0; i <= n; i++) e[i] = 40.0 * Math.Pow(16000.0 / 40.0, (double)i / n);
        return e;
    }

    // 返回 "ok rate=48000 ch=2 ... srcs=2" 或一句失败原因：调用方按前缀判，别只看有没有异常
    // Open 不等结果：岛在 UI 线程上调它，等 4 秒就是屏幕上一次看得见的卡死。
    // 开没开成看 Status()（"opening..." -> "ok …" / "…hr=0x…"），失败由 Run() 自己每秒重试。
    public static string Open(int bands) {
        if (bands < 1) bands = 1;
        if (bands > MAXB) bands = MAXB;
        bandsN = bands;
        edges = BuildEdges(bands);
        BuildFftTables();
        if (run) return status;
        run = true;
        int myGen = ++gen;
        status = "opening...";
        worker = new Thread(new ThreadStart(delegate { Run(myGen); }));
        worker.IsBackground = true;
        // COM 全部在这条线程上建：RCW 建在 PowerShell 的 STA 线程上，跨公寓封送是额外的一处失败点
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        return status;
    }

    // 测试用：开完直接等到有结论，免得每个用例自己写轮询
    public static string Start(int bands) {
        string s = Open(bands);
        for (int i = 0; i < 100 && (s == "opening..." || s == "running..."); i++) {
            Thread.Sleep(50); s = status;
        }
        return s;
    }

    // 关掉必须把 status 一起改掉：它要是还留着上一次成功时的 "ok rate=…"，
    // 调用方那句「已经开着就别重开」的判断会被骗过去，于是关再开之后根本没有线程在跑，
    // 屏幕上柱子永远躺平，而日志/管道里一切「正常」（实测踩过：菜单上关一下再开一下就复现）。
    public static void Stop() { run = false; gen++; status = "closed"; }
    public static string Status() { return status; }
    public static bool Running() { return run; }
    public static string MixInfo() { return mixinfo; }

    public static void Tune(double g, int stall, double fb) {
        if (g > 0) gain = g;
        if (stall > 0) stallMs = stall;
        if (fb >= 6 && fb <= 120) floorDb = fb;
    }

    public static int BandCount() { return bandsN; }

    // 当前真的生效的显示下限（dB）。bars 就是按它折算出来的，调用方不知道它就解不开那份柱高：
    // audio.json 里 bands/bars 是同一瞬态的两口径，再配上这个数才是自洽的一份数据。
    // 为什么不只让调用方读自己的配置：改配置到岛上生效之间有一个写文件的间隔，
    // 测试拿「我设了 60」当事实就会拿到上一档的柱高（实测把 dB 自校验判成偏差 0.49）。
    public static double FloorDb() { lock (gate) { return floorDb; } }

    static double FloorLin() { return Math.Pow(10.0, -floorDb / 20.0); }

    // 逐端点合并：同一时刻往往只有一两个设备在响，取每格的最大值 —— 柱子跟着最响的那个设备走。
    // 停顿衰减在这里按「每个设备自己最后出窗的时刻」算，不是全局一个 lastWin：
    // 一个设备安静不该把另一个正在响的设备一起压成 0。
    static double[] Merged() {              // 调用方必须已经持有 gate
        double f = FloorLin();
        double[] o = new double[bandsN];
        for (int i = 0; i < srcs.Count; i++) {
            Src s = srcs[i];
            double k = Stall(s.lastWin);
            if (k <= 0) continue;
            for (int b = 0; b < bandsN; b++) {
                double v = s.raw[b] * k * gain;
                if (v < f) v = 0;           // 低于显示下限就是真的 0：判据读到的 0 不需要再解释「其实是一点几 e-4」
                if (v > 1) v = 1;
                if (v > o[b]) o[b] = v;
            }
        }
        return o;
    }

    // 柱高 0..1：按 dB 折算。audioFloorDb 那一档是 0 高，满幅是 1 高。
    // 为什么要折而不是乘个增益：正常听音量的音乐每格只有 0.01~0.05，线性高度下 17px 里长不到 1px，
    // 用户看到的就是「开了但没显示」（2026-09-27 实测）。dB 折完 0.02 已经是三成高度。
    //
    // 一次锁里同时给出两口径 —— 这是 bands/bars 唯一的取数入口。
    // 分开 lock 拿 Levels() 再 Bars()，两次之间恰好过了一个新分析窗（每 85ms 一个）就会把
    // 「上一刻的 bands + 下一刻的 bars」拼进同一份 audio.json：外部看到的就成了柱子还指着 0.8、
    // 物理量却已经是 0，而 dB 折算的自校验（bars = curve(bands)）也会因此假失败。
    public static double[][] Pair() {
        lock (gate) {
            double[] v = Merged();
            double[] o = new double[bandsN];
            for (int i = 0; i < bandsN; i++) {
                if (v[i] <= 0) continue;
                double y = (20.0 * Math.Log10(v[i]) + floorDb) / floorDb;
                o[i] = y < 0 ? 0 : (y > 1 ? 1 : y);
            }
            return new double[][] { v, o };
        }
    }

    public static double[] Levels() { return Pair()[0]; }

    public static double[] Bars() { return Pair()[1]; }

    public static double Level() {
        lock (gate) {
            double m = 0;
            foreach (Src s in srcs) { double v = s.level * Stall(s.lastWin); if (v > m) m = v; }
            return m;
        }
    }

    public static double PeakHz() {
        lock (gate) {
            Src t = null; double m = 0;
            foreach (Src s in srcs) {
                double v = s.level * Stall(s.lastWin);
                if (v > m) { m = v; t = s; }
            }
            return t == null ? 0 : t.peakHz * Stall(t.lastWin);
        }
    }

    // 分析窗总数：所有设备相加。测试判据「放音这段时间有没有在出窗」读这个。
    public static long Windows() { lock (gate) { long n = 0; foreach (Src s in srcs) n += s.windows; return n; } }

    // 距离「任一设备」最后一次出窗过了多久：从没出过窗返回 -1。
    // 给 Start-IslandAudio 判「线程活着但已经不吐数据了」用 —— 只看 run 会被卡死的 COM 调用骗过去。
    public static double IdleMs() {
        lock (gate) {
            double best = -1;
            foreach (Src s in srcs) {
                if (s.lastWin == DateTime.MinValue) continue;
                double v = (DateTime.UtcNow - s.lastWin).TotalMilliseconds;
                if (best < 0 || v < best) best = v;
            }
            return best;
        }
    }

    // 每个设备一行：谁在响、出过多少窗、最后一次出窗多久之前、开流失败的原因。
    // 「捕捉不到我放的媒体」这种问题靠这一行就能分清是设备没被抓、抓到了但没声、还是引擎死了。
    // rms 必须逐设备报：多设备归并取的是每格最大值，一台虚拟声卡在自己的回环流上吐垃圾采样
    // （实测 rms 0.4、谱峰跑到 23kHz）就会把整条谱顶起来，只看合并值永远查不到是哪台。
    public static string Sources() {
        lock (gate) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < srcs.Count; i++) {
                Src s = srcs[i];
                if (i > 0) sb.Append(" | ");
                sb.Append(s.label + " win=" + s.windows + " idle=" +
                    (s.lastWin == DateTime.MinValue ? "never" : (int)(DateTime.UtcNow - s.lastWin).TotalMilliseconds + "ms") +
                    " rms=" + (s.level * Stall(s.lastWin)).ToString("F4"));
                if (s.err != "") sb.Append(" err=" + s.err);
            }
            return sb.Length == 0 ? "(no active endpoint)" : sb.ToString();
        }
    }

    // 1 = 这个设备在放；0 = 停了超过 stallMs+fadeMs
    static double Stall(DateTime lastWin) {
        if (lastWin == DateTime.MinValue) return 0;
        double idle = (DateTime.UtcNow - lastWin).TotalMilliseconds;
        if (idle <= stallMs) return 1;
        double k = 1.0 - (idle - stallMs) / FADEMS;
        return k < 0 ? 0 : k;
    }

    static void BuildFftTables() {
        int bits = 0; while ((1 << bits) < FFT) bits++;
        for (int i = 0; i < FFT; i++) {
            int r = 0;
            for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
            rev[i] = r;
        }
        for (int i = 0; i < FFT / 2; i++) {
            double a = -2.0 * Math.PI * i / (FFT / 2.0);
            tw[i, 0] = Math.Cos(a); tw[i, 1] = Math.Sin(a);
        }
        for (int i = 0; i < FFT; i++)
            win[i] = 0.5 - 0.5 * Math.Cos(2.0 * Math.PI * i / (FFT - 1));
    }

    static void Fft() {
        for (int i = 0; i < FFT; i++) {
            int j = rev[i];
            if (j > i) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= FFT; len <<= 1) {
            int half = len >> 1;
            // tw[k] = exp(-2pi i k/(FFT/2))，本级要 exp(-2pi i j/len) -> k = j*(FFT/2)/len
            int step = FFT / 2 / len;
            for (int i = 0; i < FFT; i += len) {
                for (int j = 0; j < half; j++) {
                    double wr = tw[j * step, 0], wi = tw[j * step, 1];
                    double ur = re[i + j], ui = im[i + j];
                    double vr = re[i + j + half] * wr - im[i + j + half] * wi;
                    double vi = re[i + j + half] * wi + im[i + j + half] * wr;
                    re[i + j] = ur + vr; im[i + j] = ui + vi;
                    re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
                }
            }
        }
    }

    // 端点 ID 形如 {0.0.0.00000000}.{91f515ae-3702-...}：第一个点在花括号里，取最后一段才是设备 guid。
    static string Tail(string id) {
        int i = id.LastIndexOf('.');
        if (i > 0 && id.Length >= i + 9) return id.Substring(i + 1, 8);
        return id.Length > 8 ? id.Substring(0, 8) : id;
    }

    // 只开默认端点（或前 N 个）：给判据和排查留的开关。某些声卡同时只喂一条回环流，
    // 多开反而把默认那条饿死 —— 这时候要能退回「只听默认」，而不是屏幕上什么都没有。
    public static void CapSources(int n) {
        if (n < 1) n = 1;
        if (n > MAXSRC) n = MAXSRC;
        maxSrc = n;
        lastScan = 0;      // 下一轮就重数端点表，改这个开关不该等三秒
    }
    public static int CapSources() { return maxSrc; }
    public static int MaxSources() { return MAXSRC; }

    static int maxSrc = MAXSRC;

    static void Run(int myGen) {
        while (run && gen == myGen) {
            try { PumpAll(myGen); }
            catch (Exception e) {
                // 抛出来的是我们自己的代码错了，重试没有意义：停下并把原因留给 Status()
                status = "exception: " + e.GetType().Name + " " + e.Message;
                run = false;
                return;
            }
            if (!run || gen != myGen) break;
            Thread.Sleep(1000);
        }
    }

    // 一条线程轮流转所有端点：包都是攒着的，GetNextPacketSize 不阻塞，所以单线程喂两三条流不会漏包，
    // 也省掉「每个设备一条线程」的 COM 公寓问题。
    static void PumpAll(int myGen) {
        while (run && gen == myGen) {
            long now = DateTime.UtcNow.Ticks;
            if (now >= lastScan) { RebuildSources(); lastScan = now + 30 * TimeSpan.TicksPerSecond / 10; }
            List<Src> cur;
            lock (gate) { cur = srcs; }
            bool got = false;
            for (int i = 0; i < cur.Count; i++) { if (Pump(cur[i])) got = true; }
            if (!got) Thread.Sleep(6);
        }
        lock (gate) {
            foreach (Src s in srcs) { try { if (s.cli != null) s.cli.Stop(); } catch { } }
        }
    }

    // 每 3 秒重数一遍活动端点：设备变了（插耳机/切蓝牙/播放器换了输出）就整条重来。
    // 端点没变且所有流都健康时什么都不做 —— 不然每 3 秒断一次流，柱子会跟着抖。
    static void RebuildSources() {
        List<string> ids = new List<string>();
        try {
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDevEnumCom();
            IntPtr dptr;
            defId = "";
            if (en.GetDefaultAudioEndpoint(0, 1, out dptr) == 0) {           // eRender, eMultimedia
                var dd = (IMMDevice)Marshal.GetTypedObjectForIUnknown(dptr, typeof(IMMDevice));
                IntPtr ip;
                if (dd.GetId(out ip) == 0) { defId = Marshal.PtrToStringUni(ip); CoTaskMemFree(ip); }
            }
            IntPtr coll;
            if (en.EnumAudioEndpoints(0, 1, out coll) != 0) { status = "EnumAudioEndpoints failed"; return; }
            var c = (IMMDeviceCollection)Marshal.GetTypedObjectForIUnknown(coll, typeof(IMMDeviceCollection));
            int n; c.GetCount(out n);
            if (n > MAXSRC * 2) n = MAXSRC * 2;
            for (int i = 0; i < n; i++) {
                IntPtr dp; if (c.Item(i, out dp) != 0) continue;
                var dev = (IMMDevice)Marshal.GetTypedObjectForIUnknown(dp, typeof(IMMDevice));
                IntPtr idp;
                if (dev.GetId(out idp) == 0) { ids.Add(Marshal.PtrToStringUni(idp)); CoTaskMemFree(idp); }
            }
            // 默认端点排第一：被 maxSrc 截掉时先丢非默认的，而不是丢正在出声的那个。
            // EnumAudioEndpoints 不保证顺序稳定，所以这里自己定序，不然每 3 秒重数都会以为「表变了」而重开流。
            ids.Sort(delegate (string a, string b) {
                int ra = a == defId ? 0 : 1, rb = b == defId ? 0 : 1;
                return ra != rb ? ra.CompareTo(rb) : string.Compare(a, b, StringComparison.Ordinal);
            });
            if (ids.Count > maxSrc) ids.RemoveRange(maxSrc, ids.Count - maxSrc);
        } catch (Exception e) { status = "enum ex: " + e.GetType().Name; return; }

        lock (gate) {
            bool same = builtGen == gen && ids.Count == srcs.Count;
            if (same) {
                for (int i = 0; i < ids.Count; i++)
                    if (srcs[i].id != ids[i]) { same = false; break; }
            }
            if (same) {
                // 端点表没变：只重试开败了的那几条，健康的一条都不碰。
                // 「有任何一条 err 就整表重开」会把正在出声的默认端点每 3 秒断一次流，柱子跟着抖。
                for (int i = 0; i < srcs.Count; i++) {
                    if (srcs[i].err == "" && srcs[i].cap != null) continue;
                    Src fresh = OpenSrc(srcs[i].id, i);
                    srcs[i] = fresh;
                }
                RebuildStatus();
                return;
            }
        }

        // 重建：先停旧的，再逐个开新的。开不成的也留在表里（带 err），这样 Sources() 能说出「这个设备抓不到」。
        lock (gate) { foreach (Src s in srcs) { try { if (s.cli != null) s.cli.Stop(); } catch { } } }
        List<Src> next = new List<Src>();
        for (int i = 0; i < ids.Count; i++) next.Add(OpenSrc(ids[i], i));
        lock (gate) { srcs = next; builtGen = gen; }
        RebuildStatus();
    }

    // status 只从「当前这批流」推出来：全开失败和一条没开到，得能区分，而且不能留着上一代的 "ok" 骗过调用方。
    static void RebuildStatus() {                 // 调用方持有 gate，或刚换完表
        List<Src> cur;
        lock (gate) { cur = srcs; }
        if (cur.Count == 0) { status = "no active render endpoint"; mixinfo = status; return; }
        int ok = 0;
        Src first = null;
        foreach (Src s in cur) { if (s.err == "") { ok++; if (first == null) first = s; } }
        if (first == null) status = "all endpoints failed: " + cur[0].err;
        else status = "ok rate=" + first.rate + " ch=" + first.chans + " srcs=" + ok + "/" + cur.Count;
        mixinfo = status;
    }

    static Src OpenSrc(string id, int idx) {
        Src s = new Src();
        s.id = id;
        s.label = "EP" + idx + (id == defId ? "(default)" : "") + " " + Tail(id);
        try {
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDevEnumCom();
            IntPtr dptr;
            if (en.GetDevice(id, out dptr) != 0) { s.err = "GetDevice"; return s; }
            IMMDevice dev = (IMMDevice)Marshal.GetTypedObjectForIUnknown(dptr, typeof(IMMDevice));
            Guid iidCli = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            IntPtr p;
            if (dev.Activate(ref iidCli, CLSCTX_INPROC_SERVER, IntPtr.Zero, out p) != 0) { s.err = "Activate"; return s; }
            s.cli = (IAudioClient)Marshal.GetTypedObjectForIUnknown(p, typeof(IAudioClient));
            IntPtr wf;
            if (s.cli.GetMixFormat(out wf) != 0) { s.err = "GetMixFormat"; return s; }
            int tag = Marshal.ReadInt16(wf, 0) & 0xFFFF;
            s.chans = Marshal.ReadInt16(wf, 2);
            s.rate = Marshal.ReadInt32(wf, 4);
            // WAVEFORMATEX: tag@0 ch@2 rate@4 avgBytes@8 blockAlign@12 bits@14（记错过一位，别再记回去）
            s.blockAlign = Marshal.ReadInt16(wf, 12);
            int bitsRes = Marshal.ReadInt16(wf, 14);
            s.isFloat = tag == 3 || (tag == 0xFFFE && bitsRes == 32);
            // 共享模式要求把 GetMixFormat 给的指针原样交回，NULL 没有被文档认可
            int hr = s.cli.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, wf, IntPtr.Zero);
            CoTaskMemFree(wf);
            if (hr != 0) { s.err = "Initialize hr=0x" + hr.ToString("X8"); return s; }
            Guid iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            if (s.cli.GetService(ref iidCap, out p) != 0) { s.err = "GetService"; return s; }
            s.cap = (IAudioCaptureClient)Marshal.GetTypedObjectForIUnknown(p, typeof(IAudioCaptureClient));
            if (s.cli.Start() != 0) { s.err = "Start"; return s; }
            return s;
        } catch (Exception e) { s.err = "ex:" + e.GetType().Name; return s; }
    }

    static bool Pump(Src s) {
        if (s.cap == null) return false;
        bool any = false;
        // 每轮最多取 16 包：某条流突然狂出包时不能让它把别的设备饿死
        for (int guard = 0; guard < 16; guard++) {
            int q;
            if (s.cap.GetNextPacketSize(out q) != 0) { s.err = "packet_size"; s.cap = null; return any; }
            if (q == 0) break;
            IntPtr data; int frames, flags; long d1, d2;
            if (s.cap.GetBuffer(out data, out frames, out flags, out d1, out d2) != 0) { s.err = "getbuffer"; return any; }
            any = true;
            if (frames > 0) Feed(s, data, frames, flags);
            s.cap.ReleaseBuffer(frames);
        }
        return any;
    }

    static void Feed(Src s, IntPtr data, int frames, int flags) {
        int total = frames * s.chans;
        if (total > mono.Length) mono = new float[total];
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
            // SILENT 段按零喂进分析窗（它确实是「这段时间没声音」的采样），静音也是数据点
            for (int i = 0; i < total; i++) mono[i] = 0;
        } else {
            int need = frames * s.blockAlign;
            if (need > s.buf.Length) s.buf = new byte[need];
            Marshal.Copy(data, s.buf, 0, need);
            int bps = s.blockAlign / s.chans;
            if (s.isFloat && bps == 4) {
                for (int i = 0; i < total; i++) mono[i] = BitConverter.ToSingle(s.buf, i * 4);
            } else if (bps == 2) {
                for (int i = 0; i < total; i++) mono[i] = BitConverter.ToInt16(s.buf, i * 2) / 32768f;
            } else if (bps == 3) {
                for (int i = 0; i < total; i++) {
                    int v = s.buf[i * 3] | (s.buf[i * 3 + 1] << 8) | (s.buf[i * 3 + 2] << 16);
                    if ((v & 0x800000) != 0) v -= 0x1000000;
                    mono[i] = v / 8388608f;
                }
            } else if (bps == 4) {
                for (int i = 0; i < total; i++) mono[i] = BitConverter.ToInt32(s.buf, i * 4) / 2147483648f;
            } else {
                s.err = "unsupported bps=" + bps;
                s.cap = null;
                return;
            }
        }
        for (int i = 0; i < frames; i++) {
            double v = 0;
            for (int c = 0; c < s.chans; c++) v += mono[i * s.chans + c];
            s.acc[s.accN++] = v / s.chans;
            if (s.accN >= FFT) { Analyse(s); s.accN = 0; }
        }
    }

    static void Analyse(Src s) {
        double sum2 = 0;
        for (int i = 0; i < FFT; i++) {
            double a = s.acc[i];
            sum2 += a * a;
            re[i] = a * win[i]; im[i] = 0;
        }
        Fft();
        double binHz = (double)s.rate / FFT;
        double peakMag = 0; int peakBin = 0;
        for (int k = 1; k < FFT / 2; k++) {
            double m = Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
            mag[k] = m;
            if (m > peakMag) { peakMag = m; peakBin = k; }
        }
        lock (gate) {
            s.windows++;
            s.level = Math.Sqrt(sum2 / FFT);
            s.peakHz = peakBin * binHz;
            s.lastWin = DateTime.UtcNow;
            for (int b = 0; b < bandsN; b++) {
                int lo = (int)Math.Max(1, Math.Ceiling(edges[b] / binHz));
                int hi = (int)Math.Min(FFT / 2 - 1, Math.Floor(edges[b + 1] / binHz));
                // 取该频段里最强的一根谱线，不是平均：平均会被格宽稀释 ——
                // 对数分频下高音那一格横跨几百个 bin，一个满幅正弦摊到 495 个 bin 上只剩零头，
                // 实测 0.32 幅度的 1000Hz 纯音平均口径只给到 0.03，柱子永远躺在地板线上。
                // 峰值口径 + 满幅正弦=1.0 的归一才讲得通（这是 Levels 的物理刻度，柱高另算，见 Bars）。
                double mv = 0;
                for (int k = lo; k <= hi; k++) { if (mag[k] > mv) mv = mag[k]; }
                double v = mv / (FFT / 4.0);      // Hann 窗下满幅正弦的主瓣谱线约 N/4，除掉它 => 1.0
                s.raw[b] = s.raw[b] * 0.5 + v * 0.5;
            }
        }
    }

    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr pv);
}
'@ -ReferencedAssemblies 'System','System.Core','PresentationCore','WindowsBase'
  return ('IslandAudio' -as [type]) -ne $null
}

# ---------- PowerShell 侧的薄封装：岛只用这几个（Start/Stop/Levels/Bars/Snapshot），参数全从 $script:P 来 ----------

# 频段边界：40Hz~16kHz 对数分 n 格。测试拿它算「放 1000Hz 应该亮第几格」，
# 所以规则和引擎同一份，不在测试里再抄一遍系数。
function Get-IslandAudioBandEdges([int]$bands) {
  $e = @()
  for ($i = 0; $i -le $bands; $i++) { $e += 40.0 * [Math]::Pow(16000.0 / 40.0, $i / $bands) }
  return $e
}

# 「已经开着」要同时满足三件事才成立：线程在跑、格数没变、而且真的还在出数据。
# 只看 Status() 会被骗（Stop() 之后它可能还留着上一次的 "ok rate=…"）；只看 run 会被
# 卡在 COM 调用里的线程骗（run 是 true，分析窗却再也不来）。
# 出窗的宽限期取 5 分钟而不是十几秒：整机安静时 loopback 一个包都不给，idleMs 本来就会一直涨，
# 阈值太短会变成「安静时每十几秒无谓重开一次流」，把 windows 计数清零、柱子抖一下。
# 设备变了另有每 3 秒的重数兜底，不需要靠这个阈值发现。
function Start-IslandAudio([int]$bands, [double]$gain, [int]$stallMs, [int]$floorDb) {
  if (-not (Ensure-IslandAudioType)) { return 'Add-Type 编译失败（看 island.err.log）' }
  [IslandAudio]::Tune($gain, $stallMs, $floorDb)
  $st = [IslandAudio]::Status()
  $idle = [double][IslandAudio]::IdleMs()
  $live = [IslandAudio]::Running() -and ([IslandAudio]::BandCount() -eq $bands) -and
          ($st -eq 'opening...' -or ($st -like 'ok*' -and ($idle -lt 0 -or $idle -le 300000)))
  if ($live) { return $st }
  [IslandAudio]::Stop()
  return [IslandAudio]::Open($bands)
}

function Stop-IslandAudio { if ('IslandAudio' -as [type]) { [IslandAudio]::Stop() } }

# 抓取端点数的上限（判据/排查用）：0 = 全部活动端点（默认），1 = 只听默认端点。
# 要先 Ensure 类型，否则「还没编译」时这句是空操作（实测踩过：cap 没生效，对照臂其实跑的是同一套流）。
function Set-IslandAudioCap([int]$n) {
  if (-not (Ensure-IslandAudioType)) { return }
  if ($n -le 0) { $n = [IslandAudio]::MaxSources() }
  [IslandAudio]::CapSources($n)
}
function Get-IslandAudioCap { if ('IslandAudio' -as [type]) { return [IslandAudio]::CapSources() } return 0 }

function Get-IslandAudioStatus { if ('IslandAudio' -as [type]) { return [IslandAudio]::Status() } return 'not compiled' }

function Get-IslandAudioSources { if ('IslandAudio' -as [type]) { return [IslandAudio]::Sources() } return 'not compiled' }

# 物理量：判据挂在这一份上（满幅正弦≈1.0）
function Get-IslandAudioLevels {
  if ('IslandAudio' -as [type]) { return @([IslandAudio]::Levels()) }
  return @()
}

# 柱高 0..1：dB 折算之后的，绘制只用这一份
function Get-IslandAudioBars {
  if ('IslandAudio' -as [type]) { return @([IslandAudio]::Bars()) }
  return @()
}

# 给管道 API 的那一份（island 每 ~0.5s 原子替换 audio.json，api.mjs 的 {"cmd":"audio"} 读它）
function Get-IslandAudioSnapshot {
  $has = ('IslandAudio' -as [type]) -ne $null
  # bands 和 bars 必须出自同一次 Pair()：这一份是要整个写进 audio.json 的，
  # 分开取就会给出「一份物理量 + 晚一个窗的柱高」的拼接数据（判据按 bars=curve(bands) 校验时误报）。
  $pr = if ($has) { [IslandAudio]::Pair() } else { @(), @() }
  $lv = @($pr[0])
  $br = @($pr[1])
  $lvl = if ($has) { [Math]::Round([double][IslandAudio]::Level(), 5) } else { 0 }
  $pk = if ($has) { [Math]::Round([double][IslandAudio]::PeakHz(), 1) } else { 0 }
  $wn = if ($has) { [long][IslandAudio]::Windows() } else { 0 }
  $id = if ($has) { [Math]::Round([double][IslandAudio]::IdleMs(), 0) } else { -1 }
  return @{
    bands   = $lv
    bars    = $br
    floorDb = if ($has) { [Math]::Round([double][IslandAudio]::FloorDb(), 3) } else { 0 }
    level   = $lvl
    peakHz  = $pk
    windows = $wn
    idleMs  = $id
    sources = if ($has) { Get-IslandAudioSources } else { 'not compiled' }
    status  = Get-IslandAudioStatus
    at      = [long]([DateTimeOffset]::Now).ToUnixTimeMilliseconds()
  }
}
