// postinstall: on a Mac, name the development Electron.app Kuna (scripts/dev-app.sh).
// Elsewhere there is nothing to do, and Windows has no `sh` to run the script with.
if (process.platform === 'darwin') {
  const { execFileSync } = require('node:child_process')
  execFileSync('sh', [require('node:path').join(__dirname, 'dev-app.sh')], { stdio: 'inherit' })
}
