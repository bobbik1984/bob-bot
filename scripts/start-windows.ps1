param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..\prototype')
$state = Join-Path $env:LOCALAPPDATA 'Bob-Bot'
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"
function Open-Bob {
    Write-Host "Bob-Bot: $url"
    if (!$NoBrowser) { Start-Process $url }
}
function Get-Digest($file) {
    $stream = [IO.File]::OpenRead((Convert-Path -LiteralPath $file))
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
}
function Get-Node {
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($installed -and ([version]((& $installed.Source -v).TrimStart('v')) -ge [version]'24.9.0')) { return $installed.Source }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $runtime = Join-Path $state "runtime-$arch"
    $exe = Join-Path $runtime 'node.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    Write-Host '首次启动：正在下载专用于 Bob-Bot 的 Node.js 24，无需管理员权限。'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 35 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $match = [regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+(node-(v24\.\d+\.\d+)-win-$arch\.zip)\s*$")
    if (!$match.Success) { throw '无法获取 Node.js 官方校验清单。请检查网络，或安装 Node.js 24 LTS 后重试。' }
    $tmp = New-Item -ItemType Directory -Path (Join-Path $state ([guid]::NewGuid().ToString()))
    $zip = Join-Path $tmp.FullName $match.Groups[2].Value
    try {
        $source = 'https://nodejs.org/dist/' + $match.Groups[3].Value + '/' + $match.Groups[2].Value
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe --fail --location --progress-bar --show-error --connect-timeout 15 --speed-limit 512 --speed-time 60 --max-time 1200 --retry 1 --output $zip $source
            if ($LASTEXITCODE) { throw '无法完成 Node.js 下载。请检查网络，或安装 Node.js 24 LTS 后再次双击。' }
        } else {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 1200 $source -OutFile $zip
        }
        if ((Get-Digest $zip) -ne $match.Groups[1].Value) { throw 'Node.js 下载校验失败，请重试。' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp.FullName)
        $extracted = Join-Path $tmp.FullName ([IO.Path]::GetFileNameWithoutExtension($zip))
        [IO.Directory]::Move($extracted, $runtime)
    } finally {
        # Only remove our freshly generated download directory.
        if ($tmp.Parent.FullName -eq [IO.Path]::GetFullPath($state) -and $tmp.Name -match '^[0-9a-f-]{36}$') {
            Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
        }
    }
    return $exe
}
function Read-Pin {
    $secure = Read-Host '设置六位数字 PIN（输入时隐藏）' -AsSecureString
    $plain = [Net.NetworkCredential]::new('', $secure).Password
    $secure.Dispose()
    return $plain
}
try {
    $existing = try { Invoke-RestMethod "$url/api/version" -TimeoutSec 2 -ErrorAction Stop } catch { $null }
    if ($existing.name -eq 'bobbot') { Open-Bob; exit 0 }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } catch { throw "本机端口 $port 已被其他程序占用，请关闭该程序后重试。" } finally { $listener.Stop() }
    $mutex = [Threading.Mutex]::new($false, 'Local\BobBotWindowsLauncher')
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw '另一个 Bob-Bot 窗口正在准备或启动服务，请查看那个窗口。' }
    $null = New-Item -ItemType Directory -Path $state -Force
    if (!$env:BOBBOT_DATA) {
        $env:BOBBOT_DATA = if (Test-Path -LiteralPath 'data' -PathType Container) { (Resolve-Path 'data').Path } else { Join-Path $state 'data' }
    }
    $env:HOST = '127.0.0.1'
    $env:BOB_COMPAT_HOST = '127.0.0.1'
    $node = Get-Node
    $nodeDir = Split-Path $node
    $env:Path = "$nodeDir;$env:Path"
    $stamp = 'node_modules\.bobbot-windows-install'
    $fingerprint = ((@('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc') | ForEach-Object { Get-Digest $_ }) -join '-') + (& $node -v)
    if (!(Test-Path $stamp) -or [IO.File]::ReadAllText((Join-Path $PWD $stamp)) -ne $fingerprint -or !(Test-Path 'node_modules\@deepseek-ai\dsh\package.json')) {
        Write-Host '正在安装 Bob-Bot 的依赖。首次下载可能需要几分钟。'
        $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
        if ($pnpm -and (& $pnpm.Source --version) -eq '11.13.0') {
            & $pnpm.Source install --frozen-lockfile
        } else {
            & (Join-Path $nodeDir 'npx.cmd') --yes --registry=https://registry.npmjs.org pnpm@11.13.0 install --frozen-lockfile
        }
        if ($LASTEXITCODE) { throw '依赖安装未完成。请检查上方提示及网络，然后再次双击启动。' }
        [IO.File]::WriteAllText((Join-Path $PWD $stamp), $fingerprint)
    }
    if (!(Test-Path -LiteralPath (Join-Path $env:BOBBOT_DATA 'pin.json'))) {
        do { $pin = Read-Pin; if ($pin -notmatch '^[0-9]{6}$') { Write-Host '请输入六位数字。' } } until ($pin -match '^[0-9]{6}$')
        $pin | & $node set-pin.mjs --stdin
        $pin = $null
        if ($LASTEXITCODE) { throw 'PIN 保存失败。' }
    }
    Write-Host "数据目录：$env:BOBBOT_DATA"
    Write-Host '请保留这个窗口。按 Ctrl+C 停止服务；下次双击即可重新打开。'
    if (!$NoBrowser) { $env:BOBBOT_OPEN_LOCAL = '1' } else { $env:BOBBOT_OPEN_LOCAL = '' }
    & $node server.mjs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
