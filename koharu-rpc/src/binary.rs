//! Byte-oriented reads.
//!
//! - `GET /scene.bin` — postcard-encoded `Snapshot { epoch, scene }` (native clients).
//! - `GET /scene.json` — JSON-encoded `{ epoch, scene }` (web/UI clients).
//! - `GET /blobs/:hash` — raw blob bytes.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use image::{DynamicImage, GenericImageView, imageops::FilterType};
use koharu_core::{BlobRef, ImageRole, NodeKind, PageId, Scene};
use serde::Serialize;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::{ApiError, ApiResult};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(get_scene_bin))
        .routes(routes!(get_scene_json))
        .routes(routes!(get_blob))
        .routes(routes!(get_page_thumbnail))
}

/// JSON-shaped scene snapshot for the UI (no postcard decoder in JS).
#[derive(Serialize, utoipa::ToSchema)]
pub struct SceneSnapshot {
    pub epoch: u64,
    pub scene: Scene,
}

#[utoipa::path(
    get,
    path = "/scene.json",
    responses((status = 200, body = SceneSnapshot))
)]
async fn get_scene_json(State(app): State<AppState>) -> ApiResult<Json<SceneSnapshot>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    let _ = auto_detect_new_chapters(&session);
    let scene = session.scene.read().clone();
    let epoch = session.epoch();
    Ok(Json(SceneSnapshot { epoch, scene }))
}

#[derive(Serialize)]
struct WireSnapshot<'a> {
    epoch: u64,
    scene: &'a koharu_core::Scene,
}

#[utoipa::path(
    get,
    path = "/scene.bin",
    responses((status = 200, content_type = "application/octet-stream"))
)]
async fn get_scene_bin(State(app): State<AppState>) -> ApiResult<Response> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    let _ = auto_detect_new_chapters(&session);
    let (epoch, bytes) = {
        let scene = session.scene.read();
        let epoch = session.epoch();
        let bytes = postcard::to_allocvec(&WireSnapshot {
            epoch,
            scene: &scene,
        })
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;
        (epoch, bytes)
    };
    let mut resp = Response::new(Body::from(bytes));
    resp.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    resp.headers_mut().insert(
        "x-koharu-epoch",
        HeaderValue::from_str(&epoch.to_string())
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?,
    );
    Ok(resp)
}

#[utoipa::path(
    get,
    path = "/blobs/{hash}",
    params(("hash" = String, Path, description = "Blake3 hash of the blob")),
    responses((status = 200, content_type = "application/octet-stream"))
)]
async fn get_blob(State(app): State<AppState>, Path(hash): Path<String>) -> ApiResult<Response> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    let blob_ref = BlobRef::new(hash);
    let bytes = session
        .blobs
        .get_bytes(&blob_ref)
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "blob not found"))?;
    let mut resp = Response::new(Body::from(bytes));
    resp.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(resp.into_response())
}

/// Thumbnail of a page's source image. Cached on disk under
/// `.khrproj/cache/thumbs/<page_id>.webp`; generated on first request.
const THUMB_MAX_DIM: u32 = 320;

#[utoipa::path(
    get,
    path = "/pages/{id}/thumbnail",
    params(("id" = PageId, Path, description = "Page id")),
    responses((status = 200, content_type = "image/webp"))
)]
async fn get_page_thumbnail(
    State(app): State<AppState>,
    Path(id): Path<PageId>,
) -> ApiResult<Response> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;

    // Fast path: cached file on disk.
    let thumbs_dir = session.dir.join("cache").join("thumbs");
    let cache_path = thumbs_dir.join(format!("{id}.webp"));
    if cache_path.exists()
        && let Ok(bytes) = std::fs::read(cache_path.as_std_path())
    {
        return Ok(webp_response(bytes));
    }

    // Slow path: load the page's Source image, downscale, encode, cache.
    let source_ref = {
        let scene = session.scene.read();
        let page = scene
            .page(id)
            .ok_or_else(|| ApiError::not_found(format!("page {id}")))?;
        page.nodes
            .values()
            .find_map(|n| match &n.kind {
                NodeKind::Image(img) if img.role == ImageRole::Source => Some(img.blob.clone()),
                _ => None,
            })
            .ok_or_else(|| ApiError::not_found("page has no source image"))?
    };
    let source: DynamicImage = session
        .blobs
        .load_image(&source_ref)
        .map_err(ApiError::internal)?;
    let (w, h) = source.dimensions();
    let scale = THUMB_MAX_DIM as f32 / w.max(h) as f32;
    let resized = if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        source.resize(nw, nh, FilterType::Triangle)
    } else {
        source
    };
    let mut buf = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut buf, image::ImageFormat::WebP)
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;
    let bytes = buf.into_inner();
    let _ = std::fs::create_dir_all(thumbs_dir.as_std_path());
    let _ = std::fs::write(cache_path.as_std_path(), &bytes);
    Ok(webp_response(bytes))
}

fn webp_response(bytes: Vec<u8>) -> Response {
    let mut resp = Response::new(Body::from(bytes));
    resp.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    resp.into_response()
}

pub fn auto_detect_new_chapters(session: &std::sync::Arc<koharu_app::ProjectSession>) -> anyhow::Result<()> {
    let sync_dir = {
        let scene = session.scene.read();
        scene.project.sync_dir.clone()
    };
    let Some(sync_path_str) = sync_dir else {
        return Ok(());
    };
    let import_path = std::path::Path::new(&sync_path_str);
    if !import_path.is_dir() {
        return Ok(());
    }

    // List existing chapter names
    let existing_names: std::collections::HashSet<String> = {
        let scene = session.scene.read();
        scene.chapters.values().map(|c| c.name.clone()).collect()
    };

    // Scan subdirectories
    let mut new_chapter_dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(import_path) {
        for entry in entries.flatten() {
            if let Ok(ftype) = entry.file_type() {
                if ftype.is_dir() {
                    let dir_path = entry.path();
                    if let Some(name) = dir_path.file_name().and_then(|s| s.to_str()) {
                        if !existing_names.contains(name) {
                            new_chapter_dirs.push(dir_path);
                        }
                    }
                }
            }
        }
    }

    if new_chapter_dirs.is_empty() {
        return Ok(());
    }

    // Sort naturally
    new_chapter_dirs.sort_by(|a, b| {
        let af = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let bf = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
        natord::compare(af, bf)
    });

    for chapter_path in new_chapter_dirs {
        let chapter_name = chapter_path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled Chapter")
            .to_string();

        let chapter_id = koharu_core::ChapterId::new();
        let now = chrono::Utc::now();
        
        let order = {
            let scene = session.scene.read();
            scene.chapters.len() as u32
        };

        let chapter = koharu_core::Chapter {
            id: chapter_id,
            name: chapter_name.clone(),
            order,
            created_at: now,
            updated_at: now,
            page_ids: Vec::new(),
        };

        // Apply chapter addition immediately so page additions can reference the chapter
        session.apply(koharu_core::Op::AddChapter { chapter })?;

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
                            if ext_lower == "png" || ext_lower == "jpg" || ext_lower == "jpeg" || ext_lower == "webp" {
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
        let starting_index = {
            let scene = session.scene.read();
            scene.pages.len()
        };

        let mut page_ops = Vec::new();
        for (i, file_path) in raw_files.into_iter().enumerate() {
            if let Ok(bytes) = std::fs::read(&file_path) {
                if let Ok(img) = image::load_from_memory(&bytes) {
                    let (w, h) = img.dimensions();
                    let filename = file_path.file_name().and_then(|s| s.to_str()).unwrap_or("image.png").to_string();
                    if let Ok(blob) = blobs.put_bytes(&bytes) {
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

                        page_ops.push(koharu_core::Op::AddPage {
                            page,
                            at: starting_index + i,
                        });
                    }
                }
            }
        }

        if !page_ops.is_empty() {
            session.apply(koharu_core::Op::Batch {
                ops: page_ops,
                label: format!("Import pages for chapter {chapter_name}"),
            })?;
        }
    }

    // Save project scene.bin
    session.compact()?;
    Ok(())
}
