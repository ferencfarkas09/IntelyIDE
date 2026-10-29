//! Child processes with a deadline: output is read on threads so a chatty child cannot block, a hung one is killed.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use intely_core::{code, EngineError};

pub struct Out {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Once the child has exited, its output is waited for at most this long: a program that left a background process holding
/// the pipe (a daemonising shim) must not hang the caller.
const AFTER_EXIT: Duration = Duration::from_secs(2);

fn drain(mut r: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
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
    let collect = |rx: mpsc::Receiver<String>| rx.recv_timeout(AFTER_EXIT).unwrap_or_default();
    Ok(Out { ok: status.success(), code: status.code(), stdout: collect(out), stderr: collect(err) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_background_process_that_keeps_the_pipe_open_does_not_hang_the_caller() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo started; sleep 30 &"]);
        let start = Instant::now();
        let out = run(cmd, Duration::from_secs(10)).unwrap();
        assert!(out.ok);
        assert!(start.elapsed() < Duration::from_secs(8), "waited {:?}", start.elapsed());
    }
}
