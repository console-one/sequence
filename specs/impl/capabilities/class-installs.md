# Runtime Class Installation

Runtime classes are capabilities with constructor dependencies, lifecycle management, and typed contract IO. Installing a class mounts its capabilities AND its dependency requirements — like Spring Boot dependency injection but at the environment level.

## Original Notes

This should enable the installation of runtime classes that are captioned, at least, with the system providing the capability to label with the considerations that allow the classes to be mounted or unmounted within certain environments. Examples of these classes might be the S3 storage and S3 storage layer, general libraries that engage with the actual environment variables. The capability to have these capabilities labeled, organized, and required for the installation of other classes ultimately enables something like Spring Boot but occurring at the environment level. Every environment is labeled with the type of classes that it has available to be able to compose new components via recursive blueprinting and fill out via prompts.

## The Core Pattern

A class is a group of capabilities with:
- A constructor (what it needs to instantiate)
- Provided capabilities (what it gives to the Sequence)
- Dependencies (other classes that must be installed first)
- Lifecycle (mount/unmount/health)

```ft
-- An S3 storage class
S3Storage = [
  -- Constructor dependencies (must be provided to install)
  constructor = {
    bucket: string,
    region: string,
    credentials: { accessKey: string, secretKey: string }
  }

  -- What this class provides when installed
  read = (key: string) -> { content: string, size: number >= 0, lastModified: number }
    | read(key).content = prev.written  @[T_out..next_write(key).T_out)  ~survival(exp, 0.0001)
  
  write = (key: string, content: string) -> { ok: true, etag: string }
  
  list = (prefix: string) -> [{ key: string, size: number, lastModified: number }]
  
  delete = (key: string) -> { ok: true }

  -- Health check
  healthy = boolean | healthy = (lastPing > _rt - 30000)

  -- Depends on: credentials must be available
  "Requires env.constants to provide AWS credentials"
  ref("./env-installs")
]

-- Installing S3Storage: provide constructor args, get capabilities
storage = S3Storage
storage << { bucket: "my-data", region: "us-east-1" }
storage << { credentials: ref("env.constants.aws") }
-- Now storage.read, storage.write, storage.list, storage.delete are capabilities
cap storage.read
cap storage.write
cap storage.list
cap storage.delete
```

## Recursive Blueprinting

Classes can depend on other classes. Installing a class that depends on S3Storage first checks that S3Storage is installed (or installs it):

```ft
DataPipeline = [
  -- Dependencies: these classes must be installed first
  requires = [S3Storage, PostgresDB]

  -- Constructor: additional config beyond dependencies
  constructor = { pipelineName: string, schedule: string }

  -- Capabilities provided (use dependencies)
  ingest = (source: string) -> { ok: true, rowsProcessed: number }
    | let raw = S3Storage.read(source).content
    | let parsed = transform(raw)
    | PostgresDB.insert("pipeline_data", parsed).ok = true

  status = () -> { running: boolean, lastRun: number, rowsTotal: number }
]
```

Installing DataPipeline checks: is S3Storage installed? Is PostgresDB installed? If not, their constructors become gaps — the user is prompted to provide credentials and config.

## Requirements

**R1**: A runtime class SHALL declare its constructor type — the inputs required for instantiation. Constructor fields that are not provided become gaps.
- *Rationale*: The constructor IS the installation form. Unprovided fields are what the user (or an agent) needs to fill.
- *Verifiable by*: Installing a class without providing all constructor fields surfaces the missing fields as obligations.

**R2**: A runtime class SHALL declare its dependencies — other classes that must be installed before it. Attempting to install a class with unmet dependencies SHALL suspend.
- *Rationale*: S3Storage without AWS credentials can't work. The suspension mechanism prevents partial installations.
- *Verifiable by*: Installing DataPipeline without S3Storage suspends. Installing S3Storage first resumes DataPipeline.

**R3**: After installation, a class's provided capabilities SHALL be registered on the Sequence and discoverable via gap resolution.
- *Rationale*: Installed capabilities must be usable. If a task needs S3 read, installing S3Storage should make the gap resolvable.
- *Verifiable by*: After installing S3Storage, `seq.search({ content: string })` finds `storage.read`.

**R4**: A class SHALL be unmountable. Uninstalling a class removes its capabilities AND invalidates anything that depends on it.
- *Rationale*: If S3Storage is uninstalled, DataPipeline (which depends on it) should invalidate — its capabilities are no longer satisfiable.
- *Verifiable by*: Uninstalling S3Storage causes DataPipeline's capabilities to invalidate via while-clause break.

**R5**: Every environment SHALL expose what classes are available for installation in that runtime. An Electron environment has different available classes than a Lambda environment.
- *Rationale*: "Every environment is labeled with the type of classes that it has available." A browser can't install native filesystem classes. A Lambda can't install GUI classes.
- *Verifiable by*: Querying `env.availableClasses` returns only classes compatible with the current runtime.

**R6**: Class installation SHALL support recursive composition — a class's capabilities can reference capabilities from its dependencies, and the type system validates the composition at install time.
- *Rationale*: DataPipeline uses S3Storage.read in its ingest capability. The type composition must verify that S3Storage.read's output type is compatible with what ingest needs.
- *Verifiable by*: Installing DataPipeline with an incompatible S3Storage (wrong output type) fails at compose time.

## FT System Demands

- Constructor dependencies ARE `where` clauses on the install mount — suspend until deps are met
- Class capabilities ARE typed function schemas + cap registrations — existing mount operations
- Dependency chains ARE conjunction tracking — installing class A unblocks class B which unblocks class C
- Uninstall cascade IS while-clause invalidation — class B depends on A via `while A.healthy = true`
- Available classes per environment ARE the environment manifest — just entries in the manifest that describe what CAN be installed

The pattern is: a class is a block type. Installing it = narrowing it with constructor args. Its capabilities activate when fully concrete. Dependencies are where-clauses. Lifecycle is while-clauses. No new kernel concepts.
