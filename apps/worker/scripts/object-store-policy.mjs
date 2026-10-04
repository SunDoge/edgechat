/**
 * Keep provider bindings behind the exact-key ObjectStore boundary. This is a
 * source policy, not a usage counter: tests may inspect R2 directly, while
 * production modules must not gain a LIST/discovery escape hatch.
 */
function objectStoreContract(source) {
  const declaration = source.search(/export\s+interface\s+ObjectStore\b/);
  if (declaration < 0) return "";
  const opening = source.indexOf("{", declaration);
  if (opening < 0) return "";
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(opening + 1, index);
  }
  return "";
}

export function objectStoreBoundaryViolations(sources) {
  const violations = [];
  for (const { file, source } of sources) {
    const adapter = file.endsWith("/object-store.ts") || file === "object-store.ts";
    const bindingTypes = file.endsWith("/env.ts") || file === "env.ts";
    if (!adapter && /(?:\.ARCHIVE\b|\[\s*["']ARCHIVE["']\s*\])/.test(source)) {
      violations.push(`${file}: direct ARCHIVE binding access is restricted to object-store.ts`);
    }
    if (!adapter && /\{[^}]*\bARCHIVE\b[^}]*\}\s*=/.test(source)) {
      violations.push(`${file}: destructuring the ARCHIVE binding is restricted to object-store.ts`);
    }
    if (!adapter && (/\bR2ObjectStore\b/.test(source) || (!bindingTypes && /\bR2Bucket\b/.test(source)))) {
      violations.push(`${file}: native R2 types and adapters are restricted to object-store.ts`);
    }
    if (adapter) {
      if (/(?:^|[;\n])\s*list\s*\(/.test(objectStoreContract(source))) {
        violations.push(`${file}: ObjectStore must remain exact-key-only and cannot expose list()`);
      }
    }
  }
  return [...new Set(violations)];
}
