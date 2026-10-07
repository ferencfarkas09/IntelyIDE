//! The focus-gated scheduler: a provider polls only while the window is focused. While it is blurred there is no timer at
//! all (the loop waits on the focus channel alone); regaining focus runs one catch-up poll at once. A provider that asks for
//! a `blurred` interval (the Time Tracer: a timer started or stopped on the phone or in the browser must show up while the
//! user works elsewhere) keeps polling at that slower pace instead. Failures back off exponentially from 5 s to 5 min with
//! jitter.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Notify};

/// What a poll tells the scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Again,
    Backoff,
    /// 401 or 403: end the loop; the hub restarts it on a new token or a manual test.
    Stop,
}

pub fn backoff(failures: u32, jitter: f64) -> Duration {
    let base = 5.0 * 2f64.powi(failures.saturating_sub(1).min(10) as i32);
    Duration::from_secs_f64(base.min(300.0) * (1.0 + 0.2 * jitter.clamp(0.0, 1.0)))
}

fn jitter() -> f64 {
    f64::from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) % 1000) / 1000.0
}

pub async fn run<F, Fut>(focus: watch::Receiver<bool>, every: Duration, tick: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Next>,
{
    run_with(focus, move || every, None, Arc::new(Notify::new()), tick).await;
}

/// [`run`] with an interval that is asked for after every poll (it can change with the dock or the socket), an optional `blurred`
/// interval (without one nothing runs while blurred; with one the loop keeps polling at that pace and catches up at once on
/// focus) and a `wake` that ends the current wait early, so a state change runs the next poll at once.
pub async fn run_with<E, F, Fut>(mut focus: watch::Receiver<bool>, every: E, blurred: Option<Duration>, wake: Arc<Notify>, mut tick: F)
where
    E: Fn() -> Duration,
    F: FnMut() -> Fut,
    Fut: Future<Output = Next>,
{
    let mut failures = 0u32;
    loop {
        if blurred.is_none() {
            while !*focus.borrow_and_update() {
                if focus.changed().await.is_err() {
                    return;
                }
            }
        }
        match tick().await {
            Next::Stop => return,
            Next::Again => failures = 0,
            Next::Backoff => failures = failures.saturating_add(1),
        }
        let base = if *focus.borrow() { every() } else { blurred.unwrap_or_else(&every) };
        let wait = if failures == 0 { base } else { backoff(failures, jitter()) };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = wake.notified() => {}
            changed = focus.changed() => if changed.is_err() { return },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use super::*;

    fn spawn_counting(focus: watch::Receiver<bool>, every: Duration, results: Vec<Next>) -> (Arc<AtomicU32>, tokio::task::JoinHandle<()>) {
        let count = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&count);
        let results = Arc::new(std::sync::Mutex::new(results.into_iter()));
        let task = tokio::spawn(run(focus, every, move || {
            seen.fetch_add(1, Ordering::SeqCst);
            let next = results.lock().unwrap().next().unwrap_or(Next::Again);
            async move { next }
        }));
        (count, task)
    }

    #[tokio::test(start_paused = true)]
    async fn it_polls_on_the_interval_only_while_focused() {
        let (tx, rx) = watch::channel(true);
        let (count, task) = spawn_counting(rx, Duration::from_secs(25), vec![]);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(count.load(Ordering::SeqCst), 3, "at 0, 25 and 50 s");
        tx.send(false).unwrap();
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(count.load(Ordering::SeqCst), 3, "nothing runs while blurred");
        tx.send(true).unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(count.load(Ordering::SeqCst), 4, "one catch-up poll on focus");
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_blurred_start_waits_for_focus() {
        let (tx, rx) = watch::channel(false);
        let (count, task) = spawn_counting(rx, Duration::from_secs(25), vec![]);
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        tx.send(true).unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn failures_back_off_and_a_stop_ends_the_loop() {
        let (_tx, rx) = watch::channel(true);
        let (count, task) = spawn_counting(rx, Duration::from_secs(25), vec![Next::Backoff, Next::Backoff, Next::Stop]);
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(count.load(Ordering::SeqCst), 2, "first retry after about 5 s");
        tokio::time::sleep(Duration::from_secs(13)).await;
        assert_eq!(count.load(Ordering::SeqCst), 3, "second retry after about 10 s");
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_provider_with_a_blurred_interval_keeps_polling_slowly_and_catches_up_on_focus() {
        let (tx, rx) = watch::channel(false);
        let count = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&count);
        let task = tokio::spawn(run_with(rx, || Duration::from_secs(4), Some(Duration::from_secs(10)), Arc::new(Notify::new()), move || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { Next::Again }
        }));
        tokio::time::sleep(Duration::from_secs(35)).await;
        assert_eq!(count.load(Ordering::SeqCst), 4, "blurred: at 0, 10, 20 and 30 s");
        tx.send(true).unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(count.load(Ordering::SeqCst), 5, "one catch-up poll on focus");
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert_eq!(count.load(Ordering::SeqCst), 6, "focused again: the fast interval");
        task.abort();
    }

    #[test]
    fn the_backoff_doubles_up_to_five_minutes() {
        let secs = |n| backoff(n, 0.0).as_secs();
        assert_eq!((secs(1), secs(2), secs(3), secs(7), secs(50)), (5, 10, 20, 300, 300));
        assert!(backoff(1, 1.0) <= Duration::from_secs(6) && backoff(1, 1.0) > Duration::from_secs(5));
    }
}
