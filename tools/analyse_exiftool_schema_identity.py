import os
import sys
import json
import xml.etree.ElementTree as ET

def classify_tag_id(tag_id, table_name=None):
    if tag_id is None or tag_id == "":
        return {"kind": "empty", "value": ""}
    tag_id_str = str(tag_id).strip()
    
    # Check if generated (Extra or Composite table)
    if table_name and (table_name.startswith("Composite") or table_name.startswith("Extra")):
        return {"kind": "generated", "value": tag_id_str}
        
    if tag_id_str.startswith('0x') or tag_id_str.startswith('0X'):
        return {"kind": "hex", "value": tag_id_str}
        
    # Check if numeric
    try:
        val = int(tag_id_str)
        return {"kind": "numeric", "value": val}
    except ValueError:
        pass
        
    # Check if symbolic (has punctuation/special chars)
    special_chars = ['.', ',', '{', '}', '[', ']', '/', '\\', '?', '*', '#', '@', '$', '%', '^', '&', '(', ')']
    if any(c in tag_id_str for c in special_chars):
        return {"kind": "symbolic", "value": tag_id_str}
        
    return {"kind": "text", "value": tag_id_str}

def make_tag_id_key(parsed_id):
    kind = parsed_id["kind"]
    val = parsed_id["value"]
    if kind == "hex":
        try:
            int_val = int(val, 16)
            return f"numeric:{int_val}"
        except ValueError:
            pass
    return f"{kind}:{val}"

def parse_listx(xml_path):
    print(f"Parsing {xml_path}...")
    tree = ET.parse(xml_path)
    root = tree.getroot()
    
    definitions = []
    
    for table_elem in root.findall('table'):
        table_name = table_elem.attrib.get('name')
        # Find table description (lang=en)
        table_desc_elem = table_elem.find("desc[@lang='en']")
        if table_desc_elem is None:
            table_desc_elem = table_elem.find("desc")
        table_desc = table_desc_elem.text if table_desc_elem is not None else None
        
        table_g0 = table_elem.attrib.get('g0')
        table_g1 = table_elem.attrib.get('g1')
        table_g2 = table_elem.attrib.get('g2')
        
        for tag_elem in table_elem.findall('tag'):
            # Group overrides
            g0 = tag_elem.attrib.get('g0', table_g0)
            g1 = tag_elem.attrib.get('g1', table_g1)
            g2 = tag_elem.attrib.get('g2', table_g2)
            
            tag_id = tag_elem.attrib.get('id')
            tag_name = tag_elem.attrib.get('name')
            tag_type = tag_elem.attrib.get('type')
            count = tag_elem.attrib.get('count')
            flags = tag_elem.attrib.get('flags')
            writable = tag_elem.attrib.get('writable') == 'true'
            
            # Enum options
            enum_options = []
            values_elem = tag_elem.find('values')
            if values_elem is not None:
                for key_elem in values_elem.findall('key'):
                    code = key_elem.attrib.get('id')
                    val_elem = key_elem.find("val[@lang='en']")
                    if val_elem is None:
                        val_elem = key_elem.find("val")
                    label = val_elem.text if val_elem is not None else ""
                    enum_options.append({"code": code, "label": label})
            
            # Tag description
            desc_elem = tag_elem.find("desc[@lang='en']")
            if desc_elem is None:
                desc_elem = tag_elem.find("desc")
            desc = desc_elem.text if desc_elem is not None else None
            
            # App key
            g1_tag_name = f"{g1}:{tag_name}"
            
            parsed_id = classify_tag_id(tag_id, table_name)
            
            definitions.append({
                "table_name": table_name,
                "table_desc": table_desc,
                "g0": g0,
                "g1": g1,
                "g2": g2,
                "tag_id": tag_id,
                "parsed_tag_id": parsed_id,
                "tag_name": tag_name,
                "tag_type": tag_type,
                "count": count,
                "flags": flags,
                "writable": writable,
                "enum_options": enum_options,
                "desc": desc,
                "g1_tag_name": g1_tag_name
            })
            
    print(f"Parsed {len(definitions)} tag definitions.")
    return definitions

def get_list_shape(flags_str):
    if not flags_str:
        return None
    flags_list = [f.strip() for f in flags_str.split(',')]
    list_flags = [f for f in flags_list if f in ('List', 'Bag', 'Seq', 'Alt')]
    if not list_flags:
        return None
    return sorted(list_flags)

def normalize_type(tag_type):
    if not tag_type:
        return "unknown"
    if tag_type.startswith("string"):
        return "string"
    return tag_type

NUMERIC_TYPES = {
    'int8u', 'int8s', 'int16u', 'int16s', 'int32u', 'int32s', 'int64u', 'int64s',
    'integer', 'float', 'double', 'real', 'rational'
}

def is_numeric(tag_type):
    return tag_type in NUMERIC_TYPES

def compare_definitions(d1, d2):
    """
    Returns 'exact', 'compatible', or 'conflicting'
    """
    if d1['writable'] != d2['writable']:
        return 'conflicting'
        
    if get_list_shape(d1['flags']) != get_list_shape(d2['flags']):
        return 'conflicting'
        
    has_enum1 = len(d1['enum_options']) > 0
    has_enum2 = len(d2['enum_options']) > 0
    if has_enum1 != has_enum2:
        return 'conflicting'
        
    if has_enum1 and has_enum2:
        opts1 = sorted(d1['enum_options'], key=lambda x: x['code'])
        opts2 = sorted(d2['enum_options'], key=lambda x: x['code'])
        if opts1 != opts2:
            return 'conflicting'
            
    type1 = normalize_type(d1['tag_type'])
    type2 = normalize_type(d2['tag_type'])
    
    if type1 == type2:
        if d1['flags'] == d2['flags']:
            return 'exact'
        else:
            return 'compatible'
            
    if is_numeric(type1) and is_numeric(type2):
        return 'compatible'
        
    return 'conflicting'

def classify_group(group_defs):
    if len(group_defs) <= 1:
        return 'unique'
        
    all_exact = True
    for i in range(len(group_defs)):
        for j in range(i + 1, len(group_defs)):
            rel = compare_definitions(group_defs[i], group_defs[j])
            if rel == 'conflicting':
                return 'conflicting'
            if rel == 'compatible':
                all_exact = False
                
    if all_exact:
        return 'exact'
    else:
        return 'compatible'

def get_conflict_reason(defs):
    reasons = []
    
    writables = set(d['writable'] for d in defs)
    if len(writables) > 1:
        reasons.append("different writability")
        
    list_shapes = set(tuple(get_list_shape(d['flags']) or []) for d in defs)
    if len(list_shapes) > 1:
        has_scalar = any(len(s) == 0 for s in list_shapes)
        has_list = any(len(s) > 0 for s in list_shapes)
        if has_scalar and has_list:
            reasons.append("scalar versus list")
        else:
            reasons.append("different list semantics")
            
    enums = [len(d['enum_options']) > 0 for d in defs]
    if len(set(enums)) > 1:
        reasons.append("enum versus non-enum")
    elif any(enums):
        opt_sets = []
        for d in defs:
            opts = sorted([(o['code'], o['label']) for o in d['enum_options']])
            opt_sets.append(tuple(opts))
        if len(set(opt_sets)) > 1:
            reasons.append("different enum mappings")
            
    types = set(normalize_type(d['tag_type']) for d in defs)
    if len(types) > 1:
        has_numeric = any(is_numeric(t) for t in types)
        has_text = any(t == "string" for t in types)
        if has_numeric and has_text:
            reasons.append("text versus numeric")
        elif any(t == "struct" for t in types):
            reasons.append("different struct shape")
        else:
            reasons.append("different storage types")
            
    if not reasons:
        reasons.append("other semantic conflict")
        
    return "; ".join(reasons)

MAKERS = {'Canon', 'Nikon', 'Sony', 'Panasonic', 'Pentax', 'Olympus', 'Fujifilm', 'Kodak', 'Samsung', 'Sigma', 'Minolta', 'Casio', 'Garmin', 'Apple', 'Google'}

def classify_conflict_category(g1, tag_name, defs, reason):
    if reason == "different writability":
        return "writability-only conflicts"
        
    is_composite = any(d['table_name'].startswith("Composite") or d['table_name'].startswith("Extra") for d in defs)
    if is_composite:
        return "composite/generated-tag conflicts"
        
    is_makernote = any(any(m in d['table_name'] for m in MAKERS) for d in defs)
    if is_makernote:
        return "maker-note conflicts"
        
    format_prefixes = {"BMP", "WavPack", "ASF", "PNG", "GIF", "JPEG", "TIFF", "FLAC", "MP3", "ID3", "QuickTime", "ZIP", "PDF", "File"}
    is_format_level = any(d['table_name'].split('::')[0] in format_prefixes for d in defs)
    if is_format_level:
        return "format-level conflicts"
        
    prefixes = set(d['table_name'].split('::')[0] for d in defs)
    if len(prefixes) == 1:
        return "same-format alternative table conflicts"
        
    return "other"

def check_separator(defs, key_fn):
    subgroups = {}
    for d in defs:
        subgroups.setdefault(key_fn(d), []).append(d)
    for sub in subgroups.values():
        if len(sub) > 1 and classify_group(sub) == 'conflicting':
            return False
    return True

def main():
    xml_path = "listx.xml"
    if not os.path.exists(xml_path):
        print(f"Error: {xml_path} not found. Run exiftool first.")
        sys.exit(1)
        
    definitions = parse_listx(xml_path)
    
    # Save parsed definitions
    with open("schema-definitions.json", "w", encoding="utf-8") as f:
        json.dump(definitions, f, indent=2)
        
    # Group by G1:Name
    groups_g1_name = {}
    for d in definitions:
        groups_g1_name.setdefault(d['g1_tag_name'], []).append(d)
        
    # Group by G1:Name:TagID
    groups_g1_name_id = {}
    for d in definitions:
        id_key = make_tag_id_key(d['parsed_tag_id'])
        key = f"{d['g1']}:{d['tag_name']}:{id_key}"
        groups_g1_name_id.setdefault(key, []).append(d)
        
    # Stats for G1:Name
    stats_g1_name = {
        "total_definitions": len(definitions),
        "unique_keys": len(groups_g1_name),
        "duplicate_groups": 0,
        "exact_groups": 0,
        "compatible_groups": 0,
        "conflicting_groups": 0
    }
    for key, group_defs in groups_g1_name.items():
        cls = classify_group(group_defs)
        if cls != 'unique':
            stats_g1_name["duplicate_groups"] += 1
            if cls == 'exact':
                stats_g1_name["exact_groups"] += 1
            elif cls == 'compatible':
                stats_g1_name["compatible_groups"] += 1
            elif cls == 'conflicting':
                stats_g1_name["conflicting_groups"] += 1

    # Stats for G1:Name:TagID
    stats_g1_name_id = {
        "total_definitions": len(definitions),
        "unique_keys": len(groups_g1_name_id),
        "duplicate_groups": 0,
        "exact_groups": 0,
        "compatible_groups": 0,
        "conflicting_groups": 0
    }
    for key, group_defs in groups_g1_name_id.items():
        cls = classify_group(group_defs)
        if cls != 'unique':
            stats_g1_name_id["duplicate_groups"] += 1
            if cls == 'exact':
                stats_g1_name_id["exact_groups"] += 1
            elif cls == 'compatible':
                stats_g1_name_id["compatible_groups"] += 1
            elif cls == 'conflicting':
                stats_g1_name_id["conflicting_groups"] += 1

    # Resolve mapping check: for each of the conflicting G1:Name groups, check how they split under TagID
    resolved_by_id = 0
    compatible_by_id = 0
    still_conflicting_by_id = 0
    
    for key, group_defs in groups_g1_name.items():
        cls = classify_group(group_defs)
        if cls == 'conflicting':
            # Split by ID
            subgroups = {}
            for d in group_defs:
                id_key = make_tag_id_key(d['parsed_tag_id'])
                subgroups.setdefault(id_key, []).append(d)
                
            sub_classes = [classify_group(sub) for sub in subgroups.values()]
            if all(cls == 'unique' for cls in sub_classes):
                resolved_by_id += 1
            elif any(cls == 'conflicting' for cls in sub_classes):
                still_conflicting_by_id += 1
            else:
                compatible_by_id += 1
                
    print("\n--- G1 + Name Statistics ---")
    for k, v in stats_g1_name.items():
        print(f"{k}: {v}")
        
    print("\n--- G1 + Name + TagID Statistics ---")
    for k, v in stats_g1_name_id.items():
        print(f"{k}: {v}")
        
    print("\n--- G1 + Name Conflict Resolution by TagID ---")
    print(f"Conflicting G1:Name groups fully resolved to unique: {resolved_by_id}")
    print(f"Conflicting G1:Name groups reduced to compatible: {compatible_by_id}")
    print(f"Conflicting G1:Name groups still conflicting: {still_conflicting_by_id}")

    # Phase 2 & 3: List every remaining conflicting group and find separators
    conflicts_after_id = {}
    for key, group_defs in groups_g1_name_id.items():
        cls = classify_group(group_defs)
        if cls == 'conflicting':
            g1 = group_defs[0]['g1']
            name = group_defs[0]['tag_name']
            tag_id = group_defs[0]['tag_id']
            reason = get_conflict_reason(group_defs)
            category = classify_conflict_category(g1, name, group_defs, reason)
            
            # Separation matrix checks
            g0_sep = check_separator(group_defs, lambda d: d['g0'])
            g2_sep = check_separator(group_defs, lambda d: d['g2'])
            type_sep = check_separator(group_defs, lambda d: d['tag_type'])
            writable_sep = check_separator(group_defs, lambda d: d['writable'])
            flags_sep = check_separator(group_defs, lambda d: d['flags'])
            enum_sep = check_separator(group_defs, lambda d: str(sorted([(o['code'], o['label']) for o in d['enum_options']])))
            
            # Table name check
            table_sep = check_separator(group_defs, lambda d: d['table_name'])
            
            # Requires table identity if all runtime fields together cannot separate
            # The runtime fields we evaluate are: G0, G2, tag_type, flags, enum options
            # If grouping by all these simultaneously still leaves conflicting subgroups:
            runtime_combo_sep = check_separator(group_defs, lambda d: (
                d['g0'], d['g2'], normalize_type(d['tag_type']), get_list_shape(d['flags']),
                tuple(sorted([(o['code'], o['label']) for o in d['enum_options']]))
            ))
            requires_table_identity = not runtime_combo_sep
            
            conflicts_after_id[key] = {
                "effective_g1": g1,
                "tag_name": name,
                "tag_id": tag_id,
                "parsed_tag_id": group_defs[0]['parsed_tag_id'],
                "category": category,
                "conflict_reason": reason,
                "separators": {
                    "g0_separates": g0_sep,
                    "g2_separates": g2_sep,
                    "type_separates": type_sep,
                    "writable_separates": writable_sep,
                    "flags_separates": flags_sep,
                    "enum_mapping_separates": enum_sep,
                    "requires_table_identity": requires_table_identity
                },
                "definitions": group_defs
            }
            
    with open("schema-conflicts-after-tag-id.json", "w", encoding="utf-8") as f:
        json.dump(conflicts_after_id, f, indent=2)
        
    print(f"\nRemaining conflicting G1:Name:TagID groups: {len(conflicts_after_id)}")

if __name__ == '__main__':
    main()
