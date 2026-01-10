import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

/**
 * Close all windows in an array
 */
export function closeWindows (windowArray) {
  for (const window of windowArray) {
    if (!window || window.isDestroyed()) {
      continue
    }

    window.hide()
    if (windowArray[0] === window) {
      ipcMain.removeHandler('send-long-break-data')
      ipcMain.removeHandler('send-mini-break-data')
    }

    // Use destroy() for immediate, guaranteed cleanup on all platforms
    window.destroy()
  }
  return null
}

/**
 * Create process window
 */
export function createProcessWindow ({ __dirname, planVersionCheck }) {
  const modalPath = 'file://' + join(__dirname, '/process.html')

  const processWin = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    backgroundThrottling: false,
    webPreferences: {
      preload: join(__dirname, './process-preload.mjs'),
      sandbox: false
    }
  })
  processWin.webContents.loadURL(modalPath)
  processWin.webContents.once('ready-to-show', () => {
    planVersionCheck()
  })
  return processWin
}

/**
 * Create welcome window
 */
export function createWelcomeWindow ({ __dirname, settings, displayManager, windowIconPath, isAppStart = true }) {
  if (!settings.get('isFirstRun') || !isAppStart) {
    return null
  }

  const modalPath = 'file://' + join(__dirname, '/welcome.html')
  const welcomeWin = new BrowserWindow({
    x: displayManager.getDisplayX(-1, 1000),
    y: displayManager.getDisplayY(-1, 750),
    width: 1000,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath(),
    backgroundColor: 'EDEDED',
    webPreferences: {
      preload: join(__dirname, './welcome-preload.mjs'),
      sandbox: false
    }
  })
  welcomeWin.webContents.loadURL(modalPath)
  welcomeWin.once('ready-to-show', () => {
    welcomeWin.center()
    welcomeWin.show()
  })
  return welcomeWin
}

/**
 * Create contributor settings window
 */
export function createContributorSettingsWindow ({ __dirname, displayManager, windowIconPath }) {
  const modalPath = 'file://' + join(__dirname, '/contributor-preferences.html')
  const contributorPreferencesWin = new BrowserWindow({
    x: displayManager.getDisplayX(-1, 735),
    y: displayManager.getDisplayY(),
    width: 735,
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath(),
    backgroundColor: 'EDEDED',
    webPreferences: {
      preload: join(__dirname, './contributor-preferences-preload.mjs'),
      sandbox: false
    }
  })
  contributorPreferencesWin.webContents.loadURL(modalPath)
  contributorPreferencesWin.once('ready-to-show', () => {
    contributorPreferencesWin.center()
    contributorPreferencesWin.show()
  })
  return contributorPreferencesWin
}

/**
 * Create sync preferences window
 */
export function createSyncPreferencesWindow ({ __dirname, displayManager, windowIconPath }) {
  const syncPreferencesUrl = 'https://my.stretchly.net/app/v1/sync'
  const syncPreferencesWin = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    width: 1000,
    height: 700,
    icon: windowIconPath(),
    x: displayManager.getDisplayX(),
    y: displayManager.getDisplayY(),
    backgroundColor: 'whitesmoke',
    webPreferences: {
      preload: join(__dirname, './electron-bridge.mjs'),
      sandbox: false
    }
  })
  syncPreferencesWin.webContents.loadURL(syncPreferencesUrl)

  syncPreferencesWin.once('ready-to-show', () => {
    syncPreferencesWin.center()
    syncPreferencesWin.show()
  })
  return syncPreferencesWin
}

/**
 * Create preferences window
 */
export function createPreferencesWindow ({ __dirname, displayManager, windowIconPath, screen }) {
  const modalPath = 'file://' + join(__dirname, '/preferences.html')
  const maxHeight = screen
    .getDisplayNearestPoint(screen.getCursorScreenPoint())
    .workAreaSize.height * 0.9
  const preferencesWin = new BrowserWindow({
    autoHideMenuBar: true,
    show: false,
    backgroundThrottling: false,
    icon: windowIconPath(),
    width: 600,
    height: 530,
    maxHeight: Math.round(maxHeight),
    x: displayManager.getDisplayX(-1, 600),
    y: displayManager.getDisplayY(-1, 530),
    backgroundColor: '#EDEDED',
    webPreferences: {
      preload: join(__dirname, './preferences-preload.mjs'),
      sandbox: false
    }
  })
  preferencesWin.webContents.loadURL(modalPath)
  preferencesWin.once('ready-to-show', () => {
    preferencesWin.center()
    preferencesWin.show()
  })
  return preferencesWin
}

/**
 * Create myStretchly window
 */
export function createMyStretchlyWindow ({ __dirname, displayManager, windowIconPath, provider }) {
  const myStretchlyUrl = `https://my.stretchly.net/app/v1?provider=${provider}`
  const myStretchlyWin = new BrowserWindow({
    autoHideMenuBar: true,
    show: false,
    width: 1000,
    height: 700,
    icon: windowIconPath(),
    x: displayManager.getDisplayX(),
    y: displayManager.getDisplayY(),
    backgroundColor: 'whitesmoke',
    webPreferences: {
      preload: join(__dirname, './electron-bridge.mjs'),
      sandbox: false
    }
  })
  myStretchlyWin.webContents.loadURL(myStretchlyUrl)

  myStretchlyWin.once('ready-to-show', () => {
    myStretchlyWin.center()
    myStretchlyWin.show()
  })
  return myStretchlyWin
}

/**
 * Get blurred background window options
 */
export function getBlurredBackgroundWindowOptions (settings) {
  if (!settings.get('blurredBackground')) {
    return {}
  }

  switch (process.platform) {
    case 'darwin':
      return {
        vibrancy: 'hud',
        visualEffectState: 'active'
      }
    default:
      return {}
  }
}

/**
 * Calculate background color with opacity
 */
export function calculateBackgroundColor (color, settings) {
  let opacityMultiplier = 1
  if (settings.get('transparentMode')) {
    opacityMultiplier = settings.get('opacity')
  }
  return color + Math.round(opacityMultiplier * 255).toString(16).padStart(2, '0')
}
