//! Pipeline: runs an ordered set of engines across one or more pages and
//! wraps each engine's output in one `Op::Batch` before applying via the
//! session's history.
//!
//! **Engines don't mutate the scene.** They return `Vec<Op>`; this driver
//! applies them transactionally (per-engine) against the active session.

pub mod artifacts;
pub mod engine;
mod engines;

pub use artifacts::Artifact;
pub use engine::{
    BoxFuture, Engine, EngineCtx, EngineInfo, EngineLoadFn, PipelineRunOptions, Registry,
    build_order,
};
pub use engines::support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, bail};
use koharu_core::{NodeId, Op, PageId, PipelineStep, NodeDataPatch, NodePatch, TextDataPatch};
use crate::pipeline::engines::llm_translate::build_reinforced_system_prompt;
use koharu_runtime::RuntimeManager;

/// Observer for pipeline progress. `step_id` is the engine id of the step
/// about to run (or just finished); step_index / page_index are 0-based.
pub type ProgressSink = Arc<dyn Fn(ProgressTick) + Send + Sync>;

/// Observer for non-fatal step failures. Called once per failed step; the
/// pipeline skips the rest of that page's steps and moves on to the next
/// page.
pub type WarningSink = Arc<dyn Fn(WarningTick) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ProgressTick {
    /// Coarse UI-facing step tag derived from the engine's primary
    /// produced artifact. `None` for the final 100% tick where no engine
    /// is running.
    pub step: Option<PipelineStep>,
    /// Engine id (e.g. `"paddle-ocr-vl-1.5"`) for diagnostics + logs.
    pub step_id: String,
    pub step_index: usize,
    pub total_steps: usize,
    pub page_index: usize,
    pub total_pages: usize,
    pub overall_percent: u8,
}

#[derive(Debug, Clone)]
pub struct WarningTick {
    pub step_id: String,
    pub page_index: usize,
    pub total_pages: usize,
    pub message: String,
}

/// Returned by [`run`]. `warning_count == 0` means the run finished cleanly.
#[derive(Debug, Clone, Default)]
pub struct RunOutcome {
    pub warning_count: usize,
}

/// Map an engine's produced artifact to its UI step category. Stays
/// co-located with the engine metadata so adding a new engine can't
/// silently bypass the toolbar spinner — only the registered artifact
/// matters, not the engine's string id.
fn step_for(info: &EngineInfo) -> Option<PipelineStep> {
    info.produces.iter().find_map(|a| match a {
        Artifact::TextBoxes
        | Artifact::SegmentMask
        | Artifact::FontPredictions
        | Artifact::BubbleMask => Some(PipelineStep::Detect),
        Artifact::OcrText => Some(PipelineStep::Ocr),
        Artifact::Translations => Some(PipelineStep::LlmGenerate),
        Artifact::Inpainted => Some(PipelineStep::Inpaint),
        Artifact::FinalRender => Some(PipelineStep::Render),
        // Non-UI-facing artifacts (inputs, intermediate sprites) — no
        // toolbar step tag.
        _ => None,
    })
}

use crate::llm;
use crate::renderer;
use crate::session::ProjectSession;

// ---------------------------------------------------------------------------
// Spec + scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PipelineSpec {
    pub scope: Scope,
    pub steps: Vec<String>,
    pub options: PipelineRunOptions,
}

#[derive(Debug, Clone)]
pub enum Scope {
    WholeProject,
    Pages(Vec<PageId>),
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Execute `spec` against `session`. Each engine step becomes one `Op::Batch`
/// applied via the session's history (one undo step per step per page).
///
/// A failed step on a given page is non-fatal: the rest of that page's steps
/// are skipped (they typically depend on the failed step's output), one
/// [`WarningTick`] is emitted via `warnings`, and the driver moves on to the
/// next page. The function returns the total number of per-step warnings
/// that fired, letting callers flag the run as `CompletedWithErrors`.
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(level = "info", skip_all)]
pub async fn run(
    session: Arc<ProjectSession>,
    registry: Arc<Registry>,
    runtime: Arc<RuntimeManager>,
    cpu: bool,
    llm: Arc<llm::Model>,
    renderer: Arc<renderer::Renderer>,
    spec: PipelineSpec,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressSink>,
    warnings: Option<WarningSink>,
) -> Result<RunOutcome> {
    let infos: Vec<&EngineInfo> = spec
        .steps
        .iter()
        .map(|id| Registry::find(id))
        .collect::<Result<_>>()?;
    let order = build_order(&infos)?;

    let pages = match &spec.scope {
        Scope::WholeProject => session
            .scene
            .read()
            .pages
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        Scope::Pages(ids) => ids.clone(),
    };

    let total_pages = pages.len().max(1);
    let total_steps = order.len().max(1);
    let total_units = (total_pages * total_steps) as u64;
    let mut completed: u64 = 0;
    let mut warning_count: usize = 0;

    for (seq, &i) in order.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        let info = infos[i];

        if info.id == "llm" {
            if let Some(sink) = progress.as_ref() {
                let percent = ((completed * 100) / total_units).min(100) as u8;
                sink(ProgressTick {
                    step: step_for(info),
                    step_id: info.id.to_string(),
                    step_index: seq,
                    total_steps,
                    page_index: 0,
                    total_pages,
                    overall_percent: percent,
                });
            }

            let scene_snap = session.scene_snapshot();
            
            for page_chunk in pages.chunks(5) {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                
                let mut chunk_targets: Vec<(PageId, usize, String, String, bool, String, (NodeId, String))> = Vec::new();
                for (page_index, page_id) in pages.iter().enumerate() {
                    if !page_chunk.contains(page_id) {
                        continue;
                    }
                    if !session.scene.read().pages.contains_key(page_id) {
                        continue;
                    }
                    
                    let text_nodes_list = support::text_nodes(&scene_snap, *page_id);
                    let page_name = scene_snap.pages.get(page_id).map(|p| p.name.clone()).unwrap_or_else(|| "Unknown Page".to_string());
                    let chapter_name = scene_snap.pages.get(page_id)
                        .and_then(|p| p.chapter_id)
                        .and_then(|cid| scene_snap.chapters.get(&cid))
                        .map(|ch| ch.name.clone())
                        .unwrap_or_else(|| "Unknown Chapter".to_string());

                    for (node_id, _, text_data) in text_nodes_list {
                        if let Some(ref source_text) = text_data.text {
                            if source_text.trim().is_empty() {
                                continue;
                            }
                            
                            let is_allowed = match spec.options.text_node_ids.as_deref() {
                                Some(ids) => ids.contains(&node_id),
                                None => true,
                            };
                            if !is_allowed {
                                continue;
                            }

                            let translation = text_data.translation.as_deref().unwrap_or("").trim().to_string();
                            let already_translated = !translation.is_empty();

                            chunk_targets.push((
                                *page_id,
                                page_index,
                                page_name.clone(),
                                chapter_name.clone(),
                                already_translated,
                                translation,
                                (node_id, source_text.clone())
                            ));
                        }
                    }
                }

                let has_untranslated = chunk_targets.iter().any(|(_, _, _, _, already_translated, _, _)| !*already_translated);

                if !chunk_targets.is_empty() && has_untranslated {
                    let target_lang = spec.options.target_language.as_deref().unwrap_or("Vietnamese");
                    let first_page_id = chunk_targets[0].0;
                    let reinforced_prompt = build_reinforced_system_prompt(
                        &scene_snap,
                        first_page_id,
                        target_lang,
                        spec.options.system_prompt.as_deref(),
                    );

                    let mut structured_body = String::new();
                    let mut current_page_key: Option<(PageId, String)> = None;
                    for (idx, (page_id, page_index, page_name, chapter_name, already_translated, translation, (_, source_text))) in chunk_targets.iter().enumerate() {
                        let page_key = (*page_id, page_name.clone());
                        if current_page_key.as_ref() != Some(&page_key) {
                            current_page_key = Some(page_key);
                            structured_body.push_str(&format!(
                                "\n=== {}, {} (Page Index #{}) ===\n",
                                chapter_name,
                                page_name,
                                page_index + 1
                            ));
                        }
                        if *already_translated {
                            structured_body.push_str(&format!(
                                "[{}] (Already Translated) Original: \"{}\" -> Translated: \"{}\"\n",
                                idx + 1,
                                source_text,
                                translation
                            ));
                        } else {
                            structured_body.push_str(&format!("[{}]{}\n", idx + 1, source_text));
                        }
                    }

                    let sources: Vec<String> = chunk_targets.iter().map(|(_, _, _, _, _, _, (_, s))| s.clone()).collect();
                    
                    match llm.translate_texts(&sources, Some(target_lang), Some(&reinforced_prompt), Some(&structured_body)).await {
                        Ok(translations) => {
                            let mut page_ops: std::collections::HashMap<PageId, Vec<Op>> = std::collections::HashMap::new();
                            for ((page_id, _, _, _, already_translated, _, (node_id, _)), translation) in chunk_targets.into_iter().zip(translations) {
                                if already_translated {
                                    continue;
                                }
                                page_ops.entry(page_id).or_default().push(Op::UpdateNode {
                                    page: page_id,
                                    id: node_id,
                                    patch: NodePatch {
                                        data: Some(NodeDataPatch::Text(TextDataPatch {
                                            translation: Some(Some(translation)),
                                            ..Default::default()
                                        })),
                                        transform: None,
                                        visible: None,
                                    },
                                    prev: NodePatch::default(),
                                });
                            }

                            for (page_id, ops) in page_ops {
                                if cancel.load(Ordering::Relaxed) {
                                    bail!("cancelled");
                                }
                                if ops.is_empty() {
                                    continue;
                                }
                                let batch = Op::Batch {
                                    ops,
                                    label: format!("llm: page {page_id}"),
                                };
                                if let Err(err) = session.apply(batch) {
                                    tracing::error!("Failed to apply translation batch for page {page_id}: {err}");
                                }
                            }
                        }
                        Err(err) => {
                            let err_str = err.to_string();
                            let is_no_llm = err_str.contains("no LLM loaded") || err_str.contains("LLM is still loading") || err_str.contains("LLM failed to load");
                            if is_no_llm {
                                tracing::warn!("LLM translate skipped: {err_str}");
                                if let Some(sink) = warnings.as_ref() {
                                    sink(WarningTick {
                                        step_id: info.id.to_string(),
                                        page_index: 0,
                                        total_pages,
                                        message: format!("Skipped: {err_str}. You can load LLM and translate these pages later."),
                                    });
                                }
                            } else {
                                for (page_index, page_id) in pages.iter().enumerate() {
                                    if page_chunk.contains(page_id) {
                                        report_step_failure(
                                            info.id,
                                            page_id,
                                            seq,
                                            page_index,
                                            total_pages,
                                            total_steps,
                                            &err,
                                            &mut warning_count,
                                            warnings.as_ref(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                completed += page_chunk.len() as u64;

                if let Some(sink) = progress.as_ref() {
                    let percent = ((completed * 100) / total_units).min(100) as u8;
                    sink(ProgressTick {
                        step: step_for(info),
                        step_id: info.id.to_string(),
                        step_index: seq,
                        total_steps,
                        page_index: 0,
                        total_pages,
                        overall_percent: percent,
                    });
                }
            }
        } else {
            // Pre-load the engine once sequentially to prevent concurrent loading race conditions
            let _ = registry.get(&info.id, &runtime, cpu).await?;

            let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
            let mut tasks = Vec::new();

            for (page_index, page_id) in pages.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    bail!("cancelled");
                }
                
                if !session.scene.read().pages.contains_key(page_id) {
                    completed += 1;
                    continue;
                }

                if let Some(sink) = progress.as_ref() {
                    let percent = ((completed * 100) / total_units).min(100) as u8;
                    sink(ProgressTick {
                        step: step_for(info),
                        step_id: info.id.to_string(),
                        step_index: seq,
                        total_steps,
                        page_index,
                        total_pages,
                        overall_percent: percent,
                    });
                }

                let sem = semaphore.clone();
                let registry = registry.clone();
                let runtime = runtime.clone();
                let session = session.clone();
                let llm = llm.clone();
                let renderer = renderer.clone();
                let spec = spec.clone();
                let cancel = cancel.clone();
                let page_id = *page_id;
                let info_id = info.id.to_string();
                let info_produces = info.produces;

                tasks.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.map_err(|e| anyhow::anyhow!("failed to acquire semaphore: {e}"))?;
                    
                    let scene_snap = session.scene_snapshot();
                    if let Some(page) = scene_snap.pages.get(&page_id) {
                        let is_inpaint_or_render = info_produces.iter().any(|&art| {
                            art == Artifact::Inpainted || art == Artifact::FinalRender
                        });
                        let already_ready = !is_inpaint_or_render && info_produces.iter().all(|&art| art.ready(page));
                        if already_ready {
                            return Ok::<_, anyhow::Error>((page_id, page_index, Vec::new()));
                        }
                    }

                    let engine = registry.get(&info_id, &runtime, cpu).await?;
                    let ctx = EngineCtx {
                        scene: &scene_snap,
                        page: page_id,
                        blobs: &session.blobs,
                        runtime: &runtime,
                        cancel: &cancel,
                        options: &spec.options,
                        llm: &llm,
                        renderer: &renderer,
                    };
                    
                    let ops = engine.run(ctx).await?;
                    Ok::<_, anyhow::Error>((page_id, page_index, ops))
                }));
            }

            for task in tasks {
                if cancel.load(Ordering::Relaxed) {
                    bail!("cancelled");
                }
                match task.await {
                    Ok(Ok((page_id, page_index, ops))) => {
                        if cancel.load(Ordering::Relaxed) {
                            bail!("cancelled");
                        }
                        completed += 1;
                        if ops.is_empty() {
                            continue;
                        }
                        let batch = Op::Batch {
                            ops,
                            label: format!("{}: page {}", info.id, page_id),
                        };
                        if let Err(err) = session.apply(batch) {
                            report_step_failure(
                                info.id,
                                &page_id,
                                seq,
                                page_index,
                                total_pages,
                                total_steps,
                                &err,
                                &mut warning_count,
                                warnings.as_ref(),
                            );
                        }
                    }
                    Ok(Err(err)) => {
                        completed += 1;
                        tracing::error!("Pipeline step failed: {err}");
                        warning_count += 1;
                    }
                    Err(err) => {
                        completed += 1;
                        tracing::error!("Pipeline task join failed: {err}");
                        warning_count += 1;
                    }
                }
            }
        }
    }

    if let Some(sink) = progress.as_ref() {
        sink(ProgressTick {
            step: None,
            step_id: String::new(),
            step_index: total_steps.saturating_sub(1),
            total_steps,
            page_index: total_pages.saturating_sub(1),
            total_pages,
            overall_percent: 100,
        });
    }
    Ok(RunOutcome { warning_count })
}

#[allow(clippy::too_many_arguments)]
fn report_step_failure(
    engine_id: &str,
    page_id: &PageId,
    step_index: usize,
    page_index: usize,
    total_pages: usize,
    total_steps: usize,
    err: &anyhow::Error,
    warning_count: &mut usize,
    sink: Option<&WarningSink>,
) {
    let _ = total_steps;
    tracing::warn!(
        engine = engine_id,
        page = %page_id,
        step_index,
        "pipeline step failed: {err:#}"
    );
    *warning_count += 1;
    if let Some(sink) = sink {
        sink(WarningTick {
            step_id: engine_id.to_string(),
            page_index,
            total_pages,
            message: format!("{err:#}"),
        });
    }
}

// ---------------------------------------------------------------------------
// Engine catalog building (API surface)
// ---------------------------------------------------------------------------

use koharu_core::{EngineCatalog, EngineCatalogEntry};

/// Build the engine catalog DTO for the API.
pub fn catalog() -> EngineCatalog {
    let entry = |info: &&EngineInfo| EngineCatalogEntry {
        id: info.id.to_string(),
        name: info.name.to_string(),
        produces: info.produces.iter().map(|a| format!("{a:?}")).collect(),
    };
    EngineCatalog {
        detectors: Registry::providers(Artifact::TextBoxes)
            .iter()
            .map(entry)
            .collect(),
        font_detectors: Registry::providers(Artifact::FontPredictions)
            .iter()
            .map(entry)
            .collect(),
        segmenters: Registry::providers(Artifact::SegmentMask)
            .iter()
            .map(entry)
            .collect(),
        bubble_segmenters: Registry::providers(Artifact::BubbleMask)
            .iter()
            .map(entry)
            .collect(),
        ocr: Registry::providers(Artifact::OcrText)
            .iter()
            .map(entry)
            .collect(),
        translators: Registry::providers(Artifact::Translations)
            .iter()
            .map(entry)
            .collect(),
        inpainters: Registry::providers(Artifact::Inpainted)
            .iter()
            .map(entry)
            .collect(),
        renderers: Registry::providers(Artifact::FinalRender)
            .iter()
            .map(entry)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_includes_anime_text_detector() {
        let catalog = catalog();

        assert!(catalog.detectors.iter().any(|engine| {
            engine.id == "anime-text"
                && engine.name == "Anime Text YOLO (N)"
                && engine.produces.iter().map(String::as_str).eq(["TextBoxes"])
        }));
    }
}
