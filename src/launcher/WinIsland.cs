// win-island.exe —— 编译出来的入口：负责「找到代码在哪、把两层拉起来、把状态问回来」。
//
// 为什么用 C# 而不是把整个岛也编译掉：这台机器的 dotnet SDK 是坏 shim（未打包进程拿不到
// 包身份，WinRT 那条路走不通），没有 rust/cargo，而 WPF 是系统自带的 —— 渲染层留在
// PowerShell + WPF 上才能做到零安装。抓取层要读通知库（wpndatabase.db，SQLite+WAL），
// 走的是 Node 的 node:sqlite；bun 1.2.9 实测没有 node:sqlite，所以也不能拿它编成单文件。
// 于是这个 exe 的定位很清楚：它是**启动器和控制台**，不是重新实现一遍应用。
//
// 编译：csc.exe（.NET Framework 4.8，Windows 自带）+ windres（版本信息和图标资源）
//      见 scripts/build.mjs，一条命令 npm run build。
// C# 5 语法上限：csc 4.8 只到 C# 5，所以这里没有字符串内插、没有 ?. 、没有表达式体成员。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Threading;

namespace WinIsland.Cli
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            SetConsoleUtf8();
            string cmd = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "status";
            try
            {
                switch (cmd)
                {
                    case "start": return Start(args);
                    case "stop": return Stop();
                    case "restart": return Start(args);
                    case "status": return Status(args);
                    case "test": return RunTests();
                    case "config": return OpenConfig();
                    case "data": return OpenData();
                    case "version": case "--version": case "-v": return Version();
                    case "help": case "--help": case "-h": return Help();
                    default:
                        Err("未知命令：" + cmd);
                        Help();
                        return 2;
                }
            }
            catch (Exception e)
            {
                Err(e.Message);
                return 1;
            }
        }

        // ---------- 路径定位：exe 可能在 bin\ 下，也可能和 src\ 同级（可移植包） ----------
        private static string ExeDir()
        {
            return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        }

        private static string FindRoot()
        {
            string marker = Path.Combine("src", "capture", "capture.mjs");
            string dir = ExeDir();
            for (int up = 0; up < 4 && dir != null; up++)
            {
                if (File.Exists(Path.Combine(dir, marker))) return dir;
                dir = Path.GetDirectoryName(dir);
            }
            throw new Exception("找不到 src\\capture\\capture.mjs：win-island.exe 必须放在项目目录里（或项目目录的 bin\\ 下）一起用。");
        }

        private static string DataDir()
        {
            string d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "win-island");
            if (!Directory.Exists(d)) Directory.CreateDirectory(d);
            return d;
        }

        // ---------- 起 / 停：都交给 scripts 下那两个脚本，别处不再实现一遍 ----------
        private static int Start(string[] args)
        {
            string root = FindRoot();
            string ps = Path.Combine(root, "scripts", "launch.ps1");
            if (!File.Exists(ps)) throw new Exception("缺 " + ps);
            string hold = ArgValue(args, "--hold-ms");
            string a = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps + "\"";
            if (!string.IsNullOrEmpty(hold)) a += " -HoldMs " + hold;
            int rc = Run("powershell.exe", a, true);
            Out("");
            return Status(new string[0]);
        }

        private static int Stop()
        {
            string root = FindRoot();
            string ps = Path.Combine(root, "scripts", "stop.ps1");
            if (!File.Exists(ps)) throw new Exception("缺 " + ps);
            Run("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + ps + "\"", true);
            Out("已停止。");
            return 0;
        }

        // ---------- 状态：pid 文件 + 进程是否真活着 + 管道问未读 ----------
        private static int Status(string[] args)
        {
            bool json = HasFlag(args, "--json");
            string data = DataDir();
            int cap = ReadPid(Path.Combine(data, "capture.pid"));
            int isl = ReadPid(Path.Combine(data, "island.pid"));
            bool capAlive = Alive(cap, "node");
            bool islAlive = Alive(isl, "powershell");
            string pipeErr = "";
            string ping = (capAlive || islAlive) ? Pipe("{\"cmd\":\"ping\"}\n", 1500, out pipeErr) : null;
            string unread = JsonStr(ping, "unread");
            string total = JsonStr(ping, "n");   // 管道那边累计条数就叫 n（见 src/capture/api.mjs 的 ping）

            if (json)
            {
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"capture\":").Append(capAlive ? cap : 0)
                  .Append(",\"island\":").Append(islAlive ? isl : 0)
                  .Append(",\"unread\":").Append(string.IsNullOrEmpty(unread) ? "null" : unread)
                  .Append(",\"total\":").Append(string.IsNullOrEmpty(total) ? "null" : total)
                  .Append(",\"data\":\"").Append(Esc(data)).Append("\"}");
                Out(sb.ToString());
                return capAlive && islAlive ? 0 : 3;
            }
            Out("win-island " + ProductVersion());
            Line("抓取层 capture.mjs ", capAlive, cap);
            Line("岛屿   island.ps1  ", islAlive, isl);
            Out("数据   " + data);
            if (string.IsNullOrEmpty(unread))
                Out("未读   问不到" + (string.IsNullOrEmpty(pipeErr) ? "（抓取层没在跑就没有管道）" : "：" + pipeErr));
            else
                Out("未读   " + unread + " 条（累计 " + total + " 条）");
            if (!capAlive || !islAlive) Out("没起全就 win-island start；报错看数据目录里的 capture.err.log / island.err.log");
            return capAlive && islAlive ? 0 : 3;
        }

        private static void Line(string what, bool alive, int pid)
        {
            Out(what + (alive ? "运行中  pid=" + pid : "没在跑" + (pid > 0 ? "（pid 文件写着 " + pid + "，进程已不在）" : "")));
        }

        private static int RunTests()
        {
            string root = FindRoot();
            string runner = Path.Combine(root, "scripts", "test-all.mjs");
            if (!File.Exists(runner)) throw new Exception("缺 " + runner);
            Out("跑全部自证判据（会真的动鼠标、剪贴板和临时数据目录）…");
            return Run(FindNode(), "\"" + runner + "\"", false);
        }

        // 可移植包把 node.exe 放在 exe 旁边（免环境安装就靠这个），否则退回 PATH 上的。
        // start/stop 那两路由 launch.ps1 自己按同样的顺序解析，这里只管 test 直接起的进程。
        private static string FindNode()
        {
            string bundled = Path.Combine(ExeDir(), "node.exe");
            return File.Exists(bundled) ? bundled : "node.exe";
        }

        private static int OpenConfig()
        {
            string f = Path.Combine(DataDir(), "config.json");
            if (!File.Exists(f))
            {
                File.WriteAllText(f, "{\n  \"weather\": { \"on\": true, \"everyMin\": 20 },\n  \"calendar\": { \"on\": true, \"everyMin\": 30, \"sources\": [] },\n  \"island\": { \"fullscreen\": \"handle\" }\n}\n", new UTF8Encoding(false));
                Out("原来没有 config.json，已经写了一份默认值。");
            }
            Process.Start(new ProcessStartInfo("notepad.exe", "\"" + f + "\"") { UseShellExecute = true });
            Out("已打开 " + f);
            return 0;
        }

        private static int OpenData()
        {
            Process.Start(new ProcessStartInfo(DataDir()) { UseShellExecute = true });
            return 0;
        }

        private static int Version()
        {
            Out("win-island " + ProductVersion() + "  (" + FileVersionInfo.GetVersionInfo(Assembly.GetExecutingAssembly().Location).FileName + ")");
            Out("启动器：csc.exe / .NET Framework " + Environment.Version);
            return 0;
        }

        private static int Help()
        {
            Out("win-island —— 把 Windows 通知收进屏幕顶部一枚胶囊");
            Out("");
            Out("用法： win-island [命令]   （不带命令 = status）");
            Out("  start      起抓取层 + 岛屿（--hold-ms 毫秒 改胶囊停留时长）");
            Out("  stop       停");
            Out("  status     两个进程在不在、未读几条   （--json 给机器读）");
            Out("  test       跑全部自证判据");
            Out("  config     用记事本打开 config.json（天气/日程/全屏行为）");
            Out("  data       打开数据目录 %LOCALAPPDATA%\\win-island");
            Out("  version    版本");
            Out("");
            Out("起来之后：鼠标顶到屏幕最上边展开面板；右键胶囊看菜单；托盘图标常驻。");
            return 0;
        }

        // ---------- 小工具 ----------
        private static int Run(string file, string arguments, bool hidden)
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = hidden;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try
            {
                Process p = Process.Start(psi);
                p.WaitForExit();
                return p.ExitCode;
            }
            catch (Exception e)
            {
                Err(file + " 起不来：" + e.Message);
                return 1;
            }
        }

        private static int ReadPid(string file)
        {
            try
            {
                if (!File.Exists(file)) return 0;
                int pid;
                if (int.TryParse(File.ReadAllText(file).Trim(), out pid)) return pid;
            }
            catch { }
            return 0;
        }

        // pid 文件会复用（进程没了、号被别人拿走），所以还要核对进程名，别报假活。
        private static bool Alive(int pid, string expectName)
        {
            if (pid <= 0) return false;
            try
            {
                Process p = Process.GetProcessById(pid);
                return string.Equals(p.ProcessName, expectName, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        // 问一次命名管道。管道名和协议都是抓取层定的（api.mjs：一行 JSON 进、一行 JSON 出），
        // 这里只是复用它，不再实现第二份。ReadLine 会一直等，所以另开线程 + 超时join，
        // 免得对方半路死了这个 CLI 就挂住。
        private static string Pipe(string line, int timeoutMs, out string err)
        {
            err = "";
            string result = null;
            Exception boom = null;
            Thread t = new Thread(delegate()
            {
                try
                {
                    using (NamedPipeClientStream c = new NamedPipeClientStream(".", "win-island", PipeDirection.InOut, PipeOptions.None))
                    {
                        c.Connect(timeoutMs);
                        using (StreamWriter w = new StreamWriter(c) { AutoFlush = true, NewLine = "\n" })
                        using (StreamReader r = new StreamReader(c, Encoding.UTF8))
                        {
                            w.Write(line);
                            result = r.ReadLine();
                        }
                    }
                }
                catch (Exception e) { boom = e; }
            });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(timeoutMs + 800)) { err = "超时 " + timeoutMs + "ms 没回话"; return null; }
            if (boom != null) err = boom.GetType().Name + ": " + boom.Message;
            return result;
        }

        // ping 回来的是一层扁平 JSON，手抠两个数就够，不为这个引一个 JSON 库。
        private static string JsonStr(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string pat = "\"" + key + "\":";
            int i = json.IndexOf(pat, StringComparison.Ordinal);
            if (i < 0) return null;
            i += pat.Length;
            int j = i;
            while (j < json.Length && (char.IsDigit(json[j]) || json[j] == '-')) j++;
            if (j > i) return json.Substring(i, j - i);
            int q1 = json.IndexOf('"', i);
            if (q1 < 0) return null;
            int q2 = json.IndexOf('"', q1 + 1);
            return q2 < 0 ? null : json.Substring(q1 + 1, q2 - q1 - 1);
        }

        private static string ArgValue(string[] args, string name)
        {
            for (int i = 1; i < args.Length - 1; i++) if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            return null;
        }

        private static bool HasFlag(string[] args, string name)
        {
            for (int i = 1; i < args.Length; i++) if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static string ProductVersion()
        {
            try
            {
                FileVersionInfo v = FileVersionInfo.GetVersionInfo(Assembly.GetExecutingAssembly().Location);
                if (!string.IsNullOrEmpty(v.ProductVersion)) return v.ProductVersion;
            }
            catch { }
            return Assembly.GetExecutingAssembly().GetName().Version.ToString();
        }

        private static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
        private static void Out(string s) { Console.Out.WriteLine(s); }
        private static void Err(string s) { Console.Error.WriteLine("win-island: " + s); }

        // 控制台默认跟着代码页走（这台机器是 GBK），中文提示会花；直接切 UTF-8 输出。
        private static void SetConsoleUtf8()
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        }
    }
}
