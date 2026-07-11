import os
import sys
import subprocess
import json
import glob
import re
from tools.analyse_exiftool_schema_identity import compare_definitions, classify_group, get_list_shape, normalize_type, is_numeric, classify_tag_id, make_tag_id_key

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

def run_exiftool_on_fixtures():
    # Find all fixture files in test_images
    fixtures = []
    for ext in ['*.jpg', '*.png', '*.tiff', '*.bmp']:
        fixtures.extend(glob.glob(os.path.join('test_images', ext)))
        
    print(f"Found {len(fixtures)} fixture files for runtime tests.")
    
    results = {}
    for fpath in fixtures:
        fname = os.path.basename(fpath)
        
        # Pass 1: formatted + ID
        cmd1 = ["exiftool", "-charset", "filename=utf8", "-a", "-G1", "-D", "-s", "-j", fpath]
        res1 = subprocess.run(cmd1, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        if res1.returncode != 0:
            print(f"Error running cmd1 on {fname}: {res1.stderr.strip()}")
            continue
        try:
            data1 = json.loads(res1.stdout)[0]
        except Exception as e:
            print(f"Failed to parse cmd1 output for {fname}: {e}")
            continue
            
        # Pass 2: raw values
        cmd2 = ["exiftool", "-charset", "filename=utf8", "-a", "-G1", "-D", "-n", "-s", "-j", fpath]
        res2 = subprocess.run(cmd2, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        if res2.returncode != 0:
            print(f"Error running cmd2 on {fname}: {res2.stderr.strip()}")
            continue
        try:
            data2 = json.loads(res2.stdout)[0]
        except Exception as e:
            print(f"Failed to parse cmd2 output for {fname}: {e}")
            continue
            
        # Pass 3: group families G0:2:5:6 (collapse-free, with -D)
        cmd3 = ["exiftool", "-charset", "filename=utf8", "-a", "-G0:2:5:6", "-D", "-s", "-j", fpath]
        res3 = subprocess.run(cmd3, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        if res3.returncode != 0:
            print(f"Error running cmd3 on {fname}: {res3.stderr.strip()}")
            continue
        try:
            data3 = json.loads(res3.stdout)[0]
        except Exception as e:
            print(f"Failed to parse cmd3 output for {fname}: {e}")
            continue
            
        tags = []
        file_context = {}
        
        for k1, v1 in data1.items():
            if k1 in ('SourceFile', 'ExifToolVersion', 'ExifTool:ExifToolVersion'):
                continue
                
            parts1 = k1.split(':')
            g1 = parts1[0]
            tag_name = parts1[1]
            
            tag_id = v1.get("id") if isinstance(v1, dict) else None
            formatted_val = v1.get("val") if isinstance(v1, dict) else v1
            
            # Find matching raw value from data2
            raw_val = None
            if k1 in data2:
                v2 = data2[k1]
                raw_val = v2.get("val") if isinstance(v2, dict) else v2
                
            # Align with data3 to get G0, G2, G5, G6
            match_k3 = None
            # Pass 1: Try with G1 substring match
            for k3, v3 in data3.items():
                if k3.endswith(':' + tag_name):
                    v3_id = v3.get('id') if isinstance(v3, dict) else None
                    if str(v3_id) == str(tag_id):
                        if g1.lower() in k3.lower() or (g1 == 'IFD1' and 'ifd1' in k3.lower()) or (g1 == 'IFD0' and 'ifd0' in k3.lower()):
                            match_k3 = k3
                            break
            # Pass 2: Fall back to pure TagName + TagID
            if not match_k3:
                for k3, v3 in data3.items():
                    if k3.endswith(':' + tag_name):
                        v3_id = v3.get('id') if isinstance(v3, dict) else None
                        if str(v3_id) == str(tag_id):
                            match_k3 = k3
                            break
                            
            g0, g2, g5, g6 = None, None, None, None
            if match_k3:
                parts3 = match_k3.split(':')
                groups3 = parts3[:-1]
                if len(groups3) >= 1:
                    g0 = groups3[0]
                if len(groups3) >= 2:
                    g2 = groups3[1]
                if len(groups3) >= 3:
                    g5 = groups3[2]
                if len(groups3) >= 4:
                    g6 = groups3[3]
                    
            tag_obj = {
                "tag_name": tag_name,
                "g0": g0,
                "g1": g1,
                "g2": g2,
                "g5": g5,
                "g6": g6,
                "tag_id": tag_id,
                "raw_val": raw_val,
                "formatted_val": formatted_val
            }
            tags.append(tag_obj)
            
            # File context keys
            if tag_name == 'FileType':
                file_context['file_type'] = raw_val
            elif tag_name == 'MIMEType':
                file_context['mime_type'] = raw_val
            elif tag_name == 'Make':
                file_context['make'] = raw_val
            elif tag_name == 'Model':
                file_context['model'] = raw_val
                
        results[fname] = {
            "tags": tags,
            "context": file_context
        }
        
    return results

def normalize_id(tag_id):
    if tag_id is None or tag_id == "":
        return None
    tag_id_str = str(tag_id).strip()
    m = re.match(r'^(.+?)-[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$', tag_id_str)
    if m:
        tag_id_str = m.group(1)
    if tag_id_str.startswith('0x') or tag_id_str.startswith('0X'):
        try:
            return str(int(tag_id_str, 16))
        except ValueError:
            pass
    try:
        return str(int(tag_id_str))
    except ValueError:
        pass
    return tag_id_str.lower()

def clean_tag_name(name):
    m = re.match(r'^(.+?)-[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$', name)
    if m:
        return m.group(1)
    return name

def g1_equivalent(g1_static, g1_runtime):
    if g1_static == g1_runtime:
        return True
    if {g1_static, g1_runtime} == {'IFD0', 'IFD1'}:
        return True
    return False

def g5_matches(g5, static_def):
    if not g5:
        return True
    g5_clean = g5.lower().replace('-', '_').replace('::', '_')
    g1_clean = static_def['g1'].lower().replace('-', '_')
    table_clean = static_def['table_name'].lower().replace('-', '_').replace('::', '_')
    
    # Generic groups match anything
    if g1_clean in ('file', 'system', 'exiftool'):
        return True
        
    # XMP namespace matching
    if 'xmp' in g1_clean and 'xmp' in g5_clean:
        return True
        
    # Standard G1 substring matching
    if g1_clean in g5_clean or g5_clean in g1_clean:
        return True
        
    # IFD0/IFD1/EXIFIFD equivalences
    if 'ifd0' in g1_clean and 'ifd0' in g5_clean:
        return True
    if 'ifd1' in g1_clean and 'ifd1' in g5_clean:
        return True
    if 'exififd' in g1_clean and 'exififd' in g5_clean:
        return True
        
    table_parts = table_clean.split('_')
    for part in table_parts:
        if part in ('main', 'info', 'header', 'tags', 'other', 'exif', 'gps', 'xmp'):
            continue
        if len(part) >= 3 and part in g5_clean:
            return True
            
    return False

MAKERS = {
    'Canon': ['canon'],
    'Nikon': ['nikon'],
    'Sony': ['sony'],
    'Panasonic': ['panasonic'],
    'Pentax': ['pentax'],
    'Olympus': ['olympus'],
    'Fujifilm': ['fuji'],
    'Kodak': ['kodak'],
    'Samsung': ['samsung'],
    'Sigma': ['sigma'],
    'Minolta': ['minolta'],
    'Casio': ['casio'],
    'Garmin': ['garmin'],
    'Apple': ['apple'],
    'Google': ['google']
}

def format_context_matches(file_context, static_def):
    table_name = static_def['table_name']
    table_prefix = table_name.split('::')[0]
    
    # Skip maker notes
    if any(table_name.startswith(f"{maker}::") for maker in MAKERS):
        return True
        
    file_type = (file_context.get('file_type') or '').lower()
    
    FORMAT_MAP = {
        'BMP': ['bmp'],
        'WavPack': ['wav', 'wv'],
        'ASF': ['asf', 'wmv', 'wma'],
        'PNG': ['png'],
        'GIF': ['gif'],
        'JPEG': ['jpeg', 'jpg'],
        'TIFF': ['tiff', 'tif'],
        'FLAC': ['flac'],
        'MP3': ['mp3'],
        'ID3': ['mp3', 'mp4'],
        'QuickTime': ['mov', 'mp4'],
        'ZIP': ['zip'],
        'PDF': ['pdf']
    }
    
    if table_prefix in FORMAT_MAP:
        expected_types = FORMAT_MAP[table_prefix]
        return any(t in file_type for t in expected_types)
        
    return True

def maker_context_matches(file_context, static_def):
    table_name = static_def['table_name']
    for maker, keywords in MAKERS.items():
        if table_name.startswith(f"{maker}::"):
            make = (file_context.get('make') or '').lower()
            model = (file_context.get('model') or '').lower()
            return any(kw in make or kw in model for kw in keywords)
    return True

def raw_value_matches(raw_val, static_def):
    if not static_def['enum_options']:
        return True
    codes = set(o['code'] for o in static_def['enum_options'])
    return str(raw_val) in codes

def classify_matches(matches):
    if not matches:
        return 'no_match'
    if len(matches) == 1:
        return 'unique'
        
    all_exact = True
    for i in range(len(matches)):
        for j in range(i + 1, len(matches)):
            rel = compare_definitions(matches[i], matches[j])
            if rel == 'conflicting':
                return 'conflicting'
                
    return 'compatible'

def main():
    # Load data
    with open('schema-definitions.json', 'r', encoding='utf-8') as f:
        static_defs = json.load(f)
    with open('schema-conflicts-after-tag-id.json', 'r', encoding='utf-8') as f:
        static_conflicts = json.load(f)
        
    defs_by_name = {}
    for d in static_defs:
        defs_by_name.setdefault(d['tag_name'], []).append(d)
        
    # Get runtime tag extraction results
    fixtures_output = run_exiftool_on_fixtures()
    
    # Metrics
    stages = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]
    stage_stats = {s: {"unique": 0, "compatible": 0, "conflicting": 0, "no_match": 0} for s in stages}
    
    total_occurrences = 0
    tested_conflict_keys = set()
    no_match_cases = []
    progression_traces = []
    
    exact_table_resolutions = 0
    semantic_only_resolutions = 0
    
    for fname, data in fixtures_output.items():
        tags = data["tags"]
        file_context = data["context"]
        
        for t in tags:
            tag_name = t["tag_name"]
            g0 = t["g0"]
            g1 = t["g1"]
            g2 = t["g2"]
            g5 = t["g5"]
            g6 = t["g6"]
            tag_id = t["tag_id"]
            raw_val = t["raw_val"]
            
            if tag_name in ('FileType', 'MIMEType'):
                continue
                
            total_occurrences += 1
            
            cleaned_name = clean_tag_name(tag_name)
            candidates = defs_by_name.get(cleaned_name, [])
            
            # Check if this occurrence belongs to a static G1:Name:TagID conflict
            is_static_conflict = False
            for sc_key, sc_val in static_conflicts.items():
                if sc_val['effective_g1'] == g1 and sc_val['tag_name'] == cleaned_name:
                    parsed_runtime_id = classify_tag_id(tag_id)
                    runtime_id_key = make_tag_id_key(parsed_runtime_id)
                    sc_id_key = make_tag_id_key(sc_val['parsed_tag_id'])
                    if sc_id_key == runtime_id_key:
                        is_static_conflict = True
                        tested_conflict_keys.add(sc_key)
                        break
                        
            # Resolver Stage 1 (G1 + TagName + TagID)
            matches_r1 = [d for d in candidates if g1_equivalent(d['g1'], g1) and normalize_id(d['tag_id']) == normalize_id(tag_id)]
            res_r1 = classify_matches(matches_r1)
            stage_stats["R1"][res_r1] += 1
            
            # Resolver Stage 2 (R1 + G0 + G2)
            matches_r2 = [d for d in matches_r1 if d['g0'] == g0 and d['g2'] == g2]
            # Fall back to matches_r1 if this filter leaves us with nothing (prevent false negatives)
            if not matches_r2 and matches_r1:
                matches_r2 = matches_r1
            res_r2 = classify_matches(matches_r2)
            stage_stats["R2"][res_r2] += 1
            
            # Resolver Stage 3 (R2 + Family 6 type)
            matches_r3 = matches_r2
            if g6:
                matches_r3 = [d for d in matches_r2 if normalize_type(d['tag_type']) == normalize_type(g6)]
                if not matches_r3 and matches_r2:
                    matches_r3 = matches_r2
            res_r3 = classify_matches(matches_r3)
            stage_stats["R3"][res_r3] += 1
            
            # Resolver Stage 4 (R3 + Family 5 path)
            # Only filter by Family 5 if there is ambiguity (more than 1 candidate remaining)
            if len(matches_r3) > 1:
                matches_r4 = [d for d in matches_r3 if g5_matches(g5, d)]
                if not matches_r4:
                    matches_r4 = matches_r3
            else:
                matches_r4 = matches_r3
            res_r4 = classify_matches(matches_r4)
            stage_stats["R4"][res_r4] += 1
            
            # Resolver Stage 5 (R4 + Format File Context)
            if len(matches_r4) > 1:
                matches_r5 = [d for d in matches_r4 if format_context_matches(file_context, d)]
                if not matches_r5:
                    matches_r5 = matches_r4
            else:
                matches_r5 = matches_r4
            res_r5 = classify_matches(matches_r5)
            stage_stats["R5"][res_r5] += 1
            
            # Resolver Stage 6 (R5 + Maker Notes Context)
            if len(matches_r5) > 1:
                matches_r6 = [d for d in matches_r5 if maker_context_matches(file_context, d)]
                if not matches_r6:
                    matches_r6 = matches_r5
            else:
                matches_r6 = matches_r5
            res_r6 = classify_matches(matches_r6)
            stage_stats["R6"][res_r6] += 1
            
            # Resolver Stage 7 (R6 + raw value shape)
            if len(matches_r6) > 1:
                matches_r7 = [d for d in matches_r6 if raw_value_matches(raw_val, d)]
                if not matches_r7:
                    matches_r7 = matches_r6
            else:
                matches_r7 = matches_r6
            res_r7 = classify_matches(matches_r7)
            stage_stats["R7"][res_r7] += 1
            
            # Record progression trace for static conflicts
            if is_static_conflict:
                progression_traces.append({
                    "file": fname,
                    "tag_name": tag_name,
                    "g1": g1,
                    "tag_id": tag_id,
                    "raw_val": raw_val,
                    "stages": {
                        "R1": {"count": len(matches_r1), "status": res_r1},
                        "R2": {"count": len(matches_r2), "status": res_r2},
                        "R3": {"count": len(matches_r3), "status": res_r3},
                        "R4": {"count": len(matches_r4), "status": res_r4},
                        "R5": {"count": len(matches_r5), "status": res_r5},
                        "R6": {"count": len(matches_r6), "status": res_r6},
                        "R7": {"count": len(matches_r7), "status": res_r7}
                    },
                    "final_matches": [{"table": m['table_name'], "writable": m['writable'], "type": m['tag_type']} for m in matches_r7]
                })
                
            # Log no-matches
            if res_r7 == 'no_match':
                no_match_cases.append({
                    "file": fname,
                    "key": f"{g1}:{tag_name}",
                    "g0": g0,
                    "g2": g2,
                    "tag_id": tag_id,
                    "raw_val": raw_val
                })
                
            # Final stats counting
            if res_r7 == 'unique':
                exact_table_resolutions += 1
            elif res_r7 == 'compatible':
                semantic_only_resolutions += 1
                
    # Print results
    print("\n--- RESOLVER STAGE PERFORMANCE ---")
    for s in stages:
        print(f"Stage {s} stats:")
        for status, count in stage_stats[s].items():
            pct = (count / total_occurrences) * 100 if total_occurrences > 0 else 0
            print(f"  {status}: {count} ({pct:.1f}%)")
            
    print("\n--- DETAILED CONFLICT RESOLUTION PROGRESSION TRACES ---")
    for pt in progression_traces:
        print(f"\nConflict occurrence: {pt['g1']}:{pt['tag_name']} (ID: {pt['tag_id']}) in {pt['file']}")
        print(f"  Observed Raw Value: {pt['raw_val']}")
        for s in stages:
            st = pt["stages"][s]
            print(f"  Stage {s} -> candidates remaining: {st['count']}, status: {st['status']}")
        print(f"  Final matched static tables: {[m['table'] for m in pt['final_matches']]}")
        
    print("\n--- SUMMARY OF METRICS ---")
    print(f"Total occurrences analysed: {total_occurrences}")
    print(f"Static conflict groups tested with real files: {len(tested_conflict_keys)}")
    print(f"Static conflict groups not tested: {len(static_conflicts) - len(tested_conflict_keys)}")
    print(f"Exact table resolutions (unique matches): {exact_table_resolutions}")
    print(f"Semantic-only resolutions (compatible matches): {semantic_only_resolutions}")
    print(f"Ambiguous occurrences remaining (conflicting matches): {stage_stats['R7']['conflicting']}")
    print(f"No-match occurrences: {len(no_match_cases)}")
    for nm in no_match_cases:
        print(f"  No-match: {nm['key']} (ID: {nm['tag_id']}) in {nm['file']} (G0: {nm['g0']}, G2: {nm['g2']})")

if __name__ == '__main__':
    main()
