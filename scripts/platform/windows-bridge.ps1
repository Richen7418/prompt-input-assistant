param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("GetTarget", "Focus", "Paste", "Server")]
  [string]$Action,

  [long]$WindowHandle = 0,

  [long]$ProcessId = 0
)

$source = @"
using System;
using System.Runtime.InteropServices;

public static class PromptInputBridge
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@

Add-Type -TypeDefinition $source -Language CSharp

function Get-TargetJson {
  $handle = [PromptInputBridge]::GetForegroundWindow()
  [uint32]$processId = 0
  [void][PromptInputBridge]::GetWindowThreadProcessId($handle, [ref]$processId)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $rect = New-Object PromptInputBridge+RECT
  $hasRect = [PromptInputBridge]::GetWindowRect($handle, [ref]$rect)

  [PSCustomObject]@{
    windowHandle = $handle.ToInt64()
    processId = $processId
    processName = if ($process) { $process.ProcessName } else { "UnknownApplication" }
    windowTitle = if ($process) { $process.MainWindowTitle } else { "" }
    bounds = if ($hasRect) {
      [PSCustomObject]@{
        x = $rect.Left
        y = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
      }
    } else { $null }
  } | ConvertTo-Json -Compress
}

function Set-TargetForeground([long]$TargetWindowHandle, [long]$TargetProcessId) {
  if ($TargetWindowHandle -le 0) {
    return $false
  }

  $handle = [IntPtr]::new($TargetWindowHandle)
  $foreground = [PromptInputBridge]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  $foregroundThreadId = [PromptInputBridge]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  [uint32]$windowProcessId = 0
  $targetThreadId = [PromptInputBridge]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
  $currentThreadId = [PromptInputBridge]::GetCurrentThreadId()

  if ([PromptInputBridge]::IsIconic($handle)) {
    [void][PromptInputBridge]::ShowWindowAsync($handle, 9)
  }

  $attachedForeground = $false
  $attachedTarget = $false
  try {
    if ($foregroundThreadId -gt 0 -and $foregroundThreadId -ne $currentThreadId) {
      $attachedForeground = [PromptInputBridge]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
    }
    if ($targetThreadId -gt 0 -and $targetThreadId -ne $currentThreadId) {
      $attachedTarget = [PromptInputBridge]::AttachThreadInput($currentThreadId, $targetThreadId, $true)
    }
    [void][PromptInputBridge]::BringWindowToTop($handle)
    [void][PromptInputBridge]::SetActiveWindow($handle)
    [void][PromptInputBridge]::SetForegroundWindow($handle)
  } finally {
    if ($attachedTarget) {
      [void][PromptInputBridge]::AttachThreadInput($currentThreadId, $targetThreadId, $false)
    }
    if ($attachedForeground) {
      [void][PromptInputBridge]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false)
    }
  }

  Start-Sleep -Milliseconds 130

  $actualForeground = [PromptInputBridge]::GetForegroundWindow()
  [uint32]$actualProcessId = 0
  [void][PromptInputBridge]::GetWindowThreadProcessId($actualForeground, [ref]$actualProcessId)
  $expectedProcessId = if ($TargetProcessId -gt 0) { [uint32]$TargetProcessId } else { $windowProcessId }
  $activated = $actualForeground -eq $handle -or ($expectedProcessId -gt 0 -and $actualProcessId -eq $expectedProcessId)
  return $activated
}

function Invoke-FocusJson([long]$TargetWindowHandle, [long]$TargetProcessId) {
  $activated = Set-TargetForeground $TargetWindowHandle $TargetProcessId
  return [PSCustomObject]@{ success = [bool]$activated } | ConvertTo-Json -Compress
}

function Invoke-PasteJson([long]$TargetWindowHandle, [long]$TargetProcessId) {
  $activated = Set-TargetForeground $TargetWindowHandle $TargetProcessId
  if (-not $activated) {
    return [PSCustomObject]@{ success = $false } | ConvertTo-Json -Compress
  }

  $keyUp = 0x0002
  [PromptInputBridge]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [PromptInputBridge]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
  [PromptInputBridge]::keybd_event(0x56, 0, $keyUp, [UIntPtr]::Zero)
  [PromptInputBridge]::keybd_event(0x11, 0, $keyUp, [UIntPtr]::Zero)

  return [PSCustomObject]@{ success = $true } | ConvertTo-Json -Compress
}

if ($Action -eq "GetTarget") {
  Get-TargetJson
  exit 0
}

if ($Action -eq "Paste") {
  Invoke-PasteJson $WindowHandle $ProcessId
  exit 0
}

if ($Action -eq "Focus") {
  Invoke-FocusJson $WindowHandle $ProcessId
  exit 0
}

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Write-Output '{"ready":true}'
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq "GET") {
    Write-Output (Get-TargetJson)
  } elseif ($line.StartsWith("FOCUS|")) {
    $parts = $line.Split('|')
    [long]$targetHandle = 0
    [long]$targetProcessId = 0
    if ($parts.Length -ge 3 -and [long]::TryParse($parts[1], [ref]$targetHandle) -and [long]::TryParse($parts[2], [ref]$targetProcessId)) {
      Write-Output (Invoke-FocusJson $targetHandle $targetProcessId)
    } else {
      Write-Output '{"success":false}'
    }
  } elseif ($line.StartsWith("PASTE|")) {
    $parts = $line.Split('|')
    [long]$targetHandle = 0
    [long]$targetProcessId = 0
    if ($parts.Length -ge 3 -and [long]::TryParse($parts[1], [ref]$targetHandle) -and [long]::TryParse($parts[2], [ref]$targetProcessId)) {
      Write-Output (Invoke-PasteJson $targetHandle $targetProcessId)
    } else {
      Write-Output '{"success":false}'
    }
  } else {
    Write-Output '{"error":"unknown-command"}'
  }
  [Console]::Out.Flush()
}
