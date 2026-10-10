mod agents;
mod close_guard;
mod commands;
mod e2e;
mod e2e_shot;
mod menu;
mod modules;
mod perf;
mod sink;

use std::sync::Arc;

use commands::EngineSlot;
use intely_core::Engine;
use tauri::{Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewWindowBuilder, WindowEvent};

pub fn run() {
    perf::init();
    // Our own menu is set in setup(); without the default one AppKit has no Edit menu to decorate while it finishes
    // launching (it loads the Writing Tools framework for that, which sits on the startup path).
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .manage(e2e::E2e::from_env())
        .manage(close_guard::CloseGuard::default())
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT {
                if !close_guard::intercept(app) {
                    app.exit(0);
                }
            } else if event.id() == menu::CHECK_UPDATES {
                let _ = app.emit(menu::CHECK_UPDATES_EVENT, ());
            } else if event.id() == menu::CLOSE_WINDOW {
                // Closing goes through CloseRequested, which the guard sees.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            perf::heartbeat,
            perf::first_paint,
            close_guard::close_guard_arm,
            close_guard::close_guard_dialog,
            close_guard::close_guard_exit,
            perf::perf_mark,
            e2e::e2e_report,
            e2e::e2e_pid_alive,
            e2e_shot::e2e_screenshot,
            e2e_shot::e2e_resize,
            commands::workspace_get,
            // ==== wave6 workspaces (registry, hardened save) ====
            modules::workspaces::workspace_save,
            modules::workspaces::workspaces_list,
            modules::workspaces::workspaces_probe,
            modules::workspaces::workspaces_create,
            modules::workspaces::workspaces_rename,
            modules::workspaces::workspaces_recolor,
            modules::workspaces::workspaces_duplicate,
            modules::workspaces::workspaces_remove,
            modules::workspaces::workspaces_reorder,
            modules::workspaces::workspaces_ready,
            modules::workspaces::workspaces_add_repos,
            modules::workspaces::workspaces_relocate_repo,
            modules::workspaces::workspaces_reveal,
            modules::workspaces::workspaces_restore_backup,
            modules::workspaces::workspaces_start_fresh,
            modules::workspaces_switch::workspaces_switch,
            modules::workspaces_switch::workspaces_busy,
            modules::workspaces_switch::workspaces_kill_survivor,
            // ==== wave6 folder picker ((design notes: workspaces-spec) 5) ====
            modules::picker::picker_capabilities,
            modules::picker::picker_start,
            modules::picker::picker_list,
            modules::picker::picker_pick,
            modules::picker::picker_native,
            modules::picker::picker_scan_start,
            modules::picker::picker_scan_results,
            modules::picker::picker_scan_cancel,
            modules::picker::picker_take_drop,
            modules::picker::picker_drop_listen,
            modules::picker::picker_open_privacy_settings,
            modules::picker::picker_git_init,
            modules::picker::e2e_drop,
            commands::engine_status,
            commands::snapshot_get,
            commands::snapshot_refresh,
            commands::list_untracked,
            commands::file_contents,
            commands::file_hunks,
            commands::commit_message_last,
            commands::commit_start,
            commands::commit_cancel,
            commands::push_plan,
            commands::push_commit_files,
            commands::push_start,
            commands::push_cancel,
            commands::pull,
            commands::fetch,
            commands::set_push_target,
            commands::doctor,
            commands::exec_surface_check,
            agents::agent_roles,
            agents::agents_auto_info,
            agents::agent_start,
            agents::providers_enforcement,
            agents::agent_send,
            agents::agent_interrupt,
            agents::agent_answer_permission,
            agents::agent_set_permission,
            agents::agent_modes,
            agents::agent_mcp_status,
            agents::agent_note,
            agents::agent_usage_limits,
            agents::agent_mcp_reconnect,
            agents::agent_answer_question,
            agents::agent_list,
            agents::agent_history,
            agents::agent_rewind,
            agents::agent_repo_files,
            // ==== track C commands (files, term) ====
            modules::files::files_list_dir,
            modules::files::files_read_file,
            modules::files::files_write_file,
            modules::files::files_quick_open_index,
            modules::files::files_create_entry,
            modules::files::files_rename_entry,
            modules::files::files_trash_entry,
            modules::files::files_reveal_entry,
            modules::files::files_watch,
            modules::files::files_unwatch,
            modules::files::search_start,
            modules::files::search_cancel,
            modules::files::branches_list,
            modules::files::branches_create,
            modules::files::branches_switch,
            modules::files::branches_switch_all,
            modules::files::branches_delete,
            modules::files::branches_stash_list,
            modules::files::branches_stash_push,
            modules::files::branches_stash_apply,
            modules::files::branches_stash_pop,
            modules::files::branches_stash_drop,
            modules::files::branches_rollback,
            modules::term::term_open,
            modules::term::term_write,
            modules::term::term_resize,
            modules::term::term_close,
            // ==== track D commands (graph) ====
            modules::graph::graph_log_page,
            modules::graph::graph_commit_detail,
            modules::graph::graph_blame,
            modules::graph::graph_blame_caret,
            modules::graph::graph_file_history,
            modules::graph::graph_rebase_plan,
            modules::graph::graph_rebase_run,
            modules::graph::graph_rebase_abort,
            modules::graph::graph_rebase_continue,
            modules::graph::graph_op_state,
            modules::graph::graph_cherry_pick,
            modules::graph::graph_cherry_pick_abort,
            modules::graph::graph_cherry_pick_continue,
            modules::graph::graph_branch_matrix,
            modules::graph::graph_same_branch_create,
            modules::graph::graph_same_branch_switch,
            modules::graph::graph_bundles,
            modules::graph::graph_bundle_record,
            modules::graph::graph_bundle_remove,
            modules::graph::graph_validate_message,
            modules::graph::graph_message_template,
            modules::graph::graph_draft_message,
            // ==== track E commands (roles) ====
            modules::roles::roles_list,
            modules::roles::roles_save,
            modules::roles::roles_drift,
            modules::roles::roles_resolve_drift,
            modules::roles::roles_preset_happy_tiering,
            modules::roles::roles_groups,
            modules::roles::roles_status,
            modules::roles::roles_use_automatic,
            modules::roles::roles_reset_overlay,
            modules::roles::roles_set_hidden,
            modules::roles::roles_set_pin,
            modules::roles::roles_set_trust,
            modules::roles::roles_delete_preview,
            modules::roles::roles_delete,
            modules::roles::roles_capabilities,
            modules::roles::runs_start,
            modules::roles::runs_list,
            modules::roles::runs_history,
            modules::roles::runs_resume,
            modules::roles::runs_fork,
            modules::roles::runs_stop,
            modules::roles::runs_tag,
            modules::roles::runs_usage,
            modules::roles::runs_rewind_snapshots,
            modules::roles::runs_rewind_restore,
            // ==== track F commands (settings, happy) ====
            modules::settings::settings_get,
            modules::settings::settings_set,
            modules::settings::settings_safety_status,
            modules::settings::secrets_has,
            modules::settings::secrets_status,
            modules::settings::secrets_retry_keychain,
            modules::settings::secrets_set,
            modules::settings::secrets_remove,
            modules::settings::providers_list,
            modules::settings::providers_detect,
            modules::settings::providers_test,
            modules::settings::providers_set_enabled,
            modules::settings::providers_set_auth_mode,
            modules::settings::providers_doctor,
            // ==== wave4 providers commands (experimental switch, command confirmation, test run) ====
            modules::providers::providers_experimental_get,
            modules::providers::providers_experimental_set,
            modules::providers::providers_confirm_launch,
            modules::providers::providers_revoke_launch,
            modules::providers::providers_set_weak_writer,
            modules::providers::providers_caps,
            modules::providers::providers_test_run,
            modules::sentry::sentry_status,
            modules::sentry::sentry_set_config,
            modules::sentry::sentry_save_token,
            modules::sentry::sentry_clear_token,
            modules::sentry::sentry_test,
            modules::sentry::sentry_projects,
            modules::sentry::sentry_issues,
            modules::sentry::sentry_issue,
            modules::sentry::sentry_assign_me,
            modules::sentry::sentry_set_status,
            modules::happy::happy_status,
            modules::happy::happy_set_config,
            modules::happy::happy_save_token,
            modules::happy::happy_test_connection,
            modules::happy::happy_disconnect,
            modules::happy::happy_timer_current,
            modules::happy::happy_timer_start,
            modules::happy::happy_timer_stop,
            modules::happy::happy_timer_pause,
            modules::happy::happy_timer_resume,
            modules::happy::happy_timer_trackables,
            modules::happy::happy_timer_entries,
            modules::happy::happy_timer_totals,
            modules::happy::happy_timer_search,
            modules::happy::happy_timer_create_task,
            modules::happy::happy_meet_list,
            modules::happy::happy_meet_current,
            modules::happy::happy_meet_join,
            modules::happy_inbox::happy_notifications_current,
            modules::happy_inbox::happy_notifications_list,
            modules::happy_inbox::happy_notifications_mark_read,
            modules::happy_inbox::happy_notifications_mark_all_read,
            modules::happy_inbox::happy_notifications_mark_unread,
            modules::happy_inbox::happy_notifications_delete,
            modules::happy_inbox::happy_tasks_current,
            modules::happy_inbox::happy_tasks_list,
            modules::happy_chat::happy_chat_summary,
            modules::happy_chat::happy_chat_refresh,
            modules::happy_chat::happy_chat_set_active,
            modules::happy_chat::happy_chat_open,
            modules::happy_chat::happy_chat_older,
            modules::happy_chat::happy_chat_send,
            modules::happy_chat::happy_chat_mark_read,
            modules::happy_chat::happy_chat_directory,
            modules::happy_chat::happy_chat_open_direct,
            modules::happy_chat::happy_chat_typing,
            modules::happy_chat::happy_chat_around,
            modules::happy_chat::happy_chat_newer,
            modules::happy_chat::happy_chat_thread,
            modules::happy_chat::happy_chat_threads,
            modules::happy_chat::happy_chat_browse,
            modules::happy_chat::happy_chat_create_channel,
            modules::happy_chat::happy_chat_join,
            modules::happy_chat::happy_chat_leave,
            modules::happy_chat::happy_chat_update_channel,
            modules::happy_chat::happy_chat_preferences,
            modules::happy_chat::happy_chat_members,
            modules::happy_chat::happy_chat_add_members,
            modules::happy_chat::happy_chat_remove_member,
            modules::happy_chat::happy_chat_edit,
            modules::happy_chat::happy_chat_delete,
            modules::happy_chat::happy_chat_react,
            modules::happy_chat::happy_chat_pin,
            modules::happy_chat::happy_chat_search,
            modules::happy::open_external,
            modules::updates::update_status,
            modules::updates::update_check,
            modules::updates::update_set_enabled,
            modules::updates::update_dismiss,
            // ==== MCP commands ((design notes: mcp-management-spec) 3) ====
            modules::mcp::mcp_list,
            modules::mcp::mcp_save,
            modules::mcp::mcp_remove,
            modules::mcp::mcp_set_enabled,
            modules::mcp::mcp_confirm,
            modules::mcp::mcp_workspace_set,
            modules::mcp::mcp_set_policy,
            modules::mcp::mcp_test,
            modules::mcp::mcp_import_preview,
            modules::mcp::mcp_import_apply,
            modules::mcp::mcp_secrets_present,
            modules::mcp::mcp_run_servers,
            // ==== wave3 X1 l10n commands ====
            modules::l10n::l10n_analyze,
            modules::l10n::l10n_apply,
            modules::l10n::l10n_draft,
            modules::l10n::l10n_release_plan,
            modules::l10n::l10n_release_apply,
            // ==== alpha attachments commands ====
            modules::attachments::attachment_import_bytes,
            modules::attachments::attachment_import_paths,
            modules::attachments::attachment_inspect,
            modules::attachments::attachment_list,
            modules::attachments::attachment_read,
            modules::attachments::attachment_remove,
            modules::attachments::attachment_confirm,
            modules::attachments::attachment_root,
            modules::attachments::attachment_cleanup,
            // ==== track P commands (run) ====
            modules::runner::run_scripts,
            modules::runner::run_script_command,
            modules::runner::run_start,
            modules::runner::run_stop,
            modules::runner::run_restart,
            modules::runner::run_stop_all,
            modules::runner::run_list,
            modules::runner::run_logs,
            modules::runner::run_clear_log,
            modules::runner::run_dismiss,
            modules::runner::run_open,
            modules::runner::run_access,
            modules::runner::run_allow_processes,
            // ==== track P commands (preview) ====
            modules::preview::preview_check_url,
            modules::preview::preview_probe,
            modules::preview::preview_open_external,
            modules::preview::preview_proxy_start,
            modules::preview::preview_proxy_stop,
            modules::preview::preview_component_start,
            modules::preview::preview_component_release,
            modules::preview::preview_component_log,
            // ==== wave3 X2 checks commands ====
            modules::checks::checks_access,
            modules::checks::checks_discover,
            modules::checks::checks_start,
            modules::checks::checks_stop,
            modules::checks::checks_list,
            modules::checks::checks_logs,
            modules::checks::checks_dismiss,
            modules::checks::secrets_scan,
            modules::checks::env_report,
            modules::checks::hygiene_report,
            modules::checks::hygiene_delete_branch,
            modules::checks::worktrees_list,
            modules::checks::worktrees_create,
            modules::checks::worktrees_remove,
            // ==== wave4 GitX commands (PR bridge, Doctor) ====
            modules::gitx::gitx_gh_status,
            modules::gitx::gitx_pr_list,
            modules::gitx::gitx_pr_view,
            modules::gitx::gitx_pr_plan,
            modules::gitx::gitx_pr_preview,
            modules::gitx::gitx_pr_create,
            modules::gitx::gitx_open_url,
            modules::gitx::gitx_doctor,
            modules::gitx::gitx_refresh_env,
            // ==== wave4 agent-ux commands ====
            modules::agentux::agentux_search,
            modules::agentux::agentux_usage,
            modules::agentux::agentux_night_state,
            modules::agentux::agentux_night_add,
            modules::agentux::agentux_night_remove,
            modules::agentux::agentux_night_move,
            modules::agentux::agentux_night_arm,
            modules::agentux::agentux_night_stop,
            modules::agentux::agentux_night_clear,
            modules::agentux::agentux_brief,
            modules::agentux::agentux_brief_summarise,
            // ==== wave4 contract commands ====
            modules::contract::contract_analyze,
            modules::contract::contract_detail,
            modules::contract::contract_definition,
            // ==== wave3 Rm1 remote commands ====
            modules::remote::remote_status,
            modules::remote::remote_configure,
            modules::remote::remote_enable,
            modules::remote::remote_disable,
            modules::remote::remote_pair_start,
            modules::remote::remote_pair_confirm,
            modules::remote::remote_pair_cancel,
            modules::remote::remote_revoke,
            modules::remote::remote_set_capability,
            modules::remote::remote_kill,
            modules::remote::remote_panic,
            modules::remote::remote_apply_local_relay,
            modules::remote::remote_send_build_key,
            // ==== wave5 relay cloud commands (owner: relay task T6) ====
            modules::relay_cloud::relay_cloud_status,
            modules::relay_cloud::relay_cloud_prepare,
            modules::relay_cloud::relay_cloud_login,
            modules::relay_cloud::relay_cloud_logout,
            modules::relay_cloud::relay_cloud_token_set,
            modules::relay_cloud::relay_cloud_token_clear,
            modules::relay_cloud::relay_cloud_whoami,
            modules::relay_cloud::relay_cloud_choose_account,
            modules::relay_cloud::relay_cloud_preview,
            modules::relay_cloud::relay_cloud_plan,
            modules::relay_cloud::relay_cloud_deploy,
            modules::relay_cloud::relay_cloud_retry,
            modules::relay_cloud::relay_cloud_stop,
            modules::relay_cloud::relay_cloud_logs,
            modules::relay_cloud::relay_cloud_verify,
            modules::relay_cloud::relay_cloud_apply,
            modules::relay_cloud::relay_cloud_custom_set,
            modules::relay_cloud::relay_cloud_custom_apply,
            modules::relay_cloud::relay_cloud_rollback,
            modules::relay_cloud::relay_cloud_forget,
            modules::relay_cloud::relay_cloud_vapid_generate,
            modules::relay_cloud::relay_cloud_vapid_push,
            modules::relay_cloud::relay_cloud_rotate,
            modules::relay_cloud::relay_cloud_remove,
            // ==== wave3 X3 hud, tray and viewers commands ====
            modules::hud::hud_snapshot,
            modules::hud::hud_kill,
            modules::hud::hud_restart_sidecar,
            modules::hud::hud_configure,
            modules::hud::hud_focus,
            modules::hud::hud_eco_active,
            modules::tray::tray_configure,
            modules::tray::tray_update,
            modules::notify::notify_configure,
            modules::notify::notify_badge,
            modules::notify::notify_show,
            // ==== servers (Settings > Servers) ====
            modules::servers::servers_list,
            modules::servers::servers_save,
            modules::servers::servers_remove,
            modules::servers::servers_probe,
            modules::servers::servers_setup,
            modules::servers::servers_repos,
            modules::servers::servers_clone,
            modules::servers::servers_ssh_command,
            modules::viewers::viewers_stat,
            modules::viewers::viewers_read_range,
            modules::viewers::viewers_open_external,
            // ==== beta M1 mongo commands (cargo feature mongo-studio) ====
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_status,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_set_enabled,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_parse_literal,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profiles,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_save,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_delete,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_duplicate,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_dismiss_notices,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_connect,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_disconnect,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_test,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_run,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_window,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_cursor_close,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_cancel,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ai_payload,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ai_generate,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ai_explain,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ai_cancel,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_uri_parse,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_uri_render,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_draft_discard,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_convert,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_meta,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profile_secret,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_secrets_status,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_test_cancel,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ssh_hostkey,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ssh_trust,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ssh_forget,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_dialog_open,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_dialog_save,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profiles_export,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profiles_import_preview,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_profiles_import,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_detect_local,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_ai_capabilities,
            #[cfg(feature = "mongo-studio")]
            modules::mongo::mongo_reset_all,
        ])
        .setup(|app| {
            perf::line("setup_start");
            // INTELY_MODE=empty|rich renders the Phase 0 spike UIs; unset is the real app.
            let mode = std::env::var("INTELY_MODE").unwrap_or_default();
            let raf = std::env::var("INTELY_RAF").map_or(true, |v| v != "0");
            let script = format!(
                "window.__INTELY_MODE__ = {}; window.__INTELY_RAF__ = {raf};",
                serde_json::to_string(&mode)?
            );
            let config = app.config().app.windows[0].clone();
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(script)
                .on_page_load(|_, payload| perf::line(&format!("page_{:?}", payload.event())));
            // The folder picker's token table is shared with the workspace registry: it must exist first.
            modules::picker::setup(app)?;
            let sink = Arc::new(sink::TauriSink::new(app.handle().clone()));
            let slot = if mode.is_empty() {
                // the registry decides what opens (the legacy workspace.json is migrated once); a problem starts the app detached
                let slot = modules::workspaces::setup(app, sink, true);
                perf::line("engine_created");
                window = window.traffic_light_position(LogicalPosition::new(16.0, 18.0));
                slot
            } else {
                window = window.title_bar_style(TitleBarStyle::Visible).hidden_title(false);
                modules::workspaces::setup(app, sink, false)
            };
            app.manage(slot);
            // ==== track C state (files, term) ====
            modules::files::setup(app)?;
            modules::term::setup(app)?;
            // ==== track D state (graph) ====
            modules::graph::setup(app)?;
            // ==== track E state (roles) ====
            modules::roles::setup(app)?;
            // ==== track F state (settings, happy) ====
            modules::settings::setup(app)?;
            // MCP state: after settings (it sits on the settings and secret stores), before the agent host asks for its suppliers
            modules::mcp::setup(app)?;
            // the servers a run may execute on: before the agent host asks for the registry
            modules::servers::setup_state(app)?;
            modules::happy::setup(app)?;
            modules::sentry::setup(app)?;
            // ==== beta M1 mongo state (cargo feature mongo-studio; opens nothing) ====
            #[cfg(feature = "mongo-studio")]
            modules::mongo::setup(app)?;
            // ==== alpha attachments state ====
            modules::attachments::setup(app)?;
            // ==== track P state (run) ====
            modules::runner::setup(app)?;
            // ==== wave3 X2 checks state ====
            modules::checks::setup(app)?;
            // ==== track P state (preview) ====
            modules::preview::setup(app)?;
            // ==== wave4 agent-ux state (reads and starts nothing until the UI asks) ====
            modules::agentux::setup(app)?;
            // ==== wave3 Rm1 remote state (inert until remote_enable) ====
            modules::remote::setup(app)?;
            // ==== wave5 relay cloud state (owner: relay task T6; inert until a command runs) ====
            modules::relay_cloud::setup(app)?;
            // ==== wave3 X3 state (empty until the UI switches a feature on) ====
            modules::hud::setup(app)?;
            modules::tray::setup(app)?;
            modules::notify::setup(app)?;
            // ==== update notification (no request before the disclosure; no scheduler in debug builds) ====
            modules::updates::setup(app)?;
            // No agent process exists before the first run; this only prepares the host (and sweeps leftovers).
            let env_handle = app.handle().clone();
            app.manage(agents::AgentSlot::new(app.handle(), move || {
                env_handle.try_state::<EngineSlot>().and_then(|s| s.get().ok().map(Engine::login_env)).unwrap_or_default()
            }));
            // Every module that owns processes, watchers or caches of a workspace joins the switch.
            modules::workspaces_switch::register_module_hooks(app.handle(), &app.state::<Arc<modules::workspaces::WorkspacesState>>());
            let e2e = app.state::<e2e::E2e>();
            if let Some(init) = e2e.init_script() {
                // A fresh, non-persistent web data store (no selection, drafts or history leak between runs), unless the
                // scenario names an isolated persistent one to survive a relaunch.
                window = window.initialization_script(init);
                window = match e2e.store() {
                    Some(id) => window.data_store_identifier(id),
                    None => window.incognito(true),
                };
                e2e.start_watchdog(app.handle());
            }
            // SIGTERM/SIGINT/SIGHUP must end in a regular exit, or `Engine::shutdown` never kills running hooks.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                intely_core::termination_signal().await;
                handle.exit(0);
            });
            perf::line("window_building");
            window.build()?;
            perf::line("window_built");
            app.set_menu(menu::build(app.handle())?)?;
            perf::line(&format!("setup_done mode={mode:?}"));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building IntelySwitchIDE");

    app.run(|handle, event| {
        if let RunEvent::WindowEvent { event: tauri::WindowEvent::Focused(focused), .. } = &event {
            modules::happy::set_focus(handle, *focused);
            modules::updates::set_focus(handle, *focused);
        }
        // Dropped folders: validated in Rust and handed to the screen that declared itself a drop target.
        if let RunEvent::WindowEvent { label, event: WindowEvent::DragDrop(drop), .. } = &event {
            if label == "main" {
                modules::picker::on_drag_drop(handle, drop);
            }
        }
        // Unsaved buffers: hold the window close (and a system quit) back and let the UI ask.
        match &event {
            RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
                if close_guard::intercept(handle) {
                    api.prevent_close();
                }
            }
            // A quit from the Dock menu or the system; after the window has closed there is nothing left to ask.
            RunEvent::ExitRequested { api, code: None, .. } if handle.get_webview_window("main").is_some() => {
                if close_guard::intercept(handle) {
                    api.prevent_exit();
                }
            }
            _ => {}
        }
        // No git process may outlive the app: cancel every run and wait for the process groups to go.
        if let RunEvent::Exit = event {
            if let Some(agents) = handle.try_state::<agents::AgentSlot>() {
                agents.shutdown();
            }
            modules::term::shutdown(handle);
            modules::runner::shutdown(handle);
            modules::checks::shutdown(handle);
            modules::preview::shutdown(handle);
            modules::remote::shutdown(handle);
            #[cfg(feature = "mongo-studio")]
            modules::mongo::shutdown(handle);
            if let Some(slot) = handle.try_state::<EngineSlot>() {
                if let Ok(engine) = slot.get() {
                    tauri::async_runtime::block_on(engine.shutdown());
                }
            }
        }
    });
}
