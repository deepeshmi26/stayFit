import { Menu, globalShortcut } from 'electron'
import log from 'electron-log/main.js'

/**
 * Complete a break - close windows and play sound
 */
export function breakComplete ({ shouldPlaySound, windows, breakType, settings, processWin, closeWindows }) {
  if (settings.get('endBreakShortcut') && globalShortcut.isRegistered(settings.get('endBreakShortcut'))) {
    globalShortcut.unregister(settings.get('endBreakShortcut'))
  }
  if (shouldPlaySound && !settings.get('silentNotifications')) {
    const audio = breakType === 'mini' ? 'miniBreakAudio' : 'longBreakAudio'
    processWin.webContents.send('play-sound', settings.get(audio), settings.get('volume'))
  }
  if (process.platform === 'darwin') {
    // get focus on the last app
    Menu.sendActionToFirstResponder('hide:')
  }
  return closeWindows(windows)
}

/**
 * Enter manual await phase for breaks
 */
export function enterManualAwaitPhase ({ type, shouldPlaySound, microbreakWins, breakWins, settings, processWin }) {
  const isMini = type === 'mini'
  const manualSettingKey = isMini ? 'miniBreakManualFinish' : 'longBreakManualFinish'
  if (!settings.get(manualSettingKey)) return
  if (shouldPlaySound && !settings.get('silentNotifications')) {
    const audioKey = isMini ? 'miniBreakAudio' : 'longBreakAudio'
    processWin.webContents.send('play-sound', settings.get(audioKey), settings.get('volume'))
  }
  const wins = isMini ? microbreakWins : breakWins
  if (wins) {
    wins.forEach(w => {
      if (w && !w.isDestroyed()) {
        w.webContents.send('enter-manual-await', isMini ? 'microbreak' : 'break')
      }
    })
  }
  log.info('Stretchly: entering manual finish phase (' + (isMini ? 'Mini' : 'Long') + ' break)')
}
