Option Explicit

Dim shell, fso, root, packagePath, electronPath, vitePath, concurrentlyPath, waitOnPath, crossEnvPath, splashPath, promptPath, readyPath
Dim nodeCheck, npmCheck, installExit, waited, depsMissing

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
packagePath = fso.BuildPath(root, "package.json")
electronPath = fso.BuildPath(root, "node_modules\electron")
vitePath = fso.BuildPath(root, "node_modules\vite")
concurrentlyPath = fso.BuildPath(root, "node_modules\concurrently")
waitOnPath = fso.BuildPath(root, "node_modules\wait-on")
crossEnvPath = fso.BuildPath(root, "node_modules\cross-env")
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
    ShowThemedPrompt "Node.js is required to run Resin Slicer from source." & vbCrLf & vbCrLf & _
                     "Install the LTS build from https://nodejs.org, or run this in PowerShell:" & vbCrLf & _
                     "    winget install OpenJS.NodeJS.LTS" & vbCrLf & vbCrLf & _
                     "After installing, sign out and back in (or reboot) so Node is on PATH," & vbCrLf & _
                     "then run this launcher again."
    WScript.Quit 1
End If

npmCheck = shell.Run("cmd.exe /d /c where npm.cmd >nul 2>nul", 0, True)
If npmCheck <> 0 Then
    ShowThemedPrompt "npm.cmd was not found on PATH." & vbCrLf & _
                     "Reinstall Node.js with npm enabled, then run this launcher again."
    WScript.Quit 1
End If

depsMissing = Not fso.FolderExists(electronPath) Or _
              Not fso.FolderExists(vitePath) Or _
              Not fso.FolderExists(concurrentlyPath) Or _
              Not fso.FolderExists(waitOnPath) Or _
              Not fso.FolderExists(crossEnvPath)

If depsMissing Then
    installExit = shell.Run("cmd.exe /d /c cd /d """ & root & """ && npm.cmd install", 0, True)
    If installExit <> 0 Then
        ShowThemedPrompt "Resin Slicer development dependency installation failed." & vbCrLf & _
                         "Run npm install manually in:" & vbCrLf & root
        WScript.Quit installExit
    End If
End If

shell.Run "cmd.exe /d /c cd /d """ & root & """ && npm.cmd run dev", 0, False

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
