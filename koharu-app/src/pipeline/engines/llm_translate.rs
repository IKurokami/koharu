//! LLM-driven translation. Collects `text` from every text node on the page,
//! sends them through the loaded LLM as tagged blocks, writes the parsed
//! translations back via `UpdateNode { TextDataPatch { translation } }`.

use anyhow::Result;
use async_trait::async_trait;
use koharu_core::{NodeDataPatch, NodeId, NodePatch, Op, PageId, Scene, TextData, TextDataPatch};

use crate::pipeline::artifacts::Artifact;
use crate::pipeline::engine::{Engine, EngineCtx, EngineInfo};
use crate::pipeline::engines::support::text_nodes;

pub struct Model;

pub fn build_reinforced_system_prompt(
    scene: &Scene,
    current_page_id: PageId,
    target_lang: &str,
    user_system_prompt: Option<&str>,
) -> String {
    let mut prompt = String::new();

    prompt.push_str("You are a professional manga and comic translator.\n");
    if let Some(user_prompt) = user_system_prompt {
        prompt.push_str(&format!("{}\n", user_prompt));
    }
    
    prompt.push_str(&format!(
        "\nYour task is to translate the text blocks below into {}.\n",
        target_lang
    ));

    prompt.push_str(&format!(
        "Current Project: \"{}\"\n\n",
        scene.project.name
    ));

    let current_page = scene.pages.get(&current_page_id);
    let active_chapter_id = current_page.and_then(|p| p.chapter_id);

    let mut same_chapter_memory = Vec::new();
    let mut other_chapter_memory = Vec::new();

    for (page_id, page) in &scene.pages {
        if *page_id == current_page_id {
            continue;
        }
        let chapter_name = page.chapter_id
            .and_then(|cid| scene.chapters.get(&cid))
            .map(|ch| ch.name.as_str())
            .unwrap_or("Unknown Chapter");

        let mut text_node_count = 0;
        for node in page.nodes.values() {
            if let koharu_core::NodeKind::Text(text_data) = &node.kind {
                text_node_count += 1;
                if let (Some(ocr), Some(trans)) = (&text_data.text, &text_data.translation) {
                    let ocr_trimmed = ocr.trim();
                    let trans_trimmed = trans.trim();
                    if !ocr_trimmed.is_empty() && !trans_trimmed.is_empty() {
                        let page_idx = scene.pages.get_index_of(page_id).map(|idx| idx + 1).unwrap_or(0);
                        let entry = format!(
                            "[{ch_name}][Page: {pg_name} (Index #{pg_idx})][Bubble #{bubble_idx}] Original: \"{ocr}\" -> Translated: \"{trans}\"",
                            ch_name = chapter_name,
                            pg_name = page.name,
                            pg_idx = page_idx,
                            bubble_idx = text_node_count,
                            ocr = ocr_trimmed,
                            trans = trans_trimmed
                        );
                        if page.chapter_id == active_chapter_id && active_chapter_id.is_some() {
                            same_chapter_memory.push(entry);
                        } else {
                            other_chapter_memory.push(entry);
                        }
                    }
                }
            }
        }
    }

    if !same_chapter_memory.is_empty() {
        prompt.push_str("--- CONTEXT FROM THE CURRENT CHAPTER ---\n");
        prompt.push_str("Use the following translated blocks from this same chapter to maintain identical character names, terminology, and speech tone:\n");
        for entry in same_chapter_memory.iter().take(15) {
            prompt.push_str(&format!("* {}\n", entry));
        }
        prompt.push_str("\n");
    }

    if !other_chapter_memory.is_empty() {
        prompt.push_str("--- CONTEXT FROM OTHER CHAPTERS ---\n");
        prompt.push_str("Here is general translation context from other chapters in the same project for global terminology consistency:\n");
        for entry in other_chapter_memory.iter().take(10) {
            prompt.push_str(&format!("* {}\n", entry));
        }
        prompt.push_str("\n");
    }

    prompt.push_str("--- TRANSLATION DIRECTIVE ---\n");
    prompt.push_str("Translate the new text blocks below. Match the naming, vocabulary, and stylistic conventions established in the context above strictly. Follow the provided structural page headers (e.g. === PAGE ... ===) to understand the sequential flow of dialogue.");

    prompt
}

#[async_trait]
impl Engine for Model {
    async fn run(&self, ctx: EngineCtx<'_>) -> Result<Vec<Op>> {
        let targets = collect_translation_targets(&ctx);
        if targets.is_empty() {
            return Ok(Vec::new());
        }

        let target_lang = ctx.options.target_language.as_deref().unwrap_or("Vietnamese");
        let reinforced_prompt = build_reinforced_system_prompt(
            ctx.scene,
            ctx.page,
            target_lang,
            ctx.options.system_prompt.as_deref(),
        );

        let sources: Vec<String> = targets.iter().map(|(_, s)| s.clone()).collect();
        let translations = ctx
            .llm
            .translate_texts(
                &sources,
                Some(target_lang),
                Some(&reinforced_prompt),
                None,
            )
            .await?;

        let mut ops = Vec::with_capacity(targets.len());
        for ((node_id, _), translation) in targets.into_iter().zip(translations) {
            ops.push(Op::UpdateNode {
                page: ctx.page,
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
        Ok(ops)
    }
}

fn collect_translation_targets(ctx: &EngineCtx<'_>) -> Vec<(NodeId, String)> {
    collect_translation_targets_from(ctx.scene, ctx.page, ctx.options.text_node_ids.as_deref())
}

pub fn collect_translation_targets_from(
    scene: &Scene,
    page: PageId,
    allowed_ids: Option<&[NodeId]>,
) -> Vec<(NodeId, String)> {
    text_nodes(scene, page)
        .into_iter()
        .filter(|(id, _, text_data)| should_translate(*id, text_data, allowed_ids))
        .filter_map(|(id, _, text_data)| text_data.text.as_ref().map(|source| (id, source.clone())))
        .collect()
}

fn should_translate(id: NodeId, text_data: &TextData, allowed_ids: Option<&[NodeId]>) -> bool {
    if let Some(ids) = allowed_ids {
        if !ids.contains(&id) {
            return false;
        }
    } else if let Some(ref trans) = text_data.translation {
        if !trans.trim().is_empty() {
            return false;
        }
    }
    text_data
        .text
        .as_ref()
        .is_some_and(|source| !source.trim().is_empty())
}

inventory::submit! {
    EngineInfo {
        id: "llm",
        name: "LLM",
        needs: &[Artifact::OcrText],
        produces: &[Artifact::Translations],
        load: |_runtime, _cpu| Box::pin(async move {
            Ok(Box::new(Model) as Box<dyn Engine>)
        }),
    }
}

#[cfg(test)]
mod tests {
    use koharu_core::{Node, NodeKind, Page, PageId, Scene, TextData, Transform};
    use uuid::Uuid;

    use super::*;

    fn node_id(value: u128) -> NodeId {
        NodeId(Uuid::from_u128(value))
    }

    fn page_id() -> PageId {
        PageId(Uuid::from_u128(1))
    }

    fn text_node(id: NodeId, text: Option<&str>) -> Node {
        Node {
            id,
            transform: Transform::default(),
            visible: true,
            kind: NodeKind::Text(TextData {
                text: text.map(str::to_string),
                ..Default::default()
            }),
        }
    }

    fn scene_with_texts(nodes: Vec<Node>) -> Scene {
        let page_id = page_id();
        let mut page = Page::new("page", 100, 100);
        page.id = page_id;
        page.nodes = nodes.into_iter().map(|node| (node.id, node)).collect();
        let mut scene = Scene::default();
        scene.pages.insert(page_id, page);
        scene
    }

    #[test]
    fn should_translate_only_requested_nodes() {
        let first = node_id(11);
        let second = node_id(22);
        let scene = scene_with_texts(vec![
            text_node(first, Some("first")),
            text_node(second, Some("second")),
        ]);
        let options = crate::PipelineRunOptions {
            text_node_ids: Some(vec![second]),
            ..Default::default()
        };

        let targets =
            collect_translation_targets_from(&scene, page_id(), options.text_node_ids.as_deref());

        assert_eq!(targets, vec![(second, "second".to_string())]);
    }

    #[test]
    fn should_ignore_requested_nodes_without_ocr_text() {
        let blank = node_id(33);
        let scene = scene_with_texts(vec![
            text_node(blank, Some("   ")),
            text_node(node_id(44), Some("translated")),
        ]);
        let options = crate::PipelineRunOptions {
            text_node_ids: Some(vec![blank]),
            ..Default::default()
        };

        let targets =
            collect_translation_targets_from(&scene, page_id(), options.text_node_ids.as_deref());

        assert!(targets.is_empty());
    }

    #[test]
    fn should_build_reinforced_prompt_containing_translation_memory() {
        let first = node_id(11);
        let second = node_id(22);
        
        let mut node1 = text_node(first, Some("こんにちは"));
        if let NodeKind::Text(data) = &mut node1.kind {
            data.translation = Some("Xin chào".to_string());
        }
        
        let node2 = text_node(second, Some("さようなら"));
        
        let mut scene = Scene::default();
        
        // Page 1: current page, contains node2
        let page_id_1 = page_id();
        let mut page1 = Page::new("page1", 100, 100);
        page1.id = page_id_1;
        page1.nodes.insert(node2.id, node2);
        scene.pages.insert(page_id_1, page1);

        // Page 2: other page, contains translation memory node1
        let page_id_2 = PageId(Uuid::from_u128(2));
        let mut page2 = Page::new("page2", 100, 100);
        page2.id = page_id_2;
        page2.nodes.insert(node1.id, node1);
        scene.pages.insert(page_id_2, page2);
        
        let prompt = build_reinforced_system_prompt(&scene, page_id_1, "Vietnamese", None);
        
        assert!(prompt.contains("Original: \"こんにちは\" -> Translated: \"Xin chào\""));
        assert!(prompt.contains("Vietnamese"));
    }
}
