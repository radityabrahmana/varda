/**
 * Build backend/data/kbli/kbli-2025.json from the KBLI annex (lampiran) as
 * published on Pasal.id. The source is Peraturan BPS No. 6 Tahun 2026, whose
 * annex restates the whole classification of Peraturan BPS No. 7 Tahun 2025
 * (KBLI 2025) with the 2026 changes applied: the consolidated current text.
 *
 * Usage (from backend/):
 *   npx tsx scripts/build-kbli-dataset.ts                 # fetch from Pasal.id (needs PASAL_MCP_TOKEN)
 *   npx tsx scripts/build-kbli-dataset.ts --from-text f   # parse an already downloaded annex text
 *   ... --out data/kbli/kbli-2025.json                    # default output path
 *
 * The fetch pages read_law(selector="lampiran") with a cursor and backs off on
 * Pasal.id's rate limit. The parse is deterministic, so the JSON is
 * reproducible from the saved text.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { callPasalTool } from "../src/lib/pasal";
import { parseKbliAnnex, type KbliSource } from "../src/lib/kbliParse";

const KBLI_LAW_ID = 650688; // Peraturan BPS 6/2026 on Pasal.id
const SOURCE: KbliSource = {
    regulation:
        "Lampiran Peraturan BPS No. 6 Tahun 2026 tentang Perubahan atas Peraturan BPS No. 7 Tahun 2025 tentang Klasifikasi Baku Lapangan Usaha Indonesia",
    edition: "KBLI 2025 (konsolidasi perubahan 2026)",
    pasal_law_id: KBLI_LAW_ID,
    url: "https://pasal.id/peraturan/perban/peraturan-bps-6-2026",
    fetched_at: new Date().toISOString().slice(0, 10),
};

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchAnnex(): Promise<string> {
    const parts: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
        const result = await callPasalTool("read_law", {
            law: KBLI_LAW_ID,
            selector: "lampiran",
            max_chars: 100_000,
            ...(cursor ? { cursor } : {}),
        });
        if (!result.ok) {
            if (result.kind === "rate_limit") {
                console.error(`rate limited after ${pages} pages; sleeping 65s`);
                await new Promise((r) => setTimeout(r, 65_000));
                continue;
            }
            throw new Error(result.error);
        }
        const payload = JSON.parse(result.text) as {
            error_code?: string;
            message?: string;
            sections?: { content_text?: string }[];
            next_cursor?: string | null;
            truncated?: boolean;
        };
        if (payload.error_code === "rate_limit") {
            console.error(`rate limited after ${pages} pages; sleeping 65s`);
            await new Promise((r) => setTimeout(r, 65_000));
            continue;
        }
        if (payload.error_code) throw new Error(`${payload.error_code}: ${payload.message ?? ""}`);
        for (const s of payload.sections ?? []) parts.push(s.content_text ?? "");
        pages += 1;
        if (pages % 10 === 0) console.error(`page ${pages}`);
        if (!payload.next_cursor || !payload.truncated) break;
        cursor = payload.next_cursor;
        await new Promise((r) => setTimeout(r, 1_300));
    }
    return parts.join("\n");
}

async function main() {
    const fromText = arg("--from-text");
    const out = resolve(process.cwd(), arg("--out") ?? "data/kbli/kbli-2025.json");
    const text = fromText ? readFileSync(resolve(process.cwd(), fromText), "utf8") : await fetchAnnex();
    const dataset = parseKbliAnnex(text, SOURCE);
    const counts = dataset.entries.reduce<Record<string, number>>((acc, e) => {
        acc[e.level] = (acc[e.level] ?? 0) + 1;
        return acc;
    }, {});
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(dataset));
    console.error(`wrote ${out}`);
    console.error(JSON.stringify({ entries: dataset.entries.length, ...counts, warnings: dataset.warnings.length }));
    for (const w of dataset.warnings.slice(0, 20)) console.error("  warn:", w);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
