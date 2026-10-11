Option Explicit

Dim fso, project, exe, shell, desktop, application, arguments, i
Set fso = CreateObject("Scripting.FileSystemObject")
project = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(project, "node_modules\electron\dist\electron.exe")
If Not fso.FileExists(exe) Then Fail "missing-electron", exe

On Error Resume Next
Set shell = CreateObject("Shell.Application")
If Err.Number <> 0 Then Fail "shell-unavailable", Err.Description
Set desktop = shell.Windows.FindWindowSW(0, 0, 8, 0, 1)
If Err.Number <> 0 Then Fail "desktop-unavailable", Err.Description
If desktop Is Nothing Then Fail "desktop-unavailable", "Explorer desktop was unavailable"
Set application = desktop.Document.Application
If Err.Number <> 0 Then Fail "desktop-application-unavailable", Err.Description
If application Is Nothing Then Fail "desktop-application-unavailable", "Explorer shell dispatcher was unavailable"

arguments = Chr(34) & project & Chr(34)
For i = 0 To WScript.Arguments.Count - 1
  If WScript.Arguments(i) = "--autostart" Or WScript.Arguments(i) = "--open-stats" Then
    arguments = arguments & " " & WScript.Arguments(i)
  End If
Next
application.ShellExecute exe, arguments, project, "open", 0
If Err.Number <> 0 Then Fail "launch-failed", Err.Description
On Error GoTo 0
WScript.Quit 0

Sub Fail(stage, detail)
  Dim logShell, folder, logfile
  On Error Resume Next
  Set logShell = CreateObject("WScript.Shell")
  folder = logShell.ExpandEnvironmentStrings("%APPDATA%") & "\relay-balance-pet"
  If Not fso.FolderExists(folder) Then fso.CreateFolder folder
  Set logfile = fso.OpenTextFile(folder & "\launcher.log", 8, True)
  logfile.WriteLine CStr(Now) & " [" & stage & "] " & detail
  logfile.Close
  WScript.Quit 1
End Sub
