use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub type DraftEditsPayload = HashMap<String, HashMap<String, Option<String>>>;

#[derive(Serialize, Deserialize)]
struct DraftEditLine {
    relative_path: String,
    edits: HashMap<String, Option<String>>,
}

const FILE_NAME: &str = "MediaLibraryDraftEdits.jsonl";
const HEADER_COMMENT: &str = "// This file stores unapplied metadata draft edits. Lines starting with // are ignored.";

pub fn load_draft_edits(folder_path: &str) -> Result<DraftEditsPayload, String> {
    let path = Path::new(folder_path).join(FILE_NAME);
    let mut payload: DraftEditsPayload = HashMap::new();

    if !path.exists() {
        return Ok(payload);
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        if let Ok(parsed) = serde_json::from_str::<DraftEditLine>(trimmed) {
            payload.insert(parsed.relative_path, parsed.edits);
        }
    }

    Ok(payload)
}

pub fn save_draft_edits(folder_path: &str, data: DraftEditsPayload) -> Result<(), String> {
    let path = Path::new(folder_path).join(FILE_NAME);
    
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    writeln!(file, "{}", HEADER_COMMENT).map_err(|e| e.to_string())?;

    for (relative_path, edits) in data {
        if edits.is_empty() {
            continue;
        }
        let line = DraftEditLine {
            relative_path,
            edits,
        };
        let json_line = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{}", json_line).map_err(|e| e.to_string())?;
    }

    Ok(())
}
