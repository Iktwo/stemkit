const path = require('path')
const { execFileSync } = require('child_process')
const fs = require('fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // If a real Developer ID certificate is provided, let electron-builder handle signing
  if (process.env.CSC_NAME || process.env.CSC_LINK) {
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[afterPack] Ad-hoc signing bundle: ${appPath}`)

  // Sign any nested Mach-O executables inside Contents/Resources (such as ffmpeg)
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  if (fs.existsSync(resourcesDir)) {
    function signExecutables(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          signExecutables(full)
        } else if (entry.isFile()) {
          try {
            const buf = Buffer.alloc(4)
            const fd = fs.openSync(full, 'r')
            fs.readSync(fd, buf, 0, 4, 0)
            fs.closeSync(fd)
            const magic = buf.readUInt32BE(0)
            // Mach-O magic numbers: 32-bit/64-bit, big/little endian, and universal fat binaries
            if (
              magic === 0xfeedface ||
              magic === 0xfeedfacf ||
              magic === 0xcefaedfe ||
              magic === 0xcffaedfe ||
              magic === 0xcafebabe ||
              magic === 0xbebafeca
            ) {
              console.log(`[afterPack] Ad-hoc signing nested binary: ${path.relative(appPath, full)}`)
              execFileSync('codesign', ['--force', '--sign', '-', full])
            }
          } catch {}
        }
      }
    }
    signExecutables(resourcesDir)
  }

  // Deep-sign the entire app bundle with an ad-hoc signature so Info.plist and resources are sealed
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath])
  console.log('[afterPack] Ad-hoc signing completed successfully')
}
