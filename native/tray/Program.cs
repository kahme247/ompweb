using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace OmpWebTray;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        var portArg = 0;
        var hostnameArg = "";
        var modeArg = "";
        var configPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".omp", "agent", "web-service.json");
        var startup = false;
        var openBrowser = false;

        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a == "-Port" || a == "--port" || a == "-p") { if (i + 1 < args.Length && int.TryParse(args[++i], out var p)) portArg = p; }
            else if (a == "-Hostname" || a == "--hostname" || a == "-H") { if (i + 1 < args.Length) hostnameArg = args[++i]; }
            else if (a == "-Mode" || a == "--mode") { if (i + 1 < args.Length) modeArg = args[++i]; }
            else if (a == "-ConfigPath") { if (i + 1 < args.Length) configPath = args[++i]; }
            else if (a == "-Startup" || a == "--startup") startup = true;
            else if (a == "-OpenBrowser" || a == "--open-browser") openBrowser = true;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var tray = new TrayApplication(portArg, hostnameArg, modeArg, configPath, startup, openBrowser);
        tray.Run();
    }
}

class TrayApplication : IDisposable
{
    private readonly int _portArg;
    private readonly string _hostnameArg;
    private readonly string _modeArg;
    private readonly string _configPath;
    private readonly bool _startup;
    private bool _openBrowser;

    private readonly string _repoRoot;
    private readonly string _pkgVersion;
    private int _effectivePort;
    private string _effectiveHostname = "127.0.0.1";
    private string _effectiveMode = "start";
    private bool _effectiveAutoRestart = true;
    private string _serverUrl = "http://127.0.0.1:30177";

    private NotifyIcon _notifyIcon = null!;
    private ContextMenuStrip _contextMenu = null!;
    private ToolStripMenuItem _menuHeader = null!;
    private ToolStripMenuItem _menuStatus = null!;
    private ToolStripMenuItem _menuOpen = null!;
    private ToolStripMenuItem _menuCopy = null!;
    private ToolStripMenuItem _menuRestart = null!;
    private ToolStripMenuItem _menuToggle = null!;
    private ToolStripMenuItem _menuViewLogs = null!;
    private ToolStripMenuItem _menuConfig = null!;
    private ToolStripMenuItem _menuOpenFolder = null!;
    private ToolStripMenuItem _menuAutostart = null!;
    private ToolStripMenuItem _menuExit = null!;
    private System.Windows.Forms.Timer _timer = null!;
    private Mutex? _appMutex;
    private bool _createdNew;
    private Process? _childProcess;
    private string _state = "Starting";
    private readonly List<DateTime> _crashTimestamps = new();
    private bool _isExiting;
    private readonly string _logFile;
    private readonly object _logLock = new();
    private string? _nodeExe;
    private readonly string _icoPath;
    private readonly string _pngPath;

    public TrayApplication(int portArg, string hostnameArg, string modeArg, string configPath, bool startup, bool openBrowser)
    {
        _portArg = portArg;
        _hostnameArg = hostnameArg;
        _modeArg = modeArg;
        _configPath = configPath;
        _startup = startup;
        _openBrowser = openBrowser;

        _repoRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        // When published single-file, BaseDirectory is different; fallback to resolving from assembly location
        if (!Directory.Exists(Path.Combine(_repoRoot, "bin")) || !File.Exists(Path.Combine(_repoRoot, "package.json")))
        {
            // Try 4 levels up (common for win-x64 publish)
            var alt = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
            if (File.Exists(Path.Combine(alt, "package.json"))) _repoRoot = alt;
            else _repoRoot = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", ".."));
            if (!Directory.Exists(Path.Combine(_repoRoot, "bin"))) _repoRoot = Directory.GetCurrentDirectory();
            // Final fallback: assume exe is in bin/
            var binDir = Path.GetDirectoryName(Environment.ProcessPath) ?? "";
            if (File.Exists(Path.Combine(binDir, "..", "package.json"))) _repoRoot = Path.GetFullPath(Path.Combine(binDir, ".."));
        }

        _pkgVersion = "0.0.0";
        try
        {
            var pkgJson = Path.Combine(_repoRoot, "package.json");
            if (File.Exists(pkgJson))
            {
                var json = File.ReadAllText(pkgJson);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("version", out var v)) _pkgVersion = v.GetString() ?? "0.0.0";
            }
        }
        catch { }

        _icoPath = Path.Combine(_repoRoot, "public", "omp-web.ico");
        _pngPath = Path.Combine(_repoRoot, "public", "icon.png");

        var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".omp", "agent", "logs");
        Directory.CreateDirectory(logDir);
        _logFile = Path.Combine(logDir, "omp-web-service.log");
        try
        {
            if (File.Exists(_logFile) && new FileInfo(_logFile).Length > 5 * 1024 * 1024)
                File.Move(_logFile, Path.Combine(logDir, "omp-web-service.old.log"), true);
        }
        catch { }

        ResolveConfig();
    }

    private void ResolveConfig()
    {
        const int DefaultPort = 30177;
        const string DefaultHostname = "127.0.0.1";
        const string DefaultMode = "start";

        JsonElement? config = null;
        try
        {
            if (File.Exists(_configPath))
            {
                var txt = File.ReadAllText(_configPath);
                using var doc = JsonDocument.Parse(txt);
                config = doc.RootElement.Clone();
            }
        }
        catch { }

        int? cfgPort = null;
        string? cfgHost = null;
        string? cfgMode = null;
        bool? cfgAutoRestart = null;
        bool? cfgOpenBrowser = null;
        if (config.HasValue)
        {
            var el = config.Value;
            if (el.TryGetProperty("port", out var p) && p.TryGetInt32(out var pi)) cfgPort = pi;
            if (el.TryGetProperty("hostname", out var h)) cfgHost = h.GetString();
            if (el.TryGetProperty("mode", out var m)) cfgMode = m.GetString();
            if (el.TryGetProperty("autoRestart", out var ar) && (ar.ValueKind == JsonValueKind.True || ar.ValueKind == JsonValueKind.False)) cfgAutoRestart = ar.GetBoolean();
            if (el.TryGetProperty("openBrowserOnLaunch", out var ob) && (ob.ValueKind == JsonValueKind.True || ob.ValueKind == JsonValueKind.False)) cfgOpenBrowser = ob.GetBoolean();
        }

        _effectivePort = _portArg > 0 ? _portArg : (cfgPort ?? DefaultPort);
        _effectiveHostname = !string.IsNullOrWhiteSpace(_hostnameArg) ? _hostnameArg : (!string.IsNullOrWhiteSpace(cfgHost) ? cfgHost! : DefaultHostname);
        _effectiveMode = !string.IsNullOrWhiteSpace(_modeArg) ? _modeArg : (!string.IsNullOrWhiteSpace(cfgMode) ? cfgMode! : DefaultMode);
        _effectiveAutoRestart = cfgAutoRestart ?? true;
        if (_openBrowser) { /* explicit */ }
        else if (!_startup && cfgOpenBrowser == true) _openBrowser = true;

        var buildIndex = Path.Combine(_repoRoot, "dist", "index.html");
        if (_effectiveMode == "start" && !File.Exists(buildIndex))
        {
            _effectiveMode = "dev";
            if (_effectivePort == 30177) _effectivePort = 30178;
        }

        _serverUrl = (_effectiveHostname == "0.0.0.0" || _effectiveHostname == "::" || string.IsNullOrWhiteSpace(_effectiveHostname))
            ? $"http://localhost:{_effectivePort}"
            : $"http://{_effectiveHostname}:{_effectivePort}";
    }

    private void WriteLog(string message)
    {
        var ts = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
        var line = $"[{ts}] {message}";
        lock (_logLock)
        {
            try { File.AppendAllText(_logFile, line + "\r\n"); } catch { }
        }
    }

    private string FindNodeExecutable()
    {
        try
        {
            var where = Environment.GetEnvironmentVariable("PATH") ?? "";
            // Try where node
            var psi = new ProcessStartInfo("where", "node") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            using var p = Process.Start(psi);
            if (p != null)
            {
                var outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(2000);
                var first = outp.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
                if (!string.IsNullOrEmpty(first) && File.Exists(first)) return first;
            }
        }
        catch { }

        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "node", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", "node.exe"),
        };
        foreach (var c in candidates) if (File.Exists(c)) return c;
        return "node.exe";
    }

    // Copy an omp-web credential from the user (then system) environment into the child,
    // or remove it there. The tray's own environment was captured at logon, so a value
    // changed or removed with `setx` since then must not survive a server restart: the
    // old password would keep working after rotation.
    private static string? SetChildCredential(ProcessStartInfo psi, string name)
    {
        var value = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);
        if (string.IsNullOrEmpty(value))
            value = Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.Machine);
        if (string.IsNullOrEmpty(value))
            psi.EnvironmentVariables.Remove(name);
        else
            psi.EnvironmentVariables[name] = value;
        return value;
    }

    private void StartWebServer()
    {
        if (_childProcess != null && !_childProcess.HasExited) return;
        _state = "Starting";
        UpdateTrayUI();
        WriteLog($"Starting web server in {_effectiveMode} mode on {_effectiveHostname}:{_effectivePort}...");

        if (_nodeExe == null) _nodeExe = FindNodeExecutable();

        var psi = new ProcessStartInfo
        {
            FileName = _nodeExe,
            WorkingDirectory = _repoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        if (_effectiveMode == "start")
        {
            var launcher = Path.Combine(_repoRoot, "bin", "omp-web.js");
            psi.Arguments = $"\"{launcher}\" -p {_effectivePort} -H {_effectiveHostname} --no-open";
        }
        else
        {
            var bunLauncher = Path.Combine(_repoRoot, "bin", "bun-runtime.js");
            psi.Arguments = $"\"{bunLauncher}\" --hot server/dev.ts -H {_effectiveHostname} -p {_effectivePort}";
        }

        psi.EnvironmentVariables["OMP_WEB_PORT"] = _effectivePort.ToString();
        psi.EnvironmentVariables["OMP_WEB_HOSTNAME"] = _effectiveHostname;
        psi.EnvironmentVariables["OMP_WEB_SERVICE"] = "1";
        psi.EnvironmentVariables["PORT"] = _effectivePort.ToString();
        // bin/omp-web.js refuses a non-loopback bind without a password hash. A plaintext
        // OMP_WEB_PASSWORD is passed through only so the server can refuse it with instructions.
        if (string.IsNullOrEmpty(SetChildCredential(psi, "OMP_WEB_PASSWORD_HASH")))
            WriteLog("WARN: OMP_WEB_PASSWORD_HASH not found in the user or system environment; a non-loopback bind will be refused by bin/omp-web.js (generate one with: ompweb hash-password)");
        SetChildCredential(psi, "OMP_WEB_PASSWORD");
        SetChildCredential(psi, "OMP_WEB_TRUSTED_HEADER_SHA256");

        var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) WriteLog($"[STDOUT] {e.Data}"); };
        proc.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) WriteLog($"[STDERR] {e.Data}"); };

        try
        {
            if (proc.Start())
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                _childProcess = proc;
                WriteLog($"Child server process started with PID {proc.Id}");
            }
            else
            {
                _state = "Error";
                WriteLog("Failed to start child server process.");
                UpdateTrayUI();
            }
        }
        catch (Exception ex)
        {
            _state = "Error";
            WriteLog($"Exception starting child server: {ex.Message}");
            UpdateTrayUI();
        }
    }

    private void StopWebServer()
    {
        if (_childProcess != null && !_childProcess.HasExited)
        {
            var pid = _childProcess.Id;
            WriteLog($"Stopping child server process tree (PID {pid})...");
            try
            {
                var taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                if (!File.Exists(taskkill)) taskkill = "taskkill.exe";
                var psi = new ProcessStartInfo(taskkill, $"/PID {pid} /T /F") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden };
                using var p = Process.Start(psi);
                p?.WaitForExit(5000);
            }
            catch { try { _childProcess.Kill(); } catch { } }
            _childProcess = null;
        }
        _state = "Stopped";
        WriteLog("Server stopped.");
        UpdateTrayUI();
    }

    private bool TestServerHealth()
    {
        try
        {
            var req = WebRequest.Create(_serverUrl);
            req.Timeout = 2000;
            using var resp = req.GetResponse();
            return true;
        }
        catch { return false; }
    }

    private bool CheckAutostart()
    {
        try
        {
            var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            var lnk = Path.Combine(startup, "omp-web-tray.lnk");
            return File.Exists(lnk);
        }
        catch { return false; }
    }

    private void SetAutostart(bool enable)
    {
        try
        {
            var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            var lnk = Path.Combine(startup, "omp-web-tray.lnk");
            if (enable)
            {
                // Recreate via install script logic (simplified): copy from install
                var ps = Path.Combine(_repoRoot, "scripts", "windows", "install-tray.ps1");
                if (File.Exists(ps))
                {
                    var psi = new ProcessStartInfo("powershell.exe", $"-NoProfile -ExecutionPolicy Bypass -File \"{ps}\"") { CreateNoWindow = true, UseShellExecute = false };
                    using var p = Process.Start(psi);
                    p?.WaitForExit(10000);
                }
            }
            else
            {
                if (File.Exists(lnk)) File.Delete(lnk);
            }
        }
        catch { }
    }

    private void UpdateTrayUI()
    {
        if (_menuStatus == null) return;
        var statusText = _state switch
        {
            "Running" => $"Running ({_effectivePort})",
            "Starting" => $"Starting... ({_effectivePort})",
            "Stopped" => "Stopped",
            "Error" => "Error",
            _ => _state
        };
        _menuStatus.Text = $"  Status: {statusText}";
        var tip = $"omp-web ({statusText})";
        if (tip.Length > 63) tip = tip.Substring(0, 63);
        if (_notifyIcon != null) _notifyIcon.Text = tip;

        if (_menuToggle != null)
        {
            if (_state == "Running" || _state == "Starting")
            {
                _menuToggle.Text = "Stop Server";
                if (_menuRestart != null) _menuRestart.Enabled = true;
            }
            else
            {
                _menuToggle.Text = "Start Server";
                if (_menuRestart != null) _menuRestart.Enabled = false;
            }
        }
        if (_menuAutostart != null) _menuAutostart.Checked = CheckAutostart();
    }

    public void Run()
    {
        // Mutex
        try
        {
            _appMutex = new Mutex(true, @"Local\OmpWebTray_Instance_Mutex", out _createdNew);
        }
        catch { _createdNew = true; }
        if (!_createdNew)
        {
            if (_openBrowser)
            {
                try { Process.Start(new ProcessStartInfo(_serverUrl) { UseShellExecute = true }); } catch { }
            }
            return;
        }

        WriteLog("==========================================");
        WriteLog($"omp-web System Tray Manager v{_pkgVersion} starting (native)");
        WriteLog($"Repository Root: {_repoRoot}");
        WriteLog($"Target: {_serverUrl} (Mode: {_effectiveMode}, Port: {_effectivePort})");
        WriteLog("==========================================");

        // Icon
        Icon? icon = null;
        try
        {
            if (File.Exists(_icoPath)) icon = new Icon(_icoPath);
            else if (File.Exists(_pngPath))
            {
                using var bmp = new Bitmap(_pngPath);
                var h = bmp.GetHicon();
                icon = Icon.FromHandle(h);
            }
        }
        catch { }
        icon ??= SystemIcons.Application;

        _contextMenu = new ContextMenuStrip();

        _menuHeader = new ToolStripMenuItem($"omp-web (v{_pkgVersion})") { Enabled = false, Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold) };
        _contextMenu.Items.Add(_menuHeader);

        _menuStatus = new ToolStripMenuItem($"  Status: Starting ({_effectivePort})") { Enabled = false };
        _contextMenu.Items.Add(_menuStatus);
        _contextMenu.Items.Add(new ToolStripSeparator());

        _menuOpen = new ToolStripMenuItem("Open in Browser", null, (s, e) => { try { Process.Start(new ProcessStartInfo(_serverUrl) { UseShellExecute = true }); } catch { } }) { Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold) };
        _contextMenu.Items.Add(_menuOpen);

        _menuCopy = new ToolStripMenuItem("Copy Web URL", null, (s, e) =>
        {
            try
            {
                Clipboard.SetText(_serverUrl);
                _notifyIcon.ShowBalloonTip(1500, "omp-web", $"URL copied: {_serverUrl}", ToolTipIcon.Info);
            }
            catch { }
        });
        _contextMenu.Items.Add(_menuCopy);
        _contextMenu.Items.Add(new ToolStripSeparator());

        _menuRestart = new ToolStripMenuItem("Restart Server", null, (s, e) =>
        {
            WriteLog("Restart requested from tray.");
            StopWebServer();
            Thread.Sleep(500);
            StartWebServer();
        });
        _contextMenu.Items.Add(_menuRestart);

        _menuToggle = new ToolStripMenuItem("Stop Server", null, (s, e) =>
        {
            if (_state == "Running" || _state == "Starting") StopWebServer();
            else StartWebServer();
        });
        _contextMenu.Items.Add(_menuToggle);
        _contextMenu.Items.Add(new ToolStripSeparator());

        _menuViewLogs = new ToolStripMenuItem("View Logs", null, (s, e) => { try { Process.Start("notepad.exe", $"\"{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".omp", "agent", "logs", "omp-web-service.log")}\""); } catch { } });
        _contextMenu.Items.Add(_menuViewLogs);

        _menuConfig = new ToolStripMenuItem("Edit Configuration", null, (s, e) =>
        {
            var cfg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".omp", "agent", "web-service.json");
            if (!File.Exists(cfg))
            {
                // create via autostart check
                SetAutostart(CheckAutostart());
            }
            try { Process.Start("notepad.exe", $"\"{cfg}\""); } catch { }
        });
        _contextMenu.Items.Add(_menuConfig);

        _menuOpenFolder = new ToolStripMenuItem("Open Project Folder", null, (s, e) => { try { Process.Start("explorer.exe", $"\"{_repoRoot}\""); } catch { } });
        _contextMenu.Items.Add(_menuOpenFolder);
        _contextMenu.Items.Add(new ToolStripSeparator());

        _menuAutostart = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true, Checked = CheckAutostart() };
        _menuAutostart.Click += (s, e) => SetAutostart(_menuAutostart.Checked);
        _contextMenu.Items.Add(_menuAutostart);
        _contextMenu.Items.Add(new ToolStripSeparator());

        _menuExit = new ToolStripMenuItem("Exit Tray & Server", null, (s, e) =>
        {
            _isExiting = true;
            WriteLog("Exit requested from system tray menu.");
            StopWebServer();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _timer?.Stop();
            _timer?.Dispose();
            try { _appMutex?.ReleaseMutex(); } catch { }
            _appMutex?.Dispose();
            Application.Exit();
        });
        _contextMenu.Items.Add(_menuExit);

        _notifyIcon = new NotifyIcon
        {
            Icon = icon,
            ContextMenuStrip = _contextMenu,
            Text = $"omp-web ({_state})",
            Visible = true
        };
        _notifyIcon.DoubleClick += (s, e) => { try { Process.Start(new ProcessStartInfo(_serverUrl) { UseShellExecute = true }); } catch { } };

        _timer = new System.Windows.Forms.Timer { Interval = 3000 };
        _timer.Tick += (s, e) =>
        {
            if (_isExiting) return;
            if (_childProcess != null && _childProcess.HasExited)
            {
                var code = _childProcess.ExitCode;
                WriteLog($"Child server process exited with code {code}.");
                _childProcess = null;
                if (_effectiveAutoRestart)
                {
                    var now = DateTime.Now;
                    _crashTimestamps.Add(now);
                    var cutoff = now.AddSeconds(-60);
                    _crashTimestamps.RemoveAll(t => t < cutoff);
                    if (_crashTimestamps.Count >= 3)
                    {
                        _state = "Error";
                        WriteLog("Server crashed repeatedly (3 times in 60s). Auto-restart suspended.");
                        _notifyIcon.ShowBalloonTip(3000, "omp-web Service Error", "Server crashed repeatedly. Check logs for details.", ToolTipIcon.Error);
                    }
                    else
                    {
                        WriteLog($"Auto-restarting server (crash {_crashTimestamps.Count} of 3)...");
                        StartWebServer();
                    }
                }
                else _state = "Stopped";
                UpdateTrayUI();
                return;
            }

            if (_childProcess != null && !_childProcess.HasExited)
            {
                var healthy = TestServerHealth();
                if (healthy)
                {
                    if (_state != "Running")
                    {
                        _state = "Running";
                        WriteLog($"Server is healthy and responsive at {_serverUrl}");
                        UpdateTrayUI();
                        if (_openBrowser)
                        {
                            _openBrowser = false;
                            try { Process.Start(new ProcessStartInfo(_serverUrl) { UseShellExecute = true }); } catch { }
                        }
                    }
                }
                else if (_state == "Running")
                {
                    _state = "Starting";
                    UpdateTrayUI();
                }
            }
        };

        StartWebServer();
        _timer.Start();

        Application.Run();

        // Cleanup on exit
        if (!_isExiting)
        {
            StopWebServer();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _timer.Stop();
            _timer.Dispose();
            try { _appMutex?.ReleaseMutex(); } catch { }
            _appMutex?.Dispose();
        }
    }

    public void Dispose()
    {
        _notifyIcon?.Dispose();
        _timer?.Dispose();
        _appMutex?.Dispose();
        _childProcess?.Dispose();
    }
}
