#!/usr/bin/env node

/**
 * Package Validation Script
 * Validates that the Electron app is properly packaged before distribution
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

let errors = 0;
let warnings = 0;

function log(message, type = 'info') {
  const prefix = {
    error: `${colors.red}❌`,
    success: `${colors.green}✅`,
    warning: `${colors.yellow}⚠️`,
    info: `${colors.blue}ℹ️`
  }[type] || '';
  
  console.log(`${prefix} ${message}${colors.reset}`);
  
  if (type === 'error') errors++;
  if (type === 'warning') warnings++;
}

function checkFile(filePath, description) {
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    log(`${description} found (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, 'success');
    return true;
  } else {
    log(`${description} missing at: ${filePath}`, 'error');
    return false;
  }
}

function checkDirectory(dirPath, description) {
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    const itemCount = fs.readdirSync(dirPath).length;
    log(`${description} found (${itemCount} items)`, 'success');
    return true;
  } else {
    log(`${description} missing at: ${dirPath}`, 'error');
    return false;
  }
}

function validateMacPackage() {
  console.log('\n=== Validating macOS Package ===\n');
  
  const appPath = 'out/Enai-darwin-arm64/Enai.app';
  
  if (!fs.existsSync(appPath)) {
    log('macOS app bundle not found. Run "npm run package:mac" first.', 'error');
    return false;
  }
  
  // Check app bundle structure
  checkDirectory(`${appPath}/Contents`, 'Contents directory');
  checkDirectory(`${appPath}/Contents/MacOS`, 'MacOS directory');
  checkDirectory(`${appPath}/Contents/Resources`, 'Resources directory');
  checkDirectory(`${appPath}/Contents/Frameworks`, 'Frameworks directory');
  
  // Check main executable
  checkFile(`${appPath}/Contents/MacOS/Enai`, 'Main executable');
  
  // Check Info.plist
  if (checkFile(`${appPath}/Contents/Info.plist`, 'Info.plist')) {
    try {
      const plistContent = fs.readFileSync(`${appPath}/Contents/Info.plist`, 'utf8');
      if (plistContent.includes('com.enaicorp.enai')) {
        log('Bundle ID verified: com.enaicorp.enai', 'success');
      } else {
        log('Bundle ID not found in Info.plist', 'warning');
      }
    } catch (err) {
      log('Could not read Info.plist', 'warning');
    }
  }
  
  // Check ASAR archive
  const asarPath = `${appPath}/Contents/Resources/app.asar`;
  if (checkFile(asarPath, 'app.asar')) {
    // Check unpacked directory for native modules
    const unpackedPath = `${appPath}/Contents/Resources/app.asar.unpacked`;
    if (checkDirectory(unpackedPath, 'app.asar.unpacked')) {
      // Check critical native modules
      const nativeModules = [
        'node_modules/better-sqlite3',
        'node_modules/@lancedb',
        'node_modules/apache-arrow',
        'electron_modules'
      ];
      
      console.log('\nChecking native modules:');
      nativeModules.forEach(module => {
        const modulePath = `${unpackedPath}/${module}`;
        if (fs.existsSync(modulePath)) {
          log(`${module} unpacked correctly`, 'success');
        } else {
          log(`${module} not found in unpacked directory`, 'warning');
        }
      });
    }
    
    // Verify ASAR contents using asar tool
    try {
      console.log('\nVerifying ASAR contents:');
      const asarList = execSync(`npx asar list "${asarPath}"`, { encoding: 'utf8' });
      
      // Check for critical files in ASAR
      const criticalFiles = [
        '/package.json',
        '/dist/electron/main.js',
        '/dist/electron/preload.js',
        '/out/index.html'
      ];
      
      criticalFiles.forEach(file => {
        if (asarList.includes(file)) {
          log(`${file} found in ASAR`, 'success');
        } else {
          log(`${file} missing from ASAR`, 'error');
        }
      });
    } catch (err) {
      log('Could not list ASAR contents (asar tool may not be installed)', 'warning');
    }
  }
  
  // Check for Next.js output
  const outPath = `${appPath}/Contents/Resources/out`;
  const outUnpackedPath = `${appPath}/Contents/Resources/app.asar.unpacked/out`;
  
  if (fs.existsSync(outPath) || fs.existsSync(outUnpackedPath)) {
    log('Next.js output found', 'success');
  } else {
    log('Next.js output not found - app may not render properly', 'error');
  }
  
  // Check Electron Framework
  const electronFramework = `${appPath}/Contents/Frameworks/Electron Framework.framework`;
  checkDirectory(electronFramework, 'Electron Framework');
  
  // Check code signing (macOS only)
  if (process.platform === 'darwin') {
    console.log('\nChecking code signing:');
    try {
      const codesignOutput = execSync(`codesign -dv "${appPath}" 2>&1`, { encoding: 'utf8' });
      if (codesignOutput.includes('Signature')) {
        log('App is code signed', 'success');
      } else {
        log('App is not signed (will trigger Gatekeeper warnings)', 'warning');
      }
    } catch (err) {
      log('Could not verify code signing', 'warning');
    }
  }
  
  return errors === 0;
}

function validateWindowsPackage() {
  console.log('\n=== Validating Windows Package ===\n');
  
  const winPath = 'out/Enai-win32-x64';
  
  if (!fs.existsSync(winPath)) {
    log('Windows package not found. Run "npm run package:win" first.', 'error');
    return false;
  }
  
  // Check main executable
  checkFile(`${winPath}/Enai.exe`, 'Main executable');
  
  // Check resources
  checkDirectory(`${winPath}/resources`, 'Resources directory');
  checkFile(`${winPath}/resources/app.asar`, 'app.asar');
  
  // Check native modules
  const unpackedPath = `${winPath}/resources/app.asar.unpacked`;
  if (checkDirectory(unpackedPath, 'app.asar.unpacked')) {
    const nativeModules = [
      'node_modules/better-sqlite3',
      'node_modules/@lancedb',
      'electron_modules'
    ];
    
    console.log('\nChecking native modules:');
    nativeModules.forEach(module => {
      const modulePath = `${unpackedPath}/${module}`;
      if (fs.existsSync(modulePath)) {
        log(`${module} unpacked correctly`, 'success');
      } else {
        log(`${module} not found`, 'warning');
      }
    });
  }
  
  return errors === 0;
}

function validateBuildPrerequisites() {
  console.log('\n=== Checking Build Prerequisites ===\n');
  
  // Check if Next.js is built
  if (checkDirectory('out', 'Next.js build output')) {
    checkFile('out/index.html', 'Next.js index.html');
  } else {
    log('Run "npm run build:nextjs" before packaging', 'error');
  }
  
  // Check if Electron is built
  if (checkDirectory('dist', 'Electron build output')) {
    checkFile('dist/electron/main.js', 'Electron main process');
    checkFile('dist/electron/preload.js', 'Electron preload script');
  } else {
    log('Run "npm run electron:build" before packaging', 'error');
  }
  
  // Check for electron_modules
  if (checkDirectory('electron_modules', 'Rebuilt native modules')) {
    checkFile('electron_modules/better-sqlite3/lib/binding/napi-v6-darwin-unknown-arm64/node_sqlite3.node', 
              'better-sqlite3 native binding (ARM64)');
  } else {
    log('Run "npm run rebuild:electron" to rebuild native modules', 'warning');
  }
  
  // Check environment file
  if (fs.existsSync('.env')) {
    log('.env file found (will be included in package)', 'success');
    
    // Check for critical environment variables
    const envContent = fs.readFileSync('.env', 'utf8');
    if (!envContent.includes('OPENAI_API_KEY')) {
      log('OPENAI_API_KEY not found in .env - AI features will not work', 'warning');
    }
  } else {
    log('.env file not found - app will need manual configuration', 'warning');
  }
  
  return errors === 0;
}

// Main execution
console.log('====================================');
console.log('  Enai Package Validation Script');
console.log('====================================');

// Determine which platform to validate
const args = process.argv.slice(2);
const platform = args[0] || process.platform;

validateBuildPrerequisites();

switch (platform) {
  case 'darwin':
  case 'mac':
    validateMacPackage();
    break;
  case 'win32':
  case 'win':
    validateWindowsPackage();
    break;
  default:
    log(`Unsupported platform: ${platform}`, 'error');
}

// Summary
console.log('\n====================================');
console.log('  Validation Summary');
console.log('====================================\n');

if (errors === 0 && warnings === 0) {
  log('Package validation passed! ✨', 'success');
  console.log('\nYour app is ready for distribution.');
} else {
  if (errors > 0) {
    log(`Found ${errors} error(s)`, 'error');
  }
  if (warnings > 0) {
    log(`Found ${warnings} warning(s)`, 'warning');
  }
  
  console.log('\nPlease fix the issues above before distributing.');
  
  if (errors > 0) {
    process.exit(1);
  }
}

console.log('\nNext steps:');
console.log('1. Run "npm run make:mac" to create DMG');
console.log('2. Run "./scripts/debug-dmg.sh" to validate DMG');
console.log('3. Test installation on a clean Mac');
console.log('4. Consider code signing and notarization for distribution');