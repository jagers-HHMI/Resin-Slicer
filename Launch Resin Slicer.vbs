Option Explicit

Dim shell, fso, root, packagePath, electronPath, splashPath, promptPath, readyPath
Dim nodeCheck, npmCheck, installExit, waited

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
packagePath = fso.BuildPath(root, "package.json")
electronPath = fso.BuildPath(root, "node_modules\electron")
splashPath = fso.BuildPath(root, "Show Resin Slicer Splash.ps1")
promptPath = fso.BuildPath(root, "Show Resin Slicer Prompt.ps1")

If fso.FileExists(splashPath) Then
    readyPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "resin-slicer-splash-" & Replace(CStr(Timer), ".", "") & ".ready")
    If fso.FileExists(readyPath) Then
        fso.DeleteFile readyPath, True
    End If

    shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & splashPath & """ -ReadyFile """ & readyPath & """", 0, False

    waited = 0
    Do While Not fso.FileExists(readyPath) And waited < 2500
        WScript.Sleep 50
        waited = waited + 50
    Loop

    If fso.FileExists(readyPath) Then
        fso.DeleteFile readyPath, True
    End If
End If

If Not fso.FileExists(packagePath) Then
    ShowThemedPrompt "Could not find package.json in:" & vbCrLf & root
    WScript.Quit 1
End If

nodeCheck = shell.Run("cmd.exe /d /c where node.exe >nul 2>nul", 0, True)
If nodeCheck <> 0 Then
    ShowThemedPrompt "Node.js is required to run Resin Slicer from source." & vbCrLf & _
                     "Install Node.js, then run this launcher again."
    WScript.Quit 1
End If

npmCheck = shell.Run("cmd.exe /d /c where npm.cmd >nul 2>nul", 0, True)
If npmCheck <> 0 Then
    ShowThemedPrompt "npm.cmd was not found on PATH." & vbCrLf & _
                     "Reinstall Node.js with npm enabled, then run this launcher again."
    WScript.Quit 1
End If

If Not fso.FolderExists(electronPath) Then
    installExit = shell.Run("cmd.exe /d /c cd /d """ & root & """ && npm.cmd install", 0, True)
    If installExit <> 0 Then
        ShowThemedPrompt "Electron dependency installation failed." & vbCrLf & _
                         "Run npm install manually in:" & vbCrLf & root
        WScript.Quit installExit
    End If
End If

shell.Run "cmd.exe /d /c cd /d """ & root & """ && npm.cmd start", 0, False

Sub ShowThemedPrompt(message)
    Dim messagePath, file

    If Not fso.FileExists(promptPath) Then
        MsgBox message, vbCritical, "Resin Slicer"
        Exit Sub
    End If

    messagePath = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "resin-slicer-prompt-" & Replace(CStr(Timer), ".", "") & ".txt")
    Set file = fso.CreateTextFile(messagePath, True, False)
    file.Write message
    file.Close

    shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & promptPath & """ -Title ""Resin Slicer"" -MessageFile """ & messagePath & """", 0, True

    If fso.FileExists(messagePath) Then
        fso.DeleteFile messagePath, True
    End If
End Sub
