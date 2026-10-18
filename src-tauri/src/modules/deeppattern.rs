//! Tauri glue of the DeepPattern integration (`crates/deeppattern`): `deeppattern_status` reads files only, `deeppattern_doctor` runs
//! the engine's own health check (a program of the engine's installer, so it is refused in read-only mode). Nothing here talks to the
//! network and nothing holds the endpoint or the activation key: the engine's installer asks for them in its own window.

use std::path::PathBuf;

use intely_core::jail::{Jail, Mode, READ_ONLY};
use intely_core::EngineError;
use intely_deeppattern::{DoctorError, DoctorReport, Status, DOCTOR_TIMEOUT};

use crate::agents::blocking;

type Res<T> = Result<T, EngineError>;

/// `~/.deeppattern/decision-engine`, or the folder `INTELY_DEEPPATTERN_HOME` names (tests, a moved install).
fn root() -> PathBuf {
    let home = intely_core::sys::home_dir().unwrap_or_default();
    let over = std::env::var_os("INTELY_DEEPPATTERN_HOME").map(PathBuf::from);
    intely_deeppattern::root(&home, over.as_deref())
}

#[tauri::command]
pub async fn deeppattern_status() -> Res<Status> {
    blocking(|| Ok(intely_deeppattern::status(&root()))).await
}

#[tauri::command]
pub async fn deeppattern_doctor() -> Res<DoctorReport> {
    if Jail::global().mode() == Mode::ReadOnly {
        return Err(EngineError::new(READ_ONLY, "read-only mode (INTELY_READONLY): the check starts a program"));
    }
    blocking(|| {
        intely_deeppattern::run_doctor(&root(), DOCTOR_TIMEOUT).map_err(|e| match e {
            DoctorError::NotInstalled => EngineError::new("notInstalled", "DeepPattern is not installed on this computer"),
            DoctorError::Start(why) => EngineError::new("io", format!("could not start the check: {why}")),
        })
    })
    .await
}
