import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectModuleSystem } from '../../src/typeorm/typescript-hooks.ts';

const execFileAsync = promisify(execFile);

const hooksFile = fileURLToPath(
  new URL('../../src/typeorm/typescript-hooks.ts', import.meta.url),
);

type RunReport = {
  readonly exported: unknown;
  readonly recordedMetadata: readonly string[];
  readonly failure:
    | {
        readonly name: string;
        readonly code: string | undefined;
        readonly message: string;
        readonly stack: string;
      }
    | undefined;
  readonly typescriptLoaded: boolean;
};

// The hooks are process-wide, so each scenario runs in its own node process.
const runnerSource = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [hooksFile, packageDir, entry, mode] = process.argv.slice(2);
const recordedMetadata = [];
Reflect.metadata = (key, value) => (target, propertyKey) => {
  recordedMetadata.push(key + ':' + String(propertyKey) + '=' + (typeof value === 'function' ? value.name : String(value)));
};
const { installTypescriptHooks } = await import(pathToFileURL(hooksFile).href);
process.chdir(packageDir);
installTypescriptHooks({ packageDir });
const requireFromRunner = createRequire(import.meta.url);
let exported;
let failure;
try {
  const loaded = mode === 'require' ? requireFromRunner(entry) : await import(pathToFileURL(entry).href);
  exported = loaded.default;
} catch (error) {
  failure = { name: error.name, code: error.code, message: String(error.message).split('\\n')[0], stack: String(error.stack) };
}
const typescriptLoaded = Object.keys(requireFromRunner.cache).some((key) => key.endsWith('/typescript/lib/typescript.js'));
process.stdout.write(JSON.stringify({ exported, recordedMetadata, failure, typescriptLoaded }));
`;

let scratchRoot = '';
let runnerFile = '';

beforeAll(() => {
  scratchRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-')),
  );
  runnerFile = path.join(scratchRoot, 'runner.mjs');
  fs.writeFileSync(runnerFile, runnerSource);
});

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function writeProject(
  name: string,
  files: Readonly<Record<string, string>>,
): string {
  const projectDir = path.join(scratchRoot, name);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return projectDir;
}

async function runWithHooks(
  projectDir: string,
  entry: string,
  mode: 'import' | 'require',
): Promise<RunReport> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runnerFile, hooksFile, projectDir, path.join(projectDir, entry), mode],
    { env: { PATH: process.env.PATH ?? '' } },
  );
  return JSON.parse(stdout) as RunReport;
}

describe('installTypescriptHooks on an ESM project', () => {
  it('compiles decorators, enums, parameter properties and .js specifiers written for .ts files', async () => {
    const projectDir = writeProject('esm-project', {
      'package.json': '{ "type": "module" }',
      'tsconfig.json': `{
        // comments are allowed in tsconfig files
        "compilerOptions": {
          "module": "nodenext",
          "moduleResolution": "nodenext",
          "target": "ES2023",
          "experimentalDecorators": true,
          "emitDecoratorMetadata": true,
        },
      }`,
      'src/main.ts': `
        import { Holder, Status } from './holder.js';
        import { directoryValue } from './directory';
        import settings from './settings.json';

        function Track(): PropertyDecorator {
          return () => {};
        }

        class Sample {
          @Track()
          title!: string;

          @Track()
          holder!: Holder;

          constructor(private readonly label: string) {}

          describe(): string {
            return this.label + ':' + Status.Active + ':' + directoryValue + ':' + settings.answer;
          }
        }

        export default {
          description: new Sample('label').describe(),
          dirname: import.meta.dirname,
        };
      `,
      'src/holder.ts': `
        export enum Status {
          Active = 'active',
        }
        export class Holder {}
      `,
      'src/directory/index.ts': `export const directoryValue: string = 'from-index';`,
      'src/settings.json': '{ "answer": 42 }',
    });

    const report = await runWithHooks(projectDir, 'src/main.ts', 'import');

    expect(report.failure).toBeUndefined();
    expect(report.exported).toEqual({
      description: 'label:active:from-index:42',
      dirname: path.join(projectDir, 'src'),
    });
    expect(report.recordedMetadata).toEqual([
      'design:type:title=String',
      'design:type:holder=Holder',
    ]);
  });

  it('maps stack frames of compiled files back to the TypeScript line', async () => {
    const projectDir = writeProject('esm-stack', {
      'package.json': '{ "type": "module" }',
      'src/boom.ts': [
        'export const prelude: number = 1;',
        '',
        'export function explode(): never {',
        "  throw new Error('boom');",
        '}',
        'explode();',
      ].join('\n'),
    });

    const report = await runWithHooks(projectDir, 'src/boom.ts', 'import');

    expect(report.failure?.message).toBe('boom');
    expect(report.failure?.stack).toContain(
      `${path.join(projectDir, 'src', 'boom.ts')}:4:`,
    );
  });
});

describe('installTypescriptHooks on a CommonJS project', () => {
  it('resolves baseUrl and paths aliases, extensionless imports and directory imports', async () => {
    const projectDir = writeProject('cjs-project', {
      'package.json': '{ "name": "cjs-project" }',
      'tsconfig.json': `{
        "compilerOptions": {
          "module": "commonjs",
          "target": "ES2021",
          "baseUrl": "./",
          "paths": { "@lib/*": ["src/lib/*"] },
          "experimentalDecorators": true,
          "emitDecoratorMetadata": true
        }
      }`,
      'src/main.ts': `
        import { join } from 'path';
        import { fromBaseUrl } from 'src/shared/base-url';
        import { fromPaths } from '@lib/paths-target';
        import { fromRelative } from './relative/file';
        import { fromDirectory } from './directory';

        export default {
          where: join(__dirname, 'x'),
          fromBaseUrl,
          fromPaths,
          fromRelative,
          fromDirectory,
        };
      `,
      'src/shared/base-url.ts': `export const fromBaseUrl: string = 'base-url';`,
      'src/lib/paths-target.ts': `export const fromPaths: string = 'paths';`,
      'src/relative/file.ts': `export const fromRelative: string = 'relative';`,
      'src/directory/index.ts': `export const fromDirectory: string = 'directory';`,
    });

    const report = await runWithHooks(projectDir, 'src/main.ts', 'require');

    expect(report.failure).toBeUndefined();
    expect(report.exported).toEqual({
      where: path.join(projectDir, 'src', 'x'),
      fromBaseUrl: 'base-url',
      fromPaths: 'paths',
      fromRelative: 'relative',
      fromDirectory: 'directory',
    });
  });

  it('reads settings inherited through extends, with baseUrl relative to the file that declares it', async () => {
    const workspaceDir = writeProject('cjs-extends', {
      'tsconfig.base.json': `{
        "compilerOptions": {
          "module": "commonjs",
          "baseUrl": "./app",
          "experimentalDecorators": true,
          "emitDecoratorMetadata": true
        }
      }`,
      'app/package.json': '{ "name": "cjs-extends-app" }',
      'app/tsconfig.json': '{ "extends": "../tsconfig.base.json" }',
      'app/src/main.ts': `
        import { aliased } from 'src/aliased';

        function Track(): PropertyDecorator {
          return () => {};
        }

        class Sample {
          @Track()
          title!: string;
        }

        export default { aliased, sample: Sample.name };
      `,
      'app/src/aliased.ts': `export const aliased: string = 'aliased-through-extends';`,
    });

    const report = await runWithHooks(
      path.join(workspaceDir, 'app'),
      'src/main.ts',
      'require',
    );

    expect(report.failure).toBeUndefined();
    expect(report.exported).toEqual({
      aliased: 'aliased-through-extends',
      sample: 'Sample',
    });
    expect(report.recordedMetadata).toEqual(['design:type:title=String']);
  });

  it('resolves paths aliases declared without a baseUrl, also for .js specifiers in ESM', async () => {
    const esmProject = writeProject('esm-paths-only', {
      'package.json': '{ "type": "module" }',
      'tsconfig.json': `{
        "compilerOptions": {
          "module": "nodenext",
          "moduleResolution": "nodenext",
          "paths": { "@lib/*": ["./src/lib/*"] }
        }
      }`,
      'src/main.ts': `
        import { fromPaths } from '@lib/target.js';

        export default fromPaths;
      `,
      'src/lib/target.ts': `export const fromPaths: string = 'esm-paths';`,
    });
    const cjsProject = writeProject('cjs-paths-only', {
      'package.json': '{ "name": "cjs-paths-only" }',
      'tsconfig.json': `{
        "compilerOptions": {
          "module": "commonjs",
          "paths": { "@lib/*": ["./src/lib/*"] }
        }
      }`,
      'src/main.ts': `
        import { fromPaths } from '@lib/target';

        export default fromPaths;
      `,
      'src/lib/target.ts': `export const fromPaths: string = 'cjs-paths';`,
    });

    const esmReport = await runWithHooks(esmProject, 'src/main.ts', 'import');
    const cjsReport = await runWithHooks(cjsProject, 'src/main.ts', 'require');

    expect(esmReport.failure).toBeUndefined();
    expect(esmReport.exported).toBe('esm-paths');
    expect(cjsReport.failure).toBeUndefined();
    expect(cjsReport.exported).toBe('cjs-paths');
  });

  it('survives circular imports between decorated classes', async () => {
    const projectDir = writeProject('cjs-circular', {
      'package.json': '{ "name": "cjs-circular" }',
      'tsconfig.json': `{
        "compilerOptions": {
          "module": "commonjs",
          "experimentalDecorators": true,
          "emitDecoratorMetadata": true
        }
      }`,
      'src/main.ts': `
        import { Left } from './left';
        import { Right } from './right';

        export default { left: Left.name, right: Right.name };
      `,
      'src/left.ts': `
        import { Right } from './right';

        function Mark(): PropertyDecorator {
          return () => {};
        }

        export class Left {
          @Mark()
          other!: Right;
        }
      `,
      'src/right.ts': `
        import { Left } from './left';

        function Mark(): PropertyDecorator {
          return () => {};
        }

        export class Right {
          @Mark()
          other!: Left;
        }
      `,
    });

    const report = await runWithHooks(projectDir, 'src/main.ts', 'require');

    expect(report.failure).toBeUndefined();
    expect(report.exported).toEqual({ left: 'Left', right: 'Right' });
    expect(report.recordedMetadata).toEqual([
      'design:type:other=Object',
      'design:type:other=Right',
    ]);
  });
});

describe('installTypescriptHooks configuration', () => {
  it('turns on decorators and their metadata when the project has no tsconfig', async () => {
    const projectDir = writeProject('no-tsconfig', {
      'package.json': '{ "name": "no-tsconfig" }',
      'src/main.ts': `
        function Track(): PropertyDecorator {
          return () => {};
        }

        class Sample {
          @Track()
          title!: string;
        }

        export default new Sample().constructor.name;
      `,
    });

    const report = await runWithHooks(projectDir, 'src/main.ts', 'require');

    expect(report.failure).toBeUndefined();
    expect(report.exported).toBe('Sample');
    expect(report.recordedMetadata).toEqual(['design:type:title=String']);
  });

  it('applies the tsconfig of the DataSource package to TypeScript files outside it that have none', async () => {
    const workspaceDir = writeProject('package-fallback', {
      'app/package.json': '{ "name": "app" }',
      'app/tsconfig.json': `{
        "compilerOptions": {
          "module": "commonjs",
          "experimentalDecorators": true,
          "emitDecoratorMetadata": false
        }
      }`,
      'app/src/main.ts': `
        import { Outsider } from '../../library/outsider';

        export default Outsider.name;
      `,
      'library/outsider.ts': `
        function Track(): PropertyDecorator {
          return () => {};
        }

        export class Outsider {
          @Track()
          title!: string;
        }
      `,
    });

    const report = await runWithHooks(
      path.join(workspaceDir, 'app'),
      'src/main.ts',
      'require',
    );

    expect(report.failure).toBeUndefined();
    expect(report.exported).toBe('Outsider');
    expect(report.recordedMetadata).toEqual([]);
  });

  it('lets the extension decide the module system of .mts and .cts files', async () => {
    const commonjsPackage = writeProject('extension-in-commonjs-package', {
      'package.json': '{ "name": "extension-in-commonjs-package" }',
      'main.mts': `export default typeof import.meta.url;`,
    });
    const modulePackage = writeProject('extension-in-module-package', {
      'package.json': '{ "type": "module" }',
      'main.cts': `export default typeof __dirname;`,
    });

    const moduleReport = await runWithHooks(
      commonjsPackage,
      'main.mts',
      'import',
    );
    const commonjsReport = await runWithHooks(
      modulePackage,
      'main.cts',
      'require',
    );

    expect(moduleReport.exported).toBe('string');
    expect(commonjsReport.exported).toBe('string');
  });

  it('stops with a pointer to the tsconfig when a file it extends is missing', async () => {
    const relativeProject = writeProject('broken-relative-extends', {
      'package.json': '{ "name": "broken-relative-extends" }',
      'tsconfig.json': '{ "extends": "./missing-base.json" }',
      'src/main.ts': `export default 1;`,
    });
    const packageProject = writeProject('broken-package-extends', {
      'package.json': '{ "name": "broken-package-extends" }',
      'tsconfig.json': '{ "extends": "@fixture/not-installed/tsconfig.json" }',
      'src/main.ts': `export default 1;`,
    });

    const relativeReport = await runWithHooks(
      relativeProject,
      'src/main.ts',
      'require',
    );
    const packageReport = await runWithHooks(
      packageProject,
      'src/main.ts',
      'require',
    );

    expect(relativeReport.failure?.message).toContain('TS5083');
    expect(relativeReport.failure?.message).toContain(
      path.join(relativeProject, 'tsconfig.json'),
    );
    expect(packageReport.failure?.message).toContain('TS6053');
    expect(packageReport.failure?.message).toContain(
      path.join(packageProject, 'tsconfig.json'),
    );
  });
});

describe('installTypescriptHooks scope', () => {
  it('compiles a workspace package linked into node_modules but not a real node_modules source', async () => {
    const workspaceDir = writeProject('workspace', {
      'packages/shared/package.json':
        '{ "name": "@fixture/shared", "type": "module", "exports": "./src/index.ts" }',
      'packages/shared/src/index.ts': `export const sharedValue: string = 'from-workspace-package';`,
      'app/package.json': '{ "name": "app", "type": "module" }',
      'app/src/linked.ts': `
        import { sharedValue } from '@fixture/shared';
        export default sharedValue;
      `,
      'app/src/vendored.ts': `
        import { vendoredValue } from 'vendored-source';
        export default vendoredValue;
      `,
      'app/node_modules/vendored-source/package.json':
        '{ "name": "vendored-source", "type": "module", "exports": "./index.ts" }',
      'app/node_modules/vendored-source/index.ts': `export const vendoredValue: string = 'vendored';`,
    });
    const appDir = path.join(workspaceDir, 'app');
    fs.mkdirSync(path.join(appDir, 'node_modules', '@fixture'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(workspaceDir, 'packages', 'shared'),
      path.join(appDir, 'node_modules', '@fixture', 'shared'),
      'dir',
    );

    const linked = await runWithHooks(appDir, 'src/linked.ts', 'import');
    const vendored = await runWithHooks(appDir, 'src/vendored.ts', 'import');

    expect(linked.failure).toBeUndefined();
    expect(linked.exported).toBe('from-workspace-package');
    expect(vendored.failure?.code).toMatch(
      /^ERR_(UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|UNKNOWN_FILE_EXTENSION)$/,
    );
  });

  it('leaves JavaScript projects alone and does not load typescript for them', async () => {
    const projectDir = writeProject('javascript-only', {
      'package.json': '{ "name": "javascript-only" }',
      'main.js': `
        const { helper } = require('./lib/helper');
        let optional = 'resolved';
        try {
          require('fixture-optional-package-that-is-not-installed');
        } catch (error) {
          optional = error.code;
        }
        module.exports = { default: { helper, optional } };
      `,
      'lib/helper.js': `exports.helper = 'plain-javascript';`,
    });

    const report = await runWithHooks(projectDir, 'main.js', 'require');

    expect(report.failure).toBeUndefined();
    expect(report.exported).toEqual({
      helper: 'plain-javascript',
      optional: 'MODULE_NOT_FOUND',
    });
    expect(report.typescriptLoaded).toBe(false);
  });

  it('keeps the original resolution error when no source file matches', async () => {
    const projectDir = writeProject('unresolvable', {
      'package.json': '{ "type": "module" }',
      'src/main.ts': `
        import './missing.js';
        export default 1;
      `,
    });

    const report = await runWithHooks(projectDir, 'src/main.ts', 'import');

    expect(report.failure?.code).toBe('ERR_MODULE_NOT_FOUND');
    expect(report.failure?.message).toContain('missing.js');
  });
});

describe('detectModuleSystem', () => {
  it('follows the extension first and the nearest package.json type after that', () => {
    const typelessDir = writeProject('detect-typeless', {
      'package.json': '{ "name": "typeless" }',
      'nested/deeper/file.ts': '',
    });
    const moduleDir = writeProject('detect-module', {
      'package.json': '{ "type": "module" }',
      'nested/deeper/file.ts': '',
    });
    const brokenDir = writeProject('detect-broken', {
      'package.json': '{ not json',
      'file.js': '',
    });
    const bareDir = path.join(scratchRoot, 'detect-bare');
    fs.mkdirSync(bareDir);

    expect(
      detectModuleSystem(path.join(typelessDir, 'nested/deeper/file.ts')),
    ).toBe('commonjs');
    expect(
      detectModuleSystem(path.join(moduleDir, 'nested/deeper/file.ts')),
    ).toBe('module');
    expect(detectModuleSystem(path.join(typelessDir, 'any.mjs'))).toBe(
      'module',
    );
    expect(detectModuleSystem(path.join(typelessDir, 'any.mts'))).toBe(
      'module',
    );
    expect(detectModuleSystem(path.join(moduleDir, 'any.cjs'))).toBe(
      'commonjs',
    );
    expect(detectModuleSystem(path.join(moduleDir, 'any.cts'))).toBe(
      'commonjs',
    );
    expect(detectModuleSystem(path.join(brokenDir, 'file.js'))).toBe(
      'commonjs',
    );
    expect(detectModuleSystem(path.join(bareDir, 'file.js'))).toBe('commonjs');
  });
});
