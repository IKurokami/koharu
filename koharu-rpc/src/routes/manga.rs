//! Manga search and downloading integration.
//! Supports MangaDex, NetTruyen, BlogTruyen, and HaruNeko connector sources.
//! Prioritizes storing chapters and downloaded images physically in the project folder structure.

use crate::AppState;
use crate::error::{ApiError, ApiResult};
use axum::Json;
use axum::extract::{Query, State};
use chrono::Utc;
use image::GenericImageView;
use koharu_app::projects as project_dirs;
use koharu_core::{
    Chapter, ChapterId, ImageData, ImageRole, Node, NodeId, NodeKind, Op, Page, ProjectSummary,
};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use utoipa_axum::{router::OpenApiRouter, routes};
use zip::ZipArchive;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(list_manga_sources))
        .routes(routes!(get_source_icon))
        .routes(routes!(search_manga))
        .routes(routes!(list_manga_chapters))
        .routes(routes!(create_manga_project))
        .routes(routes!(download_manga_chapter))
        .routes(routes!(clone_connectors))
        .routes(routes!(install_git))
}

// ---------------------------------------------------------------------------
// Structs & Schemas
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MangaSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub description: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MangaSearchResult {
    pub id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MangaChapterListResponse {
    pub chapters: Vec<MangaChapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MangaChapter {
    pub id: String,
    pub name: String,
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMangaProjectRequest {
    pub source_id: String,
    pub manga_id: String,
    pub manga_title: String,
    pub custom_save_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMangaChapterRequest {
    pub source_id: String,
    pub manga_id: String,
    pub chapter_id: String,
    pub chapter_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMangaQuery {
    pub source_id: String,
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListChaptersQuery {
    pub source_id: String,
    pub manga_id: String,
}

// ---------------------------------------------------------------------------
// GET /manga/sources
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn parse_connector_file(file_path: &std::path::Path) -> Option<MangaSource> {
    let content = std::fs::read_to_string(file_path).ok()?;

    // Find "super(" or "super ("
    let super_idx = content.find("super(").or_else(|| content.find("super ("))?;
    let start_idx = content[super_idx..].find('(')? + super_idx + 1;
    let end_idx = content[start_idx..].find(')')? + start_idx;

    let args_str = &content[start_idx..end_idx];
    let parts: Vec<&str> = args_str.split(',').collect();
    if parts.len() < 3 {
        return None;
    }

    let clean_quote =
        |s: &str| -> String { s.trim().trim_matches(|c| c == '\'' || c == '"').to_string() };

    let id = clean_quote(parts[0]);
    let name = clean_quote(parts[1]);
    let url = clean_quote(parts[2]);

    if id.is_empty() || name.is_empty() || url.is_empty() {
        return None;
    }

    // Skip abstract parameters/base classes (e.g. super(id, name, url))
    if id == "id" || name == "name" || url == "url" {
        return None;
    }

    let description = format!("Nguồn truyện dịch từ {}", name);
    let encoded_id =
        percent_encoding::utf8_percent_encode(&id, percent_encoding::NON_ALPHANUMERIC).to_string();
    let icon_url = Some(format!("/api/v1/manga/sources/{}/icon", encoded_id));

    Some(MangaSource {
        id,
        name,
        url,
        description,
        icon_url,
    })
}

#[utoipa::path(
    get,
    path = "/manga/sources",
    responses((status = 200, body = Vec<MangaSource>))
)]
async fn list_manga_sources(State(app): State<AppState>) -> ApiResult<Json<Vec<MangaSource>>> {
    let mut sources = vec![MangaSource {
        id: "mangadex".to_string(),
        name: "MangaDex".to_string(),
        url: "https://mangadex.org".to_string(),
        description: "Nguồn truyện gốc quốc tế chất lượng cao, dữ liệu thật 100%.".to_string(),
        icon_url: Some("/api/v1/manga/sources/mangadex/icon".to_string()),
    }];

    let config = (**app.config.load()).clone();
    let repo_dir = config.data.path.join("haruneko_repo");
    let websites_dir = repo_dir
        .join("web")
        .join("src")
        .join("engine")
        .join("websites");

    if websites_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(websites_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "ts") {
                    if let Some(mut source) = parse_connector_file(&path) {
                        // Avoid duplicates
                        if !sources.iter().any(|s| s.id == source.id) {
                            if source.id == "nettruyen" {
                                source.description =
                                    "Nguồn truyện dịch lớn nhất Việt Nam, cập nhật nhanh."
                                        .to_string();
                            } else if source.id == "blogtruyen" {
                                source.description =
                                    "Diễn đàn dịch truyện tranh lâu đời, cộng đồng lớn."
                                        .to_string();
                            } else if source.id == "truyenqq" {
                                source.description =
                                    "Nguồn truyện chất lượng cao, giao diện thân thiện."
                                        .to_string();
                            }
                            let encoded_id = percent_encoding::utf8_percent_encode(
                                &source.id,
                                percent_encoding::NON_ALPHANUMERIC,
                            )
                            .to_string();
                            source.icon_url =
                                Some(format!("/api/v1/manga/sources/{}/icon", encoded_id));
                            sources.push(source);
                        }
                    }
                }
            }
        }
    }

    // Default static fallbacks to guarantee nettruyen and blogtruyen are always available
    let defaults = vec![
        MangaSource {
            id: "nettruyen".to_string(),
            name: "NetTruyen".to_string(),
            url: "https://www.nettruyennew.com".to_string(),
            description: "Nguồn truyện dịch lớn nhất Việt Nam, cập nhật nhanh. (Hỗ trợ tìm kiếm dán thẳng link truyện)".to_string(),
            icon_url: Some("/api/v1/manga/sources/nettruyen/icon".to_string()),
        },
        MangaSource {
            id: "blogtruyen".to_string(),
            name: "BlogTruyen".to_string(),
            url: "https://blogtruyen.vn".to_string(),
            description: "Diễn đàn dịch truyện tranh lâu đời, cộng đồng lớn. (Hỗ trợ tìm kiếm dán thẳng link truyện)".to_string(),
            icon_url: Some("/api/v1/manga/sources/blogtruyen/icon".to_string()),
        },
    ];

    for default_src in defaults {
        if !sources.iter().any(|s| s.id == default_src.id) {
            sources.push(default_src);
        }
    }

    Ok(Json(sources))
}

// ---------------------------------------------------------------------------
// GET /manga/sources/{id}/icon
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/manga/sources/{id}/icon",
    params(
        ("id" = String, Path, description = "Manga source ID")
    ),
    responses(
        (status = 200, description = "Returns the source icon", content_type = "image/png"),
        (status = 307, description = "Redirects to external favicon fallback")
    )
)]
async fn get_source_icon(
    State(app): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl axum::response::IntoResponse {
    use axum::response::IntoResponse;
    let config = (**app.config.load()).clone();
    let repo_dir = config.data.path.join("haruneko_repo");
    let websites_dir = repo_dir
        .join("web")
        .join("src")
        .join("engine")
        .join("websites");

    // 1. Try to find the local connector's direct webp/png icon from websites directory
    if websites_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&websites_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "ts") {
                    if let Some(source) = parse_connector_file(&path) {
                        if source.id == id {
                            // Check for same-named webp icon next to the ts connector
                            let webp_path = path.with_extension("webp");
                            if webp_path.exists() && webp_path.is_file() {
                                if let Ok(bytes) = std::fs::read(&webp_path) {
                                    return (
                                        [(axum::http::header::CONTENT_TYPE, "image/webp")],
                                        bytes,
                                    )
                                        .into_response();
                                }
                            }

                            let png_path = path.with_extension("png");
                            if png_path.exists() && png_path.is_file() {
                                if let Ok(bytes) = std::fs::read(&png_path) {
                                    return (
                                        [(axum::http::header::CONTENT_TYPE, "image/png")],
                                        bytes,
                                    )
                                        .into_response();
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Try target-matching case-insensitively directly in the websites directory
    // (e.g. "nettruyen" -> "NetTruyen.webp")
    if websites_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&websites_dir) {
            let target_lower = id.to_lowercase();
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if stem.to_lowercase() == target_lower {
                            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                            if ext == "webp"
                                || ext == "png"
                                || ext == "jpg"
                                || ext == "jpeg"
                                || ext == "ico"
                            {
                                if let Ok(bytes) = std::fs::read(&path) {
                                    let content_type = match ext {
                                        "webp" => "image/webp",
                                        "png" => "image/png",
                                        "jpg" | "jpeg" => "image/jpeg",
                                        "ico" => "image/x-icon",
                                        _ => "image/png",
                                    };
                                    return (
                                        [(axum::http::header::CONTENT_TYPE, content_type)],
                                        bytes,
                                    )
                                        .into_response();
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback: Resolve website's online favicon!
    let mut url_opt: Option<String> = None;

    // Check defaults first
    let defaults = vec![
        ("mangadex", "https://mangadex.org"),
        ("nettruyen", "https://www.nettruyennew.com"),
        ("blogtruyen", "https://blogtruyen.vn"),
        ("truyenqq", "https://truyenqqvip.com"),
    ];
    for (d_id, d_url) in defaults {
        if d_id == id {
            url_opt = Some(d_url.to_string());
            break;
        }
    }

    if url_opt.is_none() {
        if websites_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&websites_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if path.is_file() && path.extension().map_or(false, |ext| ext == "ts") {
                        if let Some(source) = parse_connector_file(&path) {
                            if source.id == id {
                                url_opt = Some(source.url);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let fallback_url = if let Some(url_str) = url_opt {
        if let Ok(parsed) = url::Url::parse(&url_str) {
            if let Some(host) = parsed.host_str() {
                format!("https://www.google.com/s2/favicons?sz=64&domain={}", host)
            } else {
                "https://mangadex.org/favicon.ico".to_string()
            }
        } else {
            "https://mangadex.org/favicon.ico".to_string()
        }
    } else {
        "https://mangadex.org/favicon.ico".to_string()
    };

    axum::response::Redirect::temporary(&fallback_url).into_response()
}

fn extract_meta_content(html: &str, key: &str) -> Option<String> {
    let mut idx = 0;
    while let Some(match_idx) = html[idx..].find(key) {
        let absolute_match_idx = idx + match_idx;
        if let Some(tag_start) = html[..absolute_match_idx].rfind("<meta") {
            if let Some(tag_end_offset) = html[tag_start..].find('>') {
                let tag_content = &html[tag_start..tag_start + tag_end_offset];
                if let Some(content_idx) = tag_content.find("content=") {
                    let quote_char = tag_content[content_idx + 8..].chars().next()?;
                    if quote_char == '"' || quote_char == '\'' {
                        let start = content_idx + 9;
                        if let Some(end) = tag_content[start..].find(quote_char) {
                            return Some(tag_content[start..start + end].to_string());
                        }
                    }
                }
            }
        }
        idx = absolute_match_idx + key.len();
    }
    None
}

fn extract_title_tag(html: &str) -> Option<String> {
    let start = html.find("<title>")? + 7;
    let end = html[start..].find("</title>")?;
    Some(html[start..start + end].trim().to_string())
}

fn strip_html_tags(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }
    }
    result.replace('\n', " ").trim().to_string()
}

fn extract_token_from_html(html: &str) -> Option<String> {
    if let Some(token_pos) = html.find("name=\"token\"") {
        let after_token = &html[token_pos..];
        if let Some(val_pos) = after_token.find("value=\"") {
            let start = val_pos + 7;
            if let Some(end_pos) = after_token[start..].find('"') {
                return Some(after_token[start..start + end_pos].to_string());
            }
        }
    }
    None
}

fn extract_cookies_into_map(
    resp: &reqwest::Response,
    cookie_map: &mut std::collections::HashMap<String, String>,
) {
    for header in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(cookie_str) = header.to_str() {
            if let Some(first_part) = cookie_str.split(';').next() {
                let clean = first_part.trim();
                if !clean.is_empty() {
                    if let Some(pos) = clean.find('=') {
                        let name = clean[..pos].trim().to_string();
                        let value = clean[pos + 1..].trim().to_string();
                        cookie_map.insert(name, value);
                    }
                }
            }
        }
    }
}

fn build_cookie_header(cookie_map: &std::collections::HashMap<String, String>) -> String {
    cookie_map
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<String>>()
        .join("; ")
}

fn extract_chapters_html(html: &str, base_domain: &str, manga_url: &str) -> Vec<MangaChapter> {
    let mut chapters = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    let mut idx = 0;
    let mut order = 1;

    let base_url = url::Url::parse(manga_url).ok();
    let clean_manga_path = base_url
        .as_ref()
        .map(|u| u.path().trim_matches('/').to_string())
        .unwrap_or_default();

    while let Some(tag_start) = html[idx..].find("<a") {
        let abs_start = idx + tag_start;
        if let Some(tag_end) = html[abs_start..].find('>') {
            let tag_end_abs = abs_start + tag_end;
            let tag_str = &html[abs_start..tag_end_abs];

            if let Some(href_idx) = tag_str.find("href=") {
                let rest_href = &tag_str[href_idx + 5..];
                if let Some(quote_char) = rest_href.chars().next() {
                    if quote_char == '"' || quote_char == '\'' {
                        if let Some(end_quote) = rest_href[1..].find(quote_char) {
                            let href = rest_href[1..1 + end_quote].trim().to_string();

                            let resolved_href = if let Some(ref base) = base_url {
                                base.join(&href).map(|u| u.to_string()).unwrap_or_else(|_| {
                                    if href.starts_with('/') {
                                        format!("https://{}{}", base_domain, href)
                                    } else {
                                        href.clone()
                                    }
                                })
                            } else if href.starts_with('/') {
                                format!("https://{}{}", base_domain, href)
                            } else {
                                href.clone()
                            };

                            let href_lower = resolved_href.to_lowercase();
                            let is_chap = href_lower.contains("/chap")
                                || href_lower.contains("/chuong")
                                || href_lower.contains("/chapter")
                                || href_lower.contains("/chapitre")
                                || href_lower.contains("/capitulo")
                                || href_lower.contains("/ch-")
                                || href_lower.contains("/c-")
                                || href_lower.contains("/ch/")
                                || href_lower.contains("/c/")
                                || href_lower.contains("/ep-")
                                || href_lower.contains("/ep/")
                                || href_lower.contains("/episode")
                                || (!clean_manga_path.is_empty() && {
                                    if let Ok(u) = url::Url::parse(&resolved_href) {
                                        let clean_href_path = u.path().trim_matches('/');
                                        let parts: Vec<&str> = clean_href_path.split('/').collect();
                                        let n = parts.len();
                                        n >= 2
                                            && parts[0..n - 1].join("/") == clean_manga_path
                                            && !parts[n - 1].is_empty()
                                            && parts[n - 1].chars().all(|c| c.is_ascii_digit())
                                    } else {
                                        false
                                    }
                                });

                            let tag_lower = tag_str.to_lowercase();
                            let is_ignored = tag_lower.contains("btn-danger")
                                || tag_lower.contains("btn-md")
                                || tag_lower.contains("last-chapter")
                                || tag_lower.contains("last chapter")
                                || tag_lower.contains("latest chapter");

                            if is_chap && !is_ignored && !seen_urls.contains(&resolved_href) {
                                seen_urls.insert(resolved_href.clone());

                                let mut name = format!("Chapter {}", order);
                                if let Some(close_tag_start) = html[tag_end_abs..].find("</a>") {
                                    let text =
                                        html[tag_end_abs..tag_end_abs + close_tag_start].trim();

                                    let mut extracted_name = None;
                                    for marker in &["chapter-name", "chapter-title"] {
                                        if let Some(marker_pos) = text.find(marker) {
                                            let after_marker = &text[marker_pos..];
                                            if let Some(div_close_start) = after_marker.find('>') {
                                                let start = marker_pos + div_close_start + 1;
                                                if let Some(div_close_end) =
                                                    text[start..].find("</div>")
                                                {
                                                    let inner_text =
                                                        text[start..start + div_close_end].trim();
                                                    let clean_inner = strip_html_tags(inner_text);
                                                    if !clean_inner.is_empty() {
                                                        extracted_name = Some(clean_inner);
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    if extracted_name.is_none() {
                                        let clean_text = strip_html_tags(text);
                                        if !clean_text.is_empty() && clean_text.len() < 100 {
                                            extracted_name = Some(clean_text);
                                        }
                                    }

                                    if let Some(clean) = extracted_name {
                                        name = clean;
                                    }
                                }

                                chapters.push(MangaChapter {
                                    id: resolved_href,
                                    name,
                                    order,
                                });
                                order += 1;
                            }
                        }
                    }
                }
            }
            idx = tag_end_abs;
        } else {
            idx = abs_start + 2;
        }
    }
    chapters
}

fn decode_maybe_base64(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with('/')
        || trimmed.starts_with("//")
    {
        return trimmed.to_string();
    }
    use base64::Engine as _;
    if let Ok(decoded_bytes) = base64::engine::general_purpose::STANDARD.decode(trimmed) {
        if let Ok(decoded_str) = String::from_utf8(decoded_bytes) {
            let decoded_trimmed = decoded_str.trim().to_string();
            if decoded_trimmed.starts_with("http://")
                || decoded_trimmed.starts_with("https://")
                || decoded_trimmed.starts_with('/')
                || decoded_trimmed.trimmed_starts_with_any()
            {
                return decoded_trimmed;
            }
            if !decoded_trimmed.is_empty() {
                return decoded_trimmed;
            }
        }
    }
    trimmed.to_string()
}

trait StrUrlExt {
    fn trimmed_starts_with_any(&self) -> bool;
}
impl StrUrlExt for String {
    fn trimmed_starts_with_any(&self) -> bool {
        let t = self.trim();
        t.starts_with("http://")
            || t.starts_with("https://")
            || t.starts_with('/')
            || t.starts_with("//")
    }
}

fn extract_images_html(html: &str, base_domain: &str, chapter_url: &str) -> Vec<String> {
    let mut images = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    let mut idx = 0;

    let is_weloma = chapter_url.contains("weloma.art");

    while let Some(tag_start) = html[idx..].find('<') {
        let abs_start = idx + tag_start;
        let rest = &html[abs_start..];
        if rest.starts_with("<img") || rest.starts_with("<source") || rest.starts_with("<div") {
            if let Some(tag_end) = rest.find('>') {
                let tag_end_abs = abs_start + tag_end;
                let tag_str = &html[abs_start..tag_end_abs];

                if is_weloma && !tag_str.contains("chapter-img") {
                    idx = tag_end_abs;
                    continue;
                }

                let mut img_url = None;
                for attr in &[
                    "data-original=",
                    "data-src=",
                    "data-img=",
                    "data-srcset=",
                    "data-aload=",
                    "data-pagespeed-lazy-src=",
                    "data-lazy-src=",
                    "data-lazy-load-src=",
                    "data-actual-src=",
                    "data-echo=",
                    "data-lazy=",
                    "src=",
                ] {
                    if let Some(attr_idx) = tag_str.find(attr) {
                        let rest_attr = &tag_str[attr_idx + attr.len()..];
                        if let Some(quote_char) = rest_attr.chars().next() {
                            if quote_char == '"' || quote_char == '\'' {
                                if let Some(end_quote) = rest_attr[1..].find(quote_char) {
                                    let url_str = rest_attr[1..1 + end_quote].trim().to_string();
                                    if !url_str.is_empty() {
                                        let decoded = decode_maybe_base64(&url_str);
                                        if !decoded.is_empty() {
                                            img_url = Some(decoded);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if let Some(url) = img_url {
                    let resolved_url = if let Ok(base) = url::Url::parse(chapter_url) {
                        base.join(&url).map(|u| u.to_string()).unwrap_or_else(|_| {
                            if url.starts_with('/') {
                                format!("https://{}{}", base_domain, url)
                            } else if url.starts_with("//") {
                                format!("https:{}", url)
                            } else {
                                url
                            }
                        })
                    } else if url.starts_with('/') {
                        format!("https://{}{}", base_domain, url)
                    } else if url.starts_with("//") {
                        format!("https:{}", url)
                    } else {
                        url
                    };

                    let url_lower = resolved_url.to_lowercase();
                    let ignore = url_lower.contains("logo")
                        || url_lower.contains("banner")
                        || url_lower.contains("avatar")
                        || url_lower.contains("icon")
                        || url_lower.contains("loading")
                        || url_lower.contains("advertisement")
                        || url_lower.contains("fb-")
                        || url_lower.contains("facebook")
                        || url_lower.contains("donate")
                        || url_lower.contains("3282f6a4b7_o");

                    if !ignore && !seen_urls.contains(&resolved_url) {
                        seen_urls.insert(resolved_url.clone());
                        images.push(resolved_url);
                    }
                }

                idx = tag_end_abs;
            } else {
                idx = abs_start + 4;
            }
        } else {
            idx = abs_start + 1;
        }
    }
    images
}

fn extract_uuid(query: &str) -> Option<String> {
    for part in query.split('/') {
        let clean = part.trim();
        if clean.len() == 36
            && clean.chars().enumerate().all(|(i, c)| {
                if i == 8 || i == 13 || i == 18 || i == 23 {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Some(clean.to_string());
        }
    }
    None
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&#8211;", "–")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn clean_manga_title(title: &str) -> String {
    let decoded = decode_html_entities(title);
    let mut cleaned = decoded.trim().to_string();

    // List of common suffixes to strip from the title
    let suffixes = [
        " - NetTruyen",
        " - BlogTruyen",
        " - MangaDex",
        " - TruyenQQ",
        " | NetTruyen",
        " | BlogTruyen",
        " | MangaDex",
        " | TruyenQQ",
        " – Nguồn manga",
        " - Nguồn manga",
        " – Nguồn truyện",
        " - Nguồn truyện",
        " - NetTruyen.com",
        " - BlogTruyen.vn",
    ];

    for suffix in &suffixes {
        if let Some(idx) = cleaned.to_lowercase().rfind(&suffix.to_lowercase()) {
            cleaned.truncate(idx);
            cleaned = cleaned.trim().to_string();
        }
    }

    // Also strip generic suffixes starting with "– Nguồn" or "- Nguồn" or " | Nguồn"
    let generic_prefixes = ["– nguồn", "- nguồn", "| nguồn"];
    for prefix in &generic_prefixes {
        if let Some(idx) = cleaned.to_lowercase().rfind(prefix) {
            cleaned.truncate(idx);
            cleaned = cleaned.trim().to_string();
        }
    }

    // Strip trailing punctuation like dashes or pipes that might be left after suffix stripping
    while cleaned.ends_with('-') || cleaned.ends_with('|') || cleaned.ends_with('–') {
        cleaned.pop();
        cleaned = cleaned.trim().to_string();
    }

    if cleaned.is_empty() {
        "Truyện cào từ URL".to_string()
    } else {
        cleaned
    }
}

fn get_runner_path(config: &koharu_app::config::AppConfig) -> std::path::PathBuf {
    let bunfig_content = "[loader]\n\".webp\" = \"file\"\n\".png\" = \"file\"\n\".jpg\" = \"file\"\n\".jpeg\" = \"file\"\n\".gif\" = \"file\"\n";

    // Write global .bunfig.toml to home directory to universally solve webp loading
    if let Ok(home) = std::env::var("USERPROFILE") {
        let _ = std::fs::write(
            std::path::PathBuf::from(home).join(".bunfig.toml"),
            bunfig_content,
        );
    }

    // Force cached haruneko_repo FetchProvider.ts to be up to date with our BunFetchProvider patches!
    let repo_dir = config.data.path.join("haruneko_repo");
    if repo_dir.exists() {
        let fetch_provider_path = repo_dir
            .join("web")
            .join("src")
            .join("engine")
            .join("platform")
            .join("FetchProvider.ts");
        let _ = std::fs::write(&fetch_provider_path, BUN_FETCH_PROVIDER);
    }

    // 1. Check current directory
    if let Ok(cur) = std::env::current_dir() {
        let p = cur.join("scripts").join("haruneko_runner.js");
        if p.exists() {
            let _ = std::fs::write(cur.join("scripts").join("bunfig.toml"), bunfig_content);
            let _ = std::fs::write(cur.join("bunfig.toml"), bunfig_content);
            return p;
        }
        // 2. Check parent directory (for src-tauri run)
        if let Some(parent) = cur.parent() {
            let p = parent.join("scripts").join("haruneko_runner.js");
            if p.exists() {
                let _ = std::fs::write(parent.join("scripts").join("bunfig.toml"), bunfig_content);
                let _ = std::fs::write(parent.join("bunfig.toml"), bunfig_content);
                return p;
            }
        }
    }

    // 3. Fallback: write it to config.data.path.join("haruneko_runner.js")
    let dest = config.data.path.join("haruneko_runner.js");
    // Write the embedded runner script to the dest path (always keep it up to date)
    let runner_code = include_str!("../../../scripts/haruneko_runner.js");
    let _ = std::fs::write(&dest, runner_code);

    // Also write bunfig.toml next to the AppData runner
    let _ = std::fs::write(config.data.path.join("bunfig.toml"), bunfig_content);

    dest.into()
}

fn get_project_root() -> Option<std::path::PathBuf> {
    if let Ok(cur) = std::env::current_dir() {
        if cur.join("scripts").join("haruneko_runner.ts").exists() {
            return Some(cur);
        }
        if let Some(parent) = cur.parent() {
            if parent.join("scripts").join("haruneko_runner.ts").exists() {
                return Some(parent.to_path_buf());
            }
        }
    }
    None
}

fn api_internal<E>(err: E) -> ApiError
where
    E: Into<anyhow::Error>,
{
    ApiError::internal(err.into())
}

fn bun_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
}

fn bun_archive_url() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => {
            Some("https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip")
        }
        ("macos", "x86_64") => {
            Some("https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip")
        }
        ("macos", "aarch64") => {
            Some("https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip")
        }
        ("linux", "x86_64") => {
            Some("https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip")
        }
        ("linux", "aarch64") => {
            Some("https://github.com/oven-sh/bun/releases/latest/download/bun-linux-aarch64.zip")
        }
        _ => None,
    }
}

fn command_output_hidden(cmd: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.output()
}

fn bun_works(path: &Path) -> bool {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version");
    command_output_hidden(&mut cmd)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn find_existing_bun_executable() -> Option<PathBuf> {
    let binary = bun_binary_name();

    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        let candidates = [
            home.join(".bun").join("bin").join(binary),
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join(binary),
            home.join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(binary),
        ];

        for candidate in candidates {
            if candidate.exists() && bun_works(&candidate) {
                return Some(candidate);
            }
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".bun").join("bin").join(binary);
        if candidate.exists() && bun_works(&candidate) {
            return Some(candidate);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(binary);
            if candidate.exists() && bun_works(&candidate) {
                return Some(candidate);
            }
        }
    }

    let path_fallback = PathBuf::from(binary);
    if bun_works(&path_fallback) {
        return Some(path_fallback);
    }

    None
}

fn filename_matches(actual: &std::ffi::OsStr, expected: &str) -> bool {
    let actual = actual.to_string_lossy();
    if cfg!(target_os = "windows") {
        actual.eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && filename_matches(&entry.file_name(), name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn download_bytes_blocking(url: &str) -> Result<Vec<u8>, ApiError> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Koharu")
        .build()
        .map_err(api_internal)?;
    let response = client.get(url).send().map_err(api_internal)?;

    if !response.status().is_success() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "Download failed from {url}: HTTP {}",
            response.status()
        )));
    }

    Ok(response.bytes().map_err(api_internal)?.to_vec())
}

fn extract_zip_bytes(bytes: &[u8], dest: &Path) -> Result<(), ApiError> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).map_err(api_internal)?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(api_internal)?;
        let Some(enclosed_name) = file.enclosed_name() else {
            continue;
        };
        let outpath = dest.join(enclosed_name);

        if file.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(api_internal)?;
            continue;
        }

        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(api_internal)?;
        }

        let mut outfile = std::fs::File::create(&outpath).map_err(api_internal)?;
        std::io::copy(&mut file, &mut outfile).map_err(api_internal)?;
    }

    Ok(())
}

fn ensure_bun_executable(tool_root: &Path) -> Result<PathBuf, ApiError> {
    if let Some(existing) = find_existing_bun_executable() {
        return Ok(existing);
    }

    let tools_dir = tool_root.join("tools").join("bun");
    if let Some(existing) = find_file_named(&tools_dir, bun_binary_name()) {
        if bun_works(&existing) {
            return Ok(existing);
        }
    }

    let url = bun_archive_url().ok_or_else(|| {
        ApiError::internal(anyhow::anyhow!(
            "Automatic Bun download is not supported for this platform yet."
        ))
    })?;

    if tools_dir.exists() {
        std::fs::remove_dir_all(&tools_dir).map_err(api_internal)?;
    }
    std::fs::create_dir_all(&tools_dir).map_err(api_internal)?;

    let bytes = download_bytes_blocking(url)?;
    extract_zip_bytes(&bytes, &tools_dir)?;

    let bun_path = find_file_named(&tools_dir, bun_binary_name()).ok_or_else(|| {
        ApiError::internal(anyhow::anyhow!(
            "Bun archive downloaded, but {} was not found inside it.",
            bun_binary_name()
        ))
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&bun_path)
            .map_err(api_internal)?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&bun_path, permissions).map_err(api_internal)?;
    }

    if !bun_works(&bun_path) {
        return Err(ApiError::internal(anyhow::anyhow!(
            "Downloaded Bun executable is not runnable: {}",
            bun_path.display()
        )));
    }

    Ok(bun_path)
}

fn run_bun_command(runner_path: &std::path::Path, args: &[&str]) -> Result<String, ApiError> {
    let bunfig_path = runner_path.parent().map(|p| p.join("bunfig.toml"));
    let mut cmd_args = vec!["run"];

    let config_arg_str;
    if let Some(ref bp) = bunfig_path {
        config_arg_str = format!("--config={}", bp.to_str().unwrap_or(""));
        cmd_args.push(config_arg_str.as_str());
    }

    cmd_args.push(runner_path.to_str().unwrap_or(""));
    cmd_args.extend_from_slice(args);

    let tool_root = runner_path.parent().unwrap_or_else(|| Path::new("."));
    let bun_exe = ensure_bun_executable(tool_root)?;
    let mut cmd = std::process::Command::new(&bun_exe);
    cmd.args(&cmd_args);

    if let Some(root) = get_project_root() {
        cmd.current_dir(root);
    }

    let output = command_output_hidden(&mut cmd)
        .map_err(|e| ApiError::internal(anyhow::anyhow!("Không thể chạy Bun ({:?}): {e}. Koharu đã thử tự tải Bun portable nhưng vẫn không thể khởi chạy.", bun_exe)))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        let err_msg = format!(
            "HakuNeko runner failed with exit code: {}\n[STDOUT]: {}\n[STDERR]: {}",
            output.status,
            stdout.trim(),
            stderr.trim()
        );
        tracing::error!("{err_msg}");
        return Err(ApiError::internal(anyhow::anyhow!("{err_msg}")));
    }

    Ok(stdout.into_owned())
}

// ---------------------------------------------------------------------------
// GET /manga/search
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/manga/search",
    params(
        ("sourceId" = String, Query, description = "Manga source ID"),
        ("query" = String, Query, description = "Search query")
    ),
    responses((status = 200, body = Vec<MangaSearchResult>))
)]
async fn search_manga(
    State(app): State<AppState>,
    Query(q): Query<SearchMangaQuery>,
) -> ApiResult<Json<Vec<MangaSearchResult>>> {
    // Check if the query is a URL
    if q.query.starts_with("http://") || q.query.starts_with("https://") {
        let config = (**app.config.load()).clone();
        let repo_dir = config.data.path.join("haruneko_repo");

        if repo_dir.exists() {
            let websites_dir = repo_dir
                .join("web")
                .join("src")
                .join("engine")
                .join("websites");
            let runner_path = get_runner_path(&config);

            // Call find_matching_script to see if a HaruNeko script validates this URL
            if let Ok(stdout) = run_bun_command(
                &runner_path,
                &["find_matching_script", websites_dir.as_str(), &q.query],
            ) {
                let val: serde_json::Value =
                    serde_json::from_str(stdout.trim()).unwrap_or_default();

                if let Some(matched_script) = val.get("matchedScript").and_then(|s| s.as_str()) {
                    let script_path = websites_dir.join(matched_script);

                    // Run fetch_manga to scrape the actual title
                    if let Ok(stdout_manga) = run_bun_command(
                        &runner_path,
                        &["fetch_manga", script_path.as_str(), &q.query],
                    ) {
                        let manga_val: serde_json::Value =
                            serde_json::from_str(stdout_manga.trim()).unwrap_or_default();

                        if let Some(title) = manga_val.get("title").and_then(|t| t.as_str()) {
                            let scraper_manga_id = manga_val
                                .get("id")
                                .and_then(|i| i.as_str())
                                .unwrap_or(&q.query);
                            let id = format!("{}|{}", matched_script, scraper_manga_id);

                            // Try to scrape rich metadata cover and description in Rust!
                            let client = reqwest::Client::new();
                            let mut cover_url = None;
                            let mut description = None;

                            if let Ok(resp) = client.get(&q.query)
                                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                                .send()
                                .await
                            {
                                if let Ok(html) = resp.text().await {
                                    cover_url = extract_meta_content(&html, "og:image");
                                    description = extract_meta_content(&html, "og:description");
                                }
                            }

                            let mut results = Vec::new();
                            results.push(MangaSearchResult {
                                id,
                                title: clean_manga_title(title),
                                cover_url,
                                description,
                            });
                            return Ok(Json(results));
                        }
                    }
                }
            }
        }

        // Generic URL HTML scraper fallback if no HaruNeko scripts are synced or match
        let client = reqwest::Client::new();
        let resp = client
            .get(&q.query)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .send()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        if !resp.status().is_success() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Không thể truy cập URL này: HTTP {}",
                resp.status()
            )));
        }

        let html = resp
            .text()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        let title = extract_meta_content(&html, "og:title")
            .or_else(|| extract_title_tag(&html))
            .unwrap_or_else(|| "Truyện cào từ URL".to_string());

        let cover_url = extract_meta_content(&html, "og:image");
        let description = extract_meta_content(&html, "og:description");

        let mut results = Vec::new();
        results.push(MangaSearchResult {
            id: q.query.clone(),
            title: clean_manga_title(&title),
            cover_url,
            description,
        });
        return Ok(Json(results));
    }

    // Check if the query is a raw UUID
    if let Some(uuid) = extract_uuid(&q.query) {
        let client = reqwest::Client::new();
        let url = format!(
            "https://api.mangadex.org/manga/{}?includes[]=cover_art",
            uuid
        );
        let resp = client
            .get(&url)
            .header("User-Agent", "KoharuWebDownloader/1.0")
            .send()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        if !resp.status().is_success() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "MangaDex returned error: {}",
                resp.status()
            )));
        }

        let json = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        let mut results = Vec::new();
        if let Some(item) = json.get("data") {
            let id = item
                .get("id")
                .and_then(|i: &serde_json::Value| i.as_str())
                .unwrap_or("")
                .to_string();
            let attributes = item.get("attributes");
            let title = attributes
                .and_then(|a: &serde_json::Value| a.get("title"))
                .and_then(|t: &serde_json::Value| {
                    t.get("en")
                        .or_else(|| t.get("ja"))
                        .or_else(|| t.get("vi"))
                        .or_else(|| t.get("vi-vn"))
                        .or_else(|| t.as_object().and_then(|o| o.values().next()))
                })
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("Untitled")
                .to_string();

            let description = attributes
                .and_then(|a: &serde_json::Value| a.get("description"))
                .and_then(|d: &serde_json::Value| {
                    d.get("en")
                        .or_else(|| d.as_object().and_then(|o| o.values().next()))
                })
                .and_then(|v: &serde_json::Value| v.as_str())
                .map(|s| s.to_string());

            let mut cover_url = None;
            if let Some(relationships) = item
                .get("relationships")
                .and_then(|r: &serde_json::Value| r.as_array())
            {
                for rel in relationships {
                    if rel.get("type").and_then(|t: &serde_json::Value| t.as_str())
                        == Some("cover_art")
                    {
                        if let Some(filename) = rel
                            .get("attributes")
                            .and_then(|a: &serde_json::Value| a.get("fileName"))
                            .and_then(|f: &serde_json::Value| f.as_str())
                        {
                            cover_url = Some(format!(
                                "https://uploads.mangadex.org/covers/{}/{}",
                                id, filename
                            ));
                        }
                    }
                }
            }

            results.push(MangaSearchResult {
                id,
                title,
                cover_url,
                description,
            });
        }
        return Ok(Json(results));
    }

    if q.source_id != "mangadex" {
        return Err(ApiError::bad_request(
            "Chỉ hỗ trợ tìm kiếm bằng từ khóa trên MangaDex. Đối với các trang web khác, vui lòng dán thẳng link truyện để hệ thống tự cào dữ liệu!",
        ));
    }

    let client = reqwest::Client::new();
    let encoded_query =
        url::form_urlencoded::byte_serialize(q.query.as_bytes()).collect::<String>();
    let url = format!(
        "https://api.mangadex.org/manga?title={}&limit=20&includes[]=cover_art",
        encoded_query
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "KoharuWebDownloader/1.0")
        .send()
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

    if !resp.status().is_success() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "MangaDex returned error: {}",
            resp.status()
        )));
    }

    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

    let mut results = Vec::new();
    if let Some(data) = json
        .get("data")
        .and_then(|d: &serde_json::Value| d.as_array())
    {
        for item in data {
            let id = item
                .get("id")
                .and_then(|i: &serde_json::Value| i.as_str())
                .unwrap_or("")
                .to_string();
            let attributes = item.get("attributes");
            let title = attributes
                .and_then(|a: &serde_json::Value| a.get("title"))
                .and_then(|t: &serde_json::Value| {
                    t.get("en")
                        .or_else(|| t.get("ja"))
                        .or_else(|| t.get("vi"))
                        .or_else(|| t.get("vi-vn"))
                        .or_else(|| t.as_object().and_then(|o| o.values().next()))
                })
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("Untitled")
                .to_string();

            let description = attributes
                .and_then(|a: &serde_json::Value| a.get("description"))
                .and_then(|d: &serde_json::Value| {
                    d.get("en")
                        .or_else(|| d.as_object().and_then(|o| o.values().next()))
                })
                .and_then(|v: &serde_json::Value| v.as_str())
                .map(|s| s.to_string());

            let mut cover_url = None;
            if let Some(relationships) = item
                .get("relationships")
                .and_then(|r: &serde_json::Value| r.as_array())
            {
                for rel in relationships {
                    if rel.get("type").and_then(|t: &serde_json::Value| t.as_str())
                        == Some("cover_art")
                    {
                        if let Some(filename) = rel
                            .get("attributes")
                            .and_then(|a: &serde_json::Value| a.get("fileName"))
                            .and_then(|f: &serde_json::Value| f.as_str())
                        {
                            cover_url = Some(format!(
                                "https://uploads.mangadex.org/covers/{}/{}",
                                id, filename
                            ));
                        }
                    }
                }
            }

            results.push(MangaSearchResult {
                id,
                title,
                cover_url,
                description,
            });
        }
    }

    Ok(Json(results))
}

// ---------------------------------------------------------------------------
// GET /manga/chapters
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/manga/chapters",
    params(
        ("sourceId" = String, Query, description = "Manga source ID"),
        ("mangaId" = String, Query, description = "Manga ID")
    ),
    responses((status = 200, body = MangaChapterListResponse))
)]
async fn list_manga_chapters(
    State(app): State<AppState>,
    Query(q): Query<ListChaptersQuery>,
) -> ApiResult<Json<MangaChapterListResponse>> {
    let mut resolved_script = None;
    let mut resolved_manga_id = None;

    if q.manga_id.contains('|') {
        let parts: Vec<&str> = q.manga_id.split('|').collect();
        if parts.len() >= 2 {
            resolved_script = Some(parts[0].to_string());
            resolved_manga_id = Some(parts[1].to_string());
        }
    } else if q.manga_id.starts_with("http://") || q.manga_id.starts_with("https://") {
        // Try to dynamically match a HaruNeko scraper for this URL!
        let config = (**app.config.load()).clone();
        let repo_dir = config.data.path.join("haruneko_repo");
        if repo_dir.exists() {
            let websites_dir = repo_dir
                .join("web")
                .join("src")
                .join("engine")
                .join("websites");
            let runner_path = get_runner_path(&config);

            if let Ok(stdout) = run_bun_command(
                &runner_path,
                &["find_matching_script", websites_dir.as_str(), &q.manga_id],
            ) {
                let val: serde_json::Value =
                    serde_json::from_str(stdout.trim()).unwrap_or_default();
                if let Some(matched_script) = val.get("matchedScript").and_then(|s| s.as_str()) {
                    let script_path = websites_dir.join(matched_script);
                    // Run fetch_manga to scrape the actual short/numeric scraper ID
                    if let Ok(stdout_manga) = run_bun_command(
                        &runner_path,
                        &["fetch_manga", script_path.as_str(), &q.manga_id],
                    ) {
                        let manga_val: serde_json::Value =
                            serde_json::from_str(stdout_manga.trim()).unwrap_or_default();
                        if let Some(real_id) = manga_val.get("id").and_then(|i| i.as_str()) {
                            resolved_script = Some(matched_script.to_string());
                            resolved_manga_id = Some(real_id.to_string());
                        }
                    }
                }
            }
        }
    }

    if let (Some(script_name), Some(real_manga_id)) = (resolved_script, resolved_manga_id) {
        let config = (**app.config.load()).clone();
        let repo_dir = config.data.path.join("haruneko_repo");
        let websites_dir = repo_dir
            .join("web")
            .join("src")
            .join("engine")
            .join("websites");
        let script_path = websites_dir.join(&script_name);

        let runner_path = get_runner_path(&config);

        let stdout = run_bun_command(
            &runner_path,
            &["fetch_chapters", script_path.as_str(), &real_manga_id],
        )?;

        let chapters_val: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|e| {
            ApiError::internal(anyhow::anyhow!("Failed to parse chapters JSON: {e}"))
        })?;

        let mut chapters = Vec::new();
        if let Some(arr) = chapters_val.as_array() {
            for (idx, item) in arr.iter().enumerate() {
                let id = item.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");

                // Encode composite chapter ID: "script_name|chapter_id|chapter_name|real_manga_id"
                let composite_id = format!("{}|{}|{}|{}", script_name, id, name, real_manga_id);
                chapters.push(MangaChapter {
                    id: composite_id,
                    name: name.to_string(),
                    order: idx as u32 + 1,
                });
            }
        }
        return Ok(Json(MangaChapterListResponse { chapters }));
    }

    // 2. Legacy fallback URL chapters parser
    if q.manga_id.starts_with("http://") || q.manga_id.starts_with("https://") {
        let client = reqwest::Client::new();
        let resp = client
            .get(&q.manga_id)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .send()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        if !resp.status().is_success() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Không thể lấy danh sách chương: HTTP {}",
                resp.status()
            )));
        }

        let html = resp
            .text()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        let base_domain = url::Url::parse(&q.manga_id)
            .map(|u| u.host_str().unwrap_or("").to_string())
            .unwrap_or_default();

        let chapters = extract_chapters_html(&html, &base_domain, &q.manga_id);
        return Ok(Json(MangaChapterListResponse { chapters }));
    }

    if q.source_id != "mangadex" {
        return Err(ApiError::bad_request(
            "Chỉ hỗ trợ dữ liệu thật từ MangaDex.",
        ));
    }

    let client = reqwest::Client::new();
    let url = format!(
        "https://api.mangadex.org/manga/{}/feed?limit=500&translatedLanguage[]=vi&translatedLanguage[]=en&order[chapter]=asc",
        q.manga_id
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "KoharuWebDownloader/1.0")
        .send()
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

    if !resp.status().is_success() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "MangaDex returned error: {}",
            resp.status()
        )));
    }

    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

    let mut chapters = Vec::new();
    if let Some(data) = json
        .get("data")
        .and_then(|d: &serde_json::Value| d.as_array())
    {
        for (idx, item) in data.iter().enumerate() {
            let id = item
                .get("id")
                .and_then(|i: &serde_json::Value| i.as_str())
                .unwrap_or("")
                .to_string();
            let attrs = item.get("attributes");
            let chapter_num = attrs
                .and_then(|a: &serde_json::Value| a.get("chapter"))
                .and_then(|c: &serde_json::Value| c.as_str())
                .unwrap_or("")
                .to_string();
            let title = attrs
                .and_then(|a: &serde_json::Value| a.get("title"))
                .and_then(|t: &serde_json::Value| t.as_str())
                .unwrap_or("")
                .to_string();
            let lang = attrs
                .and_then(|a: &serde_json::Value| a.get("translatedLanguage"))
                .and_then(|l: &serde_json::Value| l.as_str())
                .unwrap_or("en")
                .to_string();

            let name = if title.is_empty() {
                format!("Ch. {} [{}]", chapter_num, lang.to_uppercase())
            } else {
                format!("Ch. {} - {} [{}]", chapter_num, title, lang.to_uppercase())
            };

            chapters.push(MangaChapter {
                id,
                name,
                order: idx as u32 + 1,
            });
        }
    }

    Ok(Json(MangaChapterListResponse { chapters }))
}

// ---------------------------------------------------------------------------
// POST /manga/project
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/manga/project",
    request_body = CreateMangaProjectRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn create_manga_project(
    State(app): State<AppState>,
    Json(req): Json<CreateMangaProjectRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let trimmed = req.manga_title.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("title must not be empty"));
    }
    let config = (**app.config.load()).clone();
    let path = if let Some(ref custom_path) = req.custom_save_path {
        let parent = camino::Utf8Path::new(custom_path);
        project_dirs::allocate_named_in_dir(parent, trimmed).map_err(ApiError::internal)?
    } else {
        project_dirs::allocate_named(&config, trimmed).map_err(ApiError::internal)?
    };

    let session = app
        .open_project(path.clone(), Some(trimmed.to_string()))
        .await
        .map_err(ApiError::internal)?;

    // Set manga source metadata in ProjectMeta, set sync_dir to the nested sync/ directory inside the khrproj!
    let sync_dir_path = path.join("sync");
    std::fs::create_dir_all(sync_dir_path.as_std_path())
        .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

    session
        .apply(Op::UpdateProjectMeta {
            patch: koharu_core::ProjectMetaPatch {
                name: None,
                style: None,
                updated_at: None,
                sync_dir: Some(Some(sync_dir_path.to_string())),
                source_id: Some(Some(req.source_id)),
                manga_id: Some(Some(req.manga_id)),
                manga_title: Some(Some(trimmed.to_string())),
            },
            prev: Default::default(),
        })
        .map_err(ApiError::internal)?;

    // Compact to write to scene.bin immediately
    session.compact().map_err(ApiError::internal)?;

    Ok(Json(koharu_app::app::project_summary(&session)))
}

// ---------------------------------------------------------------------------
// POST /manga/download-chapter
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/manga/download-chapter",
    request_body = DownloadMangaChapterRequest,
    responses((status = 200, body = ProjectSummary))
)]
async fn download_manga_chapter(
    State(app): State<AppState>,
    Json(req): Json<DownloadMangaChapterRequest>,
) -> ApiResult<Json<ProjectSummary>> {
    let mut resolved_script = None;
    let mut resolved_chapter_id = None;
    let mut resolved_chapter_title = None;
    let mut resolved_manga_id = None;

    if req.chapter_id.contains('|') {
        let parts: Vec<&str> = req.chapter_id.split('|').collect();
        if parts.len() >= 4 {
            resolved_script = Some(parts[0].to_string());
            resolved_chapter_id = Some(parts[1].to_string());
            resolved_chapter_title = Some(parts[2].to_string());
            resolved_manga_id = Some(parts[3].to_string());
        }
    } else if req.chapter_id.starts_with("http://") || req.chapter_id.starts_with("https://") {
        // Dynamic Resolution for raw URL chapters (backward compatibility / legacy imports)
        let session = app
            .current_session()
            .ok_or_else(|| ApiError::bad_request("no active project open"))?;

        // Read manga_id from project metadata
        let (project_manga_id, _project_source_id) = {
            let scene = session.scene.read();
            (
                scene.project.manga_id.clone().unwrap_or_default(),
                scene.project.source_id.clone().unwrap_or_default(),
            )
        };

        let mut resolved_script_name = None;
        let mut resolved_scraper_manga_id = None;

        if project_manga_id.contains('|') {
            let parts: Vec<&str> = project_manga_id.split('|').collect();
            if parts.len() >= 2 {
                resolved_script_name = Some(parts[0].to_string());
                resolved_scraper_manga_id = Some(parts[1].to_string());
            }
        } else if project_manga_id.starts_with("http://")
            || project_manga_id.starts_with("https://")
        {
            // Find matched script dynamically
            let config = (**app.config.load()).clone();
            let repo_dir = config.data.path.join("haruneko_repo");
            if repo_dir.exists() {
                let websites_dir = repo_dir
                    .join("web")
                    .join("src")
                    .join("engine")
                    .join("websites");
                let runner_path = get_runner_path(&config);

                if let Ok(stdout) = run_bun_command(
                    &runner_path,
                    &[
                        "find_matching_script",
                        websites_dir.as_str(),
                        &project_manga_id,
                    ],
                ) {
                    let val: serde_json::Value =
                        serde_json::from_str(stdout.trim()).unwrap_or_default();
                    if let Some(matched_script) = val.get("matchedScript").and_then(|s| s.as_str())
                    {
                        let script_path = websites_dir.join(matched_script);
                        if let Ok(stdout_manga) = run_bun_command(
                            &runner_path,
                            &["fetch_manga", script_path.as_str(), &project_manga_id],
                        ) {
                            let manga_val: serde_json::Value =
                                serde_json::from_str(stdout_manga.trim()).unwrap_or_default();
                            if let Some(real_id) = manga_val.get("id").and_then(|i| i.as_str()) {
                                resolved_script_name = Some(matched_script.to_string());
                                resolved_scraper_manga_id = Some(real_id.to_string());
                            }
                        }
                    }
                }
            }
        }

        if let (Some(script_name), Some(real_manga_id)) =
            (resolved_script_name, resolved_scraper_manga_id)
        {
            // Load chapters to match this chapter URL or name
            let config = (**app.config.load()).clone();
            let repo_dir = config.data.path.join("haruneko_repo");
            let websites_dir = repo_dir
                .join("web")
                .join("src")
                .join("engine")
                .join("websites");
            let script_path = websites_dir.join(&script_name);

            let runner_path = get_runner_path(&config);

            if let Ok(stdout) = run_bun_command(
                &runner_path,
                &["fetch_chapters", script_path.as_str(), &real_manga_id],
            ) {
                if let Ok(chapters_val) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                    if let Some(arr) = chapters_val.as_array() {
                        for item in arr {
                            let id = item.get("id").and_then(|i| i.as_str()).unwrap_or("");
                            let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");

                            // Match by name or chapter ID
                            if name.to_lowercase() == req.chapter_name.to_lowercase()
                                || req.chapter_id.contains(id)
                            {
                                resolved_script = Some(script_name.clone());
                                resolved_chapter_id = Some(id.to_string());
                                resolved_chapter_title = Some(name.to_string());
                                resolved_manga_id = Some(real_manga_id.clone());
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    if let (
        Some(script_name),
        Some(real_chapter_id),
        Some(real_chapter_title),
        Some(real_manga_id),
    ) = (
        resolved_script,
        resolved_chapter_id,
        resolved_chapter_title,
        resolved_manga_id,
    ) {
        let session = app
            .current_session()
            .ok_or_else(|| ApiError::bad_request("no active project open"))?;

        let chapter_id = ChapterId::new();
        let now = Utc::now();

        let chapter = Chapter {
            id: chapter_id,
            name: req.chapter_name.clone(),
            order: {
                let scene = session.scene.read();
                scene.chapters.len() as u32 + 1
            },
            created_at: now,
            updated_at: now,
            page_ids: Vec::new(),
        };

        session
            .apply(Op::AddChapter { chapter })
            .map_err(ApiError::internal)?;

        let s_dir = {
            let scene = session.scene.read();
            scene.project.sync_dir.clone()
        };

        let raw_dir = if let Some(ref sync_path_str) = s_dir {
            let ch_dir = std::path::Path::new(sync_path_str).join(&req.chapter_name);
            let raw = ch_dir.join("raw");
            let psd = ch_dir.join("psd");
            let trans = ch_dir.join("translated").join("vi-Vn");
            let _ = std::fs::create_dir_all(&raw);
            let _ = std::fs::create_dir_all(&psd);
            let _ = std::fs::create_dir_all(&trans);
            Some(raw)
        } else {
            None
        };

        let config = (**app.config.load()).clone();
        let repo_dir = config.data.path.join("haruneko_repo");
        let websites_dir = repo_dir
            .join("web")
            .join("src")
            .join("engine")
            .join("websites");
        let script_path = websites_dir.join(script_name);

        let runner_path = get_runner_path(&config);

        let temp_dir_holder;
        let dest_dir = if let Some(ref r_dir) = raw_dir {
            r_dir.clone()
        } else {
            temp_dir_holder = tempfile::tempdir().map_err(api_internal)?;
            temp_dir_holder.path().to_path_buf()
        };

        run_bun_command(
            &runner_path,
            &[
                "download_pages",
                script_path.as_str(),
                &real_chapter_id,
                &real_chapter_title,
                &real_manga_id,
                &req.chapter_name,
                dest_dir.to_str().unwrap_or(""),
            ],
        )?;

        let mut downloaded_pages = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dest_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(filename_str) = path.file_name().and_then(|f| f.to_str()) {
                        if filename_str.starts_with("page_") && filename_str.ends_with(".png") {
                            if let Ok(bytes) = std::fs::read(&path) {
                                if let Ok(img) = image::load_from_memory(&bytes) {
                                    use image::GenericImageView;
                                    let (w, h) = img.dimensions();
                                    downloaded_pages.push((filename_str.to_string(), w, h, bytes));
                                }
                            }
                        }
                    }
                }
            }
        }

        if downloaded_pages.is_empty() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Could not download any pages for this chapter"
            )));
        }

        downloaded_pages.sort_by(|a, b| natord::compare(&a.0, &b.0));

        let blobs = session.blobs.clone();
        let mut ops = Vec::new();
        let starting_index = {
            let scene = session.scene.read();
            scene.pages.len()
        };

        for (i, (filename, w, h, bytes)) in downloaded_pages.into_iter().enumerate() {
            let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
            let mut page = Page::new(&filename, w, h);
            page.chapter_id = Some(chapter_id);

            let source_node_id = NodeId::new();
            page.nodes.insert(
                source_node_id,
                Node {
                    id: source_node_id,
                    transform: koharu_core::Transform::default(),
                    visible: true,
                    kind: NodeKind::Image(ImageData {
                        role: ImageRole::Source,
                        blob,
                        opacity: 1.0,
                        natural_width: w,
                        natural_height: h,
                        name: Some(filename),
                    }),
                },
            );

            ops.push(Op::AddPage {
                page,
                at: starting_index + i,
            });
        }

        if !ops.is_empty() {
            session
                .apply(Op::Batch {
                    ops,
                    label: format!("Download chapter {} pages", req.chapter_name),
                })
                .map_err(ApiError::internal)?;
        }

        session.compact().map_err(ApiError::internal)?;

        return Ok(Json(koharu_app::app::project_summary(&session)));
    }

    if req.chapter_id.starts_with("http://") || req.chapter_id.starts_with("https://") {
        let session = app
            .current_session()
            .ok_or_else(|| ApiError::bad_request("no active project open"))?;

        let chapter_id = ChapterId::new();
        let now = Utc::now();

        // Create the chapter structure
        let chapter = Chapter {
            id: chapter_id,
            name: req.chapter_name.clone(),
            order: {
                let scene = session.scene.read();
                scene.chapters.len() as u32 + 1
            },
            created_at: now,
            updated_at: now,
            page_ids: Vec::new(),
        };

        // Add chapter to session
        session
            .apply(Op::AddChapter { chapter })
            .map_err(ApiError::internal)?;

        // Resolve directory paths for local filesystem saving inside the project sync_dir
        let s_dir = {
            let scene = session.scene.read();
            scene.project.sync_dir.clone()
        };

        let raw_dir = if let Some(ref sync_path_str) = s_dir {
            let ch_dir = std::path::Path::new(sync_path_str).join(&req.chapter_name);
            let raw = ch_dir.join("raw");
            let psd = ch_dir.join("psd");
            let trans = ch_dir.join("translated").join("vi-Vn");
            let _ = std::fs::create_dir_all(&raw);
            let _ = std::fs::create_dir_all(&psd);
            let _ = std::fs::create_dir_all(&trans);
            Some(raw)
        } else {
            None
        };

        let is_weloma = req.chapter_id.contains("weloma.art");
        let client = reqwest::Client::new();

        let html = if is_weloma {
            // Step 1: Initial GET to fetch lock token
            let resp1 = client
                .get(&req.chapter_id)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .send()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

            let mut cookie_map = std::collections::HashMap::new();
            extract_cookies_into_map(&resp1, &mut cookie_map);
            let html1 = resp1
                .text()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

            let token_opt = extract_token_from_html(&html1);

            if let Some(token) = token_opt {
                // Step 2: POST AJAX Auth
                let params = [
                    ("token", token),
                    ("action", "type".to_string()),
                    ("type", "".to_string()),
                ];
                let cookie_header = build_cookie_header(&cookie_map);
                let resp2 = client
                    .post(&req.chapter_id)
                    .form(&params)
                    .header("Origin", "https://weloma.art")
                    .header("Referer", "https://weloma.art/index.html")
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                    .header("X-Requested-With", "XMLHttpRequest")
                    .header("Cookie", cookie_header)
                    .send()
                    .await;

                if let Ok(r2) = resp2 {
                    extract_cookies_into_map(&r2, &mut cookie_map);
                }
            }

            // Step 3: Final GET with authorized cookies and guest unlock headers
            cookie_map.insert("unlock_chapter_guest".to_string(), "1".to_string());
            cookie_map.insert("smartlink_shown_guest".to_string(), "1".to_string());
            cookie_map.insert("smartlink_shown".to_string(), "1".to_string());

            let final_cookie_header = build_cookie_header(&cookie_map);

            let resp3 = client
                .get(&req.chapter_id)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .header("Referer", "https://weloma.art/93/")
                .header("Cookie", final_cookie_header)
                .send()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

            if !resp3.status().is_success() {
                return Err(ApiError::internal(anyhow::anyhow!(
                    "Không thể tải trang WeLoMa: HTTP {}",
                    resp3.status()
                )));
            }
            resp3
                .text()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
        } else {
            // Standard generic scraping flow
            let resp = client
                .get(&req.chapter_id)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                .send()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

            if !resp.status().is_success() {
                return Err(ApiError::internal(anyhow::anyhow!(
                    "Không thể tải trang: HTTP {}",
                    resp.status()
                )));
            }
            resp.text()
                .await
                .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?
        };

        let base_domain = url::Url::parse(&req.chapter_id)
            .map(|u| u.host_str().unwrap_or("").to_string())
            .unwrap_or_default();

        let image_urls = extract_images_html(&html, &base_domain, &req.chapter_id);

        if image_urls.is_empty() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Không tìm thấy trang ảnh nào trong chương này"
            )));
        }

        let mut download_futures = Vec::new();
        for (i, img_url) in image_urls.iter().enumerate() {
            let client_c = client.clone();
            let url_str = img_url.clone();
            let referer_str = req.chapter_id.clone();
            let idx = i + 1;

            download_futures.push(async move {
                let resp = client_c
                    .get(&url_str)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                    .header("Referer", &referer_str)
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("Request error: {e}"))?;
                if !resp.status().is_success() {
                    return Err(anyhow::anyhow!(
                        "Failed to download page {idx}: HTTP {}",
                        resp.status()
                    ));
                }
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!("Bytes error: {e}"))?
                    .to_vec();

                let filename = format!("page_{:03}.png", idx);
                Ok::<(String, Vec<u8>), anyhow::Error>((filename, bytes))
            });
        }

        let mut downloaded_pages = Vec::new();
        let results = futures::future::join_all(download_futures).await;
        for res in results {
            match res {
                Ok((filename, bytes)) => {
                    if let Ok(img) = image::load_from_memory(&bytes) {
                        let (w, h) = img.dimensions();

                        // Save image physically to the raw directory
                        if let Some(ref r_dir) = raw_dir {
                            let file_path = r_dir.join(&filename);
                            let _ = std::fs::write(&file_path, &bytes);
                        }

                        downloaded_pages.push((filename, w, h, bytes));
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to download page: {e}");
                }
            }
        }

        if downloaded_pages.is_empty() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Could not download any pages for this chapter"
            )));
        }

        // Sort page files naturally by name
        downloaded_pages.sort_by(|a, b| natord::compare(&a.0, &b.0));

        let blobs = session.blobs.clone();
        let mut ops = Vec::new();
        let starting_index = {
            let scene = session.scene.read();
            scene.pages.len()
        };

        // Store downloaded page bytes into Blobs, and register as new Pages
        for (i, (filename, w, h, bytes)) in downloaded_pages.into_iter().enumerate() {
            let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
            let mut page = Page::new(&filename, w, h);
            page.chapter_id = Some(chapter_id);

            let source_node_id = NodeId::new();
            page.nodes.insert(
                source_node_id,
                Node {
                    id: source_node_id,
                    transform: koharu_core::Transform::default(),
                    visible: true,
                    kind: NodeKind::Image(ImageData {
                        role: ImageRole::Source,
                        blob,
                        opacity: 1.0,
                        natural_width: w,
                        natural_height: h,
                        name: Some(filename),
                    }),
                },
            );

            ops.push(Op::AddPage {
                page,
                at: starting_index + i,
            });
        }

        if !ops.is_empty() {
            session
                .apply(Op::Batch {
                    ops,
                    label: format!("Download chapter {} pages", req.chapter_name),
                })
                .map_err(ApiError::internal)?;
        }

        // Save project scene.bin
        session.compact().map_err(ApiError::internal)?;

        return Ok(Json(koharu_app::app::project_summary(&session)));
    }

    if req.source_id != "mangadex" {
        return Err(ApiError::bad_request(
            "Chỉ hỗ trợ dữ liệu thật từ MangaDex.",
        ));
    }

    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no active project open"))?;

    let chapter_id = ChapterId::new();
    let now = Utc::now();

    // Create the chapter structure
    let chapter = Chapter {
        id: chapter_id,
        name: req.chapter_name.clone(),
        order: {
            let scene = session.scene.read();
            scene.chapters.len() as u32 + 1
        },
        created_at: now,
        updated_at: now,
        page_ids: Vec::new(),
    };

    // Add chapter to session
    session
        .apply(Op::AddChapter { chapter })
        .map_err(ApiError::internal)?;

    // Resolve directory paths for local filesystem saving inside the project sync_dir
    let s_dir = {
        let scene = session.scene.read();
        scene.project.sync_dir.clone()
    };

    let raw_dir = if let Some(ref sync_path_str) = s_dir {
        let ch_dir = std::path::Path::new(sync_path_str).join(&req.chapter_name);
        let raw = ch_dir.join("raw");
        let psd = ch_dir.join("psd");
        let trans = ch_dir.join("translated").join("vi-Vn");
        let _ = std::fs::create_dir_all(&raw);
        let _ = std::fs::create_dir_all(&psd);
        let _ = std::fs::create_dir_all(&trans);
        Some(raw)
    } else {
        None
    };

    let mut downloaded_pages = Vec::new();

    if req.source_id == "mangadex" {
        let client = reqwest::Client::new();
        let at_home_url = format!("https://api.mangadex.org/at-home/server/{}", req.chapter_id);
        let resp = client
            .get(&at_home_url)
            .header("User-Agent", "KoharuWebDownloader/1.0")
            .send()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        if !resp.status().is_success() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "MangaDex at-home returned error: {}",
                resp.status()
            )));
        }

        let json = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| ApiError::internal(anyhow::Error::new(e)))?;

        let base_url = json
            .get("baseUrl")
            .and_then(|b: &serde_json::Value| b.as_str())
            .unwrap_or("");
        let chapter_data = json.get("chapter");
        let hash = chapter_data
            .and_then(|c: &serde_json::Value| c.get("hash"))
            .and_then(|h: &serde_json::Value| h.as_str())
            .unwrap_or("");
        let page_files_val = chapter_data
            .and_then(|c: &serde_json::Value| c.get("data"))
            .and_then(|d: &serde_json::Value| d.as_array());

        if base_url.is_empty() || hash.is_empty() || page_files_val.is_none() {
            return Err(ApiError::internal(anyhow::anyhow!(
                "Invalid MangaDex at-home server response"
            )));
        }

        let page_files = page_files_val.unwrap();
        let mut download_futures = Vec::new();

        // Download page images in parallel, with explicit type mapping to resolve compiler type inference issues
        for (i, p_file) in page_files.iter().enumerate() {
            let filename = p_file.as_str().unwrap_or("").to_string();
            if filename.is_empty() {
                continue;
            }
            let img_url = format!("{}/data/{}/{}", base_url, hash, filename);
            let client_c = client.clone();
            let idx = i + 1;

            download_futures.push(async move {
                let resp = client_c
                    .get(&img_url)
                    .header("User-Agent", "KoharuWebDownloader/1.0")
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("Request error: {e}"))?;
                if !resp.status().is_success() {
                    return Err(anyhow::anyhow!(
                        "Failed to download page {idx}: HTTP {}",
                        resp.status()
                    ));
                }
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!("Bytes error: {e}"))?
                    .to_vec();
                Ok::<(String, Vec<u8>), anyhow::Error>((filename, bytes))
            });
        }

        let results = futures::future::join_all(download_futures).await;
        for res in results {
            match res {
                Ok((filename, bytes)) => {
                    if let Ok(img) = image::load_from_memory(&bytes) {
                        let (w, h) = img.dimensions();

                        // Save image physically to the raw directory
                        if let Some(ref r_dir) = raw_dir {
                            let file_path = r_dir.join(&filename);
                            let _ = std::fs::write(&file_path, &bytes);
                        }

                        downloaded_pages.push((filename, w, h, bytes));
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to download page: {e}");
                }
            }
        }
    } else {
        return Err(ApiError::bad_request("Unsupported manga source"));
    }

    if downloaded_pages.is_empty() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "Could not download any pages for this chapter"
        )));
    }

    // Sort page files naturally by name (just like manual directory import)
    downloaded_pages.sort_by(|a, b| natord::compare(&a.0, &b.0));

    let blobs = session.blobs.clone();
    let mut ops = Vec::new();
    let starting_index = {
        let scene = session.scene.read();
        scene.pages.len()
    };

    // Store downloaded page bytes into Blobs, and register as new Pages
    for (i, (filename, w, h, bytes)) in downloaded_pages.into_iter().enumerate() {
        let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
        let mut page = Page::new(&filename, w, h);
        page.chapter_id = Some(chapter_id);

        let source_node_id = NodeId::new();
        page.nodes.insert(
            source_node_id,
            Node {
                id: source_node_id,
                transform: koharu_core::Transform::default(),
                visible: true,
                kind: NodeKind::Image(ImageData {
                    role: ImageRole::Source,
                    blob,
                    opacity: 1.0,
                    natural_width: w,
                    natural_height: h,
                    name: Some(filename),
                }),
            },
        );

        ops.push(Op::AddPage {
            page,
            at: starting_index + i,
        });
    }

    if !ops.is_empty() {
        session
            .apply(Op::Batch {
                ops,
                label: format!("Download chapter {} pages", req.chapter_name),
            })
            .map_err(ApiError::internal)?;
    }

    // Save project scene.bin
    session.compact().map_err(ApiError::internal)?;

    Ok(Json(koharu_app::app::project_summary(&session)))
}

// ---------------------------------------------------------------------------
// POST /manga/clone-connectors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneConnectorsRequest {
    pub target_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneConnectorsResponse {
    pub success: bool,
    pub message: String,
    pub files: Vec<String>,
}

const BUN_FETCH_PROVIDER: &str = r##"
import { FetchProvider } from './FetchProviderCommon';
import type { FeatureFlags } from '../FeatureFlags';
import { parseHTML } from 'linkedom';
import protobuf from 'protobufjs';

const dummy = parseHTML('<a></a>');
const LinkedomAnchor = dummy.HTMLAnchorElement;
const LinkedomImage = dummy.HTMLImageElement;
const LinkedomMeta = dummy.HTMLMetaElement;
const LinkedomElement = dummy.HTMLElement;

const urlProperties = ['pathname', 'search', 'hash', 'host', 'hostname', 'origin', 'protocol'];
for (const prop of urlProperties) {
    Object.defineProperty(LinkedomAnchor.prototype, prop, {
        get() {
            const href = this.getAttribute('href') || '';
            try {
                const url = new URL(href, 'http://localhost');
                return url[prop];
            } catch {
                return href;
            }
        },
        configurable: true,
        enumerable: true
    });
}

globalThis.DOMParser = class {
    parseFromString(markup: string, type: string) {
        const { document } = parseHTML(markup);
        return document;
    }
} as any;

globalThis.HTMLMetaElement = LinkedomMeta as any;
globalThis.HTMLAnchorElement = LinkedomAnchor as any;
globalThis.HTMLImageElement = LinkedomImage as any;
globalThis.HTMLElement = LinkedomElement as any;

class BunFetchProvider extends FetchProvider {
    async Fetch(request: Request): Promise<Response> {
        const headers = new Headers(request.headers);
        if (!headers.has('User-Agent')) {
            headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }

        // Intercept and bypass WeLoveManga (weloma.art) protection
        if (request.url.includes('weloma.art') && /\/\d+\/\d+/.test(request.url) && request.method === 'GET') {
            try {
                const res1 = await fetch(request.url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
                });
                const cookies1 = res1.headers.get('set-cookie') || '';
                const html1 = await res1.text();
                const tokenMatch = html1.match(/name="token"\s+value="([^"]+)"/i);
                if (tokenMatch) {
                    const token = tokenMatch[1];
                    const phpsessid = cookies1.match(/PHPSESSID=[^;]+/)?.[0] || '';
                    
                    const params = new URLSearchParams();
                    params.append('token', token);
                    params.append('action', 'type');
                    params.append('type', '');
                    
                    const res2 = await fetch(request.url, {
                        method: 'POST',
                        body: params,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest',
                            'Cookie': phpsessid,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Origin': 'https://weloma.art',
                            'Referer': 'https://weloma.art/index.html'
                        }
                    });
                    const cookies2 = res2.headers.get('set-cookie') || '';
                    
                    let cookieHeader = phpsessid;
                    const rotate = cookies2.match(/sl_rotate=[^;]+/)?.[0];
                    if (rotate) cookieHeader += '; ' + rotate;
                    cookieHeader += '; unlock_chapter_guest=1; smartlink_shown_guest=1; smartlink_shown=1';
                    
                    return fetch(request.url, {
                        headers: {
                            'Cookie': cookieHeader,
                            'Referer': 'https://weloma.art/',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    });
                }
            } catch (e) {
                console.error("WeLoMa bypass failed:", e);
            }
        }

        return fetch(request.url, {
            method: request.method,
            headers: headers,
            body: request.body,
            signal: request.signal
        });
    }

    async FetchProto(request: Request, schema: string, messageTypePath: string): Promise<any> {
        const response = await this.Fetch(request);
        if (!response.ok) {
            const bodyText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText || ''}: ${bodyText}`);
        }
        const serialized = new Uint8Array(await response.arrayBuffer());
        const prototype = protobuf.parse(schema, { keepCase: true }).root.lookupType(messageTypePath);
        return prototype.decode(serialized).toJSON();
    }

    async FetchRegex(request: Request, regex: RegExp): Promise<string[]> {
        if (regex.flags.indexOf('g') === -1) {
            throw new Error(`The provided RegExp must contain the global 'g' modifier!`);
        }
        const response = await this.Fetch(request);
        if (!response.ok) {
            const bodyText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText || ''}: ${bodyText}`);
        }
        const data = await response.text();
        const result: string[] = [];
        let match = undefined;
        while (match = regex.exec(data)) {
            result.push(match.at(1) || '');
        }
        return result;
    }
}

const instance = new BunFetchProvider();

export function SetupFetchProvider(featureFlags: FeatureFlags) {}

export const Fetch: typeof instance.Fetch = (request) => instance.Fetch(request);
export const FetchHTML: typeof instance.FetchHTML = (request) => instance.FetchHTML(request);
export const FetchRegex: typeof instance.FetchRegex = (request, regex) => instance.FetchRegex(request, regex);
export const FetchJSON: typeof instance.FetchJSON = (request) => instance.FetchJSON(request);
export const FetchCSS: typeof instance.FetchCSS = (request, query) => instance.FetchCSS(request, query);
export const FetchProto: typeof instance.FetchProto = (request, schema, messageTypePath) => instance.FetchProto(request, schema, messageTypePath);
export const FetchGraphQL: typeof instance.FetchGraphQL = (request, operationName, query, variables, extensions) => instance.FetchGraphQL(request, operationName, query, variables, extensions);
export const FetchNextJS: typeof instance.FetchNextJS = (request, predicate) => instance.FetchNextJS(request, predicate);
export const FetchWindowScript: typeof instance.FetchWindowScript = async (request, script, delay?, timeout?) => {
    try {
        const res = await Fetch(request);
        const html = await res.text();
        const { window, document } = parseHTML(html);

        // Set up self-contained pending promises queue on this temporary window context
        const pendingPromises: Promise<any>[] = [];

        // Patch URL properties for any parsed HTMLAnchorElement inside this temporary document
        const anchors = document.querySelectorAll('a');
        for (const anchor of anchors) {
            const anchorProto = Object.getPrototypeOf(anchor);
            if (!anchorProto.hasOwnProperty('pathname')) {
                const urlProperties = ['pathname', 'search', 'hash', 'host', 'hostname', 'origin', 'protocol'];
                for (const prop of urlProperties) {
                    Object.defineProperty(anchorProto, prop, {
                        get() {
                            const href = this.getAttribute('href') || '';
                            try {
                                const url = new URL(href, 'http://localhost');
                                return url[prop];
                            } catch {
                                return href;
                            }
                        },
                        configurable: true,
                        enumerable: true
                    });
                }
            }
        }

        // Apply our HTMX dispatch patch to the temporary HTMLElement prototype
        const elementProto = Object.getPrototypeOf(document.createElement('div'));
        if (!elementProto.hasOwnProperty('dispatchEventPatched')) {
            elementProto.dispatchEventPatched = true;
            const originalDispatchEvent = elementProto.dispatchEvent;
            elementProto.dispatchEvent = function(event: any) {
                const hxGet = this.getAttribute('hx-get');
                const hxTrigger = this.getAttribute('hx-trigger');
                if (hxGet && hxTrigger && event.type === hxTrigger.trim()) {
                    const url = hxGet.trim().replace(/&amp;/g, '&').replace(/&#038;/g, '&');
                    const p = fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'X-Requested-With': 'XMLHttpRequest'
                        }
                    })
                    .then(res => res.text())
                    .then(html => {
                        const swap = this.getAttribute('hx-swap') || 'innerHTML';
                        if (swap === 'outerHTML') {
                            const parent = this.parentNode;
                            if (parent) {
                                const temp = document.createElement('div');
                                temp.innerHTML = html.trim();
                                const newEl = Array.from(temp.childNodes).find((n: any) => n.nodeType === 1);
                                if (newEl) {
                                    parent.replaceChild(newEl, this);
                                }
                            }
                        } else {
                            this.innerHTML = html.trim();
                        }
                    })
                    .catch(err => {
                        console.error("HTMX hx-get dispatch fetch failed:", err);
                    });
                    pendingPromises.push(p);
                }
                return originalDispatchEvent.call(this, event);
            };
        }

        const prevWindow = globalThis.window;
        const prevDocument = globalThis.document;
        const prevSetTimeout = globalThis.setTimeout;

        globalThis.window = window as any;
        globalThis.document = document as any;

        // Patch globalThis.setTimeout to wait for HTMX AJAX swaps to finish
        (globalThis as any).setTimeout = function(callback: any, delay: any, ...args: any[]) {
            if (pendingPromises.length > 0) {
                const promises = [...pendingPromises];
                pendingPromises.length = 0; // Clear it
                Promise.all(promises).then(() => {
                    prevSetTimeout(callback, 50, ...args);
                }).catch(() => {
                    prevSetTimeout(callback, 50, ...args);
                });
                return 999;
            }
            return prevSetTimeout(callback, delay, ...args);
        } as any;

        try {
            // Trigger the HTMX event manually since dispatchEvent is mocked
            const chListEl = document.querySelector('#chapter-list');
            if (chListEl) {
                chListEl.dispatchEvent(new Event('getChapterList'));
            }

            let result: any;
            if (script.trim().startsWith('new Promise')) {
                // Wrap the script to catch any inner promise errors
                const modifiedScript = script.replace(
                    `resolve ( [...document.querySelectorAll('#chapter-list div[data-chapter-number]')].map(chapter => {`,
                    `
                    const elements = [...document.querySelectorAll('#chapter-list div[data-chapter-number]')];
                    resolve(elements.map(chapter => {
                        const aTag = chapter.querySelector('a');
                        if (!aTag) {
                            return { id: '', title: '' };
                        }
                    `
                ).replace(`}));`, `}));` /* keep original resolve ending */);

                const fn = new Function('document', 'window', `return ${modifiedScript.trim()}`);
                result = await fn(document, window);
            } else {
                let cleanScript = script.trim();
                while (cleanScript.endsWith(';')) {
                    cleanScript = cleanScript.slice(0, -1).trim();
                }
                const fn = new Function('document', 'window', `return (${cleanScript})`);
                result = fn(document, window);
            }
            return result;
        } catch (err) {
            console.error("FetchWindowScript execution failed with error:", err);
            return undefined as any;
        } finally {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
            globalThis.setTimeout = prevSetTimeout;
        }
    } catch (e) {
        console.error("Outer FetchWindowScript failed:", e);
        return undefined as any;
    }
};
export const FetchWindowPreloadScript: typeof instance.FetchWindowPreloadScript = (request, preload, script, delay = 0, timeout = 60_000) => {
    return FetchWindowScript(request, script, delay, timeout);
};
"##;

const BUN_TIMERS: &str = r#"
type Action = () => void;

export async function Delay(ms: number, variance = 0): Promise<void> {
    const delay = variance > 0 && variance < ms ? ms - variance + 2 * variance * Math.random() : ms;
    return new Promise<void>(resolve => setTimeout(resolve, delay));
}

export function SetTimeout(callback: Action, ms: number): Promise<number> {
    const id = setTimeout(callback, ms) as any;
    return Promise.resolve(id);
}

export function ClearTimeout(timerID: number): void {
    clearTimeout(timerID);
}

export function SetInterval(callback: Action, ms: number): Promise<number> {
    const id = setInterval(callback, ms) as any;
    return Promise.resolve(id);
}

export function ClearInterval(timerID: number): void {
    clearInterval(timerID);
}
"#;

fn find_haruneko_repo_root(staging_dir: &Path) -> Option<PathBuf> {
    let websites_path = Path::new("web").join("src").join("engine").join("websites");
    if staging_dir.join(&websites_path).exists() {
        return Some(staging_dir.to_path_buf());
    }

    for entry in std::fs::read_dir(staging_dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(&websites_path).exists() {
            return Some(path);
        }
    }

    None
}

async fn download_haruneko_repo(data_dir: &Path, repo_dir: &Path) -> Result<(), ApiError> {
    let client = reqwest::Client::builder()
        .user_agent("Koharu")
        .build()
        .map_err(api_internal)?;
    let mut last_error: Option<anyhow::Error> = None;

    for branch in ["master", "main"] {
        let url =
            format!("https://codeload.github.com/manga-download/haruneko/zip/refs/heads/{branch}");
        let response = match client.get(&url).send().await {
            Ok(response) => response,
            Err(err) => {
                last_error = Some(anyhow::Error::new(err));
                continue;
            }
        };

        if !response.status().is_success() {
            last_error = Some(anyhow::anyhow!(
                "Download failed from {url}: HTTP {}",
                response.status()
            ));
            continue;
        }

        let staging_dir = data_dir.join(format!("haruneko_repo_{branch}_download"));
        if staging_dir.exists() {
            std::fs::remove_dir_all(&staging_dir).map_err(api_internal)?;
        }
        std::fs::create_dir_all(&staging_dir).map_err(api_internal)?;

        let bytes = response.bytes().await.map_err(api_internal)?;
        extract_zip_bytes(&bytes, &staging_dir)?;

        let extracted_root = find_haruneko_repo_root(&staging_dir).ok_or_else(|| {
            ApiError::internal(anyhow::anyhow!(
                "Downloaded HaruNeko archive does not contain web/src/engine/websites."
            ))
        })?;

        if repo_dir.exists() {
            std::fs::remove_dir_all(repo_dir).map_err(api_internal)?;
        }
        if let Some(parent) = repo_dir.parent() {
            std::fs::create_dir_all(parent).map_err(api_internal)?;
        }

        std::fs::rename(&extracted_root, repo_dir).map_err(api_internal)?;
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Ok(());
    }

    Err(ApiError::internal(last_error.unwrap_or_else(|| {
        anyhow::anyhow!("Failed to download HaruNeko archive.")
    })))
}

#[utoipa::path(
    post,
    path = "/manga/clone-connectors",
    request_body = CloneConnectorsRequest,
    responses((status = 200, body = CloneConnectorsResponse))
)]
async fn clone_connectors(
    State(app): State<AppState>,
    Json(req): Json<CloneConnectorsRequest>,
) -> ApiResult<Json<CloneConnectorsResponse>> {
    let config = (**app.config.load()).clone();
    let system_scripts_dir = config.data.path.join("haruneko_scripts");
    let _ = std::fs::create_dir_all(&system_scripts_dir);

    let target_dir = if req.target_dir.trim().is_empty() {
        system_scripts_dir.clone()
    } else {
        let t = camino::Utf8PathBuf::from(&req.target_dir);
        if !t.exists() {
            let _ = std::fs::create_dir_all(t.as_std_path());
        }
        t
    };

    let repo_dir = config.data.path.join("haruneko_repo");
    if repo_dir.exists() {
        let _ = std::fs::remove_dir_all(&repo_dir);
    }

    download_haruneko_repo(config.data.path.as_std_path(), repo_dir.as_std_path()).await?;

    // Overwrite FetchProvider.ts with BunFetchProvider
    let fetch_provider_path = repo_dir
        .join("web")
        .join("src")
        .join("engine")
        .join("platform")
        .join("FetchProvider.ts");
    if std::fs::write(&fetch_provider_path, BUN_FETCH_PROVIDER).is_err() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "Failed to overwrite FetchProvider.ts"
        )));
    }

    // Overwrite BackgroundTimers.ts with Bun-timers
    let timers_path = repo_dir
        .join("web")
        .join("src")
        .join("engine")
        .join("BackgroundTimers.ts");
    if std::fs::write(&timers_path, BUN_TIMERS).is_err() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "Failed to overwrite BackgroundTimers.ts"
        )));
    }

    // Copy web/src/engine/websites contents to system_scripts_dir & target_dir
    let websites_dir = repo_dir
        .join("web")
        .join("src")
        .join("engine")
        .join("websites");
    let mut files = Vec::new();

    if websites_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&websites_dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        if file_name.ends_with(".ts")
                            || file_name.ends_with(".js")
                            || file_name.ends_with(".webp")
                        {
                            let src = entry.path();

                            // Copy to system scripts path
                            let sys_dest = system_scripts_dir.join(&file_name);
                            let _ = std::fs::copy(&src, &sys_dest);

                            // Copy to target path
                            let dest = target_dir.join(&file_name);
                            if std::fs::copy(&src, &dest).is_ok() {
                                if file_name.ends_with(".ts") || file_name.ends_with(".js") {
                                    files.push(file_name);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if files.is_empty() {
        return Err(ApiError::internal(anyhow::anyhow!(
            "No connector scripts found or copied."
        )));
    }

    files.sort();

    Ok(Json(CloneConnectorsResponse {
        success: true,
        message: format!(
            "Successfully installed {} HaruNeko website connectors.",
            files.len()
        ),
        files,
    }))
}

// ---------------------------------------------------------------------------
// POST /manga/install-git
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/manga/install-git",
    responses((status = 200, body = CloneConnectorsResponse))
)]
async fn install_git(State(_app): State<AppState>) -> ApiResult<Json<CloneConnectorsResponse>> {
    Ok(Json(CloneConnectorsResponse {
        success: true,
        message: "Git is no longer required. Koharu downloads connector archives directly."
            .to_string(),
        files: vec![],
    }))
}
