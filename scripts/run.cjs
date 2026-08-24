#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function readRequiredMajor() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()
    const major = parseInt(txt.split('.')[0], 10)
    if (!Number.isNaN(major)) return major
  } catch {}
  return 18
}

function cleanVersion(version) {
  return String(version).replace(/^v/, '')
}

function majorOf(version) {
  return parseInt(cleanVersion(version).split('.')[0], 10)
}

function cmpSemver(a, b) {
  const pa = cleanVersion(a).split('.').map(Number)
  const pb = cleanVersion(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

function findNvmNode(requiredMajor) {
  const rootDir = path.join(process.env.HOME || '', '.nvm', 'versions', 'node')
  let best = null
  try {
    for (const ver of fs.readdirSync(rootDir)) {
      if (majorOf(ver) < requiredMajor) continue
      const nodeBin = path.join(rootDir, ver, 'bin', 'node')
      if (!fs.existsSync(nodeBin)) continue
      if (!best || cmpSemver(ver, best.version) > 0) best = { version: ver, nodeBin }
    }
  } catch {}
  return best
}

const STEPS = {
  dev: [['electron-vite', 'dev']],
  build: [['electron-vite', 'build']],
  typecheck: [
    ['tsc', '--noEmit', '-p', 'tsconfig.node.json'],
    ['tsc', '--noEmit', '-p', 'tsconfig.web.json']
  ],
  'typecheck:node': [['tsc', '--noEmit', '-p', 'tsconfig.node.json']],
  'typecheck:web': [['tsc', '--noEmit', '-p', 'tsconfig.web.json']],
  dist: [['electron-vite', 'build'], ['electron-builder', '--mac']]
}

function resolveBin(name) {
  const local = path.join(ROOT, 'node_modules', '.bin', name)
  if (fs.existsSync(local)) return local
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  console.error(`Cannot find ${name} — run npm install first`)
  process.exit(1)
}

function runSteps(steps) {
  for (const [bin, ...args] of steps) {
    const r = spawnSync(resolveBin(bin), args, { stdio: 'inherit' })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
}

function main() {
  const cmd = process.argv[2]
  const steps = STEPS[cmd]
  if (!steps) {
    console.error(`Unknown command: ${cmd}. Available: ${Object.keys(STEPS).join(', ')}`)
    process.exit(1)
  }

  const required = readRequiredMajor()
  if (majorOf(process.versions.node) < required) {
    const found = findNvmNode(required)
    if (!found) {
      console.error(
        `StemKit needs Node ${required}+ but you have ${process.versions.node}, and no matching nvm install was found.\nInstall one with: nvm install ${required}`
      )
      process.exit(1)
    }
    console.log(
      `> StemKit needs Node ${required}+ (active: ${process.versions.node}) — using nvm ${found.version}`
    )
    const r = spawnSync(found.nodeBin, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit'
    })
    process.exit(r.status ?? 1)
  }

  runSteps(steps)
}

main()
