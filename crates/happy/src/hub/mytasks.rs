//! Hub side of "My tasks" (plan E4): a focused poll every 5 minutes, the cached view, and a manual refresh. Read-only: the
//! timer and agent shortcuts live in the webview (they use the Time Tracer verbs and the New Run dialog).

use super::{ApiError, Hub, Id, Kind, Method, Scope};
use crate::tasks::{self, TasksView};

pub(super) struct TaskState {
    view: TasksView,
    misses: u32,
}

impl Default for TaskState {
    fn default() -> Self {
        Self { view: TasksView::empty(), misses: 0 }
    }
}

impl Hub {
    /// The last known task list. Makes no request.
    pub fn tasks_current(&self) -> TasksView {
        self.st().tk.view.clone()
    }

    fn set_tasks(&self, view: TasksView) -> TasksView {
        let changed = {
            let mut st = self.st();
            st.tk.misses = 0;
            let changed = st.tk.view != view;
            st.tk.view = view.clone();
            changed
        };
        if changed {
            self.0.sink.tasks(&view);
        }
        view
    }

    pub(super) fn tasks_missed(&self) {
        let view = {
            let mut st = self.st();
            st.tk.misses += 1;
            if st.tk.misses < 2 || st.tk.view.stale || !st.tk.view.loaded {
                return;
            }
            st.tk.view.stale = true;
            st.tk.view.clone()
        };
        self.0.sink.tasks(&view);
    }

    async fn fetch_tasks(&self) -> Result<TasksView, ApiError> {
        let me = self.st().user.as_ref().map_or_else(|| "me".to_owned(), |u| u.id.clone());
        let mut list = tasks::items(&self.request(Scope::Tasks, Method::Get, "/api/tasks", &[("assignee", me.as_str())], None).await?);
        // The statuses endpoint is optional: when it is missing the statuses are derived from the tasks themselves.
        let known = match self.request(Scope::Tasks, Method::Get, "/api/tasks/statuses", &[], None).await {
            Ok(v) => tasks::statuses(&v),
            Err(e) if matches!(e.kind, Kind::Unauthorized | Kind::Backoff | Kind::Offline) => return Err(e),
            Err(_) => Vec::new(),
        };
        let statuses = tasks::reconcile(known, &mut list);
        Ok(TasksView { tasks: list, statuses, loaded: true, stale: false })
    }

    #[doc(hidden)]
    pub async fn poll_tasks(&self) -> Result<(), ApiError> {
        let view = self.fetch_tasks().await?;
        self.set_tasks(view);
        Ok(())
    }

    /// Fetches the list now (the dock tab opened, or the user pressed refresh).
    pub async fn tasks_list(&self) -> Result<TasksView, ApiError> {
        self.require(Id::Tasks)?;
        let view = self.fetch_tasks().await?;
        Ok(self.set_tasks(view))
    }
}
