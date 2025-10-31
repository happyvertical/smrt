#!/usr/bin/env node

/**
 * Synchronizes all package versions with the root package version
 * Run this after semantic-release updates the root version
 *
 * Scans packages/* for all packages
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Read the root package.json to get the new version from semantic-release
const rootPkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const newVersion = rootPkg.version

console.log(`Synchronizing all packages to version ${newVersion}...`)

// Track how many packages we actually update
let updated = 0

/**
 * Update package version at the given path
 */
function updatePackage(pkgJsonPath, pkgName) {
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

    // Only update if the version is different
    if (pkgJson.version !== newVersion) {
      console.log(`  ${pkgName}: ${pkgJson.version} → ${newVersion}`)
      pkgJson.version = newVersion
      // Write with proper formatting (2 spaces, trailing newline)
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
      updated++
    } else {
      console.log(`  ${pkgName}: already at ${newVersion}`)
    }
  } catch (err) {
    // Skip packages that don't have a package.json
    console.warn(`  ${pkgName}: skipped (${err.message})`)
  }
}

/**
 * Scan packages directory
 */
function scanDirectory(baseDir) {
  const fullPath = baseDir

  if (!existsSync(fullPath)) {
    console.warn(`Directory ${fullPath} does not exist, skipping`)
    return
  }

  console.log(`\nScanning ${fullPath}...`)
  const items = readdirSync(fullPath)

  for (const item of items) {
    const itemPath = join(fullPath, item)
    const pkgJsonPath = join(itemPath, 'package.json')

    // Only process if it's a directory with package.json
    if (existsSync(itemPath) && statSync(itemPath).isDirectory() && existsSync(pkgJsonPath)) {
      updatePackage(pkgJsonPath, item)
    }
  }
}

// Scan all packages
scanDirectory('packages')

console.log(`\nSynchronized ${updated} package(s)`)
