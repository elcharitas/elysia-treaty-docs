import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	Project,
	TypeFormatFlags,
	type Type,
	type TypeAliasDeclaration,
} from "ts-morph";

/**
 * Configuration for SDK options in the documentation generation process.
 */
export interface SdkConfig {
	import?: string;
	clientName?: string;
	clientOptions?: string;
}

/**
 * Configuration for a single app in the documentation generation process.
 *
 * Each app corresponds to a backend service whose exported Elysia type
 * will be introspected to produce endpoint documentation.
 */
export interface AppConfig {
	name: string;
	sourceFilesGlob?: string;
	entryFile: string;
	typeAliasName?: string;
	sdk?: SdkConfig;
}

/**
 * Top-level options for generating API documentation from one or more elysia apps.
 */
export interface GenerateDocsOptions {
	apps: AppConfig[];
	projectRoot: string;
	tsConfigFilePath?: string;
	outputPath?: string;
	title?: string;
	description?: string;
}

/** Well-known generic type names that should be preserved rather than expanded. */
const KNOWN_GENERICS = new Set([
	"Array",
	"ReadonlyArray",
	"Promise",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"Record",
	"Exclude",
	"Extract",
	"NonNullable",
	"ReturnType",
	"Iterable",
	"Iterator",
	"AsyncIterable",
	"AsyncIterator",
	"Generator",
	"AsyncGenerator",
	"IterableIterator",
]);

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);
const INTERNAL_PROPS = new Set([
	"decorator",
	"store",
	"derive",
	"resolve",
	"schema",
	"standaloneSchema",
	"response",
]);
const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** Fingerprint properties used to detect structurally-expanded Array types. */
const ARRAY_FINGERPRINT = new Set([
	"length",
	"push",
	"pop",
	"concat",
	"join",
	"reverse",
	"shift",
	"slice",
	"sort",
	"splice",
	"indexOf",
	"forEach",
	"map",
	"filter",
	"reduce",
	"find",
]);

/**
 * Regex that detects expanded-Array noise in a stringified type.
 * Matches things like `[Symbol.unscopables]`, `[Symbol.iterator]`, or
 * several Array-prototype method names appearing as property keys.
 */
const EXPANDED_ARRAY_RE =
	/\[\s*Symbol\.\s*(unscopables|iterator)\s*\]|(?:pop|push|shift|splice|concat|reverse|forEach|indexOf)\??\s*:/;

/**
 * Detects duplicated primitive union members in getText() output.
 * E.g. `string | null | undefined | undefined` — the repeated member is noise
 * from intersection resolution and should trigger property-level recursion.
 */
const DUPLICATE_UNION_RE = /\b(undefined|null)\b[^;{}]*?\|\s*\1\b/;

/** Maximum recursion depth for resolveTypeText to guard against circular types. */
const MAX_RESOLVE_DEPTH = 10;

/**
 * Resolves a ts-morph Type to a concise TypeScript type string, preventing
 * the compiler from fully expanding well-known generic interfaces such as
 * `Array`, `Promise`, `Map`, etc.
 *
 * Strategy:
 * 1. Handle arrays, tuples, unions, intersections, and known generics directly.
 * 2. For object types, first try getText() with alias-preserving flags. If the
 *    result is clean (no expanded array noise), use it as-is.
 * 3. Only fall back to recursive property iteration when the getText() output
 *    contains telltale signs of structural array expansion.
 */
function resolveTypeText(
	type: Type,
	enclosingNode: TypeAliasDeclaration,
	depth = 0,
): string {
	// Guard against infinite recursion on circular types
	if (depth > MAX_RESOLVE_DEPTH) {
		return type.getText(
			enclosingNode,
			TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
				TypeFormatFlags.NoTruncation,
		);
	}

	// Array<T> / T[]
	if (type.isArray()) {
		const elementType = type.getArrayElementType();
		if (!elementType) return "unknown[]";
		const inner = resolveTypeText(elementType, enclosingNode, depth + 1);
		if (elementType.isUnion() || elementType.isIntersection()) {
			return `Array<${inner}>`;
		}
		return `${inner}[]`;
	}

	// Tuple types
	if (type.isTuple()) {
		const elements = type
			.getTupleElements()
			.map((t) => resolveTypeText(t, enclosingNode, depth + 1));
		return `[${elements.join(", ")}]`;
	}

	// Union types
	if (type.isUnion()) {
		const parts = type
			.getUnionTypes()
			.map((t) => resolveTypeText(t, enclosingNode, depth + 1));
		// Deduplicate to avoid "string | null | undefined | undefined"
		const unique = [...new Set(parts)];

		// Collapse `false | true` back to `boolean`
		const hasFalse = unique.includes("false");
		const hasTrue = unique.includes("true");
		if (hasFalse && hasTrue) {
			const collapsed = unique.filter((p) => p !== "false" && p !== "true");
			collapsed.push("boolean");
			unique.length = 0;
			unique.push(...collapsed);
		}

		// Ensure concrete types first, null/undefined last
		const nullish = new Set(["null", "undefined"]);
		unique.sort((a, b) => {
			const aN = nullish.has(a) ? 1 : 0;
			const bN = nullish.has(b) ? 1 : 0;
			return aN - bN;
		});

		return unique.join(" | ");
	}

	// Intersection types
	if (type.isIntersection()) {
		const members = type.getIntersectionTypes();

		// When every member is an anonymous object type (common with
		// Elysia/better-auth overlapping interfaces), flatten into a single
		// merged object to avoid `{ … } & { … }` with duplicate properties.
		const allAnonymousObjects =
			members.every(
				(m) =>
					m.isObject() &&
					!m.isArray() &&
					m.getCallSignatures().length === 0 &&
					!KNOWN_GENERICS.has(m.getSymbol()?.getName() ?? "") &&
					!KNOWN_GENERICS.has(m.getAliasSymbol()?.getName() ?? ""),
			) && members.some((m) => m.getProperties().length > 0);

		if (allAnonymousObjects && members.length > 1) {
			const properties = type.getProperties();
			const entries: string[] = [];
			for (const prop of properties) {
				const propName = prop.getName();
				if (propName.startsWith("__@")) continue;
				const propType = prop.getTypeAtLocation(enclosingNode);
				const optional = prop.isOptional() ? "?" : "";
				const resolved = resolveTypeText(propType, enclosingNode, depth + 1);
				const key = VALID_IDENT.test(propName)
					? propName
					: JSON.stringify(propName);
				entries.push(`${key}${optional}: ${resolved}`);
			}
			if (entries.length > 0) {
				return `{ ${entries.join("; ")} }`;
			}
		}

		// Fall back: resolve each member individually, drop empty objects, dedup
		const parts = members.map((t) =>
			resolveTypeText(t, enclosingNode, depth + 1),
		);
		const filtered = parts.filter((p) => p !== "{}");
		const unique = [...new Set(filtered)];
		if (unique.length === 0) return "{}";
		if (unique.length === 1) return unique[0];
		return unique.join(" & ");
	}

	// Preserve well-known generic types (Promise<T>, Map<K,V>, Set<T>, etc.)
	const symbol = type.getSymbol() ?? type.getAliasSymbol();
	if (symbol) {
		const name = symbol.getName();
		const typeArgs =
			type.getTypeArguments().length > 0
				? type.getTypeArguments()
				: type.getAliasTypeArguments();

		if (KNOWN_GENERICS.has(name)) {
			if (typeArgs.length > 0) {
				const args = typeArgs.map((t) =>
					resolveTypeText(t, enclosingNode, depth + 1),
				);
				return `${name}<${args.join(", ")}>`;
			}
			return name;
		}
	}

	// For object types, detect and collapse structurally-expanded arrays
	if (type.isObject()) {
		// Direct fingerprint check: numeric index + Array-prototype props → T[]
		const numberIndexType = type.getNumberIndexType();
		if (numberIndexType) {
			const propNames = new Set(type.getProperties().map((p) => p.getName()));
			let matched = 0;
			for (const fp of ARRAY_FINGERPRINT) {
				if (propNames.has(fp)) matched++;
			}
			if (matched >= ARRAY_FINGERPRINT.size * 0.75) {
				const inner = resolveTypeText(
					numberIndexType,
					enclosingNode,
					depth + 1,
				);
				return `${inner}[]`;
			}
		}

		// Try getText() first — if it's clean, use it directly
		const text = type.getText(
			enclosingNode,
			TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
				TypeFormatFlags.NoTruncation,
		);

		if (!EXPANDED_ARRAY_RE.test(text) && !DUPLICATE_UNION_RE.test(text)) {
			return text;
		}

		// getText() contains expanded-array noise — recurse into properties
		// to resolve each one individually, collapsing arrays at every level
		const properties = type.getProperties();
		if (properties.length > 0 && type.getCallSignatures().length === 0) {
			const entries: string[] = [];
			for (const prop of properties) {
				const propName = prop.getName();
				if (propName.startsWith("__@")) continue;

				const propType = prop.getTypeAtLocation(enclosingNode);
				const optional = prop.isOptional() ? "?" : "";
				const resolved = resolveTypeText(propType, enclosingNode, depth + 1);

				const key = VALID_IDENT.test(propName)
					? propName
					: JSON.stringify(propName);
				entries.push(`${key}${optional}: ${resolved}`);
			}

			if (entries.length > 0) {
				return `{ ${entries.join("; ")} }`;
			}
		}

		return text;
	}

	// Fallback: let the compiler stringify with flags that discourage expansion
	return type.getText(
		enclosingNode,
		TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
			TypeFormatFlags.NoTruncation,
	);
}

/** Extracts route parameters (e.g. `:id`) from a path and returns a TS object literal type string. */
function parseParamsFromPath(path: string): string {
	const params = Array.from(path.matchAll(/\/:([^/]+)/g), (match) => match[1]);
	return params.length
		? `{${params.map((name) => `${name}: string`).join(", ")}}`
		: "{}";
}

/** Pretty-prints a compact TypeScript type string with indentation. */
function prettyPrintType(typeStr: string): string {
	const chunks: string[] = [];
	let indent = 0;
	let inString = false;
	let escaped = false;

	for (const char of typeStr) {
		if (escaped) {
			chunks.push(char);
			escaped = false;
		} else if (char === "\\") {
			chunks.push(char);
			escaped = true;
		} else if (char === '"' || char === "'") {
			inString = !inString;
			chunks.push(char);
		} else if (inString) {
			chunks.push(char);
		} else if (char === "{" || char === "[") {
			chunks.push(char, "\n", "  ".repeat(++indent));
		} else if (char === "}" || char === "]") {
			chunks.push("\n", "  ".repeat(--indent), char);
		} else if (char === ";" || char === ",") {
			chunks.push(char, "\n", "  ".repeat(indent));
		} else if (char !== " " || chunks[chunks.length - 1] !== " ") {
			chunks.push(char);
		}
	}

	return chunks
		.join("")
		.replace(/([;,])\n\s*\n(\s*[}\]])/g, "$1\n$2")
		.trim();
}

/** Builds a treaty-style client path expression from a URL path. */
function buildClientPath(path: string): string {
	return path
		.split("/")
		.filter(Boolean)
		.reduce((chain, segment) => {
			if (segment.startsWith(":"))
				return `${chain}[params.${segment.slice(1)}]`;
			if (VALID_IDENT.test(segment)) return `${chain}.${segment}`;
			return `${chain}["${segment}"]`;
		}, "client");
}

/** Generates an SDK usage code block for a single endpoint. */
function generateSdkCodeBlock(
	path: string,
	method: string,
	hasBody: boolean,
	hasParams: boolean,
	hasQuery: boolean,
	paramsType: string,
	sdkImport: string,
	sdkClientName: string,
	sdkClientOptions?: string,
): string {
	const callArgs = [hasBody && "body", hasQuery && "{ query }"]
		.filter(Boolean)
		.join(", ");
	const lines = [
		"```typescript",
		`${sdkImport}\n`,
		`const client = ${sdkClientName}(${sdkClientOptions || ""});\n`,
		hasParams &&
			`const params = ${paramsType
				.replace(/;/g, ",")
				.replace(/,(\s*})/g, "$1")
				.replace(/: string/g, ': "example-value"')};\n`,
		hasBody &&
			"// Define your request body\nconst body = {}; // Replace with actual body data\n",
		hasQuery &&
			"// Define your query parameters\nconst query = {}; // Replace with actual query data\n",
		`const response = await ${buildClientPath(path)}.${method}(${callArgs});`,
		"```\n",
	];
	return lines.filter(Boolean).join("\n");
}

/** Renders a labeled type block in Markdown. */
function formatTypeBlock(label: string, typeStr: string): string {
	return `**${label}:**\n\n\`\`\`typescript\n${prettyPrintType(typeStr)}\n\`\`\`\n\n`;
}

/** Recursively walks an Elysia type tree and generates Markdown documentation for each endpoint. */
function generateDocsFromType(
	type: Type,
	typeAlias: TypeAliasDeclaration,
	path: string,
	sdkImport: string,
	sdkClientName: string,
	sdkClientOptions?: string,
): string {
	const parts: string[] = [];

	for (const prop of type.getProperties()) {
		const propName = prop.getName();
		const propType = prop.getTypeAtLocation(typeAlias);

		if (HTTP_METHODS.has(propName)) {
			// Skip catch-all wildcard routes that have no real path
			if (!path) continue;
			const routeTypes: Record<string, string> = {
				body: "unknown",
				params: "{}",
				query: "unknown",
				response: "{}",
			};

			for (const methodProp of propType.getProperties()) {
				const key = methodProp.getName();
				if (key in routeTypes) {
					routeTypes[key] = resolveTypeText(
						methodProp.getTypeAtLocation(typeAlias),
						typeAlias,
					);
				}
			}

			if (routeTypes.params.startsWith("_ResolvePath<")) {
				const match = routeTypes.params.match(/_ResolvePath<"([^"]+)">/);
				if (match) routeTypes.params = parseParamsFromPath(match[1]);
			}

			const hasBody = routeTypes.body !== "unknown";
			const hasParams = routeTypes.params !== "{}";
			const hasQuery = routeTypes.query !== "unknown";

			parts.push(
				`### ${propName.toUpperCase()} ${path}\n\n<details>\n<summary>SDK Usage</summary>\n\n`,
				generateSdkCodeBlock(
					path,
					propName,
					hasBody,
					hasParams,
					hasQuery,
					routeTypes.params,
					sdkImport,
					sdkClientName,
					sdkClientOptions,
				),
				hasBody ? formatTypeBlock("Body", routeTypes.body) : "",
				hasParams ? formatTypeBlock("Params", routeTypes.params) : "",
				hasQuery ? formatTypeBlock("Query", routeTypes.query) : "",
				formatTypeBlock("Response", routeTypes.response),
				"</details>\n\n",
				"---\n\n",
			);
		} else if (propName === "~Routes") {
			parts.push(
				generateDocsFromType(
					propType,
					typeAlias,
					"",
					sdkImport,
					sdkClientName,
					sdkClientOptions,
				),
			);
		} else if (
			!INTERNAL_PROPS.has(propName) &&
			!propName.startsWith("~") &&
			!propName.startsWith("_")
		) {
			const separator = propName.startsWith(":") && !path ? "" : "/";
			parts.push(
				generateDocsFromType(
					propType,
					typeAlias,
					`${path}${separator}${propName}`,
					sdkImport,
					sdkClientName,
					sdkClientOptions,
				),
			);
		}
	}

	return parts.join("");
}

/**
 * Generates API documentation for the specified elysia apps by analyzing their
 * TypeScript types and writing a Markdown file that covers every endpoint.
 *
 * @example
 * ```ts
 * generateDocs({
 *   apps: [{ name: "luminary" }],
 *   projectRoot: "/absolute/path/to/project",
 * });
 * ```
 */
export function generateDocs(options: GenerateDocsOptions): void {
	const {
		apps,
		projectRoot,
		tsConfigFilePath = resolve(projectRoot, "tsconfig.json"),
		outputPath = "DOCS.md",
		title = "API Documentation",
		description = "This document contains API documentation for the configured elysia apps.",
	} = options;

	const parts = [`# ${title}\n\n${description}\n\n`];
	const project = new Project({ tsConfigFilePath });

	for (const app of apps) {
		const appName = app.name;
		const sdkImport = app.sdk?.import || 'import { treaty } from "elysia";';
		const sdkClientName = app.sdk?.clientName || "treaty";
		const sdkClientOptions = app.sdk?.clientOptions;

		console.log(`Generating docs for ${appName}...`);
		if (app.sourceFilesGlob) {
			project.addSourceFilesAtPaths(resolve(projectRoot, app.sourceFilesGlob));
		} else {
			project.addSourceFileAtPath(resolve(projectRoot, app.entryFile));
		}

		const sourceFile = project.getSourceFile(
			resolve(projectRoot, app.entryFile),
		);
		if (!sourceFile) {
			console.error(`${appName} entry file not found`);
			continue;
		}

		const typeAlias = sourceFile.getTypeAlias(app.typeAliasName || "App");
		if (!typeAlias) {
			console.error(`${appName} type alias not found`);
			continue;
		}

		parts.push(
			`## ${appName[0].toUpperCase() + appName.slice(1)} API\n\n`,
			generateDocsFromType(
				typeAlias.getType(),
				typeAlias,
				"",
				sdkImport,
				sdkClientName,
				sdkClientOptions,
			),
			"\n",
		);
	}

	writeFileSync(outputPath, parts.join(""));
	console.log(`${outputPath} generated`);
}
