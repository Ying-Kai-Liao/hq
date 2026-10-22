use super::{install, release};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("kith-update-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn archive(symlink: bool) -> Vec<u8> {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    let mut header = tar::Header::new_gnu();
    header.set_mode(0o755);
    header.set_size(if symlink { 0 } else { 3 });
    if symlink {
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_link_name("/tmp/unrelated-executable").unwrap();
    }
    header.set_cksum();
    let contents: &[u8] = if symlink { b"" } else { b"new" };
    tar.append_data(&mut header, "kith-serve-linux-arm64/kith-serve", contents).unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn extraction_refuses_symlinks_and_only_creates_the_expected_binary() {
    let dir = Directory::new();
    let target = dir.0.join("candidate");
    assert!(release::extract(&archive(true), "linux-arm64", &target).is_err());
    assert!(!target.exists());
    assert!(release::extract(&archive(false), "macos-arm64", &target).is_err());
    release::extract(&archive(false), "linux-arm64", &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert!(release::extract(&archive(false), "linux-arm64", &target).is_err());
}

#[test]
fn the_screen_helper_is_extracted_only_when_the_archive_carries_it() {
    let dir = Directory::new();
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    for (name, contents) in [("kith-serve", b"new"), ("kith-screen", b"scr")] {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o755);
        header.set_size(3);
        header.set_cksum();
        tar.append_data(&mut header, format!("kith-serve-linux-arm64/{name}"), &contents[..]).unwrap();
    }
    let with_helper = tar.into_inner().unwrap().finish().unwrap();
    let helper = dir.0.join("helper");
    assert!(release::extract_file(&with_helper, "linux-arm64", "kith-screen", &helper).unwrap());
    assert_eq!(std::fs::read(&helper).unwrap(), b"scr");
    assert!(!release::extract_file(&archive(false), "linux-arm64", "kith-screen", &dir.0.join("none")).unwrap());
}

#[tokio::test]
async fn a_failed_health_check_restores_the_previous_binary_and_service() {
    let dir = Directory::new();
    let target = dir.0.join("host");
    let candidate = dir.0.join("candidate");
    std::fs::write(&target, b"old").unwrap();
    std::fs::write(&candidate, b"new").unwrap();
    let restored = AtomicBool::new(false);
    let result = install::replace(
        &target,
        &candidate,
        || async { Ok(()) },
        || async {
            assert_eq!(std::fs::read(&target).unwrap(), b"new");
            anyhow::bail!("new host never answered")
        },
        || async {
            assert_eq!(std::fs::read(&target).unwrap(), b"old");
            restored.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;
    assert!(result.is_err());
    assert!(restored.load(Ordering::SeqCst));
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[tokio::test]
async fn failure_to_stop_the_old_host_never_replaces_its_executable() {
    let dir = Directory::new();
    let target = dir.0.join("host");
    let candidate = dir.0.join("candidate");
    std::fs::write(&target, b"old").unwrap();
    std::fs::write(&candidate, b"new").unwrap();
    let result = install::replace(
        &target,
        &candidate,
        || async { anyhow::bail!("host is still running") },
        || async { panic!("must not start the new host") },
        || async { panic!("old binary was never replaced") },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"old");
}

#[tokio::test]
async fn a_healthy_update_replaces_the_binary_and_removes_its_backup() {
    let dir = Directory::new();
    let target = dir.0.join("host");
    let candidate = dir.0.join("candidate");
    std::fs::write(&target, b"old").unwrap();
    std::fs::write(&candidate, b"new").unwrap();
    install::replace(
        &target,
        &candidate,
        || async { Ok(()) },
        || async { Ok(()) },
        || async { panic!("must not roll back a healthy update") },
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(target).unwrap(), b"new");
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[test]
fn app_and_homebrew_binaries_keep_their_installation_owner() {
    assert_eq!(
        install::method(std::path::Path::new("/Applications/Kith.app/Contents/Resources/kith-serve")),
        install::Method::AppBundle
    );
    assert_eq!(
        install::method(std::path::Path::new("/opt/homebrew/Cellar/kith-serve/2.2.1/bin/kith-serve")),
        install::Method::Homebrew
    );
}
