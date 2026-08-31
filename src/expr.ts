/**
 * A small, self-contained expression language for `{{= expr }}` prompt
 * segments (see templating.ts) — property access, comparisons, arithmetic,
 * `&&`/`||`/`!`, a ternary, and a fixed allowlist of pure helper functions.
 *
 * Deliberately NOT `new Function`/`eval`: Obsidian's own community-plugin
 * lint (`eslint-plugin-obsidianmd`'s `rule-custom-message` for `no-new-func`)
 * flags exactly that pattern, and its config marks the rule
 * non-suppressible (`eslint-comments/no-restricted-disable`) — i.e. it's a
 * hard submission-review constraint, not a style preference. This
 * interpreter has no code-execution surface at all: no assignment, no
 * loops, no access to anything outside the context object handed to
 * `evaluateExpression`, and a fixed, closed set of callable names — so
 * there's nothing to sandbox because there's no way out of the grammar.
 */

type TokenType = "num" | "str" | "ident" | "punct" | "eof";
interface Token {
	type: TokenType;
	value: string;
}

const MULTI_CHAR_PUNCT = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_CHAR_PUNCT = ".,()[]?:+-*/%<>!";

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let out = "";
			while (j < src.length && src[j] !== quote) {
				if (src[j] === "\\" && j + 1 < src.length) {
					out += src[j + 1];
					j += 2;
					continue;
				}
				out += src[j];
				j++;
			}
			if (j >= src.length) throw new Error(`unterminated string literal`);
			tokens.push({ type: "str", value: out });
			i = j + 1;
			continue;
		}
		if (/[0-9]/.test(ch)) {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j])) j++;
			tokens.push({ type: "num", value: src.slice(i, j) });
			i = j;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i;
			while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
			tokens.push({ type: "ident", value: src.slice(i, j) });
			i = j;
			continue;
		}
		const three = src.slice(i, i + 3);
		const two = src.slice(i, i + 2);
		if (MULTI_CHAR_PUNCT.includes(three)) {
			tokens.push({ type: "punct", value: three });
			i += 3;
			continue;
		}
		if (MULTI_CHAR_PUNCT.includes(two)) {
			tokens.push({ type: "punct", value: two });
			i += 2;
			continue;
		}
		if (SINGLE_CHAR_PUNCT.includes(ch)) {
			tokens.push({ type: "punct", value: ch });
			i++;
			continue;
		}
		throw new Error(`unexpected character "${ch}"`);
	}
	tokens.push({ type: "eof", value: "" });
	return tokens;
}

/** Property/index access that returns `undefined` for anything not
 * present, rather than throwing — mirrors templating.ts's own dot-path
 * lookup semantics (a missing field renders as empty, not a hard error). */
function safeGet(obj: unknown, key: string): unknown {
	if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
	if (Array.isArray(obj)) {
		const idx = Number(key);
		return Number.isInteger(idx) ? obj[idx] : undefined;
	}
	return (obj as Record<string, unknown>)[key];
}

function truthy(value: unknown): boolean {
	return Boolean(value);
}

function toNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

// Values flowing through here come from vault frontmatter / arbitrary
// {{= }} operands, so `unknown`'s only safe stringification is this — not
// a bare `String(x)`, which mangles to "[object Object]" for a plain
// object (no toString override), rather than throwing or losing meaning
// silently in some more surprising way.
function safeString(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "object") return JSON.stringify(value);
	// Only number/boolean/bigint reach here (string/object/null/undefined
	// all handled above) — all stringify meaningfully, unlike the
	// arbitrary-class-instance case this lint rule guards against.
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment above.
	return String(value);
}

// Fixed, closed set of pure helpers callable as `name(args...)` — nothing
// else is callable (see parsePrimary), so this list *is* the entire
// function surface available to an expression.
const HELPERS: Record<string, (...args: unknown[]) => unknown> = {
	join: (arr, sep) => (Array.isArray(arr) ? arr.join(typeof sep === "string" ? sep : ", ") : safeString(arr)),
	upper: (s) => safeString(s).toUpperCase(),
	lower: (s) => safeString(s).toLowerCase(),
	default: (val, fallback) => (val === undefined || val === null || val === "" ? fallback : val),
	includes: (haystack, needle) => (Array.isArray(haystack) ? haystack.includes(needle) : safeString(haystack).includes(safeString(needle))),
	length: (x) => (Array.isArray(x) || typeof x === "string" ? x.length : 0),
};

class ExpressionParser {
	private tokens: Token[];
	private pos = 0;

	constructor(
		src: string,
		private context: Record<string, unknown>
	) {
		this.tokens = tokenize(src);
	}

	private peek(): Token {
		return this.tokens[this.pos];
	}

	private isPunct(value: string): boolean {
		const t = this.peek();
		return t.type === "punct" && t.value === value;
	}

	private consumePunct(value: string): boolean {
		if (!this.isPunct(value)) return false;
		this.pos++;
		return true;
	}

	private expectPunct(value: string): void {
		if (!this.consumePunct(value)) {
			throw new Error(`expected "${value}" but found "${this.peek().value || "end of expression"}"`);
		}
	}

	evaluate(): unknown {
		const value = this.parseTernary();
		if (this.peek().type !== "eof") throw new Error(`unexpected token "${this.peek().value}"`);
		return value;
	}

	// Every binary/ternary level below eagerly evaluates both operands
	// (no true short-circuiting) — acceptable because everything in this
	// grammar is a pure, total function of its inputs (safeGet never
	// throws, HELPERS are all pure), so evaluating an "unused" branch has
	// no observable side effect.
	private parseTernary(): unknown {
		const cond = this.parseLogicalOr();
		if (this.consumePunct("?")) {
			const whenTrue = this.parseTernary();
			this.expectPunct(":");
			const whenFalse = this.parseTernary();
			return truthy(cond) ? whenTrue : whenFalse;
		}
		return cond;
	}

	private parseLogicalOr(): unknown {
		let left = this.parseLogicalAnd();
		while (this.consumePunct("||")) {
			const right = this.parseLogicalAnd();
			left = truthy(left) ? left : right;
		}
		return left;
	}

	private parseLogicalAnd(): unknown {
		let left = this.parseEquality();
		while (this.consumePunct("&&")) {
			const right = this.parseEquality();
			left = truthy(left) ? right : left;
		}
		return left;
	}

	private parseEquality(): unknown {
		let left = this.parseRelational();
		for (;;) {
			if (this.consumePunct("===")) left = left === this.parseRelational();
			else if (this.consumePunct("!==")) left = left !== this.parseRelational();
			else if (this.consumePunct("==")) left = left == this.parseRelational();
			else if (this.consumePunct("!=")) left = left != this.parseRelational();
			else break;
		}
		return left;
	}

	private parseRelational(): unknown {
		let left = this.parseAdditive();
		for (;;) {
			if (this.consumePunct("<=")) left = toNumber(left) <= toNumber(this.parseAdditive());
			else if (this.consumePunct(">=")) left = toNumber(left) >= toNumber(this.parseAdditive());
			else if (this.consumePunct("<")) left = toNumber(left) < toNumber(this.parseAdditive());
			else if (this.consumePunct(">")) left = toNumber(left) > toNumber(this.parseAdditive());
			else break;
		}
		return left;
	}

	private parseAdditive(): unknown {
		let left = this.parseMultiplicative();
		for (;;) {
			if (this.consumePunct("+")) {
				const right = this.parseMultiplicative();
				left = typeof left === "string" || typeof right === "string" ? `${String(left)}${String(right)}` : toNumber(left) + toNumber(right);
			} else if (this.consumePunct("-")) {
				left = toNumber(left) - toNumber(this.parseMultiplicative());
			} else break;
		}
		return left;
	}

	private parseMultiplicative(): unknown {
		let left = this.parseUnary();
		for (;;) {
			if (this.consumePunct("*")) left = toNumber(left) * toNumber(this.parseUnary());
			else if (this.consumePunct("/")) left = toNumber(left) / toNumber(this.parseUnary());
			else if (this.consumePunct("%")) left = toNumber(left) % toNumber(this.parseUnary());
			else break;
		}
		return left;
	}

	private parseUnary(): unknown {
		if (this.consumePunct("!")) return !truthy(this.parseUnary());
		if (this.consumePunct("-")) return -toNumber(this.parseUnary());
		return this.parsePostfix();
	}

	private parsePostfix(): unknown {
		let value = this.parsePrimary();
		for (;;) {
			if (this.consumePunct(".")) {
				const tok = this.peek();
				if (tok.type !== "ident") throw new Error(`expected a property name after "."`);
				this.pos++;
				value = safeGet(value, tok.value);
			} else if (this.consumePunct("[")) {
				const key = this.parseTernary();
				this.expectPunct("]");
				value = safeGet(value, String(key));
			} else break;
		}
		return value;
	}

	private parseArgs(): unknown[] {
		const args: unknown[] = [];
		if (!this.isPunct(")")) {
			args.push(this.parseTernary());
			while (this.consumePunct(",")) args.push(this.parseTernary());
		}
		this.expectPunct(")");
		return args;
	}

	private parsePrimary(): unknown {
		const tok = this.peek();
		if (tok.type === "num") {
			this.pos++;
			return Number(tok.value);
		}
		if (tok.type === "str") {
			this.pos++;
			return tok.value;
		}
		if (this.consumePunct("(")) {
			const value = this.parseTernary();
			this.expectPunct(")");
			return value;
		}
		if (tok.type === "ident") {
			this.pos++;
			if (tok.value === "true") return true;
			if (tok.value === "false") return false;
			if (tok.value === "null") return null;
			// A call is only recognized here — a bare `name(...)` where
			// `name` is in HELPERS. Nothing resolved from context is ever
			// callable, so `file.someMethod()` isn't valid syntax at all,
			// not just a runtime error.
			if (this.isPunct("(")) {
				this.pos++;
				const args = this.parseArgs();
				const helper = HELPERS[tok.value];
				if (!helper) {
					const known = Object.keys(HELPERS).join(", ");
					throw new Error(`unknown function "${tok.value}" — available: ${known}`);
				}
				return helper(...args);
			}
			if (!(tok.value in this.context)) {
				const known = Object.keys(this.context).join(", ");
				throw new Error(`unknown name "${tok.value}" — available: ${known}`);
			}
			return this.context[tok.value];
		}
		throw new Error(`unexpected token "${tok.value || "end of expression"}"`);
	}
}

/** Evaluates a `{{= }}` expression against a context object (AgentContext's
 * own keys, e.g. `file`/`vault`/`date` — see context.ts). Throws a plain
 * `Error` with a human-readable message on any syntax problem or unknown
 * name; templating.ts surfaces that message and aborts the run rather than
 * silently swallowing it. */
export function evaluateExpression(expr: string, context: Record<string, unknown>): unknown {
	return new ExpressionParser(expr, context).evaluate();
}
