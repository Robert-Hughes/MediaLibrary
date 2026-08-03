//! Media classification and built-in non-image thumbnails.

use serde::{Deserialize, Serialize};

/// Broad media category assigned during folder discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub enum MediaKind {
    Image,
    Audio,
    Video,
}

const AUDIO_PLACEHOLDER_THUMBNAIL: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABAAEADASIAAhEBAxEB/8QAGQAAAwEBAQAAAAAAAAAAAAAAAAcIBQMG/8QANRAAAQMDAwIDAwsFAAAAAAAAAQIDBAAFEQYSIQcTIjFBFFGzCBUWIzI2N3WBg5FWYZSx0v/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCj6KKKAooooCisi96msli3i8XaFDcS0Xu068kOKRzylH2leRAwDkjApe6i66abgIUmztSrs/tCklKSw1ndgpKljcCBzwkjyGfPANmilzoDqja9RWuXMvMu12ZxMktMxn5iAvthCDuJVjOVFfIAHGPQksKO81JjtPx3UOsOpC23G1BSVpIyCCOCCPWg6UUUUHietE2Vb+ml4lW+S/Fkt9nY8w4ULTl5AOFDkcEj9al36Z6o/qS9f57v/VU113/Cq+fsfHbpF9C9N2rVGrZcK+xfaozcFbyUdxaMLDjYBykg+Sj/ADQLqvZWLplq+8yO2zZJUVCVJSt2an2dKQo/a8eCoDBJ2gke7kZrGxWC02CP2bNbosJBSlCiy2EqcCRhO9XmojJ5JJ5PvrUoIf1ZYJWl9QSrPcHGHJMbZvUwolB3IChgkA+Sh6VYPT/7h6b/ACyN8JNTL13/ABVvn7HwG6prp/8AcPTf5ZG+Emg365yHmo0d1+Q6hphpJW444oJShIGSSTwAB610qUeuOsZmoNWTLWlxaLVbH1MtsY27nU+FbisE5OdwB9E+gJVkHD1ivVru/SrUPzTcoU7tez9z2Z9DuzL6MZ2k4zg/waWPyZPv5P8Ayxz4rVKOnR8mm2T2tVSri7BlIt71vcQ3KU0oNLV3W+AvGCfCrjPofdQUfU0dceos+4X2Zp+0SVxrXDUph9TKlJVJXjatK/I7ASpO3yOCTnw4pepR646Omaf1ZMuiW1rtVzfU82/ndtdV4ltqwBg53ED1T6khWAW1Wh0xmMTunmnXYq+42mC0yTgjxtpCFjn3KSofpxUd2i2zLxco9vtkdcmZIVsbaR5k/wCgAMkk8AAk8VZmgrB9F9IWyzlzuORmvrFBWQXFEqXtOB4dyjjIzjGaDfqaOuPTqfb77M1BaIy5NrmKU++llKlKjLxuWpfmdhIUrd5DJBx4c0vRQRHpPS921VckQ7NEW6SoJceIIaYBz4nFYwkYB/ucYAJ4qxdI2JjTWm7fZ4p3NxWgkrwRvWTla8EnGVFRxnjOBWvRQFc5DLUmO6xIaQ6w6kocbcSFJWkjBBB4II9K6UUGfarLa7R3fmm2woPdx3PZmENb8ZxnaBnGT/JrQoooP//Z";
const VIDEO_PLACEHOLDER_THUMBNAIL: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABAAEADASIAAhEBAxEB/8QAGQABAQEBAQEAAAAAAAAAAAAABwAIBgUD/8QAPxAAAQIEAwEJDgUFAAAAAAAAAQIDAAQFEQYSIQcIEyIxNkFRdbMVFhcYMlRWZpOUpdLT40ZSgYTDFDNhcpL/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A0fFFHC432oYfwfUkU+fM1NThTncalEJWWQbWz5lAAkG4GptqbAi4d1FBF4fML+YVr2LX1IvD5hfzCtexa+pALsUEXh8wv5hWvYtfUi8PmF/MK17Fr6kAuxQc4V2wYaxHWmaYyJ2TmH9GlTiEIQtfMgFKjwjzXtfi4yAUaAozpudqNTsRT+JJ2vyTFTmUbzZc4nftXC4VqIVcFRKRwjrx66m+i4A9yv8Aif8Aa/zQC73mYX9G6L7g18sfNOEsJKmFsJw/QS+hKVqbEkzmSlRISSMtwCUqsefKeiOjjNm6MnZqn7R6bNU+ZflZlumIyPMOFC03ceBsoajQkfrAOneZhf0bovuDXyxd5mF/Rui+4NfLBFgjbv8A2pTF8r0J/r5VP+outv8A6USn/ACIdJCdlahKImqfMsTUs5fI8w4FoVY2NlDQ6gj9IAT3ROGaJS8JU+dpdJkpKZE8lnPLMpazIU2skEJsDqhPHxa24zdZwO87M4Kw+/MOrdfdp8utxxxRUpai2kkknUknng93TfIOQ6zb7J2O+2f8g8N9WS3ZJgPfgD3K/wCJ/wBr/ND5Gf8AcsvNJmMSMKdQH1pl1pbKhmUlJcCiBxkAqTc82YdMBoCMybpvl5IdWN9q7Gm489dGpzlaTV3JJhdTQ0GUTK05ltoGbRJPk+Wq9rXvrewgM6YI2I1irb1NYic7kySrK3mwVMLTwTbLxIuCocLUEapjQmG8NUfDUoZeh09iTbV5ZQCVr1JGZZupVsxtcm17CPXigCLdN8g5DrNvsnY77Z/yDw31ZLdkmD3dOPNJwVTWFOoD66glaWyoZlJS24FEDjIBUm55sw6YQtn/ACDw31ZLdkmA9+CrH+xqnYorRqchPdyZh65mUpl98Q6v84GZOVR1v08ehuSqxQAH4vPrP8P+7F4vPrP8P+7D5FAAfi8+s/w/7sXi8+s/w/7sPkUANYV2E06lVpmdq9S7rS7PCTKqld6QpfMV8NWZI/Lz6XuLgssUUB//2Q==";

/// Return the built-in thumbnail for a non-image media kind.
pub fn placeholder_thumbnail(media_kind: MediaKind) -> Option<&'static str> {
    match media_kind {
        MediaKind::Image => None,
        MediaKind::Audio => Some(AUDIO_PLACEHOLDER_THUMBNAIL),
        MediaKind::Video => Some(VIDEO_PLACEHOLDER_THUMBNAIL),
    }
}
/// An unsupported extension returns `None` and is omitted from the scan.
pub(super) fn media_kind_from_extension(extension: &str) -> Option<MediaKind> {
    match extension {
        // Images
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" => Some(MediaKind::Image),
        // Audio
        "mp3" | "flac" | "m4a" | "m4b" | "aac" | "wav" | "aiff" | "ogg" | "opus" | "wma"
        | "ape" => Some(MediaKind::Audio),
        // Video
        "mp4" | "mov" | "m4v" | "3gp" | "3g2" | "avi" | "mkv" | "webm" | "mpg" | "mpeg" | "m2v"
        | "mts" | "m2ts" | "ts" | "wmv" => Some(MediaKind::Video),
        _ => None,
    }
}
