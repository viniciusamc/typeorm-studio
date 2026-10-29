import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export type EnvFileSummary = {
  readonly path: string;
  readonly keyCount: number;
};

export type ProjectLocation = {
  readonly datasourceFile: string;
  readonly packageDir: string;
  readonly workspaceRoot: string;
  readonly foundBy: string;
  readonly envFiles: readonly EnvFileSummary[];
};

export type ProjectLocationFailure =
  | {
      readonly reason: 'datasource-not-found';
      readonly searchedDirs: readonly string[];
    }
  | {
      readonly reason: 'datasource-ambiguous';
      readonly candidates: readonly string[];
    }
  | { readonly reason: 'datasource-file-missing'; readonly file: string }
  | { readonly reason: 'env-file-missing'; readonly file: string }
  | { readonly reason: 'package-json-missing'; readonly file: string };

export class ProjectLocationError extends Error {
  readonly failure: ProjectLocationFailure;

  constructor(failure: ProjectLocationFailure) {
    super(describeLocationFailure(failure));
    this.name = 'ProjectLocationError';
    this.failure = failure;
  }
}

type DatasourceFinding = { readonly file: string; readonly foundBy: string };

type DatasourceCandidate = DatasourceFinding & { readonly score: number };

type SearchScope = {
  readonly packageDirs: readonly string[];
  readonly workspaceRoot: string;
};

type BuildLayout = {
  readonly tsconfigName: string;
  readonly outDir: string;
  readonly rootDirs: readonly string[];
};

type OutputDirs = {
  readonly outDir: string | undefined;
  readonly rootDir: string | undefined;
};

type DatasourceDeclaration = {
  readonly scriptName: string;
  readonly declaredPath: string;
};

export function locateProject(request: {
  readonly startDir: string;
  readonly explicitDatasourceFile: string | undefined;
  readonly explicitEnvFiles: readonly string[];
}): ProjectLocation {
  const startDir = resolveRealPath(request.startDir);
  const found =
    request.explicitDatasourceFile === undefined
      ? discoverDatasource(startDir)
      : checkExplicitDatasource(
          path.resolve(startDir, request.explicitDatasourceFile),
        );
  const packageDir = findNearestPackageDir(path.dirname(found.file));
  if (packageDir === undefined) {
    throw new ProjectLocationError({
      reason: 'package-json-missing',
      file: found.file,
    });
  }
  const workspaceRoot = findWorkspaceRoot(packageDir);
  const explicitEnvFiles = request.explicitEnvFiles.map((file) =>
    path.resolve(startDir, file),
  );
  const envFiles =
    explicitEnvFiles.length > 0
      ? explicitEnvFiles
      : listAutomaticEnvFiles(workspaceRoot, packageDir);
  return {
    datasourceFile: found.file,
    packageDir,
    workspaceRoot,
    foundBy: found.foundBy,
    envFiles: envFiles.map((file) => ({
      path: file,
      keyCount: Object.keys(readEnvFileEntries(file)).length,
    })),
  };
}

export function composeApplicationEnvironment(request: {
  readonly envFiles: readonly EnvFileSummary[];
  readonly shellEnv: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const composed = new Map<string, string>();
  for (const envFile of request.envFiles) {
    const entries = Object.entries(readEnvFileEntries(envFile.path));
    for (const [key, value] of entries) composed.set(key, value);
  }
  for (const [key, value] of Object.entries(request.shellEnv)) {
    if (value !== undefined) composed.set(key, value);
  }
  return Object.fromEntries(composed);
}

function describeLocationFailure(failure: ProjectLocationFailure): string {
  switch (failure.reason) {
    case 'datasource-not-found':
      return `no TypeORM DataSource found in ${failure.searchedDirs.join(', ')}; expected a package.json script running "typeorm ... -d <file>" or a data-source, ormconfig or typeorm.config file that mentions DataSource; pass the file with --datasource <file>`;
    case 'datasource-ambiguous':
      return `found ${failure.candidates.length} DataSource candidates (${failure.candidates.join(', ')}); expected exactly one; pass the one to use with --datasource <file>`;
    case 'datasource-file-missing':
      return `--datasource file not found: ${failure.file}; expected the path of an existing .ts, .mts, .cts, .js, .mjs or .cjs file`;
    case 'env-file-missing':
      return `env file not found or not readable: ${failure.file}; expected the path of an existing dotenv file`;
    case 'package-json-missing':
      return `no package.json found in or above ${failure.file}; expected the DataSource file to live inside a package`;
  }
}

function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function statPath(candidate: string): fs.Stats | undefined {
  try {
    return fs.statSync(candidate);
  } catch {
    return undefined;
  }
}

function isFile(candidate: string): boolean {
  return statPath(candidate)?.isFile() === true;
}

function isDirectory(candidate: string): boolean {
  return statPath(candidate)?.isDirectory() === true;
}

function isInside(parentDir: string, target: string): boolean {
  const relative = path.relative(parentDir, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry: unknown): entry is string => typeof entry === 'string',
      )
    : [];
}

function toDisplayPath(baseDir: string, target: string): string {
  return path.relative(baseDir, target).split(path.sep).join('/') || '.';
}

function describePackage(workspaceRoot: string, packageDir: string): string {
  const shown = toDisplayPath(workspaceRoot, packageDir);
  return shown === '.' ? 'the root package' : shown;
}

function listAncestorDirs(fromDir: string): string[] {
  const ancestors = [fromDir];
  let parent = path.dirname(fromDir);
  while (parent !== ancestors.at(-1)) {
    ancestors.push(parent);
    parent = path.dirname(parent);
  }
  return ancestors;
}

function readDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listChildDirs(dir: string): string[] {
  return readDirEntries(dir)
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => path.join(dir, entry.name));
}

function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJsoncFile(file: string): unknown {
  const text = readTextFile(file).replace(/^\uFEFF/, '');
  const withoutComments = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match: string, kept: string | undefined) => kept ?? '',
  );
  try {
    return JSON.parse(
      withoutComments.replace(
        /("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/g,
        (_match: string, kept: string | undefined) => kept ?? '',
      ),
    );
  } catch {
    return undefined;
  }
}

function readWorkspacesField(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return readStringArray(value);
  if (isRecord(value) && Array.isArray(value.packages)) {
    return readStringArray(value.packages);
  }
  return undefined;
}

function readPackageManifest(packageDir: string): {
  readonly scripts: Readonly<Record<string, string>>;
  readonly workspaces: string[] | undefined;
} {
  const parsed = readJsoncFile(path.join(packageDir, 'package.json'));
  if (!isRecord(parsed)) return { scripts: {}, workspaces: undefined };
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  return {
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    workspaces: readWorkspacesField(parsed.workspaces),
  };
}

function findNearestPackageDir(fromDir: string): string | undefined {
  return listAncestorDirs(fromDir).find((dir) =>
    isFile(path.join(dir, 'package.json')),
  );
}

function hasWorkspaceMarker(dir: string): boolean {
  return (
    isFile(path.join(dir, 'pnpm-workspace.yaml')) ||
    isFile(path.join(dir, 'lerna.json')) ||
    readPackageManifest(dir).workspaces !== undefined
  );
}

function findWorkspaceRoot(packageDir: string): string {
  const ancestors = listAncestorDirs(packageDir);
  const markerDir = ancestors.find(hasWorkspaceMarker);
  if (markerDir !== undefined) return markerDir;
  return (
    ancestors.find((dir) => fs.existsSync(path.join(dir, '.git'))) ?? packageDir
  );
}

function parseYamlScalar(raw: string): string {
  const quoted = /^(?:"([^"]*)"|'([^']*)')/.exec(raw.trim());
  if (quoted !== null) return quoted[1] ?? quoted[2] ?? '';
  return raw.replace(/\s+#.*$/, '').trim();
}

function readPnpmWorkspacePackages(file: string): string[] {
  const lines = readTextFile(file).split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const inline = lines[start].replace(/^packages\s*:/, '').trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]\s*(?:#.*)?$/g, '')
      .split(',')
      .map(parseYamlScalar)
      .filter((pattern) => pattern !== '');
  }
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('-') && !line.startsWith('#')) {
      break;
    }
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item !== null) patterns.push(parseYamlScalar(item[1]));
  }
  return patterns.filter((pattern) => pattern !== '');
}

function readWorkspacePatterns(dir: string): string[] {
  const pnpmFile = path.join(dir, 'pnpm-workspace.yaml');
  const lerna = readJsoncFile(path.join(dir, 'lerna.json'));
  return [
    ...(isFile(pnpmFile) ? readPnpmWorkspacePackages(pnpmFile) : []),
    ...(readPackageManifest(dir).workspaces ?? []),
    ...(isRecord(lerna) ? readStringArray(lerna.packages) : []),
  ];
}

function expandDirectoryPattern(
  baseDir: string,
  segments: readonly string[],
): string[] {
  if (segments.length === 0) return [baseDir];
  const [head, ...rest] = segments;
  if (head === '**') {
    return [
      ...expandDirectoryPattern(baseDir, rest),
      ...listChildDirs(baseDir).flatMap((childDir) =>
        expandDirectoryPattern(childDir, segments),
      ),
    ];
  }
  if (!/[*?]/.test(head)) {
    const childDir = path.join(baseDir, head);
    return isDirectory(childDir) ? expandDirectoryPattern(childDir, rest) : [];
  }
  const escaped = head.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const segmentPattern = new RegExp(
    `^${escaped.replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`,
  );
  return listChildDirs(baseDir)
    .filter((childDir) => segmentPattern.test(path.basename(childDir)))
    .flatMap((childDir) => expandDirectoryPattern(childDir, rest));
}

function expandWorkspacePattern(
  workspaceRoot: string,
  pattern: string,
): string[] {
  const segments = pattern
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  return expandDirectoryPattern(workspaceRoot, segments);
}

function listWorkspaceMemberDirs(workspaceRoot: string): string[] {
  const patterns = readWorkspacePatterns(workspaceRoot).map((pattern) =>
    pattern.trim(),
  );
  const excludedDirs = new Set(
    patterns
      .filter((pattern) => pattern.startsWith('!'))
      .flatMap((pattern) =>
        expandWorkspacePattern(workspaceRoot, pattern.slice(1)),
      ),
  );
  const memberDirs = patterns
    .filter((pattern) => !pattern.startsWith('!'))
    .flatMap((pattern) => expandWorkspacePattern(workspaceRoot, pattern))
    .filter(
      (dir) =>
        dir !== workspaceRoot &&
        !excludedDirs.has(dir) &&
        isFile(path.join(dir, 'package.json')),
    );
  return [...new Set(memberDirs)].toSorted();
}

function resolveSearchScope(startDir: string): SearchScope {
  const startPackageDir = findNearestPackageDir(startDir);
  if (startPackageDir === undefined) {
    return { packageDirs: [startDir], workspaceRoot: startDir };
  }
  const workspaceRoot = findWorkspaceRoot(startPackageDir);
  if (startPackageDir !== workspaceRoot) {
    return { packageDirs: [startPackageDir], workspaceRoot };
  }
  return {
    packageDirs: [workspaceRoot, ...listWorkspaceMemberDirs(workspaceRoot)],
    workspaceRoot,
  };
}

function checkExplicitDatasource(file: string): DatasourceFinding {
  if (!isFile(file)) {
    throw new ProjectLocationError({ reason: 'datasource-file-missing', file });
  }
  return { file: fs.realpathSync(file), foundBy: '--datasource flag' };
}

function discoverDatasource(startDir: string): DatasourceFinding {
  const scope = resolveSearchScope(startDir);
  // Tiers: any package.json script candidate outranks every file-name
  // candidate. The score only picks the evidence line when several routes
  // lead to the same file.
  const fromScripts = dedupeCandidatesByFile(
    scope.packageDirs.flatMap((packageDir) =>
      findScriptCandidatesInPackage(packageDir, scope.workspaceRoot),
    ),
  );
  if (fromScripts.length > 0) return pickSingleCandidate(fromScripts);
  const fromNames = dedupeCandidatesByFile(
    scope.packageDirs.flatMap((packageDir) =>
      findNameCandidatesInPackage(packageDir, scope),
    ),
  );
  if (fromNames.length > 0) return pickSingleCandidate(fromNames);
  throw new ProjectLocationError({
    reason: 'datasource-not-found',
    searchedDirs: scope.packageDirs,
  });
}

function dedupeCandidatesByFile(
  candidates: readonly DatasourceCandidate[],
): DatasourceCandidate[] {
  const bestByFile = new Map<string, DatasourceCandidate>();
  for (const candidate of candidates) {
    const known = bestByFile.get(candidate.file);
    if (known === undefined || candidate.score > known.score) {
      bestByFile.set(candidate.file, candidate);
    }
  }
  return [...bestByFile.values()];
}

function pickSingleCandidate(
  candidates: readonly DatasourceCandidate[],
): DatasourceFinding {
  if (candidates.length === 1) {
    return { file: candidates[0].file, foundBy: candidates[0].foundBy };
  }
  throw new ProjectLocationError({
    reason: 'datasource-ambiguous',
    candidates: candidates.map((candidate) => candidate.file).toSorted(),
  });
}

function splitScriptIntoCommands(script: string): string[][] {
  const commands: string[][] = [[]];
  const pieces = script.matchAll(
    /[;&|\n]|(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s;&|'"\\])+/g,
  );
  for (const [piece] of pieces) {
    if (/^[;&|\n]$/.test(piece)) {
      commands.push([]);
      continue;
    }
    commands[commands.length - 1].push(
      piece.replace(
        /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g,
        (
          _match: string,
          single: string | undefined,
          double: string | undefined,
          escaped: string | undefined,
        ) => single ?? double?.replace(/\\(.)/g, '$1') ?? escaped ?? '',
      ),
    );
  }
  return commands.filter((tokens) => tokens.length > 0);
}

function scriptRunsTypeorm(
  scriptName: string,
  scripts: Readonly<Record<string, string>>,
  visitedScripts: ReadonlySet<string>,
): boolean {
  if (!Object.hasOwn(scripts, scriptName) || visitedScripts.has(scriptName)) {
    return false;
  }
  const visitedWithThis = new Set(visitedScripts).add(scriptName);
  return splitScriptIntoCommands(scripts[scriptName]).some(
    (tokens) => findTypeormTokenIndex(tokens, scripts, visitedWithThis) !== -1,
  );
}

function findTypeormTokenIndex(
  tokens: readonly string[],
  scripts: Readonly<Record<string, string>>,
  visitedScripts: ReadonlySet<string>,
): number {
  return tokens.findIndex(
    (token, index) =>
      /(?:^|[\\/])(?:typeorm(?:-ts-node-(?:commonjs|esm))?|typeorm[\\/]cli(?:-ts-node-(?:commonjs|esm))?(?:\.js)?)$/.test(
        token,
      ) ||
      (tokens
        .slice(0, index)
        .some((earlier) => /^(?:npm|pnpm|yarn|bun)$/.test(earlier)) &&
        scriptRunsTypeorm(token, scripts, visitedScripts)),
  );
}

function readDatasourceFlagValues(tokens: readonly string[]): string[] {
  return tokens.flatMap((token, index) => {
    const flag = /^(?:-d|--dataSource|--data-source)(?:=(.*))?$/.exec(token);
    const value = flag?.[1] ?? tokens[index + 1];
    return flag === null || value === undefined ? [] : [value];
  });
}

function collectDatasourceDeclarations(
  scripts: Readonly<Record<string, string>>,
): DatasourceDeclaration[] {
  return Object.entries(scripts).flatMap(([scriptName, script]) =>
    splitScriptIntoCommands(script).flatMap((tokens) => {
      const typeormIndex = findTypeormTokenIndex(
        tokens,
        scripts,
        new Set([scriptName]),
      );
      if (typeormIndex === -1) return [];
      return readDatasourceFlagValues(tokens.slice(typeormIndex + 1)).map(
        (declaredPath) => ({ scriptName, declaredPath }),
      );
    }),
  );
}

function listExtendedTsconfigFiles(
  extendsField: unknown,
  baseDir: string,
): string[] {
  const targets = readStringArray(
    typeof extendsField === 'string' ? [extendsField] : extendsField,
  );
  return targets
    .filter((target) => target.startsWith('.') || path.isAbsolute(target))
    .map((target) => path.resolve(baseDir, target))
    .map((target) => (target.endsWith('.json') ? target : `${target}.json`));
}

function readDeclaredOutputDirs(
  compilerOptions: unknown,
  baseDir: string,
): OutputDirs {
  const options = isRecord(compilerOptions) ? compilerOptions : {};
  return {
    outDir:
      typeof options.outDir === 'string'
        ? path.resolve(baseDir, options.outDir)
        : undefined,
    rootDir:
      typeof options.rootDir === 'string'
        ? path.resolve(baseDir, options.rootDir)
        : undefined,
  };
}

function readTsconfigOutputDirs(
  tsconfigFile: string,
  visitedFiles: readonly string[],
): OutputDirs {
  const parsed = readJsoncFile(tsconfigFile);
  if (!isRecord(parsed) || visitedFiles.includes(tsconfigFile)) {
    return { outDir: undefined, rootDir: undefined };
  }
  const baseDir = path.dirname(tsconfigFile);
  const own = readDeclaredOutputDirs(parsed.compilerOptions, baseDir);
  if (own.outDir !== undefined && own.rootDir !== undefined) return own;
  const inherited = listExtendedTsconfigFiles(parsed.extends, baseDir).map(
    (target) => readTsconfigOutputDirs(target, [...visitedFiles, tsconfigFile]),
  );
  return {
    outDir: own.outDir ?? inherited.findLast((dirs) => dirs.outDir)?.outDir,
    rootDir: own.rootDir ?? inherited.findLast((dirs) => dirs.rootDir)?.rootDir,
  };
}

function readBuildLayouts(packageDir: string): BuildLayout[] {
  return readDirEntries(packageDir)
    .filter((entry) => entry.isFile() && /^tsconfig.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((tsconfigName) => {
      const { outDir, rootDir } = readTsconfigOutputDirs(
        path.join(packageDir, tsconfigName),
        [],
      );
      if (outDir === undefined) return [];
      // Without rootDir tsc uses the common root of its inputs, which in
      // practice is the package dir or its src folder.
      const rootDirs =
        rootDir === undefined
          ? [packageDir, path.join(packageDir, 'src')]
          : [rootDir];
      return [{ tsconfigName, outDir, rootDirs }];
    });
}

function mapCompiledFileToSource(
  compiledFile: string,
  sourceExtension: string,
  layouts: readonly BuildLayout[],
): { readonly source: string; readonly tsconfigName: string } | undefined {
  for (const layout of layouts) {
    if (!isInside(layout.outDir, compiledFile)) continue;
    const relative = path.relative(layout.outDir, compiledFile);
    const sourceRelative = `${relative.slice(0, -path.extname(relative).length)}${sourceExtension}`;
    const source = layout.rootDirs
      .map((rootDir) => path.join(rootDir, sourceRelative))
      .find(isFile);
    if (source !== undefined) {
      return { source, tsconfigName: layout.tsconfigName };
    }
  }
  return undefined;
}

function scoreDeclaredDatasource(
  declaration: DatasourceDeclaration,
  packageDir: string,
  workspaceRoot: string,
  layouts: readonly BuildLayout[],
): DatasourceCandidate | undefined {
  const declaredFile = path.resolve(packageDir, declaration.declaredPath);
  const shownDeclared = toDisplayPath(packageDir, declaredFile);
  const evidence = `package.json script "${declaration.scriptName}" in ${describePackage(workspaceRoot, packageDir)}`;
  if (/\.[cm]?ts$/.test(declaredFile) && !/\.d\.[cm]?ts$/.test(declaredFile)) {
    return isFile(declaredFile)
      ? { file: fs.realpathSync(declaredFile), score: 100, foundBy: evidence }
      : undefined;
  }
  const sourceExtension = new Map([
    ['.js', '.ts'],
    ['.mjs', '.mts'],
    ['.cjs', '.cts'],
  ]).get(path.extname(declaredFile));
  if (sourceExtension === undefined) return undefined;
  const mapped = mapCompiledFileToSource(
    declaredFile,
    sourceExtension,
    layouts,
  );
  if (mapped !== undefined) {
    return {
      file: fs.realpathSync(mapped.source),
      score: 90,
      foundBy: `${evidence}, ${shownDeclared} mapped to ${toDisplayPath(packageDir, mapped.source)} via ${mapped.tsconfigName}`,
    };
  }
  if (!isFile(declaredFile)) return undefined;
  return {
    file: fs.realpathSync(declaredFile),
    score: 80,
    foundBy: `${evidence}, compiled file ${shownDeclared} (no TypeScript source found)`,
  };
}

function findScriptCandidatesInPackage(
  packageDir: string,
  workspaceRoot: string,
): DatasourceCandidate[] {
  const declarations = collectDatasourceDeclarations(
    readPackageManifest(packageDir).scripts,
  );
  if (declarations.length === 0) return [];
  const layouts = readBuildLayouts(packageDir);
  return declarations.flatMap(
    (declaration) =>
      scoreDeclaredDatasource(
        declaration,
        packageDir,
        workspaceRoot,
        layouts,
      ) ?? [],
  );
}

function isDatasourceFileName(packageRelativePath: string): boolean {
  return (
    /\.[cm]?[jt]s$/.test(packageRelativePath) &&
    !/\.d\.[cm]?ts$/.test(packageRelativePath) &&
    !/\.(?:spec|test)\./.test(packageRelativePath) &&
    /(^|[/._-])(data-?sources?|ormconfig|typeorm[._-]?config)([/._-]|$)/i.test(
      packageRelativePath,
    )
  );
}

function isPrunedDirectory(name: string): boolean {
  return (
    name.startsWith('.') ||
    ['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__'].includes(
      name,
    )
  );
}

function listDatasourceNamedFiles(
  packageDir: string,
  currentDir: string,
  nestedPackageDirs: ReadonlySet<string>,
): string[] {
  const matches: string[] = [];
  for (const entry of readDirEntries(currentDir)) {
    const entryPath = path.join(currentDir, entry.name);
    if (
      entry.isDirectory() &&
      !isPrunedDirectory(entry.name) &&
      !nestedPackageDirs.has(entryPath)
    ) {
      matches.push(
        ...listDatasourceNamedFiles(packageDir, entryPath, nestedPackageDirs),
      );
    } else if (
      entry.isFile() &&
      isDatasourceFileName(toDisplayPath(packageDir, entryPath))
    ) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function fileMentionsTypeormDatasource(file: string): boolean {
  const text = readTextFile(file);
  return (
    text.includes('DataSource') ||
    /\btype\s*:\s*['"`](?:postgres|mysql|mariadb|sqlite|better-sqlite3|mssql|oracle|cockroachdb|sap|spanner|mongodb|aurora-mysql|aurora-postgres|sqljs|expo|nativescript|react-native|capacitor|cordova)['"`]/.test(
      text,
    )
  );
}

function findNameCandidatesInPackage(
  packageDir: string,
  scope: SearchScope,
): DatasourceCandidate[] {
  // Workspace members are walked on their own turn, so the walk of a parent
  // package skips them instead of scanning every member twice.
  const nestedPackageDirs = new Set(
    scope.packageDirs.filter((dir) => dir !== packageDir),
  );
  return listDatasourceNamedFiles(packageDir, packageDir, nestedPackageDirs)
    .filter(fileMentionsTypeormDatasource)
    .map((file) => ({
      file: fs.realpathSync(file),
      score: 30,
      foundBy: `file name convention with TypeORM content: ${toDisplayPath(packageDir, file)} in ${describePackage(scope.workspaceRoot, packageDir)}`,
    }));
}

function listAutomaticEnvFiles(
  workspaceRoot: string,
  packageDir: string,
): string[] {
  return listAncestorDirs(packageDir)
    .filter((dir) => dir === workspaceRoot || isInside(workspaceRoot, dir))
    .toReversed()
    .map((dir) => path.join(dir, '.env'))
    .filter(isFile);
}

function readEnvFileEntries(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ProjectLocationError({ reason: 'env-file-missing', file });
  }
  return Object.fromEntries(
    Object.entries(parseEnv(text)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
