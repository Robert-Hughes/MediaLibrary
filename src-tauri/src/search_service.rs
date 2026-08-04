//! Rust-authoritative list search service.
//!
//! The mutable index is deliberately separate from the session snapshot lock.
//! Session transitions clone only their changed rows, release the authoritative
//! lock, and then update this service. Query evaluation therefore never blocks
//! file discovery, metadata scanning, draft persistence, or apply readback.

use crate::draft_edits::{EditIntent, MetadataTargetDraftEntry};
use crate::metadata_occurrence::{MetadataOccurrence, MetadataOccurrences};
use crate::metadata_value::{MetadataValue, OffsetSign, TimeValue, UtcOffsetValue};
use crate::scanner::{FileInfo, MediaKind};
use crate::tag_schema::{SchemaDefinitionId, TagInfo, TagKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

pub const SEARCH_RESULT_EVENT: &str = "media_library_search_result";
const REFRESH_COALESCE_DELAY: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySearchRequest {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub request_id: u64,
    pub query: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MediaLibrarySearchResult {
    #[cfg_attr(test, ts(type = "number"))]
    pub session_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub request_id: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub session_revision: u64,
    pub matched_paths: Vec<String>,
    pub has_edits_filter: bool,
}

#[derive(Clone, Debug, Default)]
struct ParsedSearchQuery {
    free_text: String,
    media_kinds: BTreeSet<MediaKindKey>,
    has_edits: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum MediaKindKey {
    Image,
    Audio,
    Video,
}

impl From<MediaKind> for MediaKindKey {
    fn from(value: MediaKind) -> Self {
        match value {
            MediaKind::Image => Self::Image,
            MediaKind::Audio => Self::Audio,
            MediaKind::Video => Self::Video,
        }
    }
}

fn parse_query(raw: &str) -> ParsedSearchQuery {
    let mut parsed = ParsedSearchQuery::default();
    let mut free_text = Vec::new();
    for token in raw.split_whitespace() {
        let normalized = token.to_lowercase();
        match normalized.as_str() {
            "has:edits" => parsed.has_edits = true,
            "kind:image" => {
                parsed.media_kinds.insert(MediaKindKey::Image);
            }
            "kind:audio" => {
                parsed.media_kinds.insert(MediaKindKey::Audio);
            }
            "kind:video" => {
                parsed.media_kinds.insert(MediaKindKey::Video);
            }
            _ => free_text.push(token),
        }
    }
    parsed.free_text = free_text.join(" ").to_lowercase();
    parsed
}

#[derive(Clone, Debug)]
struct SearchDocument {
    media_kind: MediaKindKey,
    file_text: String,
    occurrence_text: String,
    draft_text: String,
    has_edits: bool,
}

impl SearchDocument {
    fn haystack(&self) -> String {
        [
            self.file_text.as_str(),
            self.occurrence_text.as_str(),
            self.draft_text.as_str(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
    }
}

#[derive(Clone, Debug, Default)]
struct SearchIndex {
    session_id: Option<u64>,
    session_revision: u64,
    documents: HashMap<String, SearchDocument>,
    /// Draft rows received for paths that have not been indexed yet (the
    /// session loads persisted drafts before scanning adds any files). They
    /// attach to the document when the file lands, so draft state is
    /// independent of file/draft arrival order.
    pending_drafts: HashMap<String, Vec<MetadataTargetDraftEntry>>,
}

impl SearchIndex {
    fn reset(&mut self, session_id: Option<u64>, session_revision: u64) {
        self.session_id = session_id;
        self.session_revision = session_revision;
        self.documents.clear();
        self.pending_drafts.clear();
    }

    fn set_revision(&mut self, session_id: u64, revision: u64) -> bool {
        if self.session_id != Some(session_id) || revision < self.session_revision {
            return false;
        }
        self.session_revision = revision;
        true
    }

    fn add_files(&mut self, session_id: u64, revision: u64, files: &[FileInfo]) -> bool {
        if !self.set_revision(session_id, revision) {
            return false;
        }
        for file in files {
            let path = file.relative_path.clone();
            let pending_draft = self.pending_drafts.remove(&path);
            self.documents
                .entry(path)
                .and_modify(|document| {
                    document.media_kind = file.media_kind.into();
                    document.file_text = file_text(file);
                })
                .or_insert_with(|| {
                    let mut document = SearchDocument {
                        media_kind: file.media_kind.into(),
                        file_text: file_text(file),
                        occurrence_text: String::new(),
                        draft_text: String::new(),
                        has_edits: false,
                    };
                    if let Some(entries) = pending_draft {
                        document.has_edits = !entries.is_empty();
                        document.draft_text = drafts_text(&entries);
                    }
                    document
                });
        }
        true
    }

    fn set_metadata(
        &mut self,
        session_id: u64,
        revision: u64,
        entries: &[(String, Option<MetadataOccurrences>)],
    ) -> bool {
        if !self.set_revision(session_id, revision) {
            return false;
        }
        for (path, occurrences) in entries {
            if let Some(document) = self.documents.get_mut(path) {
                document.occurrence_text = occurrences
                    .as_ref()
                    .map(occurrences_text)
                    .unwrap_or_default();
            }
        }
        true
    }

    fn set_drafts(
        &mut self,
        session_id: u64,
        revision: u64,
        rows: &[(String, Vec<MetadataTargetDraftEntry>)],
    ) -> bool {
        if !self.set_revision(session_id, revision) {
            return false;
        }
        for (path, entries) in rows {
            if let Some(document) = self.documents.get_mut(path) {
                document.has_edits = !entries.is_empty();
                document.draft_text = drafts_text(entries);
            } else if entries.is_empty() {
                self.pending_drafts.remove(path);
            } else {
                self.pending_drafts.insert(path.clone(), entries.clone());
            }
        }
        true
    }

    fn remove_paths(&mut self, session_id: u64, revision: u64, paths: &[String]) -> bool {
        if !self.set_revision(session_id, revision) {
            return false;
        }
        for path in paths {
            self.documents.remove(path);
            self.pending_drafts.remove(path);
        }
        true
    }

    fn query(
        &self,
        request: &MediaLibrarySearchRequest,
    ) -> Result<MediaLibrarySearchResult, String> {
        if self.session_id != Some(request.session_id) {
            return Err("The media-library session changed before search ran".to_string());
        }
        let parsed = parse_query(&request.query);
        let mut matched_paths = Vec::new();
        for (path, document) in &self.documents {
            if parsed.has_edits && !document.has_edits {
                continue;
            }
            if !parsed.media_kinds.is_empty() && !parsed.media_kinds.contains(&document.media_kind)
            {
                continue;
            }
            if !parsed.free_text.is_empty()
                && !document.haystack().contains(parsed.free_text.as_str())
            {
                continue;
            }
            matched_paths.push(path.clone());
        }
        matched_paths.sort_unstable();
        Ok(MediaLibrarySearchResult {
            session_id: request.session_id,
            request_id: request.request_id,
            session_revision: self.session_revision,
            matched_paths,
            has_edits_filter: parsed.has_edits,
        })
    }
}

#[derive(Clone)]
struct ActiveRequest {
    request: MediaLibrarySearchRequest,
    last_emitted: Option<MediaLibrarySearchResult>,
}

struct SearchServiceInner {
    index: Mutex<SearchIndex>,
    active_request: Mutex<Option<ActiveRequest>>,
    app_handle: Mutex<Option<AppHandle>>,
    refresh_generation: AtomicU64,
    frontend_event_count: AtomicU64,
    effective_refresh_count: AtomicU64,
}

#[derive(Clone)]
pub struct MediaLibrarySearchService {
    inner: Arc<SearchServiceInner>,
}

impl Default for MediaLibrarySearchService {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaLibrarySearchService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SearchServiceInner {
                index: Mutex::new(SearchIndex::default()),
                active_request: Mutex::new(None),
                app_handle: Mutex::new(None),
                refresh_generation: AtomicU64::new(0),
                frontend_event_count: AtomicU64::new(0),
                effective_refresh_count: AtomicU64::new(0),
            }),
        }
    }

    pub fn install_app_handle(&self, app_handle: AppHandle) {
        *self.inner.app_handle.lock().unwrap() = Some(app_handle);
    }

    pub fn reset(&self, session_id: Option<u64>, revision: u64) {
        self.inner.index.lock().unwrap().reset(session_id, revision);
        let mut active = self.inner.active_request.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|active| Some(active.request.session_id) != session_id)
        {
            *active = None;
        }
    }

    pub fn set_revision(&self, session_id: u64, revision: u64) {
        if self
            .inner
            .index
            .lock()
            .unwrap()
            .set_revision(session_id, revision)
        {
            self.schedule_refresh();
        }
    }

    pub fn add_files(&self, session_id: u64, revision: u64, files: Vec<FileInfo>) {
        if self
            .inner
            .index
            .lock()
            .unwrap()
            .add_files(session_id, revision, &files)
        {
            self.schedule_refresh();
        }
    }

    pub fn set_metadata(
        &self,
        session_id: u64,
        revision: u64,
        entries: Vec<(String, Option<MetadataOccurrences>)>,
    ) {
        if self
            .inner
            .index
            .lock()
            .unwrap()
            .set_metadata(session_id, revision, &entries)
        {
            self.schedule_refresh();
        }
    }

    pub fn set_drafts(
        &self,
        session_id: u64,
        revision: u64,
        rows: Vec<(String, Vec<MetadataTargetDraftEntry>)>,
    ) {
        if self
            .inner
            .index
            .lock()
            .unwrap()
            .set_drafts(session_id, revision, &rows)
        {
            self.schedule_refresh();
        }
    }

    pub fn remove_paths(&self, session_id: u64, revision: u64, paths: Vec<String>) {
        if self
            .inner
            .index
            .lock()
            .unwrap()
            .remove_paths(session_id, revision, &paths)
        {
            self.schedule_refresh();
        }
    }

    pub fn submit(
        &self,
        request: MediaLibrarySearchRequest,
    ) -> Result<MediaLibrarySearchResult, String> {
        let result = self.inner.index.lock().unwrap().query(&request)?;
        let mut active = self.inner.active_request.lock().unwrap();
        let is_stale = active.as_ref().is_some_and(|current| {
            current.request.session_id == request.session_id
                && current.request.request_id > request.request_id
        });
        if !is_stale {
            *active = Some(ActiveRequest {
                request,
                last_emitted: Some(result.clone()),
            });
        }
        Ok(result)
    }

    fn schedule_refresh(&self) {
        if self.inner.active_request.lock().unwrap().is_none() {
            return;
        }
        let generation = self.inner.refresh_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let service = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(REFRESH_COALESCE_DELAY);
            if service.inner.refresh_generation.load(Ordering::Acquire) != generation {
                return;
            }
            service.emit_current_if_changed();
        });
    }

    fn emit_current_if_changed(&self) {
        let mut active_guard = self.inner.active_request.lock().unwrap();
        let Some(active) = active_guard.as_mut() else {
            return;
        };
        let Ok(result) = self.inner.index.lock().unwrap().query(&active.request) else {
            return;
        };
        if active.last_emitted.as_ref().is_some_and(|previous| {
            previous.session_id == result.session_id
                && previous.request_id == result.request_id
                && previous.matched_paths == result.matched_paths
                && previous.has_edits_filter == result.has_edits_filter
        }) {
            return;
        }
        active.last_emitted = Some(result.clone());
        self.inner
            .effective_refresh_count
            .fetch_add(1, Ordering::Relaxed);
        let app_handle = self.inner.app_handle.lock().unwrap().clone();
        if let Some(app_handle) = app_handle {
            if crate::emit_frontend_event(&app_handle, SEARCH_RESULT_EVENT, result).is_ok() {
                self.inner
                    .frontend_event_count
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    #[cfg(test)]
    fn event_count(&self) -> u64 {
        self.inner.frontend_event_count.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn effective_refresh_count(&self) -> u64 {
        self.inner.effective_refresh_count.load(Ordering::Relaxed)
    }
}

fn file_text(file: &FileInfo) -> String {
    [
        file.relative_path.clone(),
        file.filename.clone(),
        file.date_modified
            .map_or_else(|| "—".to_string(), date_text),
        file.date_created.map_or_else(|| "—".to_string(), date_text),
    ]
    .join("\n")
    .to_lowercase()
}

fn date_text(seconds: i64) -> String {
    use chrono::{Datelike, TimeZone, Utc};
    let Some(date) = Utc.timestamp_opt(seconds, 0).single() else {
        return seconds.to_string();
    };
    let day = date.day();
    let month = date.month();
    let year = date.year();
    let short_month = date.format("%b");
    format!(
        "{year}-{month:02}-{day:02} {day} {short_month} {year} {short_month} {day}, {year} {day:02}/{month:02}/{year} {month:02}/{day:02}/{year}"
    )
}

fn schema_text(id: &SchemaDefinitionId, tag_info: Option<&TagInfo>) -> Vec<String> {
    let mut parts = vec![id.table.clone(), id.tag_id.clone(), id.to_string()];
    if let Some(index) = id.index {
        parts.push(index.to_string());
        parts.push(format!("index {index}"));
    }
    if let Some(tag_info) = tag_info {
        parts.push(format!("{}:{}", tag_info.group, tag_info.name));
        parts.push(tag_info.name.clone());
        parts.push(tag_info.description.clone().unwrap_or_default());
    }
    parts
}

fn occurrence_text(occurrence: &MetadataOccurrence) -> String {
    let id = &occurrence.id;
    let mut parts = schema_text(&occurrence.schema_id, occurrence.tag_info.as_ref());
    parts.push(format_metadata_value(
        &occurrence.value,
        Some(&occurrence.schema_id),
        occurrence.tag_info.as_ref(),
    ));
    parts.push(format_metadata_value(&occurrence.value, None, None));
    parts.extend([
        id.document.clone().unwrap_or_default(),
        id.path.clone(),
        id.runtime_tag_id.clone(),
        id.tag_id_scope.table.clone(),
        id.tag_id_scope.tag_id.clone(),
        id.tag_id_scope
            .index
            .map(|value| value.to_string())
            .unwrap_or_default(),
        id.copy.to_string(),
        format!("document:{}", id.document.as_deref().unwrap_or_default()),
        format!("path:{}", id.path),
        format!("runtime-tag:{}", id.runtime_tag_id),
        format!("tag:{}", id.runtime_tag_id),
        format!("wrapped-table:{}", id.tag_id_scope.table),
        format!("wrapped-tag:{}", id.tag_id_scope.tag_id),
        format!(
            "wrapped-index:{}",
            id.tag_id_scope
                .index
                .map(|value| value.to_string())
                .unwrap_or_default()
        ),
        format!("copy:{}", id.copy),
    ]);
    parts.join("\n")
}

fn occurrences_text(occurrences: &MetadataOccurrences) -> String {
    occurrences
        .iter()
        .map(occurrence_text)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase()
}

fn drafts_text(entries: &[MetadataTargetDraftEntry]) -> String {
    drafts_text_with_lookup(entries, |schema_id| {
        crate::tag_schema::get_registry()
            .ok()
            .and_then(|registry| registry.lookup(schema_id))
            .cloned()
    })
}

fn drafts_text_with_lookup(
    entries: &[MetadataTargetDraftEntry],
    mut lookup: impl FnMut(&SchemaDefinitionId) -> Option<TagInfo>,
) -> String {
    entries
        .iter()
        .flat_map(|entry| {
            let schema_id = entry.target.schema_id();
            let tag_info = lookup(schema_id);
            let mut parts = schema_text(schema_id, tag_info.as_ref());
            match entry.edit.intent {
                EditIntent::Delete => parts.push("—".to_string()),
                _ => {
                    if let Some(value) = &entry.edit.value {
                        parts.push(format_metadata_value(
                            value,
                            Some(schema_id),
                            tag_info.as_ref(),
                        ));
                        parts.push(format_metadata_value(value, None, None));
                    }
                }
            }
            parts
        })
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase()
}

fn format_metadata_value(
    value: &MetadataValue,
    schema_id: Option<&SchemaDefinitionId>,
    tag_info: Option<&TagInfo>,
) -> String {
    if let Some(TagInfo {
        kind: TagKind::Enum { options, .. },
        ..
    }) = tag_info
    {
        let code = metadata_scalar_code(value);
        if let Some(option) =
            code.and_then(|code| options.iter().find(|option| option.code == code))
        {
            return option.label.clone();
        }
    }
    if let Some(schema_id) = schema_id {
        if let Some(formatted) = format_known_value(schema_id, value) {
            return formatted;
        }
    }
    match value {
        MetadataValue::Null => String::new(),
        MetadataValue::Text(value) => value.clone(),
        MetadataValue::Bool(value) => value.to_string(),
        MetadataValue::Integer(value) => value.to_string(),
        MetadataValue::Real(value) => value.to_string(),
        MetadataValue::Rational(value) => format!("{}/{}", value.numerator, value.denominator),
        MetadataValue::Date(value) => {
            format!("{:04}:{:02}:{:02}", value.year, value.month, value.day)
        }
        MetadataValue::Time(value) => format_time(value),
        MetadataValue::DateTime(value) => format!(
            "{:04}:{:02}:{:02} {}",
            value.date.year,
            value.date.month,
            value.date.day,
            format_time(&value.time)
        ),
        MetadataValue::TimeOffset(value) => format_offset(value),
        MetadataValue::LangAlt(values) => values
            .iter()
            .map(|(language, value)| format!("{language}: {value}"))
            .collect::<Vec<_>>()
            .join("; "),
        MetadataValue::List { items, .. } => items
            .iter()
            .map(|value| format_metadata_value(value, None, None))
            .collect::<Vec<_>>()
            .join(", "),
        MetadataValue::Struct(values) => values
            .iter()
            .map(|(name, value)| format!("{name}: {}", format_metadata_value(value, None, None)))
            .collect::<Vec<_>>()
            .join("; "),
        MetadataValue::Binary => "<binary>".to_string(),
        MetadataValue::Unknown { raw, .. } => raw.to_string(),
    }
}

fn metadata_scalar_code(value: &MetadataValue) -> Option<String> {
    match value {
        MetadataValue::Text(value) => Some(value.clone()),
        MetadataValue::Integer(value) => Some(value.to_string()),
        MetadataValue::Real(value) if value.fract() == 0.0 => Some(value.to_string()),
        _ => None,
    }
}

fn numeric_value(value: &MetadataValue) -> Option<f64> {
    match value {
        MetadataValue::Integer(value) => Some(*value as f64),
        MetadataValue::Real(value) if value.is_finite() => Some(*value),
        MetadataValue::Rational(value) if value.denominator != 0 => {
            Some(value.numerator as f64 / value.denominator as f64)
        }
        _ => None,
    }
}

fn trim_number(value: f64, decimals: usize) -> String {
    let rendered = format!("{value:.decimals$}");
    rendered
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn gps_decimal_value(value: &MetadataValue) -> Option<f64> {
    if let Some(value) = numeric_value(value) {
        return Some(value);
    }
    let MetadataValue::List { items, .. } = value else {
        return None;
    };
    match items.as_slice() {
        [only] => gps_decimal_value(only),
        [degrees, minutes, seconds] => {
            let degrees = numeric_value(degrees)?;
            let minutes = numeric_value(minutes)?;
            let seconds = numeric_value(seconds)?;
            let sign = if degrees < 0.0 { -1.0 } else { 1.0 };
            Some(sign * (degrees.abs() + minutes / 60.0 + seconds / 3600.0))
        }
        _ => None,
    }
}

fn format_known_value(id: &SchemaDefinitionId, value: &MetadataValue) -> Option<String> {
    let exact = |table: &str, tag_id: &str| id.table == table && id.tag_id == tag_id;
    let code = metadata_scalar_code(value);
    if exact("GPS::Main", "1") {
        return match code.as_deref() {
            Some("N") => Some("North".into()),
            Some("S") => Some("South".into()),
            _ => None,
        };
    }
    if exact("GPS::Main", "3") {
        return match code.as_deref() {
            Some("E") => Some("East".into()),
            Some("W") => Some("West".into()),
            _ => None,
        };
    }
    if exact("GPS::Main", "5") {
        return match code.as_deref() {
            Some("0") => Some("Above Sea Level".into()),
            Some("1") => Some("Below Sea Level".into()),
            _ => None,
        };
    }
    if exact("GPS::Main", "2") || exact("GPS::Main", "4") {
        return gps_decimal_value(value).map(|value| format!("{}°", trim_number(value, 6)));
    }
    if exact("GPS::Main", "6") {
        return gps_decimal_value(value).map(|value| format!("{} m", trim_number(value, 2)));
    }
    if exact("Exif::Main", "33434") {
        if let MetadataValue::Rational(value) = value {
            return Some(format!("{}/{} s", value.numerator, value.denominator));
        }
        let value = numeric_value(value)?;
        if value > 0.0 && value < 1.0 {
            let reciprocal = 1.0 / value;
            let denominator = reciprocal.round();
            if (reciprocal - denominator).abs() < 0.01 {
                return Some(format!("1/{} s", denominator as i64));
            }
        }
        return (value > 0.0).then(|| format!("{} s", trim_number(value, 3)));
    }
    if exact("Exif::Main", "33437") {
        let value = numeric_value(value)?;
        return (value > 0.0).then(|| format!("f/{}", trim_number(value, 3)));
    }
    if exact("Exif::Main", "37386") {
        let value = numeric_value(value)?;
        return (value > 0.0).then(|| format!("{} mm", trim_number(value, 2)));
    }
    if exact("Exif::Main", "37385") {
        let code = metadata_scalar_code(value)?.parse::<i64>().ok()?;
        let fired = code & 1 != 0;
        let return_status = (code >> 1) & 0b11;
        let mode = (code >> 3) & 0b11;
        let no_function = code & 0b100000 != 0;
        let red_eye = code & 0b1000000 != 0;
        if no_function {
            return Some("No flash function".into());
        }
        let mut parts = vec![if fired { "Fired" } else { "Did not fire" }.to_string()];
        if mode != 0 {
            parts.push(
                match mode {
                    1 => "Compulsory firing",
                    2 => "Compulsory suppression",
                    3 => "Auto",
                    _ => "Unknown",
                }
                .into(),
            );
        }
        if return_status != 0 {
            parts.push(
                match return_status {
                    2 => "Return not detected",
                    3 => "Return detected",
                    _ => "No return detected",
                }
                .into(),
            );
        }
        if red_eye {
            parts.push("Red-eye reduction".into());
        }
        return Some(parts.join(", "));
    }
    None
}

fn format_time(value: &TimeValue) -> String {
    let mut rendered = format!("{:02}:{:02}:{:02}", value.hour, value.minute, value.second);
    if let Some(subsecond) = &value.subsecond {
        rendered.push('.');
        rendered.push_str(subsecond);
    }
    if let Some(offset) = &value.offset {
        rendered.push_str(&format_offset(offset));
    }
    rendered
}

fn format_offset(value: &UtcOffsetValue) -> String {
    let sign = match value.sign {
        OffsetSign::Plus => '+',
        OffsetSign::Minus => '-',
    };
    format!("{sign}{:02}:{:02}", value.hours, value.minutes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft_edits::MetadataDraftEdit;
    use crate::metadata_draft_target::MetadataDraftTarget;
    use crate::metadata_occurrence::{MetadataOccurrenceId, RuntimeTagIdScope};

    fn file(path: &str, kind: MediaKind) -> FileInfo {
        FileInfo {
            relative_path: path.to_string(),
            filename: path.rsplit(['/', '\\']).next().unwrap().to_string(),
            media_kind: kind,
            date_modified: None,
            date_created: None,
        }
    }

    fn request(query: &str) -> MediaLibrarySearchRequest {
        MediaLibrarySearchRequest {
            session_id: 7,
            request_id: 3,
            query: query.to_string(),
        }
    }

    #[test]
    fn query_parser_preserves_unknown_and_partial_operators_as_text() {
        assert_eq!(
            parse_query("kind: image KIND:other has:edit").free_text,
            "kind: image kind:other has:edit"
        );
    }

    #[test]
    fn structured_filters_and_free_text_match_with_kind_or_semantics() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(
            7,
            2,
            &[
                file("Trips/Cat.jpg", MediaKind::Image),
                file("Audio/Cat.mp3", MediaKind::Audio),
                file("Video/Dog.mp4", MediaKind::Video),
            ],
        );
        assert_eq!(
            index
                .query(&request("kind:image kind:audio cat"))
                .unwrap()
                .matched_paths,
            vec!["Audio/Cat.mp3", "Trips/Cat.jpg"]
        );
        assert!(index
            .query(&request("kind:video cat"))
            .unwrap()
            .matched_paths
            .is_empty());
    }

    #[test]
    fn loading_metadata_contributes_no_occurrence_text_and_exact_diagnostics_are_searchable() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(7, 2, &[file("a.jpg", MediaKind::Image)]);
        index.set_metadata(7, 3, &[("a.jpg".into(), None)]);
        assert!(index
            .query(&request("runtime-tag:7"))
            .unwrap()
            .matched_paths
            .is_empty());

        let occurrence = MetadataOccurrence::try_new(
            MetadataOccurrenceId {
                document: Some("Doc1".into()),
                path: "JPEG-APP1-IFD0".into(),
                runtime_tag_id: "7".into(),
                tag_id_scope: RuntimeTagIdScope {
                    table: "Exif::Main".into(),
                    tag_id: "7".into(),
                    index: Some(0),
                },
                copy: 2,
            },
            SchemaDefinitionId {
                table: "Exif::Main".into(),
                tag_id: "7".into(),
                index: None,
            },
            MetadataValue::Text("Needle".into()),
            None,
            None,
            None,
        )
        .unwrap();
        index.set_metadata(
            7,
            4,
            &[("a.jpg".into(), Some(MetadataOccurrences(vec![occurrence])))],
        );
        for query in [
            "needle",
            "runtime-tag:7",
            "wrapped-index:0",
            "copy:2",
            "exif::main/7",
        ] {
            assert_eq!(
                index.query(&request(query)).unwrap().matched_paths,
                vec!["a.jpg"]
            );
        }
    }

    #[test]
    fn omitted_schema_index_is_distinct_from_index_zero() {
        let none = SchemaDefinitionId {
            table: "T".into(),
            tag_id: "1".into(),
            index: None,
        };
        let zero = SchemaDefinitionId {
            table: "T".into(),
            tag_id: "1".into(),
            index: Some(0),
        };
        assert_ne!(none, zero);
        assert_eq!(none.to_string(), "T/1");
        assert_eq!(zero.to_string(), "T/1/index=0");
    }

    #[test]
    fn drafts_are_searchable_and_drive_has_edits() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(7, 2, &[file("a.jpg", MediaKind::Image)]);
        let schema_id = SchemaDefinitionId {
            table: "XMP::Main".into(),
            tag_id: "title".into(),
            index: None,
        };
        let target = MetadataDraftTarget::from_new_property(&TagInfo {
            id: schema_id.clone(),
            group0: Some("XMP".into()),
            group: "XMP-dc".into(),
            name: "Title".into(),
            writable: true,
            kind: TagKind::Text,
            description: Some("Title".into()),
            storage_count: None,
        })
        .unwrap();
        index.set_drafts(
            7,
            3,
            &[(
                "a.jpg".into(),
                vec![MetadataTargetDraftEntry {
                    target,
                    edit: MetadataDraftEdit {
                        value: Some(MetadataValue::Text("Draft needle".into())),
                        intent: EditIntent::Set,
                    },
                }],
            )],
        );
        assert_eq!(
            index
                .query(&request("has:edits draft needle"))
                .unwrap()
                .matched_paths,
            vec!["a.jpg"]
        );
        index.set_drafts(7, 4, &[("a.jpg".into(), vec![])]);
        assert!(index
            .query(&request("has:edits"))
            .unwrap()
            .matched_paths
            .is_empty());
    }

    #[test]
    fn drafts_received_before_files_still_drive_has_edits_and_draft_text() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        let schema_id = SchemaDefinitionId {
            table: "XMP::Main".into(),
            tag_id: "title".into(),
            index: None,
        };
        let target = MetadataDraftTarget::from_new_property(&TagInfo {
            id: schema_id.clone(),
            group0: Some("XMP".into()),
            group: "XMP-dc".into(),
            name: "Title".into(),
            writable: true,
            kind: TagKind::Text,
            description: Some("Title".into()),
            storage_count: None,
        })
        .unwrap();
        let draft = |value: &str| {
            vec![MetadataTargetDraftEntry {
                target: target.clone(),
                edit: MetadataDraftEdit {
                    value: Some(MetadataValue::Text(value.into())),
                    intent: EditIntent::Set,
                },
            }]
        };
        // Drafts land first, exactly like persisted drafts at session open,
        // before any file has been added to the index.
        index.set_drafts(7, 2, &[("a.jpg".into(), draft("pre-indexed needle"))]);
        assert!(index
            .query(&request("has:edits"))
            .unwrap()
            .matched_paths
            .is_empty());
        // The file arrives afterwards; the pending draft must attach to it.
        index.add_files(7, 3, &[file("a.jpg", MediaKind::Image)]);
        assert_eq!(
            index.query(&request("has:edits")).unwrap().matched_paths,
            vec!["a.jpg"]
        );
        assert_eq!(
            index
                .query(&request("pre-indexed needle"))
                .unwrap()
                .matched_paths,
            vec!["a.jpg"]
        );
        // Discarding the draft before the file is indexed clears the pending
        // state instead of leaving a stale "has edits" document behind.
        index.remove_paths(7, 4, &["a.jpg".into()]);
        index.set_drafts(7, 5, &[("a.jpg".into(), vec![])]);
        index.add_files(7, 6, &[file("a.jpg", MediaKind::Image)]);
        assert!(index
            .query(&request("has:edits"))
            .unwrap()
            .matched_paths
            .is_empty());
    }

    #[test]
    fn friendly_and_raw_occurrence_and_draft_values_remain_searchable() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(
            7,
            2,
            &[
                file("enum.jpg", MediaKind::Image),
                file("flash.jpg", MediaKind::Image),
            ],
        );
        let enum_id = SchemaDefinitionId {
            table: "Test::Enum".into(),
            tag_id: "Direction".into(),
            index: None,
        };
        let enum_info = TagInfo {
            id: enum_id.clone(),
            group0: None,
            group: "Test".into(),
            name: "Direction".into(),
            writable: true,
            kind: TagKind::Enum {
                repr: crate::tag_schema::EnumRepr::String,
                options: vec![crate::tag_schema::EnumOption {
                    code: "south-code".into(),
                    label: "South".into(),
                }],
            },
            description: None,
            storage_count: None,
        };
        let occurrence = MetadataOccurrence::try_new(
            MetadataOccurrenceId {
                document: None,
                path: "XMP".into(),
                runtime_tag_id: "Direction".into(),
                tag_id_scope: RuntimeTagIdScope {
                    table: enum_id.table.clone(),
                    tag_id: enum_id.tag_id.clone(),
                    index: None,
                },
                copy: 0,
            },
            enum_id.clone(),
            MetadataValue::Text("south-code".into()),
            Some(enum_info),
            None,
            None,
        )
        .unwrap();
        index.set_metadata(
            7,
            3,
            &[(
                "enum.jpg".into(),
                Some(MetadataOccurrences(vec![occurrence])),
            )],
        );
        assert_eq!(
            index.query(&request("South")).unwrap().matched_paths,
            vec!["enum.jpg"]
        );
        assert_eq!(
            index.query(&request("south-code")).unwrap().matched_paths,
            vec!["enum.jpg"]
        );

        let flash_id = SchemaDefinitionId {
            table: "Exif::Main".into(),
            tag_id: "37385".into(),
            index: None,
        };
        let flash_info = TagInfo {
            id: flash_id.clone(),
            group0: Some("EXIF".into()),
            group: "ExifIFD".into(),
            name: "Flash".into(),
            writable: true,
            kind: TagKind::Integer {
                min: None,
                max: None,
            },
            description: Some("Flash status".into()),
            storage_count: None,
        };
        let target = MetadataDraftTarget::from_new_property(&flash_info).unwrap();
        let entries = vec![MetadataTargetDraftEntry {
            target,
            edit: MetadataDraftEdit {
                value: Some(MetadataValue::Integer(89)),
                intent: EditIntent::Set,
            },
        }];
        let text = drafts_text_with_lookup(&entries, |_| Some(flash_info.clone()));
        assert!(text.contains("red-eye reduction"));
        assert!(text.contains("89"));
        assert!(text.contains("flash status"));
    }

    #[test]
    fn exact_schema_index_diagnostic_uses_the_legacy_search_phrase() {
        let id = SchemaDefinitionId {
            table: "MakerNotes::Unknown".into(),
            tag_id: "0xBEEF".into(),
            index: Some(0),
        };
        assert!(schema_text(&id, None).iter().any(|part| part == "index 0"));
    }

    #[test]
    fn stale_session_requests_are_rejected_and_reset_clears_results() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(7, 2, &[file("a.jpg", MediaKind::Image)]);
        let mut stale = request("");
        stale.session_id = 6;
        assert!(index.query(&stale).is_err());
        index.reset(None, 3);
        assert!(index.query(&request("")).is_err());
    }

    #[test]
    fn two_thousand_file_batch_is_one_index_transition() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        let files = (0..2_000)
            .map(|number| file(&format!("{number}.jpg"), MediaKind::Image))
            .collect::<Vec<_>>();
        assert!(index.add_files(7, 2, &files));
        assert_eq!(index.documents.len(), 2_000);
        assert_eq!(index.session_revision, 2);
    }

    #[test]
    fn stale_revision_updates_cannot_restore_removed_state() {
        let mut index = SearchIndex::default();
        index.reset(Some(7), 1);
        index.add_files(7, 2, &[file("a.jpg", MediaKind::Image)]);
        assert!(index.remove_paths(7, 4, &["a.jpg".into()]));
        assert!(!index.set_metadata(7, 3, &[("a.jpg".into(), None)]));
        assert!(index.documents.is_empty());
        assert_eq!(index.session_revision, 4);
    }

    #[test]
    fn older_request_cannot_replace_the_latest_active_query() {
        let service = MediaLibrarySearchService::new();
        service.reset(Some(7), 1);
        service.add_files(7, 2, vec![file("a.jpg", MediaKind::Image)]);
        let mut latest = request("a");
        latest.request_id = 10;
        service.submit(latest).unwrap();
        let mut stale = request("missing");
        stale.request_id = 9;
        service.submit(stale).unwrap();
        let active = service.inner.active_request.lock().unwrap();
        assert_eq!(active.as_ref().unwrap().request.request_id, 10);
        assert_eq!(active.as_ref().unwrap().request.query, "a");
    }

    #[test]
    fn two_thousand_file_metadata_batch_causes_one_effective_refresh() {
        let service = MediaLibrarySearchService::new();
        service.reset(Some(7), 1);
        let files = (0..2_000)
            .map(|number| file(&format!("{number}.jpg"), MediaKind::Image))
            .collect::<Vec<_>>();
        service.add_files(7, 2, files);
        service.submit(request("batch needle")).unwrap();
        let occurrence = MetadataOccurrence::try_new(
            MetadataOccurrenceId {
                document: None,
                path: "XMP".into(),
                runtime_tag_id: "Needle".into(),
                tag_id_scope: RuntimeTagIdScope {
                    table: "Test::Main".into(),
                    tag_id: "Needle".into(),
                    index: None,
                },
                copy: 0,
            },
            SchemaDefinitionId {
                table: "Test::Main".into(),
                tag_id: "Needle".into(),
                index: None,
            },
            MetadataValue::Text("batch needle".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let entries = (0..2_000)
            .map(|number| {
                (
                    format!("{number}.jpg"),
                    Some(MetadataOccurrences(vec![occurrence.clone()])),
                )
            })
            .collect();
        service.set_metadata(7, 3, entries);
        std::thread::sleep(REFRESH_COALESCE_DELAY * 3);
        assert_eq!(service.effective_refresh_count(), 1);
        assert_eq!(service.event_count(), 0);
    }

    #[test]
    fn service_does_not_emit_without_an_active_query() {
        let service = MediaLibrarySearchService::new();
        service.reset(Some(7), 1);
        service.add_files(7, 2, vec![file("a.jpg", MediaKind::Image)]);
        std::thread::sleep(REFRESH_COALESCE_DELAY * 2);
        assert_eq!(service.event_count(), 0);
    }
}
