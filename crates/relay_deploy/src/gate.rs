//! The jail gate of spec 4.9: which wrangler/pnpm/node operations a launch mode allows. Read by every runner entry point, so a bug in
//! a higher layer cannot spawn a process the mode forbids. No change to `crates/core`.
//!
//! | mode | rule |
//! |---|---|
//! | Off | everything allowed (the caller still needs the typed confirmations of 4.4) |
//! | ReadOnly | only `Op::Version` (and the commands that spawn nothing, which never call the gate); `INTELY_CLOUD=1` makes it behave like Off |
//! | E2e | only a binary inside the fixture root; `Op::Pnpm` and `Op::Node` refused; the cloud flag never applies |

use std::path::Path;

use intely_core::jail::{Jail, Mode, READ_ONLY, TEST_JAIL};

use crate::error::{DeployError, Result};
use crate::wrangler::Op;

/// The jail as the relay tools see it: `INTELY_CLOUD=1` lifts READONLY for the relay commands only. E2E always wins over the flag.
pub fn effective_jail(jail: &Jail, cloud: bool) -> Jail {
    match jail.mode() {
        Mode::ReadOnly if cloud => Jail::off(),
        _ => jail.clone(),
    }
}

/// `bin` is the program about to run (wrangler, pnpm, node, or the `INTELY_WRANGLER_BIN` test seam).
pub fn gate(jail: &Jail, op: Op, bin: &Path, cloud: bool) -> Result<()> {
    match jail.mode() {
        Mode::Off => Ok(()),
        Mode::ReadOnly if cloud => Ok(()),
        Mode::ReadOnly => match op {
            Op::Version => Ok(()),
            _ => Err(DeployError::coded(READ_ONLY, format!("read-only mode (INTELY_READONLY): {} is refused; start with INTELY_CLOUD=1 to enable the relay tools only", op.name()))),
        },
        Mode::E2e => {
            if matches!(op, Op::Pnpm | Op::Node) {
                return Err(DeployError::coded(TEST_JAIL, format!("test jail (INTELY_E2E): {} is refused", op.name())));
            }
            if jail.in_fixture(bin) {
                Ok(())
            } else {
                Err(DeployError::coded(TEST_JAIL, format!("test jail (INTELY_E2E): {} is only allowed for a binary inside the fixture root", op.name())))
            }
        }
    }
}

/// The `INTELY_WRANGLER_BIN` seam: honoured only in the E2E jail and only for a path inside the fixture root. Anywhere else the
/// variable is ignored (not an error), so a stray variable cannot redirect a real deploy to another program.
pub fn wrangler_bin_override<'a>(jail: &Jail, value: Option<&'a str>) -> Option<&'a Path> {
    let v = value.filter(|v| !v.is_empty())?;
    (jail.mode() == Mode::E2e && jail.in_fixture(Path::new(v))).then(|| Path::new(v))
}
