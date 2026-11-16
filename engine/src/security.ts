const likelySecretPatterns: Array<{name: string; pattern: RegExp}> = [
  {name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/},
  {name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i},
  {name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/},
  {name: "credential-assignment", pattern: /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/i}
];

export function assertNoLikelySecret(value: string, source: string): void {
  for (const candidate of likelySecretPatterns) {
    if (candidate.pattern.test(value)) {
      throw new Error(`likely secret detected in ${source}: ${candidate.name}`);
    }
  }
}
