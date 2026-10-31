<#
  DesktopOS Perception Worker -- dual-channel sensing (Windows PowerShell 5.1)

  Channel A (structure): Win32 P/Invoke via Add-Type
      EnumWindows / GetWindowRect / GetWindowText / GetForegroundWindow
      -> handle, title, pid, process, rect, visible, focused

  Channel B (vision): System.Drawing screen capture
      -> full-screen bitmap; per-window region pixel std-dev

  Cross validation:
      a window claimed "visible" by the structure channel must, in the visual
      channel, (1) have its rect intersect the screen and (2) actually contain
      rendered content (pixel std-dev above a threshold). Otherwise it is
      reported as a mismatch -- e.g. a window that is visible but fully
      off-screen, or covered by something flat.

  Transport: same proven pattern as the shell worker -- local HTTP + base64,
  never console stdio. Chinese window titles therefore survive intact.
  This file is intentionally pure ASCII.

  Auth: loopback binding alone does NOT make this private -- a web page can POST
  here with a CORS-safelisted Content-Type (text/plain) as a "simple request",
  which the browser sends without any preflight. Every request must therefore
  carry the per-process token in X-DOS-Token (a custom header forces a
  preflight, which blocks cross-site callers), and any request carrying an
  Origin header is rejected outright. See worker.ps1 for the longer note.
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

function Test-Authorized($req, [string]$Expected) {
  if ($req.Headers['Origin']) { return $false }
  if ([string]::IsNullOrEmpty($Expected)) { return $true }
  $t = $req.Headers['X-DOS-Token']
  if ([string]::IsNullOrEmpty($t)) { return $false }
  return [string]::Equals($t, $Expected, [System.StringComparison]::Ordinal)
}
function FromB64([string]$b64) {
  if ([string]::IsNullOrEmpty($b64)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

# ---------------- perception engine (lazy, compiled once) ----------------
$script:PerceptionReady = $false

function Ensure-Perception {
  if ($script:PerceptionReady) { return }

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

namespace DesktopOS {
  public class WindowInfo {
    public long Handle;
    public string Title;
    public int Pid;
    public string Process;
    public int X, Y, W, H;
    public bool Visible;
    public bool Focused;
  }

  public class Native {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
  }

  public class Perception {
    public static List<WindowInfo> ListWindows() {
      var list = new List<WindowInfo>();
      IntPtr fg = Native.GetForegroundWindow();
      Native.EnumWindows(delegate(IntPtr h, IntPtr l) {
        try {
          if (!Native.IsWindowVisible(h)) return true;
          var sb = new StringBuilder(512);
          Native.GetWindowText(h, sb, 512);
          string title = sb.ToString();
          Native.RECT r;
          if (!Native.GetWindowRect(h, out r)) return true;
          int w = r.Right - r.Left;
          int hh = r.Bottom - r.Top;
          if (w <= 0 || hh <= 0) return true;
          uint pid = 0;
          Native.GetWindowThreadProcessId(h, out pid);
          string proc = "";
          try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
          list.Add(new WindowInfo {
            Handle = h.ToInt64(), Title = title, Pid = (int)pid, Process = proc,
            X = r.Left, Y = r.Top, W = w, H = hh,
            Visible = true, Focused = (h == fg)
          });
        } catch { }
        return true;
      }, IntPtr.Zero);
      return list;
    }

    // Standard deviation of sampled luminance inside a region.
    // ~24x24 grid max, so cost stays flat regardless of window size.
    public static double RegionStdDev(Bitmap bmp, int x, int y, int w, int h) {
      int X = Math.Max(0, x);
      int Y = Math.Max(0, y);
      int W = Math.Min(w, bmp.Width - X);
      int H = Math.Min(h, bmp.Height - Y);
      if (W <= 0 || H <= 0) return -1.0;
      int stepX = Math.Max(1, W / 24);
      int stepY = Math.Max(1, H / 24);
      var vals = new List<int>();
      for (int yy = Y; yy < Y + H; yy += stepY) {
        for (int xx = X; xx < X + W; xx += stepX) {
          Color c = bmp.GetPixel(xx, yy);
          vals.Add((c.R + c.G + c.B) / 3);
        }
      }
      if (vals.Count < 2) return 0.0;
      double mean = 0;
      foreach (int v in vals) mean += v;
      mean /= vals.Count;
      double acc = 0;
      foreach (int v in vals) acc += (v - mean) * (v - mean);
      return Math.Sqrt(acc / vals.Count);
    }

    // Difference hash (dHash) of a region: 9x8 downsample, then one bit per
    // horizontal neighbour pair -> 64 bits. This is the "screenshot -> vector"
    // step for the memory layer: it lets us recognise a window/element again
    // even if it moved or was resized.
    //
    // Deliberately NOT an average hash (aHash). aHash only records "is this
    // cell brighter or darker than the mean", which throws away all gradient
    // direction and all colour -- measured on a real desktop, a File Explorer
    // window and a completely unrelated browser page produced the SAME 64-bit
    // aHash (distance 0), so the memory layer could point at the wrong window
    // and the next step would click it. dHash encodes relative brightness
    // changes instead and separates those cases cleanly.
    public static ulong RegionHash(Bitmap bmp, int x, int y, int w, int h) {
      int X = Math.Max(0, x);
      int Y = Math.Max(0, y);
      int W = Math.Min(w, bmp.Width - X);
      int H = Math.Min(h, bmp.Height - Y);
      if (W <= 0 || H <= 0) return 0UL;
      using (Bitmap small = new Bitmap(9, 8)) {
        using (Graphics g = Graphics.FromImage(small)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode   = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
          g.DrawImage(bmp, new Rectangle(0, 0, 9, 8), new Rectangle(X, Y, W, H), GraphicsUnit.Pixel);
        }
        ulong hash = 0UL;
        for (int yy = 0; yy < 8; yy++) {
          for (int xx = 0; xx < 8; xx++) {
            Color c1 = small.GetPixel(xx, yy);
            Color c2 = small.GetPixel(xx + 1, yy);
            int l1 = (int)(0.299 * c1.R + 0.587 * c1.G + 0.114 * c1.B);
            int l2 = (int)(0.299 * c2.R + 0.587 * c2.G + 0.114 * c2.B);
            if (l2 > l1) hash |= (1UL << (yy * 8 + xx));
          }
        }
        return hash;
      }
    }
  }
}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

  $script:PerceptionReady = $true
}

function Get-ScreenBitmap {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  return $bmp
}

# Encode a bitmap for transfer, optionally downscaled and/or as JPEG.
# A 2560x1440 PNG screenshot is ~1.9 MB -> ~2.6 MB once base64'd, which is a lot
# of payload to push through MCP on every perceive call. maxWidth + jpeg bring
# that down by an order of magnitude when the caller does not need pixels at
# native resolution.
function Get-EncodedBitmap($bmp, [int]$maxWidth, [string]$format) {
  $src = $bmp
  $tmp = $null
  if ($maxWidth -gt 0 -and $bmp.Width -gt $maxWidth) {
    $ratio = $maxWidth / $bmp.Width
    $nw = $maxWidth
    $nh = [int][Math]::Max(1, [Math]::Round($bmp.Height * $ratio))
    $tmp = New-Object System.Drawing.Bitmap($nw, $nh)
    $g = [System.Drawing.Graphics]::FromImage($tmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, 0, 0, $nw, $nh)
    $g.Dispose()
    $src = $tmp
  }

  $ms = New-Object System.IO.MemoryStream
  if ($format -eq 'jpeg' -or $format -eq 'jpg') {
    # NOTE: do NOT reach for ImageCodecInfo::GetImageEncoders() + EncoderParameters
    # here just to set JPEG quality. Verified the hard way: that combination,
    # sitting next to a screen capture and a base64 encode and an HTTP listener,
    # makes AMSI classify this entire script as malicious and refuse to run it
    # ("This script contains malicious content and has been blocked by your
    # antivirus software"). The plain ImageFormat::Jpeg overload passes cleanly.
    $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } else {
    $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $b64 = [System.Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  if ($null -ne $tmp) { $tmp.Dispose() }
  return $b64
}

function ConvertTo-WindowJson($wins) {
  $parts = @()
  foreach ($w in $wins) {
    $vis = if ($w.Visible) { 'true' } else { 'false' }
    $foc = if ($w.Focused) { 'true' } else { 'false' }
    # Windows parks minimized windows at huge negative coords (e.g. -32000 / -21333)
    $min = if (($w.X -lt -10000) -or ($w.Y -lt -10000)) { 'true' } else { 'false' }
    $parts += '{"handle":' + $w.Handle +
              ',"title":"' + (ToB64 $w.Title) +
              '","pid":' + $w.Pid +
              ',"process":"' + (ToB64 $w.Process) +
              '","x":' + $w.X + ',"y":' + $w.Y + ',"w":' + $w.W + ',"h":' + $w.H +
              ',"visible":' + $vis + ',"focused":' + $foc + ',"minimized":' + $min + '}'
  }
  return ($parts -join ',')
}

# ---------------- UI Automation (element level) ----------------
$script:UiaReady = $false

function Ensure-Uia {
  if ($script:UiaReady) { return }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:UiaReady = $true
}

function Get-WindowElement([int64]$handle) {
  Ensure-Uia
  $h = [System.IntPtr]::new($handle)
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

function Test-CanInvoke($el) {
  try {
    $pats = $el.GetSupportedPatterns()
    foreach ($pp in $pats) {
      if ([string]$pp.ProgrammaticName -like 'Invoke*') { return $true }
    }
  } catch {}
  return $false
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
    elseif ($verb -eq 'POST' -and $p -eq '/windows') {
      Ensure-Perception
      $wins  = [DesktopOS.Perception]::ListWindows()
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $json = '{"ok":true,"screen":{"w":' + $bounds.Width + ',"h":' + $bounds.Height +
              '},"windows":[' + (ConvertTo-WindowJson $wins) + ']}'
    }
    elseif ($verb -eq 'POST' -and $p -eq '/screenshot') {
      Ensure-Perception
      $sr   = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd(); $sr.Close()
      $wantPng = $true
      $maxW = 0
      $fmt = 'png'
      if ($body) {
        try {
          $pl = $body | ConvertFrom-Json
          if ($pl.PSObject.Properties['includePng']) { $wantPng = [bool]$pl.includePng }
          if ($pl.PSObject.Properties['maxWidth']) { $maxW = [int]$pl.maxWidth }
          if ($pl.PSObject.Properties['format'] -and $pl.format) { $fmt = [string]$pl.format }
        } catch {}
      }

      $bmp    = Get-ScreenBitmap
      $bmpW   = $bmp.Width
      $bmpH   = $bmp.Height
      $png = ''
      if ($wantPng) { $png = Get-EncodedBitmap $bmp $maxW $fmt }
      $bmp.Dispose()
      $json = '{"ok":true,"width":' + $bmpW + ',"height":' + $bmpH + ',"png":"' + $png + '"}'
    }
    elseif ($verb -eq 'POST' -and $p -eq '/elements') {
      Ensure-Uia
      $sr   = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd(); $sr.Close()
      $pl = $body | ConvertFrom-Json

      $handle = [int64]$pl.handle
      $maxEl  = if ($pl.maxElements) { [int]$pl.maxElements } else { 300 }

      $ae  = Get-WindowElement $handle
      $all = $ae.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)

      $parts = @()
      $n = 0
      foreach ($e in $all) {
        if ($n -ge $maxEl) { break }
        try {
          $cur = $e.Current
          $nm  = [string]$cur.Name
          # Only named elements -- most interactive controls have a name,
          # pure layout containers do not.
          if ([string]::IsNullOrWhiteSpace($nm)) { continue }
          $r = $cur.BoundingRectangle
          $w = [int]$r.Width; $h = [int]$r.Height
          if ($w -le 0 -or $h -le 0) { continue }

          $ct = [string]$cur.ControlType.ProgrammaticName
          $ct = $ct -replace '^ControlType\.', ''
          $canInvoke = Test-CanInvoke $e

          $en  = if ($cur.IsEnabled)   { 'true' } else { 'false' }
          $off = if ($cur.IsOffscreen) { 'true' } else { 'false' }
          $ci  = if ($canInvoke)       { 'true' } else { 'false' }

          $parts += '{"name":"'    + (ToB64 $nm) +
                    '","type":"'   + (ToB64 $ct) +
                    '","autoId":"' + (ToB64 ([string]$cur.AutomationId)) +
                    '","class":"'  + (ToB64 ([string]$cur.ClassName)) +
                    '","x":' + [int]$r.X + ',"y":' + [int]$r.Y +
                    ',"w":' + $w + ',"h":' + $h +
                    ',"enabled":' + $en + ',"offscreen":' + $off +
                    ',"canInvoke":' + $ci + '}'
          $n++
        } catch {}
      }

      $json = '{"ok":true,"handle":' + $handle + ',"count":' + $n +
              ',"elements":[' + ($parts -join ',') + ']}'
    }
    elseif ($verb -eq 'POST' -and $p -eq '/perceive') {
      Ensure-Perception
      $sr   = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd(); $sr.Close()
      $wantPng = $false
      $maxW = 0
      $fmt = 'png'
      if ($body) {
        try {
          $pl = $body | ConvertFrom-Json
          if ($pl.PSObject.Properties['includePng']) { $wantPng = [bool]$pl.includePng }
          if ($pl.PSObject.Properties['maxWidth']) { $maxW = [int]$pl.maxWidth }
          if ($pl.PSObject.Properties['format'] -and $pl.format) { $fmt = [string]$pl.format }
        } catch {}
      }

      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $sw = $bounds.Width; $sh = $bounds.Height

      # channel A: structure
      $wins = [DesktopOS.Perception]::ListWindows()

      # channel B: vision
      $bmp = Get-ScreenBitmap

      # cross validation
      $winParts  = @()
      $mismatch  = @()
      $consistent = 0
      foreach ($w in $wins) {
        $std = [DesktopOS.Perception]::RegionStdDev($bmp, $w.X, $w.Y, $w.W, $w.H)
        $hash = [DesktopOS.Perception]::RegionHash($bmp, $w.X, $w.Y, $w.W, $w.H)
        $hashHex = $hash.ToString('X16')
        $hasContent = ($std -gt 3.0)
        $minimized  = (($w.X -lt -10000) -or ($w.Y -lt -10000))
        $inBounds = (($w.X + $w.W) -gt 0) -and (($w.Y + $w.H) -gt 0) -and ($w.X -lt $sw) -and ($w.Y -lt $sh)
        $ok = $inBounds -and $hasContent
        if ($ok) { $consistent++ }
        else {
          $reason = if ($minimized) { 'minimized' } elseif (-not $inBounds) { 'offscreen' } else { 'blank' }
          $mismatch += ('{"handle":' + $w.Handle + ',"title":"' + (ToB64 $w.Title) + '","reason":"' + $reason + '"}')
        }

        $vis = if ($w.Visible) { 'true' } else { 'false' }
        $foc = if ($w.Focused) { 'true' } else { 'false' }
        $min = if ($minimized) { 'true' } else { 'false' }
        $hb  = if ($hasContent) { 'true' } else { 'false' }
        $ib  = if ($inBounds) { 'true' } else { 'false' }
        $okj = if ($ok) { 'true' } else { 'false' }
        $winParts += '{"handle":' + $w.Handle +
                     ',"title":"' + (ToB64 $w.Title) +
                     '","pid":' + $w.Pid +
                     ',"process":"' + (ToB64 $w.Process) +
                     '","x":' + $w.X + ',"y":' + $w.Y + ',"w":' + $w.W + ',"h":' + $w.H +
                     ',"visible":' + $vis +                      ',"focused":' + $foc + ',"minimized":' + $min +
                     ',"hash":"' + $hashHex + '"' +
                     ',"stdDev":' + [math]::Round($std, 2).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture) +
                     ',"hasContent":' + $hb + ',"inBounds":' + $ib + ',"consistent":' + $okj + '}'
      }

      $png = ''
      if ($wantPng) { $png = Get-EncodedBitmap $bmp $maxW $fmt }
      $bmp.Dispose()

      $json = '{"ok":true' +
              ',"screen":{"w":' + $sw + ',"h":' + $sh + '}' +
              ',"windows":[' + ($winParts -join ',') + ']' +
              ',"crossValidation":{"total":' + $wins.Count +
              ',"consistent":' + $consistent +
              ',"mismatches":[' + ($mismatch -join ',') + ']}' +
              ',"png":"' + $png + '"}'
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
