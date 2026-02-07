import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Project, type Type, type TypeAliasDeclaration } from "ts-morph";

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
	sourceFilesGlob: string;
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
			const routeTypes: Record<string, string> = {
				body: "unknown",
				params: "{}",
				query: "unknown",
				response: "{}",
			};

			for (const methodProp of propType.getProperties()) {
				const key = methodProp.getName();
				if (key in routeTypes) {
					routeTypes[key] = methodProp.getTypeAtLocation(typeAlias).getText();
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
		project.addSourceFilesAtPaths(resolve(projectRoot, app.sourceFilesGlob));

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
