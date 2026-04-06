import * as vm from "node:vm";

export function truncate(text: string, maxLength = 6000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

export function extractJsonObject(raw: string): unknown {
  const normalized = normalizeJsonSource(raw);
  const direct = tryParseJsonWithRepair(normalized);
  if (direct !== undefined) {
    return direct;
  }

  const candidates = extractBalancedJsonObjects(normalized);
  for (const candidate of candidates) {
    const parsed = tryParseJsonWithRepair(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = normalized.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJsonWithRepair(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error("Model response is not valid JSON.");
}

function normalizeJsonSource(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function tryParseJsonWithRepair(text: string): unknown | undefined {
  const attempts: string[] = [];
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  attempts.push(normalized);
  attempts.push(normalized.replace(/,\s*([}\]])/g, "$1"));
  attempts.push(
    normalized
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([}\]])/g, "$1")
  );

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }

  return tryParseLooseObjectLiteral(normalized);
}

function tryParseLooseObjectLiteral(text: string): unknown | undefined {
  const source = text.trim();
  if (!source.startsWith("{") || !source.endsWith("}")) {
    return undefined;
  }

  // Defensive: only allow object-literal-ish payloads for fallback parsing.
  const forbidden = /\b(?:function|=>|new\s+|while\s*\(|for\s*\(|process\.|require\s*\(|globalThis)\b/;
  if (forbidden.test(source)) {
    return undefined;
  }

  try {
    const script = new vm.Script(`(${source})`);
    return script.runInNewContext(Object.create(null), { timeout: 40 });
  } catch {
    return undefined;
  }
}

function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth <= 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}

export function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

export function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function toNumberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
