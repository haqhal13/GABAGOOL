#!/usr/bin/env node

/**
 * Universal launcher for the Polymarket Copy Trading Bot.
 * Works on macOS, Linux, and Windows (with Node + npm installed).
 */

const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = __dirname;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    console.error(`Failed to run "${command}": ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Ensure npm is available
const npmCheck = spawnSync('npm', ['-v'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (npmCheck.error || npmCheck.status !== 0) {
  console.error('npm is required but was not found on your PATH.');
  process.exit(1);
}

console.log('🚀 Starting Polymarket Copy Trading Bot...');
console.log();

// Install dependencies if needed
if (!existsSync(path.join(projectRoot, 'node_modules'))) {
  console.log('📦 Installing dependencies...');
  run('npm', ['install']);
  console.log();
}

// Start the bot
run('npm', ['run', 'dev']);

