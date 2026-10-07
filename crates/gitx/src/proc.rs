//! Child processes with a deadline: output is read on threads so a chatty child cannot block, a hung one is killed.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use intely_core::{code, EngineError};

pub struct Out {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn drain(mut r: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// Runs `cmd` (stdin closed) and waits at most `timeout`; a timeout kills the child and fails with `io`.
pub fn run(mut cmd: Command, timeout: Duration) -> Result<Out, EngineError> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd.spawn().map_err(|e| EngineError::new(code::IO, format!("could not start {}: {e}", cmd.get_program().to_string_lossy())))?;
    let (out, err) = (drain(child.stdout.take().expect("piped")), drain(child.stderr.take().expect("piped")));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::new(code::IO, format!("{} did not finish in {} s", cmd.get_program().to_string_lossy(), timeout.as_secs())));
            }
            Err(e) => return Err(EngineError::new(code::IO, e.to_string())),
        }
    };
    Ok(Out { ok: status.success(), code: status.code(), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}
