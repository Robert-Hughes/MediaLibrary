use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyFileResult {
    pub relative_path: String,
    pub applied: bool,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub fresh_file_metadata: Option<scanner::FileMetadata>,
    pub target_outcomes: Vec<MetadataTargetOutcome>,
    pub persisted_draft_entries: Option<Vec<MetadataTargetDraftEntry>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplyResult {
    pub summary: MetadataApplySummary,
    pub undelivered_files: Vec<MetadataApplyFileResult>,
    pub complete_delivery_failed: bool,
    #[cfg(test)]
    #[serde(skip)]
    #[ts(skip)]
    pub files: Vec<MetadataApplyFileResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct MetadataApplySummary {
    pub requested: usize,
    pub selected: usize,
    pub completed: usize,
    pub applied: usize,
    pub failed: usize,
    pub warning_count: usize,
    pub cancelled: bool,
    pub aborted: bool,
    pub abort_reason: Option<String>,
    pub delivery_failure_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetadataApplyStreamMessage {
    Started {
        operation_id: String,
        total: usize,
    },
    ProgressBatch {
        operation_id: String,
        sequence: usize,
        current: usize,
        total: usize,
        results: Vec<MetadataApplyFileResult>,
    },
    Complete {
        operation_id: String,
        summary: MetadataApplySummary,
    },
}
