Option Explicit

Dim fso, shell, scriptDir, psScriptPath, args, argStr, i, cmd, winDir, psExe

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScriptPath = fso.BuildPath(scriptDir, "omp-web-tray.ps1")
winDir = shell.ExpandEnvironmentStrings("%SystemRoot%")
If winDir = "%SystemRoot%" Or winDir = "" Then
    winDir = shell.ExpandEnvironmentStrings("%windir%")
End If
If winDir = "%windir%" Or winDir = "" Then
    winDir = "C:\Windows"
End If

psExe = fso.BuildPath(winDir, "System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fso.FileExists(psExe) Then
    psExe = "powershell.exe"
End If

argStr = ""
Set args = WScript.Arguments
For i = 0 To args.Count - 1
    Dim arg
    arg = args.Item(i)
    If InStr(arg, " ") > 0 Then
        argStr = argStr & " """ & arg & """"
    Else
        argStr = argStr & " " & arg
    End If
Next

cmd = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScriptPath & """" & argStr

' WindowStyle 0 = SW_HIDE (zero console flicker)
' bWaitOnReturn False = Asynchronous execution
shell.Run cmd, 0, False

Set shell = Nothing
Set fso = Nothing
