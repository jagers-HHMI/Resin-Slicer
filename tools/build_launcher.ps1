$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$source = Join-Path $root "launcher\ResinSlicerLauncher.cs"
$output = Join-Path $root "ResinSlicer.exe"

if (!(Test-Path $csc)) {
    throw "Could not find .NET Framework C# compiler at $csc"
}

& $csc `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /reference:System.dll `
    /reference:System.Windows.Forms.dll `
    /out:$output `
    $source

Write-Host "Built $output"
