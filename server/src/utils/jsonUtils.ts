/**
 * Robustly parse JSON from string that might contain markdown code blocks or extra text.
 */
export function safeJsonParse<T = any>(text: string): T {
  let cleaned = text.trim();
  
  // 1. Strip markdown code blocks if present
  if (cleaned.includes('```')) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      cleaned = match[1];
    }
  }

  // 2. Remove possible leading/trailing junk
  cleaned = cleaned.trim();
  
  // 3. Handle common LLM escaping issues
  // Sometimes models escape characters that shouldn't be escaped in raw JSON
  // but we try a direct parse first.
  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    // Attempt second level of cleaning: find the first '[' or '{' and last ']' or '}'
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      end = cleaned.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      start = firstBracket;
      end = cleaned.lastIndexOf(']');
    }

    if (start !== -1 && end !== -1 && end > start) {
      const extracted = cleaned.substring(start, end + 1);
      try {
        return JSON.parse(extracted);
      } catch (innerErr: any) {
        throw new Error(`Failed to parse JSON even after extraction. Original error: ${err.message}. Content: ${extracted.substring(0, 100)}...`);
      }
    }
    
    throw err;
  }
}
