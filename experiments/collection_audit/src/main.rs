//! Read-only adapters to the production scanner, registry and normalizer.
use medialibrary_tauri_lib::{
    normalise::{self, NormaliseGroup, NormaliseRequestItem},
    scanner,
    tag_schema::get_registry,
};
use std::{
    error::Error,
    fs,
    future::Future,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    task::{Context, Poll, Waker},
};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("Expected schema, scan or run")?;
    let out = PathBuf::from(args.get(2).ok_or("Expected output directory")?);
    match mode.as_str() {
        "schema" => {
            let registry = get_registry()?;
            let infos: Vec<_> = registry.iter().map(|(_, v)| v).collect();
            fs::write(out.join("schema.json"), serde_json::to_vec(&infos)?)?;
        }
        "scan" => {
            let root = Path::new(args.get(3).ok_or("Expected collection root")?);
            let inventory: Vec<serde_json::Value> =
                serde_json::from_slice(&fs::read(out.join("inventory.json"))?)?;
            let mut output = BufWriter::new(fs::File::create(out.join("scan.jsonl"))?);
            for chunk in inventory.chunks(50) {
                let relative: Vec<_> = chunk
                    .iter()
                    .map(|row| row["relative_path"].as_str().unwrap().to_owned())
                    .collect();
                let paths: Vec<_> = relative.iter().map(|rel| root.join(rel)).collect();
                let read = scanner::read_file_metadata_batch(&relative, &paths)?;
                if !read.failures.is_empty() {
                    return Err(format!("Metadata scan incomplete: {:?}", read.failures).into());
                }
                if read.results.len() != chunk.len() {
                    return Err("Metadata scan returned an incomplete batch".into());
                }
                for row in read.results {
                    writeln!(output, "{}", serde_json::to_string(&row)?)?;
                }
            }
        }
        "run" => {
            let input = BufReader::new(fs::File::open(out.join("items.jsonl"))?);
            let mut output =
                BufWriter::new(fs::File::create(out.join("normaliser-results.jsonl"))?);
            let mut cx = Context::from_waker(Waker::noop());
            let mut count = 0;
            for line in input.lines() {
                let item: NormaliseRequestItem = serde_json::from_str(&line?)?;
                // No AI client, HTTP client, draft repository or apply command.
                let mut future = Box::pin(normalise::process_item(
                    &item,
                    NormaliseGroup::ALL,
                    None,
                    None,
                ));
                let Poll::Ready((edits, stats, error, calls)) = future.as_mut().poll(&mut cx)
                else {
                    return Err("Offline normalizer unexpectedly awaited external work".into());
                };
                if calls.iter().any(|call| call.error.is_none()) {
                    return Err("Offline audit unexpectedly recorded a successful AI call".into());
                }
                let planned: Vec<_> = edits
                    .iter()
                    .map(|(schema, edit)| serde_json::json!({"schema_id":schema,"edit":edit}))
                    .collect();
                writeln!(
                    output,
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "relative_path":item.rel_path,"edits":planned,"stats":stats,
                        "error":error.map(|e| format!("{e:?}")),"blocked_fields":stats.blocked_fields,
                        "conflicts":stats.conflicts
                    }))?
                )?;
                count += 1;
            }
            println!("Tested {count} files with production Normalize; no AI calls or draft writes");
        }
        _ => return Err("Expected schema, scan or run".into()),
    }
    Ok(())
}
