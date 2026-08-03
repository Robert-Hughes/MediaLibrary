//! Image thumbnail extraction, orientation normalisation, and fallback decoding.

use std::path::Path;

/// Generate a base64-encoded JPEG thumbnail for the image at `path`.
///
/// Strategy:
/// 1. Try to extract an embedded EXIF thumbnail. If its largest dimension
///    is >= 160 px, use it as-is (fast path, ~10-50 ms).
/// 2. Otherwise, full-decode the image and resize so the largest dimension
///    is 160 px (slow path, ~100-500 ms release, 2-4 s debug).
pub fn thumbnail_for(path: &Path) -> Option<String> {
    // TEMPORARY: simulate slow thumbnail generation for load testing.
    #[cfg(not(test))]
    if std::env::var("MEDIA_LIBRARY_SLOW_MODE").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }

    // Try fast path: extract embedded thumbnail from EXIF
    if let Some(thumb) = extract_exif_thumbnail(path) {
        return Some(thumb);
    }

    // Fall back to full decode
    full_decode_thumbnail(path)
}

/// Try to extract an embedded EXIF thumbnail (very fast).
///
/// Returns `Some` only when the embedded thumbnail's largest dimension is
/// >= 160 px — in that case we return it as-is without re-encoding.
pub(super) fn extract_exif_thumbnail(path: &Path) -> Option<String> {
    use std::fs::File;
    use std::io::{BufReader, Read};

    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);

    // Parse EXIF data
    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let orientation = crate::image_orientation::orientation_from_exif(&exif, exif::In::THUMBNAIL)
        .or_else(|| crate::image_orientation::orientation_from_exif(&exif, exif::In::PRIMARY))
        .unwrap_or(1);

    // Look for thumbnail in EXIF data
    let offset_field = exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?;
    let length_field =
        exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?;

    if let (exif::Value::Long(offsets), exif::Value::Long(lengths)) =
        (&offset_field.value, &length_field.value)
    {
        if let (Some(&offset), Some(&length)) = (offsets.first(), lengths.first()) {
            // Re-open file to read the entire file and find TIFF header
            let mut file = File::open(path).ok()?;
            let mut file_data = Vec::new();
            file.read_to_end(&mut file_data).ok()?;

            // Find the TIFF header in the JPEG file
            // JPEG structure: FF D8 (SOI) ... FF E1 XX XX "Exif\0\0" [TIFF header starts here]
            let tiff_offset = find_tiff_offset(&file_data)?;

            // The thumbnail offset is relative to the TIFF header
            let absolute_offset = tiff_offset + offset as usize;

            if absolute_offset + length as usize > file_data.len() {
                return None;
            }

            let thumbnail_bytes = &file_data[absolute_offset..absolute_offset + length as usize];

            // Check if it's a valid JPEG (starts with 0xFF 0xD8)
            if thumbnail_bytes.len() > 2 && thumbnail_bytes[0] == 0xFF && thumbnail_bytes[1] == 0xD8
            {
                // Decode just enough to check dimensions
                if let Ok(img) = image::load_from_memory(thumbnail_bytes) {
                    let largest = img.width().max(img.height());
                    if largest >= 160 {
                        if orientation == 1 {
                            // Embedded thumbnail is already display-oriented,
                            // so preserve the fast byte-for-byte path.
                            return Some(base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                thumbnail_bytes,
                            ));
                        }

                        // IFD1 orientation lives outside the embedded JPEG.
                        // Once extracted, browsers cannot see it, so normalize
                        // the pixels and emit a self-contained thumbnail.
                        let oriented = crate::image_orientation::apply(img, orientation);
                        return encode_thumbnail_jpeg(&oriented);
                    }
                    // Embedded thumbnail is too small; fall through to full decode
                }
            }
        }
    }

    None
}

/// Find the offset of the TIFF header within a JPEG file.
/// JPEG structure: FF D8 (SOI) ... FF E1 XX XX "Exif\0\0" [TIFF header]
fn find_tiff_offset(data: &[u8]) -> Option<usize> {
    // Look for EXIF marker: FF E1
    for i in 0..data.len().saturating_sub(10) {
        if data[i] == 0xFF && data[i + 1] == 0xE1 {
            // Check for "Exif\0\0" identifier
            if i + 10 < data.len()
                && data[i + 4] == b'E'
                && data[i + 5] == b'x'
                && data[i + 6] == b'i'
                && data[i + 7] == b'f'
                && data[i + 8] == 0
                && data[i + 9] == 0
            {
                // TIFF header starts right after "Exif\0\0"
                return Some(i + 10);
            }
        }
    }
    None
}

fn encode_thumbnail_jpeg(img: &image::DynamicImage) -> Option<String> {
    let mut buf = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut buf),
        image::ImageFormat::Jpeg,
    )
    .ok()?;
    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &buf,
    ))
}

fn full_decode_thumbnail(path: &Path) -> Option<String> {
    let orientation = crate::image_orientation::primary_orientation(path).unwrap_or(1);
    let img = image::open(path).ok()?;
    let img = crate::image_orientation::apply(img, orientation);
    let thumb = img.thumbnail(160, 160);
    encode_thumbnail_jpeg(&thumb)
}
