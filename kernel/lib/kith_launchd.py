"""Reload a launchd job without racing launchd.

`launchctl bootout` returns before the service is fully torn down, and an immediate `bootstrap` of the same label then
fails with "Bootstrap failed: 5: Input/output error". So: bootout, wait until `launchctl print` says the job is gone,
bootstrap again on EIO, and check at the end that the job really is loaded. Mirrored in Rust by
serve/host/src/service/unix.rs."""
import os
import subprocess
import sys
import time

GONE_TIMEOUT = 10.0
RETRIES = 5
BACKOFF = (0.5, 1.0, 2.0, 2.0)   # seconds between bootstrap tries
_RETRY_CODES = (5, 37)           # EIO; "operation already in progress" while the old job is still going away


class LaunchdError(RuntimeError):
    pass


def _launchctl(*args):
    return subprocess.run(['launchctl', *args], capture_output=True, text=True)


def _target(label):
    return f'gui/{os.getuid()}/{label}'


def is_loaded(label):
    return _launchctl('print', _target(label)).returncode == 0


def unload(label, timeout=GONE_TIMEOUT):
    """Bootout (not loaded is fine), then wait until launchd no longer lists the job."""
    _launchctl('bootout', _target(label))
    deadline = time.monotonic() + timeout
    while is_loaded(label):
        if time.monotonic() > deadline:
            raise LaunchdError(f'{label} is still loaded {timeout:.0f}s after launchctl bootout')
        time.sleep(0.2)


def reload(label, plist):
    """Replace the job with the one in `plist` and fail loudly if it is not loaded afterwards."""
    plist = str(plist)
    unload(label)
    err = ''
    bootstrapped = False
    for attempt in range(RETRIES):
        r = _launchctl('bootstrap', f'gui/{os.getuid()}', plist)
        if r.returncode == 0:
            bootstrapped = True
            break
        err = (r.stderr or r.stdout or '').strip()
        if r.returncode not in _RETRY_CODES or attempt == RETRIES - 1:
            break
        time.sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
    # loaded is not enough: it may be another install's plist that is running (two reloads racing)
    if not bootstrapped or not is_loaded(label):
        raise LaunchdError(
            f'{label} is not loaded (plist {plist}); last launchctl said: {err or "nothing"}. '
            f'Load it by hand: launchctl bootstrap gui/{os.getuid()} "{plist}"')


def reload_or_exit(label, plist):
    try:
        reload(label, plist)
    except LaunchdError as e:
        sys.exit(f'error: {e}')
