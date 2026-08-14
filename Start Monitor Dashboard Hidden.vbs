Option Explicit

Dim shell, fso, project, script, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function

project = fso.GetParentFolderName(WScript.ScriptFullName)
script = project & "\Start Monitor Dashboard.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Quote(script)

shell.Run command, 0, False
