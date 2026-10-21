/** Installed identities. Production values stay unchanged when adding Kith Dev. */
export function environmentProfile(environment: 'main' | 'dev') {
  const dev = environment === 'dev'
  return {
    environment,
    name: dev ? 'Kith Dev' : 'Codync',
    appId: dev ? 'com.yingkailiao.kith.dev' : 'com.pokai.Codync',
    scheme: dev ? 'codync-dev' : 'codync',
    dataFolder: dev ? '.kith-dev' : '.codync',
    port: dev ? 19223 : 19222,
    hostLabel: dev ? 'com.yingkailiao.kith.dev.host' : 'com.pokai.codync.host',
    systemdUnit: dev ? 'kith-dev-host.service' : 'codync-host.service',
    windowsService: dev ? 'CodyncDevHost' : 'CodyncHost',
    supervisor: dev ? 'codync-dev-hostw.exe' : 'codync-hostw.exe',
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
