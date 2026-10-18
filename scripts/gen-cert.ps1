param(
  [Parameter(Mandatory=$true)][string]$OutDir,
  [string]$Ip = '192.168.1.100',
  # 除局域网 IP 之外还要写进 SAN 的地址（例如出门用的 Tailscale 100.x）。用法：-ExtraIp 100.x.y.z
  [string[]]$ExtraIp = @(),
  [string]$Pass = 'anki-local'
)
$ErrorActionPreference = 'Stop'

$caSubject = 'CN=Anki Local CA (CardFlow)'
$ca = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $caSubject } | Select-Object -First 1
if (-not $ca) {
  $ca = New-SelfSignedCertificate -Subject $caSubject -KeyAlgorithm RSA -KeyLength 2048 `
    -KeyUsage CertSign, CRLSign, DigitalSignature -KeyExportPolicy Exportable `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(10) `
    -TextExtension @('2.5.29.19={text}CA=true')
  Write-Host "created new CA"
} else { Write-Host "reusing existing CA" }

# SAN 里要写的地址：永远含 localhost / 127.0.0.1 / 局域网 IP，再加上 -ExtraIp 里给的
$sanItems = @('DNS=localhost', "DNS=$Ip", 'IPAddress=127.0.0.1', "IPAddress=$Ip")
foreach ($extra in @($ExtraIp)) {
  if ($extra -and ($sanItems -notcontains "IPAddress=$extra")) { $sanItems += "IPAddress=$extra" }
}
$sanText = $sanItems -join '&'

$leafSubject = "CN=$Ip"
$leaf = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $leafSubject } | Select-Object -First 1
if ($leaf) {
  # 旧叶子还在，但 SAN 缺了这次要补的地址 → 删掉重签。CA 不动，所以手机上的 ca.crt 不用重装。
  $currentSan = ''
  $old = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($leaf)
  foreach ($ext in $old.Extensions) { if ($ext.Oid.Value -eq '2.5.29.17') { $currentSan = $ext.Format($false) } }
  $missing = @($ExtraIp | Where-Object { $_ -and ($currentSan -notmatch [regex]::Escape($_)) })
  if ($missing.Count -gt 0) {
    Write-Host "existing leaf SAN 缺 $($missing -join ', ') -> 删除旧叶子重新签发"
    $oldPath = "Cert:\CurrentUser\My\$($leaf.Thumbprint)"
    Remove-Item -Path $oldPath -Force
    $leaf = $null
  } else { Write-Host "reusing existing leaf" }
}
if (-not $leaf) {
  $leaf = New-SelfSignedCertificate -Subject $leafSubject -KeyAlgorithm RSA -KeyLength 2048 `
    -KeyUsage DigitalSignature, KeyEncipherment -KeyExportPolicy Exportable `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5) -Signer $ca `
    -TextExtension @("2.5.29.17={text}$sanText", '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  Write-Host "created new leaf"
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$secure = ConvertTo-SecureString -String $Pass -Force -AsPlainText
Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $OutDir 'cert.pfx') -Password $secure -Force | Out-Null

$der = $ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$b64 = [Convert]::ToBase64String($der, [System.Base64FormattingOptions]::InsertLineBreaks)
$pem = "-----BEGIN CERTIFICATE-----`r`n$b64`r`n-----END CERTIFICATE-----`r`n"
[System.IO.File]::WriteAllText((Join-Path $OutDir 'ca.crt'), $pem, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "CA   : $($ca.Thumbprint)  $($ca.Subject)"
Write-Host "Leaf : $($leaf.Thumbprint)  $($leaf.Subject)  issuer=$($leaf.Issuer)"
$x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($leaf)
foreach ($ext in $x.Extensions) {
  if ($ext.Oid.Value -eq '2.5.29.17') { Write-Host ("SAN  : " + $ext.Format($false)) }
  if ($ext.Oid.Value -eq '2.5.29.37') { Write-Host ("EKU  : " + $ext.Format($false)) }
  if ($ext.Oid.Value -eq '2.5.29.19') { Write-Host ("BC   : " + $ext.Format($false)) }
}
Write-Host ("Files: " + ((Get-ChildItem $OutDir | ForEach-Object { $_.Name + '(' + $_.Length + ')' }) -join ', '))
