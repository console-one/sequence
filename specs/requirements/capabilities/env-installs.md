# Environment-Native Capability Installation

## Original Notes

So these requirements should be built around the notion that every environment has a set of default capabilities that it is defined for and versioned across that it natively installs and makes available onto any kind of snapshot which is installed within it. For example, one of those capabilities for the environment install is going to be, in certain cases, the capability to install a capability through a variety of blueprint types which we support. Those blueprints could span from installing a set of HTTP labeled endpoints with a variety of constant-type input constraints that we've specialized or created templates for installing. Others could be actual classes in the specific runtime that are installed and labeled with particular contract I/O.

## Problem Context

- **Actor(s)**: Environments (Electron, Node, browser, Lambda), snapshots/sessions loaded within environments, developers and agents installing capabilities.
- **Domain**: Environment-level capability provisioning. Each environment has native capabilities it provides by default, and supports installing additional capabilities via typed blueprints (HTTP endpoints, runtime classes, document-based definitions, tool adapters).
- **Core Tension**: Environments vary widely (browser vs. Lambda vs. Electron), but sessions need a consistent way to discover what capabilities exist and install new ones. The system must handle versioning (environment updates change available capabilities) and ensure that capability installation is typed, validated, and reversible.

## Requirements

**R1**: Every environment SHALL declare a versioned capability manifest -- the set of capabilities it natively provides -- that is available to any session loaded within it, before any user interaction.
- *Rationale*: A session must know what its environment can do from the start. Without the manifest, there is no basis for capability discovery or dependency checking.
- *Verifiable by*: Immediately after loading a session, querying the environment's capabilities returns the full manifest including version identifier.

**R2**: The environment manifest SHALL include a meta-capability for installing new capabilities from blueprints.
- *Rationale*: The system must be extensible. Users install connectors, tools, and agents. The install capability is the mechanism for growth. Without it, the environment is static.
- *Verifiable by*: The manifest includes an install operation. Invoking it with a valid blueprint adds the blueprint's capabilities to the session.

**R3**: The environment manifest SHALL include a meta-capability for uninstalling previously installed capabilities.
- *Rationale*: Installed capabilities must be removable. An environment that only grows but never shrinks accumulates stale or conflicting capabilities.
- *Verifiable by*: After uninstalling a previously installed capability, it is no longer accessible in the session.

**R4**: Blueprints SHALL be typed -- each blueprint SHALL declare what capabilities it provides, what prerequisites it requires, and its installation type.
- *Rationale*: Typed blueprints allow the system to validate before installing. A blueprint requiring database credentials cannot install into an environment without them.
- *Verifiable by*: Inspecting a blueprint before installation reveals its provided capabilities, required prerequisites, and type. Attempting to install a blueprint with unmet prerequisites fails with a specific error.

**R5**: The system SHALL support at least the following blueprint types: HTTP endpoint sets, runtime classes, document-based capability definitions, and tool adapters.
- *Rationale*: Real-world capabilities come in diverse forms. HTTP endpoints expose external services. Runtime classes provide programmatic capabilities. Documents define declarative capabilities. Tool adapters wrap external tools.
- *Verifiable by*: A blueprint of each type can be successfully installed, and its provided capabilities become accessible.

**R6**: After successful installation, the capabilities provided by a blueprint SHALL be discoverable and usable within the session.
- *Rationale*: Installation that does not make capabilities accessible is useless. Installed capabilities must appear in the session's capability set.
- *Verifiable by*: After installing a blueprint that provides "db.query", querying the session's capabilities includes "db.query" with its typed schema.

**R7**: Capability uninstallation SHALL remove the capability from the session and invalidate any active components that depend on it.
- *Rationale*: A removed capability cannot fulfill its contract. Anything depending on it must be notified or degraded.
- *Verifiable by*: After uninstalling a capability, components that depend on it report the dependency as unavailable.

**R8**: Environment manifests SHALL be versioned. When a session created under manifest version N is loaded into an environment running manifest version M (where M != N), the system SHALL detect the version difference and reconcile capability changes.
- *Rationale*: Environment updates may add, remove, or change capabilities. A session from v1 loaded on v2 needs to know what changed so it can adapt.
- *Verifiable by*: Loading a v1 session on a v2 environment produces a report of added capabilities, removed capabilities, and changed capabilities.

## Acceptance Criteria

**AC1** [R1]: Given a fresh Node environment at version 2.1, when a new session is created, then the session's capability set includes all capabilities from the v2.1 manifest before any user action.

**AC2** [R2, R6]: Given an environment with the install meta-capability, when a valid HTTP endpoint blueprint (providing "api.users.list" and "api.users.get") is installed, then both capabilities appear in the session's capability set with their input/output schemas.

**AC3** [R4]: Given a blueprint requiring "aws.credentials" and an environment without AWS credentials configured, when installation is attempted, then it fails identifying "aws.credentials" as an unmet prerequisite.

**AC4** [R3, R7]: Given an installed capability "db.query" with a component actively depending on it, when "db.query" is uninstalled, then the dependent component reports the dependency as unavailable.

**AC5** [R8]: Given a session created under manifest v1 (capabilities: [A, B, C]) loaded into an environment running manifest v2 (capabilities: [B, C, D]), then the system reports: A removed, D added, B and C unchanged.

**AC6** [R5]: Given blueprints of types "http-endpoints", "runtime-class", "document-definition", and "tool-adapter", when each is installed into a compatible environment, then each successfully provides its declared capabilities.

## Open Questions

- What is the reconciliation strategy when a removed capability (v1 -> v2) is actively in use by the loaded session? Options: degrade gracefully, block session load, or prompt for resolution.
- Should blueprint installation be transactional (all-or-nothing), or can partial installation be acceptable for multi-capability blueprints?
- How should conflicting capabilities be handled when two blueprints provide the same capability path?
