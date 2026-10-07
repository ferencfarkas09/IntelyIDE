//! Serde types of the `ipc.term` namespace (camelCase, like `intely-core`).

use serde::{Deserialize, Serialize};

macro_rules! api_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

api_types! {
    #[serde(rename_all = "camelCase")]
    pub struct TermOpenOptions {
        /// Starts in the root of this repo.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub repo_id: Option<String>,
        /// Absolute directory; wins over `repoId`.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub cwd: Option<String>,
        pub cols: u16,
        pub rows: u16,
    }

    #[serde(rename_all = "camelCase")]
    pub struct TermOpened {
        pub term_id: String,
        pub cwd: String,
        pub shell: String,
    }

    /// Streamed over the channel `term_open` receives; `Data` batches roughly every 16 ms.
    #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum TermEvent {
        Data { data: String },
        Exit { code: Option<i32> },
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn events_serialise_as_the_ui_expects() {
        let data = serde_json::to_string(&TermEvent::Data { data: "hi".into() }).unwrap();
        assert_eq!(data, r#"{"kind":"data","data":"hi"}"#);
        let exit = serde_json::to_string(&TermEvent::Exit { code: None }).unwrap();
        assert_eq!(exit, r#"{"kind":"exit","code":null}"#);
    }

    #[test]
    fn open_options_accept_the_ui_shape() {
        let o: TermOpenOptions = serde_json::from_str(r#"{"repoId":"api","cols":80,"rows":24}"#).unwrap();
        assert_eq!((o.repo_id.as_deref(), o.cwd, o.cols, o.rows), (Some("api"), None, 80, 24));
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default().register::<TermOpenOptions>().register::<TermOpened>().register::<TermEvent>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
