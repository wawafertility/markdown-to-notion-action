export function readInput(name: string, environmentFallbacks: string[]): string {
  const coreValue = process.env[`INPUT_${name.toUpperCase()}`];
  if (coreValue) {
    return coreValue.trim();
  }

  for (const environment of environmentFallbacks) {
    const value = process.env[environment];
    if (value) {
      return value.trim();
    }
  }

  return "";
}

export function normalizeTitlePrefixSeparator(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "→";
  }
  return trimmed;
}

export function isInputEnabled(value: string, isEnabledWhenBlank = false): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return isEnabledWhenBlank;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return isEnabledWhenBlank;
}

export function normalizePrivateMarkdownPrefix(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return "_";
  }
  if (["null", "none", "false"].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}
