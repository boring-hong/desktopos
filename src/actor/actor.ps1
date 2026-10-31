<#
  DesktopOS Actor Worker -- UI execution layer (Windows PowerShell 5.1)

  Injects real input through Win32: focus / move / click / scroll / type / hotkey.

  Two things worth noting:

  1. Chinese input. SendKeys cannot send Unicode -- it silently produces garbage
     for CJK. So typing goes through the clipboard (SetText, full Unicode)
     followed by Ctrl+V. Everything non-ASCII therefore stays intact, and the
     same base64-over-HTTP transport as the other workers keeps command text safe.

  2. Built-in verification. Any action can ask for `verify`, which captures the
     screen before and after, then reports a pixel diff ratio. That turns
     "act -> verify" into infrastructure instead of forcing every caller to
     assemble that loop by hand.

  This file is intentionally pure ASCII: PowerShell 5.1 reads .ps1 as ANSI
  (CP936) without a BOM, and a stray CJK comment corrupts the following line.

  Auth: this worker can move the mouse and inject keystrokes, so an unguarded
  loopback port would be the juiciest target of the three. Every request must
  carry the per-process token in X-DOS-Token (a custom header forces a CORS
  preflight, which blocks cross-site callers); Origin-bearing requests are
  rejected outright. See worker.ps1 for the longer note.
#>
param(
  [int]$Port = 0,
  [string]$Token = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

function ToB64([string]$s) {
  if ($null -eq $s) { $s = '' }
  return [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
function FromB64([string]$b64) {
  if ([string]::IsNullOrEmpty($b64)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

function Test-Authorized($req, [string]$Expected) {
  if ($req.Headers['Origin']) { return $false }
  if ([string]::IsNullOrEmpty($Expected)) { return $true }
  $t = $req.Headers['X-DOS-Token']
  if ([string]::IsNullOrEmpty($t)) { return $false }
  return [string]::Equals($t, $Expected, [System.StringComparison]::Ordinal)
}

# ---------------- input engine (lazy, compiled once) ----------------
$script:ActorReady = $false

function Ensure-Actor {
  if ($script:ActorReady) { return }

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;

namespace DesktopOS {
  public class Actor {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    public const int SW_RESTORE = 9;
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
    public const uint WHEEL = 0x0800;
    public const uint KEYUP = 0x0002;

    public static int[] CursorPos() {
      POINT p; GetCursorPos(out p);
      return new int[] { p.X, p.Y };
    }

    public static bool Focus(long handle) {
      IntPtr h = new IntPtr(handle);
      ShowWindow(h, SW_RESTORE);   // no-op unless minimized
      return SetForegroundWindow(h);
    }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void Click(int x, int y, string button, int count) {
      SetCursorPos(x, y);
      uint down, up;
      if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
      else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
      else { down = LEFTDOWN; up = LEFTUP; }
      int n = count < 1 ? 1 : count;
      for (int i = 0; i < n; i++) {
        mouse_event(down, 0, 0, 0, 0);
        mouse_event(up, 0, 0, 0, 0);
      }
    }

    public static void Scroll(int x, int y, int delta) {
      SetCursorPos(x, y);
      mouse_event(WHEEL, 0, 0, (uint)delta, 0);
    }

    public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, 0); }
    public static void KeyUp(byte vk) { keybd_event(vk, 0, KEYUP, 0); }

    // Unicode-safe typing: clipboard carries the text, Ctrl+V delivers it.
    public static void PasteText(string text) {
      System.Windows.Forms.Clipboard.SetText(text);
      KeyDown(0x11); KeyDown(0x56);
      KeyUp(0x56);   KeyUp(0x11);
    }

    public static byte VkOf(string name) {
      switch (name.ToLower()) {
        case "ctrl": case "control": return 0x11;
        case "alt": return 0x12;
        case "shift": return 0x10;
        case "win": case "meta": return 0x5B;
        case "enter": case "return": return 0x0D;
        case "tab": return 0x09;
        case "esc": case "escape": return 0x1B;
        case "space": return 0x20;
        case "back": case "backspace": return 0x08;
        case "del": case "delete": return 0x2E;
        case "up": return 0x26; case "down": return 0x28;
        case "left": return 0x25; case "right": return 0x27;
        case "home": return 0x24; case "end": return 0x23;
        case "pageup": return 0x21; case "pagedown": return 0x22;
        case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72;
        case "f4": return 0x73; case "f5": return 0x74; case "f6": return 0x75;
        case "f7": return 0x76; case "f8": return 0x77; case "f9": return 0x78;
        case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
        default: break;
      }
      if (name.Length == 1) {
        char c = char.ToUpper(name[0]);
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (byte)c;
      }
      return 0;
    }

    public static List<byte> Combo(string combo) {
      string[] parts = combo.Split(new char[] { '+', '-' }, StringSplitOptions.RemoveEmptyEntries);
      var vks = new List<byte>();
      foreach (string p in parts) {
        byte vk = VkOf(p.Trim());
        if (vk != 0) vks.Add(vk);
      }
      foreach (byte v in vks) KeyDown(v);
      for (int i = vks.Count - 1; i >= 0; i--) KeyUp(vks[i]);
      return vks;
    }

    // Fraction of sampled pixels that changed between two frames.
    // Whole-screen by default; when a region is supplied (a window rect) only
    // that rectangle is compared. Region scoping matters because "did anything
    // on screen change" is not the question -- "did MY action change the thing
    // I acted on" is. A ticking clock or a blinking caret otherwise registers
    // as a successful click.
    public static double DiffRatio(Bitmap a, Bitmap b) {
      return DiffRatio(a, b, 0, 0, 0, 0);
    }

    public static double DiffRatio(Bitmap a, Bitmap b, int rx, int ry, int rw, int rh) {
      int ox = 0, oy = 0;
      int W = Math.Min(a.Width, b.Width);
      int H = Math.Min(a.Height, b.Height);
      if (rw > 0 && rh > 0) {
        ox = Math.Max(0, rx);
        oy = Math.Max(0, ry);
        W = Math.Min(rw, Math.Min(a.Width, b.Width) - ox);
        H = Math.Min(rh, Math.Min(a.Height, b.Height) - oy);
      }
      if (W <= 0 || H <= 0) return 0.0;
      int stepX = Math.Max(1, W / 64);
      int stepY = Math.Max(1, H / 64);
      int total = 0, diff = 0;
      for (int y = oy; y < oy + H; y += stepY) {
        for (int x = ox; x < ox + W; x += stepX) {
          Color ca = a.GetPixel(x, y);
          Color cb = b.GetPixel(x, y);
          total++;
          if (Math.Abs(ca.R - cb.R) + Math.Abs(ca.G - cb.G) + Math.Abs(ca.B - cb.B) > 24) diff++;
        }
      }
      return total == 0 ? 0.0 : (double)diff / total;
    }
  }
}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

  $script:ActorReady = $true
}

function Get-ScreenBitmap {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  return $bmp
}

# ---------------- UI Automation (element level) ----------------
$script:UiaReady = $false

function Ensure-Uia {
  if ($script:UiaReady) { return }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:UiaReady = $true
}

function Find-ElementByText($rootEl, [string]$needle) {
  $all = $rootEl.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $key = $needle.ToLower()
  foreach ($e in $all) {
    try {
      $nm = [string]$e.Current.Name
      if ($nm -and $nm.ToLower().Contains($key)) { return $e }
    } catch {}
  }
  return $null
}

# ---------------- http bridge ----------------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
[Console]::Out.WriteLine("READY:$Port")
[Console]::Out.Flush()

$running = $true
while ($running) {
  $ctx = $null
  try { $ctx = $listener.GetContext() } catch { break }
  if ($null -eq $ctx) { break }

  $req  = $ctx.Request
  $resp = $ctx.Response
  $resp.ContentType = 'application/json; charset=utf-8'
  $resp.StatusCode  = 200

  if (-not (Test-Authorized $req $Token)) {
    $resp.StatusCode = 403
    $fb = [System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"Zm9yYmlkZGVu"}')
    $resp.ContentLength64 = $fb.Length
    $resp.OutputStream.Write($fb, 0, $fb.Length)
    $resp.OutputStream.Close()
    continue
  }

  try {
    $p    = $req.Url.AbsolutePath
    $verb = $req.HttpMethod

    if ($verb -eq 'GET' -and $p -eq '/health') {
      $json = '{"ok":true}'
    }
    elseif ($verb -eq 'POST' -and $p -eq '/shutdown') {
      $json = '{"ok":true}'
      $running = $false
    }
    elseif ($verb -eq 'POST' -and $p -eq '/cursor') {
      Ensure-Actor
      $cp = [DesktopOS.Actor]::CursorPos()
      $json = '{"ok":true,"x":' + $cp[0] + ',"y":' + $cp[1] + '}'
    }
    elseif ($verb -eq 'POST' -and $p -eq '/act') {
      Ensure-Actor

      $sr   = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd(); $sr.Close()
      $pl = $body | ConvertFrom-Json

      $action   = [string]$pl.action
      $wantVrfy = [bool]$pl.verify
      $settleMs = if ($pl.settleMs) { [int]$pl.settleMs } else { 350 }

      $before = $null
      if ($wantVrfy) { $before = Get-ScreenBitmap }

      $note = ''
      switch ($action) {
        'focus' {
          $ok = [DesktopOS.Actor]::Focus([long]$pl.handle)
          $note = 'focus handle=' + $pl.handle + ' -> ' + $ok
        }
        'move' {
          [DesktopOS.Actor]::Move([int]$pl.x, [int]$pl.y)
          $note = 'move to (' + $pl.x + ',' + $pl.y + ')'
        }
        'click' {
          $btn = if ($pl.button) { [string]$pl.button } else { 'left' }
          $cnt = if ($pl.count) { [int]$pl.count } else { 1 }
          [DesktopOS.Actor]::Click([int]$pl.x, [int]$pl.y, $btn, $cnt)
          $note = 'click ' + $btn + ' x' + $cnt + ' at (' + $pl.x + ',' + $pl.y + ')'
        }
        'scroll' {
          $d = if ($pl.delta) { [int]$pl.delta } else { -120 }
          [DesktopOS.Actor]::Scroll([int]$pl.x, [int]$pl.y, $d)
          $note = 'scroll delta=' + $d + ' at (' + $pl.x + ',' + $pl.y + ')'
        }
        'type' {
          $text = FromB64 $pl.text
          [DesktopOS.Actor]::PasteText($text)
          $note = 'typed ' + $text.Length + ' chars via clipboard'
        }
        'key' {
          $combo = FromB64 $pl.keys
          [DesktopOS.Actor]::Combo($combo)
          $note = 'key combo: ' + $combo
        }
        'element' {
          Ensure-Uia
          $handle = [int64]$pl.handle
          $needle = FromB64 $pl.name
          if ([string]::IsNullOrWhiteSpace($needle)) { throw 'element name is empty' }

          $root = [System.Windows.Automation.AutomationElement]::FromHandle([System.IntPtr]::new($handle))
          $el = Find-ElementByText $root $needle
          if ($null -eq $el) { throw "element not found: $needle" }

          $r = $el.Current.BoundingRectangle
          $cx = [int]($r.X + $r.Width / 2)
          $cy = [int]($r.Y + $r.Height / 2)

          # Prefer InvokePattern (more reliable for buttons);
          # fall back to clicking the element centre when unsupported.
          $invoked = $false
          try {
            $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $ip.Invoke()
            $invoked = $true
          } catch {}

          if (-not $invoked) {
            [DesktopOS.Actor]::Click($cx, $cy, 'left', 1)
          }

          $note = 'element "' + $needle + '" -> ' +
                  $(if ($invoked) { 'InvokePattern' } else { 'click' }) +
                  ' at (' + $cx + ',' + $cy + ')'
        }
        default { throw "unknown action: $action" }
      }

      $vrfyJson = '"verify":null'
      if ($wantVrfy) {
        Start-Sleep -Milliseconds $settleMs
        $after = Get-ScreenBitmap

        # Optional region scope (usually the target window rect from perceive).
        $rx = 0; $ry = 0; $rw = 0; $rh = 0
        if ($pl.PSObject.Properties['verifyRegion'] -and $null -ne $pl.verifyRegion) {
          $rg = $pl.verifyRegion
          $rx = [int]$rg.x; $ry = [int]$rg.y; $rw = [int]$rg.w; $rh = [int]$rg.h
        }
        $scoped = ($rw -gt 0 -and $rh -gt 0)

        $ratio = [DesktopOS.Actor]::DiffRatio($before, $after, $rx, $ry, $rw, $rh)
        $after.Dispose()
        $changed = if ($ratio -gt 0.002) { 'true' } else { 'false' }
        $r = [math]::Round($ratio, 5).ToString('0.#####', [System.Globalization.CultureInfo]::InvariantCulture)
        $regionJson = 'null'
        if ($scoped) {
          $regionJson = '{"x":' + $rx + ',"y":' + $ry + ',"w":' + $rw + ',"h":' + $rh + '}'
        }
        $vrfyJson = '"verify":{"changed":' + $changed + ',"diffRatio":' + $r +
                    ',"scope":"' + $(if ($scoped) { 'region' } else { 'screen' }) + '"' +
                    ',"region":' + $regionJson + '}'
      }
      if ($null -ne $before) { $before.Dispose() }

      $json = '{"ok":true,"action":"' + $action + '","note":"' + (ToB64 $note) + '",' + $vrfyJson + '}'
    }
    else {
      $resp.StatusCode = 404
      $json = '{"ok":false,"error":"' + (ToB64 "not found: $p") + '"}'
    }
  } catch {
    $resp.StatusCode = 500
    $json = '{"ok":false,"error":"' + (ToB64 $_.Exception.Message) + '"}'
  }

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $resp.ContentLength64 = $bytes.Length
  $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  $resp.OutputStream.Close()
}

try { $listener.Stop() } catch {}
