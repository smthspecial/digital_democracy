import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function validateExceptions(entries, read = (path) => readFileSync(path), now = new Date()) {
  const identities = new Set();
  for (const entry of entries) {
    if (!entry.package || !entry.version || !entry.advisory || !entry.cve || !entry.owner ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy) ||
        Date.parse(`${entry.reviewBy}T23:59:59Z`) < now.getTime() ||
        !Number.isFinite(Date.parse(entry.reviewBy)) ||
        createHash('sha256').update(read(entry.patch)).digest('hex') !== entry.sha256) {
      throw new Error(`Invalid, expired or changed security exception: ${entry.advisory}`);
    }
    const identity = `${entry.package}:${entry.version}:${entry.advisory}`;
    if (identities.has(identity)) throw new Error(`Duplicate exception: ${identity}`);
    identities.add(identity);
  }
  return entries;
}

export function unmitigatedAdvisories(report, entries) {
  if (!report.metadata || !report.advisories) throw new Error('Invalid dependency scanner report');
  return Object.values(report.advisories).filter((advisory) => !entries.some((entry) =>
    entry.advisory === advisory.github_advisory_id && entry.package === advisory.module_name &&
    advisory.findings.length > 0 && advisory.findings.every((finding) => finding.version === entry.version)));
}
