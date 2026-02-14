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

/**
 * Resolves a ts-morph Type to a concise TypeScript type string, preventing
 * the compiler from fully expanding well-known generic interfaces such as
 * `Array`, `Promise`, `Map`, etc.
 */
function resolveTypeText(
	type: Type,
	enclosingNode: TypeAliasDeclaration,
): string {
	// Array<T> / T[]
	if (type.isArray()) {
		const elementType = type.getArrayElementType();
		if (!elementType) return "unknown[]";
		const inner = resolveTypeText(elementType, enclosingNode);
		// Wrap union/intersection element types in Array<> for clarity
		if (elementType.isUnion() || elementType.isIntersection()) {
			return `Array<${inner}>`;
		}
		return `${inner}[]`;
	}

	// Tuple types
	if (type.isTuple()) {
		const elements = type
			.getTupleElements()
			.map((t) => resolveTypeText(t, enclosingNode));
		return `[${elements.join(", ")}]`;
	}

	// Union types
	if (type.isUnion()) {
		const parts = type
			.getUnionTypes()
			.map((t) => resolveTypeText(t, enclosingNode));
		return parts.join(" | ");
	}

	// Intersection types
	if (type.isIntersection()) {
		const parts = type
			.getIntersectionTypes()
			.map((t) => resolveTypeText(t, enclosingNode));
		return parts.join(" & ");
	}

	// Preserve well-known generic types (Promise<T>, Map<K,V>, etc.)
	const symbol = type.getSymbol() ?? type.getAliasSymbol();
	if (symbol) {
		const name = symbol.getName();
		const typeArgs =
			type.getTypeArguments().length > 0
				? type.getTypeArguments()
				: type.getAliasTypeArguments();

		if (KNOWN_GENERICS.has(name) && typeArgs.length > 0) {
			const args = typeArgs.map((t) => resolveTypeText(t, enclosingNode));
			return `${name}<${args.join(", ")}>`;
		}
	}

	return type.getText(
		enclosingNode,
		TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
			| TypeFormatFlags.NoTruncation,
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

	return chunks.join("").trim();
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
			`const params = ${paramsType.replace(/: string/g, ': "example-value"')};\n`,
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
	return `**${label}:**\n\n\`\`\`typescript\n${prettyPrintType(typeStr)}\`\`\`\n\n`;
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
