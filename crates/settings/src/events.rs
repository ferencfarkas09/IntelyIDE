//! A minimal synchronous listener list: the Tauri glue subscribes once and forwards to the webview.

use std::sync::{Arc, Mutex, PoisonError};

type Listener<T> = Arc<dyn Fn(&T) + Send + Sync>;

pub struct Listeners<T> {
    list: Mutex<Vec<Listener<T>>>,
}

impl<T> Default for Listeners<T> {
    fn default() -> Self {
        Self { list: Mutex::new(Vec::new()) }
    }
}

impl<T> Listeners<T> {
    pub fn add(&self, cb: impl Fn(&T) + Send + Sync + 'static) {
        self.list.lock().unwrap_or_else(PoisonError::into_inner).push(Arc::new(cb));
    }

    /// Calls the listeners outside the lock, so a listener may subscribe or call back into the owner.
    pub fn emit(&self, event: &T) {
        let snapshot: Vec<Listener<T>> = self.list.lock().unwrap_or_else(PoisonError::into_inner).clone();
        snapshot.iter().for_each(|cb| cb(event));
    }
}
