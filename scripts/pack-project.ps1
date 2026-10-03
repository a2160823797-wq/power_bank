$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'outputs'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$archivePath = Join-Path $outputDirectory ('PowerBank-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.zip')
$excludedDirectories = @('node_modules', '.git', '.next', '.vinext', '.wrangler', '.offline-build', 'dist', 'out', 'coverage', 'outputs', 'work')

# Skip generated directories before traversal to avoid scanning dependency files.
function Get-PackageFiles([string]$Directory) {
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($entry.PSIsContainer) {
            if ($entry.Name -notin $excludedDirectories) {
                Get-PackageFiles $entry.FullName
            }
        } elseif ($entry.Name -notlike '*.tsbuildinfo' -and $entry.Name -notlike '*.log' -and $entry.Name -notlike '.env*') {
            $entry
        }
    }
}

$files = @(Get-PackageFiles $projectRoot)
$archive = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $relativePath = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $file.FullName, "PowerBank/$relativePath", [System.IO.Compression.CompressionLevel]::Fastest
        ) | Out-Null
    }
} finally {
    $archive.Dispose()
}

Write-Host ('Packed {0} files, {1:N2} MB -> {2:N2} MB' -f $files.Count, (($files | Measure-Object Length -Sum).Sum / 1MB), ((Get-Item -LiteralPath $archivePath).Length / 1MB))
Write-Host $archivePath
