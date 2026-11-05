#requires -Version 5.1
<#
  Read-only SMB metadata worker. Input is one JSON object on stdin. Output is
  newline-delimited JSON only. The parent process owns cancellation/timeouts.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:token = [IntPtr]::Zero
$script:identity = $null
$script:impersonation = $null
$script:hostName = ''
$script:warningCount = 0
$script:hadErrors = $false
$script:credentialFailed = $false
$script:validationMessage = $null
$password = $null
$request = $null
$inputJson = $null

function Write-Event {
    param([Parameter(Mandatory = $true)][hashtable]$Event)
    if ($script:credentialFailed) { $Event.authFailure = $true }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Event -Depth 6 -Compress))
    [Console]::Out.Flush()
}

function Get-PropertyValue {
    param($Object, [string]$Name, $Default)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Stop-InvalidRequest {
    param([string]$Message)
    # Only our fixed validation messages may be copied to output. Parser and
    # framework exception messages can include fragments of the input JSON.
    $script:validationMessage = $Message
    throw [ArgumentException]::new($Message)
}

function Read-IntegerOption {
    param($Options, [string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum)
    $value = Get-PropertyValue $Options $Name $Default
    $parsed = 0
    if (-not [int]::TryParse([string]$value, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        Stop-InvalidRequest "Invalid option: $Name."
    }
    return $parsed
}

function Read-BooleanOption {
    param($Options, [string]$Name, [bool]$Default)
    $value = Get-PropertyValue $Options $Name $Default
    if ($value -isnot [bool]) { Stop-InvalidRequest "Invalid option: $Name." }
    return [bool]$value
}

function Get-SafeError {
    param([Exception]$Exception)
    $current = $Exception
    while ($null -ne $current.InnerException) { $current = $current.InnerException }
    $code = $current.HResult -band 0xffff
    if ($current -is [ComponentModel.Win32Exception]) { $code = $current.NativeErrorCode }
    switch ($code) {
        5    { return 'Access denied.' }
        53   { return 'Network path unavailable.' }
        64   { return 'The network connection was lost.' }
        67   { return 'Share name not found.' }
        86   { $script:credentialFailed = $true; return 'The server rejected the supplied credentials.' }
        121  { return 'The network operation timed out.' }
        1219 { return 'Windows reported a conflicting SMB session for this server.' }
        1231 { return 'The network location cannot be reached.' }
        1326 { $script:credentialFailed = $true; return 'The server rejected the supplied credentials.' }
        1327 { $script:credentialFailed = $true; return 'The account has a logon restriction.' }
        1328 { $script:credentialFailed = $true; return 'The account cannot log on at this time.' }
        1329 { $script:credentialFailed = $true; return 'The account cannot log on from this computer.' }
        1330 { $script:credentialFailed = $true; return 'The account password has expired.' }
        1331 { $script:credentialFailed = $true; return 'The account is disabled.' }
        1385 { $script:credentialFailed = $true; return 'The account is not allowed this logon type.' }
        1793 { $script:credentialFailed = $true; return 'The account has expired.' }
        1907 { $script:credentialFailed = $true; return 'The account password must be changed.' }
        1909 { $script:credentialFailed = $true; return 'The account is locked out.' }
        default {
            if ($current -is [UnauthorizedAccessException] -or $current -is [Security.SecurityException]) {
                return 'Access denied.'
            }
            return "The operation failed (Windows error $code)."
        }
    }
}

function Write-WarningEvent {
    param([string]$Message)
    $script:hadErrors = $true
    # A broken tree should not produce an unbounded error stream.
    if ($script:warningCount -lt 100) {
        Write-Event @{ type = 'warning'; message = $Message }
    } elseif ($script:warningCount -eq 100) {
        Write-Event @{ type = 'warning'; message = 'Further directory warnings have been suppressed.' }
    }
    $script:warningCount++
}

function Invoke-ShareInventory {
    param([string]$Share, [string]$UncHost, [int]$MaxDepth, [bool]$IncludeFolders)
    $shareHadError = $false
    $rootOpened = $false
    $root = '\\' + $UncHost + '\' + $Share
    Write-Event @{ type = 'share'; share = $Share; status = 'scanning' }
    $pending = New-Object 'System.Collections.Generic.Stack[object]'
    $pending.Push(@{ path = $root; depth = 0 })

    while ($pending.Count -gt 0 -and -not $script:credentialFailed) {
        $directory = $pending.Pop()
        $iterator = $null
        try {
            $directoryInfo = New-Object System.IO.DirectoryInfo([string]$directory.path)
            $iterator = $directoryInfo.EnumerateFileSystemInfos().GetEnumerator()
            while (-not $script:credentialFailed) {
                # Enumeration can fail on MoveNext as well as on creation.
                if (-not $iterator.MoveNext()) { break }
                $rootOpened = $true
                $item = $iterator.Current
                try {
                    $attributes = $item.Attributes
                    $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
                    $isReparsePoint = ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
                    if (-not $isDirectory -or $IncludeFolders) {
                        $size = $null
                        $extension = ''
                        $kind = 'folder'
                        if (-not $isDirectory) {
                            $size = [long]$item.Length
                            $extension = $item.Extension.ToLowerInvariant()
                            $kind = 'file'
                        }
                        Write-Event @{
                            type = 'entry'
                            entry = @{
                                host = $script:hostName
                                share = $Share
                                path = $item.FullName
                                name = $item.Name
                                kind = $kind
                                size = $size
                                modified = $item.LastWriteTimeUtc.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
                                extension = $extension
                            }
                        }
                    }
                    # Junctions and symlinks must not escape the requested share tree.
                    if ($isDirectory -and -not $isReparsePoint -and [int]$directory.depth -lt $MaxDepth) {
                        $pending.Push(@{ path = $item.FullName; depth = ([int]$directory.depth + 1) })
                    } elseif ($isDirectory -and -not $isReparsePoint) {
                        $shareHadError = $true
                        Write-WarningEvent "The configured depth limit prevented inspecting directory contents at $($item.FullName)."
                    }
                } catch {
                    $shareHadError = $true
                    $reason = Get-SafeError $_.Exception
                    Write-WarningEvent "Could not read metadata in $($directory.path). $reason"
                }
            }
            # An empty share is still a successfully opened root.
            if ([int]$directory.depth -eq 0) { $rootOpened = $true }
        } catch {
            $shareHadError = $true
            $reason = Get-SafeError $_.Exception
            if ([int]$directory.depth -eq 0 -and -not $rootOpened) {
                Write-Event @{ type = 'share'; share = $Share; status = 'error'; error = $reason }
                $script:hadErrors = $true
                return
            }
            Write-WarningEvent "Could not enumerate $($directory.path). $reason"
        } finally {
            if ($null -ne $iterator -and $iterator -is [IDisposable]) { $iterator.Dispose() }
        }
    }

    if ($shareHadError -or $script:credentialFailed) {
        Write-Event @{ type = 'share'; share = $Share; status = 'partial'; error = 'Some metadata could not be read.' }
    } else {
        Write-Event @{ type = 'share'; share = $Share; status = 'complete' }
    }
}

try {
    $inputJson = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($inputJson)) { Stop-InvalidRequest 'A JSON request is required.' }
    $request = ConvertFrom-Json -InputObject $inputJson
    $inputJson = $null
    $rawHost = [string](Get-PropertyValue $request 'host' '')
    $address = $null
    if (-not [Net.IPAddress]::TryParse($rawHost, [ref]$address)) {
        Stop-InvalidRequest 'The host must be an IP address literal.'
    }
    $script:hostName = $address.ToString()
    $uncHost = $script:hostName
    if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
        $uncHost = $uncHost.Replace(':', '-').Replace('%', 's') + '.ipv6-literal.net'
    }

    $username = [string](Get-PropertyValue $request 'username' '')
    $password = [string](Get-PropertyValue $request 'password' '')
    $domain = [string](Get-PropertyValue $request 'domain' '')
    if ([string]::IsNullOrWhiteSpace($username)) { Stop-InvalidRequest 'A username is required.' }
    if ($username.Contains('\')) {
        $pieces = $username.Split('\')
        if ($pieces.Count -ne 2 -or [string]::IsNullOrWhiteSpace($pieces[0]) -or [string]::IsNullOrWhiteSpace($pieces[1])) {
            Stop-InvalidRequest 'Use DOMAIN\username or username@domain for the username.'
        }
        if (-not [string]::IsNullOrWhiteSpace($domain) -and $domain -ne $pieces[0]) {
            Stop-InvalidRequest 'The username domain conflicts with the domain field.'
        }
        $domain = $pieces[0]
        $username = $pieces[1]
    }
    if ([string]::IsNullOrWhiteSpace($domain)) { $domain = $null }
    if ($username.Contains('@') -and $null -ne $domain) {
        Stop-InvalidRequest 'Leave the domain field empty when using username@domain.'
    }

    $options = Get-PropertyValue $request 'options' $null
    $maxDepth = Read-IntegerOption $options 'maxDepth' 8 0 32
    $includeHiddenShares = Read-BooleanOption $options 'includeHiddenShares' $false
    $includeFolders = Read-BooleanOption $options 'includeFolders' $false
    $requestedShares = @(Get-PropertyValue $options 'shareNames' @())
    $shares = New-Object 'System.Collections.Generic.List[string]'
    $seenShares = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($shareValue in @($requestedShares)) {
        if ($shareValue -isnot [string]) { Stop-InvalidRequest 'Share names must be strings.' }
        $share = $shareValue.Trim()
        if ([string]::IsNullOrWhiteSpace($share) -or $share -eq '.' -or $share -eq '..' -or $share -match '[\\/\x00-\x1f]') {
            Stop-InvalidRequest 'A share name is invalid. Supply names only, without a UNC path.'
        }
        if (($includeHiddenShares -or -not $share.EndsWith('$')) -and $seenShares.Add($share)) { $shares.Add($share) }
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SmbAtlasNative
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool LogonUser(string username, string domain, string password,
        int logonType, int logonProvider, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHARE_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string Name;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string Remark;
    }

    [DllImport("Netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetShareEnum(string server, int level, out IntPtr buffer,
        int preferredMaximumLength, out int entriesRead, out int totalEntries, ref uint resumeHandle);

    [DllImport("Netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);

    public static string[] GetDiskShares(string server)
    {
        var shares = new List<string>();
        uint resume = 0;
        int result;
        do
        {
            IntPtr buffer = IntPtr.Zero;
            int read, total;
            uint previousResume = resume;
            try
            {
                result = NetShareEnum(server, 1, out buffer, 65536, out read, out total, ref resume);
                if (result != 0 && result != 234) throw new Win32Exception(result);
                int size = Marshal.SizeOf(typeof(SHARE_INFO_1));
                for (int i = 0; i < read; i++)
                {
                    var share = (SHARE_INFO_1)Marshal.PtrToStructure(IntPtr.Add(buffer, i * size), typeof(SHARE_INFO_1));
                    if ((share.Type & 0xff) == 0 && !String.IsNullOrEmpty(share.Name)) shares.Add(share.Name);
                }
                if (result == 234 && read == 0 && resume == previousResume) throw new Win32Exception(234);
            }
            finally
            {
                if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
            }
        } while (result == 234);
        return shares.ToArray();
    }
}
'@

    # LOGON32_LOGON_NEW_CREDENTIALS + WINNT50 isolate outbound credentials from
    # the interactive user and avoid modifying existing SMB mappings/sessions.
    if (-not [SmbAtlasNative]::LogonUser($username, $domain, $password, 9, 3, [ref]$script:token)) {
        $nativeCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($nativeCode)
    }
    $password = $null
    $request = $null
    $script:identity = [Security.Principal.WindowsIdentity]::new($script:token)
    $script:impersonation = $script:identity.Impersonate()

    if (@($requestedShares).Count -eq 0) {
        foreach ($share in [SmbAtlasNative]::GetDiskShares(('\\' + $uncHost))) {
            if (($includeHiddenShares -or -not $share.EndsWith('$')) -and $seenShares.Add($share)) { $shares.Add($share) }
        }
    }
    if ($shares.Count -eq 0) {
        Write-Event @{ type = 'warning'; message = 'No eligible disk shares were found. Enable hidden shares or supply share names if appropriate.' }
    }
    foreach ($share in $shares) {
        if ($script:credentialFailed) { break }
        Invoke-ShareInventory -Share $share -UncHost $uncHost -MaxDepth $maxDepth -IncludeFolders $includeFolders
    }
    if ($script:credentialFailed) {
        Write-Event @{ type = 'done'; status = 'error'; error = 'The scan stopped after the server rejected the account or credentials.' }
    } elseif ($script:hadErrors) {
        Write-Event @{ type = 'done'; status = 'partial'; error = 'Some shares or directories could not be read.' }
    } else {
        Write-Event @{ type = 'done'; status = 'complete' }
    }
} catch {
    # Never serialize exception messages from native or filesystem operations:
    # they may contain account or connection details supplied by the caller.
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    $message = 'The SMB worker could not complete the scan.'
    if ($null -ne $script:validationMessage) {
        $message = $script:validationMessage
    } elseif ($exception -is [ComponentModel.Win32Exception] -or $exception -is [IO.IOException] -or $exception -is [UnauthorizedAccessException]) {
        $message = Get-SafeError $exception
    } elseif ($exception -is [System.Management.Automation.PSArgumentException] -or $exception -is [System.Management.Automation.PSInvalidCastException]) {
        $message = 'The request contains invalid values.'
    }
    Write-Event @{ type = 'done'; status = 'error'; error = $message }
    exit 1
} finally {
    $password = $null
    $inputJson = $null
    $request = $null
    if ($null -ne $script:impersonation) {
        try { $script:impersonation.Undo() } catch { }
        try { $script:impersonation.Dispose() } catch { }
    }
    if ($null -ne $script:identity) { try { $script:identity.Dispose() } catch { } }
    if ($script:token -ne [IntPtr]::Zero) { [void][SmbAtlasNative]::CloseHandle($script:token) }
}
