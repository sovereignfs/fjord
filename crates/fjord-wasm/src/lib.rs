// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord-core`'s pure subset for WebAssembly (ROADMAP P4): what a client with no filesystem needs to
//! read a repository's shape and work on its documents. See [`api`] for what each function takes and
//! returns; this file only makes each one callable from JavaScript, so the logic is tested natively.
//!
//! Not here, on purpose: reading a directory, and the system clock (a page supplies `Date.now()`). Randomness
//! is a page's too (`crypto.getRandomValues`) except for `age`, which draws its own through the same source.

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

// --- Encryption (ROADMAP web P8) ---------------------------------------------------------------------------------------
// Secrets travel as `Uint8Array`s so that a page can wipe them; nothing here logs or keeps one.

#[wasm_bindgen(js_name = generateIdentity)]
pub fn generate_identity() -> Vec<u8> {
    api::generate_identity()
}

#[wasm_bindgen(js_name = identityRecipient)]
pub fn identity_recipient(identity: &[u8]) -> Result<String, JsError> {
    api::identity_recipient(identity).map_err(thrown)
}

/// Why a recipient line cannot be used (for a person), or `undefined` if it can.
#[wasm_bindgen(js_name = checkRecipient)]
pub fn check_recipient(text: &str) -> Option<String> {
    api::check_recipient(text)
}

#[wasm_bindgen(js_name = isWellFormed)]
pub fn is_well_formed(bytes: &[u8]) -> bool {
    api::is_well_formed(bytes)
}

#[wasm_bindgen]
pub fn encrypt(plaintext: &[u8], recipients: &str, armor: bool) -> Result<Vec<u8>, JsError> {
    api::encrypt(plaintext, recipients, armor).map_err(thrown)
}

#[wasm_bindgen]
pub fn decrypt(ciphertext: &[u8], identity: &[u8]) -> Result<Vec<u8>, JsError> {
    api::decrypt(ciphertext, identity).map_err(thrown)
}

/// scrypt's `log2(N)` to seal with unless there is a reason not to.
#[wasm_bindgen(js_name = passphraseWorkFactor)]
pub fn passphrase_work_factor() -> u8 {
    api::passphrase_work_factor()
}

/// Seal bytes with a passphrase (both bytes, so a page can wipe them). Slow on purpose: it is the passphrase's whole defence.
#[wasm_bindgen(js_name = sealWithPassphrase)]
pub fn seal_with_passphrase(
    plaintext: &[u8],
    passphrase: &[u8],
    log_n: u8,
) -> Result<Vec<u8>, JsError> {
    api::seal_with_passphrase(plaintext, passphrase, log_n).map_err(thrown)
}

#[wasm_bindgen(js_name = openWithPassphrase)]
pub fn open_with_passphrase(sealed: &[u8], passphrase: &[u8]) -> Result<Vec<u8>, JsError> {
    api::open_with_passphrase(sealed, passphrase).map_err(thrown)
}

#[wasm_bindgen(js_name = wrapContainer)]
pub fn wrap_container(name: &str, contents: &[u8]) -> Result<Vec<u8>, JsError> {
    api::wrap_container(name, contents).map_err(thrown)
}

/// What a container held: the document's real file name and its bytes.
#[wasm_bindgen]
pub struct Unwrapped {
    name: String,
    contents: Vec<u8>,
}

#[wasm_bindgen]
impl Unwrapped {
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn contents(&self) -> Vec<u8> {
        self.contents.clone()
    }
}

#[wasm_bindgen(js_name = unwrapContainer)]
pub fn unwrap_container(archive: &[u8]) -> Result<Unwrapped, JsError> {
    let (name, contents) = api::unwrap_container(archive).map_err(thrown)?;
    Ok(Unwrapped { name, contents })
}
