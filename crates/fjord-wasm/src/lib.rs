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

#[wasm_bindgen(js_name = planAdopt)]
pub fn plan_adopt(
    options_json: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, JsError> {
    api::plan_adopt(options_json, existing_json, now_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = detectSite)]
pub fn detect_site(existing_json: &str) -> Result<String, JsError> {
    api::detect_site(existing_json).map_err(thrown)
}

#[wasm_bindgen(js_name = planVault)]
pub fn plan_vault(
    options_json: &str,
    manifest: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, JsError> {
    api::plan_vault(options_json, manifest, existing_json, now_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = planVaultEncryption)]
pub fn plan_vault_encryption(manifest: &str, options_json: &str) -> Result<String, JsError> {
    api::plan_vault_encryption(manifest, options_json).map_err(thrown)
}

#[wasm_bindgen(js_name = planVaultDecryption)]
pub fn plan_vault_decryption(manifest: &str) -> String {
    api::plan_vault_decryption(manifest)
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

#[wasm_bindgen(js_name = isEntryDate)]
pub fn is_entry_date(text: &str) -> bool {
    api::is_entry_date(text)
}

#[wasm_bindgen(js_name = entryDateFromUnix)]
pub fn entry_date_from_unix(seconds: f64, offset_minutes: f64) -> Option<String> {
    api::entry_date_from_unix(seconds, offset_minutes)
}

// --- Repository kinds, journals and tags (ROADMAP web P12) -------------------------------------------------------------

#[wasm_bindgen(js_name = planKind)]
pub fn plan_kind(options_json: &str, now_ms: f64, random: &[u8]) -> Result<String, JsError> {
    api::plan_kind(options_json, now_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = planSetupKind)]
pub fn plan_setup_kind(
    options_json: &str,
    existing_json: &str,
    now_ms: f64,
    random: &[u8],
) -> Result<String, JsError> {
    api::plan_setup_kind(options_json, existing_json, now_ms, random).map_err(thrown)
}

#[wasm_bindgen(js_name = withKind)]
pub fn with_kind(manifest: &str, kind: &str, engine: Option<String>) -> String {
    api::with_kind(manifest, kind, engine)
}

#[wasm_bindgen(js_name = kindRule)]
pub fn kind_rule(kind: &str, encrypted_json: &str) -> Result<Option<String>, JsError> {
    api::kind_rule(kind, encrypted_json).map_err(thrown)
}

#[wasm_bindgen(js_name = journalEntryPath)]
pub fn journal_entry_path(date: &str) -> Option<String> {
    api::journal_entry_path(date)
}

#[wasm_bindgen(js_name = journalSlug)]
pub fn journal_slug(title: &str) -> Option<String> {
    api::journal_slug(title)
}

#[wasm_bindgen(js_name = newEntry)]
pub fn new_entry(
    id: &str,
    title: Option<String>,
    created: &str,
    date: &str,
) -> Result<String, JsError> {
    api::new_entry(id, title, created, date).map_err(thrown)
}

#[wasm_bindgen(js_name = withDate)]
pub fn with_date(text: &str, date: Option<String>) -> Option<String> {
    api::with_date(text, date)
}

#[wasm_bindgen(js_name = withField)]
pub fn with_field(text: &str, key: &str, value_json: &str) -> Result<Option<String>, JsError> {
    api::with_field(text, key, value_json).map_err(thrown)
}

#[wasm_bindgen(js_name = withTags)]
pub fn with_tags(text: &str, tags_json: &str) -> Result<Option<String>, JsError> {
    api::with_tags(text, tags_json).map_err(thrown)
}

#[wasm_bindgen(js_name = journalEntry)]
pub fn journal_entry(text: &str, path: &str) -> String {
    api::journal_entry(text, path)
}

#[wasm_bindgen(js_name = sitePostPath)]
pub fn site_post_path(engine: &str, date: &str, title: &str, draft: bool) -> Option<String> {
    api::site_post_path(engine, date, title, draft)
}

#[wasm_bindgen(js_name = siteNewPost)]
pub fn site_new_post(
    engine: &str,
    id: &str,
    title: &str,
    created: &str,
    date: &str,
    draft: bool,
) -> Result<String, JsError> {
    api::site_new_post(engine, id, title, created, date, draft).map_err(thrown)
}

#[wasm_bindgen(js_name = siteTagProblem)]
pub fn site_tag_problem(engine: &str, tag: &str) -> Option<String> {
    api::site_tag_problem(engine, tag)
}

#[wasm_bindgen(js_name = siteImageType)]
pub fn site_image_type(bytes: &[u8]) -> Option<String> {
    api::site_image_type(bytes)
}

#[wasm_bindgen(js_name = siteImageMime)]
pub fn site_image_mime(extension: &str) -> Option<String> {
    api::site_image_mime(extension)
}

#[wasm_bindgen(js_name = siteImageDir)]
pub fn site_image_dir(engine: &str, vault_dir: &str) -> Option<String> {
    api::site_image_dir(engine, vault_dir)
}

#[wasm_bindgen(js_name = siteImageName)]
pub fn site_image_name(file_name: &str, extension: &str, existing_json: &str) -> Option<String> {
    api::site_image_name(file_name, extension, existing_json)
}

#[wasm_bindgen(js_name = siteImageRef)]
pub fn site_image_ref(engine: &str, post_path: &str, image_path: &str) -> Option<String> {
    api::site_image_ref(engine, post_path, image_path)
}

#[wasm_bindgen(js_name = siteRefersTo)]
pub fn site_refers_to(post_path: &str, body: &str, image_path: &str) -> bool {
    api::site_refers_to(post_path, body, image_path)
}

#[wasm_bindgen(js_name = foldTag)]
pub fn fold_tag(tag: &str) -> String {
    api::fold_tag(tag)
}

#[wasm_bindgen(js_name = sameTag)]
pub fn same_tag(a: &str, b: &str) -> bool {
    api::same_tag(a, b)
}

#[wasm_bindgen(js_name = tagIsUnder)]
pub fn tag_is_under(tag: &str, parent: &str) -> bool {
    api::tag_is_under(tag, parent)
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
