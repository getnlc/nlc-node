# Writes a line for every top-level window that becomes visible on this desktop while it runs (an event hook, so a flash that
# lasts a few milliseconds is still seen). Used by selfupdate-proof.cjs to show that updating shows nothing on screen.
param([string]$Out, [string]$StopFile, [int]$Seconds = 600)
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Threading; using System.Diagnostics; using System.Runtime.InteropServices;
public static class NlcWatch {
  delegate void Cb(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint a, uint b, IntPtr mod, Cb cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint r);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  static StreamWriter log; static Cb keep; static EnumCb enumKeep; static System.Collections.Generic.HashSet<long> seen = new System.Collections.Generic.HashSet<long>();
  static void Describe(string tag, IntPtr hwnd) {
    var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
    var title = new StringBuilder(256); GetWindowText(hwnd, title, 256);
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    string exe = "?"; try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }
    lock (log) { log.WriteLine(DateTime.UtcNow.ToString("o") + "|" + pid + "|" + exe + "|" + cls + "|" + title.ToString().Replace("|", "/") + "|" + tag); }
  }
  // A second, independent way of seeing windows: every few milliseconds, list the visible top-level windows and report new ones.
  static bool OnEnum(IntPtr h, IntPtr l) { if (IsWindowVisible(h) && seen.Add(h.ToInt64())) Describe("enum", h); return true; }
  static void OnEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    try {
      if (idObject != 0 || hwnd == IntPtr.Zero) return;
      if (GetAncestor(hwnd, 2) != hwnd) return;       // top-level windows only
      if (!IsWindowVisible(hwnd)) return;
      var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
      var title = new StringBuilder(256); GetWindowText(hwnd, title, 256);
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      string exe = "?"; try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }
      lock (log) { log.WriteLine(DateTime.UtcNow.ToString("o") + "|" + pid + "|" + exe + "|" + cls + "|" + title.ToString().Replace("|", "/") + "|event"); }
    } catch { }
  }
  public static void Run(string path, string stop, int seconds) {
    log = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
    keep = OnEvent;
    enumKeep = OnEnum;
    IntPtr hook = SetWinEventHook(0x8000, 0x8002, IntPtr.Zero, keep, 0, 0, 0);   // EVENT_OBJECT_CREATE..SHOW, out of context
    var baseline = new System.Collections.Generic.HashSet<long>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) baseline.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    foreach (var b in baseline) seen.Add(b);
    lock (log) { log.WriteLine("READY|" + (hook != IntPtr.Zero)); }
    var end = DateTime.UtcNow.AddSeconds(seconds);
    MSG msg;
    while (DateTime.UtcNow < end && !File.Exists(stop)) {
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
      EnumWindows(enumKeep, IntPtr.Zero);
      Thread.Sleep(5);
    }
    lock (log) { log.WriteLine("DONE"); }
  }
}
'@
[NlcWatch]::Run($Out, $StopFile, $Seconds)
