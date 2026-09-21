import { readFileSync } from "node:fs";
import { skillCatalog, skillReferences } from "./skills";
// Small POSIX ustar archive; only these project-owned paths can be downloaded.
export function skillBundle() {
  const files = [
    ...skillCatalog.map((s) => `skills/${s.id}/SKILL.md`),
    ...Object.entries(skillReferences).flatMap(([id, files]) => files.map((file) => `skills/${id}/${file}`)),
    "skills/PROVENANCE.md",
    "skills/THIRD-PARTY-NOTICES.md",
    "skills/draftdesk-submit/scripts/submit.py",
    "skills/draftdesk-submit/references/intake-example.json",
  ];
  const chunks: Buffer[] = [];
  for (const file of files) {
    const data = readFileSync(file),
      header = Buffer.alloc(512);
    header.write(file, 0, 100);
    const octal = (n: number, len: number) =>
      n.toString(8).padStart(len - 1, "0") + "\0";
    header.write(octal(0o644, 8), 100, 8);
    header.write(octal(0, 8), 108, 8);
    header.write(octal(0, 8), 116, 8);
    header.write(octal(data.length, 12), 124, 12);
    header.write(octal(0, 12), 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
