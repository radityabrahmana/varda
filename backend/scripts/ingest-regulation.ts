/**
 * Load one regulation into the library from the command line (bulk seeding,
 * platform-wide rows). The web UI covers the everyday case; this is for
 * operators with the service-role key.
 *
 * Usage (from backend/, with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set):
 *   npx tsx scripts/ingest-regulation.ts \
 *     --file ~/kuhperdata.pdf --title "Kitab Undang-Undang Hukum Perdata" \
 *     --short-name KUHPerdata --type KUHPERDATA --year 1847 --platform
 *   npx tsx scripts/ingest-regulation.ts --file pm60.pdf --title "..." \
 *     --short-name "PM 60/2019" --type PERMEN --issuer "Kementerian Perhubungan" \
 *     --number "PM 60" --year 2019 --org <org uuid> [--status berlaku] [--source-url URL]
 *
 * Runs as a platform administrator: --platform creates a row every
 * organization sees; --org <uuid> creates it for that organization.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createServerSupabase } from "../src/lib/supabase";
import {
    attachRegulationFile,
    createRegulation,
    parseRegulationMetaBody,
    type RegulationScope,
} from "../src/modules/regulations/regulations.service";

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const file = arg("--file");
    if (!file) throw new Error("--file is required");
    const org = arg("--org");
    const platform = process.argv.includes("--platform");
    if (!org && !platform) throw new Error("pass --org <uuid> or --platform");

    const meta = parseRegulationMetaBody({
        scope: platform ? "platform" : "org",
        org_id: org,
        title: arg("--title"),
        short_name: arg("--short-name"),
        regulation_type: arg("--type"),
        issuer: arg("--issuer"),
        number: arg("--number"),
        year: arg("--year"),
        status: arg("--status"),
        source_url: arg("--source-url"),
        notes: arg("--notes"),
    });
    if (!meta.ok) throw new Error(meta.kind === "error" ? String(meta.error) : meta.detail);

    const db = createServerSupabase();
    const scope: RegulationScope = {
        userId: arg("--user") ?? "00000000-0000-4000-8000-000000000000",
        orgIds: org ? [org] : [],
        adminOrgIds: org ? [org] : [],
        platformAdmin: true,
    };
    const created = await createRegulation(db, scope, meta.data);
    if (!created.ok) throw new Error(created.kind === "error" ? String(created.error) : created.detail);
    console.error(`created ${created.data.id} (${created.data.short_name})`);

    const path = resolve(process.cwd(), file);
    const attached = await attachRegulationFile(db, scope, created.data.id, { buffer: readFileSync(path), filename: basename(path) });
    if (!attached.ok) throw new Error(attached.kind === "error" ? String(attached.error) : attached.detail);
    const r = attached.data;
    console.error(JSON.stringify({ id: r.id, short_name: r.short_name, parse_status: r.parse_status, nodes: r.node_count, pasal: r.pasal_count, warnings: r.parse_warnings.length }));
    for (const w of r.parse_warnings.slice(0, 15)) console.error("  warn:", w);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
