//! Exact ExifTool schema identities used by specialised application behaviour.

use crate::tag_schema::SchemaDefinitionId;

fn id(table: &str, tag_id: &str) -> SchemaDefinitionId {
    SchemaDefinitionId {
        table: table.to_owned(),
        tag_id: tag_id.to_owned(),
        index: None,
    }
}

macro_rules! known_ids {
    ($($name:ident => ($table:literal, $tag_id:literal)),+ $(,)?) => {
        $(pub fn $name() -> SchemaDefinitionId { id($table, $tag_id) })+
    };
}

known_ids! {
    image_description => ("Exif::Main", "270"), artist => ("Exif::Main", "315"),
    copyright => ("Exif::Main", "33432"), date_time_original => ("Exif::Main", "36867"),
    create_date => ("Exif::Main", "36868"), offset_time => ("Exif::Main", "36880"),
    offset_time_original => ("Exif::Main", "36881"), offset_time_digitized => ("Exif::Main", "36882"),
    sub_sec_time_original => ("Exif::Main", "37521"), sub_sec_time_digitized => ("Exif::Main", "37522"),
    iptc_coded_character_set => ("IPTC::EnvelopeRecord", "90"),
    iptc_object_name => ("IPTC::ApplicationRecord", "5"), iptc_keywords => ("IPTC::ApplicationRecord", "25"),
    iptc_date_created => ("IPTC::ApplicationRecord", "55"), iptc_time_created => ("IPTC::ApplicationRecord", "60"),
    iptc_digital_creation_date => ("IPTC::ApplicationRecord", "62"), iptc_digital_creation_time => ("IPTC::ApplicationRecord", "63"),
    iptc_by_line => ("IPTC::ApplicationRecord", "80"), iptc_city => ("IPTC::ApplicationRecord", "90"),
    iptc_sub_location => ("IPTC::ApplicationRecord", "92"), iptc_province_state => ("IPTC::ApplicationRecord", "95"),
    iptc_country_code => ("IPTC::ApplicationRecord", "100"), iptc_country_name => ("IPTC::ApplicationRecord", "101"),
    iptc_headline => ("IPTC::ApplicationRecord", "105"), iptc_copyright => ("IPTC::ApplicationRecord", "116"),
    iptc_caption => ("IPTC::ApplicationRecord", "120"),
    xmp_description => ("XMP::dc", "description"), xmp_title => ("XMP::dc", "title"),
    xmp_subject => ("XMP::dc", "subject"), xmp_creator => ("XMP::dc", "creator"),
    xmp_rights => ("XMP::dc", "rights"), xmp_hierarchical_subject => ("XMP::Lightroom", "hierarchicalSubject"),
    xmp_headline => ("XMP::photoshop", "Headline"), xmp_city => ("XMP::photoshop", "City"),
    xmp_state => ("XMP::photoshop", "State"), xmp_country => ("XMP::photoshop", "Country"),
    xmp_date_created => ("XMP::photoshop", "DateCreated"), xmp_location => ("XMP::iptcCore", "Location"),
    xmp_country_code => ("XMP::iptcCore", "CountryCode"), xmp_create_date => ("XMP::xmp", "CreateDate"),
    mlib_ai_description => ("UserDefined::mlib", "AIDescription"),
    mlib_ai_interpretation => ("UserDefined::mlib", "AIInterpretation"),
    mlib_ai_objects => ("UserDefined::mlib", "AIObjects"), mlib_ai_ocr_text => ("UserDefined::mlib", "AIOcrText"),
    mlib_ai_tags => ("UserDefined::mlib", "AITags"), mlib_ai_model => ("UserDefined::mlib", "AIModel"),
    mlib_ai_prompt_version => ("UserDefined::mlib", "AIPromptVersion"),
    mlib_ai_generated_at => ("UserDefined::mlib", "AIGeneratedAt"),
}

#[cfg(test)]
pub fn test_id(label: &str) -> SchemaDefinitionId {
    match label {
        "IFD0:ImageDescription" => image_description(), "IFD0:Artist" => artist(),
        "IFD0:Copyright" => copyright(), "ExifIFD:DateTimeOriginal" => date_time_original(),
        "ExifIFD:CreateDate" => create_date(), "XMP-dc:Description" => xmp_description(),
        "XMP-dc:Title" => xmp_title(), "XMP-dc:Subject" => xmp_subject(),
        "XMP-dc:Creator" => xmp_creator(), "XMP-dc:Rights" => xmp_rights(),
        "XMP-lr:HierarchicalSubject" => xmp_hierarchical_subject(),
        "XMP-photoshop:Headline" => xmp_headline(), "XMP-photoshop:City" => xmp_city(),
        "XMP-photoshop:State" => xmp_state(), "XMP-photoshop:Country" => xmp_country(),
        "XMP-photoshop:DateCreated" => xmp_date_created(),
        "XMP-iptcCore:Location" => xmp_location(), "XMP-iptcCore:CountryCode" => xmp_country_code(),
        "XMP-xmp:CreateDate" => xmp_create_date(), "IPTC:ObjectName" => iptc_object_name(),
        "IPTC:Keywords" => iptc_keywords(), "IPTC:DateCreated" => iptc_date_created(),
        "IPTC:TimeCreated" => iptc_time_created(), "IPTC:DigitalCreationDate" => iptc_digital_creation_date(),
        "IPTC:DigitalCreationTime" => iptc_digital_creation_time(), "IPTC:By-line" => iptc_by_line(),
        "IPTC:City" => iptc_city(), "IPTC:Sub-location" => iptc_sub_location(),
        "IPTC:Province-State" => iptc_province_state(), "IPTC:Country-PrimaryLocationCode" => iptc_country_code(),
        "IPTC:Country-PrimaryLocationName" => iptc_country_name(), "IPTC:Headline" => iptc_headline(),
        "IPTC:CopyrightNotice" => iptc_copyright(), "IPTC:Caption-Abstract" => iptc_caption(),
        "XMP-mlib:AIDescription" => mlib_ai_description(), "XMP-mlib:AIInterpretation" => mlib_ai_interpretation(),
        "XMP-mlib:AIObjects" => mlib_ai_objects(), "XMP-mlib:AIOcrText" => mlib_ai_ocr_text(),
        "XMP-mlib:AITags" => mlib_ai_tags(), "XMP-mlib:AIModel" => mlib_ai_model(),
        "XMP-mlib:AIPromptVersion" => mlib_ai_prompt_version(), "XMP-mlib:AIGeneratedAt" => mlib_ai_generated_at(),
        other => panic!("no exact test schema identity registered for {other}"),
    }
}
