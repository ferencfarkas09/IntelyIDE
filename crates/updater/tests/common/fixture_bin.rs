//! The fixture program ((design notes: updater-spec) 10.1): a tiny Mach-O compiled with `/usr/bin/cc` at
//! test time and used as `CFBundleExecutable` of ad-hoc signed `LSBackgroundOnly` fixture apps.
//! Its behaviour is chosen by a `behavior` file in the bundle's `Resources`:
//! write `started-<token>` (its pid) first thing, write `confirmed-<token>` after N seconds,
//! write `clean-exit-<token>`, exit after N seconds, hang, spawn an orphan child process.
//! A hard lifetime cap makes sure a stray fixture can never linger.
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use super::fixture_app::{have_codesign, sign_adhoc, TEST_EXE};

const SOURCE: &str = r#"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>

static char state_dir[2048], token[64], logpath[2048], app_path[2048];
static int write_started = 0, confirm_after = -1, clean_exit = 0, exit_after = -1, spawn_child = 0, hang = 0, max_life = 120;

static void logline(const char *what, long v) {
  if (!logpath[0]) return;
  FILE *f = fopen(logpath, "a");
  if (!f) return;
  fprintf(f, "%s %ld\n", what, v);
  fclose(f);
}

static void marker(const char *kind, int with_pid) {
  char tmp[4300], dst[4300];
  snprintf(dst, sizeof dst, "%s/%s-%s", state_dir, kind, token);
  snprintf(tmp, sizeof tmp, "%s.tmp", dst);
  FILE *f = fopen(tmp, "w");
  if (!f) return;
  if (with_pid) fprintf(f, "%d\n", (int)getpid());
  fclose(f);
  rename(tmp, dst);
}

int main(int argc, char **argv) {
  (void)argc; (void)argv;
  char exe[PATH_MAX]; uint32_t sz = sizeof exe;
  if (_NSGetExecutablePath(exe, &sz) != 0) return 2;
  char real[PATH_MAX];
  if (!realpath(exe, real)) return 2;
  /* <app>/Contents/MacOS/<exe> */
  char *p = strrchr(real, '/'); if (p) *p = 0;       /* .../MacOS */
  p = strrchr(real, '/'); if (p) *p = 0;             /* .../Contents */
  char res[PATH_MAX]; snprintf(res, sizeof res, "%s/Resources/behavior", real);
  p = strrchr(real, '/'); if (p) *p = 0;             /* app path */
  snprintf(app_path, sizeof app_path, "%s", real);
  FILE *f = fopen(res, "r");
  if (f) {
    char line[4400];
    while (fgets(line, sizeof line, f)) {
      line[strcspn(line, "\n")] = 0;
      char *eq = strchr(line, '='); if (!eq) continue; *eq = 0; char *v = eq + 1;
      if (!strcmp(line, "state_dir")) snprintf(state_dir, sizeof state_dir, "%s", v);
      else if (!strcmp(line, "token")) snprintf(token, sizeof token, "%s", v);
      else if (!strcmp(line, "log")) snprintf(logpath, sizeof logpath, "%s", v);
      else if (!strcmp(line, "write_started")) write_started = atoi(v);
      else if (!strcmp(line, "confirm_after")) confirm_after = atoi(v);
      else if (!strcmp(line, "clean_exit")) clean_exit = atoi(v);
      else if (!strcmp(line, "exit_after")) exit_after = atoi(v);
      else if (!strcmp(line, "spawn_child")) spawn_child = atoi(v);
      else if (!strcmp(line, "hang")) hang = atoi(v);
      else if (!strcmp(line, "max_life")) max_life = atoi(v);
    }
    fclose(f);
  }
  logline("start", (long)getpid());
  if (write_started) marker("started", 1);
  if (spawn_child) {
    pid_t c = fork();
    if (c == 0) {
      setsid();
      execl("/bin/sh", app_path, "-c", "sleep 300", (char *)0);
      _exit(127);
    }
    logline("child", (long)c);
  }
  if (confirm_after >= 0) { sleep(confirm_after); marker("confirmed", 0); logline("confirmed", 0); }
  if (exit_after >= 0) {
    if (exit_after > 0 && confirm_after < 0) sleep(exit_after);
    if (clean_exit) marker("clean-exit", 0);
    logline("exit", 0);
    _exit(0);
  }
  (void)hang;
  for (int i = 0; i < max_life; i++) sleep(1);
  logline("lifetime", 0);
  return 0;
}
"#;

#[derive(Clone, Debug, Default)]
pub struct Behavior {
    pub state_dir: Option<PathBuf>,
    pub token: Option<String>,
    pub write_started: bool,
    pub confirm_after: Option<u32>,
    pub clean_exit: bool,
    pub exit_after: Option<u32>,
    pub spawn_child: bool,
    pub log: Option<PathBuf>,
    pub max_life: Option<u32>,
}

impl Behavior {
    fn render(&self) -> String {
        let mut s = String::new();
        let mut kv = |k: &str, v: String| s.push_str(&format!("{k}={v}\n"));
        if let Some(d) = &self.state_dir {
            kv("state_dir", d.display().to_string());
        }
        if let Some(t) = &self.token {
            kv("token", t.clone());
        }
        if let Some(l) = &self.log {
            kv("log", l.display().to_string());
        }
        kv("write_started", (self.write_started as u8).to_string());
        if let Some(n) = self.confirm_after {
            kv("confirm_after", n.to_string());
        }
        kv("clean_exit", (self.clean_exit as u8).to_string());
        if let Some(n) = self.exit_after {
            kv("exit_after", n.to_string());
        }
        kv("spawn_child", (self.spawn_child as u8).to_string());
        kv("max_life", self.max_life.unwrap_or(60).to_string());
        s
    }
}

/// Compiles the program once per test process and returns the path of the binary.
pub fn compiled() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("intely-fixture-bin-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("fixture.c");
        fs::write(&src, SOURCE).unwrap();
        let out = dir.join("fixture");
        let r = Command::new("/usr/bin/cc").arg("-O0").arg("-o").arg(&out).arg(&src).output().expect("cc");
        assert!(r.status.success(), "cc failed: {}", String::from_utf8_lossy(&r.stderr));
        out
    })
}

pub fn have_cc() -> bool {
    Path::new("/usr/bin/cc").exists()
}

/// Writes `<parent>/<dir_name>` as an `LSBackgroundOnly` app that runs the fixture program with
/// `behavior`, and signs it ad hoc when `codesign` exists.
pub fn make_fixture_app(parent: &Path, dir_name: &str, bundle_id: &str, version: &str, behavior: &Behavior) -> PathBuf {
    let app = parent.join(dir_name);
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(app.join("Contents/Resources")).unwrap();
    let mut d = plist::Dictionary::new();
    d.insert("CFBundleIdentifier".into(), bundle_id.into());
    d.insert("CFBundleShortVersionString".into(), version.into());
    d.insert("CFBundleVersion".into(), version.into());
    d.insert("CFBundleExecutable".into(), TEST_EXE.into());
    d.insert("CFBundleName".into(), "FixtureApp".into());
    d.insert("CFBundlePackageType".into(), "APPL".into());
    d.insert("LSBackgroundOnly".into(), true.into());
    plist::Value::Dictionary(d).to_file_xml(app.join("Contents/Info.plist")).unwrap();
    let exe = app.join("Contents/MacOS").join(TEST_EXE);
    fs::copy(compiled(), &exe).unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(app.join("Contents/Resources/behavior"), behavior.render()).unwrap();
    if have_codesign() {
        sign_adhoc(&app);
    }
    app
}
