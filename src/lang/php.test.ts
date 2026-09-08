import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedSymbol } from '../parser/types.js';
import type { ProjectFacts, ResolveContext } from './types.js';
import { php } from './php.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(php.grammar('a.php') as Parser.Language);
  return php.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string, owner?: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name && (owner === undefined || symbol.owner === owner));
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

/**
 * The PSR-4 map lives on `ProjectFacts` under a field `src/lang/types.ts` does
 * not carry yet, so it is written here through the same shape php.ts reads it
 * through. When the field lands, this type goes and the object is a plain
 * `ProjectFacts`.
 */
type FactsWithPsr4 = ProjectFacts & { psr4?: ReadonlyMap<string, readonly string[]> };

function facts(psr4?: ReadonlyMap<string, readonly string[]>): FactsWithPsr4 {
  const base: FactsWithPsr4 = { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() };
  return psr4 === undefined ? base : { ...base, psr4 };
}

/** A resolve context over a file set, with only what the case under test needs. */
function context(options: {
  from: string;
  specifier: string;
  files: readonly string[];
  modules?: Record<string, string>;
  declarations?: Record<string, readonly string[]>;
  psr4?: ReadonlyMap<string, readonly string[]>;
}): ResolveContext {
  return {
    from: options.from,
    specifier: options.specifier,
    files: new Set(options.files),
    modules: new Map(Object.entries(options.modules ?? {})),
    declarations: new Map(
      Object.entries(options.declarations ?? {}).map(([file, names]) => [file, new Set(names)] as const),
    ),
    imports: new Map(),
    facts: facts(options.psr4),
  };
}

const resolve = (options: Parameters<typeof context>[0]): string | null => php.resolve(context(options));

test('every form of use is written down as the graph reads it', () => {
  const { imports, bindings, moduleName } = parse(`<?php
    namespace App\\Models;

    use App\\Contracts\\Loggable;
    use App\\Support\\Str as S;
    use App\\Support\\{Arr, Collection as C};
    use function App\\Helpers\\slugify;
    use const App\\Helpers\\VERSION;
    use \\JsonSerializable;

    class User implements Loggable, JsonSerializable {
        public function go(): void { S::of(Arr::first(C::make())); slugify(VERSION); }
    }
  `);

  assert.equal(moduleName, 'App\\Models');
  assert.deepEqual(sorted(imports), [
    'App\\Contracts\\Loggable',
    'App\\Helpers\\VERSION',
    'App\\Helpers\\slugify',
    'App\\Support\\Arr',
    'App\\Support\\Collection',
    'App\\Support\\Str',
    'JsonSerializable',
  ]);

  const bound = new Map((bindings ?? []).map((binding) => [binding.local, binding.specifier]));
  // The alias is the key, because the alias is what every reference in the file
  // is written with.
  assert.equal(bound.get('S'), 'App\\Support\\Str');
  assert.equal(bound.get('C'), 'App\\Support\\Collection');
  assert.equal(bound.get('Arr'), 'App\\Support\\Arr');
  assert.equal(bound.get('slugify'), 'App\\Helpers\\slugify');
  assert.equal(bound.get('JsonSerializable'), 'JsonSerializable');
});

test('a name the file never wrote a use for hangs off its own namespace', () => {
  const { imports, bindings } = parse(`<?php
    namespace App\\Models;
    use App\\Support as Sup;

    class User extends Model {
        public function go(Profile $p): void {
            new Sup\\Bag();
            \\App\\Deep\\Thing::run();
            namespace\\Sibling::run();
        }
    }
  `);

  // `Model` and `Profile` are named with no `use` at all: PHP resolves them
  // against the current namespace, and so does this.
  assert.ok(imports.includes('App\\Models\\Model'));
  assert.ok(imports.includes('App\\Models\\Profile'));
  // An aliased namespace prefix is substituted, not treated as a class.
  assert.ok(imports.includes('App\\Support\\Bag'));
  // A leading backslash is already absolute, and `namespace\` is the current one.
  assert.ok(imports.includes('App\\Deep\\Thing'));
  assert.ok(imports.includes('App\\Models\\Sibling'));
  // `use App\Support as Sup` names a namespace, not a file, and is not reported
  // as an import that failed: every reference through it resolves on its own.
  assert.ok(!imports.includes('App\\Support'));

  const bound = new Map((bindings ?? []).map((binding) => [binding.local, binding.specifier]));
  // The binding is keyed by the text the file wrote, so a call written
  // `\App\Deep\Thing::run()` and one written `Thing::run()` cannot collide.
  assert.equal(bound.get('\\App\\Deep\\Thing'), 'App\\Deep\\Thing');
});

test('an unqualified function call is a binding and never an import', () => {
  const { imports, bindings } = parse(`<?php
    namespace Illuminate\\Support;
    function go(): void { trim(helper()); Other\\thing(); }
  `);

  // PHP's standard library is one flat global namespace, so an unqualified call
  // is a candidate for the file's namespace and then for the global one — and it
  // is almost always the second. Reported as imports, laravel/framework's five
  // worst "unresolved" specifiers were `trim`, `is_null`, `file_exists`,
  // `str_replace` and `isset`.
  assert.deepEqual(sorted(imports), ['Illuminate\\Support\\Other\\thing']);
  const bound = new Map((bindings ?? []).map((binding) => [binding.local, binding.specifier]));
  assert.equal(bound.get('trim'), 'Illuminate\\Support\\trim|trim');
  assert.equal(bound.get('helper'), 'Illuminate\\Support\\helper|helper');
});

test('a class box is a UML class box, attributes before operations', () => {
  const { symbols } = parse(`<?php
    namespace App;
    abstract class User extends Model implements Loggable {
        use HasUuid, Timestamps;

        public const ROLE = 'admin';
        protected static int $count = 0;
        private Logger $log;
        public ?Profile $profile = null;

        public function __construct(private Mailer $mailer, Logger $log) { $this->log = $log; }
        abstract protected function name(): string;
    }
  `);

  const user = byName(symbols, 'User');
  assert.equal(user.kind, 'class');
  assert.equal(user.isAbstract, true);
  assert.deepEqual(user.implements, ['Loggable']);
  // A trait's members become the class's own, which is generalisation; see the
  // argument in heritageOf.
  assert.deepEqual(user.extends, ['Model', 'HasUuid', 'Timestamps']);

  const owned = symbols.filter((symbol) => symbol.owner === 'User').map((symbol) => symbol.name);
  assert.deepEqual(owned, ['mailer', 'ROLE', 'count', 'log', 'profile', '__construct', 'name']);

  assert.equal(byName(symbols, 'count', 'User').visibility, 'protected');
  assert.equal(byName(symbols, 'count', 'User').isStatic, true);
  assert.equal(byName(symbols, 'ROLE', 'User').isStatic, true);
  assert.equal(byName(symbols, 'name', 'User').isAbstract, true);
  // Absent, not 'public': the source did not say, and a PHP method with no
  // modifier is public by the language rather than by the declaration.
  assert.equal(byName(symbols, '__construct', 'User').visibility, 'public');
  assert.equal(byName(symbols, 'name', 'User').visibility, 'protected');
});

test('an association is what the property declaration wrote', () => {
  const { symbols } = parse(`<?php
    class Store {
        private Logger $log;
        public ?Profile $profile = null;
        protected Cache $cache;
        private Index $index;
        public Session|Token $either;
        public function __construct(private Mailer $mailer, Cache $cache) {
            $this->cache = $cache;
            $this->index = new Index();
        }
    }
  `);

  assert.equal(byName(symbols, 'log', 'Store').typeName, 'Logger');
  assert.equal(byName(symbols, 'log', 'Store').optional, undefined);
  assert.equal(byName(symbols, 'profile', 'Store').typeName, 'Profile');
  assert.equal(byName(symbols, 'profile', 'Store').optional, true);
  // Handed in through the constructor, both ways PHP writes it.
  assert.equal(byName(symbols, 'cache', 'Store').handedIn, true);
  assert.equal(byName(symbols, 'mailer', 'Store').handedIn, true);
  assert.equal(byName(symbols, 'mailer', 'Store').typeName, 'Mailer');
  // Built by the class itself, and of the property's own declared type.
  assert.equal(byName(symbols, 'index', 'Store').composed, true);
  assert.equal(byName(symbols, 'index', 'Store').handedIn, undefined);
  // A union of two real classes names neither.
  assert.equal(byName(symbols, 'either', 'Store').typeName, undefined);
});

test('a trait is a class box, an interface an interface, an enum a class', () => {
  const { symbols } = parse(`<?php
    interface Runner extends Base { public function run(): void; }
    trait HasUuid { protected string $value; public function uuid(): string { return $this->value; } }
    enum Status: string implements HasLabel {
        case Draft = 'draft';
        case Live = 'live';
        public function label(): string { return Helper::label(); }
    }
  `);

  assert.equal(byName(symbols, 'Runner').kind, 'interface');
  assert.deepEqual(byName(symbols, 'Runner').extends, ['Base']);
  assert.equal(byName(symbols, 'HasUuid').kind, 'class');
  assert.equal(byName(symbols, 'uuid', 'HasUuid').kind, 'method');

  assert.equal(byName(symbols, 'Status').kind, 'class');
  assert.deepEqual(byName(symbols, 'Status').implements, ['HasLabel']);
  // A case is an instance of its own enum: an attribute, and a static one.
  assert.equal(byName(symbols, 'Draft', 'Status').kind, 'field');
  assert.equal(byName(symbols, 'Draft', 'Status').isStatic, true);
  assert.deepEqual(sorted(byName(symbols, 'label', 'Status').calls), ['Helper.label']);
});

test('a static call is qualified, because :: says so', () => {
  const { symbols } = parse(`<?php
    namespace App;
    class Job extends Base {
        public function run(Repo $repo, $untyped): void {
            Str::slug('x');
            \\App\\Deep\\Thing::go();
            self::helper();
            static::other();
            parent::boot();
            $this->save();
            $repo->persist();
            $untyped->whatever();
            $built = new Client();
            $built->send();
            new Mailer();
        }
    }
  `);

  // The receiver is the text the file wrote, backslash and all, because that is
  // the key its binding is filed under — see writtenName.
  assert.deepEqual(sorted(byName(symbols, 'run', 'Job').calls), [
    'Base.boot',
    'Client',
    'Client.send',
    'Job.helper',
    'Job.other',
    'Job.save',
    'Mailer',
    'Repo.persist',
    'Str.slug',
    '\\App\\Deep\\Thing.go',
  ]);
  // `$untyped->whatever()` reaches the graph as nothing at all — not as the
  // bare `whatever`, which could only ever land on a same-named declaration
  // somewhere else. A missing edge is a gap; a wrong one is a lie.
});

test('a property reached through this carries the call, when its type was written', () => {
  const { symbols } = parse(`<?php
    class Service {
        private Logger $log;
        private $bare;
        public function go(): void {
            $this->log->write('x');
            $this->bare->write('x');
        }
    }
  `);

  assert.deepEqual(sorted(byName(symbols, 'go', 'Service').calls), ['Logger.write']);
});

test('an anonymous class body is nobody else s this', () => {
  const { symbols } = parse(`<?php
    class Outer {
        public function go(): void {
            $x = new class extends Base { public function run(): void { $this->hidden(); Str::slug('x'); } };
            $this->mine();
        }
    }
  `);

  const calls = sorted(byName(symbols, 'go', 'Outer').calls);
  // `$this->hidden()` inside the anonymous body is that class's, not Outer's;
  // `Str::slug()` is unambiguous whoever wrote it, and `Base` is constructed.
  assert.ok(calls.includes('Outer.mine'));
  assert.ok(calls.includes('Str.slug'));
  assert.ok(!calls.includes('Outer.hidden'));
});

test('a call outside every symbol belongs to the file', () => {
  const parsed = parse(`<?php
    namespace App;
    use App\\Support\\Route;
    Route::get('/', 'x');
    $app = new Application();
    $app->boot();
    function declared(): void { helper(); }
  `);

  assert.deepEqual(sorted(parsed.calls ?? []), ['Application', 'Application.boot', 'Route.get']);
  // The function's own call is the function's, not the file's.
  assert.deepEqual(byName(parsed.symbols, 'declared').calls, ['helper']);
});

test('a class writes its dependencies in the signatures of its operations', () => {
  const { symbols } = parse(`<?php
    class Report {
        private Store $store;
        public function build(Clock $clock, int $n): Sheet { return new Sheet(); }
    }
  `);

  // The store is held as a field, so it is an association and not a dependency;
  // the graph is what refuses the weaker line, and this only has to list them.
  assert.deepEqual(sorted(byName(symbols, 'Report').dependsOn ?? []), ['Clock', 'Sheet']);
});

test('a namespace block and a conditional declaration are still the file s', () => {
  const { symbols, moduleName } = parse(`<?php
    namespace App\\Compat {
        if (!class_exists(Shim::class)) {
            class Shim {}
        }
        class Always {}
    }
  `);

  assert.equal(moduleName, 'App\\Compat');
  assert.deepEqual(sorted(symbols.map((symbol) => symbol.name)), ['Always', 'Shim']);
});

test('psr-4 turns a name into a path, longest prefix first and then the shorter', () => {
  const psr4 = new Map<string, readonly string[]>([
    ['Illuminate', ['src/Illuminate']],
    ['Illuminate\\Support', ['src/Illuminate/Macroable', 'src/Illuminate/Collections']],
  ]);
  const files = ['src/Illuminate/Collections/Str.php', 'src/Illuminate/Support/Facades/Log.php'];

  // The long prefix answers for what its directories actually hold …
  assert.equal(
    resolve({ from: 'src/Illuminate/Auth/Guard.php', specifier: 'Illuminate\\Support\\Str', files, psr4 }),
    'src/Illuminate/Collections/Str.php',
  );
  // … and the short one for everything else under it, which is why every
  // matching prefix is tried rather than only the longest.
  assert.equal(
    resolve({ from: 'src/Illuminate/Auth/Guard.php', specifier: 'Illuminate\\Support\\Facades\\Log', files, psr4 }),
    'src/Illuminate/Support/Facades/Log.php',
  );
});

test('without a map, the namespace each file declared is the answer', () => {
  const files = ['app/Models/User.php', 'tests/Models/User.php'];
  const modules = { 'app/Models/User.php': 'App\\Models', 'tests/Models/User.php': 'Tests\\Models' };

  assert.equal(
    resolve({ from: 'app/Http/Controller.php', specifier: 'App\\Models\\User', files, modules }),
    'app/Models/User.php',
  );
  assert.equal(
    resolve({ from: 'app/Http/Controller.php', specifier: 'Tests\\Models\\User', files, modules }),
    'tests/Models/User.php',
  );
  // A name no file in the project declares resolves to nothing, which is what
  // `use PHPUnit\Framework\TestCase` has to do.
  assert.equal(resolve({ from: 'app/Http/Controller.php', specifier: 'PHPUnit\\Framework\\TestCase', files, modules }), null);
});

test('the nearest of two files declaring the same name wins', () => {
  const files = ['src/main/App/Store.php', 'src/test/App/Store.php'];
  const modules = { 'src/main/App/Store.php': 'App', 'src/test/App/Store.php': 'App' };

  assert.equal(resolve({ from: 'src/test/App/StoreTest.php', specifier: 'App\\Store', files, modules }), 'src/test/App/Store.php');
  assert.equal(resolve({ from: 'src/main/App/Cart.php', specifier: 'App\\Store', files, modules }), 'src/main/App/Store.php');
});

test('a function is found by name inside its namespace, not by its file name', () => {
  const files = ['app/Helpers/helpers.php'];
  const modules = { 'app/Helpers/helpers.php': 'App\\Helpers' };
  const declarations = { 'app/Helpers/helpers.php': ['slugify', 'titleCase'] };

  assert.equal(
    resolve({ from: 'app/Models/Post.php', specifier: 'App\\Helpers\\slugify', files, modules, declarations }),
    'app/Helpers/helpers.php',
  );
  assert.equal(
    resolve({ from: 'app/Models/Post.php', specifier: 'App\\Helpers\\missing', files, modules, declarations }),
    null,
  );
});

test('an unqualified function tries its own namespace and then the global one', () => {
  const files = ['app/Helpers/helpers.php', 'globals.php'];
  const modules = { 'app/Helpers/helpers.php': 'App\\Helpers' };
  const declarations = { 'app/Helpers/helpers.php': ['slugify'], 'globals.php': ['slugify', 'shout'] };
  const from = 'app/Helpers/Post.php';

  // The candidates arrive in PHP's own order, and the first hit is the only
  // meaning the reference can have.
  assert.equal(
    resolve({ from, specifier: 'App\\Helpers\\slugify|slugify', files, modules, declarations }),
    'app/Helpers/helpers.php',
  );
  assert.equal(
    resolve({ from, specifier: 'App\\Helpers\\shout|shout', files, modules, declarations }),
    'globals.php',
  );
  assert.equal(resolve({ from, specifier: 'App\\Helpers\\trim|trim', files, modules, declarations }), null);
});
