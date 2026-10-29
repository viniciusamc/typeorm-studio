import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = fileURLToPath(new URL('../../src/', import.meta.url));
const typeormDirectory = path.join(sourceDirectory, 'typeorm');
const drizzleDirectory = path.join(sourceDirectory, 'drizzle');
const cliDirectory = path.join(sourceDirectory, 'cli');

type Side = 'typeorm' | 'drizzle';

type SourceImport = {
  readonly file: string;
  readonly specifier: string;
};

const specifierPatterns: readonly RegExp[] = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function listSourceFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(?:ts|cts|mts|js|cjs|mjs)$/.test(entry))
    .map((entry) => path.join(directory, entry));
}

function extractSpecifiers(sourceText: string): string[] {
  const withoutComments = sourceText
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return specifierPatterns.flatMap((pattern) =>
    Array.from(withoutComments.matchAll(pattern), (match) => match[1] ?? ''),
  );
}

function readSourceImports(): SourceImport[] {
  return listSourceFiles(sourceDirectory).flatMap((file) =>
    extractSpecifiers(fs.readFileSync(file, 'utf8')).map((specifier) => ({
      file,
      specifier,
    })),
  );
}

function isInside(directory: string, target: string): boolean {
  return target.startsWith(directory + path.sep);
}

function isPackage(specifier: string, names: readonly string[]): boolean {
  return names.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function findImportedSide(entry: SourceImport): Side | undefined {
  const { file, specifier } = entry;
  if (isPackage(specifier, ['drizzle-kit', 'drizzle-orm'])) return 'drizzle';
  if (isPackage(specifier, ['typeorm', 'typeorm-0.3'])) return 'typeorm';
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(file), specifier);
  if (isInside(drizzleDirectory, resolved)) return 'drizzle';
  if (isInside(typeormDirectory, resolved)) return 'typeorm';
  return undefined;
}

function describeViolation(entry: SourceImport, reason: string): string {
  return `${path.relative(sourceDirectory, entry.file)} imports '${entry.specifier}': ${reason}`;
}

describe('import boundary between the TypeORM connector and Drizzle', () => {
  const imports = readSourceImports();

  it('extracts every import form it must police', () => {
    const found = extractSpecifiers(`
      import { a } from 'static-named';
      import type {
        B,
      } from "static-multiline";
      export * from './re-export.ts';
      import 'side-effect';
      const lazy = await import('dynamic');
      const legacy = require('commonjs');
      // import { c } from 'commented-out';
    `);

    expect(found).toEqual(
      expect.arrayContaining([
        'static-named',
        'static-multiline',
        './re-export.ts',
        'side-effect',
        'dynamic',
        'commonjs',
      ]),
    );
    expect(found).not.toContain('commented-out');
  });

  it('scans both sides of the boundary', () => {
    const scannedFiles = new Set(imports.map((entry) => entry.file));

    expect(listSourceFiles(typeormDirectory).length).toBeGreaterThan(0);
    expect(listSourceFiles(drizzleDirectory).length).toBeGreaterThan(0);
    expect(scannedFiles.size).toBeGreaterThan(0);
  });

  it('keeps src/typeorm free of Drizzle', () => {
    const violations = imports
      .filter((entry) => isInside(typeormDirectory, entry.file))
      .filter((entry) => findImportedSide(entry) === 'drizzle')
      .map((entry) =>
        describeViolation(entry, 'src/typeorm must not use Drizzle'),
      );

    expect(violations).toEqual([]);
  });

  it('keeps src/drizzle free of TypeORM', () => {
    const violations = imports
      .filter((entry) => isInside(drizzleDirectory, entry.file))
      .filter((entry) => findImportedSide(entry) === 'typeorm')
      .map((entry) =>
        describeViolation(entry, 'src/drizzle must not use TypeORM'),
      );

    expect(violations).toEqual([]);
  });

  it('lets only src/cli import from both sides', () => {
    const sidesByFile = new Map<string, Map<Side, SourceImport>>();
    for (const entry of imports) {
      const side = findImportedSide(entry);
      if (side === undefined || isInside(cliDirectory, entry.file)) continue;
      const sides =
        sidesByFile.get(entry.file) ?? new Map<Side, SourceImport>();
      sides.set(side, sides.get(side) ?? entry);
      sidesByFile.set(entry.file, sides);
    }

    const violations = Array.from(sidesByFile.values())
      .filter((sides) => sides.size === 2)
      .flatMap((sides) =>
        Array.from(sides.values(), (entry) =>
          describeViolation(entry, 'only src/cli may import from both sides'),
        ),
      );

    expect(violations).toEqual([]);
  });
});
