# Runtime Class Installation

## Original Notes

This should enable the installation of runtime classes that are captioned, at least, with the system providing the capability to label with the considerations that allow the classes to be mounted or unmounted within certain environments. Examples of these classes might be the S3 storage and S3 storage layer, general libraries that engage with the actual environment variables. The capability to have these capabilities labeled, organized, and required for the installation of other classes ultimately enables something like Spring Boot but occurring at the environment level. Every environment is labeled with the type of classes that it has available to be able to compose new components via recursive blueprinting and fill out via prompts.

## Problem Context

- **Actor(s)**: Environments (hosting runtimes), runtime classes (capability bundles), developers (composing systems from classes), agents (filling in configuration prompts).
- **Domain**: Dependency injection and capability management at the environment level. Classes are groups of capabilities (e.g., S3 storage, database access) that can be installed into environments, with declared dependencies, lifecycle, and typed contracts.
- **Core Tension**: Classes have interdependencies (a data pipeline needs storage and a database), but the available classes vary by environment (browser vs. Lambda vs. Electron). The system must enforce dependency ordering, surface missing configuration, and prevent partial installations -- all while keeping each environment's class catalog honest about what it can actually support.

## Requirements

**R1**: A runtime class SHALL declare a constructor schema -- the set of typed inputs required for instantiation.
- *Rationale*: The constructor is the installation contract. Without declaring what it needs, the system cannot determine what configuration is missing.
- *Verifiable by*: Inspecting a class definition reveals every required input with its type. Attempting to install without providing all required inputs surfaces exactly the missing fields.

**R2**: A runtime class SHALL declare its provided capabilities -- the operations and data it makes available after installation.
- *Rationale*: Consumers need to know what a class offers before installing it. Provided capabilities are the class's public contract.
- *Verifiable by*: After successful installation, every declared capability is accessible and callable with the documented input/output types.

**R3**: A runtime class SHALL declare its dependencies -- other classes that must be installed before it can be instantiated.
- *Rationale*: A data pipeline class that depends on S3 storage cannot function if storage is not available. Dependencies must be explicit so the system can enforce ordering.
- *Verifiable by*: Attempting to install a class whose dependencies are not met results in an error identifying the unmet dependencies. Installation succeeds only after all dependencies are satisfied.

**R4**: When a class is installed with incomplete constructor inputs, the system SHALL identify the specific missing fields and present them for resolution (by a user, agent, or automated source).
- *Rationale*: This is the "fill out via prompts" behavior. Missing configuration should not silently fail; it should be surfaced as actionable items.
- *Verifiable by*: Installing a class with 2 of 4 required fields returns exactly the 2 missing fields with their types and descriptions.

**R5**: A runtime class SHALL support uninstallation. Uninstalling a class SHALL remove its provided capabilities and invalidate any installed classes that depend on it.
- *Rationale*: If S3 storage is removed, a data pipeline that depends on it is no longer viable. Cascade invalidation prevents orphaned dependencies.
- *Verifiable by*: After uninstalling a class, its capabilities are no longer accessible, and any dependent classes report their dependencies as unmet.

**R6**: Each environment SHALL declare which runtime classes are available for installation in that environment.
- *Rationale*: A browser environment cannot install native filesystem classes. A Lambda environment cannot install GUI classes. The class catalog must reflect the environment's actual capabilities.
- *Verifiable by*: Querying an environment's available classes returns only classes compatible with that runtime. Attempting to install an unavailable class produces an error.

**R7**: Class installation SHALL support recursive composition -- a class's capabilities MAY reference capabilities from its dependencies, and the system SHALL validate type compatibility across the composition at install time.
- *Rationale*: A data pipeline's "ingest" capability may internally use S3 storage's "read" capability. The output type of "read" must be compatible with what "ingest" expects. Catching type mismatches at install time prevents runtime failures.
- *Verifiable by*: Installing a composite class with type-incompatible dependencies produces an error identifying the mismatch. Installing with compatible dependencies succeeds.

**R8**: Runtime classes SHALL expose health status, allowing the system to determine whether an installed class is operational.
- *Rationale*: An installed class may become non-functional (e.g., credentials expired, external service down). Health status enables the system to react to degradation.
- *Verifiable by*: An installed class reports healthy when operational and unhealthy when its underlying service is unreachable.

## Acceptance Criteria

**AC1** [R1, R4]: Given a class with constructor fields {bucket: string, region: string, credentials: object}, when installed with only {bucket: "my-data"}, then the system reports {region, credentials} as missing with their expected types.

**AC2** [R3]: Given class DataPipeline depending on classes S3Storage and PostgresDB, when DataPipeline is installed without S3Storage present, then installation fails citing S3Storage as an unmet dependency.

**AC3** [R3, R4]: Given class DataPipeline depending on S3Storage, when S3Storage is installed first (with complete constructor inputs) and then DataPipeline is installed, then DataPipeline's capabilities become available.

**AC4** [R5]: Given S3Storage installed and DataPipeline installed (depending on S3Storage), when S3Storage is uninstalled, then DataPipeline's capabilities become unavailable and its dependency on S3Storage is reported as unmet.

**AC5** [R6]: Given a browser environment with classes [HttpClient, LocalStorage] available and a server environment with classes [S3Storage, PostgresDB, HttpClient] available, when querying each environment's class catalog, then only the environment-appropriate classes are listed.

**AC6** [R7]: Given DataPipeline's ingest capability expecting string input from S3Storage.read, when S3Storage is replaced with a variant whose read returns binary, then DataPipeline installation fails with a type compatibility error.

**AC7** [R8]: Given S3Storage installed and healthy, when the underlying S3 service becomes unreachable, then the health status reports unhealthy.

## Open Questions

- What is the resolution strategy when uninstalling a class that has dependents? Options: cascade uninstall, block uninstall until dependents are removed, or mark dependents as degraded.
- Should class versioning be supported (e.g., upgrading S3Storage v1 to v2 while DataPipeline is installed)?
- How should circular dependencies be handled (class A depends on B, B depends on A)? Likely prohibited, but needs explicit policy.
