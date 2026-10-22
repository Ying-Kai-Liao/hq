/** Installed identities. The host's half (data folder, port, service names) mirrors serve/host/src/environment.rs. */
export function environmentProfile(environment: 'main' | 'dev') {
  const dev = environment === 'dev'
  return {
    environment,
    name: dev ? 'Kith Dev' : 'Codync',
    appId: dev ? 'com.yingkailiao.kith.dev' : 'com.pokai.Codync',
    scheme: dev ? 'kith-dev' : 'kith',
    /** The scheme links used before the rename: still opened, never produced. */
    legacyScheme: dev ? 'codync-dev' : 'codync',
    dataFolder: dev ? '.kith/serve' : '.kith/serve-main',
    port: dev ? 19224 : 19225,
    hostLabel: dev ? 'dev.kith.serve' : 'dev.kith.serve.main',
    systemdUnit: dev ? 'kith-serve.service' : 'kith-serve-main.service',
    windowsService: dev ? 'KithServe' : 'KithServeMain',
    supervisor: dev ? 'kith-servew.exe' : 'kith-servew-main.exe',
    screenLabel: dev ? 'com.yingkailiao.kith.dev.screen' : 'com.pokai.Codync.screen',
    screenName: dev ? 'CodyncDevScreen' : 'CodyncScreen',
    releaseUpdates: !dev,
  }
}

/** Refuse to manage a different environment's daemon, including pre-isolation dev hosts. */
export function hostEnvironmentError(expected: 'main' | 'dev', actual?: string): string | null {
  if (actual === expected || (expected === 'main' && actual === undefined)) return null
  return `This ${expected === 'dev' ? 'Kith Dev' : 'Codync'} app found a host from ${actual ?? 'an unidentified environment'}. Start the matching host on its own port.`
}
