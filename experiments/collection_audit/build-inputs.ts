// Reuse the actual frontend projection, including effective output presence.
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { buildNormaliseItemForFile } from "../../src/utils/buildNormaliseItems";
import { KNOWN_METADATA_IDS as ID } from "../../src/metadata/knownIds";
import { installTagSchemaRegistry } from "../../src/tagSchemaRegistry";
import { filterGeneratedMetadataDestinationView } from "../../src/utils/generatedMetadataDestination";
import { buildEffectiveMetadataForFile } from "../../src/utils/effectiveMetadata";
import { resolveGps } from "../../src/utils/resolveGps";
import { metadataGet } from "../../src/utils/metadataCollection";
import type {
  MetadataOccurrence,
  NormaliseGroup,
  TagInfo,
} from "../../src/types";

interface RecordInput {
  relative_path: string;
  media_kind: string;
  extension: string;
  modified: number;
  created: number;
  occurrences: MetadataOccurrence[];
  native_dates: unknown[];
  alternative_gps: unknown[];
}

const out = process.argv[2];
installTagSchemaRegistry(
  JSON.parse(readFileSync(path.join(out, "schema.json"), "utf8")) as TagInfo[],
);
const groups: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "iptc_utf8",
  "location",
  "dates",
  "description",
  "title",
  "headline",
];
const presence = createWriteStream(path.join(out, "presence.jsonl"));
const items = createWriteStream(path.join(out, "items.jsonl"));
let count = 0;
for await (const line of createInterface({
  input: createReadStream(path.join(out, "occurrences.jsonl")),
  crlfDelay: Infinity,
})) {
  const record = JSON.parse(line) as RecordInput;
  const occurrences = record.occurrences;
  const item = buildNormaliseItemForFile(
    record.relative_path,
    groups,
    occurrences,
    undefined,
    { date_modified: record.modified, date_created: record.created },
  );
  const effective = buildEffectiveMetadataForFile(
    filterGeneratedMetadataDestinationView({
      occurrences,
      targetDrafts: undefined,
    }),
  );
  const dto = metadataGet(effective, ID.dateTimeOriginal);
  const primary = resolveGps(undefined, effective);
  const validGps =
    typeof primary.lat === "number" &&
    Number.isFinite(primary.lat) &&
    Math.abs(primary.lat) <= 90 &&
    typeof primary.lon === "number" &&
    Number.isFinite(primary.lon) &&
    Math.abs(primary.lon) <= 180 &&
    !(primary.lat === 0 && primary.lon === 0);
  const description = item.groupInputs.description!;
  const keywords = item.groupInputs.keywords!;
  const row = {
    relative_path: record.relative_path,
    media_kind: record.media_kind,
    extension: record.extension,
    primary_gps: validGps,
    alternative_gps: record.alternative_gps,
    date_time_original: dto?.kind === "DateTime",
    native_dates: record.native_dates,
    description: [
      description.description,
      description.imageDescription,
      description.captionAbstract,
    ].some((s) => !!s?.trim()),
    keywords: [
      ...keywords.hierarchicalSubject,
      ...keywords.dcSubject,
      ...keywords.iptcKeywords,
    ].some((s) => !!s.trim()),
    ai_description: !!description.aiDescription?.trim(),
  };
  if (!items.write(JSON.stringify(item) + "\n")) await once(items, "drain");
  if (!presence.write(JSON.stringify(row) + "\n"))
    await once(presence, "drain");
  count++;
}
items.end();
presence.end();
await Promise.all([once(items, "finish"), once(presence, "finish")]);
console.log(
  `Prepared ${count} files with the production frontend input builder`,
);
