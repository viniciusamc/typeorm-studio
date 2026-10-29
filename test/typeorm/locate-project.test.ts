import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeApplicationEnvironment,
  locateProject,
  ProjectLocationError,
  type ProjectLocation,
  type ProjectLocationFailure,
} from '../../src/typeorm/locate-project.ts';

type Tree = Readonly<Record<string, string>>;

const datasourceSource =
  "import { DataSource } from 'typeorm';\nexport default new DataSource({ type: 'postgres' });\n";
const emptyModule = 'export {};\n';
const gitMarker: Tree = { '.git/HEAD': 'ref: refs/heads/main\n' };
const appsWorkspace = "packages:\n  - 'apps/*'\n";
const typeormCli = 'node ./node_modules/typeorm/cli.js migration:run -d';
const tmpdirIsIsolated = !hasProjectMarkerAbove(os.tmpdir());

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hasProjectMarkerAbove(dir: string): boolean {
  const parent = path.dirname(dir);
  const markers = ['package.json', 'pnpm-workspace.yaml', 'lerna.json', '.git'];
  if (markers.some((name) => fs.existsSync(path.join(dir, name)))) return true;
  return parent !== dir && hasProjectMarkerAbove(parent);
}

function buildTree(files: Tree): string {
  const rootDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'typeorm-studio-')),
  );
  createdDirs.push(rootDir);
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return rootDir;
}

function packageWithScripts(scripts: Tree, extra: object = {}): string {
  return JSON.stringify({ name: 'fixture', scripts, ...extra });
}

function scriptedProject(scripts: Tree, extraFiles: Tree = {}): string {
  return buildTree({
    'package.json': packageWithScripts(scripts),
    'src/orm/main.ts': emptyModule,
    ...extraFiles,
  });
}

function datasourceMember(memberDir: string): Tree {
  return {
    [`${memberDir}/package.json`]: packageWithScripts({
      'migration:run': 'typeorm migration:run -d src/orm/main.ts',
    }),
    [`${memberDir}/src/orm/main.ts`]: datasourceSource,
  };
}

function locateFrom(
  startDir: string,
  options: { datasource?: string; envFiles?: readonly string[] } = {},
): ProjectLocation {
  return locateProject({
    startDir,
    explicitDatasourceFile: options.datasource,
    explicitEnvFiles: options.envFiles ?? [],
  });
}

function expectLocated(
  startDir: string,
  expectedFile: string,
): ProjectLocation {
  const location = locateFrom(startDir);
  expect(location.datasourceFile).toBe(expectedFile);
  return location;
}

function captureLocationError(action: () => unknown): ProjectLocationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ProjectLocationError) return error;
    throw error;
  }
  throw new Error('expected a ProjectLocationError but nothing was thrown');
}

function captureFailure(action: () => unknown): ProjectLocationFailure {
  return captureLocationError(action).failure;
}

function expectNotFound(startDir: string): void {
  expect(captureFailure(() => locateFrom(startDir))).toEqual({
    reason: 'datasource-not-found',
    searchedDirs: [startDir],
  });
}

const subscriptionLikeFiles: Tree = {
  'package.json': JSON.stringify({ name: 'workspace-root', private: true }),
  'pnpm-workspace.yaml':
    'packages:\n  - "apps/*"\n  - "packages/*"\nallowBuilds:\n  ssh2: false\n',
  'apps/api/package.json': packageWithScripts(
    {
      'migration:create':
        'typeorm migration:create src/database/migrations/$npm_config_name',
      'migration:generate':
        'nest build && typeorm migration:generate -d dist/config/database/postgres.data-source.js src/database/migrations/$npm_config_name',
      'migration:run':
        'nest build && typeorm migration:run -d dist/config/database/postgres.data-source.js',
      'migration:revert':
        'nest build && typeorm migration:revert -d dist/config/database/postgres.data-source.js',
    },
    { type: 'module' },
  ),
  'apps/api/tsconfig.json':
    '{\n  // comments and trailing commas are valid in tsconfig files\n  "compilerOptions": {\n    "outDir": "./dist",\n    "rootDir": ".",\n    /* block comment */\n    "types": ["node"],\n  },\n}\n',
  'apps/api/tsconfig.build.json': JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { rootDir: './src' },
    include: ['src'],
  }),
  'apps/api/src/config/database/postgres.data-source.ts': datasourceSource,
};

describe('locateProject with package.json scripts', () => {
  it.each([
    { from: 'the workspace root', startPath: '.' },
    { from: 'the member package', startPath: 'apps/api' },
    { from: 'a folder inside the member', startPath: 'apps/api/src/config' },
    {
      from: 'a file inside the member',
      startPath: 'apps/api/src/config/database/postgres.data-source.ts',
    },
  ])(
    'maps the compiled script target to its TypeScript source from $from',
    ({ startPath }) => {
      const rootDir = buildTree(subscriptionLikeFiles);

      const location = expectLocated(
        path.join(rootDir, startPath),
        path.join(
          rootDir,
          'apps/api/src/config/database/postgres.data-source.ts',
        ),
      );

      expect(location.packageDir).toBe(path.join(rootDir, 'apps/api'));
      expect(location.workspaceRoot).toBe(rootDir);
      expect(location.foundBy).toMatch(
        /^package\.json script "migration:(?:generate|run|revert)" in apps\/api, dist\/config\/database\/postgres\.data-source\.js mapped to src\/config\/database\/postgres\.data-source\.ts via tsconfig\.build\.json$/,
      );
      expect(location.envFiles).toEqual([]);
    },
  );

  it('returns real paths when started from a symlinked folder', () => {
    const rootDir = buildTree(subscriptionLikeFiles);
    const link = path.join(buildTree({}), 'linked-root');
    fs.symlinkSync(rootDir, link);

    const location = expectLocated(
      link,
      path.join(
        rootDir,
        'apps/api/src/config/database/postgres.data-source.ts',
      ),
    );

    expect(location.workspaceRoot).toBe(rootDir);
  });

  it('still returns the source when the compiled file also exists', () => {
    const rootDir = buildTree({
      ...subscriptionLikeFiles,
      'apps/api/dist/config/database/postgres.data-source.js': emptyModule,
    });

    expectLocated(
      rootDir,
      path.join(
        rootDir,
        'apps/api/src/config/database/postgres.data-source.ts',
      ),
    );
  });

  it('finds the datasource of a CommonJS package with ts-node and prod scripts', () => {
    const tsNode =
      'TS_NODE_TRANSPILE_ONLY=true ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js';
    const datasource = './src/config/dbs/postgres/ledger-datasource.ts';
    const rootDir = buildTree({
      ...gitMarker,
      'package.json': packageWithScripts({
        typeorm: tsNode,
        'migration:create': `typeorm migration:create ./database/ledger/migrations/$npm_config_name`,
        'migration:run': `${tsNode} migration:run -d ${datasource}`,
        'migration:run:prod':
          'node node_modules/typeorm/cli.js migration:run -d dist/src/config/dbs/postgres/ledger-datasource.js',
        'migration:revert': `${tsNode} migration:revert -d ${datasource}`,
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          outDir: './dist',
          baseUrl: './',
        },
      }),
      'src/config/dbs/postgres/ledger-datasource.ts': datasourceSource,
      'dist/src/config/dbs/postgres/ledger-datasource.js': emptyModule,
    });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'src/config/dbs/postgres/ledger-datasource.ts'),
    );

    expect(location.packageDir).toBe(rootDir);
    expect(location.workspaceRoot).toBe(rootDir);
    expect(location.foundBy).toBe(
      'package.json script "migration:run" in the root package',
    );
  });

  it('skips a function-style migration:create and reads the ts-node -d script', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'migration:create':
          'f() { typeorm migration:create ./database/catalog/migrations/$1; }; f',
        'migration:run':
          'ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:run -d ./src/config/db/datasource.ts',
        'migration:run:prod':
          'node ./node_modules/typeorm/cli.js migration:run -d ./dist/src/config/db/datasource.js',
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { outDir: './dist', baseUrl: './' },
      }),
      'src/config/db/datasource.ts': datasourceSource,
    });

    expectLocated(rootDir, path.join(rootDir, 'src/config/db/datasource.ts'));
  });

  it.each([
    ['typeorm -d', 'typeorm migration:run -d src/orm/main.ts'],
    [
      'typeorm-ts-node-commonjs --dataSource',
      'typeorm-ts-node-commonjs migration:run --dataSource src/orm/main.ts',
    ],
    [
      'typeorm-ts-node-esm --data-source=',
      'typeorm-ts-node-esm migration:run --data-source=src/orm/main.ts',
    ],
    ['npx typeorm -d=', 'npx typeorm migration:run -d=src/orm/main.ts'],
    [
      'pnpm exec typeorm with double quotes',
      'pnpm exec typeorm migration:run -d "src/orm/main.ts"',
    ],
    [
      'yarn typeorm with single quotes',
      "yarn typeorm migration:run -d 'src/orm/main.ts'",
    ],
    [
      'a cross-env wrapper',
      'cross-env NODE_ENV=development typeorm migration:run -d src/orm/main.ts',
    ],
    ['node on the typeorm cli', `${typeormCli} src/orm/main.ts`],
    [
      'ts-node on the typeorm ts-node cli',
      'ts-node ./node_modules/typeorm/cli-ts-node-commonjs.js migration:run -d src/orm/main.ts',
    ],
    [
      'a chain around the command',
      'npm run build && typeorm migration:run -d src/orm/main.ts; echo done',
    ],
    [
      'a quoted path followed by more flags',
      'typeorm migration:run -d "src/orm/main.ts" --transaction each',
    ],
    [
      'a credential assignment before the command',
      'DATABASE_URL=postgres://app:hunter2@localhost:5432/app typeorm migration:run -d src/orm/main.ts',
    ],
  ])('recognizes %s', (_shape, script) => {
    const rootDir = scriptedProject({ 'db:migrate': script });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'src/orm/main.ts'),
    );

    expect(location.foundBy).toBe(
      'package.json script "db:migrate" in the root package',
    );
    expect(JSON.stringify(location)).not.toContain('hunter2');
  });

  it('reads a quoted path that contains a space', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate': 'typeorm migration:run -d "src/my orm/main.ts"',
      }),
      'src/my orm/main.ts': emptyModule,
    });

    expectLocated(rootDir, path.join(rootDir, 'src/my orm/main.ts'));
  });

  it.each<{ shape: string; scripts: Record<string, string> }>([
    {
      shape: 'npm run to a typeorm wrapper script',
      scripts: {
        orm: 'typeorm-ts-node-commonjs',
        'db:migrate': 'npm run orm -- migration:run -d src/orm/main.ts',
      },
    },
    {
      shape: 'pnpm to a typeorm wrapper script',
      scripts: {
        orm: 'typeorm-ts-node-esm',
        'db:migrate': 'pnpm orm migration:run -d src/orm/main.ts',
      },
    },
    {
      shape: 'yarn run through two wrapper levels',
      scripts: {
        base: 'node ./node_modules/typeorm/cli.js',
        orm: 'yarn run base',
        'db:migrate': 'yarn run orm migration:run -d src/orm/main.ts',
      },
    },
  ])('follows $shape', ({ scripts }) => {
    const rootDir = scriptedProject(scripts);

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'src/orm/main.ts'),
    );

    expect(location.foundBy).toBe(
      'package.json script "db:migrate" in the root package',
    );
  });

  it('survives scripts that call each other in a loop', () => {
    expectNotFound(
      scriptedProject({
        first: 'npm run second',
        second: 'npm run first -- -d src/orm/main.ts',
      }),
    );
  });

  it.each([
    ['docker compose -d', 'docker compose up -d db'],
    ['a node script with -d', 'node tools/seed.js -d src/orm/main.ts'],
    ['a shell variable value', 'typeorm migration:run -d $DATASOURCE_FILE'],
    ['a glob value', 'typeorm migration:run -d dist/**/*.js'],
    ['a missing value', 'typeorm migration:run -d'],
    ['no -d flag', 'typeorm migration:create src/migrations/add-users'],
  ])('does not treat %s as a datasource declaration', (_shape, script) => {
    expectNotFound(scriptedProject({ task: script }));
  });

  it('ignores a script target that does not exist', () => {
    expectNotFound(
      buildTree({
        'package.json': packageWithScripts({
          'db:migrate': 'typeorm migration:run -d src/orm/missing.ts',
        }),
      }),
    );
  });

  it('uses an existing compiled file when no TypeScript source maps to it', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate': `${typeormCli} dist/orm/main.js`,
      }),
      'dist/orm/main.js': emptyModule,
    });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'dist/orm/main.js'),
    );

    expect(location.foundBy).toBe(
      'package.json script "db:migrate" in the root package, compiled file dist/orm/main.js (no TypeScript source found)',
    );
  });

  it.each([
    ['main.js', 'main.ts'],
    ['main.mjs', 'main.mts'],
    ['main.cjs', 'main.cts'],
  ])('maps %s back to %s', (compiled, source) => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate': `${typeormCli} dist/orm/${compiled}`,
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { outDir: './dist', rootDir: './src' },
      }),
      [`src/orm/${source}`]: emptyModule,
    });

    expectLocated(rootDir, path.join(rootDir, 'src/orm', source));
  });

  it('follows an extends chain and falls back to src when no rootDir is declared', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate': `${typeormCli} dist/orm/main.js`,
      }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { outDir: './dist' },
      }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base' }),
      'src/orm/main.ts': emptyModule,
    });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'src/orm/main.ts'),
    );

    expect(location.foundBy).toMatch(
      /dist\/orm\/main\.js mapped to src\/orm\/main\.ts via tsconfig\.(?:base\.)?json$/,
    );
  });

  it('lets a later entry of an extends array override an earlier one', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate': `${typeormCli} dist/orm/main.js`,
      }),
      'tsconfig.first.json': JSON.stringify({
        compilerOptions: { outDir: './elsewhere', rootDir: './nowhere' },
      }),
      'tsconfig.second.json': JSON.stringify({
        compilerOptions: { outDir: './dist', rootDir: './src' },
      }),
      'tsconfig.json': JSON.stringify({
        extends: ['./tsconfig.first.json', './tsconfig.second.json'],
      }),
      'src/orm/main.ts': emptyModule,
    });

    expect(locateFrom(rootDir).foundBy).toMatch(
      /mapped to src\/orm\/main\.ts via tsconfig\.json$/,
    );
  });

  it('resolves inherited directories relative to the config that declares them', () => {
    const rootDir = buildTree({
      ...gitMarker,
      'package.json': JSON.stringify({ name: 'workspace-root' }),
      'configs/tsconfig.base.json': JSON.stringify({
        compilerOptions: { outDir: '../build-output', rootDir: '../sources' },
      }),
      'apps/api/package.json': packageWithScripts({
        'db:migrate': `${typeormCli} ../../build-output/orm/main.js`,
      }),
      'apps/api/tsconfig.json': JSON.stringify({
        extends: '../../configs/tsconfig.base.json',
      }),
      'sources/orm/main.ts': emptyModule,
    });

    expectLocated(
      path.join(rootDir, 'apps/api'),
      path.join(rootDir, 'sources/orm/main.ts'),
    );
  });

  it('prefers a package.json script over a file-name match', () => {
    const rootDir = scriptedProject(
      { 'db:migrate': 'typeorm migration:run -d src/orm/main.ts' },
      { 'src/legacy/data-source.ts': datasourceSource },
    );

    expectLocated(rootDir, path.join(rootDir, 'src/orm/main.ts'));
  });

  it('reports the strongest evidence when scripts reach one file in different ways', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:prod': `${typeormCli} dist/orm/main.js`,
        'db:dev': 'typeorm migration:run -d src/orm/main.ts',
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { outDir: './dist', rootDir: './src' },
      }),
      'src/orm/main.ts': emptyModule,
    });

    expect(locateFrom(rootDir).foundBy).toBe(
      'package.json script "db:dev" in the root package',
    );
  });

  it('collapses several scripts that point at one file into one candidate', () => {
    const rootDir = scriptedProject({
      'db:run': 'typeorm migration:run -d src/orm/main.ts',
      'db:revert': 'typeorm migration:revert -d ./src/orm/main.ts',
      'db:show': 'typeorm migration:show --dataSource src/orm/../orm/main.ts',
    });

    expect(locateFrom(rootDir).foundBy).toBe(
      'package.json script "db:run" in the root package',
    );
  });
});

describe('locateProject with file names', () => {
  it('finds a data-source file when no script names one', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({ build: 'tsc' }),
      'src/database/data-source.ts': datasourceSource,
      'src/database/user.entity.ts': 'export class User {}\n',
    });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'src/database/data-source.ts'),
    );

    expect(location.foundBy).toBe(
      'file name convention with TypeORM content: src/database/data-source.ts in the root package',
    );
  });

  it.each([
    ['datasource.ts', datasourceSource],
    ['postgres.data-source.mts', datasourceSource],
    ['orm/typeorm.config.ts', datasourceSource],
    ['orm/typeorm-config.cts', datasourceSource],
    ['ormconfig.js', "module.exports = { type: 'postgres' };\n"],
    ['db/data-sources/main.ts', datasourceSource],
    ['config/app.datasources.ts', datasourceSource],
  ])('recognizes the file name %s', (name, content) => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({}),
      [`src/${name}`]: content,
    });

    expectLocated(rootDir, path.join(rootDir, 'src', name));
  });

  it('requires TypeORM content in a file whose name matches', () => {
    expectNotFound(
      buildTree({
        'package.json': packageWithScripts({}),
        'src/data-source.ts': 'export const label = "unrelated";\n',
      }),
    );
  });

  it('lists every file-name candidate when several match', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({}),
      'src/data-source.ts': datasourceSource,
      'src/legacy/ormconfig.ts': datasourceSource,
    });

    expect(captureFailure(() => locateFrom(rootDir))).toEqual({
      reason: 'datasource-ambiguous',
      candidates: [
        path.join(rootDir, 'src/data-source.ts'),
        path.join(rootDir, 'src/legacy/ormconfig.ts'),
      ],
    });
  });

  it('skips build output, dependencies, hidden folders, declarations and tests', () => {
    expectNotFound(
      buildTree({
        'package.json': packageWithScripts({}),
        'node_modules/driver/data-source.ts': datasourceSource,
        'dist/data-source.ts': datasourceSource,
        'build/ormconfig.ts': datasourceSource,
        'out/typeorm.config.ts': datasourceSource,
        'coverage/data-source.js': datasourceSource,
        '.cache/typeorm.config.ts': datasourceSource,
        '.next/data-source.js': datasourceSource,
        'src/data-source.d.ts': datasourceSource,
        'src/data-source.spec.ts': datasourceSource,
        'src/data-source.test.ts': datasourceSource,
        'src/__tests__/data-source.ts': datasourceSource,
      }),
    );
  });

  it('finds the real file next to ignored copies', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({}),
      'node_modules/driver/data-source.ts': datasourceSource,
      'dist/data-source.js': datasourceSource,
      'src/data-source.spec.ts': datasourceSource,
      'src/orm/data-source.ts': datasourceSource,
    });

    expectLocated(rootDir, path.join(rootDir, 'src/orm/data-source.ts'));
  });
});

describe('locateProject scope', () => {
  const twoAppFiles: Tree = {
    'package.json': packageWithScripts({
      'db:run': 'typeorm migration:run -d tools/zz-main.ts',
    }),
    'tools/zz-main.ts': emptyModule,
    'pnpm-workspace.yaml': appsWorkspace,
    ...datasourceMember('apps/billing'),
    ...datasourceMember('apps/catalog'),
  };

  it('lists, sorted, the datasource of the root package and of every member', () => {
    const rootDir = buildTree(twoAppFiles);

    expect(captureFailure(() => locateFrom(rootDir))).toEqual({
      reason: 'datasource-ambiguous',
      candidates: [
        path.join(rootDir, 'apps/billing/src/orm/main.ts'),
        path.join(rootDir, 'apps/catalog/src/orm/main.ts'),
        path.join(rootDir, 'tools/zz-main.ts'),
      ],
    });
  });

  it('searches only the member package when started inside it', () => {
    const rootDir = buildTree(twoAppFiles);

    const location = expectLocated(
      path.join(rootDir, 'apps/catalog/src'),
      path.join(rootDir, 'apps/catalog/src/orm/main.ts'),
    );

    expect(location.packageDir).toBe(path.join(rootDir, 'apps/catalog'));
    expect(location.workspaceRoot).toBe(rootDir);
  });

  it.each<{ form: string; files: Tree; member: string }>([
    {
      form: 'a package.json workspaces array',
      files: {
        'package.json': JSON.stringify({ workspaces: ['./modules/*/'] }),
      },
      member: 'modules/ledger',
    },
    {
      form: 'a package.json workspaces object with packages',
      files: {
        'package.json': JSON.stringify({
          workspaces: { packages: ['services/**'] },
        }),
      },
      member: 'services/payments/api',
    },
    {
      form: 'a lerna.json packages list',
      files: {
        'package.json': JSON.stringify({ name: 'root' }),
        'lerna.json': JSON.stringify({ packages: ['modules/*'] }),
      },
      member: 'modules/ledger',
    },
    {
      form: 'a pnpm flow sequence with a comment',
      files: {
        'package.json': JSON.stringify({ name: 'root' }),
        'pnpm-workspace.yaml':
          'packages: [\'apps/*\', "libs/shared"] # members\n',
      },
      member: 'libs/shared',
    },
    {
      form: 'pnpm explicit paths with CRLF line endings and comments',
      files: {
        'package.json': JSON.stringify({ name: 'root' }),
        'pnpm-workspace.yaml':
          '# Every app is a member\r\npackages:\r\n  # contracts first\r\n  - "libs/contracts"\r\n  - apps/pay # main app\r\nonlyBuiltDependencies:\r\n  - sharp\r\n',
        ...datasourceMember('sharp'),
      },
      member: 'apps/pay',
    },
    {
      form: 'pnpm items written at column zero',
      files: {
        'package.json': JSON.stringify({ name: 'root' }),
        'pnpm-workspace.yaml': "packages:\n- 'apps/*'\n",
      },
      member: 'apps/web',
    },
  ])('expands $form', ({ files, member }) => {
    const rootDir = buildTree({ ...files, ...datasourceMember(member) });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, member, 'src/orm/main.ts'),
    );

    expect(location.workspaceRoot).toBe(rootDir);
  });

  it('honors exclusions in pnpm-workspace.yaml', () => {
    const rootDir = buildTree({
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': `${appsWorkspace}  - '!apps/legacy'\n`,
      ...datasourceMember('apps/current'),
      ...datasourceMember('apps/legacy'),
    });

    expectLocated(rootDir, path.join(rootDir, 'apps/current/src/orm/main.ts'));
  });

  it('finds a member datasource by file name from the workspace root', () => {
    const rootDir = buildTree({
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': appsWorkspace,
      'apps/web/package.json': packageWithScripts({}),
      'apps/web/src/data-source.ts': datasourceSource,
    });

    const location = expectLocated(
      rootDir,
      path.join(rootDir, 'apps/web/src/data-source.ts'),
    );

    expect(location.foundBy).toBe(
      'file name convention with TypeORM content: src/data-source.ts in apps/web',
    );
  });

  it('prefers a workspace marker over a nearer .git folder', () => {
    const rootDir = buildTree({
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': appsWorkspace,
      'apps/web/.git/HEAD': gitMarker['.git/HEAD'],
      ...datasourceMember('apps/web'),
    });

    expect(locateFrom(path.join(rootDir, 'apps/web')).workspaceRoot).toBe(
      rootDir,
    );
  });

  it('uses the nearest .git folder when no workspace marker exists', () => {
    const rootDir = buildTree({
      ...gitMarker,
      ...datasourceMember('services/billing'),
    });

    const location = locateFrom(path.join(rootDir, 'services/billing'));

    expect(location.workspaceRoot).toBe(rootDir);
    expect(location.packageDir).toBe(path.join(rootDir, 'services/billing'));
  });

  it.skipIf(!tmpdirIsIsolated)(
    'falls back to the package folder when nothing marks a workspace',
    () => {
      const rootDir = buildTree(datasourceMember('standalone'));

      expect(locateFrom(path.join(rootDir, 'standalone')).workspaceRoot).toBe(
        path.join(rootDir, 'standalone'),
      );
    },
  );

  it.skipIf(!tmpdirIsIsolated)(
    'searches the start folder when no package.json exists above it',
    () => {
      expectNotFound(buildTree({ 'notes.txt': 'nothing here\n' }));
    },
  );

  it.skipIf(!tmpdirIsIsolated)(
    'reports a start folder that does not exist as not found',
    () => {
      expectNotFound(path.join(os.tmpdir(), 'typeorm-studio-never-created'));
    },
  );

  it.skipIf(!tmpdirIsIsolated)(
    'reports a missing package.json for a datasource outside any package',
    () => {
      const rootDir = buildTree({ 'src/data-source.ts': datasourceSource });

      expect(captureFailure(() => locateFrom(rootDir))).toEqual({
        reason: 'package-json-missing',
        file: path.join(rootDir, 'src/data-source.ts'),
      });
    },
  );
});

describe('locateProject with an explicit datasource', () => {
  const scriptedFiles: Tree = {
    'package.json': packageWithScripts({
      'db:migrate': 'typeorm migration:run -d src/orm/main.ts',
    }),
    'src/orm/main.ts': datasourceSource,
    'src/custom/chosen.ts': emptyModule,
  };

  it.each([
    [
      'an absolute path',
      (rootDir: string) => path.join(rootDir, 'src/custom/chosen.ts'),
    ],
    ['a path relative to the start folder', () => 'src/custom/chosen.ts'],
  ])('overrides scripts and file names with %s', (_form, toArgument) => {
    const rootDir = buildTree(scriptedFiles);

    const location = locateFrom(rootDir, { datasource: toArgument(rootDir) });

    expect(location.datasourceFile).toBe(
      path.join(rootDir, 'src/custom/chosen.ts'),
    );
    expect(location.foundBy).toBe('--datasource flag');
    expect(location.packageDir).toBe(rootDir);
  });

  it('computes package, workspace and env files from the chosen file', () => {
    const rootDir = buildTree({
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': appsWorkspace,
      '.env': 'A=1\nB=2\n',
      'apps/other/package.json': packageWithScripts({}),
      'apps/other/.env': 'C=3\n',
      'apps/other/src/chosen.ts': emptyModule,
      ...datasourceMember('apps/scripted'),
    });

    const location = locateFrom(path.join(rootDir, 'apps/scripted'), {
      datasource: path.join(rootDir, 'apps/other/src/chosen.ts'),
    });

    expect(location.packageDir).toBe(path.join(rootDir, 'apps/other'));
    expect(location.workspaceRoot).toBe(rootDir);
    expect(location.envFiles).toEqual([
      { path: path.join(rootDir, '.env'), keyCount: 2 },
      { path: path.join(rootDir, 'apps/other/.env'), keyCount: 1 },
    ]);
  });

  it.each([
    ['a file that does not exist', 'src/gone.ts'],
    ['a directory', 'src'],
    ['a path below a file', 'src/orm/main.ts/extra'],
  ])('fails for %s', (_form, relativePath) => {
    const rootDir = buildTree(scriptedFiles);
    const requested = path.join(rootDir, relativePath);

    expect(
      captureFailure(() => locateFrom(rootDir, { datasource: requested })),
    ).toEqual({ reason: 'datasource-file-missing', file: requested });
  });

  it.skipIf(!tmpdirIsIsolated)(
    'fails for a file that lives outside any package',
    () => {
      const rootDir = buildTree({ 'loose/ds.ts': datasourceSource });
      const requested = path.join(rootDir, 'loose/ds.ts');

      expect(
        captureFailure(() => locateFrom(rootDir, { datasource: requested })),
      ).toEqual({ reason: 'package-json-missing', file: requested });
    },
  );
});

describe('locateProject env files', () => {
  const layeredEnvFiles: Tree = {
    'workspace/package.json': JSON.stringify({ name: 'root' }),
    'workspace/pnpm-workspace.yaml': appsWorkspace,
    'workspace/.env': 'ROOT_ONLY=1\nSHARED=root\nPORT=3000\n',
    'workspace/.env.local': 'LOCAL=1\n',
    'workspace/.env.example': 'EXAMPLE=1\n',
    'workspace/apps/.env': 'MIDDLE=1\n',
    'workspace/apps/api/.env':
      '# comment\nSHARED=package\nPACKAGE_ONLY="two words"\nexport EXPORTED=1\nEMPTY=\nSHARED=again\n',
    'workspace/apps/api/.env.production': 'PROD=1\n',
    '.env': 'OUTSIDE=1\n',
    ...datasourceMember('workspace/apps/api'),
  };

  it('collects exact .env files from the workspace root down to the package, root first', () => {
    const rootDir = buildTree(layeredEnvFiles);
    const workspace = path.join(rootDir, 'workspace');

    const location = locateFrom(path.join(workspace, 'apps/api'));

    expect(location.envFiles).toEqual([
      { path: path.join(workspace, '.env'), keyCount: 3 },
      { path: path.join(workspace, 'apps/.env'), keyCount: 1 },
      { path: path.join(workspace, 'apps/api/.env'), keyCount: 4 },
    ]);
  });

  it('uses only the explicit env files, in the given order', () => {
    const rootDir = buildTree({
      ...layeredEnvFiles,
      'extras/first.env': 'ONE=1\nTWO=2\n',
      'extras/second.env': 'TWO=22\n',
    });
    const first = path.join(rootDir, 'extras/first.env');
    const second = path.join(rootDir, 'extras/second.env');

    const location = locateFrom(path.join(rootDir, 'workspace/apps/api'), {
      envFiles: [second, first],
    });

    expect(location.envFiles).toEqual([
      { path: second, keyCount: 1 },
      { path: first, keyCount: 2 },
    ]);
  });

  it('resolves relative explicit env files against the start folder', () => {
    const rootDir = buildTree({
      ...datasourceMember('app'),
      'app/config/custom.env': 'A=1\n',
    });

    const location = locateFrom(path.join(rootDir, 'app'), {
      envFiles: ['config/custom.env'],
    });

    expect(location.envFiles).toEqual([
      { path: path.join(rootDir, 'app/config/custom.env'), keyCount: 1 },
    ]);
  });

  it.each([
    ['is missing', 'extras/absent.env'],
    ['is a directory', 'extras'],
  ])('fails when an explicit env file %s', (_form, relativePath) => {
    const rootDir = buildTree({
      ...datasourceMember('app'),
      'extras/first.env': 'ONE=1\n',
    });
    const requested = path.join(rootDir, relativePath);

    expect(
      captureFailure(() =>
        locateFrom(path.join(rootDir, 'app'), {
          envFiles: [path.join(rootDir, 'extras/first.env'), requested],
        }),
      ),
    ).toEqual({ reason: 'env-file-missing', file: requested });
  });

  it('reports only paths and key counts, never values', () => {
    const rootDir = buildTree({
      ...datasourceMember('app'),
      'app/.env': 'API_TOKEN=value-that-must-stay-private\n',
    });

    const location = locateFrom(path.join(rootDir, 'app'));

    expect(JSON.stringify(location)).not.toContain(
      'value-that-must-stay-private',
    );
    expect(location.envFiles).toEqual([
      { path: path.join(rootDir, 'app/.env'), keyCount: 1 },
    ]);
  });
});

describe('composeApplicationEnvironment', () => {
  const layeredFiles: Tree = {
    ...datasourceMember('workspace/apps/api'),
    'workspace/package.json': JSON.stringify({ name: 'root' }),
    'workspace/pnpm-workspace.yaml': appsWorkspace,
    'workspace/.env': 'ROOT_ONLY=root\nSHARED=root\nPORT=3000\n',
    'workspace/apps/api/.env':
      'SHARED=package\nPACKAGE_ONLY=package\nNODE_ENV=production\n',
    'extras/first.env': 'SHARED=first\nFIRST_ONLY=first\nPLAIN=${SHARED}/db\n',
    'extras/second.env': 'SHARED=second\nSECOND_ONLY=second\n',
  };

  function composeFor(
    rootDir: string,
    shellEnv: Readonly<Record<string, string | undefined>>,
    envFileNames: readonly string[] = [],
  ): Record<string, string> {
    const location = locateFrom(path.join(rootDir, 'workspace/apps/api'), {
      envFiles: envFileNames.map((name) => path.join(rootDir, 'extras', name)),
    });
    return composeApplicationEnvironment({
      envFiles: location.envFiles,
      shellEnv,
    });
  }

  it('lets the package .env win over ancestor .env files and passes PORT and NODE_ENV through', () => {
    expect(composeFor(buildTree(layeredFiles), {})).toEqual({
      ROOT_ONLY: 'root',
      SHARED: 'package',
      PORT: '3000',
      PACKAGE_ONLY: 'package',
      NODE_ENV: 'production',
    });
  });

  it('lets defined shell variables win over every file and keeps unrelated ones', () => {
    const environment = composeFor(buildTree(layeredFiles), {
      SHARED: 'shell',
      PORT: '8080',
      HOME: '/home/tester',
      GONE: undefined,
    });

    expect(environment).toMatchObject({
      SHARED: 'shell',
      PORT: '8080',
      HOME: '/home/tester',
      ROOT_ONLY: 'root',
      NODE_ENV: 'production',
    });
    expect(environment).not.toHaveProperty('GONE');
  });

  it('does not let an undefined shell variable erase a file value', () => {
    expect(
      composeFor(buildTree(layeredFiles), { SHARED: undefined }).SHARED,
    ).toBe('package');
  });

  it('lets a later explicit env file win, ignores automatic ones and keeps references literal', () => {
    const rootDir = buildTree(layeredFiles);

    expect(composeFor(rootDir, {}, ['first.env', 'second.env'])).toEqual({
      SHARED: 'second',
      FIRST_ONLY: 'first',
      PLAIN: '${SHARED}/db',
      SECOND_ONLY: 'second',
    });
    expect(composeFor(rootDir, {}, ['second.env', 'first.env']).SHARED).toBe(
      'first',
    );
  });

  it('lets shell variables win over explicit env files', () => {
    const environment = composeFor(
      buildTree(layeredFiles),
      { SHARED: 'shell' },
      ['first.env'],
    );

    expect(environment.SHARED).toBe('shell');
    expect(environment.PLAIN).toBe('${SHARED}/db');
  });

  it('returns only the shell variables when there are no env files', () => {
    expect(
      composeApplicationEnvironment({
        envFiles: [],
        shellEnv: { A: '1', B: undefined },
      }),
    ).toEqual({ A: '1' });
  });

  it('fails when a summarized env file has disappeared', () => {
    const rootDir = buildTree(layeredFiles);
    const envFiles = locateFrom(
      path.join(rootDir, 'workspace/apps/api'),
    ).envFiles;
    fs.rmSync(path.join(rootDir, 'workspace/.env'));

    expect(
      captureFailure(() =>
        composeApplicationEnvironment({ envFiles, shellEnv: {} }),
      ),
    ).toEqual({
      reason: 'env-file-missing',
      file: path.join(rootDir, 'workspace/.env'),
    });
  });
});

describe('ProjectLocationError', () => {
  it('carries the failure and names the paths involved', () => {
    const rootDir = buildTree({ 'package.json': packageWithScripts({}) });

    const error = captureLocationError(() => locateFrom(rootDir));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProjectLocationError');
    expect(error.failure).toEqual({
      reason: 'datasource-not-found',
      searchedDirs: [rootDir],
    });
    expect(error.message).toContain(rootDir);
    expect(error.message).toContain('--datasource');
  });

  it.each<{ failure: ProjectLocationFailure; paths: string[] }>([
    {
      failure: {
        reason: 'datasource-ambiguous',
        candidates: ['/a/one.ts', '/b/two.ts'],
      },
      paths: ['/a/one.ts', '/b/two.ts'],
    },
    {
      failure: { reason: 'datasource-file-missing', file: '/missing/ds.ts' },
      paths: ['/missing/ds.ts'],
    },
    {
      failure: { reason: 'env-file-missing', file: '/missing/.env' },
      paths: ['/missing/.env'],
    },
    {
      failure: { reason: 'package-json-missing', file: '/loose/ds.ts' },
      paths: ['/loose/ds.ts'],
    },
  ])(
    'describes the $failure.reason failure on one line with the offending paths',
    ({ failure, paths }) => {
      const message = new ProjectLocationError(failure).message;

      expect(paths.filter((offending) => !message.includes(offending))).toEqual(
        [],
      );
      expect(message).not.toContain('\n');
    },
  );

  it('never echoes script contents or env values in a failure', () => {
    const rootDir = buildTree({
      'package.json': packageWithScripts({
        'db:migrate':
          'DATABASE_URL=postgres://app:hunter2@localhost:5432/app typeorm migration:run -d src/gone.ts',
      }),
      '.env': 'DATABASE_PASSWORD=hunter2\n',
    });

    const error = captureLocationError(() => locateFrom(rootDir));

    expect(error.message).not.toContain('hunter2');
    expect(JSON.stringify(error.failure)).not.toContain('hunter2');
  });
});

describe('locateProject performance', () => {
  it('locates a project in under 100 ms', () => {
    const filler: Record<string, string> = {};
    for (let index = 0; index < 400; index += 1) {
      filler[`node_modules/dependency-${index}/index.js`] = emptyModule;
      filler[`apps/api/src/feature-${index}/feature.service.ts`] = emptyModule;
    }
    filler['node_modules/dependency-0/data-source.ts'] = datasourceSource;
    const scripted = buildTree({ ...subscriptionLikeFiles, ...filler });
    const named = buildTree({
      'package.json': packageWithScripts({}),
      'src/orm/data-source.ts': datasourceSource,
      ...filler,
    });
    locateFrom(scripted);
    locateFrom(named);

    const scriptedStart = performance.now();
    locateFrom(scripted);
    const scriptedElapsed = performance.now() - scriptedStart;
    const namedStart = performance.now();
    locateFrom(named);
    const namedElapsed = performance.now() - namedStart;

    expect(scriptedElapsed).toBeLessThan(100);
    expect(namedElapsed).toBeLessThan(100);
  });
});
