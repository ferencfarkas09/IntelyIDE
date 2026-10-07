//! Tauri glue of the contract-drift detector and API explorer (Wave 4) on top of `intely_contract`.
//! Everything here only reads: it lists files, runs `git status`/`rev-parse`, reads source and swagger files, and keeps
//! the parsed contract and per-repo results in memory (keyed by commit hash and working-tree state). It sends no
//! request and writes nothing, so no jail check is needed.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use intely_contract::analyze::{analyze, Cache, ClientInput, Report};
use intely_contract::spec::{self, Detail, Node, Spec};
use intely_contract::git;
use intely_core::EngineError;
use tauri::State;

use super::switchhook::{BoxFuture, SwitchHook};
use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;

type Res<T> = Result<T, EngineError>;

struct Loaded {
    fingerprint: String,
    repo_id: String,
    spec: Arc<Spec>,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
static CACHE: Mutex<Option<Arc<Cache>>> = Mutex::new(None);

/// The per-repo result cache (created on first use, dropped by a workspace switch).
fn cache() -> Arc<Cache> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(|| Arc::new(Cache::default())).clone()
}

/// The `SwitchHook` of the contract module: the parsed spec and the analysis results belong to the old workspace's repos.
pub struct ContractHook;

/// Forgets the loaded contract and every cached result.
pub fn reset() {
    *LOADED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

impl SwitchHook for ContractHook {
    fn name(&self) -> &'static str {
        "contract"
    }

    fn busy(&self) -> Vec<intely_core::BusyItem> {
        Vec::new()
    }

    fn stop(&self) -> BoxFuture<'_, Vec<intely_core::SwitchWarning>> {
        Box::pin(async move {
            reset();
            Vec::new()
        })
    }
}

pub fn hook() -> Arc<dyn SwitchHook> {
    Arc::new(ContractHook)
}

fn current() -> Res<Arc<Spec>> {
    LOADED.lock().ok().and_then(|g| g.as_ref().map(|l| l.spec.clone())).ok_or_else(|| EngineError::new("contract", "run the contract check first"))
}

/// Runs (or serves from the cache) the comparison of the backend contract with every other workspace repo.
#[tauri::command]
pub async fn contract_analyze(engine: State<'_, EngineSlot>, spec_repo_id: Option<String>) -> Res<Report> {
    let all = repos(&engine).await?;
    blocking(move || {
        let listed: Vec<(String, PathBuf, Vec<String>)> = all.into_iter().map(|r| (r.id, r.path.clone(), git::list_files(&r.path))).collect();
        let pick = match &spec_repo_id {
            Some(id) => listed.iter().find(|(i, ..)| i == id),
            None => listed.iter().filter_map(|(i, p, f)| spec::discover(p, f).map(|c| (c.score, i.as_str()))).max_by_key(|(s, _)| *s).and_then(|(_, id)| listed.iter().find(|(i, ..)| i == id)),
        };
        let Some((spec_id, spec_root, spec_files)) = pick else {
            return Err(EngineError::new("noSpec", "no repository with a swagger or openapi description"));
        };
        let fp = git::fingerprint(spec_root);
        let spec = {
            let mut g = LOADED.lock().map_err(|_| EngineError::new("internal", "contract state poisoned"))?;
            match g.as_ref() {
                Some(l) if l.fingerprint == fp && &l.repo_id == spec_id => l.spec.clone(),
                _ => {
                    let s = Arc::new(spec::load(spec_root, spec_files).map_err(|m| EngineError::new("spec", m))?);
                    *g = Some(Loaded { fingerprint: fp.clone(), repo_id: spec_id.clone(), spec: s.clone() });
                    s
                }
            }
        };
        let clients: Vec<ClientInput> = listed.iter().filter(|(i, ..)| i != spec_id).map(|(i, p, _)| ClientInput { id: i.clone(), root: p.clone() }).collect();
        Ok(analyze(&spec, spec_id, &fp, &clients, &cache()))
    })
    .await
}

/// Parameters, request body and responses of one endpoint (`METHOD /path`) as resolved schema trees.
#[tauri::command]
pub async fn contract_detail(endpoint_id: String) -> Res<Detail> {
    let spec = current()?;
    blocking(move || spec::detail(&spec, &endpoint_id).ok_or_else(|| EngineError::new("notFound", format!("unknown endpoint {endpoint_id}")))).await
}

/// One named definition as a schema tree.
#[tauri::command]
pub async fn contract_definition(name: String) -> Res<Node> {
    let spec = current()?;
    blocking(move || spec::definition(&spec, &name).ok_or_else(|| EngineError::new("notFound", format!("unknown definition {name}")))).await
}

#[cfg(test)]
mod hook_tests {
    use super::*;

    #[test]
    fn the_contract_hook_clears_the_loaded_spec_and_the_cache_and_can_be_stopped_twice() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("swagger.json"), r#"{"swagger":"2.0","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}}}}}"#).unwrap();
        let spec = Arc::new(spec::load(dir.path(), &["swagger.json".to_owned()]).expect("a tiny swagger loads"));
        *LOADED.lock().unwrap() = Some(Loaded { fingerprint: "fp".into(), repo_id: "api".into(), spec });
        let first = cache();
        assert!(current().is_ok());

        let hook = hook();
        assert_eq!(hook.name(), "contract");
        assert!(hook.busy().is_empty());
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
        assert!(current().is_err(), "the loaded contract is gone");
        assert!(!Arc::ptr_eq(&first, &cache()), "the result cache was dropped");
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");
    }
}
