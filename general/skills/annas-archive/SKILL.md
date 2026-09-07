---
name: annas-archive
description: Access Anna's Archive data, torrents, and metadata. Use when the user asks about Anna's Archive, wants to find books/papers/files, download torrent lists, access bulk data, or needs current mirror domains.
allowed-tools: Bash, Read, Grep, WebSearch, WebFetch
---

# Anna's Archive

Anna's Archive is a shadow library and search engine aggregating data from Library Genesis, Sci-Hub, Z-Library, Open Library, and others. It provides bulk open data access to metadata and files via torrents.

## Domains and Mirrors

Anna's Archive domains are frequently suspended due to legal action. **Domains go down regularly.**

### Finding Current Mirrors

1. **Check Wikipedia first**: The Anna's Archive Wikipedia page is kept up-to-date with working domains by the community.
2. **Reddit**: Search `r/Annas_Archive` for current domain announcements.
3. **Web search**: Search for "Anna's Archive working domain" with the current year.

### Known Domains (check status before relying on any)

| Domain | Notes |
|--------|-------|
| `annas-archive.li` | Primary domain as of late 2024 |
| `annas-archive.gl` | Mirror |
| `annas-archive.pm` | Added after .org suspension |
| `annas-archive.se` | Suspended Jan 2026 |
| `annas-archive.org` | Suspended Jan 2026 |
| `annas-archive.gs` | Suspended Jul 2024 |

**Always try multiple domains** if one doesn't respond.

## API Endpoints (all verified working)

All endpoints are under `https://annas-archive.li/dyn/`. No auth needed unless noted.

### Torrents

**`/dyn/torrents.json`** — Full torrent listing (~18k entries, ~1.5MB JSON)

```bash
curl -sL --compressed "https://annas-archive.li/dyn/torrents.json" -o /tmp/torrents.json
```

Returns array of objects with fields:
- `display_name`, `group_name`, `top_level_group_name` — identification
- `btih` — 40-char hex info hash
- `magnet_link` — full magnet URI
- `data_size` — bytes, `num_files` — file count
- `seeders`, `leechers`, `completed` — swarm stats
- `added_to_torrents_list_at` — date string (e.g., `"2025-12-20"`)
- `aa_currently_seeding` — bool
- `is_metadata` — bool
- `obsolete`, `embargo`, `partially_broken` — status flags

**`/dyn/generate_torrents`** — Smart torrent picker (most-needed torrents within a storage budget)

```bash
# Get most-needed torrents fitting in 50GB, as JSON
curl -sL --compressed "https://annas-archive.li/dyn/generate_torrents?max_tb=0.05&format=json"

# As magnet links (one per line, ready to paste into a client)
curl -sL --compressed "https://annas-archive.li/dyn/generate_torrents?max_tb=0.5&format=magnet"

# As .torrent download URLs
curl -sL --compressed "https://annas-archive.li/dyn/generate_torrents?max_tb=0.5&format=url"
```

Parameters: `max_tb` (float, storage budget in TB), `format` (`json`|`magnet`|`url`)

**`/dyn/torrents/latest_aac_meta/{collection}.torrent`** — Latest AAC metadata torrent for a specific collection

```bash
curl -sL "https://annas-archive.li/dyn/torrents/latest_aac_meta/duxiu_records.torrent" -o latest.torrent
```

**`/dyn/small_file/{file_path}`** — Download .torrent files directly

The `file_path` is `torrents/{top_level_group_name}/{group_name}/{display_name}` from torrents.json:
```bash
curl -sL "https://annas-archive.li/dyn/small_file/torrents/other_aa/aa_misc_data/annas_archive_spotify_2025_07_metadata.torrent" -o metadata.torrent
```

### File Info by MD5

**`/dyn/md5/summary/{md5}`** — Quick file info (report count, comments, lists, download total, quality rating)

```bash
curl -sL "https://annas-archive.li/dyn/md5/summary/d6e1dc51a50726f00ec438af21952a45"
# Returns: {"reports_count":0,"comments_count":0,"lists_count":4,"downloads_total":1525,"great_quality_count":1,...}
```

**`/dyn/md5/inline_info/{md5}`** — Same as summary but fewer fields

### Download Statistics

**`/dyn/downloads/stats/`** — Global download counts (hourly timeseries, last ~31 days)

Returns `{"timeseries_x": [...hours...], "timeseries_y": [...counts...]}` where hours are `hour_since_epoch` (Unix timestamp / 3600).

**`/dyn/downloads/stats/{md5}`** — Per-file download stats

Returns `{"total": N, "timeseries_x": [...], "timeseries_y": [...]}` plus top countries.

### Auth-Required

**`/dyn/api/fast_download.json`** — Get a download URL (requires membership)

```bash
curl -sL "https://annas-archive.li/dyn/api/fast_download.json?md5=HASH&key=YOUR_SECRET_KEY"
# Optional: &path_index=0&domain_index=0
```

The API is self-documenting — calling it without params returns the full docs in JSON.

### Health/Utility

- **`/dyn/up/`** — Health check, returns `{"aa_logged_in": 0|1}`
- **`/dyn/translations/`** — Available UI language codes

### Filtering Torrents

```bash
# List all group names
python3 -c "
import json
with open('/tmp/torrents.json') as f:
    data = json.load(f)
groups = sorted(set(e.get('group_name','') for e in data))
for g in groups: print(g)
"

# Find torrents by keyword
python3 -c "
import json
with open('/tmp/torrents.json') as f:
    data = json.load(f)
for e in data:
    if 'keyword' in json.dumps(e).lower():
        print(f'{e[\"display_name\"]} ({e[\"data_size\"]/1e9:.1f}GB, {e[\"seeders\"]} seeders)')
        print(f'  magnet: {e[\"magnet_link\"]}')
"
```

## Using the Wayback Machine as Fallback

When Anna's Archive domains are down or content has been removed, the Wayback Machine often has snapshots. Use the `wayback-machine` skill for detailed CDX API instructions.

### Key Archived URLs

```bash
# Torrents JSON (many snapshots across all three domains)
curl -s "https://web.archive.org/cdx/search/cdx?url=annas-archive.li/dyn/torrents.json&output=json&filter=statuscode:200"
curl -s "https://web.archive.org/cdx/search/cdx?url=annas-archive.se/dyn/torrents.json&output=json&filter=statuscode:200"
curl -s "https://web.archive.org/cdx/search/cdx?url=annas-archive.org/dyn/torrents.json&output=json&filter=statuscode:200"

# Torrent listing pages for specific categories
curl -s "https://web.archive.org/cdx/search/cdx?url=annas-archive.org/torrents/*&output=json&filter=statuscode:200&collapse=urlkey"

# Blog posts
curl -s "https://web.archive.org/cdx/search/cdx?url=annas-archive.org/blog/*&output=json&filter=statuscode:200&collapse=urlkey"
```

### Fetching Archived Content

```bash
# MUST use --compressed or you get binary garbage
curl -sL --compressed "https://web.archive.org/web/{timestamp}id_/https://annas-archive.li/dyn/torrents.json" -o /tmp/torrents.json
```

### Why Wayback Matters

- **Removed content**: Torrents are sometimes removed from the live site under legal pressure (e.g., Spotify torrents were listed then removed)
- **Domain outages**: When all domains are down, Wayback snapshots still work
- **Historical data**: Compare `torrents.json` across snapshots to find when content was added/removed (use the `length` field in CDX results to spot changes)
- **Always check all three domain variants** (.li, .se, .org) — different snapshots exist on each

## Content Categories

| Group | Description |
|-------|-------------|
| `libgen_rs_non_fic` | Library Genesis non-fiction |
| `libgen_rs_fic` | Library Genesis fiction |
| `libgen_li_*` | LibGen.li collections (comics, fiction, magazines, etc.) |
| `scihub` | Sci-Hub papers |
| `ia` | Internet Archive scraped content |
| `duxiu` | Chinese academic library |
| `hathitrust` | HathiTrust scraped content |
| `zlib` | Z-Library |
| `upload` | Direct user uploads |
| `nexusstc` | Nexus/STC |
| `worldcat` | WorldCat metadata |
| `magzdb` | Magazine database |
| `aa_derived_mirror_metadata` | AA's derived metadata (good for search/LLM use) |
| `aa_misc_data` | Miscellaneous data (including Spotify) |
| `spotify` | Spotify metadata and music |

## From llms.txt

Anna's Archive provides an `llms.txt` at the site root. Key points:
- Website has CAPTCHAs; use bulk data access instead of scraping
- All code is in their [GitLab repos](https://software.annas-archive.li/)
- All metadata/files available via the [Torrents page](/torrents)
- `aa_derived_mirror_metadata` is recommended for building custom search
- Enterprise SFTP access available for large donations (see `/llm` page)
