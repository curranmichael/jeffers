#!/bin/bash

# DMG Debugging Script for Enai
# This script helps debug DMG packaging issues before installing on another computer

set -e

echo "================================================"
echo "Enai DMG Packaging Debug Script"
echo "================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if DMG exists
DMG_PATH="out/make/Enai.dmg"
if [ ! -f "$DMG_PATH" ]; then
    echo -e "${RED}❌ DMG not found at $DMG_PATH${NC}"
    echo "Please run 'npm run make:mac' first"
    exit 1
fi

echo -e "${GREEN}✅ DMG found at: $DMG_PATH${NC}"
echo "Size: $(du -h "$DMG_PATH" | cut -f1)"
echo ""

# Mount the DMG
echo "Mounting DMG for inspection..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" | grep Volumes | awk '{print $3}')
echo -e "${GREEN}✅ DMG mounted at: $MOUNT_POINT${NC}"
echo ""

# Check app bundle structure
APP_PATH="$MOUNT_POINT/Enai.app"
if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}❌ App bundle not found in DMG${NC}"
    hdiutil detach "$MOUNT_POINT"
    exit 1
fi

echo "Checking app bundle structure..."
echo "================================"

# Check for required directories
REQUIRED_DIRS=(
    "Contents"
    "Contents/MacOS"
    "Contents/Resources"
    "Contents/Frameworks"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ -d "$APP_PATH/$dir" ]; then
        echo -e "${GREEN}✅ $dir exists${NC}"
    else
        echo -e "${RED}❌ $dir missing${NC}"
    fi
done

echo ""

# Check for main executable
if [ -f "$APP_PATH/Contents/MacOS/Enai" ]; then
    echo -e "${GREEN}✅ Main executable found${NC}"
    echo "   Size: $(du -h "$APP_PATH/Contents/MacOS/Enai" | cut -f1)"
else
    echo -e "${RED}❌ Main executable missing${NC}"
fi

# Check for Info.plist
if [ -f "$APP_PATH/Contents/Info.plist" ]; then
    echo -e "${GREEN}✅ Info.plist found${NC}"
    # Extract key information
    echo "   Bundle ID: $(defaults read "$APP_PATH/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo 'Unknown')"
    echo "   Version: $(defaults read "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo 'Unknown')"
else
    echo -e "${RED}❌ Info.plist missing${NC}"
fi

echo ""

# Check for app.asar
if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
    echo -e "${GREEN}✅ app.asar found${NC}"
    echo "   Size: $(du -h "$APP_PATH/Contents/Resources/app.asar" | cut -f1)"
    
    # Check for unpacked native modules
    if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked" ]; then
        echo -e "${GREEN}✅ app.asar.unpacked directory exists${NC}"
        
        # Check for critical native modules
        echo ""
        echo "Checking native modules..."
        echo "=========================="
        
        NATIVE_MODULES=(
            "node_modules/better-sqlite3"
            "node_modules/@lancedb"
            "node_modules/apache-arrow"
            "electron_modules"
        )
        
        for module in "${NATIVE_MODULES[@]}"; do
            if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/$module" ]; then
                echo -e "${GREEN}✅ $module unpacked${NC}"
            else
                echo -e "${YELLOW}⚠️  $module not found in unpacked${NC}"
            fi
        done
    else
        echo -e "${RED}❌ app.asar.unpacked directory missing - native modules won't work!${NC}"
    fi
else
    echo -e "${RED}❌ app.asar missing${NC}"
fi

echo ""

# Check for Next.js output
if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/out" ] || [ -d "$APP_PATH/Contents/Resources/out" ]; then
    echo -e "${GREEN}✅ Next.js output found${NC}"
else
    # Check inside asar
    echo "Checking for Next.js output in asar..."
    npx asar list "$APP_PATH/Contents/Resources/app.asar" | grep -q "^/out" && \
        echo -e "${GREEN}✅ Next.js output found in asar${NC}" || \
        echo -e "${RED}❌ Next.js output missing${NC}"
fi

echo ""

# Check for code signing (macOS only)
echo "Checking code signing..."
echo "========================"
codesign -dv "$APP_PATH" 2>&1 | grep -q "Signature" && \
    echo -e "${GREEN}✅ App is signed${NC}" || \
    echo -e "${YELLOW}⚠️  App is not signed (will trigger Gatekeeper on other Macs)${NC}"

# Check for notarization
spctl -a -v "$APP_PATH" 2>&1 | grep -q "accepted" && \
    echo -e "${GREEN}✅ App is notarized${NC}" || \
    echo -e "${YELLOW}⚠️  App is not notarized (users will need to bypass Gatekeeper)${NC}"

echo ""

# Check architecture
echo "Checking architecture..."
echo "======================="
file "$APP_PATH/Contents/MacOS/Enai" | grep -q "universal" && \
    echo -e "${GREEN}✅ Universal binary (Intel + Apple Silicon)${NC}" || \
    echo -e "${YELLOW}⚠️  Single architecture binary${NC}"

file "$APP_PATH/Contents/MacOS/Enai"

echo ""

# Check for .env file (warning if missing)
if [ -f "$APP_PATH/Contents/Resources/.env" ] || [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/.env" ]; then
    echo -e "${GREEN}✅ .env file included${NC}"
else
    echo -e "${YELLOW}⚠️  No .env file found - app will need environment variables configured${NC}"
fi

echo ""

# List Electron and Chromium frameworks
echo "Checking Electron framework..."
echo "=============================="
if [ -d "$APP_PATH/Contents/Frameworks/Electron Framework.framework" ]; then
    echo -e "${GREEN}✅ Electron Framework found${NC}"
    # Get Electron version from version file if available
    VERSION_FILE="$APP_PATH/Contents/Frameworks/Electron Framework.framework/Versions/Current/Resources/electron_version"
    if [ -f "$VERSION_FILE" ]; then
        echo "   Electron version: $(cat "$VERSION_FILE")"
    fi
else
    echo -e "${RED}❌ Electron Framework missing${NC}"
fi

echo ""

# Unmount DMG
echo "Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" > /dev/null 2>&1
echo -e "${GREEN}✅ DMG unmounted${NC}"

echo ""
echo "================================================"
echo "Debug Summary"
echo "================================================"

# Generate installation readiness report
echo ""
echo "Installation Readiness:"
echo "----------------------"
echo "• DMG file is valid and mountable"
echo "• To test on another Mac:"
echo "  1. Copy $DMG_PATH to the target Mac"
echo "  2. Double-click to mount"
echo "  3. Drag Enai.app to Applications"
echo "  4. If unsigned, right-click and select 'Open' to bypass Gatekeeper"
echo ""
echo "Known Issues to Check:"
echo "---------------------"
echo "• If app won't open: Check code signing and notarization"
echo "• If database errors: Ensure better-sqlite3 is properly unpacked"
echo "• If AI features fail: Check if .env with OPENAI_API_KEY is included"
echo "• If web features fail: Check network permissions in System Preferences"
echo ""
echo "To generate a full ASAR content list:"
echo "  npx asar list \"$APP_PATH/Contents/Resources/app.asar\" > asar-contents.txt"
echo ""
echo "Done!"