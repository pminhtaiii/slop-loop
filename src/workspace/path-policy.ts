/** Parse a model-supplied repository alias without permitting platform-dependent rewrites. */
export function parseRepositoryPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value) ||
    value.startsWith("//")
  )
    return null;
  if (value === ".") return value;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return value;
}

/** Apply default secret and Git metadata denials to an alias and again to its resolved target. */
export function isDeniedRepositoryPath(relativePath: string): boolean {
  const components = relativePath.toLowerCase().split("/");
  return components.some(
    (part) =>
      part === ".git" ||
      part === ".aws" ||
      part === ".ssh" ||
      part === ".env" ||
      part.startsWith(".env.") ||
      part.endsWith(".pem") ||
      part.endsWith(".key") ||
      part === "id_rsa" ||
      part === "id_ed25519",
  );
}
