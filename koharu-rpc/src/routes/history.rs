//! Scene mutation routes — the only way a client changes the scene.
//!
//! - `POST /history/apply` — apply an `Op` (including `Op::Batch`)
//! - `POST /history/undo`  — revert the last applied op
//! - `POST /history/redo`  — re-apply the last undone op
//!
//! Three distinct sub-resource actions under `/history` (Stripe-style
//! named-action URLs). Each returns `{ epoch }` — populated if the action
//! advanced the scene, `None` for a no-op boundary.

use axum::Json;
use axum::extract::State;
use koharu_core::Op;
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(apply_command))
        .routes(routes!(undo))
        .routes(routes!(redo))
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    /// New epoch. `None` only for a no-op undo/redo at the stack boundary.
    pub epoch: Option<u64>,
}

#[utoipa::path(
    post,
    path = "/history/apply",
    request_body = Op,
    responses((status = 200, body = HistoryResult))
)]
async fn apply_command(
    State(app): State<AppState>,
    Json(op): Json<Op>,
) -> ApiResult<Json<HistoryResult>> {
    // Before applying, collect chapter names that are about to be removed.
    // We need these names to clean up sync_dir subdirectories afterwards,
    // otherwise auto_detect_new_chapters will immediately re-add them.
    let chapters_to_remove = {
        let session = app.current_session();
        if let Some(session) = &session {
            let scene = session.scene.read();
            let sync_dir = scene.project.sync_dir.clone();
            if let Some(sync_dir) = sync_dir {
                // Build a lookup of chapter_id -> chapter_name
                let chapter_names: std::collections::HashMap<koharu_core::ChapterId, String> =
                    scene.chapters.iter().map(|(id, ch)| (*id, ch.name.clone())).collect();
                let mut names = Vec::new();
                collect_removed_chapter_names(&op, &chapter_names, &mut names);
                if !names.is_empty() {
                    Some((sync_dir, names))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    };

    let epoch = app.apply(op).map_err(ApiError::internal)?;

    // After successful apply, delete sync_dir subdirectories for removed chapters
    // so auto_detect_new_chapters won't re-add them on the next /scene.json fetch.
    if let Some((sync_dir, chapter_names)) = chapters_to_remove {
        for name in chapter_names {
            let chapter_path = std::path::Path::new(&sync_dir).join(&name);
            if chapter_path.is_dir() {
                tracing::info!(?chapter_path, "Removing sync directory for deleted chapter");
                let _ = std::fs::remove_dir_all(&chapter_path);
            }
        }
    }

    Ok(Json(HistoryResult { epoch: Some(epoch) }))
}

/// Recursively collect chapter names from RemoveChapter ops (including inside Batch).
fn collect_removed_chapter_names(
    op: &Op,
    chapter_names: &std::collections::HashMap<koharu_core::ChapterId, String>,
    out: &mut Vec<String>,
) {
    match op {
        Op::RemoveChapter { id, .. } => {
            if let Some(name) = chapter_names.get(id) {
                out.push(name.clone());
            }
        }
        Op::Batch { ops, .. } => {
            for inner in ops {
                collect_removed_chapter_names(inner, chapter_names, out);
            }
        }
        _ => {}
    }
}

#[utoipa::path(post, path = "/history/undo", responses((status = 200, body = HistoryResult)))]
async fn undo(State(app): State<AppState>) -> ApiResult<Json<HistoryResult>> {
    let epoch = app.undo().map_err(ApiError::internal)?;
    Ok(Json(HistoryResult { epoch }))
}

#[utoipa::path(post, path = "/history/redo", responses((status = 200, body = HistoryResult)))]
async fn redo(State(app): State<AppState>) -> ApiResult<Json<HistoryResult>> {
    let epoch = app.redo().map_err(ApiError::internal)?;
    Ok(Json(HistoryResult { epoch }))
}
