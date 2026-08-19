use super::*;
use quick_xml::events::Event;
use quick_xml::Reader;

impl TagRegistry {
    /// Build from raw `exiftool -listx -f -lang en` XML output.
    /// Public for testing against fixture XML.
    pub fn from_listx_xml(xml: &str) -> Result<Self, SchemaError> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(true);

        let mut tags: BTreeMap<SchemaDefinitionId, TagInfo> = BTreeMap::new();
        let mut current_group0: Option<String> = None;
        let mut current_group: Option<String> = None;
        let mut current_table: Option<String> = None;
        let mut table_tags: Vec<PartialTag> = Vec::new();
        let mut current_tag: Option<PartialTag> = None;
        let mut in_desc_en = false;
        let mut in_values = false;
        let mut current_value_id: Option<String> = None;
        let mut in_value_label_en = false;
        let mut desc_buffer = String::new();
        let mut value_label_buffer = String::new();

        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Err(e) => {
                    return Err(SchemaError::XmlParseError {
                        detail: e.to_string(),
                    })
                }
                Ok(Event::Eof) => break,
                Ok(Event::Start(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    let attrs = collect_attrs(&e);
                    match name.as_str() {
                        "table" => {
                            current_group0 = attrs.get("g0").cloned();
                            current_group = attrs.get("g1").cloned();
                            current_table = attrs
                                .get("name")
                                .map(|name| normalize_static_table_name(name));
                            table_tags.clear();
                        }
                        "tag" => {
                            let g0 = attrs
                                .get("g0")
                                .cloned()
                                .or_else(|| current_group0.clone())
                                .unwrap_or_default();
                            let g1 = attrs
                                .get("g1")
                                .cloned()
                                .or_else(|| current_group.clone())
                                .unwrap_or_default();
                            let tag_name = attrs.get("name").cloned().unwrap_or_default();
                            let type_attr = attrs.get("type").cloned().unwrap_or_default();
                            let writable =
                                attrs.get("writable").map(|s| s == "true").unwrap_or(false);
                            let count = attrs.get("count").cloned();
                            let flags = attrs
                                .get("flags")
                                .map(|value| {
                                    value.split(',').map(str::trim).map(str::to_owned).collect()
                                })
                                .unwrap_or_default();
                            current_tag = Some(PartialTag {
                                tag_id: normalize_static_tag_id(
                                    attrs.get("id").map(String::as_str).unwrap_or_default(),
                                ),
                                struct_parent: attrs
                                    .get("struct")
                                    .map(|id| normalize_static_tag_id(id)),
                                group0: g0,
                                group: g1,
                                name: tag_name,
                                type_attr,
                                writable,
                                count,
                                flags,
                                description: None,
                                enum_options: Vec::new(),
                            });
                        }
                        "desc" => {
                            let lang = attrs.get("lang").cloned().unwrap_or_default();
                            if lang == "en" {
                                if in_values && current_value_id.is_some() {
                                    in_value_label_en = true;
                                    value_label_buffer.clear();
                                } else if current_tag.is_some() {
                                    in_desc_en = true;
                                    desc_buffer.clear();
                                }
                            }
                        }
                        "values" => {
                            in_values = true;
                        }
                        "key" => {
                            current_value_id = attrs.get("id").cloned();
                        }
                        "val" => {
                            let lang = attrs.get("lang").cloned().unwrap_or_default();
                            if lang == "en" && current_value_id.is_some() {
                                in_value_label_en = true;
                                value_label_buffer.clear();
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::End(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    match name.as_str() {
                        "tag" => {
                            if let Some(partial) = current_tag.take() {
                                table_tags.push(partial);
                            }
                        }
                        "desc" => {
                            if in_value_label_en {
                                if let Some(tag) = current_tag.as_mut() {
                                    if let Some(id) = current_value_id.clone() {
                                        tag.enum_options.push(EnumOption {
                                            code: id,
                                            label: value_label_buffer.trim().to_string(),
                                        });
                                    }
                                }
                                in_value_label_en = false;
                            } else if in_desc_en {
                                if let Some(tag) = current_tag.as_mut() {
                                    tag.description = Some(desc_buffer.trim().to_string());
                                }
                                in_desc_en = false;
                            }
                        }
                        "val" => {
                            if in_value_label_en && current_value_id.is_some() {
                                if let Some(tag) = current_tag.as_mut() {
                                    tag.enum_options.push(EnumOption {
                                        code: current_value_id.clone().unwrap(),
                                        label: value_label_buffer.trim().to_string(),
                                    });
                                }
                                in_value_label_en = false;
                            }
                        }
                        "key" => {
                            current_value_id = None;
                        }
                        "values" => {
                            in_values = false;
                        }
                        "table" => {
                            let table = current_table.take().unwrap_or_default();
                            let mut counts = BTreeMap::<String, usize>::new();
                            for partial in &table_tags {
                                *counts.entry(partial.tag_id.clone()).or_default() += 1;
                            }
                            let mut occurrences = BTreeMap::<String, u32>::new();
                            let mut finalized = Vec::with_capacity(table_tags.len());
                            for partial in table_tags.drain(..) {
                                let occurrence =
                                    occurrences.entry(partial.tag_id.clone()).or_default();
                                let index = (counts[&partial.tag_id] > 1).then_some(*occurrence);
                                *occurrence += 1;
                                let id = SchemaDefinitionId {
                                    table: table.clone(),
                                    tag_id: partial.tag_id.clone(),
                                    index,
                                };
                                let struct_member = partial.struct_member()?;
                                let info = partial.finalize(id.clone());
                                finalized.push((id, info, struct_member));
                            }
                            populate_struct_fields(&mut finalized)?;
                            for (id, info, _) in finalized {
                                if let Some(previous) = tags.insert(id.clone(), info.clone()) {
                                    return Err(SchemaError::XmlParseError { detail: format!(
                                        "duplicate schema identity {id:?}: {previous:?} and {info:?}"
                                    ) });
                                }
                            }
                            current_group = None;
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) => {
                    let text = t.unescape().unwrap_or_default();
                    if in_value_label_en {
                        value_label_buffer.push_str(&text);
                    } else if in_desc_en {
                        desc_buffer.push_str(&text);
                    }
                }
                _ => {}
            }
            buf.clear();
        }

        // Apply semantic overrides where physical listx types are insufficient.
        apply_overrides(&mut tags);

        Ok(TagRegistry { tags })
    }
}

pub(super) struct PartialTag {
    tag_id: String,
    struct_parent: Option<String>,
    group0: String,
    group: String,
    name: String,
    type_attr: String,
    writable: bool,
    count: Option<String>,
    flags: Vec<String>,
    description: Option<String>,
    enum_options: Vec<EnumOption>,
}

impl PartialTag {
    fn struct_member(&self) -> Result<Option<StructMember>, SchemaError> {
        let Some(parent_tag_id) = &self.struct_parent else {
            return Ok(None);
        };
        let Some(field_name) = self.tag_id.strip_prefix(parent_tag_id) else {
            return Err(SchemaError::XmlParseError {
                detail: format!(
                    "flattened struct member {} does not begin with parent tag id {}",
                    self.tag_id, parent_tag_id
                ),
            });
        };
        if field_name.is_empty() {
            return Err(SchemaError::XmlParseError {
                detail: format!(
                    "flattened struct member {} has an empty field name",
                    self.tag_id
                ),
            });
        }

        // ExifTool propagates a plain `List` flag from a repeatable ancestor
        // onto every flattened descendant. The specific Bag/Seq/Alt flags,
        // however, describe the member itself and must be retained.
        let member_flags = self
            .flags
            .iter()
            .filter(|flag| flag.as_str() != "Flattened" && flag.as_str() != "List")
            .cloned()
            .collect::<Vec<_>>();
        let kind = derive_kind_for_tag(
            &self.group,
            &self.name,
            &self.type_attr,
            self.count.as_deref().and_then(|value| value.parse().ok()),
            &self.enum_options,
        );

        Ok(Some(StructMember {
            parent_tag_id: parent_tag_id.clone(),
            child_tag_id: self.tag_id.clone(),
            field_name: field_name.to_string(),
            kind: wrap_list_flag(kind, &member_flags),
        }))
    }

    fn finalize(self, id: SchemaDefinitionId) -> TagInfo {
        let kind = derive_kind_for_tag(
            &self.group,
            &self.name,
            &self.type_attr,
            self.count.as_deref().and_then(|value| value.parse().ok()),
            &self.enum_options,
        );
        let kind = wrap_list_flag(kind, &self.flags);
        TagInfo {
            id,
            group0: Some(self.group0),
            group: self.group,
            name: self.name,
            writable: self.writable,
            kind,
            description: self.description,
            storage_count: self.count,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct StructMember {
    parent_tag_id: String,
    child_tag_id: String,
    field_name: String,
    kind: TagKind,
}

pub(super) fn populate_struct_fields(
    finalized: &mut [(SchemaDefinitionId, TagInfo, Option<StructMember>)],
) -> Result<(), SchemaError> {
    let members = finalized
        .iter()
        .filter_map(|(_, _, member)| member.clone())
        .fold(
            BTreeMap::<String, Vec<StructMember>>::new(),
            |mut by_parent, member| {
                by_parent
                    .entry(member.parent_tag_id.clone())
                    .or_default()
                    .push(member);
                by_parent
            },
        );

    fn populate_kind(
        kind: &mut TagKind,
        owner_tag_id: &str,
        members: &BTreeMap<String, Vec<StructMember>>,
        visiting: &mut Vec<String>,
    ) -> Result<(), SchemaError> {
        match kind {
            TagKind::Bag(inner) | TagKind::Seq(inner) | TagKind::Alt(inner) => {
                populate_kind(inner, owner_tag_id, members, visiting)
            }
            TagKind::Struct(fields) => {
                if visiting.iter().any(|id| id == owner_tag_id) {
                    let mut cycle = visiting.clone();
                    cycle.push(owner_tag_id.to_string());
                    return Err(SchemaError::XmlParseError {
                        detail: format!("cyclic flattened struct schema: {}", cycle.join(" -> ")),
                    });
                }
                visiting.push(owner_tag_id.to_string());
                for member in members.get(owner_tag_id).into_iter().flatten() {
                    let mut member_kind = member.kind.clone();
                    populate_kind(&mut member_kind, &member.child_tag_id, members, visiting)?;
                    if let Some(previous) =
                        fields.insert(member.field_name.clone(), member_kind.clone())
                    {
                        return Err(SchemaError::XmlParseError {
                            detail: format!(
                                "duplicate field {} in flattened struct {}: {:?} and {:?}",
                                member.field_name, owner_tag_id, previous, member_kind
                            ),
                        });
                    }
                }
                visiting.pop();
                Ok(())
            }
            _ => Ok(()),
        }
    }

    for (id, info, _) in finalized {
        populate_kind(&mut info.kind, &id.tag_id, &members, &mut Vec::new())?;
    }
    Ok(())
}

pub(super) fn collect_attrs(e: &quick_xml::events::BytesStart) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let val = attr
            .unescape_value()
            .map(|s| s.into_owned())
            .unwrap_or_default();
        out.insert(key, val);
    }
    out
}

/// Map exiftool's `type` attribute plus `count` plus enum options to a TagKind.
///
/// exiftool type vocabulary (partial): `string`, `int8u`/`int16u`/`int32u`,
/// `int8s`/`int16s`/`int32s`, `int64u`, `float`, `double`, `rational32u`,
/// `rational64u`, `rational64s`, `boolean`, `date`, `date+`, `datetime`,
/// `lang-alt`, `struct`, `undef`, `?` (unknown).
///
/// `int*` and friends → Integer; rational → Rational; float/double → Real;
/// any date-flavoured type → DateTime; lang-alt → LangAlt; struct → Struct.
/// Struct fields are populated in a second pass from listx's flattened member
/// definitions and their explicit `struct="ParentTagId"` relationships.
///
/// Phase 8 fix-up: `date+` (multiple dates) and `datetime` (XMP-flavoured
/// alias used by some namespaces) were previously unrecognised and fell
/// through to `Unknown`, so write_args's DateTime → numeric arm and
/// metadata verification's DateTime epsilon never fired for them.
pub(super) fn derive_kind_for_tag(
    group: &str,
    name: &str,
    type_attr: &str,
    count: Option<u32>,
    options: &[EnumOption],
) -> TagKind {
    // XMP stores GPS coordinates using string/rational physical types, while
    // ExifTool's raw (`-n`) API exposes scalar decimal values. This applies
    // equally to top-level XMP-exif tags and flattened struct members such as
    // LocationCreatedGPSLatitude.
    if group.starts_with("XMP-")
        && (name.ends_with("GPSLatitude")
            || name.ends_with("GPSLongitude")
            || name.ends_with("GPSAltitude"))
    {
        return TagKind::Real;
    }
    if group == "ExifIFD"
        && matches!(
            name,
            "OffsetTime" | "OffsetTimeOriginal" | "OffsetTimeDigitized"
        )
    {
        return TagKind::TimeOffset;
    }
    if group == "IPTC" && type_attr == "digits" && count == Some(8) && name.contains("Date") {
        return TagKind::Date;
    }
    if group == "IPTC" && type_attr == "string" && count == Some(11) && name.contains("Time") {
        return TagKind::Time;
    }
    derive_kind(type_attr, count, options)
}

pub(super) fn derive_kind(type_attr: &str, _count: Option<u32>, options: &[EnumOption]) -> TagKind {
    let base = match type_attr {
        "string" => TagKind::Text,
        "lang-alt" => TagKind::LangAlt,
        "boolean" => TagKind::Boolean,
        // Every date-shaped type exiftool emits: bare `date`, `date+` (one
        // or more dates), and `datetime` (XMP variant).
        "date" | "date+" | "datetime" => TagKind::DateTime,
        "struct" => TagKind::Struct(BTreeMap::new()),
        "?" | "" | "undef" => TagKind::Unknown,
        "float" | "double" | "real" => TagKind::Real,
        s if s.starts_with("rational") => TagKind::Rational,
        s if s.starts_with("int") => TagKind::Integer {
            min: None,
            max: None,
        },
        _ => TagKind::Unknown,
    };

    // Enum overrides numeric/text base when value list present.
    if !options.is_empty() {
        let repr = match &base {
            TagKind::Integer { .. } => EnumRepr::Integer,
            _ => EnumRepr::String,
        };
        let kind = TagKind::Enum {
            repr,
            options: options.to_vec(),
        };
        return kind;
    }

    base
}

pub(super) fn wrap_list_flag(kind: TagKind, flags: &[String]) -> TagKind {
    if matches!(kind, TagKind::LangAlt) {
        return kind;
    }
    if flags.iter().any(|flag| flag == "Seq") {
        TagKind::Seq(Box::new(kind))
    } else if flags.iter().any(|flag| flag == "Alt") {
        TagKind::Alt(Box::new(kind))
    } else if flags.iter().any(|flag| flag == "Bag" || flag == "List") {
        TagKind::Bag(Box::new(kind))
    } else {
        kind
    }
}
