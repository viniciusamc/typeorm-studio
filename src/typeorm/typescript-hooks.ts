import fs from 'node:fs';
import {
  createRequire,
  registerHooks,
  setSourceMapsSupport,
} from 'node:module';
import type {
  LoadFnOutput,
  LoadHookContext,
  LoadHookSync,
  ResolveFnOutput,
  ResolveHookContext,
  ResolveHookSync,
} from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Typescript from 'typescript';

export type ModuleSystem = 'module' | 'commonjs';

type HookEnvironment = {
  readonly packageTsconfigPath: string | undefined;
  readonly loadTypescript: () => typeof Typescript;
  readonly tsconfigPathByDirectory: Map<string, string | undefined>;
  readonly compilerOptionsByTsconfigPath: Map<
    string,
    Typescript.CompilerOptions
  >;
};

const probeExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

const requireFromHooks = createRequire(import.meta.url);

const packageJsonPathByDirectory = new Map<string, string | undefined>();
const moduleSystemByPackageJsonPath = new Map<string, ModuleSystem>();

// Node and TypeORM agree on this rule, so the compile step and the choice between
// import() and require() of the DataSource file both ask here.
export function detectModuleSystem(filePath: string): ModuleSystem {
  const extension = path.extname(filePath);
  if (extension === '.mjs' || extension === '.mts') return 'module';
  if (extension === '.cjs' || extension === '.cts') return 'commonjs';
  const packageJsonPath = findNearestAncestorFile(
    path.dirname(filePath),
    'package.json',
    packageJsonPathByDirectory,
  );
  if (packageJsonPath === undefined) return 'commonjs';
  return readPackageModuleSystem(packageJsonPath);
}

// Synchronous hooks, so they cover both import() and require(). Install them before
// the first import: a failed ESM import stays cached and cannot be retried.
export function installTypescriptHooks(options: {
  readonly packageDir: string;
}): void {
  const environment: HookEnvironment = {
    packageTsconfigPath: findNearestAncestorFile(
      options.packageDir,
      'tsconfig.json',
      new Map(),
    ),
    loadTypescript: createTypescriptLoader(),
    tsconfigPathByDirectory: new Map(),
    compilerOptionsByTsconfigPath: new Map(),
  };
  setSourceMapsSupport(true, { nodeModules: false, generatedCode: true });
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      resolveWithSourceFallback(environment, specifier, context, nextResolve),
    load: (url, context, nextLoad) =>
      loadWithTranspile(environment, url, context, nextLoad),
  });
}

function createTypescriptLoader(): () => typeof Typescript {
  let loaded: typeof Typescript | undefined;
  return () => {
    const typescript: typeof Typescript =
      loaded ?? requireFromHooks('typescript');
    loaded = typescript;
    return typescript;
  };
}

function readPackageModuleSystem(packageJsonPath: string): ModuleSystem {
  const known = moduleSystemByPackageJsonPath.get(packageJsonPath);
  if (known !== undefined) return known;
  let moduleSystem: ModuleSystem = 'commonjs';
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    );
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      'type' in manifest &&
      manifest.type === 'module'
    ) {
      moduleSystem = 'module';
    }
  } catch {
    // An unreadable package.json counts as CommonJS, the way TypeORM treats it.
  }
  moduleSystemByPackageJsonPath.set(packageJsonPath, moduleSystem);
  return moduleSystem;
}

function resolveWithSourceFallback(
  environment: HookEnvironment,
  specifier: string,
  context: ResolveHookContext,
  nextResolve: Parameters<ResolveHookSync>[2],
): ResolveFnOutput {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const sourceFile = findSourceFile(
      environment,
      specifier,
      context.parentURL,
    );
    if (sourceFile === undefined) throw error;
    // Handing a file: URL back to nextResolve fails on the require() path.
    return { url: pathToFileURL(sourceFile).href, shortCircuit: true };
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return (
    error.code === 'ERR_MODULE_NOT_FOUND' ||
    error.code === 'MODULE_NOT_FOUND' ||
    error.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
  );
}

function findSourceFile(
  environment: HookEnvironment,
  specifier: string,
  parentUrl: string | undefined,
): string | undefined {
  const parentFile =
    parentUrl === undefined ? undefined : convertUrlToFilePath(parentUrl);
  const base = resolveSpecifierBase(specifier, parentFile);
  if (base !== undefined) return probeSourceFile(base);
  if (parentFile === undefined) return undefined;
  return resolveThroughTsconfig(environment, specifier, parentFile);
}

function resolveSpecifierBase(
  specifier: string,
  parentFile: string | undefined,
): string | undefined {
  if (specifier.startsWith('file:')) return convertUrlToFilePath(specifier);
  if (path.isAbsolute(specifier)) return specifier;
  const isRelative =
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../');
  if (!isRelative || parentFile === undefined) return undefined;
  return path.resolve(path.dirname(parentFile), specifier);
}

// Covers the three ways a TypeScript project names a file that exists only as
// source: a compiled extension (./a.js for a.ts), no extension, or a directory.
function probeSourceFile(base: string): string | undefined {
  const extension = path.extname(base);
  const swappedExtensions =
    new Map([
      ['.js', ['.ts', '.tsx']],
      ['.mjs', ['.mts']],
      ['.cjs', ['.cts']],
    ]).get(extension) ?? [];
  const withoutExtension = base.slice(0, base.length - extension.length);
  const found = [
    ...swappedExtensions.map((swapped) => withoutExtension + swapped),
    ...probeExtensions.map((probed) => base + probed),
    ...probeExtensions.map((probed) => path.join(base, `index${probed}`)),
  ].find(isExistingFile);
  return found === undefined ? undefined : fs.realpathSync(found);
}

function resolveThroughTsconfig(
  environment: HookEnvironment,
  specifier: string,
  parentFile: string,
): string | undefined {
  const compilerOptions = findCompilerOptions(
    environment,
    path.dirname(parentFile),
  );
  if (
    compilerOptions === undefined ||
    (compilerOptions.baseUrl === undefined &&
      compilerOptions.paths === undefined)
  ) {
    return undefined;
  }
  const typescript = environment.loadTypescript();
  const resolved = typescript.resolveModuleName(
    specifier,
    parentFile,
    compilerOptions,
    typescript.sys,
  ).resolvedModule;
  if (resolved === undefined || resolved.isExternalLibraryImport) {
    return undefined;
  }
  const resolvedFile = resolved.resolvedFileName;
  if (/\.d\.[cm]?ts$/.test(resolvedFile) || isInsideNodeModules(resolvedFile)) {
    return undefined;
  }
  return fs.realpathSync(resolvedFile);
}

function loadWithTranspile(
  environment: HookEnvironment,
  url: string,
  context: LoadHookContext,
  nextLoad: Parameters<LoadHookSync>[2],
): LoadFnOutput {
  const filePath = convertUrlToFilePath(url);
  if (filePath === undefined) return nextLoad(url, context);
  if (/\.[cm]?tsx?$/.test(filePath) && !isInsideNodeModules(filePath)) {
    return transpileTypescriptFile(environment, filePath);
  }
  if (path.extname(filePath) !== '.json') return nextLoad(url, context);
  try {
    return nextLoad(url, context);
  } catch (error) {
    // Plain `import data from './x.json'` is rejected without an import attribute,
    // but projects compiled to CommonJS never write one.
    if (!hasErrorCode(error, 'ERR_IMPORT_ATTRIBUTE_MISSING')) throw error;
    return {
      format: 'json',
      source: fs.readFileSync(filePath, 'utf8'),
      shortCircuit: true,
    };
  }
}

function transpileTypescriptFile(
  environment: HookEnvironment,
  filePath: string,
): LoadFnOutput {
  const typescript = environment.loadTypescript();
  const moduleSystem = detectModuleSystem(filePath);
  const projectOptions: Typescript.CompilerOptions = findCompilerOptions(
    environment,
    path.dirname(filePath),
  ) ?? {
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    target: typescript.ScriptTarget.ES2022,
  };
  const transpiled = typescript.transpileModule(
    fs.readFileSync(filePath, 'utf8'),
    {
      fileName: filePath,
      compilerOptions: {
        ...projectOptions,
        module:
          moduleSystem === 'module'
            ? typescript.ModuleKind.ESNext
            : typescript.ModuleKind.CommonJS,
        importHelpers: false,
        inlineSourceMap: true,
        inlineSources: true,
        sourceMap: false,
        declaration: false,
        declarationMap: false,
        composite: false,
        incremental: false,
        tsBuildInfoFile: undefined,
        outDir: undefined,
        rootDir: undefined,
        sourceRoot: undefined,
        mapRoot: undefined,
      },
    },
  );
  return {
    format: moduleSystem,
    source: transpiled.outputText,
    shortCircuit: true,
  };
}

function findCompilerOptions(
  environment: HookEnvironment,
  directory: string,
): Typescript.CompilerOptions | undefined {
  const tsconfigPath =
    findNearestAncestorFile(
      directory,
      'tsconfig.json',
      environment.tsconfigPathByDirectory,
    ) ?? environment.packageTsconfigPath;
  if (tsconfigPath === undefined) return undefined;
  const known = environment.compilerOptionsByTsconfigPath.get(tsconfigPath);
  if (known !== undefined) return known;
  const parsed = parseTsconfigOptions(
    environment.loadTypescript(),
    tsconfigPath,
  );
  environment.compilerOptionsByTsconfigPath.set(tsconfigPath, parsed);
  return parsed;
}

function parseTsconfigOptions(
  typescript: typeof Typescript,
  tsconfigPath: string,
): Typescript.CompilerOptions {
  const read = typescript.readConfigFile(tsconfigPath, typescript.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(
      `typescript could not read ${tsconfigPath} (TS${read.error.code}); expected a tsconfig.json with valid JSON, comments allowed`,
    );
  }
  // readDirectory stays empty on purpose: only the options matter, and listing the
  // files behind include/exclude would walk the whole project.
  const parsed = typescript.parseJsonConfigFileContent(
    read.config,
    {
      useCaseSensitiveFileNames: typescript.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: typescript.sys.fileExists,
      readFile: typescript.sys.readFile,
    },
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  // A missing "extends" target would silently drop the decorator settings it carries:
  // TS5083 for a relative path, TS6053 for a package that is not installed.
  const unreadableBase = parsed.errors.find(
    (diagnostic) => diagnostic.code === 5083 || diagnostic.code === 6053,
  );
  if (unreadableBase !== undefined) {
    throw new Error(
      `typescript could not read a file that ${tsconfigPath} extends (TS${unreadableBase.code}); expected the "extends" target to exist, for example after installing the project dependencies`,
    );
  }
  return parsed.options;
}

function findNearestAncestorFile(
  directory: string,
  fileName: string,
  cache: Map<string, string | undefined>,
): string | undefined {
  if (cache.has(directory)) return cache.get(directory);
  const candidate = path.join(directory, fileName);
  const parent = path.dirname(directory);
  let found: string | undefined;
  if (isExistingFile(candidate)) found = candidate;
  else if (parent !== directory)
    found = findNearestAncestorFile(parent, fileName, cache);
  cache.set(directory, found);
  return found;
}

function isExistingFile(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
}

function isInsideNodeModules(filePath: string): boolean {
  // A workspace package linked into node_modules is real source, and its realpath
  // lies outside it.
  let realPath = filePath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    // The path still decides below.
  }
  return realPath.split(path.sep).includes('node_modules');
}

function convertUrlToFilePath(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
