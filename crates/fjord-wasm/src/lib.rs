// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord-core`'s pure subset for WebAssembly (ROADMAP P4): what a client with no filesystem needs to
//! read a repository's shape and work on its documents. See [`api`] for what each function takes and
//! returns; this file only makes each one callable from JavaScript, so the logic is tested natively.
//!
//! Not here, on purpose: reading a directory, `age` encryption and `tar` containers, and the system
//! clock and a random source (a page supplies `Date.now()` and `crypto.getRandomValues`).

#![forbid(unsafe_code)]

pub mod api;

use wasm_bindgen::prelude::*;

/// A malformed *call*, thrown. A finding about the input is data in the JSON instead.
fn thrown(message: String) -> JsError {
    JsError::new(&message)
}

#[wasm_bindgen(js_name = formatVersion)]
pub fn format_version() -> u32 {
    api::format_version()
}

#[wasm_bindgen(js_name = manifestPaths)]
pub fn manifest_paths(files_json: &str) -> Result<String, JsError> {
    api::manifest_paths(files_json).map_err(thrown)
}

#[wasm_bindgen]
pub fn discover(files_json: &str, manifests_json: &str) -> Result<String, JsError> {
    api::discover(files_json, manifests_json).map_err(thrown)
}

#[wasm_bindgen(js_name = describeRepositoryManifest)]
pub fn describe_repository_manifest(text: &str) -> String {
    api::describe_repository_manifest(text)
}

#[wasm_bindgen(js_name = describeVaultManifest)]
pub fn describe_vault_manifest(text: &str) -> String {
    api::describe_vault_manifest(text)
}

#[wasm_bindgen(js_name = checkName)]
pub fn check_name(component: &str) -> String {
    api::check_name(component)
}

#[wasm_bindgen(js_name = caseCollisions)]
pub fn case_collisions(names_json: &str) -> Result<String, JsError> {
    api::case_collisions(names_json).map_err(thrown)
}

#[wasm_bindgen(js_name = toNfc)]
pub fn to_nfc(name: &str) -> String {
    api::to_nfc(name)
}

#[wasm_bindgen(js_name = checkManifestPath)]
pub fn check_manifest_path(candidate: &str) -> Option<String> {
    api::check_manifest_path(candidate)
}

#[wasm_bindgen(js_name = parseDocument)]
pub fn parse_document(text: &str) -> String {
    api::parse_document(text)
}

#[wasm_bindgen(js_name = newDocument)]
pub fn new_document(id: &str, title: &str, created: &str) -> Result<String, JsError> {
    api::new_document(id, title, created).map_err(thrown)
}

#[wasm_bindgen(js_name = withFreshId)]
pub fn with_fresh_id(text: &str, id: &str) -> Option<String> {
    api::with_fresh_id(text, id)
}

#[wasm_bindgen(js_name = promoteDocument)]
pub fn promote_document(text: &str, id: &str, created: &str, title: &str) -> Option<String> {
    api::promote_document(text, id, created, title)
}

#[wasm_bindgen(js_name = withTitle)]
pub fn with_title(text: &str, title: &str) -> Option<String> {
    api::with_title(text, title)
}

#[wasm_bindgen(js_name = impliedTitle)]
pub fn implied_title(text: &str, file_name: &str) -> String {
    api::implied_title(text, file_name)
}

#[wasm_bindgen(js_name = quickNoteName)]
pub fn quick_note_name(
    text: &str,
    existing_json: &str,
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
) -> Result<String, JsError> {
    api::quick_note_name(text, existing_json, year, month, day, hour, minute).map_err(thrown)
}

#[wasm_bindgen(js_name = titleFromText)]
pub fn title_from_text(text: &str) -> Option<String> {
    api::title_from_text(text)
}

#[wasm_bindgen(js_name = freeName)]
pub fn free_name(stem: &str, extension: &str, existing_json: &str) -> Result<String, JsError> {
    api::free_name(stem, extension, existing_json).map_err(thrown)
}

#[wasm_bindgen(js_name = mergeTexts)]
pub fn merge_texts(
    base: &str,
    ours: &str,
    theirs: &str,
    ours_label: &str,
    theirs_label: &str,
) -> String {
    api::merge_texts(base, ours, theirs, ours_label, theirs_label)
}

#[wasm_bindgen(js_name = planSetup)]
pub fn plan_setup(
    options_json: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, JsError> {
    api::plan_setup(options_json, existing_json, now_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = freeVaultName)]
pub fn free_vault_name(preferred: &str, existing_json: &str) -> Result<String, JsError> {
    api::free_vault_name(preferred, existing_json).map_err(thrown)
}

#[wasm_bindgen(js_name = newUlid)]
pub fn new_ulid(timestamp_ms: f64, random: &[u8]) -> Result<String, JsError> {
    api::new_ulid(timestamp_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = isUlid)]
pub fn is_ulid(text: &str) -> bool {
    api::is_ulid(text)
}

#[wasm_bindgen(js_name = isRfc3339Utc)]
pub fn is_rfc3339_utc(text: &str) -> bool {
    api::is_rfc3339_utc(text)
}

#[wasm_bindgen(js_name = rfc3339FromUnix)]
pub fn rfc3339_from_unix(seconds: f64) -> Option<String> {
    api::rfc3339_from_unix(seconds)
}
