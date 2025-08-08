# Enai Release and Distribution Guide

This document outlines the setup and process for building, signing, notarizing, and distributing Enai.

## Overview

Enai uses GitHub Actions for automated builds and GitHub Releases for distribution. The app includes auto-update functionality that checks for new releases.

## macOS Code Signing & Notarization

### Required Apple Developer Certificates

1. **Developer ID Application Certificate**
   - Used to sign the application binary
   - Required for distribution outside the Mac App Store
   - Created via Apple Developer portal → Certificates → Developer ID Application

2. **Developer ID Installer Certificate**
   - Used to sign the installer package (DMG)
   - Required for distribution outside the Mac App Store
   - Created via Apple Developer portal → Certificates → Developer ID Installer

### GitHub Secrets Configuration

The following secrets must be configured in the GitHub repository settings (Settings → Secrets and variables → Actions):

| Secret Name | Description | How to Obtain |
|------------|-------------|---------------|
| `APPLE_ID` | Your Apple ID email address | Your Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for automation | appleid.apple.com → Security → App-Specific Passwords → Generate |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID | Apple Developer account → Membership → Team ID (e.g., "SNXQ3BDQ5V") |
| `APPLE_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate | Export from Keychain, base64 encode: `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the Application certificate | Password set when exporting from Keychain |
| `APPLE_INSTALLER_CERTIFICATE_P12` | Base64-encoded Developer ID Installer certificate | Export from Keychain, base64 encode: `base64 -i installer.p12` |
| `APPLE_INSTALLER_CERTIFICATE_PASSWORD` | Password for the Installer certificate | Password set when exporting from Keychain |

### Certificate Export Process

1. Install certificates in Keychain Access
2. Right-click certificate → Export
3. Save as .p12 with password
4. Base64 encode: `base64 -i certificate.p12`
5. Add base64 string to GitHub Secrets

### Entitlements

The app requires specific entitlements for macOS (located in `build/entitlements.plist`):
- `com.apple.security.cs.allow-jit` - Required for Electron
- `com.apple.security.cs.allow-unsigned-executable-memory` - Required for Electron
- `com.apple.security.cs.disable-library-validation` - Required for native modules
- `com.apple.security.network.client` - Network access
- `com.apple.security.network.server` - Local server capabilities
- `com.apple.security.files.user-selected.read-write` - File system access

## Auto-Update Configuration

### Update Service Setup

The UpdateService is configured in `electron/bootstrap/serviceBootstrap.ts`:
```javascript
registry.update.configureGitHubUpdates('enai-computer', 'enai', true);
```

- Repository: `enai-computer/enai`
- Release Type: Prereleases enabled for beta testing
- Check Interval: Every 4 hours
- Auto-download: Disabled (user prompted)

### Update Flow

1. App checks GitHub releases every 4 hours
2. If update found, user is notified
3. User can choose to download
4. After download, user prompted to restart and install

## Build Configuration

### Electron Forge Setup (`forge.config.js`)

**Makers (Output Formats):**
- **DMG** (macOS): Primary distribution format with drag-to-Applications installer
- **ZIP** (macOS): Alternative distribution format
- **Squirrel** (Windows): Windows installer (future)
- **DEB/RPM** (Linux): Linux packages (future)

**DMG Configuration:**
```javascript
{
  name: '@electron-forge/maker-dmg',
  platforms: ['darwin'],
  config: {
    format: 'ULFO', // macOS 10.11+ compatible
    name: 'Enai'
  }
}
```

### Icons

- macOS: `public/icons/icon.icns` and full iconset in `public/icons/icon.iconset/`
- Windows: Icon.ico needed (not yet configured)

## Release Process

### Local Testing

1. **Build without signing:**
   ```bash
   npm run build:all
   npm run package:mac
   ```

2. **Build with local signing (requires certificates in Keychain):**
   ```bash
   npm run make:mac
   ```

### GitHub Release (Automated)

1. **Create and push a version tag:**
   ```bash
   git tag v0.1.0-beta.1
   git push origin v0.1.0-beta.1
   ```

2. **GitHub Actions automatically:**
   - Builds for macOS (x64 and arm64)
   - Signs with Developer ID certificates
   - Notarizes with Apple
   - Creates DMG and ZIP
   - Publishes GitHub Release

3. **Release types:**
   - Beta/Alpha tags (e.g., `v0.1.0-beta.1`) → Prerelease
   - Standard tags (e.g., `v1.0.0`) → Full release

### Version Management

Update version in `package.json` before tagging:
```json
{
  "version": "0.1.0"
}
```

## Distribution Channels

### Current Setup
- **GitHub Releases**: Primary distribution
- **Auto-updates**: Via GitHub releases API
- **Direct downloads**: DMG/ZIP from release page

### Future Considerations
- Mac App Store (requires different certificates and sandboxing)
- Windows Store (requires Microsoft developer account)
- Homebrew cask (community maintained)

## Troubleshooting

### Common Issues

1. **"Unidentified Developer" Warning**
   - Ensure certificates are properly configured
   - Check notarization completed successfully
   - Verify with: `spctl -a -v Enai.app`

2. **Auto-update Not Working**
   - Check GitHub releases are published (not draft)
   - Verify repository is public or app has access token
   - Check UpdateService logs

3. **Certificate Issues**
   - Ensure intermediate certificates are installed
   - Verify certificates haven't expired
   - Check Team ID matches certificates

### Verification Commands

```bash
# Check code signature
codesign -dv --verbose=4 Enai.app

# Check notarization
spctl -a -v Enai.app

# List certificates
security find-identity -v -p codesigning
```

## Security Considerations

1. **Never commit secrets** - All sensitive data in GitHub Secrets
2. **Certificate rotation** - Certificates expire every 5 years
3. **Password protection** - Use strong passwords for P12 exports
4. **Environment isolation** - Production secrets separate from development

## Compliance

- **Apple Requirements**: Notarization required for macOS 10.15+
- **Code Signing**: Required for distribution outside Mac App Store
- **Privacy**: App does not access camera, microphone, or location
- **Network**: App requires network access for AI features and updates

## Maintenance

### Annual Requirements
- Apple Developer Program renewal ($99/year)
- Certificate renewal (every 5 years)
- Provisioning profile updates (if using App Store)

### Regular Tasks
- Monitor GitHub Actions for build failures
- Review and merge Dependabot security updates
- Test auto-update flow with each release
- Update this documentation as process evolves

## Support

For release issues:
- Check GitHub Actions logs
- Review Apple Developer portal for certificate status
- Contact Apple Developer support for notarization issues
- File issues at github.com/enai-computer/enai/issues