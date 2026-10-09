# ===================================================================
#  Wait for the tunnel URL and copy it to the clipboard
#  Called by the public tunnel launcher (GenerateURL.cmd)
#
#  How it works:
#    cloudflared writes its log to tunnel.log. This script polls that
#    file, grabs the https://xxx.trycloudflare.com line, prints it in a
#    big block and copies it to the clipboard.
#
#  Why not read the process command line:
#    Get-CimInstance returns an empty CommandLine for cloudflared
#    without admin rights, so that approach does not work here.
#
#  ENCODING WARNING:
#    PowerShell reads .ps1 files as GBK on a Chinese Windows. Any
#    non-ASCII character here turns into mojibake, and the stray quote
#    characters break the parser ("The string is missing the
#    terminator"). So EVERYTHING in this file must stay ASCII,
#    including comments.
# ===================================================================

$logFile = Join-Path $PSScriptRoot 'tunnel.log'
$deadline = (Get-Date).AddSeconds(90)
$url = $null

# Only these hosts are real tunnel addresses. The log also contains
# api.trycloudflare.com and region1.v2.argotunnel.com, and matching a
# bare ".trycloudflare.com" would wrongly pick up api.trycloudflare.com
# when the tunnel fails with a TLS error. A real quick-tunnel subdomain
# is a random multi-word name like "fitted-jackets-costumes-jean".
$rx = 'https://(?!(?:api|status|updates)\.)[a-z0-9]+\-[a-z0-9\-]+\.trycloudflare\.com'

while ((Get-Date) -lt $deadline) {
    if (Test-Path $logFile) {
        # Read only the tail, otherwise the log grows and slows this down
        try {
            $tail = Get-Content $logFile -Tail 60 -ErrorAction SilentlyContinue
            if ($tail) {
                # Require the success banner before trusting any URL.
                $ok = ($tail | Select-String -SimpleMatch 'Your quick Tunnel has been created').Count -gt 0
                if ($ok) {
                    $hit = $tail | Select-String -Pattern $rx | Select-Object -First 1
                    if ($hit) {
                        if ($hit -is [array]) { $hit = $hit[0] }
                        $m = [regex]::Match($hit.ToString(), $rx)
                        if ($m.Success) { $url = $m.Value; break }
                    }
                }
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 800
}

if (-not $url) {
    # Look for the common failure so the message can be specific.
    $why = ''
    try {
        $t2 = Get-Content $logFile -Tail 60 -ErrorAction SilentlyContinue
        if ($t2 | Select-String -SimpleMatch 'certificate signed by unknown authority') {
            $why = 'TLS certificate check failed. This is a local network issue.'
        } elseif ($t2 | Select-String -SimpleMatch 'failed to request quick Tunnel') {
            $why = 'Could not reach Cloudflare. Check your internet connection.'
        }
    } catch { }

    Write-Host ''
    Write-Host '   [WARN] No public URL was created within 90 seconds.'
    if ($why) { Write-Host ('   Reason: ' + $why) }
    Write-Host '   Close this window and try again.'
    Write-Host ''
    exit 1
}

if ($url) {
    # Copy to clipboard.
    # Set-Clipboard must run in THIS process: inside Start-Job it runs in
    # a child runspace with no clipboard access, so the copy silently
    # does nothing. Verified: same-session Set-Clipboard works, the
    # Start-Job version leaves the clipboard empty.
    # Never fatal: if it fails the URL is still printed on screen.
    $copied = $false
    try {
        Set-Clipboard -Value $url
        $copied = $true
    } catch { }

    Write-Host ''
    Write-Host '  =============================================================='
    Write-Host ''
    if ($copied) {
        Write-Host '     PUBLIC URL IS READY  (copied to clipboard)'
    } else {
        Write-Host '     PUBLIC URL IS READY  (copy it by hand)'
    }
    Write-Host ''
    Write-Host '     ' $url
    Write-Host ''
    Write-Host '  =============================================================='
    Write-Host ''
    Write-Host '   Send this URL to the tester. It works on any network.'
    Write-Host ''
    Write-Host '   Keep this window open the whole time.'
    Write-Host ''
    Write-Host '   Remember:'
    Write-Host '     1. Close this window  = URL stops working'
    Write-Host '     2. PC off / sleep / no network = URL stops working'
    Write-Host '     3. Restarting gives a different URL each time'
    Write-Host ''
    exit 0
}