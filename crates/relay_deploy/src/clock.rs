//! Injectable time for the pipeline's Health step (retry every 5 s up to 90 s), so tests never sleep.

use std::time::Duration;

pub trait Clock: Send + Sync {
    /// Unix seconds.
    fn now(&self) -> u64;
    fn sleep(&self, d: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}
