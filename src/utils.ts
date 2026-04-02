export function truncate(text: string, maxLength = 6000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const inner = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, "").trim();
    return extractJsonObject(inner);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to brace extraction.
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error("Model response is not valid JSON.");
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
