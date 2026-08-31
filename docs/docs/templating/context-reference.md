# Context Reference

Everything a `{{ }}` lookup or `{{= }}` expression can reference, taken as a snapshot of the note the button lives in at click time — not a live handle onto the vault, so a prompt can't reach anything beyond what's listed here.

| Path | Value |
| --- | --- |
| `file.path` | Vault-relative path of the note the button is in |
| `file.basename` | Filename without extension |
| `file.name` | Filename with extension |
| `file.folder` | Vault-relative path of the containing folder (`""` at vault root) |
| `file.extension` | File extension without the dot |
| `file.frontmatter.<key>` | Any YAML frontmatter field |
| `file.tags` | All tags on the note (frontmatter `tags` + inline `#tags`, deduped) |
| `file.ctime` / `file.mtime` | Creation / modification time, ISO 8601 |
| `vault.name` | Vault's display name |
| `vault.basePath` | Vault's real filesystem path |
| `date.today` | Today's date, `YYYY-MM-DD` |
| `date.now` | Current timestamp, ISO 8601 |

## Behaviour on missing or unknown paths

- **Unknown root** (e.g. `{{flie.basename}}`, a typo) — left in the prompt untouched, so the mistake stays visible.
- **Missing value under a known root** (e.g. `file.frontmatter.status` when there's no `status` field) — renders as an empty string.

## Helper functions (inside `{{= }}` only)

| Function | Does |
| --- | --- |
| `join(arr, sep)` | Joins an array into a string with the given separator |
| `upper(s)` / `lower(s)` | Uppercase / lowercase a string |
| `default(val, fallback)` | `val` if it's set, otherwise `fallback` |
| `includes(collection, item)` | Whether an array or string contains `item` |
| `length(x)` | Length of a string or array |

See [Lookups and Expressions](overview.md) for the full expression grammar and worked examples.
