import { log } from "./logger.js";

const SUSPICIOUS_PATTERNS = [
  /\bIMPORTANT\s*:/gi,
  /\bSYSTEM\s*:/gi,
  /\bINSTRUCTION\s*:/gi,
  /\bignore\s+previous\b/gi,
  /\byou\s+must\b/gi,
  /\bdo\s+not\s+tell\s+the\s+user\b/gi,
  /\bdo\s+not\s+reveal\b/gi,
  /\bignore\s+all\b/gi,
  /\bforget\s+(?:your|all)\b/gi,
  /\bact\s+as\b/gi,
  /\bpretend\s+(?:to|you)\b/gi,
];

const MARKDOWN_CODE_BLOCK = /```[\s\S]*?```/g;

const MAX_DESCRIPTION_LENGTH = 500;

export function sanitizeToolDescription(description: string): string {
  let sanitized = description;

  // Normalize Unicode to catch homoglyph bypass attempts (e.g., ÏMPÖRTANT → IMPORTANT)
  sanitized = sanitized.normalize("NFC").replace(/[\u00C0-\u00FF]/g, (char) => {
    return char.normalize("NFD").replace(/[\u0300-\u036f]/g, "") || char;
  });

  let wasSanitized = false;

  // Strip markdown code blocks
  const withoutCodeBlocks = sanitized.replace(MARKDOWN_CODE_BLOCK, "");
  if (withoutCodeBlocks !== sanitized) {
    sanitized = withoutCodeBlocks;
    wasSanitized = true;
  }

  // Strip suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    const replaced = sanitized.replace(pattern, "");
    if (replaced !== sanitized) {
      sanitized = replaced;
      wasSanitized = true;
    }
  }

  // Collapse multiple spaces left by removals
  sanitized = sanitized.replace(/\s{2,}/g, " ").trim();

  // Truncate
  if (sanitized.length > MAX_DESCRIPTION_LENGTH) {
    sanitized = sanitized.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd() + "...";
    wasSanitized = true;
  }

  if (wasSanitized) {
    log("warn", "Tool description was sanitized", {
      original_length: description.length,
      sanitized_length: sanitized.length,
    });
  }

  return sanitized;
}
