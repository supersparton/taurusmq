// scripts/dev.js
// Unified development stack runner for TaurusMQ.
// Starts test-complex.js (API) and next dev (Dashboard UI) concurrently.
// Automatically runs first-time npm installs if dependencies are missing.

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const dashboardDir = path.join(rootDir, 'dashboard');

console.log('\n\x1b[35m🐂 TaurusMQ Developer Bootstrapper\x1b[0m');
console.log('====================================');

// 1. Verify and install dashboard dependencies if needed
const hasNodeModules = fs.existsSync(path.join(dashboardDir, 'node_modules'));
if (!hasNodeModules) {
  console.log('📦 \x1b[33mFirst-time setup detected: Installing dashboard dependencies...\x1b[0m');
  try {
    execSync('npm install', { cwd: dashboardDir, stdio: 'inherit' });
    console.log('✅ \x1b[32mDependencies installed successfully!\x1b[0m\n');
  } catch (err) {
    console.error('❌ Failed to install dashboard dependencies:', err.message);
    process.exit(1);
  }
}

// 2. Start processes concurrently
console.log('🚀 \x1b[36mStarting local development stack...\x1b[0m\n');

// Spawn backend API & worker/scheduler simulator
const apiProcess = spawn('node', ['tests/test-complex.js'], {
  cwd: rootDir,
  shell: true,
  env: { ...process.env, FORCE_COLOR: 'true' }
});

// Spawn frontend Next.js Dashboard UI
const dashboardProcess = spawn('npm', ['run', 'dev'], {
  cwd: dashboardDir,
  shell: true,
  env: { ...process.env, FORCE_COLOR: 'true' }
});

// 3. Format and forward output streams
function logStream(name, stream, colorCode) {
  stream.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const cleanLine = line.replace(/[\r\n]+/g, '');
      if (cleanLine.trim()) {
        console.log(`\x1b[${colorCode}m[${name}]\x1b[0m ${cleanLine}`);
      }
    }
  });
}

logStream('API', apiProcess.stdout, '32');      // Green
logStream('API-ERR', apiProcess.stderr, '31');  // Red
logStream('UI', dashboardProcess.stdout, '36');  // Cyan
logStream('UI-ERR', dashboardProcess.stderr, '31');  // Red

// 4. Handle clean process exit
let cleaningUp = false;
const cleanup = () => {
  if (cleaningUp) return;
  cleaningUp = true;
  console.log('\n\n🧹 \x1b[33mStopping TaurusMQ processes...\x1b[0m');
  
  try {
    apiProcess.kill('SIGINT');
  } catch (_) {}
  
  try {
    dashboardProcess.kill('SIGINT');
  } catch (_) {}
  
  setTimeout(() => {
    process.exit(0);
  }, 500);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

apiProcess.on('exit', (code) => {
  console.log(`\x1b[31m[System] API process exited with code ${code}\x1b[0m`);
  cleanup();
});

dashboardProcess.on('exit', (code) => {
  console.log(`\x1b[31m[System] UI process exited with code ${code}\x1b[0m`);
  cleanup();
});
