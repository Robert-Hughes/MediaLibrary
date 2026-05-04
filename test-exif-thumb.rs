use std::fs::File;
use std::io::BufReader;

fn main() {
    let path = std::env::args().nth(1).expect("Usage: test-exif-thumb <image-path>");
    
    let file = File::open(&path).expect("Failed to open file");
    let mut reader = BufReader::new(file);
    
    let exif_reader = exif::Reader::new();
    match exif_reader.read_from_container(&mut reader) {
        Ok(exif) => {
            println!("✓ EXIF data found");
            
            // Check for thumbnail offset and length
            let offset = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL);
            let length = exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL);
            
            match (offset, length) {
                (Some(off), Some(len)) => {
                    println!("✓ Thumbnail found!");
                    println!("  Offset: {:?}", off.value);
                    println!("  Length: {:?}", len.value);
                }
                _ => {
                    println!("✗ No thumbnail in EXIF");
                    
                    // List all fields to see what's available
                    println!("\nAvailable EXIF fields:");
                    for field in exif.fields() {
                        println!("  {:?} = {:?}", field.tag, field.value);
                    }
                }
            }
        }
        Err(e) => {
            println!("✗ Failed to read EXIF: {}", e);
        }
    }
}
