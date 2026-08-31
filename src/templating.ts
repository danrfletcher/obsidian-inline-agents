import type { AgentContext } from "./context";
import { evaluateExpression } from "./expr";

export interface RenderPromptOptions {
	/** Mirrors the "Allow JavaScript expressions in prompts" setting.
	 * `{{= }}` expressions are refused (with a visible error, not silently
	 * dropped) unless this is true. Default off — see settings.ts. */
	allowJs: boolean;
}

export interface RenderPromptResult {
	text: string;
	/** Set if rendering failed (JS disabled but used, or a thrown
	 * expression) — callers should surface this and not spawn the agent. */
	error?: string;
}

// `{{= expr }}` — a JS expression, evaluated with AgentContext's top-level
// keys (file, vault, date) in scope. Matched and substituted BEFORE the
// plain-lookup pass below so its own output can never be reinterpreted as
// a lookup placeholder. Non-greedy up to the first `}}`, so an expression
// containing a literal `}}` (e.g. a nested object literal) isn't supported
// — same practical limitation Dataview's own inline `= ` fields have.
const JS_EXPR_RE = /\{\{\s*=\s*([\s\S]+?)\s*\}\}/g;

// `{{ path.to.value }}` — a dot-path lookup against AgentContext. The
// leading-`=` exclusion keeps this from ever matching a `{{= }}` block that
// (for whatever reason) survived the pass above.
const LOOKUP_RE = /\{\{\s*([^={}]+?)\s*\}\}/g;

function stringifyValue(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(stringifyValue).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	// Only number/boolean/bigint reach here (string/array/object/null/
	// undefined all handled above; frontmatter/JS-expression results can't
	// realistically yield a function or Symbol) — all stringify meaningfully,
	// unlike the arbitrary-class-instance case this lint rule guards against.
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- number/boolean/bigint all stringify meaningfully; not an arbitrary-class instance.
	return String(value);
}

/** Walks a dot-path (e.g. "file.frontmatter.status") against context.
 * `found: false` means the ROOT segment itself isn't a known context key
 * (almost always a typo, e.g. `{{flie.basename}}`) — callers leave those
 * placeholders untouched so the mistake stays visible in the note rather
 * than silently vanishing. Anything past a known root that comes up
 * missing (no frontmatter, no such field) resolves to `found: true,
 * value: undefined`, which renders as "". */
function lookupPath(context: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
	const segments = path.split(".").map((s) => s.trim());
	if (!(segments[0] in context)) return { found: false };
	let current: unknown = context;
	for (const seg of segments) {
		if (current === null || typeof current !== "object") {
			current = undefined;
			break;
		}
		current = (current as Record<string, unknown>)[seg];
	}
	return { found: true, value: current };
}

/**
 * Renders an `agent-button` prompt template against an AgentContext.
 * Two tiers, both opt-in only in the sense that a plain prompt with no
 * `{{ }}` at all round-trips unchanged:
 *  - `{{ file.basename }}` etc. — always available, simple dot-path
 *    lookups, no code execution.
 *  - `{{= expr }}` — a small expression language (see expr.ts) with
 *    `file`/`vault`/`date` in scope, gated behind `opts.allowJs` (see
 *    settings.ts's "Allow JavaScript expressions in prompts", default off).
 */
export function renderPromptTemplate(template: string, context: AgentContext, opts: RenderPromptOptions): RenderPromptResult {
	const ctx = context as unknown as Record<string, unknown>;
	let error: string | undefined;

	const afterJs = template.replace(JS_EXPR_RE, (match, expr: string) => {
		if (error) return match;
		if (!opts.allowJs) {
			error =
				`JavaScript expressions are disabled: {{= ${expr} }}. Enable "Allow JavaScript expressions ` +
				`in prompts" in Settings → Inline Agents to use them.`;
			return match;
		}
		try {
			return stringifyValue(evaluateExpression(expr, ctx));
		} catch (err) {
			error = `Error evaluating {{= ${expr} }}: ${(err as Error).message}`;
			return match;
		}
	});

	if (error) return { text: template, error };

	const rendered = afterJs.replace(LOOKUP_RE, (match, path: string) => {
		const { found, value } = lookupPath(ctx, path);
		return found ? stringifyValue(value) : match;
	});

	return { text: rendered };
}
