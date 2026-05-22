Option Explicit

Dim shell, fso, root, packagePath, electronPath, splashPath, nodeCheck, npmCheck, installExit

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
packagePath = fso.BuildPath(root, "package.json")
electronPath = fso.BuildPath(root, "node_modules\electron")
splashPath = fso.BuildPath(root, "Show Resin Slicer Splash.ps1")

If Not fso.FileExists(packagePath) Then
    MsgBox "Could not find package.json in:" & vbCrLf & root, vbCritical, "Resin Slicer"
    WScript.Quit 1
End If

If fso.FileExists(splashPath) Then
    shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & splashPath & """", 0, False
End If

nodeCheck = shell.Run("cmd.exe /d /c where node.exe >nul 2>nul", 0, True)
If nodeCheck <> 0 Then
    MsgBox "Node.js is required to run Resin Slicer from source." & vbCrLf & _
           "Install Node.js, then run this launcher again.", vbCritical, "Resin Slicer"
    WScript.Quit 1
End If

npmCheck = shell.Run("cmd.exe /d /c where npm.cmd >nul 2>nul", 0, True)
If npmCheck <> 0 Then
    MsgBox "npm.cmd was not found on PATH." & vbCrLf & _
           "Reinstall Node.js with npm enabled, then run this launcher again.", vbCritical, "Resin Slicer"
    WScript.Quit 1
End If

If Not fso.FolderExists(electronPath) Then
    installExit = shell.Run("cmd.exe /d /c cd /d """ & root & """ && npm.cmd install", 0, True)
    If installExit <> 0 Then
        MsgBox "Electron dependency installation failed." & vbCrLf & _
               "Run npm install manually in:" & vbCrLf & root, vbCritical, "Resin Slicer"
        WScript.Quit installExit
    End If
End If

shell.Run "cmd.exe /d /c cd /d """ & root & """ && npm.cmd start", 0, False
