//! Tag-specific country-code projection for XMP/IPTC location mirrors.

pub const IPTC_COUNTRY_PRIMARY_LOCATION_CODE: &str = "IPTC:Country-PrimaryLocationCode";

/// App-level country code semantics: trimmed, whitespace-collapsed,
/// uppercase text. This intentionally preserves alpha-2 values and does
/// not perform ISO alpha-2/alpha-3 conversion.
pub fn canonical_country_code(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

pub fn xmp_country_code_projection(value: &str) -> String {
    canonical_country_code(value)
}

/// Legacy IPTC IIM stores this field as fixed-width text. For normal
/// alpha-2 values, write the three-byte storage projection ExifTool reads
/// back as a trailing-space-padded value.
pub fn iptc_country_code_projection(value: &str) -> String {
    let canonical = canonical_country_code(value);
    if canonical.len() == 2 && canonical.is_ascii() {
        format!("{canonical} ")
    } else {
        canonical
    }
}

/// Readback canonicalisation trims the legacy fixed-width storage padding
/// before semantic comparison.
pub fn canonical_iptc_country_code_readback(value: &str) -> String {
    canonical_country_code(value.trim_end_matches(' '))
}

pub fn iptc_country_code_storage_equivalent(expected: &str, observed: &str) -> bool {
    canonical_iptc_country_code_readback(expected) == canonical_iptc_country_code_readback(observed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_code_projection_keeps_alpha_2_semantics_and_pads_iptc() {
        assert_eq!(canonical_country_code(" gb "), "GB");
        assert_eq!(canonical_country_code("g \t b"), "G B");
        assert_eq!(xmp_country_code_projection(" gb "), "GB");
        assert_eq!(iptc_country_code_projection(" gb "), "GB ");
        assert_eq!(iptc_country_code_projection("GBR"), "GBR");
        assert_eq!(canonical_iptc_country_code_readback("GB "), "GB");
    }
}
