//! What the machine has left: available memory as a percent of the total, and swap in use.
//! The gate waits on these (see `Settings::shortage`).

use anyhow::Result;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Memory {
    /// Memory that can be given to a new process without swapping, as a percent of all of it.
    pub free_percent: f64,
    pub swap_used_gb: f64,
}

pub trait Probe: Send + Sync {
    fn read(&self) -> Result<Memory>;
}

pub struct System;

impl Probe for System {
    fn read(&self) -> Result<Memory> {
        read_system()
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// macOS: `kern.memorystatus_level` is the "System-wide memory free percentage" that
/// `memory_pressure` prints. The kernel computes it from free, speculative, purgeable and
/// file-backed (reclaimable) pages against all pages, which is what "room for another process"
/// means here; adding the page counts up by hand would only reproduce it. Swap is `vm.swapusage`.
#[cfg(target_os = "macos")]
fn read_system() -> Result<Memory> {
    use anyhow::{bail, ensure};
    use std::ffi::CString;

    /// `struct xsw_usage` from <sys/sysctl.h>.
    #[repr(C)]
    #[derive(Default)]
    struct SwapUsage {
        total: u64,
        avail: u64,
        used: u64,
        pagesize: u32,
        encrypted: u8,
    }

    fn sysctl<T: Default>(name: &str) -> Result<T> {
        let name = CString::new(name)?;
        let mut value = T::default();
        let mut len = size_of::<T>();
        // SAFETY: `value` is a writable buffer of `len` bytes, valid for the call; the name is NUL-terminated.
        let rc = unsafe {
            libc::sysctlbyname(name.as_ptr(), (&raw mut value).cast(), &raw mut len, std::ptr::null_mut(), 0)
        };
        if rc != 0 {
            bail!("sysctl {}: {}", name.to_string_lossy(), std::io::Error::last_os_error());
        }
        Ok(value)
    }

    let level: i32 = sysctl("kern.memorystatus_level")?;
    ensure!((0..=100).contains(&level), "kern.memorystatus_level = {level}");
    let swap: SwapUsage = sysctl("vm.swapusage")?;
    #[allow(clippy::cast_precision_loss)]
    Ok(Memory { free_percent: f64::from(level), swap_used_gb: swap.used as f64 / GB })
}

/// Linux: `MemAvailable` is the kernel's own estimate of what a new process can get without swapping.
#[cfg(target_os = "linux")]
fn read_system() -> Result<Memory> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo")?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_system() -> Result<Memory> {
    anyhow::bail!("memory isn't measured on this platform")
}

/// `/proc/meminfo` text to a reading.
#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(text: &str) -> Result<Memory> {
    use anyhow::Context as _;
    let kb = |key: &str| -> Result<f64> {
        let line = text.lines().find_map(|l| l.strip_prefix(key)).with_context(|| format!("no {key} in meminfo"))?;
        let n: f64 = line.trim_start_matches(':').split_whitespace().next().unwrap_or_default().parse()?;
        Ok(n)
    };
    let (total, available) = (kb("MemTotal")?, kb("MemAvailable")?);
    anyhow::ensure!(total > 0.0, "MemTotal is 0");
    let swap_used = (kb("SwapTotal")? - kb("SwapFree")?).max(0.0);
    Ok(Memory { free_percent: available / total * 100.0, swap_used_gb: swap_used * 1024.0 / GB })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo_gives_available_percent_and_swap_used() {
        let text = "MemTotal:       16000000 kB\nMemFree:          200000 kB\nMemAvailable:    4000000 kB\n\
                    SwapTotal:       4194304 kB\nSwapFree:        2097152 kB\n";
        let m = parse_meminfo(text).unwrap();
        assert!((m.free_percent - 25.0).abs() < 1e-9);
        assert!((m.swap_used_gb - 2.0).abs() < 1e-9);
        assert!(parse_meminfo("MemTotal: 1 kB\n").is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn this_machine_can_be_read() {
        let m = System.read().unwrap();
        assert!((0.0..=100.0).contains(&m.free_percent));
        assert!(m.swap_used_gb >= 0.0);
    }
}
