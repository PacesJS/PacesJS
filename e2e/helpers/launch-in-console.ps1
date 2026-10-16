# Starts a command line in its own hidden console and prints the PID of the console's cmd.exe.
# The new console lets a test deliver a real Ctrl+C (see send-ctrl-c.ps1) without touching its own.
# Ctrl+C handling is inherited: if any ancestor ignores it (CI agents and some shells do), every
# descendant ignores it too, so re-enable it for this process before spawning. Windows only.
param([Parameter(Mandatory = $true)][string]$CommandLine)
Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);' -Name Console -Namespace Paces
[void][Paces.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$p = Start-Process -FilePath cmd.exe -ArgumentList ('/d /s /v:on /c "' + $CommandLine + '"') -WindowStyle Hidden -PassThru
Write-Output $p.Id
