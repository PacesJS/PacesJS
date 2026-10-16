# Sends a real console Ctrl+C (CTRL_C_EVENT) to every process attached to the console of -ProcessId,
# which is what a terminal does when the user presses Ctrl+C. Windows only.
param([Parameter(Mandatory = $true)][int]$ProcessId)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PacesConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
}
"@
[void][PacesConsole]::FreeConsole()
if (-not [PacesConsole]::AttachConsole([uint32]$ProcessId)) { exit 2 }
[void][PacesConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
$ok = [PacesConsole]::GenerateConsoleCtrlEvent(0, 0); Write-Output "generate=$ok err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Start-Sleep -Milliseconds 300
exit 0
