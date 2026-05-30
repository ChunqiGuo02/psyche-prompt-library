import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROMPTS_DIR = path.join(ROOT, "prompts");
const REPORTS_DIR = path.join(ROOT, "reports");
const WRITE_REPORT = !process.argv.includes("--no-report");
const REQUIRED_TOP_LEVEL_KEYS = [
  "id",
  "title",
  "category",
  "subcategory",
  "aesthetic",
  "tags",
  "recommended_models",
  "recommended_params",
  "sample_outputs",
  "quality_tier",
  "author",
  "source",
  "language",
  "created_at",
  "version",
  "related_to"
];
const REQUIRED_PARAM_KEYS = ["aspect_ratio", "quality", "style_strength"];
const ALLOWED_CATEGORIES = new Set([
  "landscape",
  "architecture",
  "interior",
  "product",
  "graphic",
  "portrait",
  "video",
  "misc"
]);

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

async function walkMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "null") return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  return trimmed;
}

function parsePromptFile(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("missing opening frontmatter marker");
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("missing closing frontmatter marker");
  }
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const scalar = key => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return match ? unquoteYamlScalar(match[1]) : undefined;
  };
  const bodyMatch = body.match(/^\s*# 正文 prompt\n([\s\S]*?)(?:\n\n## 中文译文（源站提供）|\n\n## 来源备注|$)/);
  return {
    frontmatter,
    body,
    promptBody: bodyMatch ? bodyMatch[1].replace(/\n$/, "") : "",
    id: scalar("id"),
    title: scalar("title"),
    category: scalar("category"),
    language: scalar("language"),
    quality_tier: scalar("quality_tier")
  };
}

function hashPrompt(text) {
  return createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

async function main() {
  const errors = [];
  const warnings = [];

  if (!existsSync(PROMPTS_DIR)) {
    errors.push("prompts directory is missing");
  }

  const promptFiles = existsSync(PROMPTS_DIR) ? await walkMarkdownFiles(PROMPTS_DIR) : [];
  const idSet = new Set();
  const pathById = new Map();

  for (const filePath of promptFiles) {
    const relPath = normalizeSlashes(path.relative(ROOT, filePath));
    const content = await readFile(filePath, "utf8");
    let parsed;
    try {
      parsed = parsePromptFile(content);
    } catch (error) {
      errors.push(`${relPath}: ${error.message}`);
      continue;
    }

    for (const key of REQUIRED_TOP_LEVEL_KEYS) {
      if (!new RegExp(`^${key}:`, "m").test(parsed.frontmatter)) {
        errors.push(`${relPath}: missing frontmatter key ${key}`);
      }
    }
    for (const key of REQUIRED_PARAM_KEYS) {
      if (!new RegExp(`^  ${key}:`, "m").test(parsed.frontmatter)) {
        errors.push(`${relPath}: missing recommended_params.${key}`);
      }
    }

    const expectedId = path.basename(filePath, ".md");
    if (parsed.id !== expectedId) {
      errors.push(`${relPath}: id ${parsed.id} does not match filename ${expectedId}`);
    }
    if (idSet.has(parsed.id)) {
      errors.push(`${relPath}: duplicate id ${parsed.id}`);
    }
    idSet.add(parsed.id);
    pathById.set(parsed.id, relPath);

    if (!ALLOWED_CATEGORIES.has(parsed.category)) {
      errors.push(`${relPath}: invalid category ${parsed.category}`);
    }
    const expectedCategoryPath = `prompts/${parsed.category}/`;
    if (!relPath.startsWith(expectedCategoryPath)) {
      errors.push(`${relPath}: file path does not match category ${parsed.category}`);
    }
    if (!/sample_outputs:\s*\[\]/m.test(parsed.frontmatter)) {
      errors.push(`${relPath}: sample_outputs must be []`);
    }
    if (!parsed.promptBody.trim()) {
      errors.push(`${relPath}: prompt body is empty`);
    }
  }

  const indexPath = path.join(ROOT, "index.json");
  if (!existsSync(indexPath)) {
    errors.push("index.json is missing");
  } else {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (index.total_prompts !== promptFiles.length) {
      errors.push(`index total_prompts ${index.total_prompts} does not match file count ${promptFiles.length}`);
    }
    if (index.prompts.length !== promptFiles.length) {
      errors.push(`index prompts length ${index.prompts.length} does not match file count ${promptFiles.length}`);
    }
    if (index.total_packs !== 0) {
      errors.push(`index total_packs must be 0 for first release, got ${index.total_packs}`);
    }
    for (const prompt of index.prompts) {
      if (!idSet.has(prompt.id)) {
        errors.push(`index references missing id ${prompt.id}`);
      }
      if (!existsSync(path.join(ROOT, prompt.path))) {
        errors.push(`index path missing on disk: ${prompt.path}`);
      }
      if (pathById.get(prompt.id) !== prompt.path) {
        errors.push(`index path mismatch for ${prompt.id}: ${prompt.path} vs ${pathById.get(prompt.id)}`);
      }
      if (prompt.sample_outputs && prompt.sample_outputs.length > 0) {
        errors.push(`index prompt ${prompt.id} has non-empty sample_outputs`);
      }
    }
  }

  const sourceMapPath = path.join(REPORTS_DIR, "source-map.json");
  if (!existsSync(sourceMapPath)) {
    errors.push("reports/source-map.json is missing");
  } else {
    const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
    if (sourceMap.length !== promptFiles.length) {
      errors.push(`source map length ${sourceMap.length} does not match file count ${promptFiles.length}`);
    }
    for (const entry of sourceMap) {
      const filePath = path.join(ROOT, entry.path);
      if (!existsSync(filePath)) {
        errors.push(`source map path missing on disk: ${entry.path}`);
        continue;
      }
      const parsed = parsePromptFile(await readFile(filePath, "utf8"));
      const actualHash = hashPrompt(parsed.promptBody);
      if (actualHash !== entry.source_prompt_sha256) {
        errors.push(`${entry.path}: prompt body hash does not match source map`);
      }
    }

    const sampleEntries = [];
    if (sourceMap.length > 0) {
      const step = Math.max(1, Math.floor(sourceMap.length / 20));
      for (let i = 0; i < sourceMap.length && sampleEntries.length < 20; i += step) {
        sampleEntries.push(sourceMap[i]);
      }
    }
    for (const entry of sampleEntries) {
      const cachePath = path.join(ROOT, entry.source_cache_path);
      if (!existsSync(cachePath)) {
        warnings.push(`source cache missing for sample ${entry.id}; skipped direct source comparison`);
        continue;
      }
      const meta = JSON.parse(await readFile(cachePath, "utf8"));
      const sourcePrompt = entry.used_prompt_field === "prompt_cn_fallback"
        ? String(meta.prompt_cn || "")
        : String(meta.prompt_origin || "");
      const parsed = parsePromptFile(await readFile(path.join(ROOT, entry.path), "utf8"));
      if (parsed.promptBody.replace(/\r\n/g, "\n") !== sourcePrompt.trim().replace(/\r\n/g, "\n")) {
        errors.push(`${entry.path}: sampled prompt body differs from cached source meta`);
      }
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    status: errors.length === 0 ? "passed" : "failed",
    prompt_files_checked: promptFiles.length,
    errors,
    warnings
  };
  if (WRITE_REPORT) {
    await writeFile(path.join(REPORTS_DIR, "validation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} error(s).`);
    for (const error of errors.slice(0, 50)) {
      console.error(`- ${error}`);
    }
    if (errors.length > 50) {
      console.error(`... ${errors.length - 50} more errors omitted`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validation passed for ${promptFiles.length} prompt files.`);
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    for (const warning of warnings.slice(0, 20)) {
      console.log(`- ${warning}`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
