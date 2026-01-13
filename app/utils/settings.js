/**
 * Settings module - Singleton pattern for application settings
 * All functions dependent on settings should use getSettings() to access the settings object
 */

import log from 'electron-log/main.js'
import Store from 'electron-store'
import defaultSettings from './defaultSettings.js'
import { insideFlatpak, insideWindowsStore, insideSnap } from './utils.js'

// Singleton settings instance
let settingsObject = null

/**
 * Initialize the settings object
 * Creates and configures the electron-store instance with migrations and watchers
 */
export function initializeSettings () {
  if (!settingsObject) {
    settingsObject = new Store({
      defaults: defaultSettings,
      beforeEachMigration: (store, context) => {
        log.info(`Stretchly: migrating preferences from Stretchly v${context.fromVersion} to v${context.toVersion}`)
      },
      migrations: {
        '1.13.0': store => {
          if (store.has('pauseBreaksShortcut')) {
            store.set('pauseBreaksToggleShortcut', store.get('pauseBreaksShortcut'))
            log.info(`Stretchly: settings pauseBreaksToggleShortcut to "${store.get('pauseBreaksShortcut')}"`)
            store.delete('pauseBreaksShortcut')
            log.info('Stretchly: removing pauseBreaksShortcut')
          } else {
            log.info('Stretchly: not migrating pauseBreaksShortcut')
          }
          if (store.has('pauseBreaksShortcut')) {
            store.delete('resumeBreaksShortcut')
            log.info('Stretchly: removing resumeBreaksShortcut')
          }
        },
        '1.17.0': store => {
          if (store.has('showBreakActionsInStrictMode')) {
            store.set('showTrayMenuInStrictMode', store.get('showBreakActionsInStrictMode'))
            log.info(`Stretchly: settings showTrayMenuInStrictMode to "${store.get('showBreakActionsInStrictMode')}"`)
            store.delete('showBreakActionsInStrictMode')
            log.info('Stretchly: removing showBreakActionsInStrictMode')
          } else {
            log.info('Stretchly: not migrating showTrayMenuInStrictMode')
          }
        },
        '1.18.2': store => {
          if (insideFlatpak() || insideWindowsStore() || insideSnap()) {
            if (!store.get('disableAppUpdateFeatures')) {
              store.set('disableAppUpdateFeatures', true)
              log.info('Stretchly: setting disableAppUpdateFeatures to true because we are in Flatpak/Windows Store/Snap build')
            }
          }
        },
        '1.19.0': store => {
          if (store.has('audio')) {
            const legacyAudio = store.get('audio')
            store.set('longBreakAudio', legacyAudio)
            log.info(`Stretchly: migrating audio to longBreakAudio with value "${legacyAudio}"`)
            store.delete('audio')
            log.info('Stretchly: removing audio')
          } else {
            log.info('Stretchly: not migrating audio to longBreakAudio')
          }
          if (store.has('microbreakStartSoundPlaying')) {
            const val = store.get('microbreakStartSoundPlaying') ? store.get('miniBreakAudio') : 'silence'
            store.set('miniBreakStartSound', val)
            log.info(`Stretchly: migrating microbreakStartSoundPlaying to miniBreakStartSound with value "${val}"`)
            store.delete('microbreakStartSoundPlaying')
            log.info('Stretchly: removing microbreakStartSoundPlaying')
          } else {
            log.info('Stretchly: not migrating microbreakStartSoundPlaying')
          }
          if (store.has('breakStartSoundPlaying')) {
            const val = store.get('breakStartSoundPlaying') ? store.get('longBreakAudio') : 'silence'
            store.set('longBreakStartSound', val)
            log.info(`Stretchly: migrating breakStartSoundPlaying to longBreakStartSound with value "${val}"`)
            store.delete('breakStartSoundPlaying')
            log.info('Stretchly: removing breakStartSoundPlaying')
          } else {
            log.info('Stretchly: not migrating breakStartSoundPlaying')
          }
        },
        '1.20.0': store => {
          if (store.has('timeToBreakInTray')) {
            if (store.get('timeToBreakInTray')) {
              store.set('trayIconStyle', 'time')
              log.info('Stretchly: migrating timeToBreakInTray to trayIconStyle="time"')
            } else {
              store.set('trayIconStyle', 'default')
              log.info('Stretchly: migrating tray settings to trayIconStyle="default"')
            }
            store.delete('timeToBreakInTray')
          }
        }
      },
      watch: true
    })
    log.info('Stretchly: loading preferences')
    Store.initRenderer()
    Object.entries(settingsObject.store).forEach(([key, _]) => {
      settingsObject.onDidChange(key, (newValue, oldValue) => {
        log.info(`Stretchly: setting '${key}' to '${JSON.stringify(newValue)}' (was '${JSON.stringify(oldValue)}')`)
      })
    })
  }
}

/**
 * Get the settings object (singleton instance)
 * @returns {Store} The settings object
 * @throws {Error} If settings have not been initialized
 */
export function getSettings () {
  if (!settingsObject) {
    throw new Error('Settings have not been initialized. Call initializeSettings() first.')
  }
  return settingsObject
}
