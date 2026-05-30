//! Managed-projects directory under `{data.path}/projects/`.
//!
//! Every `.khrproj/` lives here. Clients address projects by `id` (the
//! directory basename without the `.khrproj` extension). No path handling on
//! the client side — all operations (create, open, list, import) resolve
//! paths through these helpers.
//!
//! Thread-safety: directory allocation uses atomic `create_dir` so concurrent
//! clients never collide on the same name.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use camino::{Utf8Path, Utf8PathBuf};
use koharu_core::ProjectSummary;

use crate::AppConfig;
use serde_json;

pub const PROJECT_EXT: &str = "khrproj";

/// The managed projects directory. Created on first call.
pub fn projects_dir(config: &AppConfig) -> Result<Utf8PathBuf> {
    let root = config.data.path.join("projects");
    fs::create_dir_all(root.as_std_path())
        .with_context(|| format!("create projects root {root}"))?;
    Ok(root)
}

/// Resolve an `id` (directory basename, no extension) to its absolute path.
pub fn project_path(config: &AppConfig, id: &str) -> Result<Utf8PathBuf> {
    let slug = slugify(id);
    if slug.is_empty() {
        anyhow::bail!("invalid project id: {id}");
    }
    Ok(projects_dir(config)?.join(format!("{slug}.{PROJECT_EXT}")))
}

pub fn allocate_named_in_dir(parent_dir: &Utf8Path, name: &str) -> Result<Utf8PathBuf> {
    let base = {
        let s = slugify(name);
        if s.is_empty() {
            "untitled".to_string()
        } else {
            s
        }
    };
    for attempt in 0..1024 {
        let filename = if attempt == 0 {
            format!("{base}.{PROJECT_EXT}")
        } else {
            format!("{base}-{attempt}.{PROJECT_EXT}")
        };
        let candidate = parent_dir.join(&filename);
        match fs::create_dir(candidate.as_std_path()) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(anyhow::Error::new(e).context(format!("create {candidate}"))),
        }
    }
    anyhow::bail!("could not allocate a fresh project directory (1024 collisions)")
}

/// Pick a fresh `{projects_dir}/{slug}.khrproj` path for a new project with
/// the given display name. Sanitises the name, retries with `-2`, `-3`, … on
/// collision. Creates the directory atomically so concurrent callers never
/// land on the same path.
pub fn allocate_named(config: &AppConfig, name: &str) -> Result<Utf8PathBuf> {
    let root = projects_dir(config)?;
    allocate_named_in_dir(&root, name)
}

/// Pick a fresh path for an imported archive. Uses the archive-provided name
/// as the base when it's non-empty; otherwise `imported`.
pub fn allocate_imported(config: &AppConfig, name_hint: Option<&str>) -> Result<Utf8PathBuf> {
    allocate_named(config, name_hint.unwrap_or("imported"))
}

/// List every `.khrproj/` directory under the managed projects root. Reads
/// `project.toml` to derive the display name; falls back to the directory
/// slug if the file can't be read. Sorted by `updated_at_ms` descending.
pub fn list_projects(config: &AppConfig) -> Result<Vec<ProjectSummary>> {
    let root = projects_dir(config)?;
    let mut out: Vec<ProjectSummary> = Vec::new();
    let entries = match fs::read_dir(root.as_std_path()) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(anyhow::Error::new(e)),
    };
    for entry in entries.flatten() {
        let ftype = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ftype.is_dir() {
            continue;
        }
        let name_os = entry.file_name();
        let Some(filename) = name_os.to_str() else {
            continue;
        };
        let Some(id) = filename.strip_suffix(&format!(".{PROJECT_EXT}")) else {
            continue;
        };
        let abs = root.join(filename);
        let display = read_project_name(&abs).unwrap_or_else(|| id.to_string());
        let updated_at_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(ProjectSummary {
            id: id.to_string(),
            name: display,
            path: abs.to_string(),
            updated_at_ms,
        });
    }

    // Merge with recent projects!
    let r_path = recent_projects_path();
    if r_path.exists() {
        if let Ok(text) = fs::read_to_string(r_path.as_std_path()) {
            if let Ok(recent_list) = serde_json::from_str::<Vec<Utf8PathBuf>>(&text) {
                let mut updated_recents = recent_list.clone();
                let mut list_changed = false;

                for path in recent_list {
                    if !path.exists() {
                        // Cleanup deleted projects from recent registry
                        updated_recents.retain(|p| p != &path);
                        list_changed = true;
                        continue;
                    }

                    // If already included via default projects dir scanning, skip duplicate
                    if out.iter().any(|p| p.path == path.as_str()) {
                        continue;
                    }

                    let Some(id) = id_from_dir(&path) else {
                        continue;
                    };

                    let display = read_project_name(&path).unwrap_or_else(|| id.clone());
                    let updated_at_ms = std::fs::metadata(path.as_std_path())
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    out.push(ProjectSummary {
                        id,
                        name: display,
                        path: path.to_string(),
                        updated_at_ms,
                    });
                }

                if list_changed {
                    let _ = serde_json::to_string_pretty(&updated_recents).map(|t| {
                        let _ = fs::write(r_path.as_std_path(), t);
                    });
                }
            }
        }
    }

    out.sort_by_key(|project| std::cmp::Reverse(project.updated_at_ms));
    Ok(out)
}

/// Produce an id for a `.khrproj/` directory basename.
pub fn id_from_dir(dir: &Utf8Path) -> Option<String> {
    dir.file_name()
        .and_then(|n| n.strip_suffix(&format!(".{PROJECT_EXT}")))
        .map(|s| s.to_string())
}

pub fn recent_projects_path() -> Utf8PathBuf {
    koharu_runtime::default_app_data_root().join("recent_projects.json")
}

pub fn add_recent_project(path: &Utf8Path) -> Result<()> {
    let r_path = recent_projects_path();
    if let Some(parent) = r_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut list = if r_path.exists() {
        let text = fs::read_to_string(r_path.as_std_path())?;
        serde_json::from_str::<Vec<Utf8PathBuf>>(&text).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Remove if exists
    let abs_path = path.to_path_buf();
    list.retain(|p| p != &abs_path);

    // Prepend
    list.insert(0, abs_path);

    // Keep max 50
    if list.len() > 50 {
        list.truncate(50);
    }

    let text = serde_json::to_string_pretty(&list)?;
    fs::write(r_path.as_std_path(), text)?;
    Ok(())
}

pub fn remove_recent_project(path: &Utf8Path) -> Result<()> {
    let r_path = recent_projects_path();
    if r_path.exists() {
        let text = fs::read_to_string(r_path.as_std_path())?;
        let mut list = serde_json::from_str::<Vec<Utf8PathBuf>>(&text).unwrap_or_default();
        let abs_path = path.to_path_buf();
        let old_len = list.len();
        list.retain(|p| p != &abs_path);
        if list.len() != old_len {
            let text = serde_json::to_string_pretty(&list)?;
            fs::write(r_path.as_std_path(), text)?;
        }
    }
    Ok(())
}

pub fn find_recent_project_path(id: &str) -> Option<Utf8PathBuf> {
    let r_path = recent_projects_path();
    if r_path.exists() {
        let text = fs::read_to_string(r_path.as_std_path()).ok()?;
        let list = serde_json::from_str::<Vec<Utf8PathBuf>>(&text).ok()?;
        for path in list {
            if let Some(p_id) = id_from_dir(&path) {
                if p_id == id {
                    return Some(path);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn read_project_name(dir: &Utf8Path) -> Option<String> {
    let toml_path = dir.join("project.toml");
    let text = fs::read_to_string(toml_path.as_std_path()).ok()?;
    // Minimal parse: look for `name = "..."` on a line. Avoids adding a toml
    // dependency here; the real config is parsed inside the session.
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("name") {
            let rest = rest.trim_start();
            let Some(rest) = rest.strip_prefix('=') else {
                continue;
            };
            let rest = rest.trim();
            let name = rest.trim_matches(|c| c == '"' || c == '\'').to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn remove_vietnamese_diacritics(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let mapped = match ch {
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ' | 'ặ' | 'ẳ' | 'ẵ' |
            'À' | 'Á' | 'Ạ' | 'Ả' | 'Ã' | 'Â' | 'Ầ' | 'Ấ' | 'Ậ' | 'Ẩ' | 'Ẫ' | 'Ă' | 'Ằ' | 'Ắ' | 'Ặ' | 'Ẳ' | 'Ẵ' => 'a',
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' |
            'È' | 'É' | 'Ẹ' | 'Ẻ' | 'Ẽ' | 'Ê' | 'Ề' | 'Ế' | 'Ệ' | 'Ể' | 'Ễ' => 'e',
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' |
            'Ì' | 'Í' | 'Ị' | 'Ỉ' | 'Ĩ' => 'i',
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ' | 'ợ' | 'ở' | 'ỡ' |
            'Ò' | 'Ó' | 'Ọ' | 'Ỏ' | 'Õ' | 'Ô' | 'Ồ' | 'Ố' | 'Ộ' | 'Ổ' | 'Ỗ' | 'Ơ' | 'Ờ' | 'Ớ' | 'Ợ' | 'Ở' | 'Ỡ' => 'o',
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' |
            'Ù' | 'Ú' | 'Ụ' | 'Ủ' | 'Ũ' | 'Ư' | 'Ừ' | 'Ứ' | 'Ự' | 'Ử' | 'Ữ' => 'u',
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' |
            'Ỳ' | 'Ý' | 'Ỵ' | 'Ỷ' | 'Ỹ' => 'y',
            'đ' | 'Đ' => 'd',
            other => other,
        };
        out.push(mapped);
    }
    out
}

/// Lowercase + keep ASCII alphanumerics + `-` + `_`; collapse whitespace to
/// `-`. Keeps the result filesystem-safe across Win/Mac/Linux without needing
/// heavier slug libraries.
fn slugify(input: &str) -> String {
    let normalized = remove_vietnamese_diacritics(input);
    let mut out = String::with_capacity(normalized.len());
    let mut prev_dash = false;
    for ch in normalized.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if c == '-' || c == '_' {
            if !out.is_empty() && !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        } else if c.is_whitespace() && !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        // Other chars dropped silently.
    }
    let _ = SystemTime::now().duration_since(UNIX_EPOCH); // silence unused import warn
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Project"), "my-project");
        assert_eq!(slugify("  leading and trailing  "), "leading-and-trailing");
        assert_eq!(slugify("under_score_already"), "under-score-already");
        assert_eq!(slugify("你好 hello"), "hello");
        assert_eq!(slugify("--dashes--"), "dashes");
        assert_eq!(slugify("chạy bộ"), "chay-bo");
    }
}
