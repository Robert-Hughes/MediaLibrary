use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use exif::{Exif, In, Tag};
use image::DynamicImage;

/// Read an EXIF orientation from one image directory.
///
/// Values outside the EXIF-defined 1..=8 range are treated as absent so
/// callers can safely fall back to another directory or to normal orientation.
pub(crate) fn orientation_from_exif(exif: &Exif, image: In) -> Option<u32> {
    exif.get_field(Tag::Orientation, image)
        .and_then(|field| field.value.get_uint(0))
        .filter(|orientation| (1..=8).contains(orientation))
}

/// Read the primary image's EXIF orientation, if the container has one.
pub(crate) fn primary_orientation(path: &Path) -> Option<u32> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    orientation_from_exif(&exif, In::PRIMARY)
}

/// Put decoded pixels into the display orientation requested by EXIF.
///
/// This handles the mirrored orientations as well as the four rotations.
pub(crate) fn apply(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate90().flipv(),
        8 => img.rotate270(),
        _ => img,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labelled_image() -> DynamicImage {
        let mut image = image::RgbImage::new(3, 2);
        for (pixel, label) in image.pixels_mut().zip(1_u8..) {
            *pixel = image::Rgb([label, 0, 0]);
        }
        DynamicImage::ImageRgb8(image)
    }

    fn labels(image: &DynamicImage) -> Vec<u8> {
        image.to_rgb8().pixels().map(|pixel| pixel[0]).collect()
    }

    #[test]
    fn applies_all_eight_exif_orientations() {
        let cases: &[(u32, (u32, u32), &[u8])] = &[
            (1, (3, 2), &[1, 2, 3, 4, 5, 6]),
            (2, (3, 2), &[3, 2, 1, 6, 5, 4]),
            (3, (3, 2), &[6, 5, 4, 3, 2, 1]),
            (4, (3, 2), &[4, 5, 6, 1, 2, 3]),
            (5, (2, 3), &[1, 4, 2, 5, 3, 6]),
            (6, (2, 3), &[4, 1, 5, 2, 6, 3]),
            (7, (2, 3), &[6, 3, 5, 2, 4, 1]),
            (8, (2, 3), &[3, 6, 2, 5, 1, 4]),
        ];

        for &(orientation, dimensions, expected) in cases {
            let actual = apply(labelled_image(), orientation);
            assert_eq!(
                (actual.width(), actual.height()),
                dimensions,
                "orientation {orientation}"
            );
            assert_eq!(labels(&actual), expected, "orientation {orientation}");
        }
    }

    #[test]
    fn unknown_orientation_leaves_pixels_unchanged() {
        let original = labelled_image();
        let actual = apply(original.clone(), 99);
        assert_eq!(
            (actual.width(), actual.height()),
            (original.width(), original.height())
        );
        assert_eq!(labels(&actual), labels(&original));
    }
}
