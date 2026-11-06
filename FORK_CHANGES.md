# IKurokami's Koharu fork — engineering notes

This repository is a **customized fork** of the upstream [Koharu project](https://github.com/koharu-rs/koharu). Original upstream licensing and attribution are preserved. The customization branch `vi` was merged into `main` in [PR #1](https://github.com/IKurokami/koharu/pull/1).

## Major changes in this fork

- **Manga source integration:** source search, import, chapter download, and related RPC endpoints and client interfaces.
- **Project workflows:** additional project metadata, recent projects, import and browsing UX improvements.
- **Translation workflows:** batch translation with memory and a draft rendering option to improve iteration on translated pages.
- **Export:** translated-text export support and related interface actions.
- **Localization and interface:** Vietnamese locale assets and polish to navigation, dialogs, canvas actions and other UI details.
- **Developer tooling:** changes to script runners, transport contracts and generated API schemas.

These are descriptions of the changes present in the fork, not guarantees of feature completeness. Compare the branches and commits in [PR #1](https://github.com/IKurokami/koharu/pull/1) for detailed attribution and code changes.

## Current verification status

The merge was completed on GitHub. There were no reported passing CI status checks on the source branch at merge time, and no local application build was completed during the merge. Please run the repository's Rust and UI test suites before distributing releases.

## Upstream credit

The upstream project and its authors own the original Koharu implementation. This document highlights only the changes made in the customized fork. Please retain license notices and third-party attributions.
