//! Project lifecycle routes. Every project lives under the managed
//! `{data.path}/projects/` directory; clients never supply filesystem
//! paths. A project's `id` is the `.khrproj/` directory basename.
//!
//! - `GET    /projects` — list managed projects
//! - `POST   /projects` — create a new project (`{name}`), server allocates path
//! - `POST   /projects/import` — extract a `.khr` archive into a fresh dir + open
//! - `PUT    /projects/current` — open a managed project by `id`
//! - `DELETE /projects/current` — close current session
//! - `POST   /projects/current/export` — export current; returns bytes

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use image::GenericImageView;
use koharu_app::projects as project_dirs;
use koharu_core::{ImageRole, PageId, ProjectSummary};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(list_projects))
        .routes(routes!(create_project))
        .routes(routes!(import_project))
        .routes(routes!(import_directory))
        .routes(routes!(put_current_project))
        .routes(routes!(delete_current_project))
        .routes(routes!(delete_project_by_id))
        .routes(routes!(rename_project))
        .routes(routes!(export_current_project))
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResponse {
    pub projects: Vec<ProjectSummary>,
}

#[utoipa::path(
    get,
    path = "/projects",
    responses((status = 200, body = ListProjectsResponse))
)]
async fn list_projects(State(app): State<AppState>) -> ApiResult<Json<ListProjectsResponse>> {
    let config = (**app.config.load()).clone();
    let projects = project_dirs::list_projects(&config).map_err(ApiError::internal)?;
    Ok(Json(ListProjectsResponse { projects }))
}

// ---------------------------------------------------------------------------
// POST /projects — create a new project from a display name
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
}

#[utoipa::path(
    post,
    path = "/projects",
    request_body = CreateProjectRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn create_project(
    State(app): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let trimmed = req.name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("name must not be empty"));
    }
    let config = (**app.config.load()).clone();
    let path = project_dirs::allocate_named(&config, trimmed).map_err(ApiError::internal)?;
    let session = app
        .open_project(path, Some(trimmed.to_string()))
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(koharu_app::app::project_summary(&session)))
}

// ---------------------------------------------------------------------------
// PUT /projects/current — open a managed project by id
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectRequest {
    /// `.khrproj/` directory basename (no extension). Must exist under the
    /// managed projects directory.
    pub id: String,
}

#[utoipa::path(
    put,
    path = "/projects/current",
    request_body = OpenProjectRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn put_current_project(
    State(app): State<AppState>,
    Json(req): Json<OpenProjectRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let config = (**app.config.load()).clone();
    let path = project_dirs::find_recent_project_path(&req.id)
        .or_else(|| project_dirs::project_path(&config, &req.id).ok())
        .ok_or_else(|| ApiError::bad_request("invalid project id"))?;
    if !path.exists() {
        return Err(ApiError::not_found(format!("project {}", req.id)));
    }
    let session = app
        .open_project(path, None)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(koharu_app::app::project_summary(&session)))
}

#[utoipa::path(delete, path = "/projects/current", responses((status = 204)))]
async fn delete_current_project(State(app): State<AppState>) -> ApiResult<axum::http::StatusCode> {
    app.close_project().await.map_err(ApiError::internal)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/projects/{id}", responses((status = 204)))]
async fn delete_project_by_id(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    let config = (**app.config.load()).clone();
    let path = project_dirs::find_recent_project_path(&id)
        .or_else(|| project_dirs::project_path(&config, &id).ok())
        .ok_or_else(|| ApiError::bad_request("invalid project id"))?;
    if path.exists() {
        if let Some(session) = app.current_session() {
            if session.dir == path {
                app.close_project().await.map_err(ApiError::internal)?;
            }
        }
        std::fs::remove_dir_all(path.as_std_path())
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;
    }

    // Also remove from recent projects!
    let _ = project_dirs::remove_recent_project(&path);

    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// PUT /projects/{id}/name — rename a project
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectRequest {
    pub name: String,
}

#[utoipa::path(
    put,
    path = "/projects/{id}/name",
    request_body = RenameProjectRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn rename_project(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RenameProjectRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let trimmed = req.name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("name must not be empty"));
    }
    let config = (**app.config.load()).clone();
    let path = project_dirs::find_recent_project_path(&id)
        .or_else(|| project_dirs::project_path(&config, &id).ok())
        .ok_or_else(|| ApiError::bad_request("invalid project id"))?;
    if !path.exists() {
        return Err(ApiError::not_found(format!("project {}", id)));
    }

    // 1. Update the project.toml
    let toml_path = path.join("project.toml");
    if toml_path.exists() {
        let text = std::fs::read_to_string(toml_path.as_std_path())
            .map_err(|e| ApiError::internal(anyhow::anyhow!("read project.toml: {e}")))?;

        let mut lines: Vec<String> = Vec::new();
        let mut name_updated = false;
        for line in text.lines() {
            let trimmed_line = line.trim();
            if trimmed_line.starts_with("name") && trimmed_line.contains('=') {
                let escaped_name = trimmed.replace('\\', "\\\\").replace('"', "\\\"");
                lines.push(format!("name = \"{escaped_name}\""));
                name_updated = true;
            } else {
                lines.push(line.to_string());
            }
        }
        if !name_updated {
            let escaped_name = trimmed.replace('\\', "\\\\").replace('"', "\\\"");
            lines.insert(0, format!("name = \"{escaped_name}\""));
        }
        let new_text = lines.join("\n");
        std::fs::write(toml_path.as_std_path(), new_text)
            .map_err(|e| ApiError::internal(anyhow::anyhow!("write project.toml: {e}")))?;
    }

    // 2. Is the project currently open in the active session?
    if let Some(session) = app.current_session() {
        if session.dir == path {
            // Apply the metadata change in the active session
            session
                .apply(koharu_core::Op::UpdateProjectMeta {
                    patch: koharu_core::ProjectMetaPatch {
                        name: Some(trimmed.to_string()),
                        ..Default::default()
                    },
                    prev: Default::default(),
                })
                .map_err(ApiError::internal)?;
            session.compact().map_err(ApiError::internal)?;
        }
    }

    let updated_at_ms = std::fs::metadata(path.as_std_path())
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let meta = koharu_app::projects::read_project_meta(&path);
    let project_type = if meta.manga_id.is_some() && !meta.manga_id.as_ref().unwrap().is_empty() {
        "downloaded".to_string()
    } else if meta.sync_dir.is_some() && !meta.sync_dir.as_ref().unwrap().is_empty() {
        "imported".to_string()
    } else {
        "manual".to_string()
    };
    let sync_dir = meta.sync_dir.clone();

    Ok(Json(ProjectSummary {
        id,
        name: trimmed.to_string(),
        path: path.to_string(),
        updated_at_ms,
        project_type: Some(project_type),
        sync_dir,
    }))
}

// ---------------------------------------------------------------------------
// POST /projects/import — extract an archive into a fresh allocated dir
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/projects/import",
    request_body(content_type = "application/zip"),
    responses((status = 200, body = ProjectSummary))
)]
async fn import_project(
    State(app): State<AppState>,
    body: Bytes,
) -> ApiResult<Json<ProjectSummary>> {
    if body.is_empty() {
        return Err(ApiError::bad_request("empty archive body"));
    }
    let config = (**app.config.load()).clone();
    let dest =
        project_dirs::allocate_imported(&config, Some("imported")).map_err(ApiError::internal)?;
    let body_vec = body.to_vec();
    let dest_c = dest.clone();
    tokio::task::spawn_blocking(move || koharu_app::archive::import_khr_bytes(&body_vec, &dest_c))
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
        .map_err(ApiError::internal)?;

    let session = app
        .open_project(dest, None)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(koharu_app::app::project_summary(&session)))
}

// ---------------------------------------------------------------------------
// POST /projects/import-directory — import a structured folder
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportDirectoryRequest {
    pub path: String,
}

#[utoipa::path(
    post,
    path = "/projects/import-directory",
    request_body = ImportDirectoryRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn import_directory(
    State(app): State<AppState>,
    Json(req): Json<ImportDirectoryRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let import_path = std::path::Path::new(&req.path);
    if !import_path.is_dir() {
        return Err(ApiError::bad_request(format!(
            "Not a valid directory: {}",
            req.path
        )));
    }

    let project_name = import_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| ApiError::bad_request("invalid directory path"))?
        .to_string();

    let config = (**app.config.load()).clone();
    let dest_path =
        project_dirs::allocate_named(&config, &project_name).map_err(ApiError::internal)?;
    let session = app
        .open_project(dest_path, Some(project_name.clone()))
        .await
        .map_err(ApiError::internal)?;

    // Set sync_dir metadata in ProjectMeta
    session
        .apply(koharu_core::Op::UpdateProjectMeta {
            patch: koharu_core::ProjectMetaPatch {
                name: None,
                style: None,
                updated_at: None,
                sync_dir: Some(Some(req.path.clone())),
                source_id: None,
                manga_id: None,
                manga_title: None,
            },
            prev: Default::default(),
        })
        .map_err(ApiError::internal)?;

    // List chapters
    let mut chapter_dirs = Vec::new();
    let entries = std::fs::read_dir(import_path)
        .map_err(|e| ApiError::bad_request(format!("Failed to read directory: {e}")))?;
    for entry in entries.flatten() {
        if let Ok(ftype) = entry.file_type() {
            if ftype.is_dir() {
                chapter_dirs.push(entry.path());
            }
        }
    }

    chapter_dirs.sort_by(|a, b| {
        let af = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let bf = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
        natord::compare(af, bf)
    });

    for (ch_idx, chapter_path) in chapter_dirs.into_iter().enumerate() {
        let chapter_name = chapter_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled Chapter")
            .to_string();
        let chapter_id = koharu_core::ChapterId::new();
        let now = Utc::now();
        let chapter = koharu_core::Chapter {
            id: chapter_id,
            name: chapter_name.clone(),
            order: ch_idx as u32,
            created_at: now,
            updated_at: now,
            page_ids: Vec::new(),
        };

        session
            .apply(koharu_core::Op::AddChapter { chapter })
            .map_err(ApiError::internal)?;

        let raw_dir = chapter_path.join("raw");
        let psd_dir = chapter_path.join("psd");
        let trans_dir = chapter_path.join("translated").join("vi-Vn");
        let _ = std::fs::create_dir_all(&raw_dir);
        let _ = std::fs::create_dir_all(&psd_dir);
        let _ = std::fs::create_dir_all(&trans_dir);

        let mut raw_files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&raw_dir) {
            for entry in entries.flatten() {
                if let Ok(ftype) = entry.file_type() {
                    if ftype.is_file() {
                        let path = entry.path();
                        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                            let ext_lower = ext.to_lowercase();
                            if ext_lower == "png"
                                || ext_lower == "jpg"
                                || ext_lower == "jpeg"
                                || ext_lower == "webp"
                                || ext_lower == "bmp"
                            {
                                raw_files.push(path);
                            }
                        }
                    }
                }
            }
        }

        raw_files.sort_by(|a, b| {
            let af = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let bf = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
            natord::compare(af, bf)
        });

        let blobs = session.blobs.clone();
        let decoded: Vec<(String, u32, u32, koharu_core::BlobRef)> =
            tokio::task::spawn_blocking(move || {
                raw_files
                    .into_par_iter()
                    .map(
                        |path| -> ApiResult<(String, u32, u32, koharu_core::BlobRef)> {
                            let filename = path
                                .file_name()
                                .and_then(|s| s.to_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "page.png".to_string());
                            let bytes = std::fs::read(&path).map_err(|e| {
                                ApiError::bad_request(format!("read `{filename}`: {e}"))
                            })?;
                            let img = image::load_from_memory(&bytes).map_err(|e| {
                                ApiError::bad_request(format!("decode `{filename}`: {e}"))
                            })?;
                            let (w, h) = img.dimensions();
                            let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
                            Ok((filename, w, h, blob))
                        },
                    )
                    .collect::<ApiResult<Vec<_>>>()
            })
            .await
            .map_err(|e| ApiError::internal(anyhow::anyhow!("import task panicked: {e}")))??;

        let mut ops = Vec::with_capacity(decoded.len());
        let starting_index = session.scene.read().pages.len();
        for (i, (filename, w, h, blob)) in decoded.into_iter().enumerate() {
            let mut page = koharu_core::Page::new(&filename, w, h);
            page.chapter_id = Some(chapter_id);
            let source_node_id = koharu_core::NodeId::new();
            page.nodes.insert(
                source_node_id,
                koharu_core::Node {
                    id: source_node_id,
                    transform: koharu_core::Transform::default(),
                    visible: true,
                    kind: koharu_core::NodeKind::Image(koharu_core::ImageData {
                        role: koharu_core::ImageRole::Source,
                        blob,
                        opacity: 1.0,
                        natural_width: w,
                        natural_height: h,
                        name: Some(filename),
                    }),
                },
            );
            ops.push(koharu_core::Op::AddPage {
                page,
                at: starting_index + i,
            });
        }

        if !ops.is_empty() {
            session
                .apply(koharu_core::Op::Batch {
                    ops,
                    label: format!("Import chapter {} pages", chapter_name),
                })
                .map_err(ApiError::internal)?;
        }
    }

    Ok(Json(koharu_app::app::project_summary(&session)))
}

// ---------------------------------------------------------------------------
// Export — returns bytes (zip when the format produces >1 file)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectRequest {
    pub format: ExportFormat,
    /// Optional subset of pages; defaults to every page.
    #[serde(default)]
    pub pages: Option<Vec<PageId>>,
    /// Optional global font override (from UI preferences).
    #[serde(default)]
    pub default_font: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// Whole project as a `.khr` archive (always a single zip).
    Khr,
    /// One `.psd` per page.
    Psd,
    /// One `.png` per page (the Rendered layer).
    Rendered,
    /// One `.png` per page (the Inpainted layer).
    Inpainted,
}

#[utoipa::path(
    post,
    path = "/projects/current/export",
    request_body = ExportProjectRequest,
    responses((
        status = 200,
        content_type = "application/octet-stream",
        description = "Export bytes. Content-Type is `application/zip` when the format produces multiple files."
    ))
)]
async fn export_current_project(
    State(app): State<AppState>,
    Json(req): Json<ExportProjectRequest>,
) -> ApiResult<Response> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;

    let s_for_compact = session.clone();
    tokio::task::spawn_blocking(move || s_for_compact.compact())
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
        .map_err(ApiError::internal)?;

    let project_name = session.scene.read().project.name.clone();

    match req.format {
        ExportFormat::Khr => {
            let src = session.dir.clone();
            let bytes =
                tokio::task::spawn_blocking(move || koharu_app::archive::export_khr_bytes(&src))
                    .await
                    .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
                    .map_err(ApiError::internal)?;
            Ok(bytes_response(
                bytes,
                &sanitize(&project_name, "project"),
                "khr",
                "application/octet-stream",
            ))
        }
        ExportFormat::Psd => {
            let page_ids = resolve_page_ids(&session, req.pages.as_deref())?;
            if page_ids.is_empty() {
                return Err(ApiError::bad_request("no pages in selection"));
            }
            let session_c = session.clone();
            let page_ids_c = page_ids.clone();
            let renderer_c = app.renderer.clone();
            let default_font_c = req.default_font.clone();
            let files = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                let mut out = Vec::with_capacity(page_ids_c.len());
                let sync_dir = {
                    let scene = session_c.scene.read();
                    scene.project.sync_dir.clone()
                };
                for (i, id) in page_ids_c.iter().enumerate() {
                    let bytes = crate::psd_export::psd_bytes_for_page(
                        &session_c,
                        &renderer_c,
                        default_font_c.clone(),
                        *id,
                    )?;
                    if let Some(ref s_dir) = sync_dir {
                        let scene = session_c.scene.read();
                        if let Some(page) = scene.pages.get(id) {
                            let chapter_name = page
                                .chapter_id
                                .and_then(|ch_id| scene.chapters.get(&ch_id))
                                .map(|ch| ch.name.as_str())
                                .unwrap_or("Untitled Chapter");
                            let page_stem = std::path::Path::new(&page.name)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or(&page.name);
                            let target_dir =
                                std::path::Path::new(s_dir).join(chapter_name).join("psd");
                            let _ = std::fs::create_dir_all(&target_dir);
                            let target_path = target_dir.join(format!("{}.psd", page_stem));
                            let _ = std::fs::write(&target_path, &bytes);
                        }
                    }
                    out.push((format!("page-{:03}-{id}.psd", i + 1), bytes));
                }
                Ok(out)
            })
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
            .map_err(ApiError::internal)?;
            Ok(files_to_response(files, &project_name, "psd")?)
        }
        ExportFormat::Rendered => {
            export_image_role(
                &session,
                req.pages.as_deref(),
                ImageRole::Rendered,
                &project_name,
            )
            .await
        }
        ExportFormat::Inpainted => {
            export_image_role(
                &session,
                req.pages.as_deref(),
                ImageRole::Inpainted,
                &project_name,
            )
            .await
        }
    }
}

async fn export_image_role(
    session: &std::sync::Arc<koharu_app::ProjectSession>,
    pages: Option<&[PageId]>,
    role: ImageRole,
    project_name: &str,
) -> ApiResult<Response> {
    let page_ids = resolve_page_ids(session, pages)?;
    if page_ids.is_empty() {
        return Err(ApiError::bad_request("no pages in selection"));
    }
    let session_c = session.clone();
    let page_ids_c = page_ids.clone();
    let files = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let mut out: Vec<(String, Vec<u8>)> = Vec::new();
        let sync_dir = {
            let scene = session_c.scene.read();
            scene.project.sync_dir.clone()
        };
        for (i, id) in page_ids_c.iter().enumerate() {
            if let Some(bytes) = crate::psd_export::png_bytes_for_page(&session_c, *id, role)? {
                if role == ImageRole::Rendered {
                    if let Some(ref s_dir) = sync_dir {
                        let scene = session_c.scene.read();
                        if let Some(page) = scene.pages.get(id) {
                            let chapter_name = page
                                .chapter_id
                                .and_then(|ch_id| scene.chapters.get(&ch_id))
                                .map(|ch| ch.name.as_str())
                                .unwrap_or("Untitled Chapter");
                            let page_stem = std::path::Path::new(&page.name)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or(&page.name);
                            let target_dir = std::path::Path::new(s_dir)
                                .join(chapter_name)
                                .join("translated")
                                .join("vi-Vn");
                            let _ = std::fs::create_dir_all(&target_dir);
                            let target_path = target_dir.join(format!("{}.png", page_stem));
                            let _ = std::fs::write(&target_path, &bytes);
                        }
                    }
                }
                out.push((format!("page-{:03}-{id}.png", i + 1), bytes));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
    .map_err(ApiError::internal)?;

    if files.is_empty() {
        return Err(ApiError::bad_request(
            "no pages have the requested layer populated",
        ));
    }
    files_to_response(files, project_name, role_ext(role))
}

fn resolve_page_ids(
    session: &koharu_app::ProjectSession,
    requested: Option<&[PageId]>,
) -> ApiResult<Vec<PageId>> {
    let scene = session.scene.read();
    match requested {
        None => Ok(scene.pages.keys().copied().collect()),
        Some(ids) => {
            for id in ids {
                if !scene.pages.contains_key(id) {
                    return Err(ApiError::not_found(format!("page {id}")));
                }
            }
            Ok(ids.to_vec())
        }
    }
}

fn role_ext(role: ImageRole) -> &'static str {
    match role {
        ImageRole::Rendered => "png",
        ImageRole::Inpainted => "png",
        ImageRole::Source => "png",
        ImageRole::Custom => "png",
    }
}

fn files_to_response(
    mut files: Vec<(String, Vec<u8>)>,
    project_name: &str,
    ext: &str,
) -> ApiResult<Response> {
    if files.len() == 1 {
        let (fname, bytes) = files.remove(0);
        let content_type = match ext {
            "psd" => "image/vnd.adobe.photoshop",
            "png" => "image/png",
            "khr" => "application/octet-stream",
            _ => "application/octet-stream",
        };
        return Ok(bytes_response_with_filename(bytes, &fname, content_type));
    }
    let zip_bytes = koharu_app::archive::zip_files_to_bytes(&files).map_err(ApiError::internal)?;
    let base = sanitize(project_name, "export");
    let filename = format!("{base}-{ext}.zip");
    Ok(bytes_response_with_filename(
        zip_bytes,
        &filename,
        "application/zip",
    ))
}

fn bytes_response(bytes: Vec<u8>, base: &str, ext: &str, content_type: &str) -> Response {
    let filename = format!("{base}.{ext}");
    bytes_response_with_filename(bytes, &filename, content_type)
}

fn bytes_response_with_filename(bytes: Vec<u8>, filename: &str, content_type: &str) -> Response {
    let cd = format!("attachment; filename=\"{filename}\"");
    let mut resp = Response::new(Body::from(bytes));
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(v) = HeaderValue::from_str(&cd) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    resp.into_response()
}

fn sanitize(name: &str, fallback: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}
